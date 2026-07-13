import type { Protocol } from "devtools-protocol";

// The effects the background service worker must apply for a raw CDP event. Every
// field is optional so an empty decision ({}) is a valid no-op and the consumer
// can branch on `decision.bumpGeneration` / `decision.pageEvent` / etc.
export interface CdpDecision {
  bumpGeneration?: boolean;
  pageEvent?: { kind: "navigated" | "load"; url: string };
  newUrl?: string;
  dismissDialog?: boolean;
}

// Narrow a raw CDP payload to Page.frameNavigated, or null when it is not shaped
// like one. Keeps the classifier type-safe over the loosely-typed `params`.
function asFrameNavigated(params: unknown): Protocol.Page.FrameNavigatedEvent | null {
  if (typeof params !== "object" || params === null) return null;
  const frame = (params as { frame?: unknown }).frame;
  if (typeof frame !== "object" || frame === null) return null;
  if (typeof (frame as { url?: unknown }).url !== "string") return null;
  return params as Protocol.Page.FrameNavigatedEvent;
}

export function classifyCdpEvent(
  method: string,
  params: unknown,
  ctx: { currentUrl: string },
): CdpDecision {
  switch (method) {
    case "Page.frameNavigated": {
      const evt = asFrameNavigated(params);
      // Main frame only: a subframe navigation carries a parentId and is ignored.
      if (evt === null || evt.frame.parentId !== undefined) return {};
      const url = evt.frame.url;
      return { newUrl: url, bumpGeneration: true, pageEvent: { kind: "navigated", url } };
    }
    case "Page.loadEventFired":
      // The load event carries no URL; use the generation-tracked current URL.
      return { pageEvent: { kind: "load", url: ctx.currentUrl } };
    case "DOM.documentUpdated":
      // A SPA DOM swap invalidates every outstanding ref, so bump the generation.
      return { bumpGeneration: true };
    case "Page.javascriptDialogOpening":
      return { dismissDialog: true };
    default:
      return {};
  }
}
