import {
  PROTOCOL_CAPABILITIES,
  PROTOCOL_VERSION,
  isWriteCommand,
  safeParseSessionServerFrame,
  type Command,
  type Event,
  type SessionServerFrame,
  type TabInfo,
} from "@understudy/protocol";
import { routeCommand } from "./router";
import { ReconnectingWs } from "./ws-client";
import { WriteJournal } from "./write-journal";
import { DialogOutbox } from "./dialog-outbox";
import { CdpSession } from "../driver/cdp";
import { classifyCdpEvent } from "../driver/cdp-events";

export interface RuntimeAssignment {
  sessionId: string;
  leaseId: string;
  leaseEpoch: number;
  browserEpoch: string;
  allowedOrigins: string[];
  tabId: number;
  windowId: number;
}

export type CleanupIntent = "recover" | "release" | "discard";

export interface ManagedAssignment extends RuntimeAssignment {
  cleanupIntent?: CleanupIntent;
}

export interface RuntimeHost {
  serviceOrigin(): string;
  browserEpoch(): string;
  isCurrent(runtime: SessionRuntime): boolean;
  onFenced(runtime: SessionRuntime): Promise<void>;
  onTabChanged(runtime: SessionRuntime): Promise<void>;
}

export class SessionRuntime {
  readonly journal: WriteJournal;
  readonly dialogs: DialogOutbox;
  private peer: ReconnectingWs | null = null;
  private cdp: CdpSession | null = null;
  private accepting: boolean;
  private writesBlocked = false;
  private closing = false;

  constructor(
    readonly assignment: ManagedAssignment,
    private readonly host: RuntimeHost,
  ) {
    this.accepting = assignment.cleanupIntent === undefined;
    this.journal = new WriteJournal(
      browser.storage.session,
      `understudy:journal:${assignment.sessionId}`,
    );
    this.dialogs = new DialogOutbox(
      browser.storage.session,
      `understudy:dialogs:${assignment.sessionId}`,
    );
  }

  get sessionId(): string {
    return this.assignment.sessionId;
  }

  get leaseId(): string {
    return this.assignment.leaseId;
  }

  get tabId(): number {
    return this.assignment.tabId;
  }

  matchesFence(frame: {
    leaseId?: string;
    leaseEpoch?: number;
    browserEpoch?: string;
  }): boolean {
    return (
      frame.leaseId === this.assignment.leaseId &&
      frame.leaseEpoch === this.assignment.leaseEpoch &&
      frame.browserEpoch === this.assignment.browserEpoch
    );
  }

  async attach(): Promise<void> {
    const cdp = await CdpSession.create(this.tabId, this.sessionId);
    await cdp.attach();
    try {
      await cdp.enableDomains();
      await cdp.enableUnattendedContainment(this.assignment.allowedOrigins);
    } catch (error) {
      await cdp.detach().catch(() => {});
      throw error;
    }
    this.cdp = cdp;
  }

  async reconcileSameEpoch(): Promise<void> {
    const cdp = await CdpSession.create(this.tabId, this.sessionId);
    await cdp.reconcile();
    await cdp.enableUnattendedContainment(this.assignment.allowedOrigins);
    this.cdp = cdp;
  }

  connect(ticket: string): void {
    if (
      !this.accepting ||
      this.closing ||
      this.assignment.cleanupIntent !== undefined ||
      this.cdp === null
    ) {
      throw new Error("session runtime is not accepting connections");
    }
    this.peer?.stop();
    const url = new URL(
      `/agents/session/${encodeURIComponent(this.sessionId)}`,
      this.host.serviceOrigin(),
    );
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("ticket", ticket);
    let peer!: ReconnectingWs;
    peer = new ReconnectingWs(
      () => url.toString(),
      {
        onCommand: (raw) => {
          if (peer === this.peer) void this.onServerFrame(raw).catch(() => {});
        },
        onOpen: () => {
          if (peer === this.peer) void this.onOpen().catch(() => {});
        },
        onClose: () => {
          if (peer === this.peer) peer.stop();
        },
      },
    );
    this.peer = peer;
  }

  async close(closeTab: boolean): Promise<boolean> {
    this.closing = true;
    this.accepting = false;
    this.peer?.stop();
    this.peer = null;
    const cdp = this.cdp;
    this.cdp = null;
    await cdp?.detach().catch(() => {});
    if (!closeTab) return true;
    if (
      this.assignment.browserEpoch !== this.host.browserEpoch() ||
      !this.host.isCurrent(this)
    ) {
      this.closing = false;
      return false;
    }
    try {
      await browser.tabs.remove(this.tabId);
      return true;
    } catch {
      try {
        await browser.tabs.get(this.tabId);
        this.closing = false;
        return false;
      } catch {
        return true;
      }
    }
  }

