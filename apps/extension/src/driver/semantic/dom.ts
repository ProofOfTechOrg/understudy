/*
 * Portions adapted from Browserbase Stagehand at
 * 04c8ee48ffb6c0b1eae2f201a6d756b679d46355 (MIT License).
 * See public/THIRD_PARTY_NOTICES.txt.
 */

import { MAX_SEMANTIC_NODES } from "@understudy/protocol";
import type { Protocol } from "devtools-protocol";
import { normalizePageString } from "./normalize";
import type { SafeDomNode } from "./types";

const DOM_DEPTH_ATTEMPTS = [-1, 256, 128, 64, 32, 16, 8, 4, 2, 1];
const DESCRIBE_DEPTH_ATTEMPTS = [-1, 64, 32, 16, 8, 4, 2, 1];
const MAX_DOM_FALLBACK_NODES = MAX_SEMANTIC_NODES * 2;

export type SemanticSend = <R>(
  method: string,
  params: Record<string, unknown> | undefined,
  debuggerSessionId?: string,
) => Promise<R>;

export interface DomCaptureResult {
  byFrame: Map<string, Map<number, SafeDomNode>>;
  frameOwnerByChild: Map<
    string,
    { parentFrameId: string; backendNodeId: number; debuggerSessionId?: string }
  >;
}

function isCborStackError(cause: unknown): boolean {
  return String(cause instanceof Error ? cause.message : cause).includes(
    "CBOR: stack limit exceeded",
  );
}

function shouldExpandNode(node: Protocol.DOM.Node): boolean {
  return (node.childNodeCount ?? 0) > (node.children?.length ?? 0);
}

function mergeDomNodes(target: Protocol.DOM.Node, source: Protocol.DOM.Node): void {
  target.childNodeCount = source.childNodeCount ?? target.childNodeCount;
  target.children = source.children ?? target.children;
  target.shadowRoots = source.shadowRoots ?? target.shadowRoots;
  target.contentDocument = source.contentDocument ?? target.contentDocument;
}

function traversalTargets(node: Protocol.DOM.Node): Protocol.DOM.Node[] {
  return [
    ...(node.children ?? []),
    ...(node.shadowRoots ?? []),
    ...(node.contentDocument === undefined ? [] : [node.contentDocument]),
    ...(node.templateContent === undefined ? [] : [node.templateContent]),
    ...(node.pseudoElements ?? []),
  ];
}

async function hydrateDomTree(
  send: SemanticSend,
  debuggerSessionId: string | undefined,
  root: Protocol.DOM.Node,
): Promise<void> {
  const stack = [root];
  const expandedNodeIds = new Set<number>();
  const expandedBackendIds = new Set<number>();
  while (stack.length > 0) {
    const node = stack.pop()!;
    const nodeId = node.nodeId > 0 ? node.nodeId : undefined;
    const backendNodeId = node.backendNodeId > 0 ? node.backendNodeId : undefined;
    if (
      (nodeId !== undefined && expandedNodeIds.has(nodeId)) ||
      (nodeId === undefined &&
        backendNodeId !== undefined &&
        expandedBackendIds.has(backendNodeId))
    ) {
      continue;
    }
    if (nodeId !== undefined) expandedNodeIds.add(nodeId);
    else if (backendNodeId !== undefined) expandedBackendIds.add(backendNodeId);

    if (shouldExpandNode(node) && (nodeId !== undefined || backendNodeId !== undefined)) {
      let expanded = false;
      for (const depth of DESCRIBE_DEPTH_ATTEMPTS) {
        try {
          const described = await send<Protocol.DOM.DescribeNodeResponse>(
            "DOM.describeNode",
            {
              ...(nodeId === undefined ? { backendNodeId } : { nodeId }),
              depth,
              pierce: true,
            },
            debuggerSessionId,
          );
          mergeDomNodes(node, described.node);
          expanded = true;
          break;
        } catch (cause) {
          if (!isCborStackError(cause)) throw cause;
        }
      }
      if (!expanded) throw new Error("DOM.describeNode depth fallbacks exhausted");
    }
    stack.push(...traversalTargets(node));
  }
}

