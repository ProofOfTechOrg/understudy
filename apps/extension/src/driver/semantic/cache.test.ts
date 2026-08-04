import { describe, expect, it } from "vitest";
import {
  MAX_SEMANTIC_NODES,
  type ElementDescriptor,
  type ElementSnapshot,
} from "@understudy/protocol";
import {
  buildSemanticCache,
  deltaDescriptors,
  findDescriptors,
  inspectDescriptors,
  snapshotDescriptors,
} from "./cache";
import { semanticSearchKey } from "./normalize";
import type { NormalizedSemanticNode, SemanticCapture } from "./types";

function semanticNode(
  identity: string,
  backendNodeId: number,
  descriptor: Partial<ElementDescriptor> & Pick<ElementDescriptor, "role" | "category">,
  options: {
    parentIdentity?: string;
    childIdentities?: string[];
    domOrder?: number;
    description?: string;
    placeholder?: string;
  } = {},
): NormalizedSemanticNode {
  const visibility = descriptor.visibility ?? "viewport";
  const actions = descriptor.actions ?? ["inspect"];
  const name = descriptor.name;
  return {
    identity,
    backendNodeId,
    frameId: "main",
    ...(options.parentIdentity === undefined
      ? {}
      : { parentIdentity: options.parentIdentity }),
    childIdentities: options.childIdentities ?? [],
    frameOrder: 0,
    domOrder: options.domOrder ?? backendNodeId,
    descriptor: {
      role: descriptor.role,
      category: descriptor.category,
      ...(name === undefined ? {} : { name }),
      ...(options.description === undefined
        ? {}
        : { description: options.description }),
      depth: descriptor.depth ?? 0,
      visibility,
      actions,
      ...(descriptor.states === undefined ? {} : { states: descriptor.states }),
      ...(descriptor.form === undefined ? {} : { form: descriptor.form }),
      ...(descriptor.bounds === undefined ? {} : { bounds: descriptor.bounds }),
    },
    searchName: semanticSearchKey(name),
    searchDescription: semanticSearchKey(options.description),
    searchPlaceholder: semanticSearchKey(options.placeholder),
    fingerprint: {
      role: descriptor.role,
      ...(name === undefined ? {} : { name }),
      domMetadataKnown: false,
      hidden: visibility === "hidden",
      disabled: descriptor.states?.disabled === true,
      readonly: descriptor.states?.readonly === true,
      editable: actions.includes("type"),
      focusable: actions.includes("key"),
      scrollable: actions.includes("scroll"),
    },
  };
}

function cache(
  nodes: NormalizedSemanticNode[],
  generation = 1,
  coverage: "complete" | "partial" = "complete",
) {
  const capture: SemanticCapture = {
    loaderId: "loader",
    url: "https://example.test/",
    topologyKey: "root:main:-",
    capturedAt: "2026-08-03T00:00:00.000Z",
    coverage,
    nodes,
  };
  const snapshot: ElementSnapshot = {
    id: `snapshot-${generation}`,
    generation,
    capturedAt: capture.capturedAt,
    scope: "document",
    view: "all",
    coverage,
  };
  return buildSemanticCache(capture, snapshot, `atest:s${generation}e`).cache;
}

