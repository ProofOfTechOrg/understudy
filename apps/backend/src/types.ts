/**
 * Shared cross-module contract for @understudy/backend.
 *
 * The SessionCoordinator (M-003), the SessionAgent Durable Object (M-004),
 * caller/tenant auth (M-006) all import
 * Env, SessionState, and SessionStatus from this module rather than
 * declaring their own copies, so the Worker bindings and the per-session DO
 * state have exactly one definition each.
 */

import type {
  Command,
  CommandState,
  DialogDelivery,
  DialogRecord,
  Event,
  PendingCommandResponse,
  ProtocolCapability,
  TabInfo,
  UnattendedSessionLifecycle,
} from "@understudy/protocol";
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

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
 * Runtime bindings come from `wrangler types`. The additions below exist only
 * for request-scoped OAuth injection and the optional maintenance latch.
 */
export interface Env extends Cloudflare.Env {
  /**
   * OAuth helper methods the provider injects into env for requests that
   * flow through it (the dashboard defaultHandler uses them for consent).
   * Absent on requests that bypass the provider.
   */
  OAUTH_PROVIDER?: OAuthHelpers;
  AUTH_EPOCH_CUTOVER?: string;
}

/**
 * Lifecycle status of a SessionAgent DO. Consumed by SessionAgent.onDetach
 * (M-004), SessionCoordinator.setStatus (M-003), and the GET
 * /v1/sessions/:id status route (M-005).
 */
export type SessionStatus = "pending" | "idle" | "connected" | "detached";

export interface LegacyCommandTombstone {
  commandId: string;
  commandType: Command["type"];
  requestFingerprint: string;
}

export interface CompletedLegacyWrite extends LegacyCommandTombstone {
  event: Extract<Event, { type: "action_result" }>;
}

export type PersistedLegacyAwaiting =
  | LegacyCommandTombstone
  | { commandId: string };

export type PersistedLegacyCommandTombstone = PersistedLegacyAwaiting;

export type PersistedCompletedLegacyWrite =
  | CompletedLegacyWrite
  | { commandId: string; event: Event };

/**
 * Agents-SDK Durable Object state for one session. Must stay JSON-
 * serializable because setState round-trips through JSON. Legacy
 * awaitingCommandIds remain readable while new writes persist typed command
 * tombstones.
 */
export interface SessionState {
  browser: HelloBrowserInfo | null;
  tabs: TabInfo[];
  currentUrl: string | null;
  /** The refMap generation; bumped on navigation / hello resync. */
  generation: number;
  awaitingCommandIds: string[];
  awaitingCommands?: PersistedLegacyAwaiting[];
  status: SessionStatus;
  /** Current attended attachment incarnation. Unattended sessions keep null. */
  attachmentId: string | null;
  /**
   * The one authenticated extension connection allowed to receive Commands
   * and submit Events. `null` means no authoritative connection. Sessions
   * persisted before this field existed can lack it at runtime; session.ts
   * migrates that legacy shape only when exactly one authorized connection
   * exists, so an ambiguous multi-connection state never falls back to
   * broadcasting.
   */
  activeConnectionId: string | null;
  /**
   * Completed WRITE commands' Events, oldest first, capped in session.ts -
   * the service half of the idempotent-retry contract. A consumer retrying
   * a write under the same commandId (the connector derives it from the
   * breakwater idempotency key) gets the recorded Event back instead of a
   * second execution, closing the write-performed-but-response-lost gap.
   * New entries hold bounded action_results plus the exact command type and
   * request fingerprint. Legacy ID-only entries remain conflict tombstones.
   */
  completedWrites: PersistedCompletedLegacyWrite[];
  legacyCommandTombstones?: PersistedLegacyCommandTombstone[];
  /**
   * Recent page dialogs the extension handled (alert/confirm/prompt/
   * beforeunload), oldest first, capped in session.ts. Surfaced to the consumer
   * via GET /v1/sessions/:id so an agent/governance layer sees what a page said
   * and how it was auto-answered. An after-the-fact record, not a response
   * channel: dialogs are answered synchronously extension-side (an open dialog
   * blocks the CDP channel), never by a consumer round-trip. Protocol 3
   * acknowledges and replays records within one browser epoch. The public
   * payload list remains capped, so this is an operational surface rather than
   * a durable audit log.
   */
  dialogs: DialogRecord[];
  protocolVersion?: 1 | 2 | 3;
  capabilities?: ProtocolCapability[];
  mode?: "attended" | "unattended";
  unattended?: {
    tenantId: string;
    deviceId: string;
    leaseId: string;
    leaseEpoch: number;
    browserEpoch: string;
    status: UnattendedSessionLifecycle;
    createdAt: string;
    lastActivityAt: string;
    idleExpiresAt: string;
    hardExpiresAt: string;
    needsReconciliation: boolean;
    dialogDelivery: DialogDelivery;
    allowedOrigins: string[];
  };
}

/**
 * What dispatch returns across the DO RPC boundary. Expected
 * delivery failures travel as data, not exceptions: a rejected RPC promise
 * is logged by workerd as an uncaught exception even when the Worker-side
 * caller handles it, and a typed reason beats message-prefix parsing at the
 * route. Unknown errors still throw - those are genuine 500s.
 */
export type DispatchOutcome =
  | { ok: true; event: Event }
  | {
      ok: false;
      reason:
        | "not_connected"
        | "timed_out"
        | "resynced"
        | "duplicate_in_flight"
        | "session_busy"
        | "terminal_session"
        | "id_conflict";
      message: string;
    };

export type V2DispatchOutcome =
  | { kind: "terminal"; event: Event }
  | { kind: "pending"; pending: PendingCommandResponse }
  | { kind: "not_started"; commandId: string; safeToRetry: true }
  | { kind: "timed_out"; commandId: string; safeToRetry: true }
  | { kind: "unknown"; commandId: string; safeToRetry: false }
  | { kind: "id_conflict"; commandId: string }
  | { kind: "busy"; commandId: string }
  | { kind: "not_connected"; commandId: string }
  | { kind: "legacy_snapshot_required"; commandId: string }
  | { kind: "unsupported"; commandId: string }
  | { kind: "terminal_session"; commandId: string };

export interface CommandStatusRecord {
  commandId: string;
  status: CommandState;
  event?: Event;
  safeToRetry: boolean;
}