export async function getDomTreeWithFallback(
  send: SemanticSend,
  debuggerSessionId?: string,
): Promise<Protocol.DOM.Node> {
  for (const depth of DOM_DEPTH_ATTEMPTS) {
    try {
      const { root } = await send<Protocol.DOM.GetDocumentResponse>(
        "DOM.getDocument",
        { depth, pierce: true },
        debuggerSessionId,
      );
      if (depth !== -1) await hydrateDomTree(send, debuggerSessionId, root);
      return root;
    } catch (cause) {
      if (!isCborStackError(cause)) throw cause;
    }
  }
  throw new Error("DOM.getDocument depth fallbacks exhausted");
}

function safeAttributes(
  attributes: readonly string[] | undefined,
): { inputType?: string; placeholder?: string; autocomplete?: string } {
  let inputType: string | undefined;
  let placeholder: string | undefined;
  let autocomplete: string | undefined;
  for (let index = 0; index < (attributes?.length ?? 0); index += 2) {
    const name = attributes?.[index]?.toLowerCase();
    if (name !== "type" && name !== "placeholder" && name !== "autocomplete") continue;
    const value = normalizePageString(
      attributes?.[index + 1],
      name === "type" ? 128 : 512,
    );
    if (name === "type") inputType = value;
    else if (name === "placeholder") placeholder = value;
    else autocomplete = value;
  }
  return {
    ...(inputType === undefined ? {} : { inputType }),
    ...(placeholder === undefined ? {} : { placeholder }),
    ...(autocomplete === undefined ? {} : { autocomplete }),
  };
}

function indexedAttributes(
  indexes: readonly number[] | undefined,
  strings: readonly string[],
): { inputType?: string; placeholder?: string; autocomplete?: string } {
  if (indexes === undefined) return {};
  let inputType: string | undefined;
  let placeholder: string | undefined;
  let autocomplete: string | undefined;
  for (let index = 0; index < indexes.length; index += 2) {
    const name = strings[indexes[index] ?? -1]?.toLowerCase();
    if (name !== "type" && name !== "placeholder" && name !== "autocomplete") continue;
    const value = normalizePageString(
      strings[indexes[index + 1] ?? -1],
      name === "type" ? 128 : 512,
    );
    if (name === "type") inputType = value;
    else if (name === "placeholder") placeholder = value;
    else autocomplete = value;
  }
  return {
    ...(inputType === undefined ? {} : { inputType }),
    ...(placeholder === undefined ? {} : { placeholder }),
    ...(autocomplete === undefined ? {} : { autocomplete }),
  };
}

function safeTagName(value: unknown): string | undefined {
  return normalizePageString(value)?.toLowerCase();
}

export function allowlistedDomMetadata(node: Protocol.DOM.Node): {
  tagName?: string;
  inputType?: string;
  placeholder?: string;
  autocomplete?: string;
  scrollable: boolean;
} {
  const tagName = safeTagName(node.nodeName);
  return {
    ...(tagName === undefined ? {} : { tagName }),
    ...safeAttributes(node.attributes),
    scrollable: node.isScrollable === true,
  };
}

function rareBooleanIndexes(data: Protocol.DOMSnapshot.RareBooleanData | undefined): Set<number> {
  return new Set(data?.index ?? []);
}

function rareIntegerMap(
  data: Protocol.DOMSnapshot.RareIntegerData | undefined,
): Map<number, number> {
  return new Map(
    (data?.index ?? []).map((index, offset) => [index, data?.value[offset] ?? -1]),
  );
}

function finiteBounds(
  value: readonly number[] | undefined,
): { x: number; y: number; width: number; height: number } | undefined {
  if (value === undefined || value.length < 4) return undefined;
  const [x, y, width, height] = value;
  if (
    x === undefined ||
    y === undefined ||
    width === undefined ||
    height === undefined ||
    ![x, y, width, height].every(Number.isFinite)
  ) {
    return undefined;
  }
  return { x, y, width: Math.max(0, width), height: Math.max(0, height) };
}

