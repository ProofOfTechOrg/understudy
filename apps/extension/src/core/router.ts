import {
  SESSION_RESULT_FRAME_MAX_BYTES,
  safeParseEvent,
  utf8ByteLength,
  type Command,
  type Event,
} from "@understudy/protocol";
import type { CdpSession } from "../driver/cdp";
import { actionError, errorMessage } from "../events";

async function withSession(
  session: CdpSession | null,
  commandId: string,
  run: (session: CdpSession) => Promise<Event>,
  expectedTabId?: number,
): Promise<Event> {
  if (session === null) {
    return actionError(commandId, "no active CDP session");
  }
  if (expectedTabId !== undefined && expectedTabId !== session.tabId) {
    return actionError(
      commandId,
      `attached CDP session is tab ${session.tabId}, not requested tab ${expectedTabId}`,
    );
  }
  return run(session);
}

async function routeGetTabs(commandId: string, session: CdpSession | null): Promise<Event> {
  if (session === null) return actionError(commandId, "no active CDP session");
  const tab = await browser.tabs.get(session.tabId);
  return {
    type: "tabs_result",
    commandId,
    tabs: [
      {
        tabId: session.tabId,
        url: tab.url ?? session.currentUrl,
        title: tab.title ?? "",
        active: tab.active,
      },
    ],
  };
}

async function routeSwitchTab(
  commandId: string,
  tabId: number,
  session: CdpSession | null,
): Promise<Event> {
  if (session === null) return actionError(commandId, "no active CDP session");
  if (tabId !== session.tabId) {
    return actionError(commandId, `tab ${tabId} is not owned by this session`);
  }
  return { type: "action_result", commandId, ok: true };
}

export async function routeCommand(cmd: Command, session: CdpSession | null): Promise<Event> {
  const event = await routeCommandUnchecked(cmd, session);
  const parsed = safeParseEvent(event);
  if (
    parsed.success &&
    utf8ByteLength(JSON.stringify(parsed.data)) <= SESSION_RESULT_FRAME_MAX_BYTES
  ) {
    return parsed.data;
  }
  return actionError(cmd.commandId, "command result exceeded protocol limits");
}

async function routeCommandUnchecked(
  cmd: Command,
  session: CdpSession | null,
): Promise<Event> {
  try {
    switch (cmd.type) {
      case "snapshot": {
        if (cmd.mode === "dom") {
          return actionError(cmd.commandId, "dom snapshot unsupported");
        }
        if (cmd.mode === "a11y") {
          return await withSession(
            session,
            cmd.commandId,
            (s) => s.snapshotA11y(cmd.commandId),
            cmd.tabId,
          );
        }
        return await withSession(
          session,
          cmd.commandId,
          (s) => s.screenshot(cmd.commandId),
          cmd.tabId,
        );
      }
      case "navigate": {
        const { url } = cmd;
        return await withSession(
          session,
          cmd.commandId,
          (s) => s.navigate(cmd.commandId, url),
          cmd.tabId,
        );
      }
      case "click": {
        const { ref } = cmd;
        return await withSession(session, cmd.commandId, (s) => s.click(cmd.commandId, ref));
      }
      case "type": {
        const { ref, text, submit } = cmd;
        return await withSession(session, cmd.commandId, (s) => s.type(cmd.commandId, ref, text, submit));
      }
      case "key": {
        const { keys, ref } = cmd;
        return await withSession(session, cmd.commandId, (s) => s.key(cmd.commandId, keys, ref));
      }
      case "scroll": {
        const { dy, ref } = cmd;
        return await withSession(session, cmd.commandId, (s) => s.scroll(cmd.commandId, dy, ref));
      }
      case "wait": {
        const { for: waitFor, value } = cmd;
        return await withSession(session, cmd.commandId, (s) => s.wait(cmd.commandId, waitFor, value));
      }
      case "resolve_ref": {
        const { ref } = cmd;
        return await withSession(session, cmd.commandId, (s) =>
          s.resolveRefCheck(cmd.commandId, ref),
        );
      }
      case "get_tabs":
        return await routeGetTabs(cmd.commandId, session);
      case "switch_tab":
        return await routeSwitchTab(cmd.commandId, cmd.tabId, session);
      default: {
        const fallback = cmd as Command;
        return actionError(fallback.commandId, `unhandled command type: ${fallback.type}`);
      }
    }
  } catch (cause) {
    return actionError(cmd.commandId, errorMessage(cause));
  }
}
