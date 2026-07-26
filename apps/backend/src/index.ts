import { Hono, type Context } from "hono";
import { getAgentByName, routeAgentRequest } from "agents";
import { z } from "zod";
import {
  CommandRequestSchema,
  SESSION_RESULT_FRAME_MAX_BYTES,
  UnattendedSessionRequestSchema,
  isWriteCommand,
} from "@understudy/protocol";
import {
  authenticate,
  authenticateDevice,
  mintSessionId,
  mintWsTicket,
  scopeSession,
  SESSION_IDEMPOTENCY_KEY_PATTERN,
  telemetryPseudonym,
  verifyExtensionToken,
  verifyWsTicket,
} from "./auth";
import type { DeviceAgent } from "./device";
import type { SessionAgent } from "./session";
import type { TenantDeviceCoordinator } from "./tenant-coordinator";
import type { DispatchOutcome, Env, V2DispatchOutcome } from "./types";
import {
  canonicalizeUnattendedRequest,
  parseBoundedStrictJson,
  RequestBodyError,
} from "./validation";
import { emitTelemetry } from "./telemetry";
import type { Actor, DeviceIdentity } from "./auth";

export { DeviceAgent } from "./device";
export { SessionAgent } from "./session";
export { TenantDeviceCoordinator } from "./tenant-coordinator";

const app = new Hono<{ Bindings: Env }>();
const DeviceTicketRequestSchema = z
  .object({ browserEpoch: z.string().min(1).max(128) })
  .strict();

function getSessionStub(env: Env, sessionId: string): Promise<DurableObjectStub<SessionAgent>> {
  return getAgentByName(env.SESSION, sessionId);
}

function getTenantStub(
  env: Env,
  tenantId: string,
): DurableObjectStub<TenantDeviceCoordinator> {
  return env.TENANT_CONTROL.getByName(tenantId);
}

app.get("/health", (c) => c.json({ ok: true }));

app.post("/v1/sessions", async (c) => {
  const authentication = await authenticateCaller(c.req.raw, c.env);
  if (authentication.kind === "unauthorized") return c.json({ error: "unauthorized" }, 401);
  if (authentication.kind === "rate_limited") return c.json({ error: "rate limited" }, 429);
  const actor = authentication.actor;

  const idempotencyKey = c.req.header("idempotency-key")?.trim().toLowerCase();
  if (
    idempotencyKey !== undefined &&
    !SESSION_IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)
  ) {
    return c.json({ error: "idempotency-key must be a UUID" }, 400);
  }

  if (c.req.raw.body === null) {
    const actorPseudonym = await telemetryPseudonym("actor", actor.actor, c.env);
    if (
      !(await getTenantStub(c.env, actor.tenantId).consumeSessionCreateQuota(
        actorPseudonym,
      ))
    ) {
      return c.json({ error: "session creation quota exceeded" }, 429);
    }
    const sessionId = await mintSessionId(actor.tenantId, c.env, idempotencyKey);
    await emitTelemetry(c.env, {
      event: "session_create",
      outcome: "attended",
      tenantId: actor.tenantId,
      actor: actor.actor,
      sessionId,
    });
    return c.json({ sessionId });
  }

  let request: z.infer<typeof UnattendedSessionRequestSchema>;
  try {
    request = await parseBoundedStrictJson(c.req.raw, UnattendedSessionRequestSchema);
  } catch (error) {
    return bodyError(c, error);
  }
  if (idempotencyKey === undefined) {
    return c.json({ error: "idempotency-key is required for unattended sessions" }, 400);
  }
  if (!enabledForTenant(c.env.UNATTENDED_ENABLED_TENANTS, actor.tenantId)) {
    return c.json({ error: "unattended sessions are disabled" }, 503);
  }

  let canonical;
  try {
    canonical = await canonicalizeUnattendedRequest(request, actor.tenantId, c.env);
  } catch (error) {
    return bodyError(c, error);
  }
  const sessionId = await mintSessionId(actor.tenantId, c.env, idempotencyKey);
  const actorPseudonym = await telemetryPseudonym("actor", actor.actor, c.env);
  const coordinator = getTenantStub(c.env, actor.tenantId);
  const allocation = await coordinator.createLease({
    idempotencyKey,
    fingerprint: canonical.fingerprint,
    sessionId,
    ...(canonical.deviceId === undefined ? {} : { deviceId: canonical.deviceId }),
    allowedOrigins: canonical.allowedOrigins,
    profileStateHash: canonical.profileStateHash,
    actorPseudonym,
  });
  await emitTelemetry(c.env, {
    event: allocation.kind === "replay" ? "session_replay" : "session_create",
    outcome: allocation.kind,
    tenantId: actor.tenantId,
    actor: actor.actor,
    sessionId,
    ...("lease" in allocation ? { deviceId: allocation.lease.deviceId } : {}),
  });

  switch (allocation.kind) {
    case "conflict":
      return c.json({ error: "idempotency key conflicts with its original request" }, 409);
    case "terminal":
      return c.json({ sessionId, mode: "unattended", status: allocation.status }, 410);
    case "device_not_found":
      return c.json({ error: "device not found" }, 404);
    case "no_device":
      return c.json({ error: "no online compatible device" }, 503);
    case "capacity":
      return c.json({ error: "device capacity exhausted" }, 429);
    case "collision":
      return c.json({ error: "origin or profile-state collision" }, 409);
    case "created":
    case "replay": {
      const session = await getSessionStub(c.env, sessionId);
      if (allocation.created) {
        try {
          await session.initializeUnattended(actor.tenantId, allocation.lease);
          const device = c.env.DEVICE.getByName(
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
          return c.json({ error: "device connection unavailable" }, 503);
        }
      }
      const connected = await session.waitForProtocolV2Connection(5_000);
      const location = sessionLocation(c.req.raw, sessionId);
      if (!connected) {
        c.header("Location", location);
        c.header("Retry-After", "2");
        return c.json(
          { sessionId, mode: "unattended", status: allocation.lease.status },
          202,
        );
      }
      return c.json(
        { sessionId, mode: "unattended", status: "connected" as const },
        allocation.created ? 201 : 200,
      );
    }
  }
});

