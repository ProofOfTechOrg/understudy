import type { TabInfo } from "@understudy/protocol";

interface TargetInfoResult {
  targetInfo?: {
    url?: unknown;
    title?: unknown;
  };
}

export async function controlledTabInfo(
  tabId: number,
  fallbackUrl = "about:blank",
): Promise<TabInfo> {
  const [target, tab] = await Promise.all([
    browser.debugger.sendCommand(
      { tabId },
      "Target.getTargetInfo",
    ) as Promise<TargetInfoResult>,
    browser.tabs.get(tabId),
  ]);
  const url = target.targetInfo?.url;
  const title = target.targetInfo?.title;
  return {
    tabId,
    url: typeof url === "string" ? url : fallbackUrl,
    title: typeof title === "string" ? title : "",
    active: tab.active,
  };
}
