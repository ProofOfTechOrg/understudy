import { Hono, type Context } from "hono";
import { routeAgentRequest } from "agents";
import { z } from "zod";
import {
  CommandRequestSchema,
  SESSION_RESULT_FRAME_MAX_BYTES,
  UnattendedSessionRequestSchema,
} from "@understudy/protocol";
import {
  authenticate,
  authenticatedRateAllowed,
  authenticateDeviceComposite,
  mintWsTicket,
  scopeSession,
  SESSION_IDEMPOTENCY_KEY_PATTERN,
  verifyExtensionToken,
  verifyWsTicket,
} from "./auth";
import {
  createAttendedSession,
  createSession,
  deleteSession,
  dispatchCommand,
  getSessionStatus,
  getTenantStub,
  listDevices,
  pollCommand,
} from "./api/sessions";
import type { DeviceAgent } from "./device";
import type { Env, V2DispatchOutcome } from "./types";
import { parseBoundedStrictJson, readBoundedBodyText, parseStrictJsonText, RequestBodyError } from "./validation";
import { emitTelemetry } from "./telemetry";
import type { Actor, DeviceIdentity } from "./auth";

export { AccountDirectory } from "./account-directory";
export { DeviceAgent } from "./device";
export { SessionAgent } from "./session";
export { TenantDeviceCoordinator } from "./tenant-coordinator";

const app = new Hono<{ Bindings: Env }>();
const DeviceTicketRequestSchema = z
  .object({ browserEpoch: z.string().min(1).max(128) })
  .strict();

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

  // Attended creation is defined as "no body". `body === null` alone only holds
  // for a Request built in-process — over the wire every client, a Worker
  // subrequest to a public hostname included, sends `Content-Length: 0`, which
  // arrives as an empty but non-null stream. Reading the body once and treating
  // empty as absent is what makes the attended path reachable by any real
  // caller; discriminating on `body === null` made it reachable only from this
  // Worker's own in-process tests.
  let rawBody: string;
  try {
    rawBody = await readBoundedBodyText(c.req.raw);
  } catch (error) {
    return bodyError(c, error);
  }

  if (rawBody === "") {
    const result = await createAttendedSession(c.env, actor, idempotencyKey);
    return result.kind === "quota_exceeded"
      ? c.json({ error: "session creation quota exceeded" }, 429)
      : c.json({ sessionId: result.sessionId });
  }

  let request: z.infer<typeof UnattendedSessionRequestSchema>;
  try {
    request = parseStrictJsonText(rawBody, UnattendedSessionRequestSchema);
  } catch (error) {
    return bodyError(c, error);
  }
  if (idempotencyKey === undefined) {
    return c.json({ error: "idempotency-key is required for unattended sessions" }, 400);
  }

  const result = await createSession(c.env, actor, {
    request,
    idempotencyKey,
    requestUrl: c.req.url,
  });
  switch (result.kind) {
    case "bad_request":
      return c.json({ error: result.message }, result.status);
    case "disabled":
      return c.json({ error: "unattended sessions are disabled" }, 503);
    case "idempotency_conflict":
      return c.json({ error: "idempotency key conflicts with its original request" }, 409);
    case "terminal":
      return c.json({ sessionId: result.sessionId, mode: "unattended", status: result.status }, 410);
    case "device_not_found":
      return c.json({ error: "device not found" }, 404);
    case "no_device":
      return c.json({ error: "no online compatible device" }, 503);
    case "capacity":
      return c.json({ error: "device capacity exhausted" }, 429);
    case "collision":
      return c.json({ error: "origin or profile-state collision" }, 409);
    case "provision_failed":
      return c.json({ error: "device connection unavailable" }, 503);
    case "pending":
      c.header("Location", result.location);
      c.header("Retry-After", "2");
      return c.json(
        { sessionId: result.sessionId, mode: "unattended", status: result.status },
        202,
      );
    case "connected":
      return c.json(
        { sessionId: result.sessionId, mode: "unattended", status: "connected" as const },
        result.created ? 201 : 200,
      );
  }
});

app.get("/v1/devices", async (c) => {
  const authentication = await authenticateCaller(c.req.raw, c.env);
  if (authentication.kind === "unauthorized") return c.json({ error: "unauthorized" }, 401);
  if (authentication.kind === "rate_limited") return c.json({ error: "rate limited" }, 429);
  const actor = authentication.actor;
  return c.json({ devices: await listDevices(c.env, actor) });
});

