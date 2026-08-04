/**
 * Reference breakwater connectors for the understudy browser-execution
 * service (Topology 1: understudy is a model-free substrate; the Mastra
 * agent, approvals, RBAC, and audit live in the CONSUMER importing this).
 *
 * Two connectors, one governance class each:
 *   observe          - read (snapshot / get_tabs / wait). No approval.
 *   act              - write (click / type / navigate / key / scroll /
 *                      switch_tab). Fails closed unless the request carries a
 *                      flowsafe-minted grant in
 *                      requestContext['breakwater.approvedConnectors'].
 *
 * Every execute() reaches understudy only through breakwater's egress-guarded
 * runtime.fetch, pinned (redirect hops included) to the UNDERSTUDY_URL
 * hostname. Mirrors metamind's shipped packages/worker/src/intake/connectors.ts.
 */

import { RequestContext } from "@mastra/core/request-context";
import type { ToolExecutionContext } from "@mastra/core/tools";
import {
  type ConnectorPolicies,
  type ConnectorRuntime,
  createConnector,
  D1IdempotencyStore,
  D1RateLimitStore,
  DRY_RUN_CONTEXT_KEY,
  IDEMPOTENCY_KEY_CONTEXT_KEY,
  type IdempotencyStore,
  type RateLimitStore,
} from "@proofoftech/breakwater/connector-sdk";
import {
  A11yNodeSchema,
  type Command,
  CommandStatusResponseSchema,
  type DialogRecord,
  DialogRecordSchema,
  type Event,
  parseCommand,
  parseEvent,
  PendingCommandResponseSchema,
  type PendingCommandResponse,
  type CommandStatusResponse,
  SnapshotModeSchema,
  SnapshotTargetSchema,
  TabInfoSchema,
} from "@understudy/protocol";
import { z } from "zod";

// -- Env + durable stores ----------------------------------------------------

export interface BrowserConnectorEnv {
  /** Base URL of the understudy service; its hostname is the egress target. */
  UNDERSTUDY_URL: string;
  /**
   * Caller bearer token for the service's /v1 API. Maps to a tenant in the
   * service's CALLER_TOKENS; the service refuses cross-tenant sessionIds
   * with 404 (no existence oracle).
   */
  UNDERSTUDY_TOKEN: string;
}

export interface ConnectorStores {
  idempotencyStore: IdempotencyStore;
  rateLimitStore: RateLimitStore;
}

// Structural D1 seam borrowed from breakwater's own store constructors, so
// this package needs no Cloudflare type dependency (a real D1Database
// satisfies both).
type ConnectorDatabase = ConstructorParameters<typeof D1IdempotencyStore>[0] &
  ConstructorParameters<typeof D1RateLimitStore>[0];

/**
 * D1-backed stores. breakwater's in-memory defaults are per-isolate - under
 * flowsafe's DO-per-run routing that means per-RUN, so a Worker restart
 * mid-step would re-dispatch a browser write and double-submit a form. D1
 * makes replay protection and rate budgets durable across isolates.
 */
export function durableStores(db: ConnectorDatabase): ConnectorStores {
  return {
    idempotencyStore: new D1IdempotencyStore(db),
    rateLimitStore: new D1RateLimitStore(db),
  };
}

// .hostname, never .host: breakwater's egress allowlist accepts bare
// hostnames only, so a ported URL (wrangler dev = localhost:8787) would throw
// at construction via .host. The runtime guard matches url.hostname per hop.
function understudyHost(env: BrowserConnectorEnv): string {
  return new URL(env.UNDERSTUDY_URL).hostname;
}

// -- Connector ids (grant-minting keys) ---------------------------------------
// A flowsafe suspension mints grants for these STATIC literals - never for
// ids derived from model output (the grant is a capability token).

export const BROWSER_OBSERVE_CONNECTOR = "browser.observe";
export const BROWSER_ACT_CONNECTOR = "browser.act";