function visibilityAndBounds(
  bounds: { x: number; y: number; width: number; height: number } | undefined,
  document: Protocol.DOMSnapshot.DocumentSnapshot,
  viewport: { x: number; y: number; width: number; height: number } | undefined,
): Pick<SafeDomNode, "visibility" | "bounds"> {
  if (bounds === undefined || viewport === undefined) return { visibility: "unknown" };
  if (bounds.width === 0 || bounds.height === 0) return { visibility: "hidden" };
  const scrollX = document.scrollOffsetX ?? viewport.x;
  const scrollY = document.scrollOffsetY ?? viewport.y;
  const relative = {
    x: bounds.x - scrollX,
    y: bounds.y - scrollY,
    width: bounds.width,
    height: bounds.height,
  };
  const intersects =
    relative.x + relative.width > 0 &&
    relative.y + relative.height > 0 &&
    relative.x < viewport.width &&
    relative.y < viewport.height;
  return { visibility: intersects ? "viewport" : "offscreen", bounds: relative };
}

export async function captureDomSnapshot(
  send: SemanticSend,
  rootFrameId: string,
  debuggerSessionId?: string,
  useViewport = true,
): Promise<DomCaptureResult> {
  const [snapshot, metrics] = await Promise.all([
    send<Protocol.DOMSnapshot.CaptureSnapshotResponse>(
      "DOMSnapshot.captureSnapshot",
      {
        computedStyles: [],
        includePaintOrder: false,
        includeDOMRects: false,
        includeBlendedBackgroundColors: false,
        includeTextColorOpacities: false,
      },
      debuggerSessionId,
    ),
    useViewport
      ? send<Protocol.Page.GetLayoutMetricsResponse>(
          "Page.getLayoutMetrics",
          undefined,
          debuggerSessionId,
        ).catch(() => undefined)
      : Promise.resolve(undefined),
  ]);
  const visualViewport = metrics?.cssVisualViewport;
  const viewport =
    visualViewport === undefined
      ? undefined
      : {
          x: visualViewport.pageX,
          y: visualViewport.pageY,
          width: visualViewport.clientWidth,
          height: visualViewport.clientHeight,
        };
  const byFrame = new Map<string, Map<number, SafeDomNode>>();
  const frameOwnerByChild: DomCaptureResult["frameOwnerByChild"] = new Map();
  const frameIdByDocument = snapshot.documents.map(
    (document) => snapshot.strings[document.frameId] || rootFrameId,
  );
  let nextOrder = 0;

  snapshot.documents.forEach((document, documentIndex) => {
    const frameId = frameIdByDocument[documentIndex] ?? rootFrameId;
    const nodes = document.nodes;
    const backendIds = nodes.backendNodeId ?? [];
    const parentIndexes = nodes.parentIndex ?? [];
    const layoutByNode = new Map(
      document.layout.nodeIndex.map((nodeIndex, layoutIndex) => [
        nodeIndex,
        finiteBounds(document.layout.bounds[layoutIndex]),
      ]),
    );
    const clickables = rareBooleanIndexes(nodes.isClickable);
    const contentDocuments = rareIntegerMap(nodes.contentDocumentIndex);
    const frameNodes = byFrame.get(frameId) ?? new Map<number, SafeDomNode>();
    byFrame.set(frameId, frameNodes);

    for (let nodeIndex = 0; nodeIndex < backendIds.length; nodeIndex += 1) {
      const backendNodeId = backendIds[nodeIndex];
      if (backendNodeId === undefined || backendNodeId <= 0) continue;
      const attributes = indexedAttributes(nodes.attributes?.[nodeIndex], snapshot.strings);
      const parentIndex = parentIndexes[nodeIndex];
      const parentBackendNodeId =
        parentIndex === undefined || parentIndex < 0 ? undefined : backendIds[parentIndex];
      const tagName = safeTagName(snapshot.strings[nodes.nodeName?.[nodeIndex] ?? -1]);
      const visibility = visibilityAndBounds(
        layoutByNode.get(nodeIndex),
        document,
        frameId === rootFrameId ? viewport : undefined,
      );
      frameNodes.set(backendNodeId, {
        backendNodeId,
        frameId,
        ...(debuggerSessionId === undefined ? {} : { debuggerSessionId }),
        ...(parentBackendNodeId === undefined ? {} : { parentBackendNodeId }),
        ...(tagName === undefined ? {} : { tagName }),
        ...attributes,
        clickable: clickables.has(nodeIndex),
        scrollable: false,
        domOrder: nextOrder++,
        ...visibility,
      });

      const childDocumentIndex = contentDocuments.get(nodeIndex);
      const childFrameId =
        childDocumentIndex === undefined ? undefined : frameIdByDocument[childDocumentIndex];
      if (childFrameId !== undefined) {
        frameOwnerByChild.set(childFrameId, {
          parentFrameId: frameId,
          backendNodeId,
          ...(debuggerSessionId === undefined ? {} : { debuggerSessionId }),
        });
      }
    }
  });

  return { byFrame, frameOwnerByChild };
}

