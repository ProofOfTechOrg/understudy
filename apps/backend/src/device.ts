import { Agent, getAgentByName } from "agents";
import type { AgentContext, Connection, ConnectionContext, WSMessage } from "agents";
import {
  DEVICE_CONTROL_FRAME_MAX_BYTES,
  PROTOCOL_VERSION,
  safeParseDeviceControlClientFrame,
  type DeviceControlServerFrame,
  type ProtocolCapability,
} from "@understudy/protocol";
import {
  deviceCredentialExists,
  mintWsTicket,
  verifyWsTicket,
  type DeviceIdentity,
  type WsTicketClaims,
} from "./auth";
import type { LeaseResource, TenantDeviceCoordinator } from "./tenant-coordinator";
import { canonicalizeOrigins } from "./validation";
import type { Env } from "./types";
import { emitTelemetry } from "./telemetry";

interface DeviceState {
  activeConnectionId: string | null;
  tenantId: string | null;
  browserEpoch: string | null;
  browser: string | null;
  extVersion: string | null;
  capabilities: ProtocolCapability[];
}

interface AuthorizedConnectionState {
  authorized: true;
  claims: WsTicketClaims;
}

interface DeviceAuthRow {
  tenant_id: string;
  device_id: string;
  credential_digest: string;
  credential_version: number;
}

