import { describe, it, expect, vi, afterEach } from "vitest";
import type { Protocol } from "devtools-protocol";
import { CdpSession } from "./cdp";
import type { RefRecord } from "./semantic/types";

const TEST_SCOPE = "test";
const testRef = (generation: number, sequence: number): string =>
  `a${TEST_SCOPE}:s${generation}e${sequence}`;
const testRefMap = (
  entries: ReadonlyArray<readonly [string, number]>,
  fingerprint: Partial<RefRecord["fingerprint"]> = {},
): Map<string, RefRecord> =>
  new Map(
    entries.map(([ref, backendNodeId]) => [
      ref,
      {
        backendNodeId,
        frameId: "frame-1",
        generation: Number(ref.match(/:s(\d+)e/)?.[1] ?? 0),
        actions: new Set(["click", "type", "key", "scroll", "inspect"]),
        fingerprint: {
          role: "textbox",
          domMetadataKnown: false,
          hidden: false,
          disabled: false,
          readonly: false,
          editable: true,
          focusable: true,
          scrollable: true,
          ...fingerprint,
        },
        identity: `be:root:frame-1:${backendNodeId}`,
      },
    ]),
  );
function seedTestRefs(
  session: CdpSession,
  entries: ReadonlyArray<readonly [string, number]>,
  fingerprint: Partial<RefRecord["fingerprint"]> = {},
): void {
  session.replaceRefMap(testRefMap(entries, fingerprint));
  session.frameSessions.set("frame-1", {
    targetId: "frame-1",
    frameId: "frame-1",
    targetType: "page",
    ready: true,
  });
}

function liveRefResponse(method: string, params?: { backendNodeId?: number }): unknown {
  const backendNodeId = params?.backendNodeId ?? 42;
  if (method === "Accessibility.getPartialAXTree") {
    return {
      nodes: [
        {
          nodeId: `ax-${backendNodeId}`,
          ignored: false,
          role: { type: "role", value: "textbox" },
          backendDOMNodeId: backendNodeId,
          properties: [
            { name: "editable", value: { type: "token", value: "plaintext" } },
            { name: "focusable", value: { type: "booleanOrUndefined", value: true } },
            { name: "focused", value: { type: "booleanOrUndefined", value: true } },
          ],
        },
      ],
    };
  }
  if (method === "DOM.describeNode") {
    return {
      node: {
        nodeId: backendNodeId,
        backendNodeId,
        nodeType: 1,
        nodeName: "INPUT",
        localName: "input",
        nodeValue: "",
        attributes: ["type", "text"],
        isScrollable: true,
      },
    };
  }
  return {};
}

function fixedActionFailure(
  commandId: string,
  generation: number,
  reason: "action_failed" | "navigation_blocked" | "timeout" = "action_failed",
  refsStale = false,
  refreshRecommended = true,
): object {
  return {
    type: "action_result",
    commandId,
    ok: false,
    reason,
    generation,
    refsStale,
    refreshRecommended,
  };
}
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
  const sendCommand = vi
    .fn()
    .mockImplementation((_target, method: string, params?: { backendNodeId?: number }) =>
      Promise.resolve(liveRefResponse(method, params)),
    );
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
    stubActionBrowser();
    const session = await CdpSession.create(1, TEST_SCOPE);
    seedTestRefs(session, [[testRef(0, 1), 42]]);
    const generationBefore = session.generation;

    // #when the ref is probed
    const event = await session.resolveRefCheck("c1", testRef(0, 1));

    // #then it resolves ok and the generation is untouched (probing must not
    // invalidate the consumer's outstanding refs)
    expect(event).toEqual({
      type: "action_result",
      commandId: "c1",
      ok: true,
      generation: 0,
      refsStale: false,
      refreshRecommended: false,
    });
    expect(session.generation).toBe(generationBefore);
  });

  it("answers ok:false for a stale-generation ref without bumping the generation", async () => {
    // #given a session that has never seen this ref's generation
    stubBrowserStorage();
    const session = await CdpSession.create(1, TEST_SCOPE);
    seedTestRefs(session, [[testRef(0, 1), 42]]);
    const generationBefore = session.generation;

    // #when a ref from another generation is probed
    const event = await session.resolveRefCheck("c2", testRef(9, 9));

    // #then it reports stale without side effects
    expect(event).toEqual({
      type: "action_result",
      commandId: "c2",
      ok: false,
      reason: "stale_ref",
      generation: 0,
      refsStale: true,
      refreshRecommended: true,
    });
    expect(session.generation).toBe(generationBefore);
  });

  it("answers ok:false for a current-generation ref absent from the map", async () => {
    // #given a session whose current generation does not contain this ref
    stubBrowserStorage();
    const session = await CdpSession.create(1, TEST_SCOPE);
    seedTestRefs(session, [[testRef(0, 1), 42]]);

    // #when a right-generation but unknown ref is probed
    const event = await session.resolveRefCheck("c3", testRef(0, 9));

    // #then it reports stale
    expect(event).toEqual({
      type: "action_result",
      commandId: "c3",
      ok: false,
      reason: "stale_ref",
      generation: 0,
      refsStale: true,
      refreshRecommended: true,
    });
  });

  it("rides the FIFO queue: a probe behind an in-flight snapshot observes its generation bump", async () => {
    // #given a snapshot occupying the FIFO queue, its AX-tree fetch not yet
    // resolved, and a ref that is valid in the CURRENT (pre-bump) generation
    let releaseTree!: (value: { nodes: unknown[] }) => void;
    const sendCommand = vi.fn().mockImplementation((_target, method: string, params) => {
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
      return Promise.resolve(liveRefResponse(method, params));
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
    seedTestRefs(session, [[testRef(0, 1), 42]]);
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
      reason: "stale_ref",
      generation: 1,
      refsStale: true,
      refreshRecommended: true,
    });
  });
});

