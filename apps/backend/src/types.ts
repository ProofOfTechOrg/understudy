/**
 * Shared cross-module contract for @understudy/backend.
 *
 * The SessionCoordinator (M-003), the SessionAgent Durable Object (M-004),
 * caller/tenant auth (M-006), and vault secret resolution (M-007) all import
 * Env, SessionState, and SessionStatus from this module rather than
 * declaring their own copies, so the Worker bindings and the per-session DO
 * state have exactly one definition each.
 */

import type { Event, TabInfo } from "@understudy/protocol";
import type { SessionAgent } from "./session";

/**
 * The non-tabs fields of the extension's hello event: what it reports about
 * itself on connect. Derived from the protocol Event union instead of
 * re-declared, so a wire-shape change to hello is felt here automatically.
 */
type HelloBrowserInfo = Pick<Extract<Event, { type: "hello" }>, "browser" | "extVersion">;

/**
 * The credential-vault seam that secrets.ts (M-007) resolves fill_secret's
 * secretRef through. Deliberately narrow (read-by-key only) and backend-
 * agnostic: the concrete Cloudflare binding is a KV namespace (see
 * wrangler.jsonc's VAULT binding), because an arbitrary per-fill secretRef
 * needs a dynamic keyed lookup that CF's Secrets / Secrets Store bindings -
 * one static binding per fixed secret name - cannot address. A per-tenant
 * external KMS is a possible future swap behind this same seam.
 */
export interface VaultBinding {
  get(secretRef: string): Promise<string | null>;
}

/** Worker bindings and environment configuration, wired in wrangler.jsonc. */
export interface Env {
  /** One Durable Object per sessionId (per tenant/case) - DL-006. */
  SESSION: DurableObjectNamespace<SessionAgent>;
  VAULT: VaultBinding;
  /** Signs/verifies server-minted sessionIds so scopeSession can verify tenant ownership statelessly (M-006, DL-008). */
  AUTH_HMAC_SECRET: string;
  /**
   * Static caller-token -> tenantId map (JSON) for the dev auth verifier
   * (M-006). Required, not optional: wrangler.jsonc lists it in
   * `secrets.required`, which is also the .dev.vars allowlist, so a
   * deployment without it cannot start. auth.ts still guards the empty
   * string at runtime.
   */
  CALLER_TOKENS: string;
  /** Extension per-user token(s) (JSON), verified independently of caller auth. Required via `secrets.required`, like CALLER_TOKENS. */
  EXTENSION_TOKENS: string;
}

/**
 * Lifecycle status of a SessionAgent DO. Consumed by SessionAgent.onDetach
 * (M-004), SessionCoordinator.setStatus (M-003), and the GET
 * /v1/sessions/:id status route (M-005).
 */
export type SessionStatus = "pending" | "connected" | "detached";

/**
 * Agents-SDK Durable Object state for one session. Must stay JSON-
 * serializable (setState round-trips through JSON): awaitingCommandIds is a
 * string array standing in for a Set, not a JS Set/Map (DL-007).
 */
export interface SessionState {
  browser: HelloBrowserInfo | null;
  tabs: TabInfo[];
  currentUrl: string | null;
  /** The refMap generation; bumped on navigation / hello resync. */
  generation: number;
  awaitingCommandIds: string[];
  status: SessionStatus;
}
