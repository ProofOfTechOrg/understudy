import {
  PROTOCOL_CAPABILITIES,
  PROTOCOL_VERSION,
  WS_CLOSE_SESSION_TERMINAL,
  isWriteCommand,
  safeParseCommand,
  safeParseSessionServerFrame,
} from "@understudy/protocol";
import type { Command, Event, SessionServerFrame } from "@understudy/protocol";
import type { Browser } from "wxt/browser";
import { CommandIngress, type StartedCommand } from "../core/command-ingress";
import { WriteDedupe } from "../core/dedupe";
import {
  DialogOutbox,
  handleDialogWithOutbox,
} from "../core/dialog-outbox";
import { resolveAttendedTransition } from "../core/attended-switch";
import { sendIfPeerCurrent } from "../core/peer-binding";
import { routeCommand } from "../core/router";
import { RetryableStartupGate } from "../core/startup-gate";
import {
  DEFAULT_SERVICE_ORIGIN,
  PairingError,
  redeemPairingCode,
} from "../core/pairing-client";
import { ReconnectingWs } from "../core/ws-client";
import { ProfileClient } from "../core/profile-client";
import { WriteJournal } from "../core/write-journal";
import { CdpSession } from "../driver/cdp";
import { classifyCdpEvent } from "../driver/cdp-events";
import { errorMessage } from "../events";
import type {
  AttachedTab,
  LogEntry,
  LogLevel,
  LogMsg,
  PanelMsg,
  StateMsg,
  WsStatus,
} from "../messaging";
import { controlledTabInfo } from "../tabs";

// Attended URLs can contain a legacy extension token. Keep them in
// storage.session so they survive SW eviction but clear on browser restart.
const WS_URL_KEY = "wsUrl";
const WS_ISOLATION_BLOCK_KEY = "understudy:wsIsolationBlocked";
// Persisted across SW eviction so a wake can re-discover the driven tab.
const ATTACHED_TAB_KEY = "understudy:attachedTabId";
const BACKSTOP_ALARM = "ws-backstop";
const LOG_CAP = 50;

// ── Module-scope singletons — rebuilt on every SW wake ───────────────────────
// WXT re-runs main() when the service worker is revived, so these are re-created
// from scratch each wake; durable state lives in browser.storage.{local,session}.
let ws: ReconnectingWs | null = null;
// Input acceptance is retired independently from the socket itself. A URL
// switch stops admitting messages immediately, but keeps the old peer alive
// until every command already admitted through CommandIngress has replied.
let acceptingPeer: ReconnectingWs | null = null;
let wsConnecting = false;
// Tracked from ReconnectingWs's onConnecting/onOpen/onClose callbacks.
let wsStatus: WsStatus = "idle";
let currentWsUrl: string | null = null;
// Storage is read at most once per SW life to hydrate currentWsUrl on cold start;
// setWsUrl marks it hydrated immediately since it already holds the authoritative
// value, and bumps the epoch so a slower in-flight cold-start read can never land
// after it and clobber a newer in-memory URL with a stale (or unwritten) disk copy.
let wsUrlHydrated = false;
let wsUrlEpoch = 0;
let wsSwitching = false;
let wsIsolationFailed = false;
let wsSwitchRequest = 0;
let wsSwitchTail: Promise<unknown> = Promise.resolve();

let session: CdpSession | null = null;
let attachedTitle: string | undefined;
// Progress of the most recent pairing attempt, surfaced in StateMsg.pairing.
let pairingState: StateMsg["pairing"];
let hostingStopRequested = false;
let hostingStopRequest = 0;

interface AttendedRuntime {
  dedupe: WriteDedupe;
  journal: WriteJournal;
  dialogs: DialogOutbox;
  commandIngress: CommandIngress;
}

// The null store branch lets bundling eliminate attended constructors and their
// authority. Internal call sites must unwrap the runtime explicitly.
const attendedRuntime: AttendedRuntime | null = __UNDERSTUDY_STORE__
  ? null
  : {
      dedupe: new WriteDedupe(browser.storage.session),
      journal: new WriteJournal(
        browser.storage.session,
        "understudy:attendedJournal",
      ),
      dialogs: new DialogOutbox(
        browser.storage.session,
        "understudy:attendedDialogs",
      ),
      commandIngress: new CommandIngress(),
    };