describe("semantic cache projections", () => {
  it("retains a late focused action when semantic priority truncates the cache", () => {
    const nodes = Array.from({ length: MAX_SEMANTIC_NODES + 1 }, (_, index) =>
      semanticNode(
        `node-${index}`,
        index + 1,
        index === MAX_SEMANTIC_NODES
          ? {
              role: "button",
              category: "interactive",
              name: "Late focused action",
              actions: ["click", "key", "inspect"],
              states: { focused: true },
            }
          : {
              role: "StaticText",
              category: "content",
              name: `Content ${index}`,
            },
        { domOrder: index },
      ),
    );

    const built = cache(nodes);
    expect(built.nodes).toHaveLength(MAX_SEMANTIC_NODES);
    expect(built.snapshot.coverage).toBe("partial");
    expect(
      built.nodes.some((node) => node.descriptor.name === "Late focused action"),
    ).toBe(true);
  });

  it("orders urgent and viewport actions first and excludes offscreen viewport results", () => {
    const built = cache([
      semanticNode("heading", 1, {
        role: "heading",
        category: "content",
        name: "Settings",
        visibility: "viewport",
      }),
      semanticNode("offscreen", 2, {
        role: "button",
        category: "interactive",
        name: "Later",
        visibility: "offscreen",
        actions: ["click", "inspect"],
      }),
      semanticNode("action", 3, {
        role: "button",
        category: "interactive",
        name: "Save",
        visibility: "viewport",
        actions: ["click", "inspect"],
      }),
      semanticNode("alert", 4, {
        role: "alert",
        category: "status",
        name: "Session expired",
        visibility: "unknown",
      }),
      semanticNode("unknown", 5, {
        role: "button",
        category: "interactive",
        name: "Maybe",
        visibility: "unknown",
        actions: ["click", "inspect"],
      }),
    ]);

    expect(
      snapshotDescriptors(built, "viewport", "interactive").map((item) => item.name),
    ).toEqual(["Session expired", "Save", "Maybe"]);
    expect(
      snapshotDescriptors(built, "document", "interactive").map((item) => item.name),
    ).toEqual(["Session expired", "Save", "Maybe", "Later"]);
  });

  it("retains and prioritizes the complete focused-node ancestor path", () => {
    const built = cache([
      semanticNode(
        "root",
        1,
        { role: "generic", category: "structure", name: "Root" },
        { childIdentities: ["group", "other"], domOrder: 0 },
      ),
      semanticNode(
        "group",
        2,
        { role: "group", category: "structure", name: "Group" },
        { parentIdentity: "root", childIdentities: ["focused"], domOrder: 1 },
      ),
      semanticNode(
        "focused",
        3,
        {
          role: "textbox",
          category: "interactive",
          name: "Focused",
          actions: ["type", "inspect"],
          states: { focused: true },
        },
        { parentIdentity: "group", domOrder: 2 },
      ),
      semanticNode(
        "other",
        4,
        {
          role: "button",
          category: "interactive",
          name: "Other",
          actions: ["click", "inspect"],
        },
        { parentIdentity: "root", domOrder: 3 },
      ),
    ]);

    expect(
      snapshotDescriptors(built, "viewport", "interactive").map((item) => item.name),
    ).toEqual(["Root", "Group", "Focused", "Other"]);
  });

  it("ranks name matches before secondary fields and returns bounded context", () => {
    const built = cache([
      semanticNode(
        "form",
        1,
        { role: "form", category: "structure", name: "Checkout" },
        { childIdentities: ["before", "exact", "after", "secondary"], domOrder: 0 },
      ),
      semanticNode(
        "before",
        2,
        { role: "StaticText", category: "content", name: "Before" },
        { parentIdentity: "form", domOrder: 1 },
      ),
      semanticNode(
        "exact",
        3,
        {
          role: "button",
          category: "interactive",
          name: "Pay",
          actions: ["click", "inspect"],
        },
        { parentIdentity: "form", domOrder: 2 },
      ),
      semanticNode(
        "after",
        4,
        { role: "button", category: "interactive", name: "Pay later" },
        { parentIdentity: "form", domOrder: 3 },
      ),
      semanticNode(
        "secondary",
        5,
        { role: "textbox", category: "interactive", name: "Amount" },
        {
          parentIdentity: "form",
          domOrder: 4,
          description: "Pay securely",
        },
      ),
    ]);

    const result = findDescriptors(built, {
      query: "pay",
      roles: [],
      match: "contains",
      includeHidden: false,
    });
    expect(result.filter((item) => item.relation === "match").map((item) => item.name))
      .toEqual(["Pay", "Pay later", "Amount"]);
    expect(result).toContainEqual(expect.objectContaining({ name: "Checkout", relation: "ancestor" }));
    expect(result).toContainEqual(expect.objectContaining({ name: "Before", relation: "sibling" }));
    expect(
      findDescriptors(built, {
        query: "pay",
        roles: ["textbox"],
        match: "contains",
        includeHidden: false,
      }).filter((item) => item.relation === "match"),
    ).toEqual([expect.objectContaining({ role: "textbox", name: "Amount" })]);
  });

  it("inspects ancestors and a breadth-first depth-bounded subtree", () => {
    const built = cache([
      semanticNode(
        "root",
        1,
        { role: "main", category: "structure", name: "Main" },
        { childIdentities: ["target"], domOrder: 0 },
      ),
      semanticNode(
        "target",
        2,
        {
          role: "group",
          category: "structure",
          name: "Target",
          bounds: { x: 1, y: 2, width: 3, height: 4 },
        },
        { parentIdentity: "root", childIdentities: ["left", "right"], domOrder: 1 },
      ),
      semanticNode(
        "left",
        3,
        { role: "button", category: "interactive", name: "Left" },
        { parentIdentity: "target", childIdentities: ["deep"], domOrder: 2 },
      ),
      semanticNode(
        "right",
        4,
        { role: "button", category: "interactive", name: "Right" },
        { parentIdentity: "target", domOrder: 3 },
      ),
      semanticNode(
        "deep",
        5,
        { role: "StaticText", category: "content", name: "Deep" },
        { parentIdentity: "left", domOrder: 4 },
      ),
    ]);
    const target = built.byIdentity.get("target");
    if (target === undefined) throw new Error("missing target");

    expect(inspectDescriptors(built, target, { depth: 1, includeBounds: true }))
      .toEqual([
        expect.objectContaining({
          name: "Target",
          relation: "match",
          bounds: { x: 1, y: 2, width: 3, height: 4 },
        }),
        expect.objectContaining({ name: "Main", relation: "ancestor" }),
        expect.objectContaining({ name: "Left", relation: "descendant" }),
        expect.objectContaining({ name: "Right", relation: "descendant" }),
      ]);
    expect(
      inspectDescriptors(built, target, {
        depth: 0,
        includeBounds: true,
        targetOverride: { role: "group" },
        omitTargetFields: ["name", "bounds"],
      })[0],
    ).not.toHaveProperty("name");
    expect(
      inspectDescriptors(built, target, {
        depth: 0,
        includeBounds: true,
        targetOverride: { role: "group" },
        omitTargetFields: ["name", "bounds"],
      })[0],
    ).not.toHaveProperty("bounds");
  });
});

