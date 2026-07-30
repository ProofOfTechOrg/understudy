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
  taggedHmacHex,
  unauthenticatedRateAllowed,
  verifyExtensionToken,
  verifyWsTicket,
} from "./auth";
import { getDirectory, normalizePairingCode } from "./account-directory";
import { CANONICAL_HOST, CANONICAL_ORIGIN } from "./canonical";
import { dashboardApp } from "./dashboard/app";
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
import { oauthProvider } from "./oauth";
import { tryStaticMcpAuth } from "./mcp/static-auth";
import type { Env, V2DispatchOutcome } from "./types";
import {
  isLoopback,
  parseBoundedStrictJson,
  parseStrictJsonText,
  readBoundedBodyText,
  RequestBodyError,
} from "./validation";
import { emitTelemetry } from "./telemetry";
import type { Actor, DeviceIdentity } from "./auth";

export { AccountAgent } from "./account-agent";
export { AccountDirectory } from "./account-directory";
export { DeviceAgent } from "./device";
export { SessionAgent } from "./session";
export { TenantDeviceCoordinator } from "./tenant-coordinator";
export { UnderstudyMcp } from "./mcp/mcp-agent";

const app = new Hono<{ Bindings: Env }>();
const DeviceTicketRequestSchema = z
  .object({ browserEpoch: z.string().min(1).max(128) })
  .strict();
const PairingClaimSchema = z.object({ code: z.string().min(1).max(64) }).strict();

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

/**
 * Extension pairing: the one-time code IS the credential, so this route is
 * unauthenticated by design. The device identity and udt_ credential are
 * minted at redeem time inside the directory's consume-once transaction;
 * every failure mode is the same 404 (no code-state oracle). Deliberately on
 * this Hono app, NOT delegated to the OAuth provider — it is device-facing
 * /v1 surface, a sibling of /v1/device/connect-ticket.
 */
