import { describe, it, expect, vi, afterEach } from "vitest";
import { CdpSession } from "./cdp";

// Only the storage surface CdpSession.create touches; resolveRefCheck itself
// must never reach the debugger or storage.
function stubBrowserStorage(): void {
  vi.stubGlobal("browser", {
    storage: {
      session: {
        get: vi.fn().mockResolvedValue({}),
        set: vi.fn().mockResolvedValue(undefined),
      },
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// Regression guard for the M3 dry-run bug: the service's ref probe used a
// snapshot, which bumps the generation and re-mints every ref - so the probe
// could never see the consumer's ref AND it invalidated all outstanding refs.
// resolveRefCheck must stay a pure ref-map lookup with no generation bump.
describe("CdpSession.resolveRefCheck", () => {
  it("answers ok:true from the live ref map without bumping the generation", async () => {
    // #given a session whose current generation holds the ref
    stubBrowserStorage();
    const session = await CdpSession.create(1);
    session.refMap = new Map([["s0e1", 42]]);
    const generationBefore = session.generation;

    // #when the ref is probed
    const event = await session.resolveRefCheck("c1", "s0e1");

    // #then it resolves ok and the generation is untouched (probing must not
    // invalidate the consumer's outstanding refs)
    expect(event).toEqual({ type: "action_result", commandId: "c1", ok: true });
    expect(session.generation).toBe(generationBefore);
  });

  it("answers ok:false for a stale-generation ref without bumping the generation", async () => {
    // #given a session that has never seen this ref's generation
    stubBrowserStorage();
    const session = await CdpSession.create(1);
    session.refMap = new Map([["s0e1", 42]]);
    const generationBefore = session.generation;

    // #when a ref from another generation is probed
    const event = await session.resolveRefCheck("c2", "s9e9");

    // #then it reports stale without side effects
    expect(event).toEqual({
      type: "action_result",
      commandId: "c2",
      ok: false,
      error: "stale or unknown ref: s9e9",
    });
    expect(session.generation).toBe(generationBefore);
  });

  it("answers ok:false for a current-generation ref absent from the map", async () => {
    // #given a session whose current generation does not contain this ref
    stubBrowserStorage();
    const session = await CdpSession.create(1);
    session.refMap = new Map([["s0e1", 42]]);

    // #when a right-generation but unknown ref is probed
    const event = await session.resolveRefCheck("c3", "s0e9");

    // #then it reports stale
    expect(event).toEqual({
      type: "action_result",
      commandId: "c3",
      ok: false,
      error: "stale or unknown ref: s0e9",
    });
  });

  it("rides the FIFO queue: a probe behind an in-flight snapshot observes its generation bump", async () => {
    // #given a snapshot occupying the FIFO queue, its AX-tree fetch not yet
    // resolved, and a ref that is valid in the CURRENT (pre-bump) generation
    let releaseTree!: (value: { nodes: unknown[] }) => void;
    const sendCommand = vi.fn().mockImplementation((_target, method: string) => {
      if (method === "Accessibility.getFullAXTree") {
        return new Promise((resolve) => {
          releaseTree = resolve;
        });
      }
      return Promise.resolve({});
    });
    vi.stubGlobal("browser", {
      storage: {
        session: {
          get: vi.fn().mockResolvedValue({}),
          set: vi.fn().mockResolvedValue(undefined),
        },
      },
      debugger: { sendCommand },
    });
    const session = await CdpSession.create(1);
    session.refMap = new Map([["s0e1", 42]]);
    const snapshotPromise = session.snapshotA11y("c-snap");

    // #when a probe for the pre-bump ref is enqueued behind the snapshot,
    // which then completes (bumping to generation 1 and re-minting refs)
    const probePromise = session.resolveRefCheck("c-probe", "s0e1");
    // The queued snapshot body starts on a microtask; wait until it has
    // actually issued the AX-tree fetch before releasing it.
    await vi.waitFor(() => {
      expect(
        sendCommand.mock.calls.some((call) => call[1] === "Accessibility.getFullAXTree"),
      ).toBe(true);
    });
    releaseTree({ nodes: [] });
    await snapshotPromise;

    // #then the probe answered AFTER the bump - stale, exactly what the next
    // real command would see (an off-queue probe would have answered ok:true
    // from the pre-bump map, lying about the ref's future)
    expect(await probePromise).toEqual({
      type: "action_result",
      commandId: "c-probe",
      ok: false,
      error: "stale or unknown ref: s0e1",
    });
  });
});