describe("CdpSession keyboard dispatch", () => {
  it("submits typed text with Enter's carriage-return key event", async () => {
    const sendCommand = stubActionBrowser();
    const session = await CdpSession.create(7, TEST_SCOPE);
    seedTestRefs(session, [[testRef(0, 1), 42]]);

    await expect(session.type("c-submit", testRef(0, 1), "secret", true)).resolves.toEqual({
      type: "action_result",
      commandId: "c-submit",
      ok: true,
      generation: 0,
      refsStale: false,
      refreshRecommended: true,
    });

    expect(
      sendCommand.mock.calls
        .slice(2)
        .filter((call) => ["DOM.focus", "Input.insertText", "Input.dispatchKeyEvent"].includes(call[1] as string)),
    ).toEqual([
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
    seedTestRefs(session, [[testRef(0, 1), 42]]);

    await session.type("c-no-submit", testRef(0, 1), "plain text", false);

    expect(
      sendCommand.mock.calls
        .slice(2)
        .map((call) => call[1])
        .filter((method) => ["DOM.focus", "Input.insertText", "Input.dispatchKeyEvent"].includes(method as string)),
    ).toEqual(["DOM.focus", "Input.insertText"]);
  });

  it("allows repeated typing when only the editable value changes", async () => {
    let liveRead = 0;
    const sendCommand = stubActionBrowser();
    sendCommand.mockImplementation((_target, method: string, params) => {
      const response = liveRefResponse(method, params);
      if (method !== "Accessibility.getPartialAXTree") {
        return Promise.resolve(response);
      }
      liveRead += 1;
      const tree = structuredClone(response) as {
        nodes: Array<{ value?: { type: string; value: string } }>;
      };
      tree.nodes[0]!.value = { type: "string", value: `private-${liveRead}` };
      return Promise.resolve(tree);
    });
    const session = await CdpSession.create(7, TEST_SCOPE);
    seedTestRefs(session, [[testRef(0, 1), 42]]);

    await expect(session.type("first", testRef(0, 1), "first")).resolves.toMatchObject({
      ok: true,
      refreshRecommended: false,
    });
    await expect(session.type("second", testRef(0, 1), "second")).resolves.toMatchObject({
      ok: true,
      refreshRecommended: false,
    });
    expect(
      sendCommand.mock.calls
        .filter((call) => call[1] === "Input.insertText")
        .map((call) => call[2]),
    ).toEqual([{ text: "first" }, { text: "second" }]);
  });

  it("returns target_changed without dispatch when the live semantic identity changed", async () => {
    const sendCommand = stubActionBrowser();
    const session = await CdpSession.create(7, TEST_SCOPE);
    seedTestRefs(session, [[testRef(0, 1), 42]], { name: "Original field" });

    await expect(session.type("changed", testRef(0, 1), "must not type"))
      .resolves.toEqual({
        type: "action_result",
        commandId: "changed",
        ok: false,
        reason: "target_changed",
        generation: 0,
        refsStale: true,
        refreshRecommended: true,
      });
    expect(
      sendCommand.mock.calls.some((call) =>
        ["DOM.focus", "Input.insertText"].includes(call[1] as string),
      ),
    ).toBe(false);
  });

  it("treats a formerly absent AX name as a semantic identity change", async () => {
    const sendCommand = stubActionBrowser();
    sendCommand.mockImplementation((_target, method: string, params) => {
      const response = liveRefResponse(method, params);
      if (method !== "Accessibility.getPartialAXTree") {
        return Promise.resolve(response);
      }
      const tree = structuredClone(response) as {
        nodes: Array<{ name?: { type: string; value: string } }>;
      };
      tree.nodes[0]!.name = { type: "computedString", value: "New identity" };
      return Promise.resolve(tree);
    });
    const session = await CdpSession.create(7, TEST_SCOPE);
    seedTestRefs(session, [[testRef(0, 1), 42]]);

    await expect(session.type("new-name", testRef(0, 1), "must not type"))
      .resolves.toMatchObject({ ok: false, reason: "target_changed" });
    expect(
      sendCommand.mock.calls.some((call) => call[1] === "Input.insertText"),
    ).toBe(false);
  });

  it.each([
    { propertyName: "disabled", action: "click" as const },
    { propertyName: "readonly", action: "type" as const },
    { propertyName: "hidden", action: "click" as const },
  ])("rejects a live $propertyName target before $action dispatch", async ({
    propertyName,
    action,
  }) => {
    const sendCommand = stubActionBrowser();
    sendCommand.mockImplementation((_target, method: string, params) => {
      const response = liveRefResponse(method, params);
      if (method !== "Accessibility.getPartialAXTree") {
        return Promise.resolve(response);
      }
      const tree = structuredClone(response) as {
        nodes: Array<{ properties: Protocol.Accessibility.AXProperty[] }>;
      };
      tree.nodes[0]!.properties.push({
        name: propertyName,
        value: { type: "booleanOrUndefined", value: true },
      } as Protocol.Accessibility.AXProperty);
      return Promise.resolve(tree);
    });
    const session = await CdpSession.create(7, TEST_SCOPE);
    seedTestRefs(session, [[testRef(0, 1), 42]]);

    const result =
      action === "type"
        ? await session.type("state-change", testRef(0, 1), "blocked")
        : await session.click("state-change", testRef(0, 1));
    expect(result).toMatchObject({ ok: false, reason: "target_changed" });
    expect(
      sendCommand.mock.calls.some((call) =>
        ["DOM.focus", "Input.insertText", "Input.dispatchMouseEvent"].includes(
          call[1] as string,
        ),
      ),
    ).toBe(false);
  });

  it("rejects a ref whose owning frame changed before live validation", async () => {
    const sendCommand = stubActionBrowser();
    const session = await CdpSession.create(7, TEST_SCOPE);
    seedTestRefs(session, [[testRef(0, 1), 42]]);
    session.frameSessions.delete("frame-1");

    await expect(session.type("wrong-frame", testRef(0, 1), "blocked")).resolves
      .toMatchObject({ ok: false, reason: "frame_changed" });
    expect(sendCommand.mock.calls).toHaveLength(0);
  });

  it("revalidates after focus and refuses insertion into a replaced target", async () => {
    let liveRead = 0;
    const sendCommand = stubActionBrowser();
    sendCommand.mockImplementation((_target, method: string, params) => {
      const response = liveRefResponse(method, params);
      if (method !== "Accessibility.getPartialAXTree") {
        return Promise.resolve(response);
      }
      liveRead += 1;
      const tree = structuredClone(response) as {
        nodes: Array<{ name?: { type: string; value: string } }>;
      };
      tree.nodes[0]!.name = {
        type: "computedString",
        value: liveRead === 1 ? "Stable field" : "Replacement field",
      };
      return Promise.resolve(tree);
    });
    const session = await CdpSession.create(7, TEST_SCOPE);
    seedTestRefs(session, [[testRef(0, 1), 42]], { name: "Stable field" });

    await expect(session.type("focus-replace", testRef(0, 1), "blocked")).resolves
      .toMatchObject({ ok: false, reason: "target_changed" });
    expect(sendCommand.mock.calls.some((call) => call[1] === "Input.insertText")).toBe(false);
  });

  it("rechecks generation after awaited live reads", async () => {
    const sendCommand = stubActionBrowser();
    let session!: CdpSession;
    sendCommand.mockImplementation((_target, method: string, params) => {
      if (method === "DOM.describeNode") void session.bumpGeneration();
      return Promise.resolve(liveRefResponse(method, params));
    });
    session = await CdpSession.create(7, TEST_SCOPE);
    seedTestRefs(session, [[testRef(0, 1), 42]]);

    await expect(session.type("read-race", testRef(0, 1), "blocked")).resolves
      .toMatchObject({ ok: false, reason: "target_changed", generation: 1 });
    expect(sendCommand.mock.calls.some((call) => call[1] === "Input.insertText")).toBe(false);
  });

  it("fails a referenced key without dispatch when DOM focus fails", async () => {
    const sendCommand = stubActionBrowser();
    sendCommand.mockImplementation((_target, method: string, params) =>
      method === "DOM.focus"
        ? Promise.reject(new Error("focus failed"))
        : Promise.resolve(liveRefResponse(method, params)),
    );
    const session = await CdpSession.create(7, TEST_SCOPE);
    seedTestRefs(session, [[testRef(0, 1), 42]]);

    await expect(session.key("focus-failed", "Enter", testRef(0, 1))).resolves
      .toMatchObject({ ok: false, reason: "action_failed" });
    expect(
      sendCommand.mock.calls.some((call) => call[1] === "Input.dispatchKeyEvent"),
    ).toBe(false);
  });

  it("fails typing without pointer fallback when DOM focus fails", async () => {
    const sendCommand = stubActionBrowser();
    sendCommand.mockImplementation((_target, method: string, params) =>
      method === "DOM.focus"
        ? Promise.reject(new Error("focus failed"))
        : Promise.resolve(liveRefResponse(method, params)),
    );
    const session = await CdpSession.create(7, TEST_SCOPE);
    seedTestRefs(session, [[testRef(0, 1), 42]]);

    await expect(session.type("focus-failed", testRef(0, 1), "blocked")).resolves
      .toMatchObject({ ok: false, reason: "action_failed" });
    expect(
      sendCommand.mock.calls.some((call) =>
        ["Input.dispatchMouseEvent", "Input.insertText"].includes(call[1] as string),
      ),
    ).toBe(false);
  });

  it("invalidates only meaningful AX cache updates and ignores focus-only churn", async () => {
    stubActionBrowser();
    const session = await CdpSession.create(7, TEST_SCOPE);
    seedTestRefs(session, [[testRef(0, 1), 42]]);

    expect(
      session.hasMeaningfulAccessibilityUpdate({
        nodes: [
          {
            nodeId: "ax-42",
            ignored: false,
            backendDOMNodeId: 42,
            properties: [
              {
                name: "focused",
                value: { type: "booleanOrUndefined", value: true },
              },
            ],
          },
        ],
      }),
    ).toBe(false);
    expect(
      session.hasMeaningfulAccessibilityUpdate({
        nodes: [
          {
            nodeId: "ax-42",
            ignored: false,
            backendDOMNodeId: 42,
            name: { type: "computedString", value: "New identity" },
          },
        ],
      }),
    ).toBe(true);
  });

  it("revalidates AX-derived scroll capability with the same source policy", async () => {
    const sendCommand = stubActionBrowser();
    sendCommand.mockImplementation((_target, method: string, params) => {
      const response = liveRefResponse(method, params);
      if (method === "Accessibility.getPartialAXTree") {
        const tree = structuredClone(response) as {
          nodes: Array<{ properties?: Array<{ name: string; value: unknown }> }>;
        };
        tree.nodes[0]!.properties?.push({
          name: "scrollable",
          value: { type: "booleanOrUndefined", value: true },
        });
        return Promise.resolve(tree);
      }
      if (method === "DOM.describeNode") {
        const described = structuredClone(response) as {
          node: { isScrollable?: boolean };
        };
        described.node.isScrollable = false;
        return Promise.resolve(described);
      }
      if (method === "DOM.getBoxModel") {
        return Promise.resolve({
          model: { content: [0, 0, 20, 0, 20, 20, 0, 20] },
        });
      }
      return Promise.resolve(response);
    });
    const session = await CdpSession.create(7, TEST_SCOPE);
    seedTestRefs(session, [[testRef(0, 1), 42]]);

    await expect(session.scroll("ax-scroll", 200, testRef(0, 1))).resolves
      .toMatchObject({ ok: true });
    expect(sendCommand.mock.calls).toContainEqual([
      { tabId: 7 },
      "Input.dispatchMouseEvent",
      expect.objectContaining({ type: "mouseWheel", deltaY: 200 }),
    ]);
  });

  it("uses the same Enter payload for the explicit key command", async () => {
    const sendCommand = stubActionBrowser();
    const session = await CdpSession.create(7, TEST_SCOPE);
    seedTestRefs(session, [[testRef(0, 1), 42]]);

    await session.key("c-enter", "Enter", testRef(0, 1));

    expect(
      sendCommand.mock.calls
        .slice(3)
        .filter((call) => call[1] === "Input.dispatchKeyEvent"),
    ).toEqual([
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

describe("CdpSession sensitive payment submission", () => {
  it("prevalidates every ref before issuing any CDP command", async () => {
    const sendCommand = stubActionBrowser();
    const session = await CdpSession.create(7, TEST_SCOPE);
    seedTestRefs(session, [[testRef(0, 1), 41]]);

    await expect(
      session.submitSensitiveFields(
        [
          { ref: testRef(0, 1), text: "4111111111111111" },
          { ref: testRef(0, 2), text: "123" },
        ],
        testRef(0, 3),
        "https://approved.example",
        vi.fn(),
        vi.fn(),
      ),
    ).resolves.toEqual({
      stale: true,
      originMismatch: false,
      cardBytesMayHaveBeenInserted: false,
      submissionAttempted: false,
    });
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it("fills all mapped fields and invokes submit without reading the page afterward", async () => {
    const sendCommand = stubActionBrowser();
    sendCommand.mockImplementation((_target, method: string) => {
      if (method === "Page.getFrameTree") {
        return Promise.resolve({
          frameTree: {
            frame: {
              id: "main",
              loaderId: "loader",
              url: "https://approved.example/checkout",
            },
          },
        });
      }
      if (method === "DOM.getBoxModel") {
        return Promise.resolve({ model: { content: [0, 0, 10, 0, 10, 10, 0, 10] } });
      }
      return Promise.resolve({});
    });
    const session = await CdpSession.create(7, TEST_SCOPE);
    seedTestRefs(session, [
      [testRef(0, 1), 41],
      [testRef(0, 2), 42],
      [testRef(0, 3), 43],
    ]);
    const beforeInsert = vi.fn();
    const beforeSubmit = vi.fn();

    await expect(
      session.submitSensitiveFields(
        [
          { ref: testRef(0, 1), text: "4111111111111111" },
          { ref: testRef(0, 2), text: "123" },
        ],
        testRef(0, 3),
        "https://approved.example",
        beforeInsert,
        beforeSubmit,
      ),
    ).resolves.toEqual({
      stale: false,
      originMismatch: false,
      cardBytesMayHaveBeenInserted: true,
      submissionAttempted: true,
    });
    expect(beforeInsert).toHaveBeenCalledTimes(2);
    expect(beforeSubmit).toHaveBeenCalledOnce();
    expect(
      sendCommand.mock.calls.filter((call) => call[1] === "Input.insertText").map((call) => call[2]),
    ).toEqual([
      { text: "4111111111111111" },
      { text: "123" },
    ]);
    expect(
      sendCommand.mock.calls.some((call) =>
        ["Accessibility.getFullAXTree", "Page.captureScreenshot", "Runtime.evaluate"].includes(
          call[1] as string,
        ),
      ),
    ).toBe(false);
  });

  it("rechecks use-time eligibility inside the queue before the first insertion", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-31T23:59:59.999Z"));
    let releaseBlocker!: () => void;
    let blocked = false;
    const sendCommand = vi.fn().mockImplementation((_target, method: string, params) => {
      if (method === "DOM.focus" && !blocked) {
        blocked = true;
        return new Promise<void>((resolve) => {
          releaseBlocker = resolve;
        });
      }
      if (method === "Page.getFrameTree") {
        return Promise.resolve({
          frameTree: {
            frame: {
              id: "main",
              loaderId: "loader",
              url: "https://approved.example/checkout",
            },
          },
        });
      }
      return Promise.resolve(liveRefResponse(method, params));
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
    const session = await CdpSession.create(7, TEST_SCOPE);
    seedTestRefs(session, [
      [testRef(0, 1), 41],
      [testRef(0, 2), 42],
      [testRef(0, 3), 43],
    ]);
    const blocker = session.type("queue-blocker", testRef(0, 1), "not-card-data");
    await vi.waitFor(() => expect(blocked).toBe(true));
    const submission = session.submitSensitiveFields(
      [{ ref: testRef(0, 2), text: "synthetic marker" }],
      testRef(0, 3),
      "https://approved.example",
      vi.fn(),
      vi.fn(),
      () => new Date().getUTCMonth() === 7,
    );

    await vi.advanceTimersByTimeAsync(1);
    releaseBlocker();
    await blocker;

    await expect(submission).resolves.toEqual({
      stale: false,
      originMismatch: false,
      cardBytesMayHaveBeenInserted: false,
      submissionAttempted: false,
      insertionRefused: true,
    });
    expect(
      sendCommand.mock.calls
        .filter((call) => call[1] === "Input.insertText")
        .map((call) => call[2]),
    ).toEqual([{ text: "not-card-data" }]);
  });

  it("returns a fixed insertion-unknown signal when CDP fails during input", async () => {
    const sendCommand = stubActionBrowser();
    sendCommand.mockImplementation((_target, method: string) => {
      if (method === "Page.getFrameTree") {
        return Promise.resolve({
          frameTree: {
            frame: {
              id: "main",
              loaderId: "loader",
              url: "https://approved.example/checkout",
            },
          },
        });
      }
      if (method === "Input.insertText") return Promise.reject(new Error("synthetic marker"));
      return Promise.resolve({});
    });
    const session = await CdpSession.create(7, TEST_SCOPE);
    seedTestRefs(session, [
      [testRef(0, 1), 41],
      [testRef(0, 2), 42],
    ]);

    await expect(
      session.submitSensitiveFields(
        [{ ref: testRef(0, 1), text: "synthetic marker" }],
        testRef(0, 2),
        "https://approved.example",
        vi.fn(),
        vi.fn(),
      ),
    ).resolves.toEqual({
      stale: false,
      originMismatch: false,
      cardBytesMayHaveBeenInserted: true,
      submissionAttempted: false,
    });
  });

  it("refuses insertion when the live top-level origin changed after approval", async () => {
    const sendCommand = stubActionBrowser();
    sendCommand.mockImplementation((_target, method: string) => {
      if (method === "Page.getFrameTree") {
        return Promise.resolve({
          frameTree: {
            frame: {
              id: "main",
              loaderId: "loader",
              url: "https://other.example/checkout",
            },
          },
        });
      }
      return Promise.resolve({});
    });
    const session = await CdpSession.create(7, TEST_SCOPE);
    seedTestRefs(session, [
      [testRef(0, 1), 41],
      [testRef(0, 2), 42],
    ]);

    await expect(
      session.submitSensitiveFields(
        [{ ref: testRef(0, 1), text: "synthetic marker" }],
        testRef(0, 2),
        "https://approved.example",
        vi.fn(),
        vi.fn(),
      ),
    ).resolves.toEqual({
      stale: false,
      originMismatch: true,
      cardBytesMayHaveBeenInserted: false,
      submissionAttempted: false,
    });
    expect(sendCommand.mock.calls.some((call) => call[1] === "Input.insertText")).toBe(false);
  });

  it("invalidates a sensitive fill when navigation changes its ref generation", async () => {
    const sendCommand = stubActionBrowser();
    let session!: CdpSession;
    sendCommand.mockImplementation((_target, method: string) => {
      if (method === "Page.getFrameTree") {
        return Promise.resolve({
          frameTree: {
            frame: {
              id: "main",
              loaderId: "loader",
              url: "https://approved.example/checkout",
            },
          },
        });
      }
      if (method === "DOM.focus") void session.bumpGeneration();
      return Promise.resolve({});
    });
    session = await CdpSession.create(7, TEST_SCOPE);
    seedTestRefs(session, [
      [testRef(0, 1), 41],
      [testRef(0, 2), 42],
    ]);

    await expect(
      session.submitSensitiveFields(
        [{ ref: testRef(0, 1), text: "synthetic marker" }],
        testRef(0, 2),
        "https://approved.example",
        vi.fn(),
        vi.fn(),
      ),
    ).resolves.toEqual({
      stale: true,
      originMismatch: false,
      cardBytesMayHaveBeenInserted: false,
      submissionAttempted: false,
    });
    expect(sendCommand.mock.calls.some((call) => call[1] === "Input.insertText")).toBe(false);
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
    seedTestRefs(session, [[testRef(0, 1), 42]]);

    const event = await session.snapshotA11y("c-redirect");

    expect(event).toEqual(fixedActionFailure("c-redirect", 1));
    expect(session.refCount).toBe(0);
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

    await expect(session.snapshotA11y("c-fragment")).resolves.toEqual(
      fixedActionFailure("c-fragment", 1),
    );
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

    await expect(session.snapshotA11y("c-loader")).resolves.toEqual(
      fixedActionFailure("c-loader", 1),
    );
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

    await expect(snapshot).resolves.toEqual(fixedActionFailure("c-generation", 1));
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
    seedTestRefs(session, [[testRef(0, 1), 42]]);

    await expect(session.snapshotA11y("c-capture-failed")).resolves.toEqual(
      fixedActionFailure("c-capture-failed", 1),
    );
    expect(session.refCount).toBe(0);
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
    seedTestRefs(session, [[testRef(0, 1), 42]]);

    await expect(session.snapshotA11y("c-identity-failed")).resolves.toEqual(
      fixedActionFailure("c-identity-failed", 1),
    );
    expect(session.refCount).toBe(0);
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

    await expect(snapshot).resolves.toEqual(fixedActionFailure("c-persist-race", 2));
    await navigationBump;
    expect(session.refCount).toBe(0);
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
    seedTestRefs(session, [[testRef(0, 1), 42]]);
    const snapshot = session.snapshotA11y("c-aggregate-timeout");

    await vi.advanceTimersByTimeAsync(25_000);

    await expect(snapshot).resolves.toEqual(
      fixedActionFailure("c-aggregate-timeout", 1),
    );
    expect(sendCommand.mock.calls.map((call) => call[1])).toEqual([
      "Page.getFrameTree",
      "Accessibility.getFullAXTree",
      "Page.getFrameTree",
    ]);
    expect(session.refCount).toBe(0);

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

    await expect(snapshot).resolves.toEqual(
      fixedActionFailure("c-queued-timeout", 0, "timeout", true),
    );
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
    expect(second.resolveRef(secondRef ?? "")?.backendNodeId).toBe(42);
  });

  it("rotates the ref namespace and invalidates the old map at a WS-session barrier", async () => {
    stubActionableSnapshotBrowser();
    const session = await CdpSession.create(7, "session-a");
    const firstEvent = await session.snapshotA11y("c-first");
    if (firstEvent.type !== "snapshot_result") throw new Error("expected snapshot result");
    const oldRef = firstEvent.tree[0]?.ref ?? "";

    await session.invalidateRefsForSessionChange("session-b");

    expect(session.resolveRef(oldRef)).toBeNull();
    expect(session.refCount).toBe(0);

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
    seedTestRefs(session, [[oldRef, 42]]);

    await expect(
      session.invalidateRefsForSessionChange("session-b"),
    ).resolves.toBeUndefined();

    expect(session.generation).toBe(1);
    expect(session.refCount).toBe(0);
    expect(session.resolveRef(oldRef)).toBeNull();
  });
});

describe("CdpSession unattended containment", () => {
  function containmentSession(): Promise<{
    session: CdpSession;
    sendCommand: ReturnType<typeof vi.fn>;
  }> {
    const sendCommand = vi.fn().mockResolvedValue({});
    vi.stubGlobal("browser", {
      storage: {
        session: {
          get: vi.fn().mockResolvedValue({}),
          set: vi.fn().mockResolvedValue(undefined),
        },
      },
      debugger: {
        sendCommand,
      },
    });
    return CdpSession.create(7, TEST_SCOPE).then((session) => ({
      session,
      sendCommand,
    }));
  }

  it("prechecks explicit navigation and permits only about:blank or an allowed origin", async () => {
    const { session, sendCommand } = await containmentSession();
    await session.enableUnattendedContainment(["https://allowed.example"]);

    expect(session.isAllowedTopLevelUrl("about:blank")).toBe(true);
    expect(session.isAllowedTopLevelUrl("https://allowed.example/path")).toBe(true);
    expect(session.isAllowedTopLevelUrl("https://blocked.example/")).toBe(false);
    await expect(
      session.navigate("blocked-nav", "https://blocked.example/"),
    ).resolves.toEqual(
      fixedActionFailure("blocked-nav", 0, "navigation_blocked", true, false),
    );
    expect(
      sendCommand.mock.calls.some((call) => call[1] === "Page.navigate"),
    ).toBe(false);
  });

  it("blocks top-level redirects/JavaScript navigation but permits iframes and subresources", async () => {
    const { session, sendCommand } = await containmentSession();
    session.mainFrameId = "main-frame";
    await session.enableUnattendedContainment(["https://allowed.example"]);

    await session.handleFetchRequestPaused({
      requestId: "top",
      request: { url: "https://blocked.example/redirect" },
      frameId: "main-frame",
      resourceType: "Document",
    });
    await session.handleFetchRequestPaused({
      requestId: "iframe",
      request: { url: "https://blocked.example/frame" },
      frameId: "child-frame",
      resourceType: "Document",
    });
    await session.handleFetchRequestPaused({
      requestId: "script",
      request: { url: "https://blocked.example/app.js" },
      frameId: "main-frame",
      resourceType: "Script",
    });

    expect(sendCommand.mock.calls).toContainEqual([
      { tabId: 7 },
      "Fetch.failRequest",
      { requestId: "top", errorReason: "BlockedByClient" },
    ]);
    expect(sendCommand.mock.calls).toContainEqual([
      { tabId: 7 },
      "Fetch.continueRequest",
      { requestId: "iframe" },
    ]);
    expect(sendCommand.mock.calls).toContainEqual([
      { tabId: 7 },
      "Fetch.continueRequest",
      { requestId: "script" },
    ]);
  });

  it("blocks navigation from the approved payment origin to another session-approved origin", async () => {
    const { session, sendCommand } = await containmentSession();
    session.mainFrameId = "main-frame";
    await session.enableUnattendedContainment([
      "https://approved.example",
      "https://other.example",
    ]);
    session.pinSensitiveOrigin("https://approved.example");

    await session.handleFetchRequestPaused({
      requestId: "payment-redirect",
      request: { url: "https://other.example/submit" },
      frameId: "main-frame",
      resourceType: "Document",
    });

    expect(sendCommand.mock.calls).toContainEqual([
      { tabId: 7 },
      "Fetch.failRequest",
      { requestId: "payment-redirect", errorReason: "BlockedByClient" },
    ]);
  });

  it("stops an already-continued navigation and blocks all new navigation until submission", async () => {
    const { session, sendCommand } = await containmentSession();
    session.mainFrameId = "main-frame";
    await session.enableUnattendedContainment(["https://approved.example"]);
    session.pinSensitiveOrigin("https://approved.example");
    sendCommand.mockImplementation((_target, method: string) => {
      if (method === "Page.getFrameTree") {
        return Promise.resolve({
          frameTree: {
            frame: {
              id: "main-frame",
              loaderId: "loader",
              url: "https://approved.example/checkout",
            },
          },
        });
      }
      return Promise.resolve({});
    });

    await expect(
      session.stopPendingSensitiveNavigation("https://approved.example"),
    ).resolves.toBe(true);
    await session.handleFetchRequestPaused({
      requestId: "same-origin-before-submit",
      request: { url: "https://approved.example/redirect" },
      frameId: "main-frame",
      resourceType: "Document",
    });

    expect(sendCommand.mock.calls).toContainEqual([
      { tabId: 7 },
      "Page.stopLoading",
      undefined,
    ]);
    expect(sendCommand.mock.calls).toContainEqual([
      { tabId: 7 },
      "Fetch.failRequest",
      {
        requestId: "same-origin-before-submit",
        errorReason: "BlockedByClient",
      },
    ]);
  });

  it("closes a paused related page target before resuming it", async () => {
    const { session, sendCommand } = await containmentSession();

    await session.handleAttachedTarget(undefined, {
      sessionId: "popup-session",
      targetInfo: { type: "page", targetId: "popup-target" },
    }, true);

    expect(sendCommand).toHaveBeenCalledWith(
      { tabId: 7 },
      "Target.closeTarget",
      { targetId: "popup-target" },
    );
    expect(
      sendCommand.mock.calls.some((call) => call[1] === "Runtime.runIfWaitingForDebugger"),
    ).toBe(false);
  });
});

describe("CdpSession OOPIF routing", () => {
  it("initializes nested iframe sessions and routes ref validation and actions through them", async () => {
    const sendCommand = vi.fn(
      async (
        target: { tabId: number; sessionId?: string },
        method: string,
        params?: { backendNodeId?: number },
      ) => {
        if (method === "Page.getFrameTree") {
          return {
            frameTree: {
              frame: {
                id: target.sessionId === "child-session" ? "child-frame" : "main-frame",
                loaderId: "loader",
                url: "https://example.com/",
              },
            },
          };
        }
        if (method === "Accessibility.getPartialAXTree") {
          return {
            nodes: [
              {
                nodeId: "live-button",
                ignored: false,
                role: { type: "role", value: "button" },
                name: { type: "computedString", value: "Pay" },
                backendDOMNodeId: params?.backendNodeId,
                properties: [
                  {
                    name: "focusable",
                    value: { type: "booleanOrUndefined", value: true },
                  },
                ],
              },
            ],
          };
        }
        if (method === "DOM.describeNode") {
          return {
            node: {
              nodeId: 42,
              backendNodeId: 42,
              nodeType: 1,
              nodeName: "BUTTON",
              localName: "button",
              nodeValue: "",
              attributes: [],
              isScrollable: false,
            },
          };
        }
        if (method === "DOM.getBoxModel") {
          return { model: { content: [0, 0, 10, 0, 10, 10, 0, 10] } };
        }
        return {};
      },
    );
    vi.stubGlobal("browser", {
      storage: {
        session: {
          get: vi.fn(async () => ({})),
          set: vi.fn(async () => {}),
        },
      },
      debugger: { sendCommand },
    });
    const session = await CdpSession.create(7, TEST_SCOPE);

    await session.handleAttachedTarget(
      undefined,
      {
        sessionId: "child-session",
        targetInfo: { type: "iframe", targetId: "child-target" },
      },
      false,
    );
    session.replaceRefMap(
      new Map([
        [
          testRef(0, 1),
          {
            backendNodeId: 42,
            frameId: "child-frame",
            debuggerSessionId: "child-session",
            generation: 0,
            actions: new Set(["click", "inspect"]),
            fingerprint: {
              role: "button",
              name: "Pay",
              tagName: "button",
              domMetadataKnown: true,
              hidden: false,
              disabled: false,
              readonly: false,
              editable: false,
              focusable: true,
              scrollable: false,
            },
            identity: "be:child-session:child-frame:42",
          },
        ],
      ]),
    );

    await expect(session.click("click-child", testRef(0, 1))).resolves.toMatchObject({
      ok: true,
    });
    expect(
      sendCommand.mock.calls
        .filter((call) =>
          [
            "Accessibility.getPartialAXTree",
            "DOM.describeNode",
            "DOM.getBoxModel",
            "Input.dispatchMouseEvent",
          ].includes(call[1] as string),
        )
        .every((call) => call[0].sessionId === "child-session"),
    ).toBe(true);
    expect(
      sendCommand.mock.calls.some(
        (call) =>
          call[1] === "Target.setAutoAttach" &&
          call[0].sessionId === "child-session",
      ),
    ).toBe(true);
    session.frameSessions.set("grandchild-frame", {
      sessionId: "grandchild-session",
      targetId: "grandchild-target",
      frameId: "grandchild-frame",
      parentSessionId: "child-session",
      targetType: "iframe",
      ready: true,
    });
    session.frameSessions.set("great-grandchild-frame", {
      sessionId: "great-grandchild-session",
      targetId: "great-grandchild-target",
      frameId: "great-grandchild-frame",
      parentSessionId: "grandchild-session",
      targetType: "iframe",
      ready: true,
    });
    expect(session.handleDetachedTarget({ sessionId: "child-session" })).toBe(true);
    expect(session.frameSessions.has("child-frame")).toBe(false);
    expect(session.frameSessions.has("grandchild-frame")).toBe(false);
    expect(session.frameSessions.has("great-grandchild-frame")).toBe(false);
  });
});
