import { describe, expect, it, vi } from "vitest";
import type { Protocol } from "devtools-protocol";
import {
  allowlistedDomMetadata,
  captureDomFallback,
  captureDomSnapshot,
  getDomTreeWithFallback,
  type SemanticSend,
} from "./dom";

function node(
  value: Partial<Protocol.DOM.Node> & Pick<Protocol.DOM.Node, "nodeId" | "backendNodeId">,
): Protocol.DOM.Node {
  return {
    nodeType: 1,
    nodeName: "DIV",
    localName: "div",
    nodeValue: "",
    ...value,
  } as Protocol.DOM.Node;
}

describe("DOM semantic capture", () => {
  it("bounds page-controlled form hints to their public schema limits", () => {
    const metadata = allowlistedDomMetadata(
      node({
        nodeId: 1,
        backendNodeId: 1,
        nodeName: "INPUT",
        attributes: ["type", "x".repeat(300), "placeholder", "y".repeat(800)],
      }),
    );

    expect(new TextEncoder().encode(metadata.inputType).byteLength).toBe(128);
    expect(new TextEncoder().encode(metadata.placeholder).byteLength).toBe(512);
  });

  it("reads only allowlisted metadata from DOMSnapshot and computes viewport visibility", async () => {
    const send = vi.fn(async (method: string, params: unknown) => {
      if (method === "Page.getLayoutMetrics") {
        return {
          cssVisualViewport: {
            offsetX: 0,
            offsetY: 0,
            pageX: 0,
            pageY: 100,
            clientWidth: 800,
            clientHeight: 600,
            scale: 1,
            zoom: 1,
          },
        };
      }
      expect(params).toEqual({
        computedStyles: [],
        includePaintOrder: false,
        includeDOMRects: false,
        includeBlendedBackgroundColors: false,
        includeTextColorOpacities: false,
      });
      return {
        strings: [
          "main",
          "INPUT",
          "type",
          "password",
          "placeholder",
          "Secret field",
          "autocomplete",
          "current-password",
          "id",
          "private-id",
          "value",
          "private-value",
        ],
        documents: [
          {
            frameId: 0,
            scrollOffsetX: 0,
            scrollOffsetY: 100,
            nodes: {
              backendNodeId: [17],
              nodeName: [1],
              parentIndex: [-1],
              attributes: [[2, 3, 4, 5, 6, 7, 8, 9, 10, 11]],
              isClickable: { index: [0] },
            },
            layout: { nodeIndex: [0], bounds: [[10, 120, 200, 40]], styles: [[]] },
            textBoxes: { layoutIndex: [], bounds: [], start: [], length: [] },
          },
        ],
      };
    }) as unknown as SemanticSend;

    const result = await captureDomSnapshot(send, "main");
    const captured = result.byFrame.get("main")?.get(17);

    expect(captured).toMatchObject({
      tagName: "input",
      inputType: "password",
      placeholder: "Secret field",
      autocomplete: "current-password",
      clickable: true,
      visibility: "viewport",
      bounds: { x: 10, y: 20, width: 200, height: 40 },
    });
    expect(JSON.stringify(captured)).not.toContain("private-id");
    expect(JSON.stringify(captured)).not.toContain("private-value");
  });

  it("adapts document depth after a CBOR stack failure and hydrates truncated nodes", async () => {
    const root = node({
      nodeId: 1,
      backendNodeId: 1,
      childNodeCount: 1,
      children: [],
    });
    const child = node({ nodeId: 2, backendNodeId: 2, nodeName: "BUTTON" });
    const calls: Array<{ method: string; params: unknown }> = [];
    const send = vi.fn(async (method: string, params: unknown) => {
      calls.push({ method, params });
      if (method === "DOM.getDocument" && (params as { depth: number }).depth === -1) {
        throw new Error("CBOR: stack limit exceeded");
      }
      if (method === "DOM.getDocument") return { root };
      return { node: { ...root, children: [child] } };
    }) as unknown as SemanticSend;

    await expect(getDomTreeWithFallback(send)).resolves.toMatchObject({
      children: [{ backendNodeId: 2 }],
    });
    expect(calls.slice(0, 2)).toEqual([
      { method: "DOM.getDocument", params: { depth: -1, pierce: true } },
      { method: "DOM.getDocument", params: { depth: 256, pierce: true } },
    ]);
    expect(calls.some((call) => call.method === "DOM.describeNode")).toBe(true);
  });

  it("skips invalid backend IDs in the fallback tree", async () => {
    const send = vi.fn(async () => ({
      root: node({
        nodeId: 0,
        backendNodeId: 0,
        children: [node({ nodeId: 2, backendNodeId: 22, nodeName: "BUTTON" })],
      }),
    })) as unknown as SemanticSend;

    const result = await captureDomFallback(send, "main");
    expect(result.byFrame.get("main")?.has(0)).toBe(false);
    expect(result.byFrame.get("main")?.get(22)?.parentBackendNodeId).toBeUndefined();
  });

  it("iteratively walks a deeply nested fallback tree", async () => {
    let root = node({ nodeId: 25_001, backendNodeId: 25_001 });
    for (let id = 25_000; id >= 1; id -= 1) {
      root = node({ nodeId: id, backendNodeId: id, children: [root] });
    }
    const send = vi.fn(async () => ({ root })) as unknown as SemanticSend;

    const result = await captureDomFallback(send, "main");

    expect(result.byFrame.get("main")?.size).toBe(25_001);
    expect(result.byFrame.get("main")?.get(25_001)?.parentBackendNodeId).toBe(25_000);
  });

  it("maps fallback iframe owners using the content document frame", async () => {
    const iframe = node({
      nodeId: 2,
      backendNodeId: 22,
      nodeName: "IFRAME",
      frameId: "main",
      contentDocument: node({
        nodeId: 3,
        backendNodeId: 33,
        nodeName: "#document",
        frameId: "child",
      }),
    });
    const send = vi.fn(async () => ({
      root: node({ nodeId: 1, backendNodeId: 11, children: [iframe] }),
    })) as unknown as SemanticSend;

    const result = await captureDomFallback(send, "main");

    expect(result.byFrame.get("child")?.has(33)).toBe(true);
    expect(result.frameOwnerByChild.get("child")).toMatchObject({
      parentFrameId: "main",
      backendNodeId: 22,
    });
  });
});