let attendedWritesBlocked = false;
let attendedTerminal = false;
const profileClient = new ProfileClient(
  () => broadcastState(),
  __UNDERSTUDY_STORE__ ? DEFAULT_SERVICE_ORIGIN : undefined,
);

const logBuffer: LogEntry[] = [];
const ports = new Set<Browser.runtime.Port>();
const storeRuntimeGate = new RetryableStartupGate(startStoreRuntime);

function internalRuntime(): AttendedRuntime {
  if (attendedRuntime === null) {
    throw new Error("attended runtime is unavailable in the store build");
  }
  return attendedRuntime;
}

export default defineBackground({
  type: "module",
  main() {
    // Register synchronously (before any await) so the listeners are in place
    // the instant the SW is revived and survive across restarts.
    browser.alarms.onAlarm.addListener(onAlarm);
    browser.debugger.onEvent.addListener(onCdpEvent);
    browser.debugger.onDetach.addListener(onDetach);
    browser.tabs.onCreated.addListener(onTabCreated);
    browser.runtime.onConnect.addListener(onConnect);
    browser.sidePanel
      .setPanelBehavior({ openPanelOnActionClick: true })
      .catch((cause: unknown) => {
        log(`side-panel action setup failed: ${errorMessage(cause)}`, "warn");
      });
    browser.alarms.create(BACKSTOP_ALARM, { periodInMinutes: 0.5 }).catch((cause: unknown) => {
      log(`alarm create failed: ${errorMessage(cause)}`, "warn");
    });

    // Kick off the async wake tasks without awaiting (main() must stay non-async).
    if (__UNDERSTUDY_STORE__) {
      fireAndForget("store startup", () => storeRuntimeGate.wait());
    } else {
      fireAndForget("ensureConnection", ensureConnection);
      fireAndForget("reconcileAttachment", reconcileAttachment);
      fireAndForget("profileClient", () => profileClient.start());
    }
  },
});

async function startStoreRuntime(): Promise<void> {
  const stored = await browser.storage.session.get(ATTACHED_TAB_KEY);
  const tabId = stored[ATTACHED_TAB_KEY];
  if (typeof tabId === "number") {
    await browser.debugger.detach({ tabId }).catch(() => {});
  }
  await Promise.all([
    browser.storage.session.remove([
      WS_URL_KEY,
      WS_ISOLATION_BLOCK_KEY,
      ATTACHED_TAB_KEY,
      "understudy:completedWrites",
      "understudy:attendedJournal",
      "understudy:attendedDialogs",
      ...(typeof tabId === "number"
        ? [`understudy:cdp:gen:${tabId}`]
        : []),
    ]),
    browser.storage.local.remove(WS_URL_KEY),
  ]);
  await profileClient.start();
}

// ── WebSocket lifecycle ──────────────────────────────────────────────────────

async function readWsUrl(): Promise<string | null> {
  try {
    const stored = await browser.storage.session.get([
      WS_URL_KEY,
      WS_ISOLATION_BLOCK_KEY,
    ]);
    if (stored[WS_ISOLATION_BLOCK_KEY] === true) {
      wsIsolationFailed = true;
      log("attended session remains blocked after an incomplete endpoint switch", "warn");
      return null;
    }
    const value = stored[WS_URL_KEY];
    if (typeof value === "string" && value.length > 0) return value;
    const legacy = await browser.storage.local.get(WS_URL_KEY);
    const legacyValue = legacy[WS_URL_KEY];
    await browser.storage.local.remove(WS_URL_KEY);
    if (typeof legacyValue === "string" && legacyValue.length > 0) {
      await browser.storage.session.set({ [WS_URL_KEY]: legacyValue });
      return legacyValue;
    }
    return null;
  } catch (cause) {
    log(`read wsUrl failed; attended session remains idle: ${errorMessage(cause)}`, "warn");
    return null;
  }
}

async function ensureConnection(): Promise<void> {
  if (ws !== null || wsConnecting || wsSwitching || wsIsolationFailed) return;
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
    const url = currentWsUrl;
    if (url === null || ws !== null || wsSwitching) return;
    connectWs(url);
  } finally {
    wsConnecting = false;
  }
}