app.get("/v1/devices", async (c) => {
  const authentication = await authenticateCaller(c.req.raw, c.env);
  if (authentication.kind === "unauthorized") return c.json({ error: "unauthorized" }, 401);
  if (authentication.kind === "rate_limited") return c.json({ error: "rate limited" }, 429);
  const actor = authentication.actor;
  return c.json({ devices: await getTenantStub(c.env, actor.tenantId).listDevices() });
});

app.get("/v1/sessions/:sessionId", async (c) => {
  const authentication = await authenticateCaller(c.req.raw, c.env);
  if (authentication.kind === "unauthorized") return c.json({ error: "unauthorized" }, 401);
  if (authentication.kind === "rate_limited") return c.json({ error: "rate limited" }, 429);
  const actor = authentication.actor;
  const sessionId = c.req.param("sessionId");
  if ((await scopeSession(sessionId, actor.tenantId, c.env)) === "not-found") {
    return c.json({ error: "not found" }, 404);
  }
  const status = await (await getSessionStub(c.env, sessionId)).getStatus();
  if (
    "mode" in status &&
    status.mode === "unattended" &&
    (status.status === "closed" || status.status === "expired" || status.status === "lost")
  ) {
    return c.json(status, 410);
  }
  return c.json(status);
});

app.delete("/v1/sessions/:sessionId", async (c) => {
  const authentication = await authenticateCaller(c.req.raw, c.env);
  if (authentication.kind === "unauthorized") return c.json({ error: "unauthorized" }, 401);
  if (authentication.kind === "rate_limited") return c.json({ error: "rate limited" }, 429);
  const actor = authentication.actor;
  const sessionId = c.req.param("sessionId");
  if ((await scopeSession(sessionId, actor.tenantId, c.env)) === "not-found") {
    return c.json({ error: "not found" }, 404);
  }
  const session = await getSessionStub(c.env, sessionId);
  const status = await session.getStatus();
  if (!("mode" in status) || status.mode !== "unattended") {
    const confirmed = await session.requestCloseAttended();
    await emitTelemetry(c.env, {
      event: "session_close",
      outcome: confirmed ? "confirmed" : "pending",
      tenantId: actor.tenantId,
      actor: actor.actor,
      sessionId,
    });
    return confirmed
      ? c.body(null, 204)
      : c.body(null, 202, { Location: sessionLocation(c.req.raw, sessionId) });
  }
  const coordinator = getTenantStub(c.env, actor.tenantId);
  const closing = await coordinator.closeLease(sessionId);
  if (!closing.found) return c.json({ error: "not found" }, 404);
  if (closing.cleanupConfirmed) {
    await emitTelemetry(c.env, {
      event: "session_close",
      outcome: "confirmed",
      tenantId: actor.tenantId,
      actor: actor.actor,
      sessionId,
    });
    return c.body(null, 204);
  }
  if (closing.lease !== undefined) {
    await session.markLifecycle("closing", closing.lease.needsReconciliation);
    const device = c.env.DEVICE.getByName(
      closing.lease.deviceId,
    ) as DurableObjectStub<DeviceAgent>;
    await device.requestClose(closing.lease);
  }
  await emitTelemetry(c.env, {
    event: "session_close",
    outcome: "pending",
    tenantId: actor.tenantId,
    actor: actor.actor,
    sessionId,
    deviceId: closing.lease?.deviceId,
  });
  return c.body(null, 202, { Location: sessionLocation(c.req.raw, sessionId) });
});