app.post("/v1/pairing/claim", async (c) => {
  if (!(await unauthenticatedRateAllowed(c.req.raw, c.env, "pairing-claim"))) {
    return c.json({ error: "rate_limited" }, 429);
  }
  let body: z.infer<typeof PairingClaimSchema>;
  try {
    body = await parseBoundedStrictJson(c.req.raw, PairingClaimSchema, 4 * 1024);
  } catch (error) {
    return bodyError(c, error);
  }
  const normalized = normalizePairingCode(body.code);
  if (!/^[0-9A-Z]{8}$/.test(normalized)) {
    return c.json({ error: "invalid_or_expired_code" }, 404);
  }
  const claimed = await getDirectory(c.env).claimPairingCode(
    await taggedHmacHex(c.env, "pair-v1", normalized),
  );
  if (claimed.kind !== "ok") {
    return c.json({ error: "invalid_or_expired_code" }, 404);
  }
  await emitTelemetry(c.env, {
    event: "device_connect",
    outcome: "paired",
    tenantId: claimed.tenantId,
    deviceId: claimed.deviceId,
  });
  // This body satisfies the extension's normalizeProfileConfig by
  // construction: origin-only https serviceOrigin, uuid deviceId, bounded
  // credential, 1..32 canonical origins.
  return c.json({
    serviceOrigin: new URL(c.req.url).origin,
    deviceId: claimed.deviceId,
    deviceCredential: claimed.deviceCredential,
    originPolicy: claimed.originPolicy,
    unattendedEnabled: true,
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

/**
 * The only agent types the /agents/* surface may resolve. routeAgentRequest
 * auto-exposes EVERY DO binding at /agents/<kebab-binding>/<name>, so each
 * new binding (account directory, MCP transport, account agent) would
 * otherwise become a public path. Deny-by-default closes the class, not the
 * instance: anything outside this set 404s before DO resolution.
 */
const PUBLIC_AGENT_TYPES = new Set(["session", "device"]);

async function gateAgentRequest(
  req: Request,
  lobby: { name: string },
  env: Env,
): Promise<Response | undefined> {
  const url = new URL(req.url);
  const path = url.pathname.split("/").filter(Boolean);
  // Mirrors gateAgentPathBeforeResolution's allowlist (defense in depth —
  // this hook only runs for requests that already resolved an agent).
  if (path.length !== 3 || path[0] !== "agents" || !PUBLIC_AGENT_TYPES.has(path[1] ?? "")) {
    return new Response("not found", { status: 404 });
  }
  const agentType = path[1];
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
  if (path[0] !== "agents") return undefined;
  // Deny-by-default, before DO resolution: only 3-segment session/device
  // paths exist. This also closes the previously-reachable
  // /agents/tenant-control/* and the 4+-segment shapes that used to slip
  // into gateAgentRequest's at(-2) heuristic.
  if (path.length !== 3 || !PUBLIC_AGENT_TYPES.has(path[1] ?? "")) {
    return new Response("not found", { status: 404 });
  }
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

/** The dashboard/account plane — served directly, NOT through the provider. */
function isDashboardPath(pathname: string): boolean {
  return pathname === "/dashboard" || pathname.startsWith("/dashboard/");
}

/**
 * Paths handled by the OAuthProvider (or delegated by it): the MCP endpoint,
 * the OAuth token/register/authorize surface, and the RFC 8414/9728
 * well-knowns. Kept separate from the dashboard plane so a provider or
 * OAUTH_KV fault cannot reach sign-in, pairing, or token/device revocation.
 */
function isOAuthProviderPath(pathname: string): boolean {
  return (
    pathname === "/mcp" ||
    pathname.startsWith("/mcp/") ||
    pathname.startsWith("/oauth/") ||
    pathname.startsWith("/.well-known/oauth-authorization-server") ||
    pathname.startsWith("/.well-known/oauth-protected-resource")
  );
}

/**
 * The complete new surface. None of these prefixes existed before the MCP
 * work, so for every previously-valid request this predicate is a failed
 * string comparison — the non-regression argument for keeping the existing
 * fetch as the default export (D1).
 */
function isNewSurfacePath(pathname: string): boolean {
  return isDashboardPath(pathname) || isOAuthProviderPath(pathname);
}

/** Scrubbed 500 for the new surface — the /v1 app has its own app.onError. */
function scrubbedError(pathname: string): Response {
  console.error("unhandled error on the authed surface");
  return isOAuthProviderPath(pathname) && !pathname.startsWith("/oauth/authorize")
    ? Response.json({ error: "internal_error" }, { status: 500 })
    : new Response("internal error", {
        status: 500,
        headers: { "content-type": "text/plain", "cache-control": "no-store" },
      });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (
      request.headers.get("content-length") !== null &&
      Number(request.headers.get("content-length")) > SESSION_RESULT_FRAME_MAX_BYTES
    ) {
      return Response.json({ error: "request body too large" }, { status: 413 });
    }
    const url = new URL(request.url);
    if (isNewSurfacePath(url.pathname)) {
      // Single OAuth issuer / one cookie host: the new surface exists only on
      // the custom domain. workers.dev stays live for existing consumers but
      // must not mint tokens or set __Host- cookies. Loopback is exempt so
      // wrangler dev + the MCP inspector work; on the real edge url.host is
      // the routed hostname, not a client-supplied Host header, so this is
      // not a bypass.
      if (url.host !== CANONICAL_HOST && !isLoopback(url.hostname)) {
        return Response.redirect(`${CANONICAL_ORIGIN}${url.pathname}${url.search}`, 308);
      }
      // No error boundary reaches this surface otherwise: the provider (0.8.2)
      // has no top-level catch and dashboard page loads can throw (e.g. a
      // malformed VAULT_UPLOAD_PRIVATE_KEY), so one fault would return an
      // unscrubbed 500 for the whole account plane.
      try {
        if (isDashboardPath(url.pathname)) {
          return await dashboardApp.fetch(request, env, ctx);
        }
        if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
          // usk_ bearers take the fast path; null means "not a usk_ bearer",
          // so a MISSING token still reaches the provider for its
          // discovery-grade 401.
          const staticResult = await tryStaticMcpAuth(request, env, ctx);
          if (staticResult !== null) return staticResult;
        }
        // Open DCR (RFC 7591) is unauthenticated by spec; per-IP limiting is
        // the abuse backstop. Registration grants nothing — consent is always
        // human-in-the-loop on /oauth/authorize.
        if (
          url.pathname === "/oauth/register" &&
          !(await unauthenticatedRateAllowed(request, env, "dcr"))
        ) {
          return Response.json({ error: "rate_limited" }, { status: 429 });
        }
        return await oauthProvider.fetch(request, env, ctx);
      } catch {
        return scrubbedError(url.pathname);
      }
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
