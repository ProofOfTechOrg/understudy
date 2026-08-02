/**
 * Caller-facing session service layer.
 *
 * The bodies of the /v1 session/device Hono handlers live here as
 * transport-neutral functions taking (env, actor, input) and returning typed
 * result unions; src/index.ts maps each result to the exact HTTP response it
 * produced before the extraction, and the MCP layer maps the same results to
 * tool outcomes. One admission path: a tenant gate, quota, or telemetry call
 * added here is enforced for every caller class at once — new callers must
 * never reach SessionAgent/TenantDeviceCoordinator stubs directly.
 *
 * Every function re-derives session ownership via scopeSession even when the
 * HTTP adapter already checked it (the adapter's early check preserves the
 * historical 404-before-body-parse ordering; the check here is what a
 * non-HTTP caller relies on). Failure is "not_found", never "forbidden" —
 * DL-008's no-existence-oracle rule.
 */

import { getAgentByName } from "agents";
import type {
  Command,
  UnattendedSessionLifecycle,
  UnattendedSessionRequest,
} from "@understudy/protocol";
import { isWriteCommand } from "@understudy/protocol";
import type {
  ClaimPairingOfferResult,
  DirectoryDeviceRecord,
  OriginPolicyDevicePlan,
  SetOriginsResult,
} from "../account-directory";
import { getDirectory } from "../account-directory";
import type { Actor, DeviceIdentity } from "../auth";
import { mintSessionId, mintWsTicket, scopeSession, telemetryPseudonym } from "../auth";
import type { DeviceAgent, RevokeCredentialOutcome } from "../device";
import type { SessionAgent } from "../session";
import { emitTelemetry, type TelemetryEvent } from "../telemetry";
import type { TenantDeviceCoordinator } from "../tenant-coordinator";
import type { DispatchOutcome, Env, V2DispatchOutcome } from "../types";
import {
  canonicalizeOrigins,
  canonicalizeUnattendedRequest,
  RequestBodyError,
} from "../validation";

export function getSessionStub(
  env: Env,
  sessionId: string,
): Promise<DurableObjectStub<SessionAgent>> {
  return getAgentByName(env.SESSION, sessionId);
}

// Module-private: the device-control coordinator/agent stubs are reached only
// through this service layer, never from a route handler. Keeping this
// unexported is what enforces "no caller reaches the coordinator/device stubs
// directly" — the device-connect-ticket route now goes through
// mintDeviceConnectTicket below instead of grabbing the stub itself.
function getTenantStub(
  env: Env,
  tenantId: string,
): DurableObjectStub<TenantDeviceCoordinator> {
  return env.TENANT_CONTROL.getByName(tenantId);
}

// The DeviceAgent half of the same invariant. Note the namespace is global —
// unlike TENANT_CONTROL, the name carries no tenant — so every caller must
// pass an already-authorized deviceId AND the agent must re-fence on tenant.
function getDeviceStub(env: Env, deviceId: string): DurableObjectStub<DeviceAgent> {
  return env.DEVICE.getByName(deviceId);
}

export async function suspendDeviceForCredentialRotation(
  env: Env,
  claim: Extract<ClaimPairingOfferResult, { kind: "ok" }>,
): Promise<boolean> {
  if (claim.rotatedFrom === undefined) return true;
  return getTenantStub(env, claim.tenantId).suspendForCredentialRotation(
    claim.deviceId,
    claim.rotatedFrom,
  );
}

/**
 * Tenant allowlist check for UNATTENDED_ENABLED_TENANTS /
 * SAFE_WRITE_REQUIRED_TENANTS. Entries are exact tenant ids or
 * `prefix:<p>` for a tenant class (e.g. "prefix:acct-" for self-serve
 * accounts). A bare "*" deliberately enables nothing: the docs forbid
 * wildcard enablement, and a capability the code carries but policy forbids
 * is a standing footgun — a prefix entry is the auditable replacement.
 */