app.post("/v1/sessions/:sessionId/commands", async (c) => {
  const authentication = await authenticateCaller(c.req.raw, c.env);
  if (authentication.kind === "unauthorized") return c.json({ error: "unauthorized" }, 401);
  if (authentication.kind === "rate_limited") return c.json({ error: "rate limited" }, 429);
  const actor = authentication.actor;
  const sessionId = c.req.param("sessionId");
  if ((await scopeSession(sessionId, actor.tenantId, c.env)) === "not-found") {
    return c.json({ error: "not found" }, 404);
  }

  let body: z.infer<typeof CommandRequestSchema>;
  try {
    body = await parseBoundedStrictJson(c.req.raw, CommandRequestSchema);
  } catch (error) {
    if (error instanceof RequestBodyError && error.category === "schema") {
      return c.json({ error: "invalid command" }, 400);
    }
    return bodyError(c, error);
  }
  const dryRun = body.dryRun ?? false;
  const stub = await getSessionStub(c.env, sessionId);
  if (await stub.isTerminal()) {
    return c.json({ error: "session is terminal" }, 410);
  }
  const contractV2 = c.req.header("understudy-command-contract") === "2";

  if (contractV2 || (await stub.usesV2CommandProtocol())) {
    const statusUrl = commandLocation(c.req.raw, sessionId, body.command.commandId);
    const actorPseudonym = await telemetryPseudonym("actor", actor.actor, c.env);
    const outcome = await stub.dispatchV2(body.command, dryRun, actorPseudonym, statusUrl);
    await emitTelemetry(c.env, {
      event: "command",
      outcome: outcome.kind,
      tenantId: actor.tenantId,
      actor: actor.actor,
      sessionId,
      commandType: body.command.type,
    });
    return contractV2
      ? v2Outcome(c, outcome, sessionId)
      : compatibilityV2Outcome(c, outcome, sessionId);
  }

  if (
    isWriteCommand(body.command) &&
    !dryRun &&
    enabledForTenant(c.env.SAFE_WRITE_REQUIRED_TENANTS, actor.tenantId)
  ) {
    return c.json({ error: "extension lacks safe-write-v2" }, 426);
  }

  const actorPseudonym = await telemetryPseudonym("actor", actor.actor, c.env);
  const admitted = await getTenantStub(c.env, actor.tenantId).authorizeAttendedCommand({
    sessionId,
    actorPseudonym,
    credentialFill: body.command.type === "fill_secret" && !dryRun,
  });
  if (!admitted) return c.json({ code: "command_quota_exceeded" }, 429);

  const outcome: DispatchOutcome =
    body.command.type === "fill_secret"
      ? await stub.fillSecret(body.command, dryRun)
      : await stub.dispatch(body.command, dryRun);
  await emitTelemetry(c.env, {
    event: "command",
    outcome: outcome.ok ? "legacy_terminal" : `legacy_${outcome.reason}`,
    tenantId: actor.tenantId,
    actor: actor.actor,
    sessionId,
    commandType: body.command.type,
  });
  if (outcome.ok) return c.json(outcome.event);
  switch (outcome.reason) {
    case "not_connected":
      return c.json({ error: "extension not connected" }, 503);
    case "timed_out":
      return c.json({ error: "command timed out" }, 504);
    case "resynced":
      return c.json({ error: "session resynced mid-command" }, 503);
    case "duplicate_in_flight":
      return c.json({ error: "command already in flight" }, 409);
    case "session_busy":
      return c.json({ code: "session_busy" }, 429);
    case "terminal_session":
      return c.json({ error: "session is terminal" }, 410);
    case "id_conflict":
      return c.json({ code: "command_id_conflict" }, 409);
  }
});

