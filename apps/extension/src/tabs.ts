import type { TabInfo } from "@understudy/protocol";

export async function queryTabInfos(): Promise<TabInfo[]> {
  const openTabs = await browser.tabs.query({});
  return openTabs.map((t) => ({
    tabId: t.id ?? -1,
    url: t.url ?? "",
    title: t.title ?? "",
    active: t.active,
  }));
}
