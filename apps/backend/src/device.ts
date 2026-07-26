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

interface DeviceAuthorityFence {
  connectionId: string;
  tenantId: string;
  browserEpoch: string;
  credentialDigest: string;
  credentialVersion: number;
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
    const advanced = await this.coordinator(identity.tenantId).advanceDeviceCredential({
      deviceId: identity.deviceId,
      credentialDigest: identity.credentialDigest,
      credentialVersion: identity.credentialVersion,
    });
    if (!advanced.accepted) return false;
    const latest = this.authority();
    if (
      latest !== undefined &&
      (latest.tenant_id !== identity.tenantId ||
        latest.device_id !== identity.deviceId ||
        identity.credentialVersion < latest.credential_version ||
        (identity.credentialVersion === latest.credential_version &&
          identity.credentialDigest !== latest.credential_digest))
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
    let authority = this.authority();
    if (
      claims === null ||
      authority === undefined ||
      claims.deviceId !== this.name ||
      claims.tenantId !== authority.tenant_id ||
      claims.credentialVersion !== authority.credential_version ||
      !(await this.consumeTicket(claims))
    ) {
      connection.close(1008, "invalid or replayed device ticket");
      return;
    }
    authority = this.authority();
    if (
      authority === undefined ||
      claims.tenantId !== authority.tenant_id ||
      claims.deviceId !== authority.device_id ||
      claims.credentialVersion !== authority.credential_version
    ) {
      connection.close(1008, "stale device ticket");
      return;
    }

    connection.setState({ authorized: true, claims } satisfies AuthorizedConnectionState);
    this.setState({
      ...this.state,
      activeConnectionId: connection.id,
      tenantId: claims.tenantId,
      browserEpoch: claims.browserEpoch,
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
    await emitTelemetry(this.env, {
      event: "device_connect",
      outcome: "authorized",
      tenantId: claims.tenantId,
      deviceId: claims.deviceId,
    });
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
    const fence = this.captureAuthority(connection);
    if (fence === null) {
      connection.close(1008, "device authority missing");
      return;
    }

    switch (frame.type) {
      case "device_hello": {
        if (
          frame.deviceId !== this.name ||
          frame.browserEpoch !== fence.browserEpoch ||
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
        const coordinator = this.coordinator(fence.tenantId);
        const registration = await coordinator.registerDevice({
          deviceId: this.name,
          browser: frame.browser,
          extVersion: frame.extVersion,
          browserEpoch: frame.browserEpoch,
          credentialDigest: fence.credentialDigest,
          credentialVersion: fence.credentialVersion,
          allowedOrigins,
          capabilities: frame.capabilities,
        });
        if (!this.matchesAuthority(connection, fence)) return;
        if (!registration.accepted) {
          if (this.state.activeConnectionId === connection.id) {
            this.setState({ ...this.state, activeConnectionId: null });
          }
          connection.setState(null);
          connection.close(1008, "stale device registration");
          return;
        }
        if (registration.epochChanged) {
          await emitTelemetry(this.env, {
            event: "device_epoch_change",
            outcome: "recovering",
            tenantId: fence.tenantId,
            deviceId: this.name,
          });
        }
        return;
      }
      case "heartbeat": {
        if (
          frame.deviceId !== this.name ||
          frame.browserEpoch !== fence.browserEpoch ||
          !(await deviceCredentialExists(
            fence.credentialDigest,
            {
              tenantId: fence.tenantId,
              deviceId: this.name,
              credentialVersion: fence.credentialVersion,
            },
            this.env,
          ))
        ) {
          if (!this.matchesAuthority(connection, fence)) return;
          const revoked = await this.coordinator(fence.tenantId).revokeDevice(
            this.name,
            {
              credentialDigest: fence.credentialDigest,
              credentialVersion: fence.credentialVersion,
            },
          );
          if (!revoked || !this.matchesAuthority(connection, fence)) return;
          await emitTelemetry(this.env, {
            event: "device_offline",
            outcome: "credential_revoked",
            tenantId: fence.tenantId,
            deviceId: this.name,
          });
          if (!this.matchesAuthority(connection, fence)) return;
          this.send(connection, { type: "credential_revoked" });
          if (this.state.activeConnectionId === connection.id) {
            this.setState({ ...this.state, activeConnectionId: null });
          }
          connection.setState(null);
          connection.close(1008, "device credential revoked");
          return;
        }
        if (!this.matchesAuthority(connection, fence)) return;
        const heartbeat = await this.coordinator(fence.tenantId).heartbeat(
          this.name,
          frame.browserEpoch,
          frame.leaseIds,
        );
        if (!this.matchesAuthority(connection, fence)) return;
        if (!heartbeat.ok) {
          connection.close(1008, "device heartbeat rejected");
          return;
        }
        for (const lease of heartbeat.recoveries) {
          const session = await getAgentByName(this.env.SESSION, lease.sessionId);
          if (!this.matchesAuthority(connection, fence)) return;
          await session.beginRecovery(lease);
          if (!this.matchesAuthority(connection, fence)) return;
          await this.sendProvision(lease, fence);
          if (!this.matchesAuthority(connection, fence)) return;
          await emitTelemetry(this.env, {
            event: "recovery",
            outcome: "provision_sent",
            tenantId: fence.tenantId,
            deviceId: this.name,
            sessionId: lease.sessionId,
          });
        }
        for (const lease of heartbeat.assignments) {
          const session = await getAgentByName(this.env.SESSION, lease.sessionId);
          if (!this.matchesAuthority(connection, fence)) return;
          if (await session.needsSessionTicket()) {
            if (!this.matchesAuthority(connection, fence)) return;
            await this.sendSessionTicket(lease, fence);
          }
          if (!this.matchesAuthority(connection, fence)) return;
        }
        for (const lease of heartbeat.closures) {
          if (!this.matchesAuthority(connection, fence)) return;
          await this.requestClose(lease);
        }
        return;
      }
      case "provisioned": {
        const result = await this.coordinator(fence.tenantId).markProvisioned({
          ...frame,
          deviceId: this.name,
        });
        if (!result.accepted) {
          if (!this.matchesAuthority(connection, fence)) return;
          await emitTelemetry(this.env, {
            event: "provisioning",
            outcome: "fenced",
            tenantId: fence.tenantId,
            deviceId: this.name,
            sessionId: frame.sessionId,
          });
          if (!this.matchesAuthority(connection, fence)) return;
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
          tenantId: fence.tenantId,
          deviceId: this.name,
          sessionId: frame.sessionId,
        });
        return;
      }
      case "provision_failed":
        await this.coordinator(fence.tenantId).markProvisionFailed({
          ...frame,
          deviceId: this.name,
        });
        if (!this.matchesAuthority(connection, fence)) return;
        await emitTelemetry(this.env, {
          event: "provisioning",
          outcome: "failed",
          tenantId: fence.tenantId,
          deviceId: this.name,
          sessionId: frame.sessionId,
        });
        return;
      case "closed": {
        const terminal = await this.coordinator(fence.tenantId).confirmClosed({
          ...frame,
          deviceId: this.name,
        });
        if (terminal !== null) {
          const session = await getAgentByName(this.env.SESSION, frame.sessionId);
          await session.markLifecycle(terminal, false);
          await emitTelemetry(this.env, {
            event: "release",
            outcome: terminal,
            tenantId: fence.tenantId,
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

  private async sendProvision(
    lease: LeaseResource,
    expectedFence?: DeviceAuthorityFence,
  ): Promise<boolean> {
    const connection = this.authoritativeConnection();
    const fence =
      connection === undefined ? null : this.captureAuthority(connection);
    if (
      connection === undefined ||
      fence === null ||
      (expectedFence !== undefined && !sameAuthorityFence(fence, expectedFence)) ||
      lease.deviceId !== this.name ||
      lease.browserEpoch !== fence.browserEpoch
    ) {
      return false;
    }
    const sessionTicket = await mintWsTicket(
      {
        aud: "session",
        tenantId: fence.tenantId,
        deviceId: this.name,
        sessionId: lease.sessionId,
        leaseId: lease.leaseId,
        leaseEpoch: lease.leaseEpoch,
        browserEpoch: lease.browserEpoch,
        agentName: lease.sessionId,
      },
      this.env,
    );
    if (
      !this.matchesAuthority(connection, fence) ||
      lease.deviceId !== this.name ||
      lease.browserEpoch !== this.state.browserEpoch
    ) {
      return false;
    }
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

  private async sendSessionTicket(
    lease: LeaseResource,
    expectedFence?: DeviceAuthorityFence,
  ): Promise<boolean> {
    const connection = this.authoritativeConnection();
    const fence =
      connection === undefined ? null : this.captureAuthority(connection);
    if (
      connection === undefined ||
      fence === null ||
      (expectedFence !== undefined && !sameAuthorityFence(fence, expectedFence)) ||
      lease.deviceId !== this.name ||
      lease.browserEpoch !== fence.browserEpoch
    ) {
      return false;
    }
    const sessionTicket = await mintWsTicket(
      {
        aud: "session",
        tenantId: fence.tenantId,
        deviceId: this.name,
        sessionId: lease.sessionId,
        leaseId: lease.leaseId,
        leaseEpoch: lease.leaseEpoch,
        browserEpoch: lease.browserEpoch,
        agentName: lease.sessionId,
      },
      this.env,
    );
    if (
      !this.matchesAuthority(connection, fence) ||
      lease.deviceId !== this.name ||
      lease.browserEpoch !== this.state.browserEpoch
    ) {
      return false;
    }
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
    return this.captureAuthority(connection) !== null;
  }

  private authoritativeConnection(): Connection | undefined {
    if (this.state.activeConnectionId === null) return undefined;
    return [...this.getConnections()].find(
      (connection) =>
        connection.id === this.state.activeConnectionId &&
        this.captureAuthority(connection) !== null,
    );
  }

  private captureAuthority(
    connection: Connection,
  ): DeviceAuthorityFence | null {
    if (
      !this.isAuthorized(connection) ||
      this.state.activeConnectionId !== connection.id
    ) {
      return null;
    }
    const connectionState = connection.state as
      | Partial<AuthorizedConnectionState>
      | null;
    const claims = connectionState?.claims;
    const authority = this.authority();
    if (
      claims === undefined ||
      authority === undefined ||
      claims.tenantId !== authority.tenant_id ||
      claims.deviceId !== authority.device_id ||
      claims.credentialVersion !== authority.credential_version ||
      this.state.tenantId !== claims.tenantId ||
      this.state.browserEpoch !== claims.browserEpoch
    ) {
      return null;
    }
    return {
      connectionId: connection.id,
      tenantId: claims.tenantId,
      browserEpoch: claims.browserEpoch,
      credentialDigest: authority.credential_digest,
      credentialVersion: authority.credential_version,
    };
  }

  private matchesAuthority(
    connection: Connection,
    expected: DeviceAuthorityFence,
  ): boolean {
    const current = this.captureAuthority(connection);
    return current !== null && sameAuthorityFence(current, expected);
  }

  private send(connection: Connection, frame: DeviceControlServerFrame): void {
    connection.send(JSON.stringify(frame));
  }
}

function sameAuthorityFence(
  left: DeviceAuthorityFence,
  right: DeviceAuthorityFence,
): boolean {
  return (
    left.connectionId === right.connectionId &&
    left.tenantId === right.tenantId &&
    left.browserEpoch === right.browserEpoch &&
    left.credentialDigest === right.credentialDigest &&
    left.credentialVersion === right.credentialVersion
  );
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
