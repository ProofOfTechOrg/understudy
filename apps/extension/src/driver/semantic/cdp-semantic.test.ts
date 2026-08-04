import { afterEach, describe, expect, it, vi } from "vitest";
import type { Protocol } from "devtools-protocol";
import type { ElementsResult } from "@understudy/protocol";
import { CdpSession } from "../cdp";

function domSnapshot() {
  return {
    strings: ["main", "HTML", "BUTTON"],
    documents: [
      {
        frameId: 0,
        scrollOffsetX: 0,
        scrollOffsetY: 0,
        nodes: {
          backendNodeId: [1, 11, 12, 13, 14],
          nodeName: [1, 2, 2, 2, 2],
          parentIndex: [-1, 0, 0, 0, 0],
          attributes: [[], [], [], [], []],
          isClickable: { index: [1, 2, 3, 4] },
        },
        layout: {
          nodeIndex: [0, 1, 2, 3, 4],
          bounds: [
            [0, 0, 800, 600],
            [10, 10, 100, 30],
            [10, 50, 100, 30],
            [10, 90, 100, 30],
            [10, 900, 100, 30],
          ],
          styles: [[], [], [], [], []],
        },
        textBoxes: { layoutIndex: [], bounds: [], start: [], length: [] },
      },
    ],
  };
}

function fullAxTree(capture: number): { nodes: Protocol.Accessibility.AXNode[] } {
  const buttonNames = capture === 1
    ? ["Button 1", "Button 2", "Button 3", "Button 4"]
    : ["Button 1", "Renamed", "Button 3", "Button 4"];
  return {
    nodes: [
      {
        nodeId: "root",
        ignored: false,
        role: { type: "role", value: "RootWebArea" },
        childIds: ["b1", "b2", "b3", "b4"],
      },
      ...buttonNames.map((name, index) => ({
        nodeId: `b${index + 1}`,
        ignored: false,
        role: { type: "role", value: "button" },
        name: { type: "computedString", value: name },
        backendDOMNodeId: 11 + index,
        properties: [
          { name: "focusable", value: { type: "booleanOrUndefined", value: true } },
        ],
      })),
    ] as Protocol.Accessibility.AXNode[],
  };
}

