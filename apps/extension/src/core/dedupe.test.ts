import { describe, it, expect } from "vitest";
import type { Command, Event } from "@understudy/protocol";
import { WriteDedupe, type SessionStorageArea } from "./dedupe";

function fakeStorage(): SessionStorageArea & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: async (key) => (data.has(key) ? { [key]: data.get(key) } : {}),
    set: async (items) => {
      for (const [key, value] of Object.entries(items)) data.set(key, value);
    },
    remove: async (key) => {
      data.delete(key);
    },
  };
}

const CLICK: Command = { type: "click", commandId: "ik_case1:step1:click", ref: "s1e1" };
const CLICK_RESULT: Event = { type: "action_result", commandId: "ik_case1:step1:click", ok: true };

describe("WriteDedupe.claim", () => {
  it("returns execute for a fresh write and marks it in-flight", async () => {
    // #given a fresh dedupe
    const dedupe = new WriteDedupe(fakeStorage());

    // #when a write is claimed
    const first = await dedupe.claim(CLICK);

    // #then it executes, and a concurrent duplicate is now dropped (in-flight)
    expect(first).toEqual({ kind: "execute" });
    expect(await dedupe.claim(CLICK)).toEqual({ kind: "drop" });
  });

  it("drops a duplicate while the original is still in-flight (the timeout race)", async () => {
    // #given a claimed-but-not-yet-remembered write (still executing)
    const dedupe = new WriteDedupe(fakeStorage());
    expect(await dedupe.claim(CLICK)).toEqual({ kind: "execute" });

    // #when the same commandId is claimed again (service timed out, consumer retried)
    // #then the duplicate is dropped - it must NOT execute a second time
    expect(await dedupe.claim(CLICK)).toEqual({ kind: "drop" });
  });

  it("resolves two concurrent claims for one commandId to exactly one execute", async () => {
    // #given two claims issued before either resolves (both racing the first hydrate)
    const dedupe = new WriteDedupe(fakeStorage());
    const [a, b] = await Promise.all([dedupe.claim(CLICK), dedupe.claim(CLICK)]);

    // #then exactly one is told to execute and the other is dropped
    expect([a.kind, b.kind].sort()).toEqual(["drop", "execute"]);
  });

  it("replays a recorded write after it completes", async () => {
    // #given a write that executed and was remembered
    const dedupe = new WriteDedupe(fakeStorage());
    await dedupe.claim(CLICK);
    await dedupe.remember(CLICK, CLICK_RESULT);

    // #when the same commandId arrives again
    // #then the recorded Event is replayed, not re-executed
    expect(await dedupe.claim(CLICK)).toEqual({ kind: "replay", event: CLICK_RESULT });
  });

  it("re-executes after a release without a record (a failed/aborted execution)", async () => {
    // #given a claimed write whose execution was released without recording
    const dedupe = new WriteDedupe(fakeStorage());
    await dedupe.claim(CLICK);
    dedupe.release(CLICK);

    // #then the same commandId is claimable again (the execution never happened)
    expect(await dedupe.claim(CLICK)).toEqual({ kind: "execute" });
  });

  it("never tracks reads - they always execute", async () => {
    // #given a read command
    const dedupe = new WriteDedupe(fakeStorage());
    const read: Command = { type: "get_tabs", commandId: "r1" };

    // #then it executes, and even a repeat executes (reads re-run freely)
    expect(await dedupe.claim(read)).toEqual({ kind: "execute" });
    await dedupe.remember(read, { type: "tabs_result", commandId: "r1", tabs: [] });
    expect(await dedupe.claim(read)).toEqual({ kind: "execute" });
  });

  it("tracks scroll and switch_tab as writes (protocol reclassified them)", async () => {
    // #given a scroll claimed and completed
    const dedupe = new WriteDedupe(fakeStorage());
    const scroll: Command = { type: "scroll", commandId: "ik_s:scroll", dy: 120 };
    const scrollResult: Event = { type: "action_result", commandId: "ik_s:scroll", ok: true };
    await dedupe.claim(scroll);
    await dedupe.remember(scroll, scrollResult);

    // #then a retry replays instead of double-scrolling (relative dy)
    expect(await dedupe.claim(scroll)).toEqual({ kind: "replay", event: scrollResult });
  });
});

describe("WriteDedupe persistence + lifecycle", () => {
  it("survives a service-worker eviction via storage.session", async () => {
    // #given a result recorded by one SW life
    const storage = fakeStorage();
    const first = new WriteDedupe(storage);
    await first.claim(CLICK);
    await first.remember(CLICK, CLICK_RESULT);

    // #when the SW is evicted and a fresh instance hydrates from storage
    const revived = new WriteDedupe(storage);

    // #then the recorded result still replays
    expect(await revived.claim(CLICK)).toEqual({ kind: "replay", event: CLICK_RESULT });
  });

  it("clear() drops the record so a new session cannot replay the old one's writes", async () => {
    // #given a recorded write and a session change
    const storage = fakeStorage();
    const dedupe = new WriteDedupe(storage);
    await dedupe.claim(CLICK);
    await dedupe.remember(CLICK, CLICK_RESULT);

    // #when the WS target session changes
    await dedupe.clear();

    // #then the commandId is fresh again (memory AND the storage mirror cleared)
    expect(await dedupe.claim(CLICK)).toEqual({ kind: "execute" });
    expect(await new WriteDedupe(storage).claim(CLICK)).toEqual({ kind: "execute" });
  });

  it("does NOT record a straggler whose session changed (clear) mid-execution", async () => {
    // #given a write claimed under the old session, still executing when the
    // WS target session changes (setWsUrl calls clear())
    const dedupe = new WriteDedupe(fakeStorage());
    expect(await dedupe.claim(CLICK)).toEqual({ kind: "execute" });
    await dedupe.clear();

    // #when the old execution finishes and tries to record its result
    await dedupe.remember(CLICK, CLICK_RESULT);

    // #then nothing is recorded into the new session's record - a reused
    // commandId in the new session executes fresh, never replaying the
    // old session's foreign Event
    expect(await dedupe.claim(CLICK)).toEqual({ kind: "execute" });
  });

  it("evicts the oldest entries beyond the cap (100)", async () => {
    // #given 101 distinct writes claimed + recorded (cap is 100)
    const dedupe = new WriteDedupe(fakeStorage());
    for (let i = 0; i <= 100; i++) {
      const cmd: Command = { type: "click", commandId: `w${i}`, ref: "s1e1" };
      await dedupe.claim(cmd);
      await dedupe.remember(cmd, { type: "action_result", commandId: `w${i}`, ok: true });
    }

    // #then the oldest fell out and the newest remains
    expect(await dedupe.claim({ type: "click", commandId: "w0", ref: "s1e1" })).toEqual({
      kind: "execute",
    });
    expect(await dedupe.claim({ type: "click", commandId: "w100", ref: "s1e1" })).toMatchObject({
      kind: "replay",
    });
  });

  it("treats a broken storage read as an empty record set (fail open to re-execution)", async () => {
    // #given storage that throws on read
    const dedupe = new WriteDedupe({
      get: async () => {
        throw new Error("storage unavailable");
      },
      set: async () => {},
      remove: async () => {},
    });

    // #then claims execute (re-execution - the pre-dedupe behavior) instead of throwing
    expect(await dedupe.claim(CLICK)).toEqual({ kind: "execute" });
  });
});