  beginCleanup(intent: CleanupIntent): void {
    this.assignment.cleanupIntent = mergeCleanupIntent(
      this.assignment.cleanupIntent,
      intent,
    );
    this.accepting = false;
    this.peer?.stop();
    this.peer = null;
  }

  async onCdpEvent(method: string, params: unknown): Promise<void> {
    const cdp = this.cdp;
    if (cdp === null || !this.host.isCurrent(this)) return;
    if (method === "Fetch.requestPaused") {
      await cdp.handleFetchRequestPaused(params);
      return;
    }
    if (method === "Target.attachedToTarget") {
      await cdp.closePausedRelatedTarget(params);
      return;
    }
    const decision = classifyCdpEvent(method, params, {
      currentUrl: cdp.currentUrl,
      mainFrameId: cdp.mainFrameId,
    });
    if (decision.newMainFrameId !== undefined) cdp.mainFrameId = decision.newMainFrameId;
    if (decision.newUrl !== undefined) cdp.currentUrl = decision.newUrl;
    if (decision.loadStarted === true) cdp.markLoadStarted();
    if (decision.bumpGeneration === true) await cdp.bumpGeneration();
    if (!this.host.isCurrent(this)) return;
    if (decision.pageEvent?.kind === "load") cdp.notifyLoadEventFired();
    if (decision.pageEvent !== undefined) {
      this.send({
        type: "page_event",
        kind: decision.pageEvent.kind,
        tabId: this.tabId,
        url: decision.pageEvent.url,
      } satisfies Event);
      await this.host.onTabChanged(this);
    }
    if (decision.dialog !== undefined) {
      const payload = decision.dialog.event;
      const record = {
        dialogId: crypto.randomUUID(),
        occurredAt: new Date().toISOString(),
        tabId: this.tabId,
        dialogType: payload?.dialogType ?? "alert",
        message: payload?.message ?? "",
        url: payload?.url ?? cdp.currentUrl,
        ...(payload?.defaultPrompt === undefined
          ? {}
          : { defaultPrompt: payload.defaultPrompt }),
        disposition: payload?.disposition ?? (decision.dialog.accept ? "accept" : "dismiss"),
      } as const;
      const delivery = await this.dialogs.add(record);
      try {
        await cdp.send("Page.handleJavaScriptDialog", { accept: decision.dialog.accept });
      } finally {
        if (delivery === "ok") this.send({ type: "dialog", ...record });
        else this.send({ type: "health", dialogDelivery: "overflow" });
      }
    }
  }

  async onDebuggerDetach(): Promise<void> {
    this.cdp = null;
    if (this.closing) return;
    this.accepting = false;
    this.peer?.stop();
    this.peer = null;
    await this.host.onFenced(this);
  }

  private async onOpen(): Promise<void> {
    const tab = await this.tabInfo();
    if (!this.canAccept()) return;
    this.send({
      type: "hello",
      protocolVersion: PROTOCOL_VERSION,
      capabilities: [...PROTOCOL_CAPABILITIES],
      browser: navigator.userAgent,
      extVersion: browser.runtime.getManifest().version,
      browserEpoch: this.assignment.browserEpoch,
      leaseId: this.assignment.leaseId,
      leaseEpoch: this.assignment.leaseEpoch,
      tabs: [tab],
    } satisfies Event);

    for (const record of await this.journal.recover()) {
      if (!this.canAccept()) return;
      if (record.state === "prepared") {
        this.send({
          type: "write_ready",
          ...this.fence(record.attemptId, Date.now() + 1_000),
          commandId: record.commandId,
          requestFingerprint: record.requestFingerprint,
        });
      } else if (record.state === "started") {
        await this.journal.markUnknown(record.attemptId);
        this.writesBlocked = true;
      } else if (record.state === "completed_unacked" && record.event !== undefined) {
        this.send({
          type: "command_result",
          attemptId: record.attemptId,
          commandId: record.commandId,
          ...this.resultFence(),
          event: record.event,
        });
      }
    }
    for (const dialog of await this.dialogs.pending()) {
      if (!this.canAccept()) return;
      this.send({ type: "dialog", ...dialog });
    }
  }

