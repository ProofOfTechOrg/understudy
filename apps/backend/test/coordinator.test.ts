import { describe, it, expect, vi } from "vitest";
import { CfSessionCoordinator, type CoordinatorHost } from "../src/coordinator-cf";
import type { Command, Event } from "@understudy/protocol";
import type { LegacyCommandTombstone } from "../src/types";

function createFakeHost(connected = true): CoordinatorHost & { sent: string[] } {
  let awaiting: LegacyCommandTombstone[] = [];
  const sent: string[] = [];
  return {
    sendToExtension: (payload: string) => {
      sent.push(payload);
    },
    hasAuthorizedConnection: () => connected,
    getAwaitingCommands: () => awaiting,
    persistAwaitingCommands: (commands) => {
      awaiting = commands.filter(
        (entry): entry is LegacyCommandTombstone =>
          "commandType" in entry,
      );
    },
    persistCommandTombstone: () => {},
    persistStatus: () => {},
    persistLateResult: () => {},
    sent,
  };
}

function tombstone(command: Command): LegacyCommandTombstone {
  return {
    commandId: command.commandId,
    commandType: command.type,
    requestFingerprint: "0".repeat(64),
  };
}

function send(
  coordinator: CfSessionCoordinator,
  command: Command,
): Promise<Event> {
  return coordinator.send(command, tombstone(command));
}

