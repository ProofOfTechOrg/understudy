import { describe, it, expect, vi } from "vitest";
import { CfSessionCoordinator, type CoordinatorHost } from "../src/coordinator-cf";
import type { Command, Event } from "@understudy/protocol";

function createFakeHost(connected = true): CoordinatorHost & { sent: string[] } {
  let awaiting: string[] = [];
  const sent: string[] = [];
  return {
    sendToExtension: (payload: string) => {
      sent.push(payload);
    },
    hasAuthorizedConnection: () => connected,
    getAwaitingCommandIds: () => awaiting,
    persistAwaitingCommandIds: (ids: string[]) => {
      awaiting = ids;
    },
    persistStatus: () => {},
    sent,
  };
}

describe("CfSessionCoordinator", () => {
  it("resolves send() with the matching result event and clears the marker", async () => {
    // #given a coordinator and a snapshot command
    const host = createFakeHost();
    const coordinator = new CfSessionCoordinator(host);
    const cmd: Command = { type: "snapshot", commandId: "c1", mode: "a11y" };

    // #when send() is called and the matching event arrives
    const promise = coordinator.send(cmd);
    expect(host.getAwaitingCommandIds()).toEqual(["c1"]);
    expect(host.sent).toEqual([JSON.stringify(cmd)]);
    const event: Event = { type: "snapshot_result", commandId: "c1", tree: [] };
    coordinator.resolvePending(event);

    // #then the promise resolves with that event and the marker is cleared
    await expect(promise).resolves.toEqual(event);
    expect(host.getAwaitingCommandIds()).toEqual([]);
  });

  it("rejects with a payload-free error when the per-command timeout fires, and clears the marker", async () => {
    // #given a coordinator with a short per-command timeout
    vi.useFakeTimers();
    try {
      const host = createFakeHost();
      const coordinator = new CfSessionCoordinator(host, { timeoutMs: 1000 });
      const cmd: Command = { type: "click", commandId: "c2", ref: "r1" };

      // #when send() is called and no reply arrives before the timeout
      const promise = coordinator.send(cmd);
      const caught = promise.catch((err: unknown) => err);
      await vi.advanceTimersByTimeAsync(1000);
      const err = await caught;

      // #then it rejects with a payload-free error and the marker is cleared
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe("command timed out: c2 (click) after 1000ms");
      expect((err as Error).message).not.toContain("r1");
      expect(host.getAwaitingCommandIds()).toEqual([]);
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
    const err = await coordinator.send(cmd).catch((e: unknown) => e);

    // #then it rejects with the route-mappable prefix before parking anything
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe(
      "session not connected: no authorized extension connection",
    );
    expect(host.getAwaitingCommandIds()).toEqual([]);
    expect(host.sent).toEqual([]);
  });

  it("no-ops on an unknown commandId without throwing or touching the marker", () => {
    // #given a coordinator with nothing pending and an empty marker
    const host = createFakeHost();
    const coordinator = new CfSessionCoordinator(host);
    const event: Event = { type: "action_result", commandId: "ghost", ok: true };

    // #when resolvePending is called for a commandId that was never sent
    // #then it does not throw and leaves the marker untouched
    expect(() => coordinator.resolvePending(event)).not.toThrow();
    expect(host.getAwaitingCommandIds()).toEqual([]);
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
      void first.send(cmd);
      expect(host.getAwaitingCommandIds()).toEqual(["c3"]);

      const woken = new CfSessionCoordinator(host);
      const event: Event = { type: "tabs_result", commandId: "c3", tabs: [] };

      // #when the late result arrives at the woken (fresh) coordinator
      // #then it reconciles the marker and does not throw
      expect(() => woken.resolvePending(event)).not.toThrow();
      expect(host.getAwaitingCommandIds()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("logs only commandId and type - never a fill_secret's secretRef or a type command's plaintext", () => {
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

    try {
      // #when both commands are sent
      void coordinator.send(fillSecret);
      void coordinator.send(typeCmd);

      // #then every logged call carries exactly {commandId, type} - never ref/secretRef/text
      const loggedMetadata = logSpy.mock.calls.map((call) => call[1]);
      expect(loggedMetadata).toContainEqual({ commandId: "c4", type: "fill_secret" });
      expect(loggedMetadata).toContainEqual({ commandId: "c5", type: "type" });

      const serializedCalls = JSON.stringify(logSpy.mock.calls);
      expect(serializedCalls).not.toContain("vault://super-secret-password");
      expect(serializedCalls).not.toContain("hunter2-plaintext");
      expect(serializedCalls).not.toContain("s1e2");
      expect(serializedCalls).not.toContain("s1e3");
    } finally {
      logSpy.mockRestore();
      coordinator.resolvePending({ type: "action_result", commandId: "c4", ok: true });
      coordinator.resolvePending({ type: "action_result", commandId: "c5", ok: true });
    }
  });

  it("abandonInFlight rejects every pending command and clears the marker", async () => {
    // #given two outstanding commands
    const host = createFakeHost();
    const coordinator = new CfSessionCoordinator(host);
    const cmdA: Command = { type: "get_tabs", commandId: "c6" };
    const cmdB: Command = { type: "snapshot", commandId: "c7", mode: "dom" };
    const promiseA = coordinator.send(cmdA);
    const promiseB = coordinator.send(cmdB);
    expect(host.getAwaitingCommandIds()).toEqual(["c6", "c7"]);

    // #when a fresh hello resync abandons in-flight commands
    coordinator.abandonInFlight("session resynced: hello received");

    // #then both reject with the given reason and the marker is cleared
    await expect(promiseA).rejects.toThrow("session resynced: hello received");
    await expect(promiseB).rejects.toThrow("session resynced: hello received");
    expect(host.getAwaitingCommandIds()).toEqual([]);
  });
});