app.get("/v1/sessions/:sessionId", async (c) => {
  const authentication = await authenticateCaller(c.req.raw, c.env);
  if (authentication.kind === "unauthorized") return c.json({ error: "unauthorized" }, 401);
  if (authentication.kind === "rate_limited") return c.json({ error: "rate limited" }, 429);
  const actor = authentication.actor;
  const result = await getSessionStatus(c.env, actor, c.req.param("sessionId"));
  if (result.kind === "not_found") return c.json({ error: "not found" }, 404);
  return result.terminal ? c.json(result.status, 410) : c.json(result.status);
});

app.delete("/v1/sessions/:sessionId", async (c) => {
  const authentication = await authenticateCaller(c.req.raw, c.env);
  if (authentication.kind === "unauthorized") return c.json({ error: "unauthorized" }, 401);
  if (authentication.kind === "rate_limited") return c.json({ error: "rate limited" }, 429);
  const actor = authentication.actor;
  const result = await deleteSession(c.env, actor, c.req.param("sessionId"), c.req.url);
  switch (result.kind) {
    case "not_found":
      return c.json({ error: "not found" }, 404);
    case "closed":
      return c.body(null, 204);
    case "closing":
      return c.body(null, 202, { Location: result.location });
  }
});

app.post("/v1/sessions/:sessionId/commands", async (c) => {
  const authentication = await authenticateCaller(c.req.raw, c.env);
  if (authentication.kind === "unauthorized") return c.json({ error: "unauthorized" }, 401);
  if (authentication.kind === "rate_limited") return c.json({ error: "rate limited" }, 429);
  const actor = authentication.actor;
  const sessionId = c.req.param("sessionId");
  // Early ownership check so a cross-tenant request 404s before its body is
  // parsed, exactly as before the service extraction; dispatchCommand
  // re-derives the same check for non-HTTP callers.
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
  const contractV2 = c.req.header("understudy-command-contract") === "2";
  const result = await dispatchCommand(c.env, actor, sessionId, {
    command: body.command,
    dryRun: body.dryRun ?? false,
    contractV2,
    requestUrl: c.req.url,
  });
  switch (result.kind) {
    case "not_found":
      return c.json({ error: "not found" }, 404);
    case "terminal_session":
      return c.json({ error: "session is terminal" }, 410);
    case "v2":
      return contractV2
        ? v2Outcome(c, result.outcome, sessionId)
        : compatibilityV2Outcome(c, result.outcome, sessionId);
    case "legacy_unsupported_write":
      return c.json({ error: "extension lacks safe-write-v2" }, 426);
    case "legacy_quota_exceeded":
      return c.json({ code: "command_quota_exceeded" }, 429);
    case "legacy": {
      const outcome = result.outcome;
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
    }
  }
});

app.get("/v1/sessions/:sessionId/commands/:commandId", async (c) => {
  const authentication = await authenticateCaller(c.req.raw, c.env);
  if (authentication.kind === "unauthorized") return c.json({ error: "unauthorized" }, 401);
  if (authentication.kind === "rate_limited") return c.json({ error: "rate limited" }, 429);
  const actor = authentication.actor;
  const result = await pollCommand(
    c.env,
    actor,
    c.req.param("sessionId"),
    c.req.param("commandId"),
  );
  switch (result.kind) {
    case "not_found":
      return c.json({ error: "not found" }, 404);
    case "invalid_command_id":
      return c.json({ error: "invalid command id" }, 400);
    case "ok":
      return c.json(result.record);
  }
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
  if (
    !(await authenticatedRateAllowed(
      { kind: "caller", tenantId: actor.tenantId, actor: actor.actor },
      env,
    ))
  ) {
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
  const device = await authenticateDeviceComposite(request, env);
  if (device === null) {
    await emitTelemetry(env, { event: "authentication", outcome: "device_unauthorized" });
    return { kind: "unauthorized" };
  }
  if (
    !(await authenticatedRateAllowed(
      { kind: "device", tenantId: device.tenantId, deviceId: device.deviceId },
      env,
    ))
  ) {
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