export function enabledForTenant(raw: string, tenantId: string): boolean {
  try {
    const parsed = JSON.parse(raw || "[]") as unknown;
    if (!Array.isArray(parsed)) return false;
    return parsed.some(
      (entry) =>
        entry === tenantId ||
        (typeof entry === "string" &&
          entry.startsWith("prefix:") &&
          entry.length > "prefix:".length &&
          tenantId.startsWith(entry.slice("prefix:".length))),
    );
  } catch {
    return false;
  }
}

function sessionLocation(requestUrl: string, sessionId: string): string {
  return new URL(`/v1/sessions/${encodeURIComponent(sessionId)}`, requestUrl).toString();
}

function commandLocation(
  requestUrl: string,
  sessionId: string,
  commandId: string,
): string {
  return new URL(
    `/v1/sessions/${encodeURIComponent(sessionId)}/commands/${encodeURIComponent(commandId)}`,
    requestUrl,
  ).toString();
}

type SessionStatusPayload = Awaited<
  ReturnType<DurableObjectStub<SessionAgent>["getStatus"]>
>;

type DeviceStatusPayload = Awaited<
  ReturnType<DurableObjectStub<TenantDeviceCoordinator>["listDevices"]>
>;

type CommandStatusPayload = NonNullable<
  Awaited<ReturnType<DurableObjectStub<SessionAgent>["getCommandStatus"]>>
>;

export type CreateAttendedSessionResult =
  | { kind: "quota_exceeded" }
  | { kind: "created"; sessionId: string };

export async function createAttendedSession(
  env: Env,
  actor: Actor,
  idempotencyKey: string | undefined,
): Promise<CreateAttendedSessionResult> {
  const actorPseudonym = await telemetryPseudonym("actor", actor.actor, env);
  if (
    !(await getTenantStub(env, actor.tenantId).consumeSessionCreateQuota(actorPseudonym))
  ) {
    return { kind: "quota_exceeded" };
  }
  const sessionId = await mintSessionId(actor.tenantId, env, idempotencyKey);
  await emitTelemetry(env, {
    event: "session_create",
    outcome: "attended",
    tenantId: actor.tenantId,
    actor: actor.actor,
    sessionId,
  });
  return { kind: "created", sessionId };
}

export interface CreateSessionInput {
  request: UnattendedSessionRequest;
  idempotencyKey: string;
  /** Absolute URL Location headers derive from (the incoming request's URL). */
  requestUrl: string;
}

export type CreateSessionResult =
  | { kind: "bad_request"; message: string; status: 400 | 413 }
  | { kind: "disabled" }
  | { kind: "idempotency_conflict" }
  | { kind: "terminal"; sessionId: string; status: UnattendedSessionLifecycle }
  | { kind: "device_not_found" }
  | { kind: "no_device" }
  | { kind: "capacity" }
  | { kind: "collision" }
  | {
      kind: "pending";
      sessionId: string;
      status: UnattendedSessionLifecycle;
      location: string;
    }
  | { kind: "connected"; sessionId: string; created: boolean };