function semanticBrowser(): ReturnType<typeof vi.fn> {
  let capture = 0;
  const sendCommand = vi.fn(
    async (_target, method: string, params?: { backendNodeId?: number }) => {
      if (method === "Page.getFrameTree") {
        return {
          frameTree: {
            frame: {
              id: "main",
              loaderId: "loader",
              url: "https://example.test/",
            },
          },
        };
      }
      if (method === "DOMSnapshot.captureSnapshot") return domSnapshot();
      if (method === "Page.getLayoutMetrics") {
        return {
          cssVisualViewport: {
            offsetX: 0,
            offsetY: 0,
            pageX: 0,
            pageY: 0,
            clientWidth: 800,
            clientHeight: 600,
            scale: 1,
            zoom: 1,
          },
        };
      }
      if (method === "Accessibility.getFullAXTree") {
        capture += 1;
        return fullAxTree(capture);
      }
      if (method === "Accessibility.getPartialAXTree") {
        const backendNodeId = params?.backendNodeId ?? 11;
        const name = backendNodeId === 12 && capture > 1
          ? "Renamed"
          : `Button ${backendNodeId - 10}`;
        return {
          nodes: [
            {
              nodeId: `live-${backendNodeId}`,
              ignored: false,
              role: { type: "role", value: "button" },
              name: { type: "computedString", value: name },
              backendDOMNodeId: backendNodeId,
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
        const backendNodeId = params?.backendNodeId ?? 11;
        return {
          node: {
            nodeId: backendNodeId,
            backendNodeId,
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
        return { model: { content: [10, 10, 110, 10, 110, 40, 10, 40] } };
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
  return sendCommand;
}

function ok(event: Awaited<ReturnType<CdpSession["captureElements"]>>): Extract<ElementsResult, { status: "ok" }> {
  if (event.type !== "elements_result" || event.status !== "ok") {
    throw new Error(`expected successful elements result: ${JSON.stringify(event)}`);
  }
  return event;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("CdpSession semantic results", () => {
  it("paginates immutable results and keeps find, inspect, and next capture-free", async () => {
    const sendCommand = semanticBrowser();
    const session = await CdpSession.create(7, "semantic");

    const first = ok(
      await session.captureElements("snapshot", "document", "interactive", 2, false),
    );
    expect(first.elements).toHaveLength(2);
    expect(first.page).toMatchObject({ available: 4, hasMore: true });
    expect(new TextEncoder().encode(JSON.stringify(first)).byteLength).toBeLessThanOrEqual(
      32 * 1024,
    );
    const generation = first.snapshot.generation;
    const cursor = first.page.cursor;
    const firstRef = first.elements[0]?.ref;
    if (cursor === undefined || firstRef === undefined) throw new Error("missing cursor/ref");
    const fullCaptures = () =>
      sendCommand.mock.calls.filter((call) =>
        ["DOMSnapshot.captureSnapshot", "Accessibility.getFullAXTree"].includes(
          call[1] as string,
        ),
      ).length;
    expect(fullCaptures()).toBe(2);

    const found = await session.findElements(
      "find",
      "Button 4",
      ["button"],
      "exact",
      false,
      20,
    );
    const inspected = await session.inspectElements("inspect", firstRef, 1, 20, true);
    const next = await session.continueElements("next", cursor);

    expect(ok(found).snapshot.generation).toBe(generation);
    expect(ok(found).elements.some((element) => element.name === "Button 4")).toBe(true);
    expect(ok(inspected).snapshot.generation).toBe(generation);
    expect(ok(inspected).elements[0]).toMatchObject({ relation: "match", bounds: expect.any(Object) });
    expect(ok(next).snapshot.generation).toBe(generation);
    expect(ok(next).elements).toHaveLength(2);
    expect(fullCaptures()).toBe(2);
  });

  it("applies same-document deltas with new refs and expires earlier cursors", async () => {
    semanticBrowser();
    const session = await CdpSession.create(7, "semantic");
    const first = ok(
      await session.captureElements("first", "document", "interactive", 1, false),
    );
    const oldCursor = first.page.cursor;
    if (oldCursor === undefined) throw new Error("missing cursor");
    await session.bumpGeneration(true);

    const delta = ok(
      await session.captureElements("delta", "document", "interactive", 20, true),
    );
    expect(delta.delta).toEqual({
      requested: true,
      applied: true,
      added: 0,
      changed: 1,
      removed: 0,
    });
    expect(delta.snapshot.generation).toBeGreaterThan(first.snapshot.generation);
    expect(delta.elements.find((element) => element.name === "Renamed")).toMatchObject({
      change: "changed",
      ref: expect.stringContaining(`:s${delta.snapshot.generation}e`),
    });
    await expect(session.continueElements("old-next", oldCursor)).resolves.toMatchObject({
      type: "elements_result",
      operation: "next",
      status: "error",
      reason: "cursor_expired",
    });
  });

  it("falls back to a full snapshot after navigation invalidates the delta baseline", async () => {
    semanticBrowser();
    const session = await CdpSession.create(7, "semantic");
    await session.captureElements("first", "document", "interactive", 20, false);

    await session.bumpGeneration();
    const next = ok(
      await session.captureElements("next", "document", "interactive", 20, true),
    );

    expect(next.delta).toEqual({
      requested: true,
      applied: false,
      added: 0,
      changed: 0,
      removed: 0,
    });
  });

  it("expires cursors by TTL and evicts the oldest cursor above the active cap", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-03T00:00:00.000Z"));
    semanticBrowser();
    const session = await CdpSession.create(7, "semantic");
    await session.captureElements("snapshot", "document", "interactive", 20, false);

    const cursors: string[] = [];
    for (let index = 0; index < 17; index += 1) {
      const found = ok(
        await session.findElements(
          `find-${index}`,
          "Button",
          ["button"],
          "contains",
          false,
          1,
        ),
      );
      if (found.page.cursor === undefined) throw new Error("missing find cursor");
      cursors.push(found.page.cursor);
    }
    await expect(session.continueElements("evicted", cursors[0]!)).resolves.toMatchObject({
      status: "error",
      reason: "cursor_expired",
    });

    vi.setSystemTime(new Date("2026-08-03T00:10:00.001Z"));
    await expect(session.continueElements("expired", cursors.at(-1)!)).resolves.toMatchObject({
      status: "error",
      reason: "cursor_expired",
    });
    await expect(session.continueElements("invalid", "not-a-cursor")).resolves.toMatchObject({
      status: "error",
      reason: "invalid_cursor",
    });
  });

  it("does not revive refs or cursors after worker eviction", async () => {
    semanticBrowser();
    const firstWorker = await CdpSession.create(7, "semantic");
    const snapshot = ok(
      await firstWorker.captureElements("snapshot", "document", "interactive", 1, false),
    );
    const ref = snapshot.elements[0]?.ref;
    const cursor = snapshot.page.cursor;
    if (ref === undefined || cursor === undefined) throw new Error("missing ref/cursor");

    const restoredWorker = await CdpSession.create(7, "semantic");
    await expect(restoredWorker.inspectElements("inspect", ref, 3, 80, false)).resolves
      .toMatchObject({ status: "error", reason: "snapshot_expired" });
    await expect(restoredWorker.continueElements("next", cursor)).resolves.toMatchObject({
      status: "error",
      reason: "snapshot_expired",
    });
  });

  it("rejects every semantic read before touching page data in sensitive mode", async () => {
    const sendCommand = semanticBrowser();
    const session = await CdpSession.create(7, "semantic");
    session.pinSensitiveOrigin("https://example.test");

    await expect(
      session.captureElements("snapshot", "viewport", "interactive", 80, false),
    ).resolves.toMatchObject({ status: "error", reason: "sensitive_mode" });
    await expect(
      session.findElements("find", "Pay", [], "contains", false, 20),
    ).resolves.toMatchObject({ status: "error", reason: "sensitive_mode" });
    await expect(session.inspectElements("inspect", "ref", 3, 80, false))
      .resolves.toMatchObject({ status: "error", reason: "sensitive_mode" });
    await expect(session.continueElements("next", "0".repeat(32)))
      .resolves.toMatchObject({ status: "error", reason: "sensitive_mode" });
    expect(sendCommand).not.toHaveBeenCalled();
  });
});
