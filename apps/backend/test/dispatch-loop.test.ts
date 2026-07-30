/**
 * Unit tests for the MCP dispatch/poll/retry loop (src/mcp/dispatch-loop.ts).
 * Pure — the three side effects are injected — so the counting and threshold
 * logic AccountAgent depends on is exercised directly, with a no-op sleep and
 * scripted dispatch/poll steps rather than a live device.
 */

import { describe, expect, it, vi } from "vitest";
import type { Command, Event } from "@understudy/protocol";
import type { CommandStatusRecord, V2DispatchOutcome } from "../src/types";
import {
  BUSY_RETRY_LIMIT,
  DISPATCH_RETRY_LIMIT,
  PENDING_POLL_ATTEMPTS,
  runDispatchLoop,
  type DispatchStep,
} from "../src/mcp/dispatch-loop";

const COMMAND: Command = { type: "click", commandId: "ik_test", ref: "a1:s0e0" };
const OK_EVENT: Event = { type: "action_result", commandId: "ik_test", ok: true };

function terminalStep(): DispatchStep {
  return { kind: "terminal", event: OK_EVENT } satisfies V2DispatchOutcome;
}

/** A deps object whose dispatch/poll return scripted queues, sleep a no-op. */
function scriptedDeps(steps: {
  dispatch?: DispatchStep[];
  poll?: (CommandStatusRecord | null)[];
}) {
  const dispatchQueue = [...(steps.dispatch ?? [])];
  const pollQueue = [...(steps.poll ?? [])];
  const sleep = vi.fn(async () => {});
  const dispatch = vi.fn(async (_command: Command): Promise<DispatchStep> => {
    const next = dispatchQueue.shift();
    if (next === undefined) throw new Error("dispatch called more times than scripted");
    return next;
  });
  const poll = vi.fn(async (_commandId: string): Promise<CommandStatusRecord | null> => {
    const next = pollQueue.shift();
    return next === undefined ? null : next;
  });
  return { deps: { dispatch, poll, sleep }, dispatch, poll, sleep };
}

describe("runDispatchLoop", () => {
  it("returns a terminal event immediately", async () => {
    const { deps, dispatch } = scriptedDeps({ dispatch: [terminalStep()] });
    const outcome = await runDispatchLoop(COMMAND, deps);
    expect(outcome).toEqual({ kind: "terminal", event: OK_EVENT });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("re-POSTs the SAME command id on a 504-class result, up to the retry limit", async () => {
    // not_started three times (initial + DISPATCH_RETRY_LIMIT) → retries_exhausted
    const { deps, dispatch } = scriptedDeps({
      dispatch: Array.from({ length: DISPATCH_RETRY_LIMIT + 1 }, () => ({
        kind: "not_started" as const,
        commandId: COMMAND.commandId,
        safeToRetry: true as const,
      })),
    });
    const outcome = await runDispatchLoop(COMMAND, deps);
    expect(outcome).toEqual({ kind: "retries_exhausted", commandId: COMMAND.commandId });
    // Every re-dispatch used the identical command object (same id).
    for (const call of dispatch.mock.calls) expect(call[0]).toBe(COMMAND);
  });

  it("recovers when a 504 retry finally succeeds", async () => {
    const { deps, dispatch } = scriptedDeps({
      dispatch: [
        { kind: "timed_out", commandId: COMMAND.commandId, safeToRetry: true },
        terminalStep(),
      ],
    });
    const outcome = await runDispatchLoop(COMMAND, deps);
    expect(outcome).toEqual({ kind: "terminal", event: OK_EVENT });
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("backs off on busy exactly BUSY_RETRY_LIMIT times, sleeping between", async () => {
    const { deps, dispatch, sleep } = scriptedDeps({
      dispatch: Array.from({ length: BUSY_RETRY_LIMIT }, () => ({
        kind: "busy" as const,
        commandId: COMMAND.commandId,
      })),
    });
    const outcome = await runDispatchLoop(COMMAND, deps);
    expect(outcome).toEqual({ kind: "busy_exhausted" });
    expect(dispatch).toHaveBeenCalledTimes(BUSY_RETRY_LIMIT);
    expect(sleep).toHaveBeenCalledTimes(BUSY_RETRY_LIMIT - 1);
  });

  it("polls a pending command and returns its completed event", async () => {
    const { deps, poll } = scriptedDeps({
      dispatch: [{ kind: "pending", pending: { commandId: COMMAND.commandId } as never }],
      poll: [
        { commandId: COMMAND.commandId, status: "granted", safeToRetry: false },
        { commandId: COMMAND.commandId, status: "completed", event: OK_EVENT, safeToRetry: false },
      ],
    });
    const outcome = await runDispatchLoop(COMMAND, deps);
    expect(outcome).toEqual({ kind: "terminal", event: OK_EVENT });
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it("converts a pending→not_started poll into a re-dispatch (journal proves it never ran)", async () => {
    const { deps, dispatch } = scriptedDeps({
      dispatch: [
        { kind: "pending", pending: { commandId: COMMAND.commandId } as never },
        terminalStep(),
      ],
      poll: [{ commandId: COMMAND.commandId, status: "not_started", safeToRetry: true }],
    });
    const outcome = await runDispatchLoop(COMMAND, deps);
    expect(outcome).toEqual({ kind: "terminal", event: OK_EVENT });
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("gives up after PENDING_POLL_ATTEMPTS with a non-error pending_exhausted", async () => {
    const { deps, poll } = scriptedDeps({
      dispatch: [{ kind: "pending", pending: { commandId: COMMAND.commandId } as never }],
      poll: [], // every poll returns null (still running)
    });
    const outcome = await runDispatchLoop(COMMAND, deps);
    expect(outcome).toEqual({ kind: "pending_exhausted", commandId: COMMAND.commandId });
    expect(poll).toHaveBeenCalledTimes(PENDING_POLL_ATTEMPTS);
  });

  it("never retries an unknown outcome", async () => {
    const { deps, dispatch } = scriptedDeps({
      dispatch: [{ kind: "unknown", commandId: COMMAND.commandId, safeToRetry: false }],
    });
    const outcome = await runDispatchLoop(COMMAND, deps);
    expect(outcome).toEqual({ kind: "unknown_outcome", commandId: COMMAND.commandId });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["not_connected", { kind: "not_connected" as const, commandId: COMMAND.commandId }],
    ["unsupported", { kind: "unsupported" as const, commandId: COMMAND.commandId }],
    ["id_conflict", { kind: "id_conflict" as const, commandId: COMMAND.commandId }],
  ])("maps %s to a single terminal outcome with no retry", async (kind, step) => {
    const { deps, dispatch } = scriptedDeps({ dispatch: [step] });
    const outcome = await runDispatchLoop(COMMAND, deps);
    expect(outcome.kind).toBe(kind);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("folds a gone session into terminal_session", async () => {
    const { deps } = scriptedDeps({ dispatch: [{ kind: "gone" }] });
    expect(await runDispatchLoop(COMMAND, deps)).toEqual({ kind: "terminal_session" });
  });
});
