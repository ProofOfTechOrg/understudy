import { describe, it, expect } from "vitest";
import { classifyCdpEvent } from "./cdp-events";

const ctx = { currentUrl: "https://example.com/current" };

describe("classifyCdpEvent", () => {
  it("bumps generation, sets newUrl, and emits a navigated pageEvent for the main frame", () => {
    const decision = classifyCdpEvent(
      "Page.frameNavigated",
      { frame: { id: "F1", url: "https://example.com/next" } },
      ctx,
    );
    expect(decision).toEqual({
      newUrl: "https://example.com/next",
      bumpGeneration: true,
      pageEvent: { kind: "navigated", url: "https://example.com/next" },
    });
  });

  it("ignores a subframe navigation (parentId present)", () => {
    const decision = classifyCdpEvent(
      "Page.frameNavigated",
      { frame: { id: "F2", parentId: "F1", url: "https://ads.example/iframe" } },
      ctx,
    );
    expect(decision).toEqual({});
  });

  it("emits a load pageEvent carrying ctx.currentUrl, not a url from the event", () => {
    const decision = classifyCdpEvent("Page.loadEventFired", { timestamp: 12345 }, ctx);
    expect(decision).toEqual({ pageEvent: { kind: "load", url: "https://example.com/current" } });
  });

  it("bumps generation only for DOM.documentUpdated", () => {
    expect(classifyCdpEvent("DOM.documentUpdated", {}, ctx)).toEqual({ bumpGeneration: true });
  });

  it("dismisses a javascript dialog", () => {
    const decision = classifyCdpEvent(
      "Page.javascriptDialogOpening",
      { url: "https://example.com", message: "hi", type: "alert" },
      ctx,
    );
    expect(decision).toEqual({ dismissDialog: true });
  });

  it("returns an empty decision for an unrelated method", () => {
    expect(classifyCdpEvent("Runtime.consoleAPICalled", { type: "log" }, ctx)).toEqual({});
  });
});
