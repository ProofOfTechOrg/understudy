import type { Command, Event } from "@understudy/protocol";
import type { CdpSession } from "../driver/cdp";
import { actionError, errorMessage } from "../events";
import { queryTabInfos } from "../tabs";

async function withSession(
  session: CdpSession | null,
  commandId: string,
  run: (session: CdpSession) => Promise<Event>,
): Promise<Event> {
  if (session === null) {
    return actionError(commandId, "no active CDP session");
  }
  return run(session);
}

async function routeGetTabs(commandId: string): Promise<Event> {
  const tabs = await queryTabInfos();
  return { type: "tabs_result", commandId, tabs };
}

async function routeSwitchTab(commandId: string, tabId: number): Promise<Event> {
  await browser.tabs.update(tabId, { active: true });
  return { type: "action_result", commandId, ok: true };
}

export async function routeCommand(cmd: Command, session: CdpSession | null): Promise<Event> {
  try {
    switch (cmd.type) {
      case "snapshot": {
        if (cmd.mode === "dom") {
          return actionError(cmd.commandId, "dom snapshot unsupported");
        }
        if (session === null) {
          return actionError(cmd.commandId, "no active CDP session");
        }
        if (cmd.mode === "a11y") {
          return await session.snapshotA11y(cmd.commandId);
        }
        return await session.screenshot(cmd.commandId);
      }
      case "navigate": {
        const { url } = cmd;
        return await withSession(session, cmd.commandId, (s) => s.navigate(cmd.commandId, url));
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
      case "get_tabs":
        return await routeGetTabs(cmd.commandId);
      case "switch_tab":
        return await routeSwitchTab(cmd.commandId, cmd.tabId);
      default: {
        const fallback = cmd as Command;
        return actionError(fallback.commandId, `unhandled command type: ${fallback.type}`);
      }
    }
  } catch (cause) {
    return actionError(cmd.commandId, errorMessage(cause));
  }
}
