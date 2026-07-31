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
  deviceCredentialLive,
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
  // Absent on states persisted before the dashboard kill switch shipped, so
  // every read must treat `undefined` as "not revoked" (compare with === true).
  credentialRevoked?: boolean;
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

/**
 * "closed" reports that connections were torn down, not that every close()
 * succeeded — closeRevoked swallows a refusing socket, and the marker is what
 * makes the revocation stick regardless.
 */
export type RevokeCredentialOutcome = "closed" | "no_socket" | "wrong_tenant";

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
    credentialRevoked: false,
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
    if (this.isCredentialRevoked()) return false;
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
    if (this.isCredentialRevoked()) {
      this.closeRevoked(connection);
      return;
    }
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
    // Re-read after the ticket-verify awaits. The socket is already accepted
    // (partyserver accepts before invoking onConnect), so a revoke landing
    // mid-verify DID close it via revokeCredential's close-all — but this
    // continuation would then re-point activeConnectionId at that dead socket,
    // undoing the clear the kill switch just made. Refusing here is what keeps
    // "marker set ⇒ activeConnectionId null" true, which is in turn why
    // onMessage's guard needs no reset of its own.
    if (this.isCredentialRevoked()) {
      this.closeRevoked(connection);
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
    // Ahead of the isAuthoritative early-return: sockets outlive the DO
    // instance, so a hibernation-woken connection (or one the close-all loop
    // missed) dies on its next frame — a heartbeat within 22 s. No
    // activeConnectionId reset needed: revokeCredential clears it in the same
    // atomic setState as the marker, and onConnect — the only writer that sets
    // it non-null — refuses to run while the marker is up.
    if (this.isCredentialRevoked()) {
      this.closeRevoked(connection);
      return;
    }
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
          // Unconditional: matchesAuthority above already proved this is the
          // active connection (captureAuthority requires the id to match).
          this.setState({ ...this.state, activeConnectionId: null });
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
          !(await deviceCredentialLive(
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
          // Unconditional for the same reason as the registration branch above:
          // matchesAuthority already established this is the active connection.
          this.setState({ ...this.state, activeConnectionId: null });
          this.closeRevoked(connection);
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
        const confirmation = await this.coordinator(fence.tenantId).confirmClosed({
          ...frame,
          deviceId: this.name,
        });
        if (confirmation !== null) {
          const session = await getAgentByName(this.env.SESSION, frame.sessionId);
          await session.markLifecycle(confirmation.status, false);
          if (confirmation.newlyClosed) {
            await emitTelemetry(this.env, {
              event: "release",
              outcome: confirmation.status,
              tenantId: fence.tenantId,
              deviceId: this.name,
              sessionId: frame.sessionId,
            });
          }
          if (!this.matchesAuthority(connection, fence)) return;
          this.send(connection, {
            type: "closed_ack",
            sessionId: frame.sessionId,
            leaseId: frame.leaseId,
            leaseEpoch: frame.leaseEpoch,
            browserEpoch: frame.browserEpoch,
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

  /**
   * Dashboard kill switch. The persisted marker — not the close — is what
   * defeats the Worker's 60 s positive credential cache: authorizeCredential
   * and onConnect refuse marked devices, so a cached-positive credential can
   * neither re-mint a ticket nor ride a pre-minted one back in.
   *
   * Fenced on tenant because the DEVICE namespace is global —
   * `getByName(deviceId)` reaches any tenant's agent, so a foreign deviceId
   * must not brick a device. The fence is only total once an authority row
   * exists: a device paired but never connected has no row yet, and the
   * allowance is what lets the owner pre-arm it. In that window the caller's
   * ownership check is the sole gate, which is why revokeDeviceForOwner —
   * not a route handler — is the only path here.
   *
   * The marker is irreversible: nothing clears it, and there is no un-revoke.
   * Recovery is re-pairing, which mints a fresh deviceId and therefore a fresh
   * agent — which is also why a marked agent can never shadow a later device.
   *
   * Closes every connection, authorized or not — a superseded socket can idle
   * open, and one that never finished authorizing is no safer to leave up.
   * No awaits: atomic with respect to every other DO event.
   *
   * "wrong_tenant" is distinct from "no_socket" because it is unreachable via
   * the supported path: if it ever fires, either the ownership check regressed
   * or someone is probing foreign ids, and that must not look like a no-op.
   */
  async revokeCredential(tenantId: string): Promise<RevokeCredentialOutcome> {
    const authority = this.authority();
    if (authority !== undefined && authority.tenant_id !== tenantId) {
      return "wrong_tenant";
    }
    this.setState({
      ...this.state,
      credentialRevoked: true,
      activeConnectionId: null,
    });
    let hadConnections = false;
    for (const connection of this.getConnections()) {
      this.closeRevoked(connection);
      hadConnections = true;
    }
    return hadConnections ? "closed" : "no_socket";
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

  /**
   * A method, not an inline `this.state.credentialRevoked === true`: the field
   * is set by a concurrent RPC, so every guard must re-read it. Inline reads let
   * TypeScript narrow the first check across subsequent awaits and declare the
   * later guards dead — exactly the mid-verify race they exist to close.
   */
  private isCredentialRevoked(): boolean {
    return this.state.credentialRevoked === true;
  }

  /**
   * Frame-before-close is load-bearing: the extension treats 1008 as retryable
   * and stops reconnecting only on the credential_revoked frame (ReconnectingWs
   * terminal codes are 4001/4003).
   *
   * Teardown only — the caller owns the marker. The heartbeat backstop shares
   * this helper and deliberately does NOT set it: that path also fires on
   * credential supersession, where arming an irreversible marker would brick a
   * device that merely rotated.
   */
  private closeRevoked(connection: Connection): void {
    try {
      this.send(connection, { type: "credential_revoked" });
    } catch {
      // A closing socket may refuse the frame; the marker guards still hold.
    }
    connection.setState(null);
    try {
      connection.close(1008, "device credential revoked");
    } catch {
      // Already closed; the persisted marker keeps the revocation durable.
    }
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
