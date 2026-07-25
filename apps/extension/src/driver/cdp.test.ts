import { describe, it, expect, vi, afterEach } from "vitest";
import { CdpSession } from "./cdp";

const TEST_SCOPE = "test";
const testRef = (generation: number, sequence: number): string =>
  `a${TEST_SCOPE}:s${generation}e${sequence}`;
const ACTIONABLE_AX_TREE = [
  {
    nodeId: "root",
    ignored: false,
    role: { type: "role", value: "RootWebArea" },
    childIds: ["button"],
  },
  {
    nodeId: "button",
    ignored: false,
    role: { type: "role", value: "button" },
    backendDOMNodeId: 42,
  },
];

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

function stubActionBrowser(): ReturnType<typeof vi.fn> {
  const sendCommand = vi.fn().mockResolvedValue({});
  vi.stubGlobal("browser", {
    storage: {
      session: {
        get: vi.fn().mockResolvedValue({}),
        set: vi.fn().mockResolvedValue(undefined),
      },
    },
    debugger: { sendCommand },
  });
  return sendCommand;
}

afterEach(() => {
  vi.useRealTimers();
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
    const session = await CdpSession.create(1, TEST_SCOPE);
    session.refMap = new Map([[testRef(0, 1), 42]]);
    const generationBefore = session.generation;

    // #when the ref is probed
    const event = await session.resolveRefCheck("c1", testRef(0, 1));

    // #then it resolves ok and the generation is untouched (probing must not
    // invalidate the consumer's outstanding refs)
    expect(event).toEqual({ type: "action_result", commandId: "c1", ok: true });
    expect(session.generation).toBe(generationBefore);
  });

  it("answers ok:false for a stale-generation ref without bumping the generation", async () => {
    // #given a session that has never seen this ref's generation
    stubBrowserStorage();
    const session = await CdpSession.create(1, TEST_SCOPE);
    session.refMap = new Map([[testRef(0, 1), 42]]);
    const generationBefore = session.generation;

    // #when a ref from another generation is probed
    const event = await session.resolveRefCheck("c2", testRef(9, 9));

    // #then it reports stale without side effects
    expect(event).toEqual({
      type: "action_result",
      commandId: "c2",
      ok: false,
      error: `stale or unknown ref: ${testRef(9, 9)}`,
    });
    expect(session.generation).toBe(generationBefore);
  });

  it("answers ok:false for a current-generation ref absent from the map", async () => {
    // #given a session whose current generation does not contain this ref
    stubBrowserStorage();
    const session = await CdpSession.create(1, TEST_SCOPE);
    session.refMap = new Map([[testRef(0, 1), 42]]);

    // #when a right-generation but unknown ref is probed
    const event = await session.resolveRefCheck("c3", testRef(0, 9));

    // #then it reports stale
    expect(event).toEqual({
      type: "action_result",
      commandId: "c3",
      ok: false,
      error: `stale or unknown ref: ${testRef(0, 9)}`,
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
      if (method === "Page.getFrameTree") {
        return Promise.resolve({
          frameTree: {
            frame: { id: "frame-1", loaderId: "loader-1", url: "https://example.com/" },
          },
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
    const session = await CdpSession.create(1, TEST_SCOPE);
    session.refMap = new Map([[testRef(0, 1), 42]]);
    const snapshotPromise = session.snapshotA11y("c-snap");

    // #when a probe for the pre-bump ref is enqueued behind the snapshot,
    // which then completes (bumping to generation 1 and re-minting refs)
    const probePromise = session.resolveRefCheck("c-probe", testRef(0, 1));
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
      error: `stale or unknown ref: ${testRef(0, 1)}`,
    });
  });
});

describe("CdpSession keyboard dispatch", () => {
  it("submits typed text with Enter's carriage-return key event", async () => {
    const sendCommand = stubActionBrowser();
    const session = await CdpSession.create(7, TEST_SCOPE);
    session.refMap = new Map([[testRef(0, 1), 42]]);

    await expect(session.type("c-submit", testRef(0, 1), "secret", true)).resolves.toEqual({
      type: "action_result",
      commandId: "c-submit",
      ok: true,
    });

    expect(sendCommand.mock.calls).toEqual([
      [{ tabId: 7 }, "DOM.focus", { backendNodeId: 42 }],
      [{ tabId: 7 }, "Input.insertText", { text: "secret" }],
      [
        { tabId: 7 },
        "Input.dispatchKeyEvent",
        {
          type: "keyDown",
          modifiers: 0,
          key: "Enter",
          code: "Enter",
          windowsVirtualKeyCode: 13,
          text: "\r",
          unmodifiedText: "\r",
        },
      ],
      [
        { tabId: 7 },
        "Input.dispatchKeyEvent",
        {
          type: "keyUp",
          modifiers: 0,
          key: "Enter",
          code: "Enter",
          windowsVirtualKeyCode: 13,
        },
      ],
    ]);
  });

  it("does not dispatch a key event when type submit is false", async () => {
    const sendCommand = stubActionBrowser();
    const session = await CdpSession.create(7, TEST_SCOPE);
    session.refMap = new Map([[testRef(0, 1), 42]]);

    await session.type("c-no-submit", testRef(0, 1), "plain text", false);

    expect(sendCommand.mock.calls.map((call) => call[1])).toEqual([
      "DOM.focus",
      "Input.insertText",
    ]);
  });

  it("uses the same Enter payload for the explicit key command", async () => {
    const sendCommand = stubActionBrowser();
    const session = await CdpSession.create(7, TEST_SCOPE);
    session.refMap = new Map([[testRef(0, 1), 42]]);

    await session.key("c-enter", "Enter", testRef(0, 1));

    expect(sendCommand.mock.calls.slice(1)).toEqual([
      [
        { tabId: 7 },
        "Input.dispatchKeyEvent",
        {
          type: "keyDown",
          modifiers: 0,
          key: "Enter",
          code: "Enter",
          windowsVirtualKeyCode: 13,
          text: "\r",
          unmodifiedText: "\r",
        },
      ],
      [
        { tabId: 7 },
        "Input.dispatchKeyEvent",
        {
          type: "keyUp",
          modifiers: 0,
          key: "Enter",
          code: "Enter",
          windowsVirtualKeyCode: 13,
        },
      ],
    ]);
  });

  it("uses rawKeyDown for keys without text", async () => {
    const sendCommand = stubActionBrowser();
    const session = await CdpSession.create(7, TEST_SCOPE);

    await session.key("c-escape", "Escape");

    expect(sendCommand.mock.calls[0]).toEqual([
      { tabId: 7 },
      "Input.dispatchKeyEvent",
      {
        type: "rawKeyDown",
        modifiers: 0,
        key: "Escape",
        code: "Escape",
        windowsVirtualKeyCode: 27,
      },
    ]);
  });
});

describe("CdpSession snapshot target identity", () => {
  function stubSnapshotBrowser(
    sendCommand: ReturnType<typeof vi.fn>,
  ): ReturnType<typeof vi.fn> {
    const storageSet = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("browser", {
      storage: {
        session: {
          get: vi.fn().mockResolvedValue({}),
          set: storageSet,
        },
      },
      debugger: { sendCommand },
    });
    return storageSet;
  }

  it("returns the attached tab and bracketed main-frame URL with an accessibility snapshot", async () => {
    const sendCommand = vi.fn().mockImplementation((_target, method: string) => {
      if (method === "Page.getFrameTree") {
        return Promise.resolve({
          frameTree: {
            frame: {
              id: "frame-1",
              loaderId: "loader-1",
              url: "https://example.com/about",
              urlFragment: "#details",
            },
          },
        });
      }
      if (method === "Accessibility.getFullAXTree") return Promise.resolve({ nodes: [] });
      return Promise.resolve({});
    });
    stubSnapshotBrowser(sendCommand);
    const session = await CdpSession.create(7, TEST_SCOPE);

    const event = await session.snapshotA11y("c-snapshot");

    expect(event).toEqual({
      type: "snapshot_result",
      commandId: "c-snapshot",
      tree: [],
      tabId: 7,
      url: "https://example.com/about#details",
    });
    expect(sendCommand.mock.calls.map((call) => call[1])).toEqual([
      "Page.getFrameTree",
      "Accessibility.getFullAXTree",
      "Page.getFrameTree",
    ]);
  });

  it("fails closed when the attached page redirects while its tree is captured", async () => {
    let frameReads = 0;
    const sendCommand = vi.fn().mockImplementation((_target, method: string) => {
      if (method === "Page.getFrameTree") {
        frameReads += 1;
        return Promise.resolve({
          frameTree: {
            frame: {
              id: "frame-1",
              loaderId: `loader-${frameReads}`,
              url:
                frameReads === 1
                  ? "https://example.com/"
                  : "https://evil.example/redirected",
            },
          },
        });
      }
      if (method === "Accessibility.getFullAXTree") return Promise.resolve({ nodes: [] });
      return Promise.resolve({});
    });
    stubSnapshotBrowser(sendCommand);
    const session = await CdpSession.create(7, TEST_SCOPE);
    session.refMap = new Map([[testRef(0, 1), 42]]);

    const event = await session.snapshotA11y("c-redirect");

    expect(event).toEqual({
      type: "action_result",
      commandId: "c-redirect",
      ok: false,
      error: "page changed during snapshot",
    });
    expect(session.refMap.size).toBe(0);
    expect(session.generation).toBe(1);
  });

  it("fails closed when only the main-frame URL fragment changes during capture", async () => {
    let frameReads = 0;
    const sendCommand = vi.fn().mockImplementation((_target, method: string) => {
      if (method === "Page.getFrameTree") {
        frameReads += 1;
        return Promise.resolve({
          frameTree: {
            frame: {
              id: "frame-1",
              loaderId: "loader-1",
              url: "https://example.com/",
              urlFragment: frameReads === 1 ? "#before" : "#after",
            },
          },
        });
      }
      if (method === "Accessibility.getFullAXTree") return Promise.resolve({ nodes: [] });
      return Promise.resolve({});
    });
    stubSnapshotBrowser(sendCommand);
    const session = await CdpSession.create(7, TEST_SCOPE);

    await expect(session.snapshotA11y("c-fragment")).resolves.toEqual({
      type: "action_result",
      commandId: "c-fragment",
      ok: false,
      error: "page changed during snapshot",
    });
    expect(session.generation).toBe(1);
  });

  it("fails closed when the main document changes at the same URL before its event arrives", async () => {
    let frameReads = 0;
    const sendCommand = vi.fn().mockImplementation((_target, method: string) => {
      if (method === "Page.getFrameTree") {
        frameReads += 1;
        return Promise.resolve({
          frameTree: {
            frame: {
              id: "frame-1",
              loaderId: `loader-${frameReads}`,
              url: "https://example.com/",
            },
          },
        });
      }
      if (method === "Accessibility.getFullAXTree") return Promise.resolve({ nodes: [] });
      return Promise.resolve({});
    });
    stubSnapshotBrowser(sendCommand);
    const session = await CdpSession.create(7, TEST_SCOPE);

    await expect(session.snapshotA11y("c-loader")).resolves.toEqual({
      type: "action_result",
      commandId: "c-loader",
      ok: false,
      error: "page changed during snapshot",
    });
  });

  it("fails closed when the document generation changes at the same URL during capture", async () => {
    let releaseTree!: (value: { nodes: unknown[] }) => void;
    const sendCommand = vi.fn().mockImplementation((_target, method: string) => {
      if (method === "Page.getFrameTree") {
        return Promise.resolve({
          frameTree: {
            frame: { id: "frame-1", loaderId: "loader-1", url: "https://example.com/" },
          },
        });
      }
      if (method === "Accessibility.getFullAXTree") {
        return new Promise((resolve) => {
          releaseTree = resolve;
        });
      }
      return Promise.resolve({});
    });
    stubSnapshotBrowser(sendCommand);
    const session = await CdpSession.create(7, TEST_SCOPE);
    const snapshot = session.snapshotA11y("c-generation");
    await vi.waitFor(() => {
      expect(
        sendCommand.mock.calls.some((call) => call[1] === "Accessibility.getFullAXTree"),
      ).toBe(true);
    });

    await session.bumpGeneration();
    releaseTree({ nodes: [] });

    await expect(snapshot).resolves.toEqual({
      type: "action_result",
      commandId: "c-generation",
      ok: false,
      error: "page changed during snapshot",
    });
  });

  it("invalidates prior refs when the artifact capture fails before the closing identity read", async () => {
    const sendCommand = vi.fn().mockImplementation((_target, method: string) => {
      if (method === "Page.getFrameTree") {
        return Promise.resolve({
          frameTree: {
            frame: { id: "frame-1", loaderId: "loader-1", url: "https://example.com/" },
          },
        });
      }
      if (method === "Accessibility.getFullAXTree") {
        return Promise.reject(new Error("AX capture failed"));
      }
      return Promise.resolve({});
    });
    stubSnapshotBrowser(sendCommand);
    const session = await CdpSession.create(7, TEST_SCOPE);
    session.refMap = new Map([[testRef(0, 1), 42]]);

    await expect(session.snapshotA11y("c-capture-failed")).resolves.toEqual({
      type: "action_result",
      commandId: "c-capture-failed",
      ok: false,
      error: "AX capture failed",
    });
    expect(session.refMap.size).toBe(0);
    expect(session.generation).toBe(1);
  });

  it("invalidates prior refs when the closing identity read fails", async () => {
    let frameReads = 0;
    const sendCommand = vi.fn().mockImplementation((_target, method: string) => {
      if (method === "Page.getFrameTree") {
        frameReads += 1;
        if (frameReads === 2) return Promise.reject(new Error("identity read failed"));
        return Promise.resolve({
          frameTree: {
            frame: { id: "frame-1", loaderId: "loader-1", url: "https://example.com/" },
          },
        });
      }
      if (method === "Accessibility.getFullAXTree") return Promise.resolve({ nodes: [] });
      return Promise.resolve({});
    });
    stubSnapshotBrowser(sendCommand);
    const session = await CdpSession.create(7, TEST_SCOPE);
    session.refMap = new Map([[testRef(0, 1), 42]]);

    await expect(session.snapshotA11y("c-identity-failed")).resolves.toEqual({
      type: "action_result",
      commandId: "c-identity-failed",
      ok: false,
      error: "identity read failed",
    });
    expect(session.refMap.size).toBe(0);
    expect(session.generation).toBe(1);
  });

  it("does not publish refs when generation changes while the snapshot generation persists", async () => {
    let releaseFirstWrite!: () => void;
    let storageWrites = 0;
    const sendCommand = vi.fn().mockImplementation((_target, method: string) => {
      if (method === "Page.getFrameTree") {
        return Promise.resolve({
          frameTree: {
            frame: { id: "frame-1", loaderId: "loader-1", url: "https://example.com/" },
          },
        });
      }
      if (method === "Accessibility.getFullAXTree") {
        return Promise.resolve({ nodes: ACTIONABLE_AX_TREE });
      }
      return Promise.resolve({});
    });
    vi.stubGlobal("browser", {
      storage: {
        session: {
          get: vi.fn().mockResolvedValue({}),
          set: vi.fn().mockImplementation(() => {
            storageWrites += 1;
            if (storageWrites !== 1) return Promise.resolve();
            return new Promise<void>((resolve) => {
              releaseFirstWrite = resolve;
            });
          }),
        },
      },
      debugger: { sendCommand },
    });
    const session = await CdpSession.create(7, TEST_SCOPE);
    const snapshot = session.snapshotA11y("c-persist-race");
    await vi.waitFor(() => {
      expect(storageWrites).toBe(1);
    });

    const navigationBump = session.bumpGeneration();
    releaseFirstWrite();

    await expect(snapshot).resolves.toEqual({
      type: "action_result",
      commandId: "c-persist-race",
      ok: false,
      error: "page changed during snapshot",
    });
    await navigationBump;
    expect(session.refMap.size).toBe(0);
    expect(session.generation).toBe(2);
  });

  it("applies one 25s deadline across sequential identity, capture, persistence, and identity work", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const sendCommand = vi.fn().mockImplementation((_target, method: string) => {
      calls += 1;
      const call = calls;
      return new Promise((resolve, reject) => {
        setTimeout(() => {
          if (call === 3) {
            reject(new Error("late closing identity failure"));
            return;
          }
          if (method === "Page.getFrameTree") {
            resolve({
              frameTree: {
                frame: {
                  id: "frame-1",
                  loaderId: "loader-1",
                  url: "https://example.com/",
                },
              },
            });
            return;
          }
          resolve({ nodes: ACTIONABLE_AX_TREE });
        }, 10_000);
      });
    });
    stubSnapshotBrowser(sendCommand);
    const session = await CdpSession.create(7, TEST_SCOPE);
    session.refMap = new Map([[testRef(0, 1), 42]]);
    const snapshot = session.snapshotA11y("c-aggregate-timeout");

    await vi.advanceTimersByTimeAsync(25_000);

    await expect(snapshot).resolves.toEqual({
      type: "action_result",
      commandId: "c-aggregate-timeout",
      ok: false,
      error: "snapshot timed out after 25000ms",
    });
    expect(sendCommand.mock.calls.map((call) => call[1])).toEqual([
      "Page.getFrameTree",
      "Accessibility.getFullAXTree",
      "Page.getFrameTree",
    ]);
    expect(session.refMap.size).toBe(0);

    // Let the losing browser promise reject after the aggregate race. Vitest
    // treats an unhandled rejection as a test failure.
    await vi.advanceTimersByTimeAsync(5_000);
  });

  it("spends the snapshot deadline while waiting in the CDP FIFO and never starts an expired capture", async () => {
    vi.useFakeTimers();
    const sendCommand = vi.fn();
    stubSnapshotBrowser(sendCommand);
    const session = await CdpSession.create(7, TEST_SCOPE);
    const earlier = session.wait("c-earlier", "ms", 30_000);
    const snapshot = session.snapshotA11y("c-queued-timeout");

    await vi.advanceTimersByTimeAsync(25_000);

    await expect(snapshot).resolves.toEqual({
      type: "action_result",
      commandId: "c-queued-timeout",
      ok: false,
      error: "snapshot timed out after 25000ms",
    });
    expect(sendCommand).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);
    await earlier;
    await Promise.resolve();
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it("binds screenshots to the same attached target identity", async () => {
    const sendCommand = vi.fn().mockImplementation((_target, method: string) => {
      if (method === "Page.getFrameTree") {
        return Promise.resolve({
          frameTree: {
            frame: { id: "frame-1", loaderId: "loader-1", url: "https://example.com/" },
          },
        });
      }
      if (method === "Page.captureScreenshot") return Promise.resolve({ data: "QQ==" });
      return Promise.resolve({});
    });
    stubSnapshotBrowser(sendCommand);
    const session = await CdpSession.create(9, TEST_SCOPE);

    await expect(session.screenshot("c-shot")).resolves.toEqual({
      type: "screenshot_result",
      commandId: "c-shot",
      mime: "image/png",
      b64: "QQ==",
      tabId: 9,
      url: "https://example.com/",
    });
  });
});

describe("CdpSession ref target binding", () => {
  function stubActionableSnapshotBrowser(): void {
    vi.stubGlobal("browser", {
      storage: {
        session: {
          get: vi.fn().mockResolvedValue({}),
          set: vi.fn().mockResolvedValue(undefined),
        },
      },
      debugger: {
        sendCommand: vi.fn().mockImplementation((_target, method: string) => {
          if (method === "Page.getFrameTree") {
            return Promise.resolve({
              frameTree: {
                frame: {
                  id: "frame-1",
                  loaderId: "loader-1",
                  url: "https://example.com/",
                },
              },
            });
          }
          if (method === "Accessibility.getFullAXTree") {
            return Promise.resolve({ nodes: ACTIONABLE_AX_TREE });
          }
          return Promise.resolve({});
        }),
      },
    });
  }

  it("does not resolve a same-generation ref minted by another attachment", async () => {
    stubActionableSnapshotBrowser();
    const first = await CdpSession.create(7, "attachment-a");
    const second = await CdpSession.create(8, "attachment-b");
    const firstEvent = await first.snapshotA11y("c-first");
    const secondEvent = await second.snapshotA11y("c-second");
    if (firstEvent.type !== "snapshot_result" || secondEvent.type !== "snapshot_result") {
      throw new Error("expected snapshot results");
    }
    const firstRef = firstEvent.tree[0]?.ref;
    const secondRef = secondEvent.tree[0]?.ref;

    expect(firstRef).toBe("aattachment-a:s1e0");
    expect(secondRef).toBe("aattachment-b:s1e0");
    expect(second.resolveRef(firstRef ?? "")).toBeNull();
    expect(second.resolveRef(secondRef ?? "")).toBe(42);
  });

  it("rotates the ref namespace and invalidates the old map at a WS-session barrier", async () => {
    stubActionableSnapshotBrowser();
    const session = await CdpSession.create(7, "session-a");
    const firstEvent = await session.snapshotA11y("c-first");
    if (firstEvent.type !== "snapshot_result") throw new Error("expected snapshot result");
    const oldRef = firstEvent.tree[0]?.ref ?? "";

    await session.invalidateRefsForSessionChange("session-b");

    expect(session.resolveRef(oldRef)).toBeNull();
    expect(session.refMap.size).toBe(0);

    const secondEvent = await session.snapshotA11y("c-second");
    if (secondEvent.type !== "snapshot_result") throw new Error("expected snapshot result");
    expect(secondEvent.tree[0]?.ref).toBe("asession-b:s3e0");
  });

  it("finishes session invalidation even when generation persistence never settles", async () => {
    vi.stubGlobal("browser", {
      storage: {
        session: {
          get: vi.fn().mockResolvedValue({}),
          set: vi.fn(() => new Promise<void>(() => {})),
        },
      },
    });
    const session = await CdpSession.create(7, "session-a");
    const oldRef = "asession-a:s0e0";
    session.refMap = new Map([[oldRef, 42]]);

    await expect(
      session.invalidateRefsForSessionChange("session-b"),
    ).resolves.toBeUndefined();

    expect(session.generation).toBe(1);
    expect(session.refMap.size).toBe(0);
    expect(session.resolveRef(oldRef)).toBeNull();
  });
});