export async function createSession(
  env: Env,
  actor: Actor,
  input: CreateSessionInput,
): Promise<CreateSessionResult> {
  if (!enabledForTenant(env.UNATTENDED_ENABLED_TENANTS, actor.tenantId)) {
    return { kind: "disabled" };
  }

  let canonical;
  try {
    canonical = await canonicalizeUnattendedRequest(input.request, actor.tenantId, env);
  } catch (error) {
    if (error instanceof RequestBodyError) {
      return { kind: "bad_request", message: error.message, status: error.status };
    }
    return { kind: "bad_request", message: "invalid body", status: 400 };
  }
  const sessionId = await mintSessionId(actor.tenantId, env, input.idempotencyKey);
  const actorPseudonym = await telemetryPseudonym("actor", actor.actor, env);
  const coordinator = getTenantStub(env, actor.tenantId);
  const allocation = await coordinator.createLease({
    idempotencyKey: input.idempotencyKey,
    fingerprint: canonical.fingerprint,
    sessionId,
    ...(canonical.deviceId === undefined ? {} : { deviceId: canonical.deviceId }),
    allowedOrigins: canonical.allowedOrigins,
    profileStateHash: canonical.profileStateHash,
    actorPseudonym,
  });
  await emitTelemetry(env, {
    event: allocation.kind === "replay" ? "session_replay" : "session_create",
    outcome: allocation.kind,
    tenantId: actor.tenantId,
    actor: actor.actor,
    sessionId,
    ...("lease" in allocation ? { deviceId: allocation.lease.deviceId } : {}),
  });

  switch (allocation.kind) {
    case "conflict":
      return { kind: "idempotency_conflict" };
    case "terminal":
      return { kind: "terminal", sessionId, status: allocation.status };
    case "device_not_found":
      return { kind: "device_not_found" };
    case "no_device":
      return { kind: "no_device" };
    case "capacity":
      return { kind: "capacity" };
    case "collision":
      return { kind: "collision" };
    case "created":
    case "replay": {
      const session = await getSessionStub(env, sessionId);
      if (
        allocation.lease.status === "allocating" ||
        allocation.lease.status === "provisioning"
      ) {
        try {
          await session.initializeUnattended(actor.tenantId, allocation.lease);
        } catch {
          await coordinator.releaseProvisioning({
            sessionId,
            leaseId: allocation.lease.leaseId,
            deviceId: allocation.lease.deviceId,
            leaseEpoch: allocation.lease.leaseEpoch,
            browserEpoch: allocation.lease.browserEpoch,
          });
          await session.markLifecycle("closed", false);
          return { kind: "terminal", sessionId, status: "closed" };
        }
        const device = getDeviceStub(env, allocation.lease.deviceId);
        let dispatched: boolean;
        try {
          dispatched = await device.requestProvision(allocation.lease);
        } catch {
          await coordinator.markProvisionFailed({
            sessionId,
            leaseId: allocation.lease.leaseId,
            deviceId: allocation.lease.deviceId,
            leaseEpoch: allocation.lease.leaseEpoch,
            browserEpoch: allocation.lease.browserEpoch,
          });
          await session.markLifecycle("closing", true);
          return {
            kind: "pending",
            sessionId,
            status: "closing",
            location: sessionLocation(input.requestUrl, sessionId),
          };
        }
        if (!dispatched) {
          await coordinator.releaseProvisioning({
            sessionId,
            leaseId: allocation.lease.leaseId,
            deviceId: allocation.lease.deviceId,
            leaseEpoch: allocation.lease.leaseEpoch,
            browserEpoch: allocation.lease.browserEpoch,
          });
          await session.markLifecycle("closed", false);
          return { kind: "terminal", sessionId, status: "closed" };
        }
      }
      const connected = await session.waitForProtocolV3Connection(5_000);
      if (!connected) {
        return {
          kind: "pending",
          sessionId,
          status: allocation.lease.status,
          location: sessionLocation(input.requestUrl, sessionId),
        };
      }
      return { kind: "connected", sessionId, created: allocation.created };
    }
  }
}

export function listDevices(env: Env, actor: Actor): Promise<DeviceStatusPayload> {
  return getTenantStub(env, actor.tenantId).listDevices();
}

async function prepareOriginPolicyUpdate(
  env: Env,
  tenantId: string,
  devices: OriginPolicyDevicePlan[],
  allowedOrigins: string[],
): Promise<boolean> {
  const coordinator = getTenantStub(env, tenantId);
  for (const device of devices) {
    try {
      if (
        await coordinator.updateDevicePolicy({
          deviceId: device.deviceId,
          policyVersion: device.policyVersion,
          allowedOrigins,
          narrowing: device.narrowing,
        })
      ) {
        continue;
      }
    } catch {
      // The directory operation remains pending and can be resumed exactly.
    }
    return false;
  }
  return true;
}

