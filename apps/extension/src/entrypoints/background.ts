import { safeParseCommand } from "@understudy/protocol";
import type { Browser } from "wxt/browser";
import { ReconnectingWs } from "../core/ws-client";
import { routeCommand } from "../core/router";
import { CdpSession } from "../driver/cdp";
import { classifyCdpEvent } from "../driver/cdp-events";
import { errorMessage } from "../events";
import { queryTabInfos } from "../tabs";
import type {
  AttachedTab,
  LogEntry,
  LogLevel,
  LogMsg,
  PanelMsg,
  StateMsg,
  WsStatus,
} from "../messaging";

const DEFAULT_WS_URL = "ws://localhost:8787";
// WXT storage item id 'local:wsUrl' maps to browser.storage.local key 'wsUrl'.
const WS_URL_KEY = "wsUrl";
// Persisted across SW eviction so a wake can re-discover the driven tab.
const ATTACHED_TAB_KEY = "understudy:attachedTabId";
const BACKSTOP_ALARM = "ws-backstop";
const LOG_CAP = 50;

// ── Module-scope singletons — rebuilt on every SW wake ───────────────────────
// WXT re-runs main() when the service worker is revived, so these are re-created
// from scratch each wake; durable state lives in browser.storage.{local,session}.
let ws: ReconnectingWs | null = null;
let wsConnecting = false;
// Tracked from ReconnectingWs's onConnecting/onOpen/onClose callbacks.
let wsStatus: WsStatus = "connecting";
let currentWsUrl = DEFAULT_WS_URL;
// Storage is read at most once per SW life to hydrate currentWsUrl on cold start;
// setWsUrl marks it hydrated immediately since it already holds the authoritative
// value, and bumps the epoch so a slower in-flight cold-start read can never land
// after it and clobber a newer in-memory URL with a stale (or unwritten) disk copy.
let wsUrlHydrated = false;
let wsUrlEpoch = 0;

let session: CdpSession | null = null;
let attachedTitle: string | undefined;

const logBuffer: LogEntry[] = [];
const ports = new Set<Browser.runtime.Port>();

export default defineBackground({
  type: "module",
  main() {
    // Register synchronously (before any await) so the listeners are in place
    // the instant the SW is revived and survive across restarts.
    browser.alarms.onAlarm.addListener(onAlarm);
    browser.debugger.onEvent.addListener(onCdpEvent);
    browser.debugger.onDetach.addListener(onDetach);
    browser.runtime.onConnect.addListener(onConnect);
    browser.alarms.create(BACKSTOP_ALARM, { periodInMinutes: 0.5 }).catch((cause: unknown) => {
      log(`alarm create failed: ${errorMessage(cause)}`, "warn");
    });

    // Kick off the async wake tasks without awaiting (main() must stay non-async).
    fireAndForget("ensureConnection", ensureConnection);
    fireAndForget("reconcileAttachment", reconcileAttachment);
  },
});

// ── WebSocket lifecycle ──────────────────────────────────────────────────────

// Synchronous accessor for ReconnectingWs (which reads the URL when it opens a
// socket); the async storage read hydrates `currentWsUrl` before the WS is built.
function getUrl(): string {
  return currentWsUrl;
}

async function readWsUrl(): Promise<string> {
  try {
    const stored = await browser.storage.local.get(WS_URL_KEY);
    const value = stored[WS_URL_KEY];
    return typeof value === "string" && value.length > 0 ? value : DEFAULT_WS_URL;
  } catch (cause) {
    log(`read wsUrl failed, using default: ${errorMessage(cause)}`, "warn");
    return DEFAULT_WS_URL;
  }
}

async function ensureConnection(): Promise<void> {
  if (ws !== null || wsConnecting) return;
  wsConnecting = true;
  try {
    if (!wsUrlHydrated) {
      const epoch = wsUrlEpoch;
      const url = await readWsUrl();
      // Only apply this read if setWsUrl did not run (and invalidate it) while it
      // was in flight; setWsUrl's own value must always win over a cold-start read.
      if (epoch === wsUrlEpoch) {
        currentWsUrl = url;
        wsUrlHydrated = true;
      }
    }
    if (ws === null) {
      connectWs();
    }
  } finally {
    wsConnecting = false;
  }
}

function connectWs(): void {
  ws = new ReconnectingWs(getUrl, { onCommand, onOpen, onClose, onConnecting });
}

// ReconnectingWs starts its own pong heartbeat on open, so we only (re)send hello.
function onOpen(): void {
  wsStatus = "open";
  log("ws connected");
  fireAndForget("hello", sendHello);
  broadcastState();
}

function onConnecting(): void {
  wsStatus = "connecting";
  broadcastState();
}

function onClose(): void {
  wsStatus = "closed";
  broadcastState();
}

// A fresh hello on every (re)connect is the resync signal: any commands in flight
// when the SW was evicted are abandoned, and the peer tolerates repeated hellos.
async function sendHello(): Promise<void> {
  const tabs = await queryTabInfos();
  ws?.send({
    type: "hello",
    browser: navigator.userAgent,
    extVersion: browser.runtime.getManifest().version,
    tabs,
  });
}

