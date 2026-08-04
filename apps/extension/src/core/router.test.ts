import { describe, it, expect, vi, afterEach } from "vitest";
import type { Mock } from "vitest";
import type { Command, Event } from "@understudy/protocol";
import type { CdpSession } from "../driver/cdp";
import { routeCommand } from "./router";

interface MockSession {
  tabId: number;
  snapshotA11y: Mock;
  screenshot: Mock;
  captureElements: Mock;
  findElements: Mock;
  inspectElements: Mock;
  continueElements: Mock;
  click: Mock;
  type: Mock;
  key: Mock;
  scroll: Mock;
  wait: Mock;
  navigate: Mock;
  resolveRefCheck: Mock;
}

function createMockSession(): MockSession {
  return {
    tabId: 7,
    snapshotA11y: vi.fn(),
    screenshot: vi.fn(),
    captureElements: vi.fn(),
    findElements: vi.fn(),
    inspectElements: vi.fn(),
    continueElements: vi.fn(),
    click: vi.fn(),
    type: vi.fn(),
    key: vi.fn(),
    scroll: vi.fn(),
    wait: vi.fn(),
    navigate: vi.fn(),
    resolveRefCheck: vi.fn(),
  };
}

function asSession(mock: MockSession): CdpSession {
  return mock as unknown as CdpSession;
}