/** The write connectors an approval gate mints grants for (reads need none). */
export const BROWSER_WRITE_CONNECTOR_IDS = [
  BROWSER_ACT_CONNECTOR,
] as const;

// -- I/O schemas ---------------------------------------------------------------
// Command shapes mirror @understudy/protocol MINUS commandId (assigned per
// call below). The protocol's resolve_ref is deliberately absent: it is an
// internal service<->extension probe - consumers express dry-run intent via
// the service API's dryRun flag, which the action dryRunExecute path sets.

const ConnectorIdSchema = z.string().min(1).max(128);
const ConnectorRefSchema = z.string().min(1).max(256);
const ConnectorTabIdSchema = z.number().int().nonnegative();

export const observeInput = z.object({
  sessionId: ConnectorIdSchema,
  read: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("snapshot"),
      mode: SnapshotModeSchema, // "a11y" | "dom" | "screenshot"
      tabId: ConnectorTabIdSchema.optional(),
    }).strict(),
    z.object({ type: z.literal("get_tabs") }).strict(),
    z.object({
      type: z.literal("wait"),
      for: z.enum(["load", "idle", "ms"]),
      value: z.number().int().min(0).max(20_000).optional(),
    }).strict().superRefine((value, ctx) => {
      if (value.for === "ms" && value.value === undefined) {
        ctx.addIssue({ code: "custom", path: ["value"], message: "value is required for wait.ms" });
      }
      if (value.for !== "ms" && value.value !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["value"],
          message: "value is forbidden unless wait.for is 'ms'",
        });
      }
    }),
    // Recent page dialogs the browser auto-handled - read from the session
    // status (GET), not a command: dialogs are answered extension-side, this
    // just reports what happened.
    z.object({ type: z.literal("get_dialogs") }).strict(),
  ]),
}).strict();
export type ObserveInput = z.infer<typeof observeInput>;

export const observeOutput = z.object({
  /** Compact a11y tree the agent targets by opaque `ref` (never a selector). */
  tree: z.array(A11yNodeSchema).optional(),
  /** Vision fallback (canvas / visual layout) - an evidence artifact. */
  screenshot: z.object({ mime: z.string(), b64: z.string() }).optional(),
  /** Exact attached CDP target captured with tree/screenshot snapshots. */
  target: SnapshotTargetSchema.optional(),
  tabs: z.array(TabInfoSchema).optional(),
  /** Recent page dialogs (get_dialogs), oldest first. */
  dialogs: z.array(DialogRecordSchema).optional(),
  /** Wait outcome, or `false` when the driver rejects a snapshot. */
  ok: z.boolean().optional(),
  error: z.string().optional(),
}).strict();
export type ObserveOutput = z.infer<typeof observeOutput>;

// Write actions deliberately EXCLUDE secret and payment-card entry.
// Non-secret type.text (a search query, a name) remains auditable, and a
// breakwater piiSecrets policy can reject high-entropy strings at the agent
// boundary. Card submission uses the extension-local vault contract.
//
// This union is the public non-payment write class:
// click/type/navigate/key/scroll/switch_tab. Payment-card submission is
// available only through the extension-local MCP contract. Since
// the protocol reclassified scroll/switch_tab as writes (they are user-visible
// side effects), there is no longer any divergence to reconcile - the
// relationship is pinned at compile time AND runtime in index.test.ts, so a
// protocol classification change breaks the build instead of drifting.
export const actInput = z.object({
  sessionId: ConnectorIdSchema,
  action: z.discriminatedUnion("type", [
    z.object({ type: z.literal("click"), ref: ConnectorRefSchema }).strict(),
    z.object({
      type: z.literal("type"),
      ref: ConnectorRefSchema,
      text: z.string().max(64 * 1024),
      submit: z.boolean().optional(),
    }).strict(),
    z.object({
      type: z.literal("navigate"),
      url: z.string().min(1).max(8 * 1024).pipe(z.url()),
      tabId: ConnectorTabIdSchema.optional(),
    }).strict(),
    z.object({
      type: z.literal("key"),
      keys: z.string().min(1).max(256),
      ref: ConnectorRefSchema.optional(),
    }).strict(),
    z.object({
      type: z.literal("scroll"),
      ref: ConnectorRefSchema.optional(),
      dy: z.number().finite(),
    }).strict(),
    z.object({ type: z.literal("switch_tab"), tabId: ConnectorTabIdSchema }).strict(),
  ]),
}).strict();
export type ActInput = z.infer<typeof actInput>;