describe("semantic cache deltas", () => {
  it("keys changes by stable identity, remints current refs, and omits refs for removals", () => {
    const previous = cache([
      semanticNode(
        "root",
        1,
        { role: "main", category: "structure", name: "Main" },
        { childIdentities: ["changed", "removed"] },
      ),
      semanticNode(
        "changed",
        2,
        { role: "button", category: "interactive", name: "Before" },
        { parentIdentity: "root" },
      ),
      semanticNode(
        "removed",
        3,
        { role: "button", category: "interactive", name: "Removed" },
        { parentIdentity: "root" },
      ),
    ]);
    const current = cache(
      [
        semanticNode(
          "root",
          1,
          { role: "main", category: "structure", name: "Main" },
          { childIdentities: ["changed", "added"] },
        ),
        semanticNode(
          "changed",
          2,
          { role: "button", category: "interactive", name: "After" },
          { parentIdentity: "root" },
        ),
        semanticNode(
          "added",
          4,
          { role: "button", category: "interactive", name: "Added" },
          { parentIdentity: "root" },
        ),
      ],
      2,
    );

    const delta = deltaDescriptors(previous, current);
    expect(delta).toMatchObject({ added: 1, changed: 1, removed: 1 });
    expect(delta.elements.find((item) => item.name === "Added")).toMatchObject({
      change: "added",
      ref: expect.stringContaining(":s2e"),
    });
    expect(delta.elements.find((item) => item.name === "Removed")).toEqual(
      expect.not.objectContaining({ ref: expect.anything() }),
    );
  });
});