export async function captureDomFallback(
  send: SemanticSend,
  rootFrameId: string,
  debuggerSessionId?: string,
): Promise<DomCaptureResult> {
  const root = await getDomTreeWithFallback(send, debuggerSessionId);
  const byFrame = new Map<string, Map<number, SafeDomNode>>();
  const frameOwnerByChild: DomCaptureResult["frameOwnerByChild"] = new Map();
  let order = 0;

  const stack: Array<{
    node: Protocol.DOM.Node;
    frameId: string;
    parentBackendNodeId?: number;
  }> = [{ node: root, frameId: rootFrameId }];
  const visited = new Set<string>();
  while (stack.length > 0) {
    const { node, frameId, parentBackendNodeId } = stack.pop()!;
    const visitKey = `${frameId}:${node.nodeId}:${node.backendNodeId}`;
    if (visited.has(visitKey)) continue;
    if (visited.size >= MAX_DOM_FALLBACK_NODES) {
      throw new Error("DOM fallback node limit exceeded");
    }
    visited.add(visitKey);
    const tagName = safeTagName(node.nodeName);
    const frameNodes = byFrame.get(frameId) ?? new Map<number, SafeDomNode>();
    byFrame.set(frameId, frameNodes);
    if (node.backendNodeId > 0) {
      frameNodes.set(node.backendNodeId, {
        backendNodeId: node.backendNodeId,
        frameId,
        ...(debuggerSessionId === undefined ? {} : { debuggerSessionId }),
        ...(parentBackendNodeId === undefined ? {} : { parentBackendNodeId }),
        ...(tagName === undefined ? {} : { tagName }),
        ...safeAttributes(node.attributes),
        clickable: false,
        scrollable: node.isScrollable === true,
        domOrder: order++,
        visibility: "unknown",
      });
    }

    const nextParent = node.backendNodeId > 0 ? node.backendNodeId : parentBackendNodeId;
    const descendants: Array<{
      node: Protocol.DOM.Node;
      frameId: string;
      parentBackendNodeId?: number;
    }> = [
      ...(node.children ?? []).map((child) => ({
        node: child,
        frameId,
        ...(nextParent === undefined ? {} : { parentBackendNodeId: nextParent }),
      })),
      ...(node.shadowRoots ?? []).map((shadowRoot) => ({
        node: shadowRoot,
        frameId,
        ...(nextParent === undefined ? {} : { parentBackendNodeId: nextParent }),
      })),
      ...(node.templateContent === undefined
        ? []
        : [
            {
              node: node.templateContent,
              frameId,
              ...(nextParent === undefined ? {} : { parentBackendNodeId: nextParent }),
            },
          ]),
    ];
    if (node.contentDocument !== undefined) {
      const childFrameId = node.contentDocument.frameId ?? node.frameId ?? frameId;
      if (childFrameId !== frameId && node.backendNodeId > 0) {
        frameOwnerByChild.set(childFrameId, {
          parentFrameId: frameId,
          backendNodeId: node.backendNodeId,
          ...(debuggerSessionId === undefined ? {} : { debuggerSessionId }),
        });
      }
      descendants.push({ node: node.contentDocument, frameId: childFrameId });
    }
    for (let index = descendants.length - 1; index >= 0; index -= 1) {
      stack.push(descendants[index]!);
    }
  }
  return { byFrame, frameOwnerByChild };
}
