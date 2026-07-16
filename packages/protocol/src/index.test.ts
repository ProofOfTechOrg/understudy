import { describe, it, expect } from "vitest";
import {
  A11yNodeSchema,
  CommandSchema,
  EventSchema,
  isWriteCommand,
  parseCommand,
  safeParseCommand,
  safeParseEvent,
  type Command,
} from "./index";

describe("CommandSchema", () => {
  it("parses a valid snapshot command", () => {
    const cmd = { type: "snapshot", commandId: "c1", mode: "a11y" };
    expect(parseCommand(cmd)).toEqual(cmd);
  });

  it("rejects a command missing commandId", () => {
    expect(safeParseCommand({ type: "click", ref: "r1" }).success).toBe(false);
  });

  it("rejects an unknown command type", () => {
    expect(safeParseCommand({ type: "explode", commandId: "c1" }).success).toBe(false);
  });

  it("rejects navigate with a non-URL", () => {
    expect(
      safeParseCommand({ type: "navigate", commandId: "c1", url: "not a url" }).success,
    ).toBe(false);
  });

  it("accepts navigate with a real URL", () => {
    const cmd = { type: "navigate", commandId: "c1", url: "https://example.com/" };
    expect(CommandSchema.parse(cmd)).toEqual(cmd);
  });

  it("parses a valid fill_secret command", () => {
    const cmd = {
      type: "fill_secret",
      commandId: "c1",
      ref: "s1e2",
      secretRef: "vault://x",
      submit: true,
    };
    expect(parseCommand(cmd)).toEqual(cmd);
  });

  it("rejects fill_secret missing secretRef", () => {
    expect(
      safeParseCommand({ type: "fill_secret", commandId: "c1", ref: "s1e2" }).success,
    ).toBe(false);
  });

  it("parses a valid resolve_ref command", () => {
    const cmd = { type: "resolve_ref", commandId: "c1", ref: "s1e2" };
    expect(parseCommand(cmd)).toEqual(cmd);
  });

  it("rejects resolve_ref missing ref", () => {
    expect(safeParseCommand({ type: "resolve_ref", commandId: "c1" }).success).toBe(false);
  });
});

describe("isWriteCommand", () => {
  it("classifies writes vs reads", () => {
    const click: Command = { type: "click", commandId: "c1", ref: "r1" };
    const snap: Command = { type: "snapshot", commandId: "c2", mode: "a11y" };
    expect(isWriteCommand(click)).toBe(true);
    expect(isWriteCommand(snap)).toBe(false);
  });

  it("classifies fill_secret as a write", () => {
    const fillSecret: Command = {
      type: "fill_secret",
      commandId: "c1",
      ref: "s1e2",
      secretRef: "vault://x",
    };
    expect(isWriteCommand(fillSecret)).toBe(true);
  });

  it("classifies resolve_ref as a read - the dry-run probe must run freely", () => {
    const probe: Command = { type: "resolve_ref", commandId: "c1", ref: "s1e2" };
    expect(isWriteCommand(probe)).toBe(false);
  });
});

describe("EventSchema", () => {
  it("round-trips an action_result", () => {
    const ev = { type: "action_result", commandId: "c1", ok: true, url: "https://example.com/" };
    expect(EventSchema.parse(ev)).toEqual(ev);
  });

  it("round-trips an action_result with simulated:true", () => {
    const ev = { type: "action_result", commandId: "c1", ok: true, simulated: true };
    expect(EventSchema.parse(ev)).toEqual(ev);
  });

  it("parses an action_result without simulated (optional)", () => {
    const ev = { type: "action_result", commandId: "c1", ok: true };
    expect(EventSchema.parse(ev)).toEqual(ev);
  });

  it("rejects a malformed event", () => {
    expect(safeParseEvent({ type: "action_result" }).success).toBe(false);
  });

  it("round-trips a tabs_result", () => {
    const ev = {
      type: "tabs_result",
      commandId: "c1",
      tabs: [{ tabId: 1, url: "https://x/", title: "X", active: true }],
    };
    expect(EventSchema.parse(ev)).toEqual(ev);
  });

  it("rejects a tabs_result missing tabs", () => {
    expect(safeParseEvent({ type: "tabs_result", commandId: "c1" }).success).toBe(false);
  });
});

describe("A11yNodeSchema", () => {
  it("parses a nested (recursive) tree", () => {
    const tree = {
      ref: "1",
      role: "main",
      children: [{ ref: "2", role: "button", name: "Go" }],
    };
    expect(A11yNodeSchema.parse(tree)).toEqual(tree);
  });
});
