/*
 * Frame capture and stitching adapted from Browserbase Stagehand at
 * 04c8ee48ffb6c0b1eae2f201a6d756b679d46355 (MIT License).
 * See public/THIRD_PARTY_NOTICES.txt.
 */

import { MAX_SEMANTIC_NODES } from "@understudy/protocol";
import type { Protocol } from "devtools-protocol";
import { normalizeSemanticFrames } from "./normalize";
import {
  captureDomFallback,
  captureDomSnapshot,
  type DomCaptureResult,
  type SemanticSend,
} from "./dom";
import type {
  CapturedSemanticFrame,
  FrameTopologyEntry,
  NormalizedSemanticNode,
  SemanticCapture,
} from "./types";

export class SemanticCaptureError extends Error {
  constructor(readonly reason: "capture_failed" | "page_changed" | "page_too_large") {
    super(reason);
  }
}

export interface CaptureSemanticPageInput {
  send: SemanticSend;
  frames: readonly FrameTopologyEntry[];
  mainFrameId: string;
  loaderId: string;
  url: string;
}

const MAX_CAPTURE_AX_NODES = MAX_SEMANTIC_NODES * 2;

function frameScopeFailure(cause: unknown): boolean {
  const message = String(cause instanceof Error ? cause.message : cause);
  return (
    message.includes("Frame with the given") ||
    message.includes("does not belong to the target") ||
    message.includes("is not found")
  );
}

async function captureAxFrame(
  send: SemanticSend,
  frame: FrameTopologyEntry,
  isSessionRoot: boolean,
): Promise<Protocol.Accessibility.AXNode[]> {
  try {
    const response = await send<Protocol.Accessibility.GetFullAXTreeResponse>(
      "Accessibility.getFullAXTree",
      { frameId: frame.frameId },
      frame.debuggerSessionId,
    );
    return response.nodes;
  } catch (cause) {
    if (!frameScopeFailure(cause) || !isSessionRoot) throw cause;
    const response = await send<Protocol.Accessibility.GetFullAXTreeResponse>(
      "Accessibility.getFullAXTree",
      undefined,
      frame.debuggerSessionId,
    );
    return response.nodes;
  }
}

function sessionKey(debuggerSessionId: string | undefined): string {
  return debuggerSessionId ?? "root";
}

function sessionRoot(
  frames: readonly FrameTopologyEntry[],
  debuggerSessionId: string | undefined,
): FrameTopologyEntry {
  const candidates = frames.filter(
    (frame) => frame.debuggerSessionId === debuggerSessionId,
  );
  const candidate = candidates.find((frame) => {
    if (frame.parentFrameId === undefined) return true;
    const parent = frames.find((item) => item.frameId === frame.parentFrameId);
    return parent?.debuggerSessionId !== debuggerSessionId;
  });
  const root = candidate ?? candidates[0];
  if (root === undefined) throw new SemanticCaptureError("capture_failed");
  return root;
}

async function captureDomForSession(
  send: SemanticSend,
  rootFrameId: string,
  debuggerSessionId: string | undefined,
  useViewport: boolean,
): Promise<DomCaptureResult | undefined> {
  try {
    return await captureDomSnapshot(
      send,
      rootFrameId,
      debuggerSessionId,
      useViewport,
    );
  } catch {
    try {
      return await captureDomFallback(send, rootFrameId, debuggerSessionId);
    } catch {
      return undefined;
    }
  }
}

function topologyKey(frames: readonly FrameTopologyEntry[]): string {
  return [...frames]
    .sort((left, right) => left.order - right.order)
    .map(
      (frame) =>
        `${sessionKey(frame.debuggerSessionId)}:${frame.frameId}:${frame.parentFrameId ?? "-"}`,
    )
    .join("|");
}

