import { DurableObject } from "cloudflare:workers";
import { getAgentByName } from "agents";
import type { DeviceStatus, ProtocolCapability, UnattendedSessionLifecycle } from "@understudy/protocol";
import { parseQuotaPolicy } from "./quota";
import type { Env } from "./types";
import { emitTelemetry } from "./telemetry";

const DEVICE_CAPACITY = 2;
const DEVICE_OFFLINE_MS = 75_000;
const DEVICE_LOST_MS = 90_000;
const PROVISIONING_DEADLINE_MS = 30_000;
const IDLE_EXPIRY_MS = 2 * 60 * 60 * 1000;
const HARD_EXPIRY_MS = 24 * 60 * 60 * 1000;
interface DeviceRow {
  [key: string]: string | number | null;
  device_id: string;
  enabled: number;
  last_seen_at: number;
  last_assigned_at: number;
  browser: string;
  ext_version: string;
  browser_epoch: string;
  credential_digest: string;
  credential_version: number;
  origin_policy_json: string;
  capabilities_json: string;
}

interface DeviceCredentialRow {
  [key: string]: string | number;
  device_id: string;
  credential_digest: string;
  credential_version: number;
}

interface LeaseRow {
  [key: string]: string | number | null;
  session_id: string;
  lease_id: string;
  device_id: string;
  status: UnattendedSessionLifecycle;
  allowed_origins_json: string;
  profile_state_hash: string;
  lease_epoch: number;
  browser_epoch: string;
  created_at: number;
  last_activity_at: number;
  idle_expires_at: number;
  hard_expires_at: number;
  provisioning_deadline_at: number;
  release_at: number | null;
  needs_reconciliation: number;
  dialog_delivery: "ok" | "interrupted" | "overflow";
}

export interface LeaseResource {
  sessionId: string;
  leaseId: string;
  deviceId: string;
  status: UnattendedSessionLifecycle;
  allowedOrigins: string[];
  leaseEpoch: number;
  browserEpoch: string;
  createdAt: number;
  lastActivityAt: number;
  idleExpiresAt: number;
  hardExpiresAt: number;
  needsReconciliation: boolean;
  dialogDelivery: "ok" | "interrupted" | "overflow";
}

export interface ClosureConfirmation {
  status: "closed" | "expired" | "lost";
  newlyClosed: boolean;
}

export type CreateLeaseResult =
  | { kind: "created"; created: true; lease: LeaseResource }
  | { kind: "replay"; created: false; lease: LeaseResource }
  | { kind: "conflict" }
  | { kind: "terminal"; status: UnattendedSessionLifecycle }
  | { kind: "device_not_found" }
  | { kind: "no_device" }
  | { kind: "capacity" }
  | { kind: "collision" };

export interface CreateLeaseInput {
  idempotencyKey: string;
  fingerprint: string;
  sessionId: string;
  deviceId?: string;
  allowedOrigins: string[];
  profileStateHash: string;
  actorPseudonym: string;
  now?: number;
}

export interface RegisterDeviceInput {
  deviceId: string;
  browser: string;
  extVersion: string;
  browserEpoch: string;
  credentialDigest: string;
  credentialVersion: number;
  allowedOrigins: string[];
  capabilities: ProtocolCapability[];
  now?: number;
}