export async function updateOriginPolicyForOwner(
  env: Env,
  owner: { userId: string; tenantId: string },
  requestedOrigins: string[],
): Promise<SetOriginsResult> {
  let targetOrigins: string[];
  try {
    targetOrigins = canonicalizeOrigins(requestedOrigins);
  } catch (error) {
    return {
      kind: "invalid",
      message: error instanceof RequestBodyError ? error.message : "invalid origin policy",
    };
  }
  const directory = getDirectory(env);
  for (let pass = 0; pass < 4; pass += 1) {
    const pending = await directory.beginAllowedOriginsUpdate(owner.userId, targetOrigins);
    if (pending.kind === "invalid") return pending;
    if (
      !(await prepareOriginPolicyUpdate(
        env,
        owner.tenantId,
        pending.devices,
        pending.origins,
      ))
    ) {
      return { kind: "invalid", message: "browser policies are still reconciling; retry" };
    }
    const committed = await directory.commitAllowedOriginsUpdate(
      owner.userId,
      pending.operationId,
    );
    if (committed.kind === "invalid") return committed;
    await pushOriginPolicyUpdate(env, owner.tenantId, committed.devices, committed.origins);
    if (sameOrigins(committed.origins, targetOrigins)) return committed;
  }
  return { kind: "invalid", message: "browser policies changed concurrently; retry" };
}

async function pushOriginPolicyUpdate(
  env: Env,
  tenantId: string,
  devices: Array<{ deviceId: string; policyVersion: number }>,
  allowedOrigins: string[],
): Promise<void> {
  await Promise.allSettled(
    devices.map((device) =>
      getDeviceStub(env, device.deviceId).pushPolicy(
        tenantId,
        device.policyVersion,
        allowedOrigins,
      ),
    ),
  );
}

function sameOrigins(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((origin, index) => origin === right[index]);
}

export type MintTicketResult =
  | { kind: "quota_exceeded" }
  | { kind: "device_not_found" }
  | {
      kind: "ok";
      ticket: string;
      expiresIn: number;
      websocketPath: string;
      allowedOrigins: string[];
      policyVersion: number;
    };

/**
 * Device connect-ticket issuance for an already-authenticated device (either
 * class — the caller resolves identity via authenticateDeviceComposite). Lives
 * here so the /v1/device/connect-ticket route is an adapter like the session
 * routes, and the coordinator/DeviceAgent stubs stay behind the service layer.
 */
export async function mintDeviceConnectTicket(
  env: Env,
  device: DeviceIdentity,
  browserEpoch: string,
): Promise<MintTicketResult> {
  const coordinator = getTenantStub(env, device.tenantId);
  if (!(await coordinator.consumeDeviceTicketQuota(device.deviceId))) {
    return { kind: "quota_exceeded" };
  }
  const agent = getDeviceStub(env, device.deviceId);
  if (!(await agent.authorizeCredential(device))) {
    return { kind: "device_not_found" };
  }
  const ticket = await mintWsTicket(
    {
      aud: "device-control",
      tenantId: device.tenantId,
      deviceId: device.deviceId,
      credentialVersion: device.credentialVersion,
      allowedOrigins: device.allowedOrigins,
      policyVersion: device.policyVersion,
      leaseEpoch: 0,
      browserEpoch,
      agentName: device.deviceId,
    },
    env,
  );
  return {
    kind: "ok",
    ticket,
    expiresIn: 60,
    websocketPath: `/agents/device/${encodeURIComponent(device.deviceId)}`,
    allowedOrigins: device.allowedOrigins,
    policyVersion: device.policyVersion,
  };
}

/**
 * A revoke outcome as the caller may observe it. Deliberately narrower than
 * the directory's three-way result: "already_revoked" and "not_found" must stay
 * indistinguishable outside this module, or the caller becomes an existence
 * oracle for another account's device ids (DL-008). The distinction is real and
 * load-bearing — it gates the push — but it is this module's business.
 */
export type OwnerRevokeResult = "revoked" | "not_revoked";