describe("CfSessionCoordinator", () => {
  it("resolves send() with the matching result event and clears the marker", async () => {
    // #given a coordinator and a snapshot command
    const host = createFakeHost();
    const coordinator = new CfSessionCoordinator(host);
    const cmd: Command = { type: "snapshot", commandId: "c1", mode: "a11y" };

    // #when send() is called and the matching event arrives
    const promise = send(coordinator, cmd);
    expect(host.getAwaitingCommands().map((entry) => entry.commandId)).toEqual(["c1"]);
    expect(host.sent).toEqual([JSON.stringify(cmd)]);
    const event: Event = {
      type: "snapshot_result",
      commandId: "c1",
      tree: [],
      tabId: 7,
      url: "https://example.com/",
    };
    coordinator.resolvePending(event);

    // #then the promise resolves with that event and the marker is cleared
    await expect(promise).resolves.toEqual(event);
    expect(host.getAwaitingCommands()).toEqual([]);
  });

  it("rejects with a payload-free error at timeout but retains the slot until the late result is reconciled", async () => {
    // #given a coordinator with a short per-command timeout
    vi.useFakeTimers();
    try {
      const host = createFakeHost();
      const coordinator = new CfSessionCoordinator(host, { timeoutMs: 1000 });
      const cmd: Command = { type: "click", commandId: "c2", ref: "r1" };

      // #when send() is called and no reply arrives before the timeout
      const promise = send(coordinator, cmd);
      const caught = promise.catch((err: unknown) => err);
      await vi.advanceTimersByTimeAsync(1000);
      const err = await caught;

      // #then it rejects with a payload-free error while the durable marker
      // keeps later commands out of the extension's FIFO.
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe("command timed out: c2 (click) after 1000ms");
      expect((err as Error).message).not.toContain("r1");
      expect(host.getAwaitingCommands().map((entry) => entry.commandId)).toEqual(["c2"]);

      coordinator.resolvePending({ type: "action_result", commandId: "c2", ok: true });
      expect(host.getAwaitingCommands()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects immediately when no authorized socket exists - no marker, no frame, no timer burn", async () => {
    // #given a host whose session has no live authorized extension socket
    const host = createFakeHost(false);
    const coordinator = new CfSessionCoordinator(host);
    const cmd: Command = { type: "get_tabs", commandId: "c-fast" };

    // #when send() is called
    const err = await send(coordinator, cmd).catch((e: unknown) => e);

    // #then it rejects with the route-mappable prefix before parking anything
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe(
      "session not connected: no authorized extension connection",
    );
    expect(host.getAwaitingCommands()).toEqual([]);
    expect(host.sent).toEqual([]);
  });

  it("rolls back all pending bookkeeping when the authoritative socket throws during send", async () => {
    // #given liveness passed, but the authoritative socket closes in the
    // checked-to-send window and its synchronous send throws
    vi.useFakeTimers();
    try {
      const host = createFakeHost();
      host.sendToExtension = () => {
        throw new Error("WebSocket is not open");
      };
      const coordinator = new CfSessionCoordinator(host);
      const cmd: Command = { type: "get_tabs", commandId: "c-send-race" };

      // #when the coordinator attempts delivery
      const err = await send(coordinator, cmd).catch((e: unknown) => e);

      // #then it maps to the existing not-connected family and immediately
      // clears the timer, in-memory pending entry, and persisted marker
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe(
        "session not connected: authoritative extension connection unavailable during send",
      );
      expect(host.getAwaitingCommands()).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);

      // #then the same commandId can dispatch after reconnect; no stale
      // pending-map entry trips the duplicate-in-flight guard
      host.sendToExtension = (payload: string) => {
        host.sent.push(payload);
      };
      const retry = send(coordinator, cmd);
      expect(host.sent).toEqual([JSON.stringify(cmd)]);
      coordinator.resolvePending({ type: "tabs_result", commandId: cmd.commandId, tabs: [] });
      await expect(retry).resolves.toEqual({
        type: "tabs_result",
        commandId: cmd.commandId,
        tabs: [],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("no-ops on an unknown commandId without throwing or touching the marker", () => {
    // #given a coordinator with nothing pending and an empty marker
    const host = createFakeHost();
    const coordinator = new CfSessionCoordinator(host);
    const event: Event = { type: "action_result", commandId: "ghost", ok: true };

    // #when resolvePending is called for a commandId that was never sent
    // #then it does not throw and leaves the marker untouched
    expect(() => coordinator.resolvePending(event)).not.toThrow();
    expect(host.getAwaitingCommands()).toEqual([]);
  });

  it("reconciles a late result whose marker survived a simulated hibernation, without resolving anything", () => {
    // #given a command sent by one coordinator instance, then a simulated
    // hibernation: a second CfSessionCoordinator over the SAME host stands
    // in for the DO waking with a fresh (empty) in-memory pending map while
    // the marker persisted in durable state survives (DL-007).
    vi.useFakeTimers();
    try {
      const host = createFakeHost();
      const first = new CfSessionCoordinator(host);
      const cmd: Command = { type: "get_tabs", commandId: "c3" };
      void send(first, cmd);
      expect(host.getAwaitingCommands().map((entry) => entry.commandId)).toEqual(["c3"]);

      const woken = new CfSessionCoordinator(host);
      const event: Event = { type: "tabs_result", commandId: "c3", tabs: [] };

      // #when the late result arrives at the woken (fresh) coordinator
      // #then it reconciles the marker and does not throw
      expect(() => woken.resolvePending(event)).not.toThrow();
      expect(host.getAwaitingCommands()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not log command metadata, refs, or plaintext", async () => {
    // #given a spy on console.log and two sensitive commands
    const host = createFakeHost();
    const coordinator = new CfSessionCoordinator(host);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const fillSecret: Command = {
      type: "fill_secret",
      commandId: "c4",
      ref: "s1e2",
      secretRef: "vault://super-secret-password",
    };
    const typeCmd: Command = {
      type: "type",
      commandId: "c5",
      ref: "s1e3",
      text: "hunter2-plaintext",
    };

    let second: Promise<Event> | undefined;
    try {
      // #when both commands are sent one at a time
      const first = send(coordinator, fillSecret);
      coordinator.resolvePending({ type: "action_result", commandId: "c4", ok: true });
      await first;
      second = send(coordinator, typeCmd);

      // #then command execution emits no ad hoc logs. The HTTP boundary owns
      // bounded, pseudonymized command telemetry through the shared emitter.
      expect(logSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
      coordinator.resolvePending({ type: "action_result", commandId: "c5", ok: true });
      if (second !== undefined) await second;
    }
  });

  it("abandonInFlight rejects the pending command and clears the marker", async () => {
    // #given one outstanding command
    const host = createFakeHost();
    const coordinator = new CfSessionCoordinator(host);
    const cmdA: Command = { type: "get_tabs", commandId: "c6" };
    const promiseA = send(coordinator, cmdA);
    expect(host.getAwaitingCommands().map((entry) => entry.commandId)).toEqual(["c6"]);

    // #when a fresh hello resync abandons in-flight commands
    coordinator.abandonInFlight("session resynced: hello received");

    // #then both reject with the given reason and the marker is cleared
    await expect(promiseA).rejects.toThrow("session resynced: hello received");
    expect(host.getAwaitingCommands()).toEqual([]);
  });

  it("refuses a distinct command while another command owns the session slot", async () => {
    const host = createFakeHost();
    const coordinator = new CfSessionCoordinator(host);
    const firstCommand: Command = { type: "get_tabs", commandId: "c-busy-a" };
    const first = send(coordinator, firstCommand);

    await expect(
      send(coordinator, {
        type: "snapshot",
        commandId: "c-busy-b",
        mode: "a11y",
      }),
    ).rejects.toThrow("session busy: another command owns the session slot");
    expect(host.sent).toHaveLength(1);

    coordinator.resolvePending({ type: "tabs_result", commandId: "c-busy-a", tabs: [] });
    await first;
  });

  it("refuses a second send for a commandId already in flight, leaving the first undisturbed", async () => {
    // #given a command parked and awaiting its event
    const host = createFakeHost();
    const coordinator = new CfSessionCoordinator(host);
    const cmd: Command = { type: "click", commandId: "c-dup", ref: "r1" };
    const first = send(coordinator, cmd);

    // #when the same commandId is sent again mid-flight (stable consumer-
    // derived ids make this reachable)
    const err = await send(coordinator, cmd).catch((e: unknown) => e);

    // #then the duplicate is refused with the mappable prefix, nothing extra
    // hit the wire, and the original still resolves normally
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("duplicate command in flight: c-dup is already awaiting its event");
    expect(host.sent).toHaveLength(1);

    const event: Event = { type: "action_result", commandId: "c-dup", ok: true };
    coordinator.resolvePending(event);
    await expect(first).resolves.toEqual(event);
    expect(host.getAwaitingCommands()).toEqual([]);
  });
});
