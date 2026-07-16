/**
 * Worker entry: the consumer-facing command API (M-005).
 *
 * Two routers share the fetch handler: routeAgentRequest owns the
 * `/agents/session/:sessionId` WebSocket path the M2 extension connects to
 * (the route segment is `session`, kebab-cased from the SESSION binding
 * name in wrangler.jsonc - not from the SessionAgent class name); the Hono
 * app below owns everything else, including the /v1 command API consumers
 * (metamind/smart-compliance) drive. SessionAgent is re-exported because
 * wrangler resolves durable_objects.bindings[].class_name against this
 * module's exports.
 */
import { Hono } from "hono";
import { getAgentByName, routeAgentRequest } from "agents";
import { safeParseCommand } from "@understudy/protocol";
import { authenticate, mintSessionId, scopeSession, verifyExtensionToken } from "./auth";
import type { DispatchOutcome, Env } from "./types";
import type { SessionAgent } from "./session";

export { SessionAgent } from "./session";

function getSessionStub(env: Env, sessionId: string): Promise<DurableObjectStub<SessionAgent>> {
  return getAgentByName(env.SESSION, sessionId);
}

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ ok: true }));

app.post("/v1/sessions", async (c) => {
  const actor = await authenticate(c.req.raw, c.env);
  if (!actor) return c.json({ error: "unauthorized" }, 401);

  const sessionId = await mintSessionId(actor.tenantId, c.env);
  return c.json({ sessionId });
});

app.get("/v1/sessions/:sessionId", async (c) => {
  const actor = await authenticate(c.req.raw, c.env);
  if (!actor) return c.json({ error: "unauthorized" }, 401);

  const sessionId = c.req.param("sessionId");
  const scope = await scopeSession(sessionId, actor.tenantId, c.env);
  if (scope === "not-found") return c.json({ error: "not found" }, 404);

  const stub = await getSessionStub(c.env, sessionId);
  const status = await stub.getStatus();
  return c.json(status);
});

// Auth order is load-bearing: authenticate (401) -> scopeSession (404) ->
// parse (400), so an unauthenticated or cross-tenant request never reaches
// command parsing/dispatch, and a cross-tenant sessionId is indistinguishable
// from one that never existed (DL-008).
app.post("/v1/sessions/:sessionId/commands", async (c) => {
  const actor = await authenticate(c.req.raw, c.env);
  if (!actor) return c.json({ error: "unauthorized" }, 401);

  const sessionId = c.req.param("sessionId");
  const scope = await scopeSession(sessionId, actor.tenantId, c.env);
  if (scope === "not-found") return c.json({ error: "not found" }, 404);

  // Unparseable JSON is the client's fault: 400, not a rethrow into the
  // uniform 500 (which would dress a client error as a server error).
  let body: { command?: unknown; dryRun?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid body" }, 400);
  }
  const parsed = safeParseCommand(body?.command);
  if (!parsed.success) return c.json({ error: "invalid command" }, 400);

  // fill_secret is routed to the DO's dedicated fillSecret RPC rather than a
  // generic dispatch, so vault resolution stays behind that one method's
  // no-plaintext-leak contract instead of a raw type{text} command ever
  // carrying a secret through this route (DL-004).
  const dryRun = body?.dryRun === true;
  const stub = await getSessionStub(c.env, sessionId);
  const outcome: DispatchOutcome =
    parsed.data.type === "fill_secret"
      ? await stub.fillSecret(parsed.data, dryRun)
      : await stub.dispatch(parsed.data, dryRun);
  if (outcome.ok) return c.json(outcome.event);

  // Expected delivery failures arrive as typed outcomes, never as RPC
  // rejections (types.ts::DispatchOutcome). All of these are deliberately
  // non-2xx rather than a 200 ok:false Event, which a consumer's
  // idempotency store would cache and replay even after the extension
  // reconnects. Only a genuine bug still throws (-> the uniform 500).
  //
  // The honest reason is logged for observability; by DL-004 construction it
  // carries only {commandId, type}-level detail, never a command payload.
  console.warn("command dispatch failed", outcome.message);
  switch (outcome.reason) {
    case "not_connected":
      // Retryable infrastructure state: no live, authorized extension socket.
      return c.json({ error: "extension not connected" }, 503);
    case "timed_out":
      return c.json({ error: "command timed out" }, 504);
    case "resynced":
      // The extension reconnected mid-command, abandoning whatever it had in
      // flight. Retryable, like not_connected - the session itself is healthy.
      return c.json({ error: "session resynced mid-command" }, 503);
    case "duplicate_in_flight":
      return c.json({ error: "command already in flight" }, 409);
    default:
      // A new DispatchOutcome.reason without a route mapping fails the build
      // here (assertNever) instead of silently returning undefined.
      return assertNever(outcome.reason);
  }
});

// Compile-time exhaustiveness backstop for the DispatchOutcome.reason switch.
function assertNever(value: never): never {
  throw new Error(`unhandled dispatch outcome reason: ${String(value)}`);
}

// Anything a route throws (or rethrows above) becomes a uniform JSON 500
// instead of workerd's opaque non-JSON error page. Command payloads never
// enter error messages by construction (DL-004), so logging the message
// leaks nothing; the response body stays generic regardless.
app.onError((err, c) => {
  console.error("unhandled route error", err.message);
  return c.json({ error: "internal error" }, 500);
});

/**
 * Worker-level gate on every request routeAgentRequest matches, BEFORE the
 * Durable Object ever accepts the socket (or serves an SDK HTTP surface).
 * Defense-in-depth with SessionAgent.onConnect: the in-DO gate stays (it
 * covers any path that reaches the DO without this router), but an
 * unauthorized upgrade is now refused at the edge instead of being
 * accepted-but-inert. Failure statuses mirror the /v1 discipline: bad token
 * 401; a sessionId whose tenant disagrees with the token collapses to 404,
 * never 403 (DL-008: no existence oracle). `lobby.name` is the raw
 * `:sessionId` path segment routeAgentRequest extracted.
 */
async function gateAgentRequest(
  req: Request,
  lobby: { name: string },
  env: Env,
): Promise<Response | undefined> {
  const token = new URL(req.url).searchParams.get("token") ?? "";
  const verified = await verifyExtensionToken(token, env);
  if (verified === null) return new Response("invalid extension token", { status: 401 });
  const scope = await scopeSession(lobby.name, verified.tenantId, env);
  if (scope !== "ok") return new Response("not found", { status: 404 });
  return undefined;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const agentResponse = await routeAgentRequest(request, env, {
      onBeforeConnect: (req, lobby) => gateAgentRequest(req, lobby, env),
      onBeforeRequest: (req, lobby) => gateAgentRequest(req, lobby, env),
    });
    if (agentResponse) return agentResponse;
    return app.fetch(request, env, ctx);
  },
};
