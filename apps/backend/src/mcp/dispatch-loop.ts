/**
 * The MCP write/read recovery loop, factored out of AccountAgent so its
 * counting and threshold logic is unit-testable without a live device: the
 * three side effects (dispatch, poll, sleep) are injected. Each iteration
 * re-POSTs the SAME commandId — 504-class outcomes carry safeToRetry:true
 * because the journal proves the write never started, and busy re-admissions
 * must share one identity with the original.
 *
 * The pending-poll budget is expressed as an iteration COUNT, not wall-clock,
 * so a test can drive the whole loop with a no-op sleep and still exercise
 * exhaustion at the right threshold.
 */

import type { Command, Event } from "@understudy/protocol";
import type { CommandStatusRecord, V2DispatchOutcome } from "../types";

export const DISPATCH_RETRY_LIMIT = 2;
export const BUSY_RETRY_LIMIT = 5;
export const BUSY_RETRY_DELAY_MS = 2_000;
export const PENDING_POLL_INTERVAL_MS = 2_000;
/** ~30 s past the server's ~20 s synchronous window. */
export const PENDING_POLL_ATTEMPTS = 15;

/** dispatch() re-POSTs the command; "gone" folds not_found/terminal_session. */
export type DispatchStep = V2DispatchOutcome | { kind: "gone" };

export interface DispatchLoopDeps {
  dispatch(command: Command): Promise<DispatchStep>;
  poll(commandId: string): Promise<CommandStatusRecord | null>;
  sleep(ms: number): Promise<void>;
}

export type DispatchLoopOutcome =
  | { kind: "terminal"; event: Event }
  | { kind: "pending_exhausted"; commandId: string }
  | { kind: "retries_exhausted"; commandId: string }
  | { kind: "unknown_outcome"; commandId: string }
  | { kind: "id_conflict"; commandId: string }
  | { kind: "busy_exhausted" }
  | { kind: "not_connected" }
  | { kind: "unsupported" }
  | { kind: "terminal_session" };

export async function runDispatchLoop(
  command: Command,
  deps: DispatchLoopDeps,
): Promise<DispatchLoopOutcome> {
  let busyAttempts = 0;
  let dispatchAttempts = 0;
  while (true) {
    const step = await deps.dispatch(command);
    if (step.kind === "gone") return { kind: "terminal_session" };
    switch (step.kind) {
      case "terminal":
        return { kind: "terminal", event: step.event };
      case "pending": {
        const polled = await pollUntilSettled(command.commandId, deps);
        if (polled === "retry") {
          dispatchAttempts += 1;
          if (dispatchAttempts > DISPATCH_RETRY_LIMIT) {
            return { kind: "retries_exhausted", commandId: command.commandId };
          }
          continue;
        }
        return polled;
      }
      case "not_started":
      case "timed_out":
        dispatchAttempts += 1;
        if (dispatchAttempts > DISPATCH_RETRY_LIMIT) {
          return { kind: "retries_exhausted", commandId: command.commandId };
        }
        continue;
      case "unknown":
        return { kind: "unknown_outcome", commandId: command.commandId };
      case "id_conflict":
        return { kind: "id_conflict", commandId: command.commandId };
      case "busy":
        busyAttempts += 1;
        if (busyAttempts >= BUSY_RETRY_LIMIT) return { kind: "busy_exhausted" };
        await deps.sleep(BUSY_RETRY_DELAY_MS);
        continue;
      case "not_connected":
        return { kind: "not_connected" };
      case "unsupported":
        return { kind: "unsupported" };
      case "terminal_session":
        return { kind: "terminal_session" };
    }
  }
}

/**
 * Polls a pending command for up to PENDING_POLL_ATTEMPTS. Returns "retry"
 * when the journal proves the command never started (safe to re-POST the same
 * id); otherwise a final outcome.
 */
async function pollUntilSettled(
  commandId: string,
  deps: DispatchLoopDeps,
): Promise<DispatchLoopOutcome | "retry"> {
  for (let attempt = 0; attempt < PENDING_POLL_ATTEMPTS; attempt += 1) {
    await deps.sleep(PENDING_POLL_INTERVAL_MS);
    const record = await deps.poll(commandId);
    if (record === null) continue;
    switch (record.status) {
      case "completed":
        return record.event !== undefined
          ? { kind: "terminal", event: record.event }
          : { kind: "pending_exhausted", commandId };
      case "not_started":
      case "timed_out":
        return "retry";
      case "unknown":
        return { kind: "unknown_outcome", commandId };
      default:
        continue;
    }
  }
  return { kind: "pending_exhausted", commandId };
}