  private async onServerFrame(raw: unknown): Promise<void> {
    if (!this.canAccept()) return;
    const parsed = safeParseSessionServerFrame(raw);
    if (!parsed.success) return;
    const frame = parsed.data;
    switch (frame.type) {
      case "command":
        if (!this.matchesFence(frame) || deadline(frame.deadlineAt) <= Date.now()) return;
        await this.executeRead(frame);
        return;
      case "write_prepare":
        if (
          !this.matchesFence(frame) ||
          deadline(frame.deadlineAt) <= Date.now() ||
          this.writesBlocked
        ) {
          return;
        }
        await this.journal.prepare({
          attemptId: frame.attemptId,
          commandId: frame.commandId,
          requestFingerprint: frame.requestFingerprint,
          leaseId: frame.leaseId,
          leaseEpoch: frame.leaseEpoch,
          browserEpoch: frame.browserEpoch,
        });
        if (!this.canAccept()) return;
        this.send({
          type: "write_ready",
          ...this.fence(frame.attemptId, deadline(frame.deadlineAt)),
          commandId: frame.commandId,
          requestFingerprint: frame.requestFingerprint,
        });
        return;
      case "write_grant":
        await this.executeWrite(frame);
        return;
      case "attempt_cancel":
        await this.journal.cancelPrepared(frame.attemptId);
        return;
      case "result_ack":
        await this.journal.acknowledge(frame.attemptId);
        return;
      case "dialog_ack":
        await this.dialogs.acknowledge(frame.dialogId);
        return;
      case "writes_blocked":
        this.writesBlocked = true;
        return;
      case "close_session":
        await this.close(frame.closeTab);
        return;
    }
  }

  private async executeRead(
    frame: Extract<SessionServerFrame, { type: "command" }>,
  ): Promise<void> {
    const event = await this.executeWithDeadline(frame.command, deadline(frame.deadlineAt));
    if (event !== null && this.canAccept()) {
      this.send({
        type: "command_result",
        attemptId: frame.attemptId,
        commandId: frame.command.commandId,
        ...this.resultFence(),
        event,
      });
    }
  }

  private async executeWrite(
    frame: Extract<SessionServerFrame, { type: "write_grant" }>,
  ): Promise<void> {
    if (
      this.writesBlocked ||
      !this.matchesFence(frame) ||
      deadline(frame.deadlineAt) <= Date.now() ||
      !isWriteCommand(frame.command)
    ) {
      return;
    }
    const record = await this.journal.get(frame.attemptId);
    if (!this.canAccept()) return;
    if (
      record === undefined ||
      record.state !== "prepared" ||
      record.commandId !== frame.command.commandId
    ) {
      return;
    }
    await this.journal.markStarted(frame.attemptId);
    if (!this.canAccept()) return;
    const event = await this.executeWithDeadline(frame.command, deadline(frame.deadlineAt));
    if (event === null || !this.canAccept()) {
      await this.journal.markUnknown(frame.attemptId);
      this.writesBlocked = true;
      return;
    }
    await this.journal.markCompleted(frame.attemptId, event);
    if (!this.canAccept()) return;
    this.send({
      type: "command_result",
      attemptId: frame.attemptId,
      commandId: frame.command.commandId,
      ...this.resultFence(),
      event,
    });
  }

  private async executeWithDeadline(
    command: Command,
    deadlineAt: number,
  ): Promise<Event | null> {
    const cdp = this.cdp;
    if (cdp === null) {
      return {
        type: "action_result",
        commandId: command.commandId,
        ok: false,
        error: "no active CDP session",
      };
    }
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) return null;
    let timer: ReturnType<typeof setTimeout>;
    const timedOut = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), remaining);
    });
    const execution = routeCommand(command, cdp);
    const event = await Promise.race([execution, timedOut]);
    clearTimeout(timer!);
    if (event !== null) return event;
    await cdp.detach().catch(() => {});
    this.cdp = null;
    this.accepting = false;
    this.peer?.stop();
    this.peer = null;
    await this.host.onFenced(this);
    return null;
  }

  private fence(attemptId: string, deadlineAt: number) {
    return {
      attemptId,
      deadlineAt: new Date(deadlineAt).toISOString(),
      leaseId: this.assignment.leaseId,
      leaseEpoch: this.assignment.leaseEpoch,
      browserEpoch: this.assignment.browserEpoch,
    };
  }

  private resultFence() {
    return {
      leaseId: this.assignment.leaseId,
      leaseEpoch: this.assignment.leaseEpoch,
      browserEpoch: this.assignment.browserEpoch,
    };
  }

  private async tabInfo(): Promise<TabInfo> {
    const tab = await browser.tabs.get(this.tabId);
    return {
      tabId: this.tabId,
      url: tab.url ?? "about:blank",
      title: tab.title ?? "",
      active: tab.active,
    };
  }

  private canAccept(): boolean {
    return (
      this.accepting &&
      !this.closing &&
      this.assignment.cleanupIntent === undefined &&
      this.host.isCurrent(this)
    );
  }

  private send(frame: unknown): void {
    this.peer?.send(frame);
  }
}

function mergeCleanupIntent(
  current: CleanupIntent | undefined,
  requested: CleanupIntent,
): CleanupIntent {
  if (current === "discard" || requested === "discard") return "discard";
  if (current === "release" || requested === "release") return "release";
  return "recover";
}

function deadline(value: string): number {
  return Date.parse(value);
}
