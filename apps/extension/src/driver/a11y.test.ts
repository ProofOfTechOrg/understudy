import { describe, it, expect } from "vitest";
import type { Protocol } from "devtools-protocol";
import { buildA11ySnapshot } from "./a11y";

// Hand-authored getFullAXTree-shaped fixture. AXNode requires nodeId + ignored;
// role/name/value are AXValue { type, value }. It covers a kept button; an
// ignored generic wrapping a meaningful link (drop-but-descend); a StaticText
// that is not meaningful; a textbox with a value nesting a kept button; a
// meaningful checkbox WITHOUT a backend id; an ignored (hidden) heading; and a
// kept heading with no name.
const FIXTURE: Protocol.Accessibility.AXNode[] = [
  {
    nodeId: "1",
    ignored: false,
    role: { type: "role", value: "RootWebArea" },
    childIds: ["2", "3", "6", "10"],
  },
  {
    nodeId: "2",
    ignored: false,
    role: { type: "role", value: "button" },
    name: { type: "computedString", value: "Submit" },
    backendDOMNodeId: 100,
  },
  {
    nodeId: "3",
    ignored: true,
    role: { type: "role", value: "generic" },
    backendDOMNodeId: 101,
    childIds: ["4", "5"],
  },
  {
    nodeId: "4",
    ignored: false,
    role: { type: "role", value: "link" },
    name: { type: "computedString", value: "Home" },
    backendDOMNodeId: 102,
  },
  {
    nodeId: "5",
    ignored: false,
    role: { type: "role", value: "StaticText" },
    backendDOMNodeId: 103,
  },
  {
    nodeId: "6",
    ignored: false,
    role: { type: "role", value: "textbox" },
    name: { type: "computedString", value: "Search" },
    value: { type: "string", value: "hello" },
    backendDOMNodeId: 104,
    childIds: ["7", "8", "9"],
  },
  {
    nodeId: "7",
    ignored: false,
    role: { type: "role", value: "button" },
    name: { type: "computedString", value: "Clear" },
    backendDOMNodeId: 105,
  },
  {
    nodeId: "8",
    ignored: false,
    role: { type: "role", value: "checkbox" },
    name: { type: "computedString", value: "Remember" },
    // no backendDOMNodeId -> dropped (its ref could not resolve)
  },
  {
    nodeId: "9",
    ignored: true,
    role: { type: "role", value: "heading" },
    name: { type: "computedString", value: "Hidden" },
    backendDOMNodeId: 106,
  },
  {
    nodeId: "10",
    ignored: false,
    role: { type: "role", value: "heading" },
    backendDOMNodeId: 107,
    // no name -> undefined
  },
];

type A11yNodeList = ReturnType<typeof buildA11ySnapshot>["tree"];

function allRoles(tree: A11yNodeList): Set<string> {
  const roles = new Set<string>();
  const visit = (nodes: A11yNodeList): void => {
    for (const node of nodes) {
      roles.add(node.role);
      if (node.children) visit(node.children);
    }
  };
  visit(tree);
  return roles;
}

function preorderRefs(tree: A11yNodeList): string[] {
  const refs: string[] = [];
  const visit = (nodes: A11yNodeList): void => {
    for (const node of nodes) {
      refs.push(node.ref);
      if (node.children) visit(node.children);
    }
  };
  visit(tree);
  return refs;
}

