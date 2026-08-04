import {
  utf8ByteLength,
  type ElementAction,
} from "@understudy/protocol";
import type { Protocol } from "devtools-protocol";
import type {
  CapturedSemanticFrame,
  ElementCategory,
  NormalizedSemanticNode,
  SafeDomNode,
  SemanticFingerprint,
} from "./types";

const MAX_ELEMENT_STRING_BYTES = 512;
const CONTROL_AND_BIDI =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;

const CLICK_ROLES = new Set([
  "button",
  "link",
  "checkbox",
  "radio",
  "switch",
  "tab",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "treeitem",
]);
const TYPE_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton"]);
const DIALOG_ROLES = new Set(["dialog", "alertdialog"]);
const STATUS_ROLES = new Set(["alert", "status", "log", "timer", "marquee"]);
const CONTENT_ROLES = new Set([
  "heading",
  "image",
  "img",
  "StaticText",
  "paragraph",
  "list",
  "listitem",
  "table",
  "grid",
  "row",
  "cell",
  "gridcell",
  "columnheader",
  "rowheader",
  "caption",
  "figure",
  "blockquote",
  "code",
  "term",
  "definition",
]);
const LANDMARK_ROLES = new Set([
  "banner",
  "complementary",
  "contentinfo",
  "form",
  "main",
  "navigation",
  "region",
  "search",
]);
const STRUCTURAL_NOISE = new Set([
  "generic",
  "none",
  "InlineTextBox",
  "inlinetextbox",
  "RootWebArea",
  "WebArea",
]);
const RANGE_ROLES = new Set(["progressbar", "meter", "slider", "scrollbar"]);
function wellFormed(value: string): string {
  const method = (value as string & { toWellFormed?: () => string }).toWellFormed;
  return method === undefined ? value.replace(/[\ud800-\udfff]/g, "�") : method.call(value);
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (utf8ByteLength(value) <= maxBytes) return value;
  let output = "";
  let bytes = 0;
  for (const codePoint of value) {
    const size = utf8ByteLength(codePoint);
    if (bytes + size > maxBytes) break;
    output += codePoint;
    bytes += size;
  }
  return output;
}

export function normalizePageString(
  value: unknown,
  maxBytes = MAX_ELEMENT_STRING_BYTES,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = wellFormed(value)
    .normalize("NFC")
    .replace(CONTROL_AND_BIDI, "")
    .replace(/\s+/gu, " ")
    .trim();
  if (normalized.length === 0) return undefined;
  return truncateUtf8(normalized, maxBytes);
}

export function semanticSearchKey(value: string | undefined): string | undefined {
  const normalized = normalizePageString(value)
    ?.normalize("NFKC")
    .toLocaleLowerCase("und")
    // NFKC handles compatibility characters; these two mappings cover the
    // remaining common differences between Unicode lowercase and default
    // case folding that affect substring search.
    .replaceAll("ß", "ss")
    .replaceAll("ς", "σ");
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}

function booleanValue(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (value === 0 || value === "false") return false;
  if (value === 1 || value === "true") return true;
  return undefined;
}

function booleanOrMixedValue(value: unknown): boolean | "mixed" | undefined {
  if (value === "mixed") return "mixed";
  return booleanValue(value);
}