/**
 * Owner-initiated device revocation: ownership check, authoritative row flip,
 * and kill-switch push, in that order.
 *
 * This is the ONLY path to the push, which is why pushDeviceRevocation below is
 * module-private. `deviceId` is attacker-controlled form input and the DEVICE
 * namespace is global, so handing an unverified id to getDeviceStub would let a
 * caller permanently mark another account's device. The directory flip doubles
 * as that check: it is scoped by userId, so anything other than "not_found"
 * proves the row is the caller's. Taking the owner as one object rather than a
 * (userId, tenantId) pair is deliberate — two same-typed positional strings
 * that must correspond are a swap waiting to happen.
 *
 * `owner.tenantId` is the right tenant to fence the DeviceAgent on because
 * `devices.tenant_id` has a single writer (claimPairingOffer, which copies the
 * claiming user's tenant) and `users.tenant_id` is never updated after
 * ensureUser. Should tenants ever become multi-user or renameable, this is the
 * one site that must start reading the tenant off the device row instead.
 *
 * Pushes on "already_revoked" too. The card disappears once the row is flipped
 * (listDevices filters revoked_at IS NULL), so that outcome is a double submit
 * or a replayed POST rather than a user re-click — the teardown is idempotent
 * and covers a first push that never landed.
 */
export async function revokeDeviceForOwner(
  env: Env,
  owner: { userId: string; tenantId: string },
  deviceId: string,
): Promise<OwnerRevokeResult> {
  const outcome = await getDirectory(env).revokeDevice(owner.userId, deviceId);
  if (outcome !== "not_found") {
    await pushDeviceRevocation(env, owner.tenantId, deviceId);
  }
  return outcome === "revoked" ? "revoked" : "not_revoked";
}

const PUSH_TELEMETRY: Record<
  RevokeCredentialOutcome | "push_failed",
  { event: TelemetryEvent; outcome: string }
> = {
  // Only this one is a device going offline; the rest are operations that left
  // the device running, so they must not inflate device_offline rates.
  closed: { event: "device_offline", outcome: "revoked_by_owner" },
  no_socket: { event: "device_revoke", outcome: "revoked_by_owner_offline" },
  wrong_tenant: { event: "device_revoke", outcome: "tenant_mismatch" },
  push_failed: { event: "device_revoke", outcome: "push_failed" },
};

/**
 * The teardown half of the kill switch: DeviceAgent marker + socket teardown
 * FIRST (instant, including for already-minted tickets),
 * coordinator lease/session cleanup second. Agent-first is deliberate: marker +
 * dead socket means zero reconnects even if the coordinator leg never runs,
 * whereas coordinator-first with a crash strands a live socket in a
 * heartbeat-reject reconnect flap.
 *
 * Both legs are best-effort, and only the agent leg is durable. If it throws,
 * the directory revocation still blocks fresh tickets and heartbeat liveness
 * closes an existing connection. The coordinator leg does not cover that gap:
 * registerDevice's upsert sets `enabled = 1`, so
 * the device's own reconnect re-enables the row (this resurrection is why
 * agent-first wins, not because the flap is unique to coordinator-first). The
 * directory's revoked_at flip stays authoritative throughout, which is what
 * the heartbeat's deviceCredentialLive check reads, so the backstop still
 * fires. A failed leg is invisible to the user — the dashboard reports the row
 * flip, which did happen — so every outcome emits telemetry.
 *
 * Module-private: it performs no ownership check of its own, and the tenant it
 * fences on is only as good as the caller's. revokeDeviceForOwner is the path.
 */
