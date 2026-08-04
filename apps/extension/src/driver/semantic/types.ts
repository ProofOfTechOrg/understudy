import type {
  ElementAction,
  ElementDescriptor,
  ElementSnapshot,
  ElementVisibility,
} from "@understudy/protocol";
import type { Protocol } from "devtools-protocol";

export interface DebuggerFrameSession {
  sessionId?: string;
  targetId: string;
  frameId: string;
  parentSessionId?: string;
  targetType: "page" | "iframe";
  ready: boolean;
}

export interface FrameTopologyEntry {
  frameId: string;
  parentFrameId?: string;
  debuggerSessionId?: string;
  order: number;
}

export interface SafeDomNode {
  backendNodeId: number;
  frameId: string;
  debuggerSessionId?: string;
  parentBackendNodeId?: number;
  tagName?: string;
  inputType?: string;
  placeholder?: string;
  autocomplete?: string;
  clickable: boolean;
  scrollable: boolean;
  domOrder: number;
  visibility: ElementVisibility;
  bounds?: { x: number; y: number; width: number; height: number };
}

export interface CapturedSemanticFrame extends FrameTopologyEntry {
  axNodes: Protocol.Accessibility.AXNode[];
  domByBackend: ReadonlyMap<number, SafeDomNode>;
  failed: boolean;
}

export interface SemanticFingerprint {
  role: string;
  name?: string;
  description?: string;
  tagName?: string;
  inputType?: string;
  domMetadataKnown: boolean;
  hidden: boolean;
  disabled: boolean;
  readonly: boolean;
  editable: boolean;
  checked?: boolean | "mixed";
  selected?: boolean;
  expanded?: boolean;
  pressed?: boolean | "mixed";
  focusable: boolean;
  scrollable: boolean;
}

export type BaseElementDescriptor = Omit<
  ElementDescriptor,
  "ref" | "relation" | "change"
>;

export interface NormalizedSemanticNode {
  identity: string;
  frameId: string;
  debuggerSessionId?: string;
  backendNodeId?: number;
  parentIdentity?: string;
  childIdentities: string[];
  frameOrder: number;
  domOrder: number;
  descriptor: BaseElementDescriptor;
  searchName?: string;
  searchDescription?: string;
  searchPlaceholder?: string;
  searchAutocomplete?: string;
  fingerprint: SemanticFingerprint;
}

export interface RefRecord {
  readonly backendNodeId: number;
  readonly frameId: string;
  readonly debuggerSessionId?: string;
  readonly generation: number;
  readonly actions: ReadonlySet<ElementAction>;
  readonly fingerprint: Readonly<SemanticFingerprint>;
  readonly identity: string;
}

export interface SemanticCapture {
  loaderId: string;
  url: string;
  topologyKey: string;
  capturedAt: string;
  coverage: "complete" | "partial";
  nodes: NormalizedSemanticNode[];
}

export interface SemanticCache {
  snapshot: ElementSnapshot;
  loaderId: string;
  url: string;
  topologyKey: string;
  nodes: readonly NormalizedSemanticNode[];
  byIdentity: ReadonlyMap<string, NormalizedSemanticNode>;
  byBackendIdentity: ReadonlyMap<string, NormalizedSemanticNode>;
  refByIdentity: ReadonlyMap<string, string>;
}

export function backendIdentityKey(
  debuggerSessionId: string | undefined,
  backendNodeId: number,
): string {
  return `${debuggerSessionId ?? "root"}:${backendNodeId}`;
}

export type ElementCategory = ElementDescriptor["category"];
