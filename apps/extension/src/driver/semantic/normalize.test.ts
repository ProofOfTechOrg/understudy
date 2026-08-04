import { describe, expect, it } from "vitest";
import type { Protocol } from "devtools-protocol";
import {
  normalizePageString,
  normalizeSemanticFrames,
  semanticSearchKey,
} from "./normalize";
import type { CapturedSemanticFrame, SafeDomNode } from "./types";

function axNode(
  node: Partial<Protocol.Accessibility.AXNode> & Pick<Protocol.Accessibility.AXNode, "nodeId">,
): Protocol.Accessibility.AXNode {
  return node as Protocol.Accessibility.AXNode;
}

function property(name: string, value: unknown): Protocol.Accessibility.AXProperty {
  return { name, value: { type: "token", value } } as Protocol.Accessibility.AXProperty;
}

function frame(
  axNodes: Protocol.Accessibility.AXNode[],
  domNodes: SafeDomNode[] = [],
): CapturedSemanticFrame {
  return {
    frameId: "main",
    order: 0,
    axNodes,
    domByBackend: new Map(domNodes.map((node) => [node.backendNodeId, node])),
    failed: false,
  };
}

describe("semantic page-string normalization", () => {
  it("normalizes Unicode, strips controls and bidi marks, and truncates on a code-point boundary", () => {
    expect(normalizePageString("  Cafe\u0301\u0000\u202e  menu\n ")).toBe("Café menu");

    const result = normalizePageString("😀".repeat(200));
    expect(new TextEncoder().encode(result).byteLength).toBe(512);
    expect(result).toBe("😀".repeat(128));
  });

  it("repairs unpaired surrogates before normalization", () => {
    expect(normalizePageString("start\ud800end")).toBe("start�end");
  });

  it("uses normalized locale-independent case-folded search keys", () => {
    expect(semanticSearchKey("  ＳＴＲＡＳＳＥ\u202e  ")).toBe("strasse");
    expect(semanticSearchKey("Straße")).toBe("strasse");
    expect(semanticSearchKey("ΟΣ")).toBe(semanticSearchKey("ος"));
  });
});