function connectWs(url: string): void {
  let peer!: ReconnectingWs;
  peer = new ReconnectingWs(() => url, {
    onCommand: (raw) => onCommand(raw, peer),
    onOpen: () => onOpen(peer),
    onClose: (event) => onClose(peer, event),
    onConnecting,
  });
  ws = peer;
  acceptingPeer = peer;
}

// ReconnectingWs starts its own pong heartbeat on open, so we only (re)send hello.
function onOpen(peer: ReconnectingWs): void {
  if (peer !== ws || wsSwitching || attendedTerminal) {
    peer.stop();
    return;
  }
  wsStatus = "open";
  log("ws connected");
  fireAndForget("hello", () => sendHello(peer));
  broadcastState();
}

function onConnecting(): void {
  wsStatus = "connecting";
  broadcastState();
}

function onClose(peer: ReconnectingWs, event: CloseEvent): void {
  if (peer !== ws) return;
  wsStatus = "closed";
  if (event.code === WS_CLOSE_SESSION_TERMINAL) {
    attendedTerminal = true;
    if (acceptingPeer === peer) acceptingPeer = null;
    fireAndForget("terminal session detach", detach);
  }
  broadcastState();
}

// A fresh hello on every (re)connect is the resync signal: any commands in flight
// when the SW was evicted are abandoned, and the peer tolerates repeated hellos.
async function sendHello(peer: ReconnectingWs): Promise<void> {
  const active = session;
  if (active === null) {
    sendIfPeerCurrent(peer, acceptingPeer, (current) => {
      current.send({
        type: "hello",
        browser: navigator.userAgent,
        extVersion: browser.runtime.getManifest().version,
        tabs: [],
      });
    });
    return;
  }
  const tab = await controlledTabInfo(active.tabId, active.currentUrl);
  sendIfPeerCurrent(peer, acceptingPeer, (current) => {
    current.send({
      type: "hello",
      protocolVersion: PROTOCOL_VERSION,
      capabilities: [...PROTOCOL_CAPABILITIES],
      browser: navigator.userAgent,
      extVersion: browser.runtime.getManifest().version,
      tabs: [
        {
          tabId: active.tabId,
          url: tab.url,
          title: tab.title,
          active: tab.active,
        },
      ],
    });
  });
  await replayAttendedState(peer);
}

function onCommand(raw: unknown, peer: ReconnectingWs): void {
  if (attendedTerminal || peer !== acceptingPeer) return;
  const v2 = safeParseSessionServerFrame(raw);
  if (v2.success) {
    fireAndForget("v2 command ingress", () =>
      internalRuntime().commandIngress.enqueue(() =>
        startV2Frame(v2.data, peer),
      ),
    );
    return;
  }
  fireAndForget("command ingress", () =>
    internalRuntime().commandIngress.enqueue(() => startCommand(raw, peer)),
  );
}

async function startV2Frame(
  frame: SessionServerFrame,
  peer: ReconnectingWs,
): Promise<StartedCommand | undefined> {
  if (attendedTerminal || peer !== acceptingPeer) return undefined;
  switch (frame.type) {
    case "command": {
      if (deadline(frame.deadlineAt) <= Date.now()) return undefined;
      const active = session;
      const completion = executeAttendedCommand(
        frame.command,
        frame.attemptId,
        frame.deadlineAt,
        active,
        peer,
      );
      fireAndForget("v2 read execution", async () => completion);
      return { completion };
    }
    case "write_prepare":
      if (
        attendedWritesBlocked ||
        deadline(frame.deadlineAt) <= Date.now() ||
        frame.leaseId !== undefined ||
        frame.leaseEpoch !== undefined ||
        frame.browserEpoch !== undefined
      ) {
        return undefined;
      }
      await internalRuntime().journal.prepare({
        attemptId: frame.attemptId,
        commandId: frame.commandId,
        requestFingerprint: frame.requestFingerprint,
      });
      sendIfPeerCurrent(peer, acceptingPeer, (current) => {
        current.send({
          type: "write_ready",
          attemptId: frame.attemptId,
          commandId: frame.commandId,
          deadlineAt: frame.deadlineAt,
          requestFingerprint: frame.requestFingerprint,
        });
      });
      return undefined;
    case "write_grant": {
      if (
        attendedWritesBlocked ||
        !isWriteCommand(frame.command) ||
        deadline(frame.deadlineAt) <= Date.now() ||
        frame.leaseId !== undefined ||
        frame.leaseEpoch !== undefined ||
        frame.browserEpoch !== undefined
      ) {
        return undefined;
      }
      const record = await internalRuntime().journal.get(frame.attemptId);
      if (
        record?.state !== "prepared" ||
        record.commandId !== frame.command.commandId
      ) {
        return undefined;
      }
      await internalRuntime().journal.markStarted(frame.attemptId);
      const active = session;
      const completion = executeAttendedWrite(
        frame.command,
        frame.attemptId,
        frame.deadlineAt,
        active,
        peer,
      );
      fireAndForget("v2 write execution", async () => completion);
      return { completion };
    }
    case "attempt_cancel":
      await internalRuntime().journal.cancelPrepared(frame.attemptId);
      return undefined;
    case "result_ack":
      await internalRuntime().journal.acknowledge(frame.attemptId);
      return undefined;
    case "dialog_ack":
      await internalRuntime().dialogs.acknowledge(frame.dialogId);
      return undefined;
    case "writes_blocked":
      attendedWritesBlocked = true;
      return undefined;
    case "close_session":
      attendedTerminal = true;
      if (acceptingPeer === peer) acceptingPeer = null;
      peer.stop();
      await detach();
      return undefined;
  }
}

