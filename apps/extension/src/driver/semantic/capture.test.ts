import { describe, expect, it, vi } from "vitest";
import { MAX_SEMANTIC_NODES } from "@understudy/protocol";
import type { Protocol } from "devtools-protocol";
import { captureSemanticPage, SemanticCaptureError } from "./capture";
import type { SemanticSend } from "./dom";

function axTree(frameId: string, backendNodeId: number, role = "button") {
  return {
    nodes: [
      {
        nodeId: `${frameId}-root`,
        ignored: false,
        role: { type: "role", value: "RootWebArea" },
        childIds: [`${frameId}-element`],
      },
      {
        nodeId: `${frameId}-element`,
        ignored: false,
        role: { type: "role", value: role },
        name: { type: "computedString", value: frameId },
        backendDOMNodeId: backendNodeId,
      },
    ] as Protocol.Accessibility.AXNode[],
  };
}

function snapshot(
  frames: ReadonlyArray<{
    frameId: string;
    backendIds: number[];
    nodeNames: string[];
    contentDocument?: { nodeIndex: number; documentIndex: number };
  }>,
) {
  const strings: string[] = [];
  const index = (value: string): number => {
    const existing = strings.indexOf(value);
    if (existing >= 0) return existing;
    strings.push(value);
    return strings.length - 1;
  };
  return {
    strings,
    documents: frames.map((frame) => ({
      frameId: index(frame.frameId),
      scrollOffsetX: 0,
      scrollOffsetY: 0,
      nodes: {
        backendNodeId: frame.backendIds,
        nodeName: frame.nodeNames.map(index),
        parentIndex: frame.backendIds.map((_value, nodeIndex) => nodeIndex - 1),
        attributes: frame.backendIds.map(() => []),
        isClickable: { index: frame.backendIds.map((_value, nodeIndex) => nodeIndex) },
        ...(frame.contentDocument === undefined
          ? {}
          : {
              contentDocumentIndex: {
                index: [frame.contentDocument.nodeIndex],
                value: [frame.contentDocument.documentIndex],
              },
            }),
      },
      layout: {
        nodeIndex: frame.backendIds.map((_value, nodeIndex) => nodeIndex),
        bounds: frame.backendIds.map((_value, nodeIndex) => [nodeIndex * 20, 0, 10, 10]),
        styles: frame.backendIds.map(() => []),
      },
      textBoxes: { layoutIndex: [], bounds: [], start: [], length: [] },
    })),
  };
}