describe("semantic AX normalization", () => {
  it("flattens structural noise, removes duplicate static text, and keeps unnamed actions", () => {
    const nodes = normalizeSemanticFrames([
      frame(
        [
          axNode({
            nodeId: "root",
            ignored: false,
            role: { type: "role", value: "RootWebArea" },
            childIds: ["generic"],
          }),
          axNode({
            nodeId: "generic",
            ignored: false,
            role: { type: "role", value: "generic" },
            childIds: ["save", "custom", "first", "second"],
          }),
          axNode({
            nodeId: "save",
            ignored: false,
            role: { type: "role", value: "button" },
            name: { type: "computedString", value: "Save" },
            backendDOMNodeId: 10,
            childIds: ["save-text"],
          }),
          axNode({
            nodeId: "save-text",
            ignored: false,
            role: { type: "role", value: "StaticText" },
            name: { type: "computedString", value: "Save" },
          }),
          axNode({
            nodeId: "custom",
            ignored: false,
            role: { type: "role", value: "generic" },
            backendDOMNodeId: 11,
          }),
          axNode({
            nodeId: "first",
            ignored: false,
            role: { type: "role", value: "StaticText" },
            name: { type: "computedString", value: "Hello" },
            backendDOMNodeId: 12,
          }),
          axNode({
            nodeId: "second",
            ignored: false,
            role: { type: "role", value: "StaticText" },
            name: { type: "computedString", value: "world" },
            backendDOMNodeId: 13,
          }),
        ],
        [
          {
            backendNodeId: 10,
            frameId: "main",
            tagName: "button",
            clickable: true,
            scrollable: false,
            domOrder: 1,
            visibility: "viewport",
          },
          {
            backendNodeId: 11,
            frameId: "main",
            tagName: "div",
            clickable: true,
            scrollable: false,
            domOrder: 2,
            visibility: "viewport",
          },
          {
            backendNodeId: 12,
            frameId: "main",
            tagName: "span",
            clickable: false,
            scrollable: false,
            domOrder: 3,
            visibility: "viewport",
          },
          {
            backendNodeId: 13,
            frameId: "main",
            tagName: "span",
            clickable: false,
            scrollable: false,
            domOrder: 4,
            visibility: "viewport",
          },
        ],
      ),
    ]);

    expect(nodes.map((node) => node.descriptor.role)).toEqual([
      "generic",
      "button",
      "StaticText",
    ]);
    expect(nodes[1]?.childIdentities).toEqual([]);
    expect(nodes[0]?.descriptor.name).toBeUndefined();
    expect(nodes[0]?.descriptor.actions).toEqual(["inspect"]);
    expect(nodes[1]?.descriptor.actions).toContain("click");
    expect(nodes[1]?.descriptor.actions).not.toContain("key");
    expect(nodes[2]?.descriptor.name).toBe("Hello world");
    expect(nodes[2]?.backendNodeId).toBeUndefined();
  });

  it("iteratively normalizes adversarial deep and wide AX trees", () => {
    const deepNodes: Protocol.Accessibility.AXNode[] = [
      axNode({
        nodeId: "root",
        ignored: true,
        role: { type: "role", value: "RootWebArea" },
        childIds: ["node-0"],
      }),
      ...Array.from({ length: 25_000 }, (_, index) =>
        axNode({
          nodeId: `node-${index}`,
          ignored: false,
          role: { type: "role", value: "heading" },
          name: { type: "computedString", value: `Heading ${index}` },
          ...(index === 24_999 ? {} : { childIds: [`node-${index + 1}`] }),
        }),
      ),
    ];
    const deep = normalizeSemanticFrames([frame(deepNodes)]);
    expect(deep).toHaveLength(25_000);
    expect(deep.at(-1)?.descriptor.depth).toBe(24_999);

    const wide = normalizeSemanticFrames([
      frame([
        axNode({
          nodeId: "wide-root",
          ignored: true,
          role: { type: "role", value: "RootWebArea" },
          childIds: Array.from({ length: 25_000 }, (_, index) => `button-${index}`),
        }),
        ...Array.from({ length: 25_000 }, (_, index) =>
          axNode({
            nodeId: `button-${index}`,
            ignored: false,
            role: { type: "role", value: "button" },
            name: { type: "computedString", value: `Button ${index}` },
          }),
        ),
      ]),
    ]);
    expect(wide).toHaveLength(25_000);
  });

  it("exposes safe state and form hints without editable or password values", () => {
    const nodes = normalizeSemanticFrames([
      frame(
        [
          axNode({
            nodeId: "root",
            ignored: false,
            role: { type: "role", value: "RootWebArea" },
            childIds: ["password", "progress", "slider"],
          }),
          axNode({
            nodeId: "password",
            ignored: false,
            role: { type: "role", value: "textbox" },
            name: { type: "computedString", value: "Password" },
            value: { type: "string", value: "never expose me" },
            backendDOMNodeId: 20,
            properties: [
              property("editable", "plaintext"),
              property("required", true),
              property("focused", true),
              property("focusable", true),
            ],
          }),
          axNode({
            nodeId: "progress",
            ignored: false,
            role: { type: "role", value: "progressbar" },
            name: { type: "computedString", value: "Upload" },
            value: { type: "number", value: 42 },
            properties: [property("valuemin", 0), property("valuemax", 100)],
          }),
          axNode({
            nodeId: "slider",
            ignored: false,
            role: { type: "role", value: "slider" },
            name: { type: "computedString", value: "Volume" },
            value: { type: "number", value: 5 },
            properties: [
              property("disabled", false),
              property("readonly", false),
              property("required", true),
              property("invalid", "spelling"),
              property("checked", "mixed"),
              property("selected", true),
              property("expanded", false),
              property("pressed", "mixed"),
              property("focused", false),
              property("level", 3),
              property("modal", true),
              property("hasPopup", "menu"),
              property("valuemin", 0),
              property("valuemax", 10),
              property("valuetext", "half"),
            ],
          }),
        ],
        [
          {
            backendNodeId: 20,
            frameId: "main",
            tagName: "input",
            inputType: "password",
            placeholder: "Account password",
            autocomplete: "current-password",
            clickable: true,
            scrollable: false,
            domOrder: 1,
            visibility: "viewport",
          },
        ],
      ),
    ]);

    const password = nodes.find((node) => node.backendNodeId === 20);
    expect(password?.descriptor.states).toMatchObject({ required: true, focused: true });
    expect(password?.descriptor.form).toEqual({
      inputType: "password",
      placeholder: "Account password",
      autocomplete: "current-password",
    });
    expect(JSON.stringify(password)).not.toContain("never expose me");
    expect(nodes.find((node) => node.descriptor.role === "progressbar")?.descriptor.range)
      .toEqual({ min: 0, max: 100, now: 42, text: undefined });
    const slider = nodes.find((node) => node.descriptor.role === "slider")?.descriptor;
    expect(slider?.states).toEqual({
      disabled: false,
      readonly: false,
      required: true,
      invalid: true,
      checked: "mixed",
      selected: true,
      expanded: false,
      pressed: "mixed",
      focused: false,
      level: 3,
      modal: true,
      hasPopup: "menu",
    });
    expect(slider?.range).toEqual({ min: 0, max: 10, now: 5, text: "half" });
  });

  it("retains safe scroll capability from AX when DOMSnapshot cannot report it", () => {
    const nodes = normalizeSemanticFrames([
      frame([
        axNode({
          nodeId: "region",
          ignored: false,
          role: { type: "role", value: "region" },
          name: { type: "computedString", value: "Results" },
          backendDOMNodeId: 30,
          properties: [property("scrollable", true)],
        }),
      ]),
    ]);

    expect(nodes[0]?.descriptor.actions).toEqual(["scroll", "inspect"]);
  });
});