async function executeAttendedCommand(
  command: Command,
  attemptId: string,
  deadlineAt: string,
  active: CdpSession | null,
  peer: ReconnectingWs,
): Promise<void> {
  const event = await executeAttendedWithDeadline(command, deadlineAt, active);
  if (event === null || session !== active) return;
  sendAttendedResult(peer, attemptId, command.commandId, event);
}

async function executeAttendedWrite(
  command: Command,
  attemptId: string,
  deadlineAt: string,
  active: CdpSession | null,
  peer: ReconnectingWs,
): Promise<void> {
  const event = await executeAttendedWithDeadline(command, deadlineAt, active);
  if (event === null || session !== active) {
    await internalRuntime().journal.markUnknown(attemptId);
    attendedWritesBlocked = true;
    return;
  }
  await internalRuntime().journal.markCompleted(attemptId, event);
  sendAttendedResult(peer, attemptId, command.commandId, event);
}

async function executeAttendedWithDeadline(
  command: Command,
  deadlineAt: string,
  active: CdpSession | null,
): Promise<Event | null> {
  const remaining = deadline(deadlineAt) - Date.now();
  if (remaining <= 0) return null;
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), remaining);
  });
  const event = await Promise.race([routeCommand(command, active), timeout]);
  clearTimeout(timer!);
  if (event !== null) return event;
  if (session === active && active !== null) {
    await active.detach().catch(() => {});
    await clearAttachment();
  }
  return null;
}

function sendAttendedResult(
  peer: ReconnectingWs,
  attemptId: string,
  commandId: string,
  event: Event,
): void {
  sendIfPeerCurrent(peer, acceptingPeer, (current) => {
    current.send({
      type: "command_result",
      attemptId,
      commandId,
      event,
    });
  });
}

async function replayAttendedState(peer: ReconnectingWs): Promise<void> {
  for (const record of await internalRuntime().journal.recover()) {
    if (record.state === "prepared") {
      sendIfPeerCurrent(peer, acceptingPeer, (current) => {
        current.send({
          type: "write_ready",
          attemptId: record.attemptId,
          commandId: record.commandId,
          deadlineAt: new Date(Date.now() + 1_000).toISOString(),
          requestFingerprint: record.requestFingerprint,
        });
      });
    } else if (record.state === "started") {
      await internalRuntime().journal.markUnknown(record.attemptId);
      attendedWritesBlocked = true;
    } else if (
      record.state === "completed_unacked" &&
      record.event !== undefined
    ) {
      sendAttendedResult(
        peer,
        record.attemptId,
        record.commandId,
        record.event,
      );
    }
  }
  for (const record of await internalRuntime().dialogs.pending()) {
    sendIfPeerCurrent(peer, acceptingPeer, (current) => {
      current.send({ type: "dialog", ...record });
    });
  }
}

function deadline(value: string): number {
  return Date.parse(value);
}