async function pushDeviceRevocation(
  env: Env,
  tenantId: string,
  deviceId: string,
): Promise<void> {
  let outcome: RevokeCredentialOutcome | "push_failed" = "push_failed";
  try {
    outcome = await getDeviceStub(env, deviceId).revokeCredential(tenantId);
  } catch {
    // Left as "push_failed".
  }
  try {
    // Unfenced deliberately: an owner-initiated revoke kills every generation
    // of the credential, not just the one the caller happens to know about.
    await getTenantStub(env, tenantId).revokeDevice(deviceId);
  } catch {
    await emitTelemetry(env, {
      event: "device_revoke",
      outcome: "cleanup_failed",
      tenantId,
      deviceId,
    });
  }
  // Never the heartbeat path's "credential_revoked": both mean a browser lost
  // its credential, but only this one says the kill switch did it instantly.
  // Sharing an outcome would make the feature's whole value proposition —
  // instant rather than lazy — unmeasurable in production.
  await emitTelemetry(env, { ...PUSH_TELEMETRY[outcome], tenantId, deviceId });
}

/**
 * A paired device joined with its live coordinator state. The one place the
 * directory record (identity, label, allowed origins) meets the runtime
 * status (online/offline, capacity) — MCP browser_open, MCP browser_status,
 * and the dashboard home all render from this instead of re-deriving the join.
 */
export interface AccountDeviceView {
  deviceId: string;
  label: string | null;
  status:
    | "online"
    | "offline"
    | "recovering"
    | "disabled"
    | "incompatible"
    | "never_connected";
  used: number | null;
  capacity: number | null;
  lastSeenAt: string | null;
  allowedOrigins: string[];
}

export function mergeDeviceViews(
  directoryDevices: DirectoryDeviceRecord[],
  liveDevices: DeviceStatusPayload,
): AccountDeviceView[] {
  const liveById = new Map(liveDevices.map((device) => [device.deviceId, device]));
  return directoryDevices.map((device) => {
    const live = liveById.get(device.deviceId);
    return {
      deviceId: device.deviceId,
      label: device.label,
      status: live?.status ?? ("never_connected" as const),
      used: live?.used ?? null,
      capacity: live?.capacity ?? null,
      lastSeenAt: live?.lastSeenAt ?? null,
      allowedOrigins: device.allowedOrigins,
    };
  });
}

export type GetSessionStatusResult =
  | { kind: "not_found" }
  | { kind: "ok"; status: SessionStatusPayload; terminal: boolean };

export async function getSessionStatus(
  env: Env,
  actor: Actor,
  sessionId: string,
): Promise<GetSessionStatusResult> {
  if ((await scopeSession(sessionId, actor.tenantId, env)) === "not-found") {
    return { kind: "not_found" };
  }
  const session = await getSessionStub(env, sessionId);
  const status = await session.getStatus();
  if ("mode" in status && status.mode === "unattended") {
    return {
      kind: "ok",
      status,
      terminal:
        status.status === "closed" ||
        status.status === "expired" ||
        status.status === "lost",
    };
  }
  return { kind: "ok", status, terminal: await session.isTerminal() };
}

export type DeleteSessionResult =
  | { kind: "not_found" }
  | { kind: "closed" }
  | { kind: "closing"; location: string };

export async function deleteSession(
  env: Env,
  actor: Actor,
  sessionId: string,
  requestUrl: string,
): Promise<DeleteSessionResult> {
  if ((await scopeSession(sessionId, actor.tenantId, env)) === "not-found") {
    return { kind: "not_found" };
  }
  const session = await getSessionStub(env, sessionId);
  const status = await session.getStatus();
  if (!("mode" in status) || status.mode !== "unattended") {
    const confirmed = await session.requestCloseAttended();
    await emitTelemetry(env, {
      event: "session_close",
      outcome: confirmed ? "confirmed" : "pending",
      tenantId: actor.tenantId,
      actor: actor.actor,
      sessionId,
    });
    return confirmed
      ? { kind: "closed" }
      : { kind: "closing", location: sessionLocation(requestUrl, sessionId) };
  }
  const coordinator = getTenantStub(env, actor.tenantId);
  const closing = await coordinator.closeLease(sessionId);
  if (!closing.found) return { kind: "not_found" };
  if (closing.cleanupConfirmed) {
    await emitTelemetry(env, {
      event: "session_close",
      outcome: "confirmed",
      tenantId: actor.tenantId,
      actor: actor.actor,
      sessionId,
    });
    return { kind: "closed" };
  }
  if (closing.lease !== undefined) {
    await session.markLifecycle("closing", closing.lease.needsReconciliation);
    const device = getDeviceStub(env, closing.lease.deviceId);
    try {
      await device.requestClose(closing.lease);
    } catch {
      // The exact-fenced closing lease is durable; alarms and inventory
      // reconciliation retry delivery while the polling handle remains valid.
    }
  }
  await emitTelemetry(env, {
    event: "session_close",
    outcome: "pending",
    tenantId: actor.tenantId,
    actor: actor.actor,
    sessionId,
    deviceId: closing.lease?.deviceId,
  });
  return { kind: "closing", location: sessionLocation(requestUrl, sessionId) };
}