function onCommand(raw: unknown): void {
  fireAndForget("command", () => handleCommand(raw));
}

async function handleCommand(raw: unknown): Promise<void> {
  const parsed = safeParseCommand(raw);
  if (!parsed.success) {
    log(`invalid command dropped: ${parsed.error.message}`, "warn");
    const commandId = extractCommandId(raw);
    if (commandId !== null) {
      ws?.send({ type: "action_result", commandId, ok: false, error: "invalid command" });
    }
    return;
  }
  const ev = await routeCommand(parsed.data, session);
  ws?.send(ev);
}

function extractCommandId(raw: unknown): string | null {
  if (typeof raw === "object" && raw !== null) {
    const id = (raw as { commandId?: unknown }).commandId;
    if (typeof id === "string") return id;
  }
  return null;
}

// ── CDP events ───────────────────────────────────────────────────────────────

// Delegate to the pure classifier and apply only the chrome-coupled effects here.
// Generation is bumped exclusively via session.bumpGeneration() (the persisting,
// monotonic path) — never by mutating session.generation directly.
async function onCdpEvent(
  source: { tabId?: number },
  method: string,
  params: unknown,
): Promise<void> {
  const active = session;
  if (active === null || source.tabId !== active.tabId) return;
  try {
    const decision = classifyCdpEvent(method, params, { currentUrl: active.currentUrl });
    if (decision.newUrl !== undefined) {
      active.currentUrl = decision.newUrl;
    }
    if (decision.pageEvent?.kind === "navigated") {
      active.markLoadStarted();
      await active.bumpGeneration();
    } else if (decision.bumpGeneration === true) {
      await active.bumpGeneration();
    }
    if (decision.pageEvent?.kind === "load") {
      active.notifyLoadEventFired();
    }
    if (decision.pageEvent !== undefined) {
      ws?.send({
        type: "page_event",
        kind: decision.pageEvent.kind,
        tabId: active.tabId,
        url: decision.pageEvent.url,
      });
    }
    if (decision.dismissDialog === true) {
      // Auto-dismiss so a page dialog does not wedge the single CDP channel.
      await active.send("Page.handleJavaScriptDialog", { accept: false });
      log("auto-dismissed page dialog");
    }
  } catch (cause) {
    log(`cdp event (${method}) failed: ${errorMessage(cause)}`, "error");
  }
}

async function onDetach(source: { tabId?: number }, reason: string): Promise<void> {
  const active = session;
  if (active === null || source.tabId !== active.tabId) return;
  await clearAttachment();
  log(`debugger detached from tab ${active.tabId} (${reason})`);
  broadcastState();
}

// ── Attach / detach / wake-time reconcile (DL-007) ───────────────────────────

async function attach(): Promise<void> {
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (tab === undefined || tab.id === undefined) {
      log("attach failed: no active tab", "error");
      return;
    }
    const tabId = tab.id;
    const next = await CdpSession.create(tabId);
    let attachedToDebugger = false;
    try {
      await next.attach();
      attachedToDebugger = true;
      await next.enableDomains();
    } catch (cause) {
      if (isAlreadyAttached(cause)) {
        // Debugger already attached (e.g. survived a prior SW life): reconcile
        // (re-enable domains + bump generation) instead of failing.
        await next.reconcile();
      } else {
        if (attachedToDebugger) {
          // attach() itself succeeded but a later step failed — undo the partial
          // attachment so a real chrome.debugger session isn't left dangling while
          // `session` stays unset.
          await next.detach().catch(() => {});
        }
        throw cause;
      }
    }
    next.currentUrl = tab.url ?? "";
    session = next;
    attachedTitle = tab.title;
    await persistAttachedTabId(tabId);
    log(`attached to tab ${tabId}`);
    broadcastState();
  } catch (cause) {
    log(`attach failed: ${errorMessage(cause)}`, "error");
    broadcastState();
  }
}

async function detach(): Promise<void> {
  const active = session;
  try {
    if (active !== null) await active.detach();
  } catch (cause) {
    log(`detach error (continuing): ${errorMessage(cause)}`, "warn");
  }
  await clearAttachment();
  log("detached");
  broadcastState();
}

// Clears in-memory attachment state, then best-effort clears its storage.session
// persistence. In-memory state is cleared first so it stays correct even if the
// storage write fails; onDetach, detach(), and reconcileAttachment() all share
// this so the three stay consistent.
async function clearAttachment(): Promise<void> {
  session = null;
  attachedTitle = undefined;
  try {
    await browser.storage.session.remove(ATTACHED_TAB_KEY);
  } catch (cause) {
    log(`clear attached tabId failed: ${errorMessage(cause)}`, "warn");
  }
}