export class TenantDeviceCoordinator extends DurableObject<Env> {
  private readonly tenantId: string;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.tenantId = ctx.id.name ?? ctx.id.toString();
    ctx.blockConcurrencyWhile(async () => {
      this.initializeSchema();
    });
  }

  private initializeSchema(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS device (
        device_id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        last_assigned_at INTEGER NOT NULL,
        browser TEXT NOT NULL,
        ext_version TEXT NOT NULL,
        browser_epoch TEXT NOT NULL,
        credential_digest TEXT NOT NULL,
        credential_version INTEGER NOT NULL,
        origin_policy_json TEXT NOT NULL,
        capabilities_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS device_credential_fence (
        device_id TEXT PRIMARY KEY,
        credential_digest TEXT NOT NULL,
        credential_version INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS lease (
        session_id TEXT PRIMARY KEY,
        lease_id TEXT NOT NULL UNIQUE,
        device_id TEXT NOT NULL,
        status TEXT NOT NULL,
        allowed_origins_json TEXT NOT NULL,
        profile_state_hash TEXT NOT NULL,
        lease_epoch INTEGER NOT NULL,
        browser_epoch TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_activity_at INTEGER NOT NULL,
        idle_expires_at INTEGER NOT NULL,
        hard_expires_at INTEGER NOT NULL,
        provisioning_deadline_at INTEGER NOT NULL,
        release_at INTEGER,
        needs_reconciliation INTEGER NOT NULL,
        dialog_delivery TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS lease_device_active
        ON lease(device_id, status, release_at);
      CREATE TABLE IF NOT EXISTS create_idempotency (
        idempotency_key TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL,
        session_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS quota_counter (
        scope TEXT NOT NULL,
        subject TEXT NOT NULL,
        bucket INTEGER NOT NULL,
        count INTEGER NOT NULL,
        PRIMARY KEY(scope, subject, bucket)
      );
    `);
  }

  async advanceDeviceCredential(input: {
    deviceId: string;
    credentialDigest: string;
    credentialVersion: number;
  }): Promise<{ accepted: boolean }> {
    return { accepted: this.advanceCredentialFence(input) };
  }

  async registerDevice(
    input: RegisterDeviceInput,
  ): Promise<{ accepted: boolean; epochChanged: boolean }> {
    if (!this.advanceCredentialFence(input)) {
      return { accepted: false, epochChanged: false };
    }
    const now = input.now ?? Date.now();
    const previous = this.device(input.deviceId);
    const epochChanged =
      previous !== undefined &&
      previous.browser_epoch !== input.browserEpoch;
    this.ctx.storage.sql.exec(
      `INSERT INTO device (
         device_id, enabled, last_seen_at, last_assigned_at, browser, ext_version,
         browser_epoch, credential_digest, credential_version, origin_policy_json,
         capabilities_json
       ) VALUES (?, 1, ?, 0, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(device_id) DO UPDATE SET
         enabled = 1,
         last_seen_at = excluded.last_seen_at,
         browser = excluded.browser,
         ext_version = excluded.ext_version,
         browser_epoch = excluded.browser_epoch,
         credential_digest = excluded.credential_digest,
         credential_version = excluded.credential_version,
         origin_policy_json = excluded.origin_policy_json,
         capabilities_json = excluded.capabilities_json`,
      input.deviceId,
      now,
      input.browser,
      input.extVersion,
      input.browserEpoch,
      input.credentialDigest,
      input.credentialVersion,
      JSON.stringify(input.allowedOrigins),
      JSON.stringify(input.capabilities),
    );

    if (epochChanged) {
      this.ctx.storage.sql.exec(
        `UPDATE lease
         SET status = CASE WHEN status = 'expired' THEN 'expired' ELSE 'lost' END,
             release_at = ?, needs_reconciliation = 1
         WHERE device_id = ? AND status IN ('closing','expired')
           AND release_at IS NULL`,
        now,
        input.deviceId,
      );
      this.ctx.storage.sql.exec(
        `UPDATE lease
         SET status = 'recovering',
             browser_epoch = ?,
             provisioning_deadline_at = ?,
             needs_reconciliation = 1,
             dialog_delivery = CASE WHEN dialog_delivery = 'overflow' THEN 'overflow' ELSE 'interrupted' END
         WHERE device_id = ?
           AND status IN ('allocating','provisioning','connected','recovering')
           AND release_at IS NULL`,
        input.browserEpoch,
        now + DEVICE_LOST_MS,
        input.deviceId,
      );
    }
    await this.scheduleNextAlarm();
    return { accepted: true, epochChanged };
  }

  async heartbeat(
    deviceId: string,
    browserEpoch: string,
    reportedLeaseIds: string[] = [],
    now = Date.now(),
  ): Promise<{
    ok: boolean;
    recoveries: LeaseResource[];
    assignments: LeaseResource[];
    closures: LeaseResource[];
  }> {
    const device = this.device(deviceId);
    if (device === undefined || device.browser_epoch !== browserEpoch || device.enabled !== 1) {
      return { ok: false, recoveries: [], assignments: [], closures: [] };
    }
    this.ctx.storage.sql.exec(
      "UPDATE device SET last_seen_at = ? WHERE device_id = ? AND browser_epoch = ?",
      now,
      deviceId,
      browserEpoch,
    );
    const reported = new Set(reportedLeaseIds);
    for (const lease of this.leaseRows(
      `SELECT * FROM lease
       WHERE device_id = ? AND status = 'connected' AND release_at IS NULL`,
      deviceId,
    )) {
      if (reported.has(lease.lease_id)) continue;
      this.ctx.storage.sql.exec(
        `UPDATE lease SET status = 'recovering', needs_reconciliation = 1,
             provisioning_deadline_at = ?
         WHERE session_id = ? AND status = 'connected' AND release_at IS NULL`,
        now + DEVICE_LOST_MS,
        lease.session_id,
      );
    }
    const recoveries = this.leaseRows(
      `SELECT * FROM lease
       WHERE device_id = ? AND status = 'recovering' AND release_at IS NULL
       ORDER BY created_at`,
      deviceId,
    ).map(toLeaseResource);
    const assignments = this.leaseRows(
      `SELECT * FROM lease
       WHERE device_id = ? AND status = 'connected' AND release_at IS NULL
       ORDER BY created_at`,
      deviceId,
    ).map(toLeaseResource);
    const closures = this.leaseRows(
      `SELECT * FROM lease
       WHERE device_id = ? AND status IN ('closing','expired') AND release_at IS NULL
       ORDER BY created_at`,
      deviceId,
    ).map(toLeaseResource);
    await this.scheduleNextAlarm();
    return { ok: true, recoveries, assignments, closures };
  }

  async createLease(input: CreateLeaseInput): Promise<CreateLeaseResult> {
    const now = input.now ?? Date.now();
    const existingKey = this.ctx.storage.sql
      .exec<{ fingerprint: string; session_id: string }>(
        "SELECT fingerprint, session_id FROM create_idempotency WHERE idempotency_key = ?",
        input.idempotencyKey,
      )
      .toArray()[0];
    if (existingKey !== undefined) {
      if (existingKey.fingerprint !== input.fingerprint) return { kind: "conflict" };
      const lease = this.lease(existingKey.session_id);
      if (lease === undefined) return { kind: "terminal", status: "lost" };
      if (isTerminal(lease.status)) return { kind: "terminal", status: lease.status };
      return { kind: "replay", created: false, lease: toLeaseResource(lease) };
    }
    const policy = parseQuotaPolicy(this.env.QUOTA_POLICY);
    if (
      !this.consumeQuota(
        "session_create_actor",
        input.actorPseudonym,
        now,
        policy.sessionCreatesPerActorMinute,
      )
    ) {
      await emitTelemetry(this.env, {
        event: "quota",
        outcome: "session_create_denied",
        tenantId: this.tenantId,
        actor: input.actorPseudonym,
      });
      return { kind: "capacity" };
    }

    const online = this.onlineCompatibleDevices(now);
    if (input.deviceId !== undefined && this.device(input.deviceId) === undefined) {
      return { kind: "device_not_found" };
    }
    const candidates =
      input.deviceId === undefined
        ? online
        : online.filter((device) => device.device_id === input.deviceId);
    if (candidates.length === 0) return { kind: "no_device" };

    let sawCapacity = false;
    let sawCollision = false;
    let selected: DeviceRow | undefined;
    for (const device of candidates) {
      const leases = this.activeLeasesForDevice(device.device_id);
      if (leases.length >= DEVICE_CAPACITY) {
        sawCapacity = true;
        continue;
      }
      if (!isSubset(input.allowedOrigins, parseStringArray(device.origin_policy_json))) {
        sawCollision = true;
        continue;
      }
      if (
        leases.some(
          (lease) =>
            lease.profile_state_hash === input.profileStateHash ||
            intersects(input.allowedOrigins, parseStringArray(lease.allowed_origins_json)),
        )
      ) {
        sawCollision = true;
        continue;
      }
      selected = device;
      break;
    }
    if (selected === undefined) {
      if (sawCollision) return { kind: "collision" };
      if (sawCapacity) return { kind: "capacity" };
      return { kind: "no_device" };
    }

    const leaseId = crypto.randomUUID();
    const hardExpiresAt = now + HARD_EXPIRY_MS;
    const idleExpiresAt = Math.min(now + IDLE_EXPIRY_MS, hardExpiresAt);
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `INSERT INTO create_idempotency (idempotency_key, fingerprint, session_id)
         VALUES (?, ?, ?)`,
        input.idempotencyKey,
        input.fingerprint,
        input.sessionId,
      );
      this.ctx.storage.sql.exec(
        `INSERT INTO lease (
           session_id, lease_id, device_id, status, allowed_origins_json,
           profile_state_hash, lease_epoch, browser_epoch, created_at,
           last_activity_at, idle_expires_at, hard_expires_at,
           provisioning_deadline_at, release_at, needs_reconciliation,
           dialog_delivery
         ) VALUES (?, ?, ?, 'provisioning', ?, ?, 1, ?, ?, ?, ?, ?, ?, NULL, 0, 'ok')`,
        input.sessionId,
        leaseId,
        selected.device_id,
        JSON.stringify(input.allowedOrigins),
        input.profileStateHash,
        selected.browser_epoch,
        now,
        now,
        idleExpiresAt,
        hardExpiresAt,
        now + PROVISIONING_DEADLINE_MS,
      );
      this.ctx.storage.sql.exec(
        "UPDATE device SET last_assigned_at = ? WHERE device_id = ?",
        now,
        selected.device_id,
      );
    });
    await this.scheduleNextAlarm();
    const lease = this.lease(input.sessionId);
    if (lease === undefined) throw new Error("lease reservation disappeared");
    return { kind: "created", created: true, lease: toLeaseResource(lease) };
  }

  async markProvisioned(input: {
    sessionId: string;
    leaseId: string;
    leaseEpoch: number;
    browserEpoch: string;
    deviceId: string;
    now?: number;
  }): Promise<{ accepted: boolean; close: boolean }> {
    const now = input.now ?? Date.now();
    const changed = this.ctx.storage.sql.exec<{ status: string }>(
      `UPDATE lease
       SET status = 'connected', needs_reconciliation = 0
       WHERE session_id = ? AND lease_id = ? AND device_id = ? AND lease_epoch = ?
         AND browser_epoch = ? AND status IN ('provisioning','recovering')
         AND release_at IS NULL AND hard_expires_at > ? AND idle_expires_at > ?
       RETURNING status`,
      input.sessionId,
      input.leaseId,
      input.deviceId,
      input.leaseEpoch,
      input.browserEpoch,
      now,
      now,
    ).toArray();
    await this.scheduleNextAlarm();
    return { accepted: changed.length === 1, close: changed.length !== 1 };
  }

  async markProvisionFailed(input: {
    sessionId: string;
    leaseId: string;
    leaseEpoch: number;
    browserEpoch: string;
    deviceId: string;
  }): Promise<void> {
    this.ctx.storage.sql.exec(
      `UPDATE lease SET status = 'closing', needs_reconciliation = 1
       WHERE session_id = ? AND lease_id = ? AND device_id = ?
         AND lease_epoch = ? AND browser_epoch = ?
         AND status IN ('provisioning','recovering') AND release_at IS NULL`,
      input.sessionId,
      input.leaseId,
      input.deviceId,
      input.leaseEpoch,
      input.browserEpoch,
    );
    await this.scheduleNextAlarm();
  }

  async getLease(sessionId: string, now = Date.now()): Promise<LeaseResource | null> {
    let lease = this.lease(sessionId);
    if (
      lease !== undefined &&
      lease.release_at === null &&
      (lease.hard_expires_at <= now || lease.idle_expires_at <= now) &&
      ["allocating", "provisioning", "connected", "recovering"].includes(lease.status)
    ) {
      this.ctx.storage.sql.exec(
        `UPDATE lease SET status = 'expired'
         WHERE session_id = ? AND release_at IS NULL
           AND status IN ('allocating','provisioning','connected','recovering')
           AND (hard_expires_at <= ? OR idle_expires_at <= ?)`,
        sessionId,
        now,
        now,
      );
      lease = this.lease(sessionId);
      await this.scheduleNextAlarm();
    }
    return lease === undefined ? null : toLeaseResource(lease);
  }

  async authorizeCommand(input: {
    sessionId: string;
    actorPseudonym: string;
    credentialFill: boolean;
    now?: number;
  }): Promise<{ ok: true; idleExpiresAt: number } | { ok: false; reason: "terminal" | "quota" }> {
    const now = input.now ?? Date.now();
    const lease = this.lease(input.sessionId);
    if (
      lease === undefined ||
      lease.status !== "connected" ||
      lease.release_at !== null ||
      lease.hard_expires_at <= now ||
      lease.idle_expires_at <= now
    ) {
      return { ok: false, reason: "terminal" };
    }
    const policy = parseQuotaPolicy(this.env.QUOTA_POLICY);
    const quotas = [
      {
        scope: "commands_session",
        subject: input.sessionId,
        limit: policy.commandsPerSessionMinute,
      },
      {
        scope: "commands_tenant",
        subject: this.tenantId,
        limit: policy.commandsPerTenantMinute,
      },
      ...(input.credentialFill
        ? [
            {
              scope: "credential_fill_actor",
              subject: input.actorPseudonym,
              limit: policy.credentialFillsPerActorMinute,
            },
          ]
        : []),
    ];
    if (!this.consumeQuotas(quotas, now)) {
      await emitTelemetry(this.env, {
        event: "quota",
        outcome: "command_denied",
        tenantId: this.tenantId,
        actor: input.actorPseudonym,
        sessionId: input.sessionId,
      });
      return { ok: false, reason: "quota" };
    }
    const idleExpiresAt = Math.min(now + IDLE_EXPIRY_MS, lease.hard_expires_at);
    this.ctx.storage.sql.exec(
      `UPDATE lease SET last_activity_at = ?, idle_expires_at = ?
       WHERE session_id = ? AND status = 'connected' AND release_at IS NULL`,
      now,
      idleExpiresAt,
      input.sessionId,
    );
    await this.scheduleNextAlarm();
    return { ok: true, idleExpiresAt };
  }

  async authorizeAttendedCommand(input: {
    sessionId: string;
    actorPseudonym: string;
    credentialFill: boolean;
    now?: number;
  }): Promise<boolean> {
    const now = input.now ?? Date.now();
    const policy = parseQuotaPolicy(this.env.QUOTA_POLICY);
    const allowed = this.consumeQuotas(
      [
        {
          scope: "commands_session",
          subject: input.sessionId,
          limit: policy.commandsPerSessionMinute,
        },
        {
          scope: "commands_tenant",
          subject: this.tenantId,
          limit: policy.commandsPerTenantMinute,
        },
        ...(input.credentialFill
          ? [
              {
                scope: "credential_fill_actor",
                subject: input.actorPseudonym,
                limit: policy.credentialFillsPerActorMinute,
              },
            ]
          : []),
      ],
      now,
    );
    if (!allowed) {
      await emitTelemetry(this.env, {
        event: "quota",
        outcome: "attended_command_denied",
        tenantId: this.tenantId,
        actor: input.actorPseudonym,
        sessionId: input.sessionId,
      });
    }
    return allowed;
  }

  async markRecovering(input: {
    sessionId: string;
    leaseId: string;
    leaseEpoch: number;
    browserEpoch: string;
    now?: number;
  }): Promise<boolean> {
    const now = input.now ?? Date.now();
    const changed = this.ctx.storage.sql.exec<{ status: string }>(
      `UPDATE lease
       SET status = 'recovering', needs_reconciliation = 1,
           provisioning_deadline_at = ?
       WHERE session_id = ? AND lease_id = ? AND lease_epoch = ?
         AND browser_epoch = ? AND status = 'connected' AND release_at IS NULL
       RETURNING status`,
      now + DEVICE_LOST_MS,
      input.sessionId,
      input.leaseId,
      input.leaseEpoch,
      input.browserEpoch,
    ).toArray();
    await this.scheduleNextAlarm();
    return changed.length === 1;
  }

  async closeLease(
    sessionId: string,
  ): Promise<{ found: boolean; cleanupConfirmed: boolean; lease?: LeaseResource }> {
    const lease = this.lease(sessionId);
    if (lease === undefined) return { found: false, cleanupConfirmed: false };
    if (lease.release_at !== null) {
      return { found: true, cleanupConfirmed: true, lease: toLeaseResource(lease) };
    }
    if (lease.status === "expired") {
      await this.scheduleNextAlarm();
      return { found: true, cleanupConfirmed: false, lease: toLeaseResource(lease) };
    }
    this.ctx.storage.sql.exec(
      "UPDATE lease SET status = 'closing' WHERE session_id = ? AND release_at IS NULL",
      sessionId,
    );
    await this.scheduleNextAlarm();
    const next = this.lease(sessionId);
    return {
      found: true,
      cleanupConfirmed: false,
      ...(next === undefined ? {} : { lease: toLeaseResource(next) }),
    };
  }

  async confirmClosed(input: {
    sessionId: string;
    leaseId: string;
    leaseEpoch: number;
    browserEpoch: string;
    deviceId: string;
    now?: number;
  }): Promise<ClosureConfirmation | null> {
    const now = input.now ?? Date.now();
    const before = this.lease(input.sessionId);
    if (
      before === undefined ||
      before.lease_id !== input.leaseId ||
      before.device_id !== input.deviceId ||
      before.lease_epoch !== input.leaseEpoch ||
      before.browser_epoch !== input.browserEpoch
    ) {
      return null;
    }
    if (before.release_at !== null) {
      return (
        before.status === "closed" ||
        before.status === "expired" ||
        before.status === "lost"
      )
        ? { status: before.status, newlyClosed: false }
        : null;
    }
    if (
      !(
        before.status === "allocating" ||
        before.status === "provisioning" ||
        before.status === "connected" ||
        before.status === "recovering" ||
        before.status === "closing" ||
        before.status === "expired"
      )
    ) {
      return null;
    }
    const terminalStatus: UnattendedSessionLifecycle =
      before.status === "expired" ? "expired" : "closed";
    const changed = this.ctx.storage.sql.exec<{ status: UnattendedSessionLifecycle }>(
      `UPDATE lease SET status = ?, release_at = ?, needs_reconciliation = 0
       WHERE session_id = ? AND lease_id = ? AND device_id = ?
         AND lease_epoch = ? AND browser_epoch = ?
         AND release_at IS NULL
         AND status IN ('allocating','provisioning','connected','recovering','closing','expired')
       RETURNING status`,
      terminalStatus,
      now,
      input.sessionId,
      input.leaseId,
      input.deviceId,
      input.leaseEpoch,
      input.browserEpoch,
    ).toArray();
    await this.scheduleNextAlarm();
    return changed.length === 1 && changed[0]?.status === terminalStatus
      ? { status: terminalStatus, newlyClosed: true }
      : null;
  }

  async setDialogDelivery(
    sessionId: string,
    delivery: "ok" | "interrupted" | "overflow",
  ): Promise<void> {
    this.ctx.storage.sql.exec(
      `UPDATE lease SET dialog_delivery =
       CASE
         WHEN dialog_delivery = 'overflow' THEN 'overflow'
         WHEN ? = 'overflow' THEN 'overflow'
         WHEN ? = 'interrupted' THEN 'interrupted'
         ELSE dialog_delivery
       END
       WHERE session_id = ?`,
      delivery,
      delivery,
      sessionId,
    );
  }

  async revokeDevice(
    deviceId: string,
    expectedCredential?: {
      credentialDigest: string;
      credentialVersion: number;
    },
    now = Date.now(),
  ): Promise<boolean> {
    if (
      expectedCredential !== undefined &&
      !this.credentialFenceMatches(deviceId, expectedCredential)
    ) {
      return false;
    }
    const leases = this.activeLeasesForDevice(deviceId);
    this.ctx.storage.sql.exec(
      "UPDATE device SET enabled = 0 WHERE device_id = ?",
      deviceId,
    );
    this.ctx.storage.sql.exec(
      `UPDATE lease SET status = 'lost', release_at = ?, needs_reconciliation = 1
       WHERE device_id = ? AND release_at IS NULL
         AND status IN ('allocating','provisioning','connected','recovering','closing','expired')`,
      now,
      deviceId,
    );
    await this.scheduleNextAlarm();
    for (const lease of leases) {
      try {
        const session = await getAgentByName(this.env.SESSION, lease.session_id);
        await session.revokeDevice();
      } catch {
        // The coordinator's terminal lease remains authoritative.
      }
    }
    return true;
  }

  async listDevices(now = Date.now()): Promise<DeviceStatus[]> {
    return this.ctx.storage.sql
      .exec<DeviceRow>("SELECT * FROM device ORDER BY device_id")
      .toArray()
      .map((device) => {
        const used = this.activeLeasesForDevice(device.device_id).length;
        const capabilities = parseStringArray(device.capabilities_json);
        let status: DeviceStatus["status"];
        if (device.enabled !== 1) status = "disabled";
        else if (!capabilities.includes("safe-write-v2")) status = "incompatible";
        else if (now - device.last_seen_at > DEVICE_OFFLINE_MS) status = "offline";
        else if (
          this.activeLeasesForDevice(device.device_id).some((lease) => lease.status === "recovering")
        ) {
          status = "recovering";
        } else status = "online";
        return {
          deviceId: device.device_id,
          status,
          capacity: 2,
          used,
          browser: { browser: device.browser, extVersion: device.ext_version },
          lastSeenAt: new Date(device.last_seen_at).toISOString(),
        };
      });
  }

  async consumeDeviceTicketQuota(deviceId: string, now = Date.now()): Promise<boolean> {
    const allowed = this.consumeQuota(
      "device_ticket",
      deviceId,
      now,
      parseQuotaPolicy(this.env.QUOTA_POLICY).deviceTicketsPerDeviceMinute,
    );
    if (!allowed) {
      await emitTelemetry(this.env, {
        event: "quota",
        outcome: "device_ticket_denied",
        tenantId: this.tenantId,
        deviceId,
      });
    }
    return allowed;
  }

  async consumeSessionCreateQuota(
    actorPseudonym: string,
    now = Date.now(),
  ): Promise<boolean> {
    const allowed = this.consumeQuota(
      "session_create_actor",
      actorPseudonym,
      now,
      parseQuotaPolicy(this.env.QUOTA_POLICY).sessionCreatesPerActorMinute,
    );
    if (!allowed) {
      await emitTelemetry(this.env, {
        event: "quota",
        outcome: "session_create_denied",
        tenantId: this.tenantId,
        actor: actorPseudonym,
      });
    }
    return allowed;
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const devices = this.ctx.storage.sql.exec<DeviceRow>("SELECT * FROM device").toArray();
    const offlineDeviceIds = devices
      .filter(
        (device) =>
          now - device.last_seen_at >= DEVICE_OFFLINE_MS &&
          now - device.last_seen_at < DEVICE_LOST_MS,
      )
      .map((device) => device.device_id);
    const lostDeviceIds = devices
      .filter((device) => now - device.last_seen_at >= DEVICE_LOST_MS)
      .map((device) => device.device_id);
    const expiringLeases = this.leaseRows(
      `SELECT * FROM lease
       WHERE release_at IS NULL
         AND status IN ('allocating','provisioning','connected','recovering')
         AND (hard_expires_at <= ? OR idle_expires_at <= ?)`,
      now,
      now,
    );

    for (const deviceId of offlineDeviceIds) {
      this.ctx.storage.sql.exec(
        `UPDATE lease SET status = 'recovering', needs_reconciliation = 1,
             provisioning_deadline_at = ?
         WHERE device_id = ? AND release_at IS NULL
           AND status IN ('allocating','provisioning','connected')`,
        now + (DEVICE_LOST_MS - DEVICE_OFFLINE_MS),
        deviceId,
      );
      await emitTelemetry(this.env, {
        event: "device_offline",
        outcome: "recovering",
        tenantId: this.tenantId,
        deviceId,
      });
    }
    this.ctx.storage.sql.exec(
      `UPDATE lease SET status = 'expired'
       WHERE release_at IS NULL
         AND status IN ('allocating','provisioning','connected','recovering')
         AND (hard_expires_at <= ? OR idle_expires_at <= ?)`,
      now,
      now,
    );
    this.ctx.storage.sql.exec(
      `UPDATE lease SET status = 'closing', needs_reconciliation = 1
       WHERE release_at IS NULL AND status IN ('provisioning','recovering')
         AND provisioning_deadline_at <= ?`,
      now,
    );
    for (const deviceId of lostDeviceIds) {
      this.ctx.storage.sql.exec(
        `UPDATE lease SET status = 'lost', release_at = ?, needs_reconciliation = 1
         WHERE device_id = ? AND release_at IS NULL
           AND status IN ('allocating','provisioning','connected','recovering','closing','expired')`,
        now,
        deviceId,
      );
      await emitTelemetry(this.env, {
        event: "device_offline",
        outcome: "lost",
        tenantId: this.tenantId,
        deviceId,
      });
    }
    for (const lease of expiringLeases) {
      await emitTelemetry(this.env, {
        event: "session_expiry",
        outcome: lease.hard_expires_at <= now ? "hard" : "idle",
        tenantId: this.tenantId,
        deviceId: lease.device_id,
        sessionId: lease.session_id,
      });
    }

    const cleanup = this.leaseRows(
      `SELECT * FROM lease
       WHERE release_at IS NULL AND status IN ('closing','expired')
       ORDER BY created_at`,
    );
    for (const lease of cleanup) {
      try {
        // Not via api/sessions' getDeviceStub: that accessor is module-private
        // to the service layer. lease.device_id is coordinator-owned and this
        // DO is already tenant-scoped, so the global namespace is safe here.
        const device = this.env.DEVICE.getByName(lease.device_id);
        await device.requestClose(toLeaseResource(lease));
      } catch {
        // The lease stays reserved until a matching close ACK or device-loss release.
      }
    }

    const terminal = this.leaseRows(
      "SELECT * FROM lease WHERE status IN ('closed','expired','lost')",
    );
    for (const lease of terminal) {
      try {
        const session = await getAgentByName(this.env.SESSION, lease.session_id);
        await session.markLifecycle(lease.status, lease.needs_reconciliation === 1);
      } catch {
        // Status remains authoritative here and will be reconciled on the next read/alarm.
      }
    }
    await this.scheduleNextAlarm();
  }

  private device(deviceId: string): DeviceRow | undefined {
    return this.ctx.storage.sql
      .exec<DeviceRow>("SELECT * FROM device WHERE device_id = ?", deviceId)
      .toArray()[0];
  }

  private lease(sessionId: string): LeaseRow | undefined {
    return this.ctx.storage.sql
      .exec<LeaseRow>("SELECT * FROM lease WHERE session_id = ?", sessionId)
      .toArray()[0];
  }

  private leaseRows(query: string, ...values: (string | number)[]): LeaseRow[] {
    return this.ctx.storage.sql.exec<LeaseRow>(query, ...values).toArray();
  }

  private activeLeasesForDevice(deviceId: string): LeaseRow[] {
    return this.leaseRows(
      `SELECT * FROM lease
       WHERE device_id = ? AND release_at IS NULL
         AND status IN ('allocating','provisioning','connected','recovering','closing','expired')`,
      deviceId,
    );
  }

  private advanceCredentialFence(input: {
    deviceId: string;
    credentialDigest: string;
    credentialVersion: number;
  }): boolean {
    const existing = this.ctx.storage.sql
      .exec<DeviceCredentialRow>(
        "SELECT * FROM device_credential_fence WHERE device_id = ?",
        input.deviceId,
      )
      .toArray()[0];
    if (
      existing !== undefined &&
      (input.credentialVersion < existing.credential_version ||
        (input.credentialVersion === existing.credential_version &&
          input.credentialDigest !== existing.credential_digest))
    ) {
      return false;
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO device_credential_fence (
         device_id, credential_digest, credential_version
       ) VALUES (?, ?, ?)
       ON CONFLICT(device_id) DO UPDATE SET
         credential_digest = excluded.credential_digest,
         credential_version = excluded.credential_version`,
      input.deviceId,
      input.credentialDigest,
      input.credentialVersion,
    );
    return true;
  }

  private credentialFenceMatches(
    deviceId: string,
    expected: {
      credentialDigest: string;
      credentialVersion: number;
    },
  ): boolean {
    const row = this.ctx.storage.sql
      .exec<DeviceCredentialRow>(
        "SELECT * FROM device_credential_fence WHERE device_id = ?",
        deviceId,
      )
      .toArray()[0];
    return (
      row?.credential_digest === expected.credentialDigest &&
      row.credential_version === expected.credentialVersion
    );
  }

  private onlineCompatibleDevices(now: number): DeviceRow[] {
    const rows = this.ctx.storage.sql
      .exec<DeviceRow>(
        `SELECT * FROM device
         WHERE enabled = 1 AND last_seen_at > ?
         ORDER BY last_assigned_at ASC, device_id ASC`,
        now - DEVICE_OFFLINE_MS,
      )
      .toArray()
      .filter((device) =>
        parseStringArray(device.capabilities_json).includes("safe-write-v2") &&
        !this.activeLeasesForDevice(device.device_id).some(
          (lease) => lease.status === "recovering",
        ),
      );
    return rows.sort((left, right) => {
      const capacity = this.activeLeasesForDevice(left.device_id).length -
        this.activeLeasesForDevice(right.device_id).length;
      if (capacity !== 0) return capacity;
      if (left.last_assigned_at !== right.last_assigned_at) {
        return left.last_assigned_at - right.last_assigned_at;
      }
      return left.device_id.localeCompare(right.device_id);
    });
  }

  private consumeQuota(scope: string, subject: string, now: number, limit: number): boolean {
    return this.consumeQuotas([{ scope, subject, limit }], now);
  }

  private consumeQuotas(
    quotas: Array<{ scope: string; subject: string; limit: number }>,
    now: number,
  ): boolean {
    const bucket = Math.floor(now / 60_000);
    return this.ctx.storage.transactionSync(() => {
      for (const quota of quotas) {
        const row = this.ctx.storage.sql
          .exec<{ count: number }>(
            "SELECT count FROM quota_counter WHERE scope = ? AND subject = ? AND bucket = ?",
            quota.scope,
            quota.subject,
            bucket,
          )
          .toArray()[0];
        if ((row?.count ?? 0) >= quota.limit) return false;
      }
      for (const quota of quotas) {
        this.ctx.storage.sql.exec(
          `INSERT INTO quota_counter (scope, subject, bucket, count) VALUES (?, ?, ?, 1)
           ON CONFLICT(scope, subject, bucket) DO UPDATE SET count = count + 1`,
          quota.scope,
          quota.subject,
          bucket,
        );
      }
      this.ctx.storage.sql.exec("DELETE FROM quota_counter WHERE bucket < ?", bucket - 2);
      return true;
    });
  }

  private async scheduleNextAlarm(): Promise<void> {
    const now = Date.now();
    const deadline = this.ctx.storage.sql
      .exec<{ deadline: number | null }>(
        `SELECT MIN(deadline) AS deadline FROM (
           SELECT MIN(idle_expires_at, hard_expires_at) AS deadline
             FROM lease WHERE release_at IS NULL
               AND status IN ('allocating','provisioning','connected','recovering')
           UNION ALL
           SELECT provisioning_deadline_at AS deadline
             FROM lease WHERE release_at IS NULL AND status IN ('provisioning','recovering')
           UNION ALL
           SELECT last_seen_at + ${DEVICE_OFFLINE_MS} AS deadline FROM device WHERE enabled = 1
           UNION ALL
           SELECT last_seen_at + ${DEVICE_LOST_MS} AS deadline FROM device WHERE enabled = 1
         ) WHERE deadline > ?`,
        now,
      )
      .toArray()[0]?.deadline;
    if (deadline === null || deadline === undefined) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(Math.max(now + 1, deadline));
  }
}

function toLeaseResource(row: LeaseRow): LeaseResource {
  return {
    sessionId: row.session_id,
    leaseId: row.lease_id,
    deviceId: row.device_id,
    status: row.status,
    allowedOrigins: parseStringArray(row.allowed_origins_json),
    leaseEpoch: row.lease_epoch,
    browserEpoch: row.browser_epoch,
    createdAt: row.created_at,
    lastActivityAt: row.last_activity_at,
    idleExpiresAt: row.idle_expires_at,
    hardExpiresAt: row.hard_expires_at,
    needsReconciliation: row.needs_reconciliation === 1,
    dialogDelivery: row.dialog_delivery,
  };
}

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string")
      ? parsed
      : [];
  } catch {
    return [];
  }
}

function intersects(left: readonly string[], right: readonly string[]): boolean {
  const set = new Set(left);
  return right.some((value) => set.has(value));
}

function isSubset(values: readonly string[], allowed: readonly string[]): boolean {
  const set = new Set(allowed);
  return values.every((value) => set.has(value));
}

function isTerminal(status: UnattendedSessionLifecycle): boolean {
  return status === "closed" || status === "expired" || status === "lost";
}
