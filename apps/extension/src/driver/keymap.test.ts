import { describe, it, expect } from "vitest";
import { parseKeys } from "./keymap";

describe("parseKeys", () => {
  it("composes the bitmask for single modifiers (Alt=1, Ctrl=2, Meta=4, Shift=8)", () => {
    expect(parseKeys("Alt+a").modifiers).toBe(1);
    expect(parseKeys("Ctrl+a").modifiers).toBe(2);
    expect(parseKeys("Meta+a").modifiers).toBe(4);
    expect(parseKeys("Shift+a").modifiers).toBe(8);
  });

  it("ORs the bitmask for combined modifiers", () => {
    expect(parseKeys("Ctrl+Shift+A").modifiers).toBe(2 | 8);
    expect(parseKeys("Ctrl+Alt+Delete").modifiers).toBe(2 | 1);
    expect(parseKeys("Ctrl+Alt+Shift+Meta+a").modifiers).toBe(1 | 2 | 4 | 8);
  });

  it("accepts modifier aliases case-insensitively", () => {
    expect(parseKeys("control+a").modifiers).toBe(2);
    expect(parseKeys("cmd+a").modifiers).toBe(4);
    expect(parseKeys("OPTION+a").modifiers).toBe(1);
  });

  it("maps named keys to {key, code, windowsVirtualKeyCode}", () => {
    expect(parseKeys("Enter")).toEqual({
      modifiers: 0,
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
    });
    expect(parseKeys("Tab")).toMatchObject({ key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    expect(parseKeys("Escape")).toMatchObject({
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
    });
    expect(parseKeys("ArrowLeft")).toMatchObject({
      key: "ArrowLeft",
      code: "ArrowLeft",
      windowsVirtualKeyCode: 37,
    });
  });

  it("carries text for a plain printable key", () => {
    expect(parseKeys("a")).toEqual({
      modifiers: 0,
      key: "a",
      code: "KeyA",
      windowsVirtualKeyCode: 65,
      text: "a",
    });
    // Shift uppercases a printable letter's key and text.
    expect(parseKeys("Shift+a")).toMatchObject({ key: "A", text: "A", modifiers: 8 });
    // A command modifier (Ctrl) makes it a shortcut, so no text is produced.
    expect(parseKeys("Ctrl+a").text).toBeUndefined();
  });

  it("does not set text for named or control keys", () => {
    expect(parseKeys("Enter").text).toBeUndefined();
    expect(parseKeys("Ctrl+Enter").text).toBeUndefined();
  });
});