export const actOutput = z.object({
  ok: z.boolean(),
  url: z.string().optional(),
  error: z.string().optional(),
  simulated: z.boolean().optional(),
}).strict();
export type ActOutput = z.infer<typeof actOutput>;

// -- Service bridge ------------------------------------------------------------

/**
 * POST one command to the understudy service and return the correlated Event.
 * Goes through the egress-guarded runtime.fetch, so the call is pinned to the
 * understudy host (redirect hops included) or denied + audited.
 */
async function callUnderstudy(
  runtime: ConnectorRuntime,
  env: BrowserConnectorEnv,
  sessionId: string,
  command: Command,
  opts: { dryRun?: boolean } = {},
): Promise<Event> {
  const base = env.UNDERSTUDY_URL.replace(/\/$/, "");
  const res = await runtime.fetch(
    `${base}/v1/sessions/${encodeURIComponent(sessionId)}/commands`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.UNDERSTUDY_TOKEN}`,
        "understudy-command-contract": "2",
      },
      body: JSON.stringify({ command, dryRun: opts.dryRun ?? false }),
    },
  );
  if (res.status === 202) {
    const pending = PendingCommandResponseSchema.parse(await res.json());
    throw new UnderstudyCommandPendingError(pending);
  }
  if (!res.ok) {
    const failure = await parseCommandFailure(res);
    if (res.status === 504 && failure.code === "command_not_started") {
      throw new UnderstudyCommandNotStartedError(command.commandId);
    }
    if (res.status === 504 && failure.code === "command_timed_out") {
      throw new UnderstudyCommandTimedOutError(command.commandId);
    }
    if (res.status === 409 && failure.code === "command_outcome_unknown") {
      throw new UnderstudyCommandOutcomeUnknownError(command.commandId);
    }
    // Status + session only - request/response bodies can carry page content,
    // evidence, or PII that must not reach a log sink.
    throw new Error(`understudy service ${res.status} for session ${sessionId}`);
  }
  return parseEvent(await res.json());
}

const CommandFailureSchema = z
  .object({
    code: z.string().max(128).optional(),
    error: z.string().max(256).optional(),
    commandId: z.string().max(128).optional(),
    safeToRetry: z.boolean().optional(),
  })
  .strict();

async function parseCommandFailure(response: {
  json(): Promise<unknown>;
}): Promise<z.infer<typeof CommandFailureSchema>> {
  try {
    return CommandFailureSchema.parse(await response.json());
  } catch {
    return {};
  }
}

export class UnderstudyCommandPendingError extends Error {
  readonly pending: PendingCommandResponse;

  constructor(pending: PendingCommandResponse) {
    super(`understudy command ${pending.commandId} is pending`);
    this.name = "UnderstudyCommandPendingError";
    this.pending = pending;
  }
}

export class UnderstudyCommandNotStartedError extends Error {
  readonly commandId: string;
  readonly safeToRetry = true as const;

  constructor(commandId: string) {
    super(`understudy command ${commandId} was not started`);
    this.name = "UnderstudyCommandNotStartedError";
    this.commandId = commandId;
  }
}

export class UnderstudyCommandTimedOutError extends Error {
  readonly commandId: string;
  readonly safeToRetry = true as const;

  constructor(commandId: string) {
    super(`understudy command ${commandId} timed out`);
    this.name = "UnderstudyCommandTimedOutError";
    this.commandId = commandId;
  }
}

export class UnderstudyCommandOutcomeUnknownError extends Error {
  readonly commandId: string;
  readonly safeToRetry = false as const;

  constructor(commandId: string) {
    super(`understudy command ${commandId} has an unknown outcome`);
    this.name = "UnderstudyCommandOutcomeUnknownError";
    this.commandId = commandId;
  }
}

export async function pollUnderstudyCommand(
  runtime: ConnectorRuntime,
  env: BrowserConnectorEnv,
  sessionId: string,
  commandId: string,
): Promise<CommandStatusResponse> {
  const base = env.UNDERSTUDY_URL.replace(/\/$/, "");
  const response = await runtime.fetch(
    `${base}/v1/sessions/${encodeURIComponent(sessionId)}/commands/${encodeURIComponent(commandId)}`,
    {
      method: "GET",
      headers: {
        authorization: `Bearer ${env.UNDERSTUDY_TOKEN}`,
        "understudy-command-contract": "2",
      },
    },
  );
  if (!response.ok) {
    throw new Error(`understudy service ${response.status} for session ${sessionId}`);
  }
  return CommandStatusResponseSchema.parse(await response.json());
}

/**
 * GET the session status through the same egress-guarded runtime.fetch and
 * return the recent dialogs the service recorded. A pure read - no command, no
 * idempotency key, no approval.
 */
async function getSessionStatus(
  runtime: ConnectorRuntime,
  env: BrowserConnectorEnv,
  sessionId: string,
): Promise<{ dialogs: DialogRecord[] }> {
  const base = env.UNDERSTUDY_URL.replace(/\/$/, "");
  const res = await runtime.fetch(`${base}/v1/sessions/${encodeURIComponent(sessionId)}`, {
    method: "GET",
    headers: { authorization: `Bearer ${env.UNDERSTUDY_TOKEN}` },
  });
  if (!res.ok) {
    throw new Error(`understudy service ${res.status} for session ${sessionId}`);
  }
  const parsed = z.object({ dialogs: z.array(DialogRecordSchema) }).safeParse(await res.json());
  if (!parsed.success) {
    throw new Error(`understudy service returned an unparseable status for session ${sessionId}`);
  }
  return { dialogs: parsed.data.dialogs };
}

// Writes pass a stable commandId derived from the breakwater idempotency
// key; everything else gets a random UUID. breakwater replays a COMPLETED
// key without re-running execute(), but a failed attempt (response lost or
// unparseable after the service performed the write) releases the key and
// the retry re-runs execute() - under a random id the service could not
// recognize the retry, and the write would run twice. Under the derived id
// the service replays the recorded Event instead (its completedWrites
// cache). Protocol 3 supplies at-most-once execution plus explicit pending
// and unknown outcomes when an external result cannot be proven.
function toCommand(fields: object, commandId?: string): Command {
  return parseCommand({ ...fields, commandId: commandId ?? crypto.randomUUID() });
}

// The wrapper hands config.execute the same ToolExecutionContext it read the
// idempotency key from, so the derived commandId and breakwater's replay
// store always key off the same value. Structural access: Mastra's context
// type does not surface requestContext.get on every version.
async function idempotencyCommandId(ctx: ToolExecutionContext): Promise<string | undefined> {
  const requestContext = (
    ctx as { requestContext?: { get?: (key: string) => unknown } }
  ).requestContext;
  const key = requestContext?.get?.(IDEMPOTENCY_KEY_CONTEXT_KEY);
  if (typeof key !== "string" || key.length === 0) return undefined;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  const hex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `ik_${hex}`;
}

// -- Connectors ------------------------------------------------------------------

/**
 * Org-level breakwater policy pass-through: wire an AuditLogger to record
 * every decision (grant denials, per-hop egress denials, allowed executes),
 * evaluators such as tenantIsolation() for multi-tenant hosts, an org egress
 * allowlist, or a base fetch (test/instrumentation seam). Stores stay a
 * separate required argument because the write connectors cannot function
 * without them.
 */
export type BrowserConnectorPolicies = Pick<
  ConnectorPolicies,
  "audit" | "evaluators" | "networkEgress" | "writePermissions" | "fetch"
>;

export type BrowserConnectors = ReturnType<typeof createBrowserConnectors>;

export function createBrowserConnectors(
  env: BrowserConnectorEnv,
  stores: ConnectorStores,
  options: BrowserConnectorPolicies = {},
) {
  const policies = {
    ...options,
    idempotencyStore: stores.idempotencyStore,
    rateLimitStore: stores.rateLimitStore,
  };
  const egress = [understudyHost(env)];

  // Read: observe the session. No approval, no idempotency - reads are free.
  // Still egress-pinned + audited.
  const observe = createConnector({
    id: BROWSER_OBSERVE_CONNECTOR,
    description:
      "Observe the browser session: a11y-tree/DOM/screenshot snapshot of the page (target elements by the returned refs), list open tabs, read recent page dialogs the browser auto-handled, or wait for load/idle/ms. Read-only.",
    inputSchema: observeInput,
    outputSchema: observeOutput,
    permissions: { sideEffect: "read", egress },
    policies: options, // reads need no stores, but audit/evaluators apply

    execute: async (input, _ctx, runtime): Promise<ObserveOutput> => {
      const read = input.read;
      // Dialogs come from the session status (GET), not a dispatched command.
      if (read.type === "get_dialogs") {
        return await getSessionStatus(runtime, env, input.sessionId);
      }
      const ev = await callUnderstudy(runtime, env, input.sessionId, toCommand(read));
      switch (read.type) {
        case "snapshot":
          if (ev.type === "snapshot_result") {
            return { tree: ev.tree, target: { tabId: ev.tabId, url: ev.url } };
          }
          if (ev.type === "screenshot_result") {
            return {
              screenshot: { mime: ev.mime, b64: ev.b64 },
              target: { tabId: ev.tabId, url: ev.url },
            };
          }
          if (ev.type === "action_result" && !ev.ok) {
            return { ok: false, error: ev.error };
          }
          break;
        case "get_tabs":
          if (ev.type === "tabs_result") return { tabs: ev.tabs };
          break;
        case "wait":
          if (ev.type === "action_result") return { ok: ev.ok, error: ev.error };
          break;
      }
      throw new Error(`observe: unexpected event '${ev.type}' for read '${read.type}'`);
    },
  });

  // Write: a state-changing browser action. Fails closed behind the grant,
  // at-most-once across retries, dry-runnable, rate-limited.
  const act = createConnector({
    id: BROWSER_ACT_CONNECTOR,
    description:
      "Perform a state-changing browser action (click/type/navigate/key/scroll/switch_tab) in the session. Requires approval. Never put credentials or payment-card data in type.text.",
    inputSchema: actInput,
    outputSchema: actOutput,
    permissions: {
      sideEffect: "write",
      egress,
      idempotencyKey: true, // caller supplies IDEMPOTENCY_KEY_CONTEXT_KEY (e.g. caseId:step:action)
      requiresApproval: true, // unlocked only by a flowsafe-minted grant on resume
      dryRun: true,
      rateLimit: "60/min",
    },
    execute: async (input, ctx, runtime): Promise<ActOutput> => {
      const command = toCommand(input.action, await idempotencyCommandId(ctx));
      const ev = await callUnderstudy(runtime, env, input.sessionId, command);
      if (ev.type === "action_result") return { ok: ev.ok, url: ev.url, error: ev.error };
      throw new Error(`act: unexpected event '${ev.type}'`);
    },
    // Simulation: the service checks the ref still resolves (via its internal
    // resolve_ref probe - a pure ref-map lookup that never re-mints refs) and
    // returns a simulated action_result without dispatching anything. A
    // simulated ok guarantees RESOLVABILITY, not executability; ref-less
    // actions (navigate/switch_tab/ref-less key/scroll) simulate ok with zero
    // wire traffic, so a simulated ok is NOT a liveness signal.
    dryRunExecute: async (input, _ctx, runtime): Promise<ActOutput> => {
      const ev = await callUnderstudy(runtime, env, input.sessionId, toCommand(input.action), {
        dryRun: true,
      });
      if (ev.type === "action_result") {
        return { ok: ev.ok, url: ev.url, error: ev.error, simulated: true };
      }
      throw new Error(`act(dryRun): unexpected event '${ev.type}'`);
    },
    policies,
  });

  return { observe, act };
}

// -- Caller-side helpers (mirror metamind's intake/connectors.ts) ----------------
// A connector's tool boundary is execute(inputData, context) - two args;
// breakwater manufactures the egress-guarded runtime (the third arg to the
// config executes above) internally. These helpers thread per-call
// requestContext keys without mutating the workflow's runtime-minted context.

interface ConnectorLike<In> {
  execute?: (input: In, context: ToolExecutionContext) => Promise<unknown>;
}

function contextWith(base: unknown, extra: Record<string, unknown>): RequestContext {
  const source = base as { entries?: () => Iterable<readonly [string, unknown]> } | undefined;
  const merged: Record<string, unknown> = {};
  if (source?.entries) {
    for (const [key, value] of source.entries()) merged[key] = value;
  }
  for (const [key, value] of Object.entries(extra)) merged[key] = value;
  return new RequestContext(Object.entries(merged));
}

/**
 * `requestContext` must be the runtime-minted RequestContext (or undefined) -
 * contextWith merges via .entries(), so a plain object's keys (including a
 * grant) would be dropped. That failure direction is closed (a lost grant
 * denies), but don't hand-roll the context.
 */
export async function callConnector<In, Out>(
  connector: ConnectorLike<In>,
  input: In,
  requestContext: unknown,
  extraKeys?: Record<string, unknown>,
): Promise<Out> {
  if (!connector.execute) throw new Error("connector has no execute");
  const context = extraKeys !== undefined ? contextWith(requestContext, extraKeys) : requestContext;
  const result = await connector.execute(input, {
    requestContext: context,
  } as unknown as ToolExecutionContext);
  // Mastra's Tool.execute RETURNS a validation-error sentinel (never throws)
  // when inputSchema rejects. The agent tool-call path reads it, but a
  // workflow caller destructuring the output would silently see undefined
  // fields - normalize to a throw so every helper failure is catchable.
  if (
    typeof result === "object" &&
    result !== null &&
    (result as { error?: unknown }).error === true &&
    "validationErrors" in result
  ) {
    const message = (result as { message?: unknown }).message;
    throw new Error(
      `connector input validation failed: ${typeof message === "string" ? message : "invalid input"}`,
    );
  }
  return result as Out;
}

/**
 * Real write - at-most-once under a business-meaningful idempotency key
 * (e.g. `${caseId}:${step}:click`). The runtime-minted requestContext carries
 * the flowsafe grant; this only adds the per-call key.
 */
export async function callBrowserWrite<In, Out>(
  connector: ConnectorLike<In>,
  input: In,
  requestContext: unknown,
  idempotencyKey: string,
): Promise<Out> {
  return callConnector<In, Out>(connector, input, requestContext, {
    [IDEMPOTENCY_KEY_CONTEXT_KEY]: idempotencyKey,
  });
}

/** Simulation - no grant, no idempotency spend, no rate budget. */
export async function callBrowserDryRun<In, Out>(
  connector: ConnectorLike<In>,
  input: In,
): Promise<Out> {
  return callConnector<In, Out>(connector, input, undefined, {
    [DRY_RUN_CONTEXT_KEY]: true,
  });
}