async function startCommand(
  raw: unknown,
  peer: ReconnectingWs,
): Promise<StartedCommand | undefined> {
  if (attendedTerminal || peer !== acceptingPeer) return undefined;
  const parsed = safeParseCommand(raw);
  if (!parsed.success) {
    log(`invalid command dropped: ${parsed.error.message}`, "warn");
    const commandId = extractCommandId(raw);
    if (commandId !== null) {
      peer.send({ type: "action_result", commandId, ok: false, error: "invalid command" });
    }
    return undefined;
  }

  // Idempotent-retry gate for WRITE commands (reads always execute). A retry
  // under the same commandId either replays a recorded result, or - if the
  // original is still executing (the service timed out and the consumer
  // retried) - is dropped so the write runs at most once; the running
  // execution's response resolves the service's parked promise.
  const decision = await internalRuntime().dedupe.claim(parsed.data);
  if (decision.kind === "replay") {
    log(`replayed recorded result for duplicate write ${parsed.data.commandId}`);
    peer.send(decision.event);
    return undefined;
  }
  if (decision.kind === "drop") {
    log(`dropped duplicate in-flight write ${parsed.data.commandId}; the original execution will answer`);
    return undefined;
  }

  const activeSession = session;
  const completion = (async () => {
    try {
      const ev = await routeCommand(parsed.data, activeSession);
      // Record before sending: once the write executed, a crash between the two
      // must leave the record (a replayable result), not a re-executable gap.
      await internalRuntime().dedupe.remember(parsed.data, ev);
      peer.send(ev);
    } finally {
      // No-op once remember() cleared the mark; guarantees a thrown execution
      // still frees its in-flight slot so a later retry can re-run it.
      internalRuntime().dedupe.release(parsed.data);
    }
  })();
  fireAndForget("command execution", async () => completion);
  return { completion };
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
  await profileClient.sessions.onCdpEvent(source, method, params);
  if (__UNDERSTUDY_STORE__) return;
  const active = session;
  if (active === null || source.tabId !== active.tabId) return;
  const eventPeer = acceptingPeer;
  try {
    const decision = classifyCdpEvent(method, params, {
      currentUrl: active.currentUrl,
      mainFrameId: active.mainFrameId,
    });
    if (decision.newMainFrameId !== undefined) {
      active.mainFrameId = decision.newMainFrameId;
    }
    if (decision.newUrl !== undefined) {
      active.currentUrl = decision.newUrl;
    }
    if (decision.loadStarted === true) {
      active.markLoadStarted();
    }
    if (decision.bumpGeneration === true) {
      await active.bumpGeneration();
    }
    if (session !== active) return;
    if (decision.pageEvent?.kind === "load") {
      active.notifyLoadEventFired();
    }
    const pageEvent = decision.pageEvent;
    if (pageEvent !== undefined) {
      sendIfPeerCurrent(eventPeer, acceptingPeer, (current) => {
        current.send({
          type: "page_event",
          kind: pageEvent.kind,
          tabId: active.tabId,
          url: pageEvent.url,
        });
      });
    }
    if (decision.dialog !== undefined) {
      const accept = decision.dialog.accept;
      const payload = decision.dialog.event;
      const record = {
        dialogId: crypto.randomUUID(),
        occurredAt: new Date().toISOString(),
        tabId: active.tabId,
        dialogType: payload?.dialogType ?? "alert",
        message: payload?.message ?? "",
        url: payload?.url ?? active.currentUrl,
        ...(payload?.defaultPrompt === undefined
          ? {}
          : { defaultPrompt: payload.defaultPrompt }),
        disposition:
          payload?.disposition ??
          (accept ? "accept" : "dismiss"),
      } as const;
      await handleDialogWithOutbox(
        internalRuntime().dialogs,
        record,
        () => active.send("Page.handleJavaScriptDialog", { accept }),
        (delivery) => {
          if (session === active) {
            sendIfPeerCurrent(eventPeer, acceptingPeer, (current) => {
              current.send(
                delivery === "ok"
                  ? { type: "dialog", ...record }
                  : { type: "health", dialogDelivery: "overflow" },
              );
            });
          }
        },
      );
      log(
        `handled ${decision.dialog.event?.dialogType ?? "unknown"} dialog: ${
          accept ? "accept" : "dismiss"
        }`,
      );
    }
  } catch (cause) {
    log(`cdp event (${method}) failed: ${errorMessage(cause)}`, "error");
  }
}