export class DeviceAgent extends Agent<Env, DeviceState> {
  initialState: DeviceState = {
    activeConnectionId: null,
    tenantId: null,
    browserEpoch: null,
    browser: null,
    extVersion: null,
    capabilities: [],
  };

  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env);
    this.sql`
      CREATE TABLE IF NOT EXISTS device_authority (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        tenant_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        credential_digest TEXT NOT NULL,
        credential_version INTEGER NOT NULL
      )
    `;
    this.sql`
      CREATE TABLE IF NOT EXISTS consumed_ticket (
        jti_hash TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL
      )
    `;
  }

  shouldSendProtocolMessages(): boolean {
    return false;
  }

  validateStateChange(_nextState: DeviceState, source: Connection | "server"): void {
    if (source !== "server") {
      throw new Error("device state is server-driven");
    }
  }

  async authorizeCredential(identity: DeviceIdentity): Promise<boolean> {
    if (identity.deviceId !== this.name) return false;
    const existing = this.authority();
    if (
      existing !== undefined &&
      (existing.tenant_id !== identity.tenantId ||
        existing.device_id !== identity.deviceId ||
        identity.credentialVersion < existing.credential_version ||
        (identity.credentialVersion === existing.credential_version &&
          identity.credentialDigest !== existing.credential_digest))
    ) {
      return false;
    }
    this.sql`
      INSERT INTO device_authority (
        singleton, tenant_id, device_id, credential_digest, credential_version
      ) VALUES (
        1, ${identity.tenantId}, ${identity.deviceId},
        ${identity.credentialDigest}, ${identity.credentialVersion}
      )
      ON CONFLICT(singleton) DO UPDATE SET
        tenant_id = excluded.tenant_id,
        device_id = excluded.device_id,
        credential_digest = excluded.credential_digest,
        credential_version = excluded.credential_version
    `;
    if (
      existing !== undefined &&
      (existing.credential_version !== identity.credentialVersion ||
        existing.credential_digest !== identity.credentialDigest)
    ) {
      this.setState({ ...this.state, activeConnectionId: null });
      for (const connection of this.getConnections()) {
        connection.setState(null);
        try {
          connection.close(1008, "device credential rotated");
        } catch {
          // The persisted credential version already fences the predecessor.
        }
      }
    }
    return true;
  }

  async onConnect(connection: Connection, ctx: ConnectionContext): Promise<void> {
    const ticket = new URL(ctx.request.url).searchParams.get("ticket") ?? "";
    const claims = await verifyWsTicket(
      ticket,
      { aud: "device-control", agentName: this.name },
      this.env,
    );
    const authority = this.authority();
    if (
      claims === null ||
      authority === undefined ||
      claims.deviceId !== this.name ||
      claims.tenantId !== authority.tenant_id ||
      !(await this.consumeTicket(claims))
    ) {
      connection.close(1008, "invalid or replayed device ticket");
      return;
    }

    connection.setState({ authorized: true, claims } satisfies AuthorizedConnectionState);
    this.setState({
      ...this.state,
      activeConnectionId: connection.id,
      tenantId: claims.tenantId,
      browserEpoch: claims.browserEpoch,
    });
    await emitTelemetry(this.env, {
      event: "device_connect",
      outcome: "authorized",
      tenantId: claims.tenantId,
      deviceId: claims.deviceId,
    });
    for (const previous of this.getConnections()) {
      if (previous.id === connection.id || !this.isAuthorized(previous)) continue;
      previous.setState(null);
      try {
        previous.close(4001, "replaced by newer authorized device connection");
      } catch {
        // The persisted active id already fences a raced close.
      }
    }
  }

  async onMessage(connection: Connection, message: WSMessage): Promise<void> {
    if (!this.isAuthoritative(connection)) return;
    if (typeof message !== "string") {
      connection.close(1009, "binary device frames are not supported");
      return;
    }
    if (new TextEncoder().encode(message).byteLength > DEVICE_CONTROL_FRAME_MAX_BYTES) {
      connection.close(1009, "device frame too large");
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(message) as unknown;
    } catch {
      connection.close(1008, "invalid device frame");
      return;
    }
    const parsed = safeParseDeviceControlClientFrame(raw);
    if (!parsed.success) {
      connection.close(1008, "invalid device frame");
      return;
    }
    const frame = parsed.data;
    const state = connection.state as AuthorizedConnectionState;
    const authority = this.authority();
    if (authority === undefined) {
      connection.close(1008, "device authority missing");
      return;
    }

    switch (frame.type) {
      case "device_hello": {
        if (
          frame.deviceId !== this.name ||
          frame.browserEpoch !== state.claims.browserEpoch ||
          frame.protocolVersion !== PROTOCOL_VERSION
        ) {
          connection.close(1008, "device hello fence mismatch");
          return;
        }
        let allowedOrigins: string[];
        try {
          allowedOrigins = canonicalizeOrigins(frame.allowedOrigins);
        } catch {
          connection.close(1008, "invalid local origin policy");
          return;
        }
        this.setState({
          ...this.state,
          browserEpoch: frame.browserEpoch,
          browser: frame.browser,
          extVersion: frame.extVersion,
          capabilities: frame.capabilities,
        });
        const coordinator = this.coordinator(state.claims.tenantId);
        const registration = await coordinator.registerDevice({
          deviceId: this.name,
          browser: frame.browser,
          extVersion: frame.extVersion,
          browserEpoch: frame.browserEpoch,
          credentialDigest: authority.credential_digest,
          credentialVersion: authority.credential_version,
          allowedOrigins,
          capabilities: frame.capabilities,
        });
        if (registration.epochChanged) {
          await emitTelemetry(this.env, {
            event: "device_epoch_change",
            outcome: "recovering",
            tenantId: state.claims.tenantId,
            deviceId: this.name,
          });
        }
        return;
      }
      case "heartbeat": {
        if (
          frame.deviceId !== this.name ||
          frame.browserEpoch !== state.claims.browserEpoch ||
          !(await deviceCredentialExists(
            authority.credential_digest,
            {
              tenantId: authority.tenant_id,
              deviceId: authority.device_id,
              credentialVersion: authority.credential_version,
            },
            this.env,
          ))
        ) {
          await this.coordinator(state.claims.tenantId).revokeDevice(this.name);
          await emitTelemetry(this.env, {
            event: "device_offline",
            outcome: "credential_revoked",
            tenantId: state.claims.tenantId,
            deviceId: this.name,
          });
          this.send(connection, { type: "credential_revoked" });
          connection.setState(null);
          connection.close(1008, "device credential revoked");
          return;
        }
        const heartbeat = await this.coordinator(state.claims.tenantId).heartbeat(
          this.name,
          frame.browserEpoch,
          frame.leaseIds,
        );
        if (!heartbeat.ok) {
          connection.close(1008, "device heartbeat rejected");
          return;
        }
        for (const lease of heartbeat.recoveries) {
          const session = await getAgentByName(this.env.SESSION, lease.sessionId);
          await session.beginRecovery(lease);
          await this.sendProvision(lease);
          await emitTelemetry(this.env, {
            event: "recovery",
            outcome: "provision_sent",
            tenantId: state.claims.tenantId,
            deviceId: this.name,
            sessionId: lease.sessionId,
          });
        }
        for (const lease of heartbeat.assignments) {
          const session = await getAgentByName(this.env.SESSION, lease.sessionId);
          if (await session.needsSessionTicket()) {
            await this.sendSessionTicket(lease);
          }
        }
        for (const lease of heartbeat.closures) {
          await this.requestClose(lease);
        }
        return;
      }
      case "provisioned": {
        const result = await this.coordinator(state.claims.tenantId).markProvisioned({
          ...frame,
          deviceId: this.name,
        });
        if (!result.accepted) {
          await emitTelemetry(this.env, {
            event: "provisioning",
            outcome: "fenced",
            tenantId: state.claims.tenantId,
            deviceId: this.name,
            sessionId: frame.sessionId,
          });
          this.send(connection, {
            type: "close_lease",
            sessionId: frame.sessionId,
            leaseId: frame.leaseId,
            leaseEpoch: frame.leaseEpoch,
            browserEpoch: frame.browserEpoch,
          });
          return;
        }
        const session = await getAgentByName(this.env.SESSION, frame.sessionId);
        await session.markProvisioned(frame.tab, frame.browserEpoch);
        await emitTelemetry(this.env, {
          event: "provisioning",
          outcome: "connected",
          tenantId: state.claims.tenantId,
          deviceId: this.name,
          sessionId: frame.sessionId,
        });
        return;
      }
      case "provision_failed":
        await this.coordinator(state.claims.tenantId).markProvisionFailed({
          ...frame,
          deviceId: this.name,
        });
        await emitTelemetry(this.env, {
          event: "provisioning",
          outcome: "failed",
          tenantId: state.claims.tenantId,
          deviceId: this.name,
          sessionId: frame.sessionId,
        });
        return;
      case "closed": {
        const terminal = await this.coordinator(state.claims.tenantId).confirmClosed({
          ...frame,
          deviceId: this.name,
        });
        if (terminal !== null) {
          const session = await getAgentByName(this.env.SESSION, frame.sessionId);
          await session.markLifecycle(terminal, false);
          await emitTelemetry(this.env, {
            event: "release",
            outcome: terminal,
            tenantId: state.claims.tenantId,
            deviceId: this.name,
            sessionId: frame.sessionId,
          });
        }
        return;
      }
    }
  }

  async onClose(connection: Connection): Promise<void> {
    if (this.state.activeConnectionId !== connection.id) return;
    this.setState({ ...this.state, activeConnectionId: null });
  }

  async requestProvision(lease: LeaseResource): Promise<boolean> {
    if (
      this.state.tenantId === null ||
      lease.deviceId !== this.name ||
      lease.browserEpoch !== this.state.browserEpoch
    ) {
      return false;
    }
    return this.sendProvision(lease);
  }

  async requestClose(lease: LeaseResource): Promise<boolean> {
    const connection = this.authoritativeConnection();
    if (
      connection === undefined ||
      lease.deviceId !== this.name ||
      lease.browserEpoch !== this.state.browserEpoch
    ) {
      return false;
    }
    this.send(connection, {
      type: "close_lease",
      sessionId: lease.sessionId,
      leaseId: lease.leaseId,
      leaseEpoch: lease.leaseEpoch,
      browserEpoch: lease.browserEpoch,
    });
    return true;
  }

  private async sendProvision(lease: LeaseResource): Promise<boolean> {
    const connection = this.authoritativeConnection();
    if (
      connection === undefined ||
      this.state.tenantId === null ||
      lease.deviceId !== this.name ||
      lease.browserEpoch !== this.state.browserEpoch
    ) {
      return false;
    }
    const sessionTicket = await mintWsTicket(
      {
        aud: "session",
        tenantId: this.state.tenantId,
        deviceId: this.name,
        sessionId: lease.sessionId,
        leaseId: lease.leaseId,
        leaseEpoch: lease.leaseEpoch,
        browserEpoch: lease.browserEpoch,
        agentName: lease.sessionId,
      },
      this.env,
    );
    this.send(connection, {
      type: "provision",
      sessionId: lease.sessionId,
      leaseId: lease.leaseId,
      leaseEpoch: lease.leaseEpoch,
      browserEpoch: lease.browserEpoch,
      allowedOrigins: lease.allowedOrigins,
      sessionTicket,
    });
    return true;
  }

  private async sendSessionTicket(lease: LeaseResource): Promise<boolean> {
    const connection = this.authoritativeConnection();
    if (
      connection === undefined ||
      this.state.tenantId === null ||
      lease.deviceId !== this.name ||
      lease.browserEpoch !== this.state.browserEpoch
    ) {
      return false;
    }
    const sessionTicket = await mintWsTicket(
      {
        aud: "session",
        tenantId: this.state.tenantId,
        deviceId: this.name,
        sessionId: lease.sessionId,
        leaseId: lease.leaseId,
        leaseEpoch: lease.leaseEpoch,
        browserEpoch: lease.browserEpoch,
        agentName: lease.sessionId,
      },
      this.env,
    );
    this.send(connection, {
      type: "session_ticket",
      sessionId: lease.sessionId,
      leaseId: lease.leaseId,
      leaseEpoch: lease.leaseEpoch,
      browserEpoch: lease.browserEpoch,
      sessionTicket,
    });
    return true;
  }

  private authority(): DeviceAuthRow | undefined {
    return this.sql<DeviceAuthRow>`SELECT * FROM device_authority WHERE singleton = 1`[0];
  }

  private coordinator(tenantId: string): DurableObjectStub<TenantDeviceCoordinator> {
    return this.env.TENANT_CONTROL.getByName(tenantId);
  }

  private async consumeTicket(claims: WsTicketClaims): Promise<boolean> {
    const jtiHash = await sha256Hex(claims.jti);
    this.sql`DELETE FROM consumed_ticket WHERE expires_at <= ${Math.floor(Date.now() / 1000)}`;
    this.sql`
      INSERT OR IGNORE INTO consumed_ticket (jti_hash, expires_at)
      VALUES (${jtiHash}, ${claims.exp})
    `;
    const changes = this.sql<{ count: number }>`SELECT changes() AS count`[0]?.count ?? 0;
    return changes === 1;
  }

  private isAuthorized(connection: Connection): boolean {
    return (connection.state as Partial<AuthorizedConnectionState> | null)?.authorized === true;
  }

  private isAuthoritative(connection: Connection): boolean {
    return this.isAuthorized(connection) && this.state.activeConnectionId === connection.id;
  }

  private authoritativeConnection(): Connection | undefined {
    if (this.state.activeConnectionId === null) return undefined;
    return [...this.getConnections()].find(
      (connection) =>
        connection.id === this.state.activeConnectionId && this.isAuthorized(connection),
    );
  }

  private send(connection: Connection, frame: DeviceControlServerFrame): void {
    connection.send(JSON.stringify(frame));
  }
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