export interface DispatchCommandInput {
  command: Command;
  dryRun: boolean;
  /** Whether the caller speaks the v2 command contract natively. */
  contractV2: boolean;
  requestUrl: string;
}

export type DispatchCommandResult =
  | { kind: "not_found" }
  | { kind: "terminal_session" }
  | { kind: "v2"; outcome: V2DispatchOutcome }
  | { kind: "legacy_unsupported_write" }
  | { kind: "legacy_quota_exceeded" }
  | { kind: "legacy"; outcome: DispatchOutcome };

export async function dispatchCommand(
  env: Env,
  actor: Actor,
  sessionId: string,
  input: DispatchCommandInput,
): Promise<DispatchCommandResult> {
  if ((await scopeSession(sessionId, actor.tenantId, env)) === "not-found") {
    return { kind: "not_found" };
  }
  const command = input.command;
  const stub = await getSessionStub(env, sessionId);
  if (await stub.isTerminal()) {
    return { kind: "terminal_session" };
  }

  if (input.contractV2 || (await stub.usesV3CommandProtocol())) {
    const statusUrl = commandLocation(input.requestUrl, sessionId, command.commandId);
    const actorPseudonym = await telemetryPseudonym("actor", actor.actor, env);
    const outcome = await stub.dispatchV2(command, input.dryRun, actorPseudonym, statusUrl);
    await emitTelemetry(env, {
      event: "command",
      outcome: outcome.kind,
      tenantId: actor.tenantId,
      actor: actor.actor,
      sessionId,
      commandType: command.type,
    });
    return { kind: "v2", outcome };
  }

  if (
    isWriteCommand(command) &&
    !input.dryRun &&
    enabledForTenant(env.SAFE_WRITE_REQUIRED_TENANTS, actor.tenantId)
  ) {
    return { kind: "legacy_unsupported_write" };
  }

  const actorPseudonym = await telemetryPseudonym("actor", actor.actor, env);
  const admitted = await getTenantStub(env, actor.tenantId).authorizeAttendedCommand({
    sessionId,
    actorPseudonym,
  });
  if (!admitted) return { kind: "legacy_quota_exceeded" };

  const outcome: DispatchOutcome = await stub.dispatch(command, input.dryRun);
  await emitTelemetry(env, {
    event: "command",
    outcome: outcome.ok ? "legacy_terminal" : `legacy_${outcome.reason}`,
    tenantId: actor.tenantId,
    actor: actor.actor,
    sessionId,
    commandType: command.type,
  });
  return { kind: "legacy", outcome };
}

export type PollCommandResult =
  | { kind: "not_found" }
  | { kind: "invalid_command_id" }
  | { kind: "ok"; record: CommandStatusPayload };

export async function pollCommand(
  env: Env,
  actor: Actor,
  sessionId: string,
  commandId: string,
): Promise<PollCommandResult> {
  if ((await scopeSession(sessionId, actor.tenantId, env)) === "not-found") {
    return { kind: "not_found" };
  }
  if (commandId.length < 1 || commandId.length > 128) {
    return { kind: "invalid_command_id" };
  }
  const record = await (await getSessionStub(env, sessionId)).getCommandStatus(commandId);
  if (record === null) return { kind: "not_found" };
  return { kind: "ok", record };
}