function stubBrowserTabs(): {
  get: Mock;
  query: Mock;
  sendCommand: Mock;
  update: Mock;
} {
  const get = vi.fn();
  const query = vi.fn();
  const sendCommand = vi.fn(async () => ({ targetInfo: {} }));
  const update = vi.fn();
  vi.stubGlobal("browser", {
    debugger: { sendCommand },
    tabs: { get, query, update },
  });
  return { get, query, sendCommand, update };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("routeCommand", () => {
  it("routes snapshot mode a11y to session.snapshotA11y and returns its event", async () => {
    const mock = createMockSession();
    const event: Event = {
      type: "snapshot_result",
      commandId: "c-a11y",
      tree: [],
      tabId: 7,
      url: "https://example.com/",
    };
    mock.snapshotA11y.mockResolvedValue(event);
    const cmd: Command = { type: "snapshot", commandId: "c-a11y", mode: "a11y" };

    const result = await routeCommand(cmd, asSession(mock));

    expect(mock.snapshotA11y).toHaveBeenCalledWith("c-a11y");
    expect(result).toEqual(event);
  });

  it("routes snapshot mode screenshot to session.screenshot and returns its event", async () => {
    const mock = createMockSession();
    const event: Event = {
      type: "screenshot_result",
      commandId: "c-shot",
      mime: "image/png",
      b64: "QQ==",
      tabId: 7,
      url: "https://example.com/",
    };
    mock.screenshot.mockResolvedValue(event);
    const cmd: Command = { type: "snapshot", commandId: "c-shot", mode: "screenshot" };

    const result = await routeCommand(cmd, asSession(mock));

    expect(mock.screenshot).toHaveBeenCalledWith("c-shot");
    expect(result).toEqual(event);
  });

  it("routes every semantic operation with its bounded inputs", async () => {
    const mock = createMockSession();
    const response = {
      type: "elements_result",
      commandId: "semantic",
      operation: "snapshot",
      status: "error",
      reason: "capture_failed",
      retryable: true,
    } as const;
    mock.captureElements.mockResolvedValue(response);
    mock.findElements.mockResolvedValue({ ...response, operation: "find" });
    mock.inspectElements.mockResolvedValue({ ...response, operation: "inspect" });
    mock.continueElements.mockResolvedValue({ ...response, operation: "next" });

    await routeCommand(
      {
        type: "capture_elements",
        commandId: "semantic",
        scope: "viewport",
        view: "interactive",
        limit: 80,
        changesOnly: false,
      },
      asSession(mock),
    );
    await routeCommand(
      {
        type: "find_elements",
        commandId: "semantic",
        query: "Pay",
        roles: ["button"],
        match: "contains",
        includeHidden: false,
        limit: 20,
      },
      asSession(mock),
    );
    await routeCommand(
      {
        type: "inspect_elements",
        commandId: "semantic",
        ref: "ref",
        depth: 3,
        limit: 80,
        includeBounds: true,
      },
      asSession(mock),
    );
    await routeCommand(
      { type: "continue_elements", commandId: "semantic", cursor: "cursor" },
      asSession(mock),
    );

    expect(mock.captureElements).toHaveBeenCalledWith(
      "semantic",
      "viewport",
      "interactive",
      80,
      false,
    );
    expect(mock.findElements).toHaveBeenCalledWith(
      "semantic",
      "Pay",
      ["button"],
      "contains",
      false,
      20,
    );
    expect(mock.inspectElements).toHaveBeenCalledWith(
      "semantic",
      "ref",
      3,
      80,
      true,
    );
    expect(mock.continueElements).toHaveBeenCalledWith("semantic", "cursor");
  });

  it("returns a strict semantic failure when no CDP session is active", async () => {
    await expect(
      routeCommand(
        {
          type: "capture_elements",
          commandId: "semantic",
          scope: "viewport",
          view: "interactive",
          limit: 80,
          changesOnly: false,
        },
        null,
      ),
    ).resolves.toEqual({
      type: "elements_result",
      commandId: "semantic",
      operation: "snapshot",
      status: "error",
      reason: "capture_failed",
      retryable: true,
    });
  });

  it("rejects a result whose complete WebSocket frame exceeds the session limit", async () => {
    const mock = createMockSession();
    mock.screenshot.mockResolvedValue({
      type: "screenshot_result",
      commandId: "c-large",
      mime: "image/png",
      b64: "a".repeat(16 * 1024 * 1024),
      tabId: 7,
      url: "https://example.com/",
    });

    const result = await routeCommand(
      { type: "snapshot", commandId: "c-large", mode: "screenshot" },
      asSession(mock),
    );

    expect(result).toEqual({
      type: "action_result",
      commandId: "c-large",
      ok: false,
      error: "command result exceeded protocol limits",
    });
  });

  it("rejects a snapshot requested for a tab other than the attached CDP session", async () => {
    const mock = createMockSession();
    const cmd: Command = { type: "snapshot", commandId: "c-mismatch", mode: "a11y", tabId: 8 };

    const result = await routeCommand(cmd, asSession(mock));

    expect(result).toEqual({
      type: "action_result",
      commandId: "c-mismatch",
      ok: false,
      error: "attached CDP session is tab 7, not requested tab 8",
    });
    expect(mock.snapshotA11y).not.toHaveBeenCalled();
  });

  it("returns action_result unsupported for snapshot mode dom without touching the session", async () => {
    const mock = createMockSession();
    const cmd: Command = { type: "snapshot", commandId: "c-dom", mode: "dom" };

    const result = await routeCommand(cmd, asSession(mock));

    expect(result).toEqual({
      type: "action_result",
      commandId: "c-dom",
      ok: false,
      error: "dom snapshot unsupported",
    });
    expect(mock.snapshotA11y).not.toHaveBeenCalled();
    expect(mock.screenshot).not.toHaveBeenCalled();
  });

  it("routes navigate to session.navigate with the url", async () => {
    const mock = createMockSession();
    const event: Event = { type: "action_result", commandId: "c-nav", ok: true, url: "https://example.com/" };
    mock.navigate.mockResolvedValue(event);
    const cmd: Command = { type: "navigate", commandId: "c-nav", url: "https://example.com/" };

    const result = await routeCommand(cmd, asSession(mock));

    expect(mock.navigate).toHaveBeenCalledWith("c-nav", "https://example.com/");
    expect(result).toEqual(event);
  });

  it("rejects navigate when its requested tab differs from the attached CDP session", async () => {
    const mock = createMockSession();
    const cmd: Command = {
      type: "navigate",
      commandId: "c-nav-mismatch",
      url: "https://example.com/",
      tabId: 8,
    };

    const result = await routeCommand(cmd, asSession(mock));

    expect(result).toEqual({
      type: "action_result",
      commandId: "c-nav-mismatch",
      ok: false,
      error: "attached CDP session is tab 7, not requested tab 8",
    });
    expect(mock.navigate).not.toHaveBeenCalled();
  });

  it("routes click to session.click with the ref", async () => {
    const mock = createMockSession();
    const event: Event = { type: "action_result", commandId: "c-click", ok: true };
    mock.click.mockResolvedValue(event);
    const cmd: Command = { type: "click", commandId: "c-click", ref: "s0e1" };

    const result = await routeCommand(cmd, asSession(mock));

    expect(mock.click).toHaveBeenCalledWith("c-click", "s0e1");
    expect(result).toEqual(event);
  });

  it("routes type to session.type with ref, text, and submit", async () => {
    const mock = createMockSession();
    const event: Event = { type: "action_result", commandId: "c-type", ok: true };
    mock.type.mockResolvedValue(event);
    const cmd: Command = {
      type: "type",
      commandId: "c-type",
      ref: "s0e2",
      text: "hello",
      submit: true,
    };

    const result = await routeCommand(cmd, asSession(mock));

    expect(mock.type).toHaveBeenCalledWith("c-type", "s0e2", "hello", true);
    expect(result).toEqual(event);
  });

  it("routes key to session.key with keys and the optional ref", async () => {
    const mock = createMockSession();
    const event: Event = { type: "action_result", commandId: "c-key", ok: true };
    mock.key.mockResolvedValue(event);
    const cmd: Command = { type: "key", commandId: "c-key", keys: "Enter", ref: "s0e3" };

    const result = await routeCommand(cmd, asSession(mock));

    expect(mock.key).toHaveBeenCalledWith("c-key", "Enter", "s0e3");
    expect(result).toEqual(event);
  });

  it("routes scroll to session.scroll with dy before the optional ref", async () => {
    const mock = createMockSession();
    const event: Event = { type: "action_result", commandId: "c-scroll", ok: true };
    mock.scroll.mockResolvedValue(event);
    const cmd: Command = { type: "scroll", commandId: "c-scroll", dy: 200, ref: "s0e4" };

    const result = await routeCommand(cmd, asSession(mock));

    expect(mock.scroll).toHaveBeenCalledWith("c-scroll", 200, "s0e4");
    expect(result).toEqual(event);
  });

  it("routes wait to session.wait with the for-mode and optional value", async () => {
    const mock = createMockSession();
    const event: Event = { type: "action_result", commandId: "c-wait", ok: true, url: "https://example.com/" };
    mock.wait.mockResolvedValue(event);
    const cmd: Command = { type: "wait", commandId: "c-wait", for: "ms", value: 500 };

    const result = await routeCommand(cmd, asSession(mock));

    expect(mock.wait).toHaveBeenCalledWith("c-wait", "ms", 500);
    expect(result).toEqual(event);
  });

  it("routes resolve_ref to session.resolveRefCheck with the ref", async () => {
    const mock = createMockSession();
    const event: Event = { type: "action_result", commandId: "c-resolve", ok: true };
    mock.resolveRefCheck.mockResolvedValue(event);
    const cmd: Command = { type: "resolve_ref", commandId: "c-resolve", ref: "s0e5" };

    const result = await routeCommand(cmd, asSession(mock));

    expect(mock.resolveRefCheck).toHaveBeenCalledWith("c-resolve", "s0e5");
    expect(result).toEqual(event);
  });

  it("returns action_result failure for resolve_ref with a null session", async () => {
    const cmd: Command = { type: "resolve_ref", commandId: "c-resolve-null", ref: "s0e5" };

    const result = await routeCommand(cmd, null);

    expect(result).toEqual({
      type: "action_result",
      commandId: "c-resolve-null",
      ok: false,
      error: "no active CDP session",
    });
  });

  it("returns only the session-owned tab for get_tabs", async () => {
    const { get, query, sendCommand } = stubBrowserTabs();
    get.mockResolvedValue({
      id: 7,
      active: false,
    });
    sendCommand.mockResolvedValue({
      targetInfo: {
        url: "https://owned.example/",
        title: "Owned",
      },
    });
    const cmd: Command = { type: "get_tabs", commandId: "c-tabs" };

    const result = await routeCommand(cmd, asSession(createMockSession()));

    expect(get).toHaveBeenCalledWith(7);
    expect(sendCommand).toHaveBeenCalledWith(
      { tabId: 7 },
      "Target.getTargetInfo",
    );
    expect(query).not.toHaveBeenCalled();
    expect(result).toEqual({
      type: "tabs_result",
      commandId: "c-tabs",
      tabs: [
        { tabId: 7, url: "https://owned.example/", title: "Owned", active: false },
      ],
    });
  });

  it("accepts the owned tab without activating through the tabs API", async () => {
    const { update } = stubBrowserTabs();
    const cmd: Command = { type: "switch_tab", commandId: "c-switch", tabId: 7 };

    const result = await routeCommand(cmd, asSession(createMockSession()));

    expect(update).not.toHaveBeenCalled();
    expect(result).toEqual({ type: "action_result", commandId: "c-switch", ok: true });
  });

  it("rejects switch_tab for every profile tab not owned by the session", async () => {
    const { update } = stubBrowserTabs();
    const cmd: Command = { type: "switch_tab", commandId: "c-switch-other", tabId: 8 };

    const result = await routeCommand(cmd, asSession(createMockSession()));

    expect(update).not.toHaveBeenCalled();
    expect(result).toEqual({
      type: "action_result",
      commandId: "c-switch-other",
      ok: false,
      error: "tab 8 is not owned by this session",
    });
  });

  it("returns action_result failure for a null session on a session-requiring command", async () => {
    const cmd: Command = { type: "click", commandId: "c-null", ref: "s0e1" };

    const result = await routeCommand(cmd, null);

    expect(result).toEqual({
      type: "action_result",
      commandId: "c-null",
      ok: false,
      error: expect.any(String),
    });
  });

  it("converts a throwing executor into action_result failure instead of rejecting", async () => {
    const mock = createMockSession();
    mock.click.mockImplementation(() => {
      throw new Error("boom");
    });
    const cmd: Command = { type: "click", commandId: "c-throw", ref: "s0e1" };

    await expect(routeCommand(cmd, asSession(mock))).resolves.toEqual({
      type: "action_result",
      commandId: "c-throw",
      ok: false,
      error: "boom",
    });
  });
});