async function onDetach(source: { tabId?: number }, reason: string): Promise<void> {
  await profileClient.sessions.onDebuggerDetach(source);
  if (__UNDERSTUDY_STORE__) return;
  const active = session;
  if (active === null || source.tabId !== active.tabId) return;
  await fenceStartedAttendedWrites();
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
    session = next;
    attachedTitle = tab.title;
    await persistAttachedTabId(tabId);
    log(`attached to tab ${tabId}`);
    if (acceptingPeer !== null) await sendHello(acceptingPeer);
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

async function fenceStartedAttendedWrites(): Promise<void> {
  for (const record of await internalRuntime().journal.recover()) {
    if (record.state !== "started") continue;
    await internalRuntime().journal.markUnknown(record.attemptId);
    attendedWritesBlocked = true;
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
    const next = await CdpSession.create(tabId);
    await next.reconcile();
    const tab = await controlledTabInfo(tabId, next.currentUrl);
    session = next;
    attachedTitle = tab.title;
    log(`reconciled attachment to tab ${tabId}`);
    if (acceptingPeer !== null) await sendHello(acceptingPeer);
  } catch (cause) {
    await clearAttachment();
    log(
      `attachment to tab ${tabId} could not be reconciled; cleared: ${errorMessage(cause)}`,
      "warn",
    );
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
  const request = ++wsSwitchRequest;
  wsSwitching = true;
  wsUrlHydrated = true;
  wsUrlEpoch += 1;
  wsStatus = "connecting";
  acceptingPeer = null;
  broadcastState();

  let isolatedPeer: ReconnectingWs | null = null;
  const operation = wsSwitchTail.then(async () => {
    const transition = resolveAttendedTransition(
      url,
      currentWsUrl,
      wsIsolationFailed,
      acceptingPeer,
      ws,
    );
    isolatedPeer = transition.peer;
    await browser.storage.session.set({
      [WS_ISOLATION_BLOCK_KEY]: true,
    });
    await internalRuntime().commandIngress.barrier(async () => {
      isolatedPeer?.stop();
      if (ws === isolatedPeer) ws = null;
      if (!transition.sessionChanged) return;
      // The session id lives in the URL. Wait for every command accepted from
      // the old peer before clearing replay state and rotating the ref scope;
      // this prevents an old snapshot from repopulating refs after invalidation.
      await internalRuntime().dedupe.clear();
      await internalRuntime().journal.clear();
      await internalRuntime().dialogs.clear();
      attendedWritesBlocked = false;
      attendedTerminal = false;
      const active = session;
      if (active !== null) {
        try {
          await active.invalidateRefsForSessionChange();
        } catch (cause) {
          log(`persist ref invalidation failed: ${errorMessage(cause)}`, "warn");
        }
      }
    });
    currentWsUrl = url;
    await browser.storage.session.set({
      [WS_URL_KEY]: url,
      [WS_ISOLATION_BLOCK_KEY]: false,
    });
    log("attended session endpoint updated; reconnecting");
  });
  const change = operation.catch(async (cause: unknown) => {
    wsIsolationFailed = true;
    currentWsUrl = null;
    isolatedPeer?.stop();
    if (ws === isolatedPeer) ws = null;
    const safeguards = await Promise.allSettled([
      browser.storage.session.set({
        [WS_ISOLATION_BLOCK_KEY]: true,
      }),
      browser.storage.session.remove(WS_URL_KEY),
    ]);
    for (const safeguard of safeguards) {
      if (safeguard.status === "rejected") {
        log(
          `persist attended isolation failure failed: ${errorMessage(safeguard.reason)}`,
          "warn",
        );
      }
    }
    throw cause;
  });
  wsSwitchTail = change.then(
    () => undefined,
    () => undefined,
  );
  let switched = false;
  try {
    await change;
    switched = true;
  } finally {
    if (request === wsSwitchRequest) {
      wsSwitching = false;
      if (switched) {
        wsIsolationFailed = false;
        connectWs(url);
      } else {
        wsStatus = currentWsUrl === null ? "idle" : "closed";
        broadcastState();
      }
    }
  }
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
  if (msg.type === "getState") {
    pushState(port);
    return;
  }
  if (msg.type === "stopAll") {
    const request = ++hostingStopRequest;
    hostingStopRequested = true;
    pairingState = undefined;
    const stopping = __UNDERSTUDY_STORE__
      ? storeRuntimeGate.wait().then(() => profileClient.stopAll())
      : profileClient.stopAll();
    broadcastState();
    fireAndForget("stopAll", async () => {
      try {
        await stopping;
      } finally {
        if (request === hostingStopRequest) {
          hostingStopRequested = false;
          broadcastState();
        }
      }
    });
    return;
  }
  if (msg.type === "pair") {
    fireAndForget("pair", () => pairDevice(msg.code));
    return;
  }
  if (__UNDERSTUDY_STORE__) return;

  switch (msg.type) {
    case "attach":
      fireAndForget("attach", attach);
      break;
    case "detach":
      fireAndForget("detach", () =>
        internalRuntime().commandIngress.barrier(detach),
      );
      break;
    case "setWsUrl":
      fireAndForget("setWsUrl", () => setWsUrl(msg.url));
      break;
    case "configureProfile":
      hostingStopRequest += 1;
      hostingStopRequested = false;
      fireAndForget("configureProfile", () =>
        profileClient.configure({
          serviceOrigin: msg.serviceOrigin,
          unattendedEnabled: msg.enabled,
          deviceId: msg.deviceId,
          deviceCredential: msg.deviceCredential,
          originPolicy: msg.originPolicy,
        }),
      );
      break;
  }
}

// Redeems a dashboard pairing code and feeds the minted config through the
// SAME profileClient.configure path the manual form uses — a fresh
// deviceId+credential per redemption means the new profileKey can never
// match a stored ControlBlock, so pairing again is the universal recovery.
async function pairDevice(code: string): Promise<void> {
  hostingStopRequest += 1;
  hostingStopRequested = false;
  pairingState = { phase: "pairing" };
  broadcastState();
  try {
    if (__UNDERSTUDY_STORE__) await storeRuntimeGate.wait();
    const result = await redeemPairingCode(code);
    await profileClient.configure({
      serviceOrigin: result.serviceOrigin,
      unattendedEnabled: result.unattendedEnabled,
      deviceId: result.deviceId,
      deviceCredential: result.deviceCredential,
      originPolicy: result.originPolicy,
    });
    pairingState = { phase: "success" };
    log("paired with account; unattended hosting enabled");
  } catch (cause) {
    pairingState = {
      phase: "error",
      message:
        cause instanceof PairingError
          ? cause.message
          : "Pairing failed. Generate a fresh code and try again.",
    };
    log(`pairing failed: ${errorMessage(cause)}`, "error");
  }
  broadcastState();
}

// ── State + logging ──────────────────────────────────────────────────────────

function buildAttached(): AttachedTab | null {
  if (__UNDERSTUDY_STORE__) return null;
  if (session === null) return null;
  const url = session.currentUrl.length > 0 ? session.currentUrl : undefined;
  return { tabId: session.tabId, title: attachedTitle, url };
}

function buildState(): StateMsg {
  const blockedReason = profileClient.blockedReason();
  const profileConfig = profileClient.publicConfig();
  return {
    type: "state",
    wsStatus,
    wsUrl: currentWsUrl,
    attached: buildAttached(),
    profileStatus: profileClient.currentStatus(),
    controlledTabs: profileClient.sessions.assignments().length,
    profileConfig:
      hostingStopRequested && profileConfig !== null
        ? { ...profileConfig, unattendedEnabled: false }
        : profileConfig,
    ...(pairingState === undefined ? {} : { pairing: pairingState }),
    ...(blockedReason === null ? {} : { profileStatusReason: blockedReason }),
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
    if (__UNDERSTUDY_STORE__) {
      fireAndForget("ensureStoreRuntime", async () => {
        await storeRuntimeGate.wait();
        await profileClient.ensureConnection();
      });
    } else {
      fireAndForget("ensureConnection", ensureConnection);
      fireAndForget("ensureProfileConnection", () =>
        profileClient.ensureConnection(),
      );
    }
  }
}

function onTabCreated(tab: Browser.tabs.Tab): void {
  fireAndForget("popup containment", () => profileClient.sessions.closeRelatedPopup(tab));
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
