/**
 * Shared cross-module contract for @understudy/backend.
 *
 * The SessionCoordinator (M-003), the SessionAgent Durable Object (M-004),
 * caller/tenant auth (M-006), and vault secret resolution (M-007) all import
 * Env, SessionState, and SessionStatus from this module rather than
 * declaring their own copies, so the Worker bindings and the per-session DO
 * state have exactly one definition each.
 */

import type { DialogRecord, Event, TabInfo } from "@understudy/protocol";
import type { SessionAgent } from "./session";

/**
 * The non-tabs fields of the extension's hello event: what it reports about
 * itself on connect. Derived from the protocol Event union instead of
 * re-declared, so a wire-shape change to hello is felt here automatically.
 */
type HelloBrowserInfo = Pick<Extract<Event, { type: "hello" }>, "browser" | "extVersion">;

/**
 * A page dialog the extension handled, as recorded in DO state and surfaced via
 * GET /v1/sessions/:id. Re-exported from the protocol (DialogRecordSchema) so
 * the DO-state shape and the wire `dialog` Event share exactly one definition.
 */
export type { DialogRecord };

/**
 * The credential-vault seam that secrets.ts (M-007) resolves fill_secret's
 * secretRef through. Deliberately narrow (read-by-key only) and backend-
 * agnostic: the concrete Cloudflare binding is a KV namespace (see
 * wrangler.jsonc's VAULT binding), because an arbitrary per-fill secretRef
 * needs a dynamic keyed lookup that CF's Secrets / Secrets Store bindings -
 * one static binding per fixed secret name - cannot address.
 *
 * Two layers implement this same interface: Env.VAULT (the raw KV namespace,
 * which stores only AES-256-GCM envelopes - never plaintext at rest) and
 * vault.ts's EncryptedKvVault (which wraps it and decrypts with
 * VAULT_MASTER_KEY). resolveSecret always goes through the decrypting layer
 * via vault.ts's createVault(env). A per-tenant external KMS remains a
 * possible future swap behind this seam.
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
  /**
   * base64url-encoded 32-byte AES-256-GCM key that envelope-encrypts every
   * vault value (vault.ts). KV holds only ciphertext; without this secret a
   * KV read-back at rest yields nothing usable. Required via
   * `secrets.required`, like the token maps.
   */
  VAULT_MASTER_KEY: string;
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
  /**
   * Completed WRITE commands' Events, oldest first, capped in session.ts -
   * the service half of the idempotent-retry contract. A consumer retrying
   * a write under the same commandId (the connector derives it from the
   * breakwater idempotency key) gets the recorded Event back instead of a
   * second execution, closing the write-performed-but-response-lost gap.
   * Only ever holds action_results for writes: small, and plaintext-free by
   * the DL-004 construction (fill_secret results carry ok/error only).
   */
  completedWrites: { commandId: string; event: Event }[];
  /**
   * Recent page dialogs the extension handled (alert/confirm/prompt/
   * beforeunload), oldest first, capped in session.ts. Surfaced to the consumer
   * via GET /v1/sessions/:id so an agent/governance layer sees what a page said
   * and how it was auto-answered. An after-the-fact record, not a response
   * channel: dialogs are answered synchronously extension-side (an open dialog
   * blocks the CDP channel), never by a consumer round-trip. BEST-EFFORT and
   * capped: a report emitted while the WS is momentarily down is not replayed
   * (the dialog is still answered; only its notification is lost), so this is an
   * observability surface, not a guaranteed audit log.
   */
  dialogs: DialogRecord[];
}

/**
 * What dispatch/fillSecret return across the DO RPC boundary. Expected
 * delivery failures travel as data, not exceptions: a rejected RPC promise
 * is logged by workerd as an uncaught exception even when the Worker-side
 * caller handles it, and a typed reason beats message-prefix parsing at the
 * route. Unknown errors still throw - those are genuine 500s.
 */
export type DispatchOutcome =
  | { ok: true; event: Event }
  | {
      ok: false;
      reason: "not_connected" | "timed_out" | "resynced" | "duplicate_in_flight";
      message: string;
    };