describe("hybrid semantic capture", () => {
  it("fails with page_too_large before normalizing an excessive AX surface", async () => {
    const send = vi.fn(async (method: string) => {
      if (method === "DOMSnapshot.captureSnapshot" || method === "DOM.getDocument") {
        throw new Error("DOM unavailable");
      }
      if (method === "Accessibility.getFullAXTree") {
        return {
          nodes: Array.from({ length: MAX_SEMANTIC_NODES * 2 + 1 }, (_, index) => ({
            nodeId: `node-${index}`,
            ignored: false,
            role: { type: "role", value: "StaticText" },
            name: { type: "computedString", value: `Node ${index}` },
          })),
        };
      }
      return {};
    }) as unknown as SemanticSend;

    await expect(
      captureSemanticPage({
        send,
        mainFrameId: "main",
        loaderId: "loader",
        url: "https://example.test/",
        frames: [{ frameId: "main", order: 0 }],
      }),
    ).rejects.toEqual(new SemanticCaptureError("page_too_large"));
  });

  it("deduplicates DOM capture by debugger session and stitches same-process and OOPIF trees", async () => {
    const rootSnapshot = snapshot([
      {
        frameId: "main",
        backendIds: [1, 10, 11],
        nodeNames: ["HTML", "IFRAME", "IFRAME"],
        contentDocument: { nodeIndex: 1, documentIndex: 1 },
      },
      {
        frameId: "same-child",
        backendIds: [2, 20],
        nodeNames: ["HTML", "BUTTON"],
      },
    ]);
    const oopifSnapshot = snapshot([
      {
        frameId: "oopif",
        backendIds: [3, 30],
        nodeNames: ["HTML", "BUTTON"],
      },
    ]);
    const send = vi.fn(
      async (
        method: string,
        params: { frameId?: string } | undefined,
        debuggerSessionId?: string,
      ) => {
        if (method === "DOMSnapshot.captureSnapshot") {
          return debuggerSessionId === "oopif-session" ? oopifSnapshot : rootSnapshot;
        }
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
        if (method === "DOM.getFrameOwner") return { backendNodeId: 11 };
        if (method === "Accessibility.getFullAXTree") {
          if (params?.frameId === "main") {
            return {
              nodes: [
                {
                  nodeId: "main-root",
                  ignored: false,
                  role: { type: "role", value: "RootWebArea" },
                  childIds: ["same-owner", "oopif-owner"],
                },
                {
                  nodeId: "same-owner",
                  ignored: false,
                  role: { type: "role", value: "iframe" },
                  name: { type: "computedString", value: "same owner" },
                  backendDOMNodeId: 10,
                },
                {
                  nodeId: "oopif-owner",
                  ignored: false,
                  role: { type: "role", value: "iframe" },
                  name: { type: "computedString", value: "oopif owner" },
                  backendDOMNodeId: 11,
                },
              ],
            };
          }
          if (params?.frameId === "same-child") return axTree("same-child", 20);
          return axTree("oopif", 30);
        }
        throw new Error(`unexpected ${method}`);
      },
    ) as unknown as SemanticSend;

    const captured = await captureSemanticPage({
      send,
      mainFrameId: "main",
      loaderId: "loader",
      url: "https://example.test/",
      frames: [
        { frameId: "main", order: 0 },
        { frameId: "same-child", parentFrameId: "main", order: 1 },
        {
          frameId: "oopif",
          parentFrameId: "main",
          debuggerSessionId: "oopif-session",
          order: 2,
        },
      ],
    });

    expect(
      vi.mocked(send).mock.calls.filter((call) => call[0] === "DOMSnapshot.captureSnapshot"),
    ).toHaveLength(2);
    expect(
      vi.mocked(send).mock.calls.filter((call) => call[0] === "Accessibility.getFullAXTree"),
    ).toHaveLength(3);
    expect(captured.coverage).toBe("complete");
    const sameOwner = captured.nodes.find((node) => node.backendNodeId === 10);
    const oopifOwner = captured.nodes.find((node) => node.backendNodeId === 11);
    expect(captured.nodes.find((node) => node.backendNodeId === 20)?.parentIdentity)
      .toBe(sameOwner?.identity);
    expect(captured.nodes.find((node) => node.backendNodeId === 30)?.parentIdentity)
      .toBe(oopifOwner?.identity);
    expect(captured.nodes.find((node) => node.backendNodeId === 30)?.descriptor)
      .toMatchObject({ visibility: "unknown" });
    expect(captured.nodes.find((node) => node.backendNodeId === 30)?.descriptor.bounds)
      .toBeUndefined();
  });

  it("never substitutes a session-root AX tree for a failed same-process child", async () => {
    const send = vi.fn(async (method: string, params?: { frameId?: string }) => {
      if (method === "DOMSnapshot.captureSnapshot") throw new Error("DOM unavailable");
      if (method === "DOM.getDocument") throw new Error("DOM unavailable");
      if (method === "DOM.getFrameOwner") throw new Error("owner unavailable");
      if (method === "Accessibility.getFullAXTree" && params?.frameId === "main") {
        return axTree("main", 1);
      }
      if (method === "Accessibility.getFullAXTree" && params?.frameId === "child") {
        throw new Error("Frame with the given id is not found");
      }
      if (method === "Accessibility.getFullAXTree") return axTree("wrong-root", 99);
      return {};
    }) as unknown as SemanticSend;

    const captured = await captureSemanticPage({
      send,
      mainFrameId: "main",
      loaderId: "loader",
      url: "https://example.test/",
      frames: [
        { frameId: "main", order: 0 },
        { frameId: "child", parentFrameId: "main", order: 1 },
      ],
    });

    expect(captured.coverage).toBe("partial");
    expect(captured.nodes.some((node) => node.backendNodeId === 99)).toBe(false);
    expect(
      vi.mocked(send).mock.calls.filter(
        (call) => call[0] === "Accessibility.getFullAXTree" && call[1] === undefined,
      ),
    ).toHaveLength(0);
  });

  it("returns a bounded placeholder for a failed child frame", async () => {
    const send = vi.fn(async (method: string, params?: { frameId?: string }) => {
      if (method === "DOMSnapshot.captureSnapshot") throw new Error("DOM unavailable");
      if (method === "DOM.getDocument") throw new Error("DOM unavailable");
      if (method === "DOM.getFrameOwner") throw new Error("owner unavailable");
      if (method === "Accessibility.getFullAXTree" && params?.frameId === "child") {
        throw new Error("child AX unavailable");
      }
      if (method === "Accessibility.getFullAXTree") return axTree("main", 1);
      return {};
    }) as unknown as SemanticSend;

    const captured = await captureSemanticPage({
      send,
      mainFrameId: "main",
      loaderId: "loader",
      url: "https://example.test/",
      frames: [
        { frameId: "main", order: 0 },
        { frameId: "child", parentFrameId: "main", order: 1 },
      ],
    });

    expect(captured.coverage).toBe("partial");
    const placeholder = captured.nodes.find(
      (node) => node.descriptor.name === "Unavailable frame",
    );
    expect(placeholder?.backendNodeId).toBeUndefined();
    expect(placeholder?.descriptor).toMatchObject({ role: "iframe", actions: [] });
  });

  it("fails closed when the main-frame AX capture fails", async () => {
    const send = vi.fn(async (method: string) => {
      if (method === "Accessibility.getFullAXTree") throw new Error("main AX unavailable");
      throw new Error("DOM unavailable");
    }) as unknown as SemanticSend;

    await expect(
      captureSemanticPage({
        send,
        mainFrameId: "main",
        loaderId: "loader",
        url: "https://example.test/",
        frames: [{ frameId: "main", order: 0 }],
      }),
    ).rejects.toEqual(new SemanticCaptureError("capture_failed"));
  });
});