function restitchFrames(
  nodes: NormalizedSemanticNode[],
  frames: readonly FrameTopologyEntry[],
  owners: DomCaptureResult["frameOwnerByChild"],
): NormalizedSemanticNode[] {
  const byIdentity = new Map(nodes.map((node) => [node.identity, node]));
  const frameRoots = new Map<string, NormalizedSemanticNode[]>();
  for (const node of nodes) {
    if (node.parentIdentity !== undefined) continue;
    const roots = frameRoots.get(node.frameId) ?? [];
    roots.push(node);
    frameRoots.set(node.frameId, roots);
  }

  for (const frame of [...frames].sort((left, right) => left.order - right.order)) {
    if (frame.parentFrameId === undefined) continue;
    const owner = owners.get(frame.frameId);
    if (owner === undefined) continue;
    const parentFrame = frames.find((candidate) => candidate.frameId === owner.parentFrameId);
    const parentIdentity = `be:${sessionKey(
      owner.debuggerSessionId ?? parentFrame?.debuggerSessionId,
    )}:${owner.parentFrameId}:${owner.backendNodeId}`;
    const parent = byIdentity.get(parentIdentity);
    if (parent === undefined) continue;
    for (const root of frameRoots.get(frame.frameId) ?? []) {
      root.parentIdentity = parent.identity;
      if (!parent.childIdentities.includes(root.identity)) {
        parent.childIdentities.push(root.identity);
      }
    }
  }

  const childrenByParent = new Map<string, NormalizedSemanticNode[]>();
  for (const node of nodes) {
    if (node.parentIdentity === undefined) continue;
    const children = childrenByParent.get(node.parentIdentity) ?? [];
    children.push(node);
    childrenByParent.set(node.parentIdentity, children);
  }
  const stack = nodes
    .filter((node) => node.parentIdentity === undefined)
    .reverse()
    .map((node) => ({ node, depth: 0 }));
  const visited = new Set<string>();
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (visited.has(current.node.identity)) continue;
    visited.add(current.node.identity);
    current.node.descriptor = { ...current.node.descriptor, depth: current.depth };
    const children = childrenByParent.get(current.node.identity) ?? [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({ node: children[index]!, depth: current.depth + 1 });
    }
  }
  return nodes;
}

export async function captureSemanticPage(
  input: CaptureSemanticPageInput,
): Promise<SemanticCapture> {
  const frames = [...input.frames].sort((left, right) => left.order - right.order);
  if (frames.length === 0 || !frames.some((frame) => frame.frameId === input.mainFrameId)) {
    throw new SemanticCaptureError("capture_failed");
  }

  const sessions = new Map<string, string | undefined>();
  for (const frame of frames) sessions.set(sessionKey(frame.debuggerSessionId), frame.debuggerSessionId);
  const domBySession = new Map<string, DomCaptureResult>();
  const sessionRootFrames = new Map<string, string>();
  const owners: DomCaptureResult["frameOwnerByChild"] = new Map();
  let coverage: SemanticCapture["coverage"] = "complete";

  for (const [key, debuggerSessionId] of sessions) {
    const root = sessionRoot(frames, debuggerSessionId);
    sessionRootFrames.set(key, root.frameId);
    const dom = await captureDomForSession(
      input.send,
      root.frameId,
      debuggerSessionId,
      root.frameId === input.mainFrameId,
    );
    if (dom === undefined) {
      coverage = "partial";
      continue;
    }
    domBySession.set(key, dom);
    for (const [childFrameId, owner] of dom.frameOwnerByChild) {
      owners.set(childFrameId, owner);
    }
  }

  for (const frame of frames) {
    if (frame.parentFrameId === undefined || owners.has(frame.frameId)) continue;
    const parent = frames.find((candidate) => candidate.frameId === frame.parentFrameId);
    if (parent === undefined) {
      coverage = "partial";
      continue;
    }
    try {
      const owner = await input.send<{ backendNodeId?: number }>(
        "DOM.getFrameOwner",
        { frameId: frame.frameId },
        parent.debuggerSessionId,
      );
      if (typeof owner.backendNodeId !== "number") {
        coverage = "partial";
        continue;
      }
      owners.set(frame.frameId, {
        parentFrameId: parent.frameId,
        backendNodeId: owner.backendNodeId,
        ...(parent.debuggerSessionId === undefined
          ? {}
          : { debuggerSessionId: parent.debuggerSessionId }),
      });
    } catch {
      coverage = "partial";
    }
  }

  const capturedFrames: CapturedSemanticFrame[] = [];
  for (const frame of frames) {
    try {
      const axNodes = await captureAxFrame(
        input.send,
        frame,
        sessionRootFrames.get(sessionKey(frame.debuggerSessionId)) === frame.frameId,
      );
      const dom = domBySession
        .get(sessionKey(frame.debuggerSessionId))
        ?.byFrame.get(frame.frameId);
      if (dom === undefined) coverage = "partial";
      capturedFrames.push({
        ...frame,
        axNodes,
        domByBackend: dom ?? new Map(),
        failed: false,
      });
    } catch {
      if (frame.frameId === input.mainFrameId) {
        throw new SemanticCaptureError("capture_failed");
      }
      coverage = "partial";
      capturedFrames.push({
        ...frame,
        axNodes: [],
        domByBackend: new Map(),
        failed: true,
      });
    }
  }

  const axNodeCount = capturedFrames.reduce(
    (total, frame) => total + frame.axNodes.length,
    0,
  );
  if (axNodeCount > MAX_CAPTURE_AX_NODES) {
    throw new SemanticCaptureError("page_too_large");
  }
  return {
    loaderId: input.loaderId,
    url: input.url,
    topologyKey: topologyKey(frames),
    capturedAt: new Date().toISOString(),
    coverage,
    nodes: restitchFrames(normalizeSemanticFrames(capturedFrames), frames, owners),
  };
}
