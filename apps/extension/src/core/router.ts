import {
  SESSION_RESULT_FRAME_MAX_BYTES,
  safeParseEvent,
  utf8ByteLength,
  type Command,
  type ElementsResult,
  type Event,
} from "@understudy/protocol";
import type { CdpSession } from "../driver/cdp";
import { actionError, errorMessage } from "../events";
import { controlledTabInfo } from "../tabs";

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

function semanticOperation(
  command: Command,
): ElementsResult["operation"] | undefined {
  switch (command.type) {
    case "capture_elements":
      return "snapshot";
    case "find_elements":
      return "find";
    case "inspect_elements":
      return "inspect";
    case "continue_elements":
      return "next";
    default:
      return undefined;
  }
}

function semanticFailure(
  commandId: string,
  operation: ElementsResult["operation"],
  reason: "capture_failed" | "page_too_large",
): ElementsResult {
  return {
    type: "elements_result",
    commandId,
    operation,
    status: "error",
    reason,
    retryable: reason === "capture_failed",
  };
}

async function withSemanticSession(
  session: CdpSession | null,
  commandId: string,
  operation: ElementsResult["operation"],
  run: (session: CdpSession) => Promise<Event>,
): Promise<Event> {
  return session === null
    ? semanticFailure(commandId, operation, "capture_failed")
    : run(session);
}

async function routeGetTabs(commandId: string, session: CdpSession | null): Promise<Event> {
  if (session === null) return actionError(commandId, "no active CDP session");
  return {
    type: "tabs_result",
    commandId,
    tabs: [await controlledTabInfo(session.tabId, session.currentUrl)],
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
  const operation = semanticOperation(cmd);
  if (operation !== undefined) {
    return semanticFailure(cmd.commandId, operation, "page_too_large");
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
      case "capture_elements": {
        return await withSemanticSession(session, cmd.commandId, "snapshot", (s) =>
          s.captureElements(
            cmd.commandId,
            cmd.scope,
            cmd.view,
            cmd.limit,
            cmd.changesOnly,
          ),
        );
      }
      case "find_elements": {
        return await withSemanticSession(session, cmd.commandId, "find", (s) =>
          s.findElements(
            cmd.commandId,
            cmd.query,
            cmd.roles,
            cmd.match,
            cmd.includeHidden,
            cmd.limit,
          ),
        );
      }
      case "inspect_elements": {
        return await withSemanticSession(session, cmd.commandId, "inspect", (s) =>
          s.inspectElements(
            cmd.commandId,
            cmd.ref,
            cmd.depth,
            cmd.limit,
            cmd.includeBounds,
          ),
        );
      }
      case "continue_elements": {
        return await withSemanticSession(session, cmd.commandId, "next", (s) =>
          s.continueElements(cmd.commandId, cmd.cursor),
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
    const operation = semanticOperation(cmd);
    if (operation !== undefined) {
      return semanticFailure(cmd.commandId, operation, "capture_failed");
    }
    return actionError(cmd.commandId, errorMessage(cause));
  }
}
