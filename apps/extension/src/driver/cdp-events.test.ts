import { describe, it, expect } from "vitest";
import { classifyCdpEvent, dialogDisposition } from "./cdp-events";

const ctx = { currentUrl: "https://example.com/current", mainFrameId: "F1" };

describe("classifyCdpEvent", () => {
  it("bumps generation, sets newUrl, and emits a navigated pageEvent for the main frame", () => {
    const decision = classifyCdpEvent(
      "Page.frameNavigated",
      {
        frame: {
          id: "F1",
          url: "https://example.com/next",
          urlFragment: "#details",
        },
      },
      ctx,
    );
    expect(decision).toEqual({
      newMainFrameId: "F1",
      newUrl: "https://example.com/next#details",
      bumpGeneration: true,
      loadStarted: true,
      pageEvent: { kind: "navigated", url: "https://example.com/next#details" },
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

  it("tracks a same-document navigation for the main frame without starting a load", () => {
    const decision = classifyCdpEvent(
      "Page.navigatedWithinDocument",
      {
        frameId: "F1",
        url: "https://example.com/current#details",
        navigationType: "fragment",
      },
      ctx,
    );
    expect(decision).toEqual({
      newUrl: "https://example.com/current#details",
      bumpGeneration: true,
      pageEvent: {
        kind: "navigated",
        url: "https://example.com/current#details",
      },
    });
  });

  it("ignores a same-document navigation from a subframe", () => {
    const decision = classifyCdpEvent(
      "Page.navigatedWithinDocument",
      {
        frameId: "F2",
        url: "https://frame.example/#details",
        navigationType: "fragment",
      },
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

  it("accepts an alert dialog and reports it (single OK button - just close the info box)", () => {
    const decision = classifyCdpEvent(
      "Page.javascriptDialogOpening",
      { url: "https://example.com/", message: "Saved", type: "alert" },
      ctx,
    );
    expect(decision).toEqual({
      dialog: {
        accept: true,
        event: {
          dialogType: "alert",
          message: "Saved",
          url: "https://example.com/",
          disposition: "accept",
        },
      },
    });
  });

  it("dismisses a confirm dialog and reports it (never auto-confirm a possibly-destructive prompt)", () => {
    const decision = classifyCdpEvent(
      "Page.javascriptDialogOpening",
      { url: "https://example.com/", message: "Delete this item?", type: "confirm" },
      ctx,
    );
    expect(decision).toEqual({
      dialog: {
        accept: false,
        event: {
          dialogType: "confirm",
          message: "Delete this item?",
          url: "https://example.com/",
          disposition: "dismiss",
        },
      },
    });
  });

  it("dismisses a prompt dialog, carrying its defaultPrompt through to the consumer", () => {
    const decision = classifyCdpEvent(
      "Page.javascriptDialogOpening",
      { url: "https://example.com/", message: "Your name?", type: "prompt", defaultPrompt: "guest" },
      ctx,
    );
    expect(decision).toEqual({
      dialog: {
        accept: false,
        event: {
          dialogType: "prompt",
          message: "Your name?",
          url: "https://example.com/",
          defaultPrompt: "guest",
          disposition: "dismiss",
        },
      },
    });
  });

  it("accepts a beforeunload dialog so navigation proceeds (a dismiss would cancel it)", () => {
    const decision = classifyCdpEvent(
      "Page.javascriptDialogOpening",
      { url: "https://example.com/", message: "", type: "beforeunload" },
      ctx,
    );
    expect(decision).toEqual({
      dialog: {
        accept: true,
        event: {
          dialogType: "beforeunload",
          message: "",
          url: "https://example.com/",
          disposition: "accept",
        },
      },
    });
  });

  it("dismisses an unclassifiable dialog type without emitting an event (the channel must still be freed)", () => {
    const decision = classifyCdpEvent(
      "Page.javascriptDialogOpening",
      { url: "https://example.com/", message: "?", type: "not-a-real-type" },
      ctx,
    );
    expect(decision).toEqual({ dialog: { accept: false } });
  });

  it("returns an empty decision for an unrelated method", () => {
    expect(classifyCdpEvent("Runtime.consoleAPICalled", { type: "log" }, ctx)).toEqual({});
  });
});

describe("dialogDisposition", () => {
  it("accepts informational/navigational dialogs, dismisses intent-carrying ones", () => {
    expect(dialogDisposition("alert")).toBe("accept");
    expect(dialogDisposition("beforeunload")).toBe("accept");
    expect(dialogDisposition("confirm")).toBe("dismiss");
    expect(dialogDisposition("prompt")).toBe("dismiss");
  });
});