// Runs on every wake. Reads the persisted driven-tab id; if the browser is still
// attached to it, rebuilds the session and reconciles WITHOUT re-attaching (which
// would throw 'Already attached'); otherwise clears the stale persisted state.
async function reconcileAttachment(): Promise<void> {
  let tabId: number;
  try {
    const stored = await browser.storage.session.get(ATTACHED_TAB_KEY);
    const value = stored[ATTACHED_TAB_KEY];
    if (typeof value !== "number") return;
    tabId = value;
  } catch (cause) {
    log(`reconcile: read attached tabId failed: ${errorMessage(cause)}`, "warn");
    return;
  }
  try {
    // chrome.debugger.getTargets() (the WebExtensions API) — distinct from the
    // blocked CDP Target.getTargets.
    const targets = await browser.debugger.getTargets();
    const target = targets.find((t) => t.tabId === tabId);
    if (target !== undefined && target.attached) {
      const next = await CdpSession.create(tabId);
      await next.reconcile();
      next.currentUrl = target.url;
      session = next;
      attachedTitle = target.title;
      log(`reconciled attachment to tab ${tabId}`);
    } else {
      await clearAttachment();
      log(`attachment to tab ${tabId} no longer present; cleared`);
    }
  } catch (cause) {
    log(`reconcile failed: ${errorMessage(cause)}`, "error");
  }
  broadcastState();
}

async function persistAttachedTabId(tabId: number): Promise<void> {
  try {
    await browser.storage.session.set({ [ATTACHED_TAB_KEY]: tabId });
  } catch (cause) {
    log(`persist attached tabId failed: ${errorMessage(cause)}`, "warn");
  }
}

async function setWsUrl(url: string): Promise<void> {
  currentWsUrl = url;
  wsUrlHydrated = true;
  wsUrlEpoch += 1;
  try {
    await browser.storage.local.set({ [WS_URL_KEY]: url });
  } catch (cause) {
    log(`persist wsUrl failed: ${errorMessage(cause)}`, "warn");
  }
  // Tear down and rebuild directly against the now-authoritative in-memory URL —
  // routing through ensureConnection would re-read storage, which can be stale
  // (e.g. the write above just failed) and would clobber this value.
  if (ws !== null) {
    ws.stop();
    ws = null;
  }
  log(`ws url set to ${url}; reconnecting`);
  connectWs();
}

// ── Panel Port host ──────────────────────────────────────────────────────────

function onConnect(port: Browser.runtime.Port): void {
  if (port.name !== "panel") return;
  ports.add(port);
  port.onMessage.addListener((msg) => {
    handlePanelMsg(msg as PanelMsg, port);
  });
  port.onDisconnect.addListener(() => {
    ports.delete(port);
  });
  pushState(port);
}

function handlePanelMsg(msg: PanelMsg, port: Browser.runtime.Port): void {
  switch (msg.type) {
    case "getState":
      pushState(port);
      break;
    case "attach":
      fireAndForget("attach", attach);
      break;
    case "detach":
      fireAndForget("detach", detach);
      break;
    case "setWsUrl":
      fireAndForget("setWsUrl", () => setWsUrl(msg.url));
      break;
  }
}

// ── State + logging ──────────────────────────────────────────────────────────

function buildAttached(): AttachedTab | null {
  if (session === null) return null;
  const url = session.currentUrl.length > 0 ? session.currentUrl : undefined;
  return { tabId: session.tabId, title: attachedTitle, url };
}

function buildState(): StateMsg {
  return {
    type: "state",
    wsStatus,
    wsUrl: currentWsUrl,
    attached: buildAttached(),
    logs: [...logBuffer],
  };
}

function pushState(port: Browser.runtime.Port): void {
  postToPort(port, buildState());
}

function broadcastState(): void {
  const state = buildState();
  for (const port of [...ports]) postToPort(port, state);
}

function log(message: string, level?: LogLevel): void {
  const entry: LogEntry = { message, timestamp: Date.now(), level };
  logBuffer.push(entry);
  if (logBuffer.length > LOG_CAP) logBuffer.shift();
  const msg: LogMsg = { type: "log", entry };
  for (const port of [...ports]) postToPort(port, msg);
}

function postToPort(port: Browser.runtime.Port, msg: StateMsg | LogMsg): void {
  try {
    port.postMessage(msg);
  } catch {
    // Port already disconnected — drop it. Deliberately no log() here: it would
    // re-enter this same broadcast loop.
    ports.delete(port);
  }
}

// ── Misc ─────────────────────────────────────────────────────────────────────

function onAlarm(alarm: { name: string }): void {
  if (alarm.name === BACKSTOP_ALARM) {
    // Wake-driven reconnect backstop across SW eviction.
    fireAndForget("ensureConnection", ensureConnection);
  }
}

// Run an async task detached from the caller, funnelling any rejection to the log
// so a background failure can never become an unhandled rejection that kills the SW.
function fireAndForget(label: string, task: () => Promise<void>): void {
  task().catch((cause: unknown) => {
    log(`${label} failed: ${errorMessage(cause)}`, "error");
  });
}

function isAlreadyAttached(cause: unknown): boolean {
  return errorMessage(cause).toLowerCase().includes("already attached");
}