function numberValue(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function categoryFor(role: string, actionable: boolean): ElementCategory {
  if (STATUS_ROLES.has(role)) return "status";
  if (actionable) return "interactive";
  if (CONTENT_ROLES.has(role) || RANGE_ROLES.has(role)) return "content";
  return "structure";
}

function actionsFor(
  role: string,
  dom: SafeDomNode | undefined,
  state: {
    disabled: boolean;
    readonly: boolean;
    editable: boolean;
    focusable: boolean;
    scrollable: boolean;
  },
): ElementAction[] {
  const actions: ElementAction[] = [];
  if (!state.disabled && (CLICK_ROLES.has(role) || dom?.clickable === true)) actions.push("click");
  if (
    !state.disabled &&
    !state.readonly &&
    (state.editable || TYPE_ROLES.has(role))
  ) {
    actions.push("type");
  }
  if (!state.disabled && state.focusable) actions.push("key");
  if (state.scrollable) actions.push("scroll");
  actions.push("inspect");
  return actions;
}

export interface DecodedAxNode {
  role?: string;
  name?: string;
  description?: string;
  states?: NonNullable<NormalizedSemanticNode["descriptor"]["states"]>;
  range?: NormalizedSemanticNode["descriptor"]["range"];
  hidden?: boolean;
  focusable?: boolean;
  scrollable?: boolean;
  editable: boolean;
  presentProperties: ReadonlySet<string>;
}

export function decodeAxNode(
  node: Protocol.Accessibility.AXNode,
  hints: { role?: string; editable?: boolean } = {},
): DecodedAxNode {
  const properties = new Map<string, unknown>(
    (node.properties ?? []).map((property) => [property.name, property.value.value]),
  );
  const property = (name: string): unknown => properties.get(name);
  const role = normalizePageString(node.role?.value) ?? hints.role;
  const editableValue = property("editable");
  const editable =
    hints.editable === true ||
    editableValue === true ||
    editableValue === "plaintext" ||
    editableValue === "richtext" ||
    (role !== undefined && TYPE_ROLES.has(role));
  const invalidValue = property("invalid");
  const states = {
    disabled: booleanValue(property("disabled")),
    readonly: booleanValue(property("readonly")),
    required: booleanValue(property("required")),
    invalid:
      invalidValue === undefined
        ? undefined
        : invalidValue !== false && invalidValue !== "false",
    checked: booleanOrMixedValue(property("checked")),
    selected: booleanValue(property("selected")),
    expanded: booleanValue(property("expanded")),
    pressed: booleanOrMixedValue(property("pressed")),
    focused: booleanValue(property("focused")),
    level: numberValue(property("level")),
    modal: booleanValue(property("modal")),
    hasPopup: normalizePageString(property("hasPopup"), 128),
  };
  const publicStates = Object.values(states).some((value) => value !== undefined)
    ? states
    : undefined;
  let range: NormalizedSemanticNode["descriptor"]["range"];
  if (role !== undefined && !editable && RANGE_ROLES.has(role)) {
    const value = node.value?.value;
    const candidate = {
      min: numberValue(property("valuemin")),
      max: numberValue(property("valuemax")),
      now:
        numberValue(property("valuenow")) ??
        (typeof value === "number" && Number.isFinite(value) ? value : undefined),
      text:
        normalizePageString(property("valuetext")) ??
        (typeof value === "string" ? normalizePageString(value) : undefined),
    };
    if (Object.values(candidate).some((entry) => entry !== undefined)) range = candidate;
  }
  const name = normalizePageString(node.name?.value);
  const description = normalizePageString(node.description?.value);
  return {
    ...(role === undefined ? {} : { role }),
    ...(name === undefined ? {} : { name }),
    ...(description === undefined ? {} : { description }),
    ...(publicStates === undefined ? {} : { states: publicStates }),
    ...(range === undefined ? {} : { range }),
    hidden: booleanValue(property("hidden")),
    focusable: booleanValue(property("focusable")),
    scrollable: booleanValue(property("scrollable")),
    editable,
    presentProperties: new Set(properties.keys()),
  };
}

function shouldRetain(
  role: string,
  name: string | undefined,
  actions: readonly ElementAction[],
  focused: boolean,
  childCount: number,
  dom: SafeDomNode | undefined,
  modal: boolean,
): boolean {
  if (STRUCTURAL_NOISE.has(role)) {
    if (role === "RootWebArea" || role === "WebArea") return false;
    return (
      name !== undefined ||
      dom?.scrollable === true ||
      modal ||
      childCount > 1
    );
  }
  if (actions.some((action) => action !== "inspect") || focused) return true;
  if (DIALOG_ROLES.has(role) || STATUS_ROLES.has(role)) return true;
  if (role.toLowerCase() === "iframe") return true;
  if ((role === "image" || role === "img") && name !== undefined) return true;
  if (CONTENT_ROLES.has(role) || LANDMARK_ROLES.has(role) || RANGE_ROLES.has(role)) {
    return name !== undefined || childCount > 0;
  }
  return name !== undefined || childCount > 0;
}

interface TreeNode {
  node: NormalizedSemanticNode;
  children: TreeNode[];
}

function sameStaticState(left: TreeNode, right: TreeNode): boolean {
  return (
    left.node.descriptor.role === "StaticText" &&
    right.node.descriptor.role === "StaticText" &&
    JSON.stringify(left.node.descriptor.states ?? {}) ===
      JSON.stringify(right.node.descriptor.states ?? {}) &&
    left.children.length === 0 &&
    right.children.length === 0
  );
}

function coalesceStaticSiblings(children: TreeNode[]): TreeNode[] {
  const result: TreeNode[] = [];
  for (const child of children) {
    const previous = result.at(-1);
    if (previous !== undefined && sameStaticState(previous, child)) {
      const name = normalizePageString(
        [previous.node.descriptor.name, child.node.descriptor.name]
          .filter((value): value is string => value !== undefined)
          .join(" "),
      );
      previous.node.descriptor = {
        ...previous.node.descriptor,
        ...(name === undefined ? {} : { name }),
      };
      previous.node.searchName = semanticSearchKey(name);
      previous.node.backendNodeId = undefined;
      const { tagName: _tagName, inputType: _inputType, ...fingerprint } =
        previous.node.fingerprint;
      previous.node.fingerprint = {
        ...fingerprint,
        name,
        domMetadataKnown: false,
      };
      continue;
    }
    result.push(child);
  }
  return result;
}

function removeRedundantStaticText(parentName: string | undefined, children: TreeNode[]): TreeNode[] {
  if (parentName === undefined) return children;
  const staticNames = children
    .filter((child) => child.node.descriptor.role === "StaticText")
    .map((child) => child.node.descriptor.name ?? "");
  if (staticNames.length === 0) return children;
  const compact = normalizePageString(staticNames.join(""));
  const spaced = normalizePageString(staticNames.join(" "));
  if (parentName !== compact && parentName !== spaced) return children;
  return children.filter((child) => child.node.descriptor.role !== "StaticText");
}

function normalizeAxNode(
  frame: CapturedSemanticFrame,
  ax: Protocol.Accessibility.AXNode,
  axOrder: ReadonlyMap<string, number>,
  inputChildren: TreeNode[],
): TreeNode[] {
  let children = coalesceStaticSiblings(inputChildren);
  if (ax.ignored) return children;
  const decoded = decodeAxNode(ax);
  const role = decoded.role;
  if (role === undefined) return children;
  const backendNodeId = ax.backendDOMNodeId;
  const dom =
    backendNodeId === undefined ? undefined : frame.domByBackend.get(backendNodeId);
  const name = decoded.name;
  const description = decoded.description;
  const states = decoded.states;
  const disabled = states?.disabled === true;
  const readonly = states?.readonly === true;
  const editable = decoded.editable;
  const focusable = decoded.focusable === true;
  const focused = states?.focused === true;
  const modal = states?.modal === true;
  const scrollable =
    dom?.scrollable === true || decoded.scrollable === true || role === "scrollbar";
  const actions = actionsFor(role, dom, {
    disabled,
    readonly,
    editable,
    focusable,
    scrollable,
  });

  if (!shouldRetain(role, name, actions, focused, children.length, dom, modal)) {
    return children;
  }

  children = removeRedundantStaticText(name, children);
  const identity =
    backendNodeId === undefined
      ? `ax:${frame.debuggerSessionId ?? "root"}:${frame.frameId}:${ax.nodeId}`
      : `be:${frame.debuggerSessionId ?? "root"}:${frame.frameId}:${backendNodeId}`;
  const form =
    dom === undefined ||
    (dom.inputType === undefined &&
      dom.placeholder === undefined &&
      dom.autocomplete === undefined)
      ? undefined
      : {
          ...(dom.inputType === undefined ? {} : { inputType: dom.inputType }),
          ...(dom.placeholder === undefined ? {} : { placeholder: dom.placeholder }),
          ...(dom.autocomplete === undefined ? {} : { autocomplete: dom.autocomplete }),
        };
  const fingerprint: SemanticFingerprint = {
    role,
    ...(name === undefined ? {} : { name }),
    ...(description === undefined ? {} : { description }),
    ...(dom?.tagName === undefined ? {} : { tagName: dom.tagName }),
    ...(dom?.inputType === undefined ? {} : { inputType: dom.inputType }),
    domMetadataKnown: dom !== undefined,
    hidden: dom?.visibility === "hidden" || decoded.hidden === true,
    disabled,
    readonly,
    editable,
    ...(states?.checked === undefined ? {} : { checked: states.checked }),
    ...(states?.selected === undefined ? {} : { selected: states.selected }),
    ...(states?.expanded === undefined ? {} : { expanded: states.expanded }),
    ...(states?.pressed === undefined ? {} : { pressed: states.pressed }),
    focusable,
    scrollable,
  };
  const node: NormalizedSemanticNode = {
    identity,
    frameId: frame.frameId,
    ...(frame.debuggerSessionId === undefined
      ? {}
      : { debuggerSessionId: frame.debuggerSessionId }),
    ...(backendNodeId === undefined ? {} : { backendNodeId }),
    childIdentities: [],
    frameOrder: frame.order,
    domOrder: dom?.domOrder ?? axOrder.get(ax.nodeId) ?? Number.MAX_SAFE_INTEGER,
    descriptor: {
      role,
      category: categoryFor(
        role,
        actions.some((action) => action !== "inspect"),
      ),
      ...(name === undefined ? {} : { name }),
      ...(description === undefined ? {} : { description }),
      depth: 0,
      visibility: fingerprint.hidden ? "hidden" : (dom?.visibility ?? "unknown"),
      actions,
      ...(states === undefined ? {} : { states }),
      ...(form === undefined ? {} : { form }),
      ...(decoded.range === undefined ? {} : { range: decoded.range }),
      ...(dom?.bounds === undefined ? {} : { bounds: dom.bounds }),
    },
    searchName: semanticSearchKey(name),
    searchDescription: semanticSearchKey(description),
    searchPlaceholder: semanticSearchKey(form?.placeholder),
    searchAutocomplete: semanticSearchKey(form?.autocomplete),
    fingerprint,
  };
  return [{ node, children }];
}

function unavailableFrame(frame: CapturedSemanticFrame): TreeNode {
  const identity = `frame:${frame.debuggerSessionId ?? "root"}:${frame.frameId}:unavailable`;
  return {
    node: {
      identity,
      frameId: frame.frameId,
      ...(frame.debuggerSessionId === undefined
        ? {}
        : { debuggerSessionId: frame.debuggerSessionId }),
      childIdentities: [],
      frameOrder: frame.order,
      domOrder: Number.MAX_SAFE_INTEGER,
      descriptor: {
        role: "iframe",
        category: "structure",
        name: "Unavailable frame",
        depth: 0,
        visibility: "unknown",
        actions: [],
      },
      searchName: semanticSearchKey("Unavailable frame"),
      fingerprint: {
        role: "iframe",
        name: "Unavailable frame",
        domMetadataKnown: false,
        hidden: false,
        disabled: false,
        readonly: false,
        editable: false,
        focusable: false,
        scrollable: false,
      },
    },
    children: [],
  };
}

function normalizeFrame(frame: CapturedSemanticFrame): TreeNode[] {
  if (frame.failed) return [unavailableFrame(frame)];

  const byId = new Map(frame.axNodes.map((node) => [node.nodeId, node]));
  const axOrder = new Map(frame.axNodes.map((node, index) => [node.nodeId, index]));
  const seen = new Set<string>();
  const childIdsByNode = new Map<string, string[]>();
  const normalizedById = new Map<string, TreeNode[]>();

  const referencedChildren = new Set(
    frame.axNodes.flatMap((node) => node.childIds ?? []),
  );
  const roots = frame.axNodes.filter(
    (node) =>
      !referencedChildren.has(node.nodeId) || node.role?.value === "RootWebArea",
  );
  const output: TreeNode[] = [];
  for (const root of roots) {
    if (seen.has(root.nodeId)) continue;
    seen.add(root.nodeId);
    const stack: Array<{ nodeId: string; expanded: boolean }> = [
      { nodeId: root.nodeId, expanded: false },
    ];
    while (stack.length > 0) {
      const current = stack.pop()!;
      const ax = byId.get(current.nodeId);
      if (ax === undefined) continue;
      if (!current.expanded) {
        const childIds: string[] = [];
        for (const childId of ax.childIds ?? []) {
          if (seen.has(childId) || !byId.has(childId)) continue;
          seen.add(childId);
          childIds.push(childId);
        }
        childIdsByNode.set(current.nodeId, childIds);
        stack.push({ ...current, expanded: true });
        for (let index = childIds.length - 1; index >= 0; index -= 1) {
          stack.push({ nodeId: childIds[index]!, expanded: false });
        }
        continue;
      }
      const children = (childIdsByNode.get(current.nodeId) ?? []).flatMap(
        (childId) => normalizedById.get(childId) ?? [],
      );
      normalizedById.set(current.nodeId, normalizeAxNode(frame, ax, axOrder, children));
    }
    output.push(...(normalizedById.get(root.nodeId) ?? []));
  }
  return output;
}

export function normalizeSemanticFrames(
  frames: readonly CapturedSemanticFrame[],
): NormalizedSemanticNode[] {
  const output: NormalizedSemanticNode[] = [];
  const orderedFrames = [...frames].sort((left, right) => left.order - right.order);
  for (const frame of orderedFrames) {
    const roots = normalizeFrame(frame);
    for (let rootIndex = 0; rootIndex < roots.length; rootIndex += 1) {
      const stack: Array<{
        tree: TreeNode;
        parentIdentity: string | undefined;
        depth: number;
      }> = [{ tree: roots[rootIndex]!, parentIdentity: undefined, depth: 0 }];
      while (stack.length > 0) {
        const current = stack.pop()!;
        current.tree.node.parentIdentity = current.parentIdentity;
        current.tree.node.childIdentities = current.tree.children.map(
          (child) => child.node.identity,
        );
        current.tree.node.descriptor = {
          ...current.tree.node.descriptor,
          depth: current.depth,
        };
        output.push(current.tree.node);
        for (let index = current.tree.children.length - 1; index >= 0; index -= 1) {
          stack.push({
            tree: current.tree.children[index]!,
            parentIdentity: current.tree.node.identity,
            depth: current.depth + 1,
          });
        }
      }
    }
  }
  return output;
}
