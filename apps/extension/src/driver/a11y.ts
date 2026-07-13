import type { A11yNode } from "@understudy/protocol";
import type { Protocol } from "devtools-protocol";

// AX roles surfaced to the backend. Tunable (seeded from the M0 spike): widen as
// real pages demand. Every other role is dropped — but still descended into.
export const MEANINGFUL_ROLES: Set<string> = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "combobox",
  "listbox",
  "checkbox",
  "radio",
  "switch",
  "slider",
  "menuitem",
  "tab",
  "heading",
  "image",
  "cell",
]);

function axString(value: Protocol.Accessibility.AXValue | undefined): string | undefined {
  const raw = value?.value;
  return typeof raw === "string" ? raw : undefined;
}

export function buildA11ySnapshot(
  axNodes: Protocol.Accessibility.AXNode[],
  gen: number,
): { tree: A11yNode[]; refMap: Map<string, number> } {
  const refMap = new Map<string, number>();
  const byId = new Map<string, Protocol.Accessibility.AXNode>();
  for (const node of axNodes) byId.set(node.nodeId, node);

  const seen = new Set<string>();
  let seq = 0;

  // DFS pre-order. Returns the kept forest rooted at `nodeId`: a kept node comes
  // back as a single-element list carrying its kept descendants; a dropped node
  // returns its descendants' forest, so they re-parent onto the nearest kept
  // ancestor (drop-but-descend). The ref is assigned before recursing, so a kept
  // parent always precedes its kept children.
  function walk(nodeId: string): A11yNode[] {
    if (seen.has(nodeId)) return []; // guard against a malformed cyclic tree
    seen.add(nodeId);

    const node = byId.get(nodeId);
    if (node === undefined) return [];

    const roleRaw = node.role?.value;
    const role = typeof roleRaw === "string" ? roleRaw : undefined;
    const backendId = node.backendDOMNodeId;

    let self: A11yNode | undefined;
    if (
      role !== undefined &&
      MEANINGFUL_ROLES.has(role) &&
      !node.ignored &&
      backendId !== undefined
    ) {
      const ref = `s${gen}e${seq++}`;
      refMap.set(ref, backendId);
      self = { ref, role };
      const name = axString(node.name);
      if (name !== undefined) self.name = name;
      const value = axString(node.value);
      if (value !== undefined) self.value = value;
    }

    const childForest: A11yNode[] = [];
    for (const childId of node.childIds ?? []) {
      for (const kept of walk(childId)) childForest.push(kept);
    }

    if (self !== undefined) {
      if (childForest.length > 0) self.children = childForest;
      return [self];
    }
    return childForest;
  }

  const root = axNodes.find((n) => n.role?.value === "RootWebArea");
  const tree = root === undefined ? [] : walk(root.nodeId);
  return { tree, refMap };
}
