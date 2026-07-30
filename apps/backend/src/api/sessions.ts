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
import type { DirectoryDeviceRecord } from "../account-directory";
import type { Actor } from "../auth";
import { mintSessionId, scopeSession, telemetryPseudonym } from "../auth";
import type { DeviceAgent } from "../device";
import type { SessionAgent } from "../session";
import { emitTelemetry } from "../telemetry";
import type { TenantDeviceCoordinator } from "../tenant-coordinator";
import type { DispatchOutcome, Env, V2DispatchOutcome } from "../types";
import { canonicalizeUnattendedRequest, RequestBodyError } from "../validation";

export function getSessionStub(
  env: Env,
  sessionId: string,
): Promise<DurableObjectStub<SessionAgent>> {
  return getAgentByName(env.SESSION, sessionId);
}

export function getTenantStub(
  env: Env,
  tenantId: string,
): DurableObjectStub<TenantDeviceCoordinator> {
  return env.TENANT_CONTROL.getByName(tenantId);
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

export function sessionLocation(requestUrl: string, sessionId: string): string {
  return new URL(`/v1/sessions/${encodeURIComponent(sessionId)}`, requestUrl).toString();
}

export function commandLocation(
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
  | { kind: "provision_failed" }
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
      if (allocation.created) {
        try {
          await session.initializeUnattended(actor.tenantId, allocation.lease);
          const device = env.DEVICE.getByName(
            allocation.lease.deviceId,
          ) as DurableObjectStub<DeviceAgent>;
          if (!(await device.requestProvision(allocation.lease))) {
            throw new Error("device connection unavailable");
          }
        } catch {
          await coordinator.markProvisionFailed({
            sessionId,
            leaseId: allocation.lease.leaseId,
            deviceId: allocation.lease.deviceId,
            leaseEpoch: allocation.lease.leaseEpoch,
            browserEpoch: allocation.lease.browserEpoch,
          });
          await session.markLifecycle("closing", true);
          return { kind: "provision_failed" };
        }
      }
      const connected = await session.waitForProtocolV2Connection(5_000);
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
    const device = env.DEVICE.getByName(
      closing.lease.deviceId,
    ) as DurableObjectStub<DeviceAgent>;
    await device.requestClose(closing.lease);
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

  if (input.contractV2 || (await stub.usesV2CommandProtocol())) {
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
    credentialFill: command.type === "fill_secret" && !input.dryRun,
  });
  if (!admitted) return { kind: "legacy_quota_exceeded" };

  const outcome: DispatchOutcome =
    command.type === "fill_secret"
      ? await stub.fillSecret(command, input.dryRun)
      : await stub.dispatch(command, input.dryRun);
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
