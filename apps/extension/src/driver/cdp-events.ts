import type { Protocol } from "devtools-protocol";
import { DialogTypeSchema } from "@understudy/protocol";
import type { DialogDisposition, DialogRecord, DialogType } from "@understudy/protocol";

// The reportable fields of a `dialog` protocol Event, minus the wire-level
// `type`/`tabId` the background worker adds (it owns the tabId). Derived from
// the protocol's DialogRecord so it can never drift from the wire shape.
export type DialogEventFields = Omit<
  DialogRecord,
  "tabId" | "dialogId" | "occurredAt"
>;

// The effects the background service worker must apply for a raw CDP event. Every
// field is optional so an empty decision ({}) is a valid no-op and the consumer
// can branch on `decision.bumpGeneration` / `decision.pageEvent` / etc.
export interface CdpDecision {
  bumpGeneration?: boolean;
  preserveDeltaBaseline?: boolean;
  loadStarted?: boolean;
  pageEvent?: { kind: "navigated" | "load"; url: string };
  newMainFrameId?: string;
  newUrl?: string;
  // A page dialog to answer locally, and optionally report. `accept` is how to
  // answer Page.handleJavaScriptDialog and is ALWAYS set when present, so an
  // open dialog never wedges the single CDP channel. `event` is the protocol
  // payload forwarded to the consumer, omitted only for a dialog whose type we
  // could not classify (not expected - CDP's DialogType is a closed enum).
  dialog?: { accept: boolean; event?: DialogEventFields };
}

// Type-aware default disposition, applied synchronously (an open dialog blocks
// the single CDP channel, so we cannot wait for the consumer to decide):
//  - alert:        accept  (a single OK button; just close the info box)
//  - beforeunload: accept  (proceed with navigation - a dismiss would CANCEL
//                           the navigation the automation issued, wedging it)
//  - confirm:      dismiss (Cancel - never auto-confirm a possibly-destructive
//                           "Are you sure?")
//  - prompt:       dismiss (Cancel - never inject text into a page field)
export function dialogDisposition(dialogType: DialogType): DialogDisposition {
  switch (dialogType) {
    case "alert":
    case "beforeunload":
      return "accept";
    case "confirm":
    case "prompt":
      return "dismiss";
  }
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

function asNavigatedWithinDocument(
  params: unknown,
): Protocol.Page.NavigatedWithinDocumentEvent | null {
  if (typeof params !== "object" || params === null) return null;
  const event = params as { frameId?: unknown; url?: unknown };
  if (typeof event.frameId !== "string" || typeof event.url !== "string") return null;
  return params as Protocol.Page.NavigatedWithinDocumentEvent;
}

// Narrow a raw Page.javascriptDialogOpening payload to a KNOWN dialog type, or
// null otherwise. DialogTypeSchema is the protocol's source of truth for the
// four types we model; anything else (not expected from chrome.debugger) is
// unclassifiable, and the caller still dismisses it so the channel is freed.
function asDialogOpening(params: unknown): Omit<DialogEventFields, "disposition"> | null {
  if (typeof params !== "object" || params === null) return null;
  const p = params as { type?: unknown; message?: unknown; url?: unknown; defaultPrompt?: unknown };
  const parsed = DialogTypeSchema.safeParse(p.type);
  if (!parsed.success) return null;
  return {
    dialogType: parsed.data,
    message: typeof p.message === "string" ? p.message : "",
    url: typeof p.url === "string" ? p.url : "",
    defaultPrompt:
      typeof p.defaultPrompt === "string" && p.defaultPrompt.length > 0
        ? p.defaultPrompt
        : undefined,
  };
}

export function classifyCdpEvent(
  method: string,
  params: unknown,
  ctx: { currentUrl: string; mainFrameId: string; isRootSession?: boolean },
): CdpDecision {
  switch (method) {
    case "Page.frameNavigated": {
      const evt = asFrameNavigated(params);
      if (evt === null) return {};
      if (evt.frame.parentId !== undefined || ctx.isRootSession === false) {
        return { bumpGeneration: true };
      }
      const url = `${evt.frame.url}${evt.frame.urlFragment ?? ""}`;
      return {
        newMainFrameId: evt.frame.id,
        newUrl: url,
        bumpGeneration: true,
        loadStarted: true,
        pageEvent: { kind: "navigated", url },
      };
    }
    case "Page.navigatedWithinDocument": {
      const evt = asNavigatedWithinDocument(params);
      if (evt === null) return {};
      if (evt.frameId !== ctx.mainFrameId || ctx.isRootSession === false) {
        return { bumpGeneration: true };
      }
      return {
        newUrl: evt.url,
        bumpGeneration: true,
        pageEvent: { kind: "navigated", url: evt.url },
      };
    }
    case "Page.loadEventFired":
      // The load event carries no URL; use the generation-tracked current URL.
      return ctx.isRootSession === false
        ? {}
        : { pageEvent: { kind: "load", url: ctx.currentUrl } };
    case "Page.frameAttached":
    case "Page.frameDetached":
      return { bumpGeneration: true };
    case "Accessibility.loadComplete":
    case "DOM.documentUpdated":
    case "DOM.attributeModified":
    case "DOM.attributeRemoved":
    case "DOM.characterDataModified":
    case "DOM.childNodeInserted":
    case "DOM.childNodeRemoved":
    case "DOM.shadowRootPushed":
    case "DOM.shadowRootPopped":
    case "DOM.pseudoElementAdded":
    case "DOM.pseudoElementRemoved":
      return { bumpGeneration: true, preserveDeltaBaseline: true };
    case "Page.javascriptDialogOpening": {
      const opening = asDialogOpening(params);
      // Unclassifiable dialog (not expected - DialogType is a closed CDP enum):
      // still dismiss it so it cannot wedge the CDP channel, but emit no event.
      if (opening === null) return { dialog: { accept: false } };
      const disposition = dialogDisposition(opening.dialogType);
      return {
        dialog: { accept: disposition === "accept", event: { ...opening, disposition } },
      };
    }
    default:
      return {};
  }
}
