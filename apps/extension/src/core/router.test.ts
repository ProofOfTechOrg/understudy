import { describe, it, expect, vi, afterEach } from "vitest";
import type { Mock } from "vitest";
import type { Command, Event } from "@understudy/protocol";
import type { CdpSession } from "../driver/cdp";
import { routeCommand } from "./router";

interface MockSession {
  snapshotA11y: Mock;
  screenshot: Mock;
  click: Mock;
  type: Mock;
  key: Mock;
  scroll: Mock;
  wait: Mock;
  navigate: Mock;
}

function createMockSession(): MockSession {
  return {
    snapshotA11y: vi.fn(),
    screenshot: vi.fn(),
    click: vi.fn(),
    type: vi.fn(),
    key: vi.fn(),
    scroll: vi.fn(),
    wait: vi.fn(),
    navigate: vi.fn(),
  };
}

function asSession(mock: MockSession): CdpSession {
  return mock as unknown as CdpSession;
}

function stubBrowserTabs(): { query: Mock; update: Mock } {
  const query = vi.fn();
  const update = vi.fn();
  vi.stubGlobal("browser", { tabs: { query, update } });
  return { query, update };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("routeCommand", () => {
  it("routes snapshot mode a11y to session.snapshotA11y and returns its event", async () => {
    const mock = createMockSession();
    const event: Event = { type: "snapshot_result", commandId: "c-a11y", tree: [] };
    mock.snapshotA11y.mockResolvedValue(event);
    const cmd: Command = { type: "snapshot", commandId: "c-a11y", mode: "a11y" };

    const result = await routeCommand(cmd, asSession(mock));

    expect(mock.snapshotA11y).toHaveBeenCalledWith("c-a11y");
    expect(result).toEqual(event);
  });

  it("routes snapshot mode screenshot to session.screenshot and returns its event", async () => {
    const mock = createMockSession();
    const event: Event = { type: "screenshot_result", commandId: "c-shot", mime: "image/png", b64: "QQ==" };
    mock.screenshot.mockResolvedValue(event);
    const cmd: Command = { type: "snapshot", commandId: "c-shot", mode: "screenshot" };

    const result = await routeCommand(cmd, asSession(mock));

    expect(mock.screenshot).toHaveBeenCalledWith("c-shot");
    expect(result).toEqual(event);
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

  it("returns tabs_result with the mapped open tabs for get_tabs", async () => {
    const { query } = stubBrowserTabs();
    query.mockResolvedValue([
      { id: 1, url: "https://a.example/", title: "A", active: true },
      { id: 2, url: "https://b.example/", title: "B", active: false },
    ]);
    const cmd: Command = { type: "get_tabs", commandId: "c-tabs" };

    const result = await routeCommand(cmd, null);

    expect(query).toHaveBeenCalledWith({});
    expect(result).toEqual({
      type: "tabs_result",
      commandId: "c-tabs",
      tabs: [
        { tabId: 1, url: "https://a.example/", title: "A", active: true },
        { tabId: 2, url: "https://b.example/", title: "B", active: false },
      ],
    });
  });

  it("activates the tab and returns action_result ok for switch_tab", async () => {
    const { update } = stubBrowserTabs();
    update.mockResolvedValue(undefined);
    const cmd: Command = { type: "switch_tab", commandId: "c-switch", tabId: 7 };

    const result = await routeCommand(cmd, null);

    expect(update).toHaveBeenCalledWith(7, { active: true });
    expect(result).toEqual({ type: "action_result", commandId: "c-switch", ok: true });
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