app.get("/v1/sessions/:sessionId/commands/:commandId", async (c) => {
  const authentication = await authenticateCaller(c.req.raw, c.env);
  if (authentication.kind === "unauthorized") return c.json({ error: "unauthorized" }, 401);
  if (authentication.kind === "rate_limited") return c.json({ error: "rate limited" }, 429);
  const actor = authentication.actor;
  const sessionId = c.req.param("sessionId");
  if ((await scopeSession(sessionId, actor.tenantId, c.env)) === "not-found") {
    return c.json({ error: "not found" }, 404);
  }
  const commandId = c.req.param("commandId");
  if (commandId.length < 1 || commandId.length > 128) {
    return c.json({ error: "invalid command id" }, 400);
  }
  const status = await (await getSessionStub(c.env, sessionId)).getCommandStatus(
    commandId,
  );
  if (status === null) return c.json({ error: "not found" }, 404);
  return c.json(status);
});

app.post("/v1/device/connect-ticket", async (c) => {
  const authentication = await authenticateDeviceCaller(c.req.raw, c.env);
  if (authentication.kind === "unauthorized") return c.json({ error: "unauthorized" }, 401);
  if (authentication.kind === "rate_limited") return c.json({ error: "rate limited" }, 429);
  const device = authentication.device;
  let body: z.infer<typeof DeviceTicketRequestSchema>;
  try {
    body = await parseBoundedStrictJson(c.req.raw, DeviceTicketRequestSchema, 4 * 1024);
  } catch (error) {
    return bodyError(c, error);
  }
  const coordinator = getTenantStub(c.env, device.tenantId);
  if (!(await coordinator.consumeDeviceTicketQuota(device.deviceId))) {
    return c.json({ error: "device ticket quota exceeded" }, 429);
  }
  const agent = c.env.DEVICE.getByName(device.deviceId) as DurableObjectStub<DeviceAgent>;
  if (!(await agent.authorizeCredential(device))) {
    return c.json({ error: "device not found" }, 404);
  }
  const ticket = await mintWsTicket(
    {
      aud: "device-control",
      tenantId: device.tenantId,
      deviceId: device.deviceId,
      credentialVersion: device.credentialVersion,
      leaseEpoch: 0,
      browserEpoch: body.browserEpoch,
      agentName: device.deviceId,
    },
    c.env,
  );
  return c.json({
    ticket,
    expiresIn: 60,
    websocketPath: `/agents/device/${encodeURIComponent(device.deviceId)}`,
  });
});

type CallerAuthentication =
  | { kind: "ok"; actor: Actor }
  | { kind: "unauthorized" }
  | { kind: "rate_limited" };

async function authenticateCaller(
  request: Request,
  env: Env,
): Promise<CallerAuthentication> {
  const actor = await authenticate(request, env);
  if (actor === null) {
    await emitTelemetry(env, { event: "authentication", outcome: "unauthorized" });
    return { kind: "unauthorized" };
  }
  if (!(await approximateRateAllowed(request, env))) {
    await emitTelemetry(env, {
      event: "authentication",
      outcome: "rate_limited",
      tenantId: actor.tenantId,
      actor: actor.actor,
    });
    return { kind: "rate_limited" };
  }
  await emitTelemetry(env, {
    event: "authentication",
    outcome: "ok",
    tenantId: actor.tenantId,
    actor: actor.actor,
  });
  return { kind: "ok", actor };
}