describe("buildA11ySnapshot", () => {
  it("keeps only meaningful, non-ignored nodes with a backend id; drops-but-descends", () => {
    const { tree } = buildA11ySnapshot(FIXTURE, {
      scopeId: "fixture",
      generation: 4,
    });
    // Top level, in child order: button(2), link(4, re-parented off the dropped
    // ignored generic 3), textbox(6), heading(10).
    expect(tree.map((node) => node.role)).toEqual(["button", "link", "textbox", "heading"]);
    expect(tree.map((node) => node.name)).toEqual(["Submit", "Home", "Search", undefined]);

    const roles = allRoles(tree);
    // The ignored generic, the non-meaningful StaticText, the no-backend-id
    // checkbox, and the ignored heading are all gone.
    expect(roles.has("generic")).toBe(false);
    expect(roles.has("StaticText")).toBe(false);
    expect(roles.has("checkbox")).toBe(false);
    // The link survived even though its parent generic was dropped.
    expect(tree.some((node) => node.role === "link" && node.name === "Home")).toBe(true);
  });

  it("assigns deterministic attachment-and-generation-scoped refs in DFS pre-order", () => {
    const scope = { scopeId: "fixture", generation: 4 };
    const first = buildA11ySnapshot(FIXTURE, scope);
    const second = buildA11ySnapshot(FIXTURE, scope);
    // Pre-order: button(e0), link(e1), textbox(e2), the textbox's button(e3), heading(e4).
    expect(preorderRefs(first.tree)).toEqual([
      "afixture:s4e0",
      "afixture:s4e1",
      "afixture:s4e2",
      "afixture:s4e3",
      "afixture:s4e4",
    ]);
    // Same input -> identical refs across runs.
    expect(preorderRefs(second.tree)).toEqual(preorderRefs(first.tree));
  });

  it("does not collide when two attachments mint the same generation and sequence", () => {
    const first = buildA11ySnapshot(FIXTURE, {
      scopeId: "tab-a",
      generation: 1,
    });
    const second = buildA11ySnapshot(FIXTURE, {
      scopeId: "tab-b",
      generation: 1,
    });

    expect(preorderRefs(first.tree)[0]).toBe("atab-a:s1e0");
    expect(preorderRefs(second.tree)[0]).toBe("atab-b:s1e0");
    expect(preorderRefs(first.tree)[0]).not.toBe(preorderRefs(second.tree)[0]);
  });

  it("maps every ref to the correct backendDOMNodeId", () => {
    const { refMap } = buildA11ySnapshot(FIXTURE, {
      scopeId: "fixture",
      generation: 4,
    });
    expect([...refMap.entries()]).toEqual([
      ["afixture:s4e0", 100],
      ["afixture:s4e1", 102],
      ["afixture:s4e2", 104],
      ["afixture:s4e3", 105],
      ["afixture:s4e4", 107],
    ]);
  });

  it("reconstructs nested hierarchy among kept nodes", () => {
    const { tree } = buildA11ySnapshot(FIXTURE, {
      scopeId: "fixture",
      generation: 4,
    });
    const textbox = tree.find((node) => node.role === "textbox");
    expect(textbox?.children?.map((child) => ({ role: child.role, name: child.name }))).toEqual([
      { role: "button", name: "Clear" },
    ]);
    // A kept leaf has no children key at all.
    const topButton = tree.find((node) => node.role === "button");
    expect(topButton?.children).toBeUndefined();
  });

  it("carries role/name but never exposes AX values", () => {
    const { tree } = buildA11ySnapshot(FIXTURE, {
      scopeId: "fixture",
      generation: 4,
    });
    const textbox = tree.find((node) => node.role === "textbox");
    expect(textbox).toMatchObject({ role: "textbox", name: "Search" });
    expect(textbox?.value).toBeUndefined();
    const heading = tree.find((node) => node.role === "heading");
    expect(heading?.name).toBeUndefined();
    expect(heading?.value).toBeUndefined();
  });

  it("returns an empty tree and empty refMap for empty input", () => {
    const { tree, refMap } = buildA11ySnapshot([], {
      scopeId: "fixture",
      generation: 4,
    });
    expect(tree).toEqual([]);
    expect(refMap.size).toBe(0);
  });

  it("rejects more than 5,000 reportable nodes instead of truncating", () => {
    const children = Array.from({ length: 5_001 }, (_, index) => `node-${index}`);
    const nodes: Protocol.Accessibility.AXNode[] = [
      {
        nodeId: "root",
        ignored: false,
        role: { type: "role", value: "RootWebArea" },
        childIds: children,
      },
      ...children.map((nodeId, index) => ({
        nodeId,
        ignored: false,
        role: { type: "role" as const, value: "button" },
        backendDOMNodeId: index + 1,
      })),
    ];

    expect(() =>
      buildA11ySnapshot(nodes, { scopeId: "limit", generation: 1 }),
    ).toThrow("a11y snapshot exceeds 5000 nodes");
  });

  it("rejects reportable depth above 64 and 4 KiB names", () => {
    const nested: Protocol.Accessibility.AXNode[] = [
      {
        nodeId: "root",
        ignored: false,
        role: { type: "role", value: "RootWebArea" },
        childIds: ["button-0"],
      },
    ];
    for (let index = 0; index < 65; index += 1) {
      nested.push({
        nodeId: `button-${index}`,
        ignored: false,
        role: { type: "role", value: "button" },
        backendDOMNodeId: index + 1,
        ...(index === 64 ? {} : { childIds: [`button-${index + 1}`] }),
      });
    }
    expect(() =>
      buildA11ySnapshot(nested, { scopeId: "depth", generation: 1 }),
    ).toThrow("a11y snapshot exceeds depth 64");

    const oversizedName = structuredClone(FIXTURE);
    oversizedName[1]!.name = {
      type: "computedString",
      value: "x".repeat(4 * 1024 + 1),
    };
    expect(() =>
      buildA11ySnapshot(oversizedName, { scopeId: "name", generation: 1 }),
    ).toThrow("a11y name exceeds 4096 bytes");
  });
});
