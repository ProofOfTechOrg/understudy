/**
 * Portable SessionCoordinator seam (DL-010).
 *
 * The command<->event correlation contract, free of any Cloudflare or
 * `agents` import. CfSessionCoordinator (coordinator-cf.ts) is the only
 * file that couples this seam to Cloudflare - via constructor-injected
 * capabilities rather than a direct import - so a raw-DO or Node self-host
 * can swap in a different implementation here without the command API
 * (session.ts, index.ts) ever changing.
 */

import type { Command, Event } from "@understudy/protocol";
import type { SessionStatus } from "./types";

/**
 * send()'s delivery-failure vocabulary. These prefixes never cross the RPC
 * boundary as rejections: SessionAgent.dispatch/fillSecret catch coordinator
 * rejections IN-ISOLATE and map each prefix to a typed DispatchOutcome
 * (types.ts), which the Worker maps to 503/504/409 (index.ts). Keeping the
 * rejection inside the Durable Object matters twice over - a structured
 * outcome instead of message-prefix parsing at the route, and no
 * "Uncaught (in promise)" instrumentation noise from workerd, which reports
 * every RPC promise that rejects server-side even when the caller handles it.
 */
export const SESSION_NOT_CONNECTED = "session not connected";
export const COMMAND_TIMED_OUT = "command timed out";
export const SESSION_RESYNCED = "session resynced";
export const DUPLICATE_COMMAND = "duplicate command in flight";

/** One outstanding `send(cmd)` call, awaiting its correlated Event. */
export interface PendingCommand {
  resolve: (ev: Event) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Outstanding commands awaiting their correlated Event, keyed by commandId. */
export type PendingMap = Map<string, PendingCommand>;

/**
 * Correlates commands sent to the extension with the Events that answer
 * them. `send` resolves with the Event bearing the sent command's
 * commandId, or rejects if none arrives within the implementation's
 * per-command timeout.
 */
export interface SessionCoordinator {
  send(cmd: Command): Promise<Event>;
  setStatus(s: SessionStatus): void;
}