type DeviceAuthentication =
  | { kind: "ok"; device: DeviceIdentity }
  | { kind: "unauthorized" }
  | { kind: "rate_limited" };

async function authenticateDeviceCaller(
  request: Request,
  env: Env,
): Promise<DeviceAuthentication> {
  const device = await authenticateDevice(request, env);
  if (device === null) {
    await emitTelemetry(env, { event: "authentication", outcome: "device_unauthorized" });
    return { kind: "unauthorized" };
  }
  if (!(await approximateRateAllowed(request, env))) {
    await emitTelemetry(env, {
      event: "authentication",
      outcome: "device_rate_limited",
      tenantId: device.tenantId,
      deviceId: device.deviceId,
    });
    return { kind: "rate_limited" };
  }
  await emitTelemetry(env, {
    event: "authentication",
    outcome: "device_ok",
    tenantId: device.tenantId,
    deviceId: device.deviceId,
  });
  return { kind: "ok", device };
}

async function approximateRateAllowed(request: Request, env: Env): Promise<boolean> {
  if (env.RATE_LIMITER === undefined) return true;
  const credential = request.headers.get("authorization") ?? "";
  const key = await telemetryPseudonym("rate-limit-credential", credential, env);
  return (await env.RATE_LIMITER.limit({ key })).success;
}

function v2Outcome(
  c: Parameters<typeof bodyError>[0],
  outcome: V2DispatchOutcome,
  sessionId: string,
) {
  switch (outcome.kind) {
    case "terminal":
      return c.json(outcome.event);
    case "pending":
      c.header("Location", outcome.pending.statusUrl);
      c.header("Retry-After", "2");
      return c.json(outcome.pending, 202);
    case "not_started":
      return c.json(
        {
          code: "command_not_started",
          commandId: outcome.commandId,
          safeToRetry: true,
        },
        504,
      );
    case "timed_out":
      return c.json(
        {
          code: "command_timed_out",
          commandId: outcome.commandId,
          safeToRetry: true,
        },
        504,
      );
    case "unknown":
      return c.json(
        {
          code: "command_outcome_unknown",
          commandId: outcome.commandId,
          safeToRetry: false,
        },
        409,
      );
    case "id_conflict":
      return c.json({ code: "command_id_conflict", commandId: outcome.commandId }, 409);
    case "busy":
      return c.json({ code: "session_busy", commandId: outcome.commandId }, 429);
    case "not_connected":
      return c.json({ error: "session connection unavailable", sessionId }, 503);
    case "unsupported":
      return c.json({ error: "extension lacks safe-write-v2" }, 426);
    case "terminal_session":
      return c.json({ error: "session is terminal" }, 410);
  }
}

function compatibilityV2Outcome(
  c: Parameters<typeof bodyError>[0],
  outcome: V2DispatchOutcome,
  sessionId: string,
) {
  if (outcome.kind === "pending") {
    return c.json(
      {
        code: "command_pending_connector_upgrade",
        commandId: outcome.pending.commandId,
        safeToRetry: false,
      },
      503,
    );
  }
  return v2Outcome(c, outcome, sessionId);
}

async function gateAgentRequest(
  req: Request,
  lobby: { name: string },
  env: Env,
): Promise<Response | undefined> {
  const url = new URL(req.url);
  const path = url.pathname.split("/").filter(Boolean);
  const agentType = path.at(-2);
  const ticket = url.searchParams.get("ticket");
  if (agentType === "device") {
    if (
      ticket === null ||
      (await verifyWsTicket(
        ticket,
        { aud: "device-control", agentName: lobby.name },
        env,
      )) === null
    ) {
      return new Response("invalid device ticket", { status: 401 });
    }
    return undefined;
  }
  if (ticket !== null) {
    const claims = await verifyWsTicket(
      ticket,
      { aud: "session", agentName: lobby.name },
      env,
    );
    if (claims === null || claims.sessionId !== lobby.name) {
      return new Response("invalid session ticket", { status: 401 });
    }
    if ((await scopeSession(lobby.name, claims.tenantId, env)) !== "ok") {
      return new Response("not found", { status: 404 });
    }
    return undefined;
  }
  const token = url.searchParams.get("token") ?? "";
  const verified = await verifyExtensionToken(token, env);
  if (verified === null) return new Response("invalid extension token", { status: 401 });
  if ((await scopeSession(lobby.name, verified.tenantId, env)) !== "ok") {
    return new Response("not found", { status: 404 });
  }
  return undefined;
}

async function gateAgentPathBeforeResolution(
  req: Request,
  env: Env,
): Promise<Response | null | undefined> {
  const url = new URL(req.url);
  const path = url.pathname.split("/").filter(Boolean);
  if (path.length !== 3 || path[0] !== "agents") return undefined;
  const agentType = path[1];
  let agentName: string;
  try {
    agentName = decodeURIComponent(path[2] ?? "");
  } catch {
    return new Response("invalid agent path", { status: 400 });
  }
  if (agentName.length < 1 || agentName.length > 128) {
    return new Response("invalid agent path", { status: 400 });
  }

  const ticket = url.searchParams.get("ticket");
  if (agentType === "device") {
    const claims =
      ticket === null
        ? null
        : await verifyWsTicket(
            ticket,
            { aud: "device-control", agentName },
            env,
          );
    return claims?.deviceId === agentName
      ? null
      : new Response("invalid device ticket", { status: 401 });
  }
  if (agentType !== "session") return undefined;
  if (ticket !== null) {
    const claims = await verifyWsTicket(
      ticket,
      { aud: "session", agentName },
      env,
    );
    if (claims === null || claims.sessionId !== agentName) {
      return new Response("invalid session ticket", { status: 401 });
    }
    return (await scopeSession(agentName, claims.tenantId, env)) === "ok"
      ? null
      : new Response("not found", { status: 404 });
  }
  const verified = await verifyExtensionToken(url.searchParams.get("token") ?? "", env);
  if (verified === null) return new Response("invalid extension token", { status: 401 });
  return (await scopeSession(agentName, verified.tenantId, env)) === "ok"
    ? null
    : new Response("not found", { status: 404 });
}

function bodyError(c: HonoContext, error: unknown) {
  if (error instanceof RequestBodyError) {
    return c.json({ error: error.message }, error.status);
  }
  return c.json({ error: "invalid body" }, 400);
}

type HonoContext = Context<{ Bindings: Env }>;

function enabledForTenant(raw: string, tenantId: string): boolean {
  try {
    const parsed = JSON.parse(raw || "[]") as unknown;
    return Array.isArray(parsed) && (parsed.includes("*") || parsed.includes(tenantId));
  } catch {
    return false;
  }
}

function sessionLocation(request: Request, sessionId: string): string {
  return new URL(`/v1/sessions/${encodeURIComponent(sessionId)}`, request.url).toString();
}

function commandLocation(request: Request, sessionId: string, commandId: string): string {
  return new URL(
    `/v1/sessions/${encodeURIComponent(sessionId)}/commands/${encodeURIComponent(commandId)}`,
    request.url,
  ).toString();
}

app.onError((_error, c) => {
  console.error("unhandled route error");
  return c.json({ error: "internal error" }, 500);
});

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (
      request.headers.get("content-length") !== null &&
      Number(request.headers.get("content-length")) > SESSION_RESULT_FRAME_MAX_BYTES
    ) {
      return Response.json({ error: "request body too large" }, { status: 413 });
    }
    const agentGate = await gateAgentPathBeforeResolution(request, env);
    if (agentGate instanceof Response) return agentGate;
    const agentResponse = await routeAgentRequest(request, env, {
      onBeforeConnect: (req, lobby) => gateAgentRequest(req, lobby, env),
      onBeforeRequest: (req, lobby) => gateAgentRequest(req, lobby, env),
    });
    if (agentResponse) return agentResponse;
    return app.fetch(request, env, ctx);
  },
};
