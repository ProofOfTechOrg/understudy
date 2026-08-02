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
import { DialogOutbox, handleDialogWithOutbox } from "./dialog-outbox";
import { CdpSession } from "../driver/cdp";
import { classifyCdpEvent, type CdpDecision } from "../driver/cdp-events";
import { controlledTabInfo } from "../tabs";
import { CardVaultExpiredError, type CardVault } from "../payment/card-vault";
import {
  storedPaymentCardExpired,
  type ValidatedPaymentCard,
} from "../payment/card-validation";
import { closeWindowAndConfirm } from "./window-lifecycle";

export interface RuntimeAssignment {
  sessionId: string;
  leaseId: string;
  leaseEpoch: number;
  browserEpoch: string;
  allowedOrigins: string[];
  policyVersion: number;
  tabId: number;
  windowId: number;
}

export type CleanupIntent = "recover" | "release" | "discard";

export type PaymentVaultAccess = Pick<
  CardVault,
  "summary" | "authorizePayment" | "paymentAuthorizationStillValid"
>;

export interface ManagedAssignment extends RuntimeAssignment {
  cleanupIntent?: CleanupIntent;
  sensitive?: boolean;
}

export interface RuntimeHost {
  serviceOrigin(): string;
  browserEpoch(): string;
  isCurrent(runtime: SessionRuntime): boolean;
  onFenced(runtime: SessionRuntime): Promise<void>;
  onTabChanged(runtime: SessionRuntime): Promise<void>;
  paymentVault(): PaymentVaultAccess;
  enterSensitive(runtime: SessionRuntime): Promise<void>;
  prepareSensitiveComplete(runtime: SessionRuntime): Promise<boolean>;
  finalizeSensitiveComplete(runtime: SessionRuntime): Promise<void>;
  abortSensitive(runtime: SessionRuntime): Promise<void>;
}

export class SessionRuntime {
  readonly journal: WriteJournal;
  readonly dialogs: DialogOutbox;
  private peer: ReconnectingWs | null = null;
  private cdp: CdpSession | null = null;
  private accepting: boolean;
  private writesBlocked = false;
  private closing = false;
  private sensitive = false;
  private windowClosure: Promise<boolean> | null = null;

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
    const closed = await this.closeOwnedWindow();
    if (!closed) this.closing = false;
    return closed;
  }

  async closeSensitiveTab(): Promise<boolean> {
    const cdp = this.cdp;
    this.cdp = null;
    await cdp?.detach().catch(() => {});
    return this.closeOwnedWindow();
  }

  private closeOwnedWindow(): Promise<boolean> {
    if (this.windowClosure !== null) return this.windowClosure;
    const closure = closeWindowAndConfirm(this.assignment.windowId);
    this.windowClosure = closure;
    void closure.then(
      (closed) => {
        if (!closed && this.windowClosure === closure) this.windowClosure = null;
      },
      () => {
        if (this.windowClosure === closure) this.windowClosure = null;
      },
    );
    return closure;
  }

  finishSensitive(): void {
    this.accepting = false;
    this.closing = true;
    this.peer?.stop();
    this.peer = null;
  }

  beginSensitiveCompletion(): void {
    if (this.assignment.sensitive !== true || !this.accepting || this.closing) {
      throw new Error("sensitive completion is not active");
    }
    // The release fence must survive worker eviction before tab closure, while
    // the socket remains alive long enough to emit the one fixed result.
    this.assignment.cleanupIntent = mergeCleanupIntent(
      this.assignment.cleanupIntent,
      "release",
    );
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
    await this.applyCdpDecision(cdp, decision);
    if (this.sensitive) {
      if (decision.dialog !== undefined) {
        await cdp.send("Page.handleJavaScriptDialog", {
          accept: decision.dialog.accept,
        }).catch(() => {});
      }
      return;
    }
    if (!this.host.isCurrent(this)) return;
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
      const accept = decision.dialog.accept;
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
        disposition: payload?.disposition ?? (accept ? "accept" : "dismiss"),
      } as const;
      await handleDialogWithOutbox(
        this.dialogs,
        record,
        () => cdp.send("Page.handleJavaScriptDialog", { accept }),
        (delivery) => {
          if (delivery === "ok") this.send({ type: "dialog", ...record });
          else this.send({ type: "health", dialogDelivery: "overflow" });
        },
      );
    }
  }

  private async applyCdpDecision(
    cdp: CdpSession,
    decision: CdpDecision,
  ): Promise<void> {
    if (decision.newMainFrameId !== undefined) cdp.mainFrameId = decision.newMainFrameId;
    if (decision.newUrl !== undefined) cdp.currentUrl = decision.newUrl;
    if (decision.loadStarted === true) cdp.markLoadStarted();
    if (decision.bumpGeneration === true) await cdp.bumpGeneration();
    if (decision.pageEvent?.kind === "load") cdp.notifyLoadEventFired();
  }

  async onDebuggerDetach(): Promise<void> {
    this.cdp = null;
    if (this.closing || this.sensitive) return;
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
    if (event !== null && this.canReply()) {
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
    const sensitivePayment =
      frame.command.type === "submit_card" && this.assignment.sensitive === true;
    if (event === null || !(sensitivePayment ? this.canReply() : this.canAccept())) {
      await this.journal.markUnknown(frame.attemptId);
      this.writesBlocked = true;
      return;
    }
    if (!sensitivePayment) {
      await this.journal.markCompleted(frame.attemptId, event);
      if (!this.canAccept()) return;
      this.send({
        type: "command_result",
        attemptId: frame.attemptId,
        commandId: frame.command.commandId,
        ...this.resultFence(),
        event,
      });
      return;
    }
    let finalized = false;
    try {
      await this.journal.markCompleted(frame.attemptId, event);
      if (!this.canReply() || !(await this.host.prepareSensitiveComplete(this))) return;
      this.send({
        type: "command_result",
        attemptId: frame.attemptId,
        commandId: frame.command.commandId,
        ...this.resultFence(),
        event,
      });
      await this.host.finalizeSensitiveComplete(this);
      finalized = true;
    } catch {
      // Sensitive failures are represented only by durable journal state and
      // cleanup; neither extension/storage errors nor page data cross the wire.
    } finally {
      if (!finalized) {
        await this.journal.markUnknown(frame.attemptId).catch(() => {});
        this.writesBlocked = true;
        await this.host.abortSensitive(this).catch(() => {});
      }
    }
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
    if (command.type === "submit_card") {
      return this.executeCardCommand(command, cdp, deadlineAt);
    }
    let timer: ReturnType<typeof setTimeout>;
    const timedOut = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), remaining);
    });
    const execution = command.type === "list_cards"
      ? this.executeCardCommand(command, cdp, deadlineAt)
      : routeCommand(command, cdp);
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
    return controlledTabInfo(
      this.tabId,
      this.cdp?.currentUrl ?? "about:blank",
    );
  }

  private canAccept(): boolean {
    return this.canReply() && !this.sensitive;
  }

  private canReply(): boolean {
    return (
      this.accepting &&
      !this.closing &&
      this.assignment.cleanupIntent === undefined &&
      this.host.isCurrent(this)
    );
  }

  private async executeCardCommand(
    command: Extract<Command, { type: "list_cards" | "submit_card" }>,
    cdp: CdpSession,
    deadlineAt: number,
  ): Promise<Event> {
    const vault = this.host.paymentVault();
    if (command.type === "list_cards") {
      try {
        const summary = await vault.summary();
        return { type: "cards_result", commandId: command.commandId, ...summary };
      } catch {
        return {
          type: "cards_result",
          commandId: command.commandId,
          aliases: [],
          approvedOrigins: [],
        };
      }
    }

    const remainingAtStart = deadlineAt - Date.now();
    if (remainingAtStart <= 0) {
      return cardResult(command.commandId, "not_started", "input_failed");
    }
    let deadlineExpired = false;
    let bytesMayHaveBeenInserted = false;
    let submissionAttempted = false;
    const expired = () => deadlineExpired || Date.now() >= deadlineAt;
    const deadlineResult = () =>
      cardResult(
        command.commandId,
        bytesMayHaveBeenInserted ? "outcome_unknown" : "not_started",
        submissionAttempted ? "submission_attempted" : "input_failed",
      );
    let deadlineOutcome: Promise<Event> | null = null;
    const expirePayment = (): Promise<Event> => {
      deadlineExpired = true;
      if (deadlineOutcome !== null) return deadlineOutcome;
      const wasSensitive = this.sensitive;
      deadlineOutcome = this.closeSensitiveTab().then((closed) => {
        if (wasSensitive && !closed) bytesMayHaveBeenInserted = true;
        return deadlineResult();
      });
      return deadlineOutcome;
    };

    const execution = (async (): Promise<Event> => {
      const refs = paymentRefs(command);
      if (new Set(refs).size !== refs.length) {
        return cardResult(command.commandId, "not_started", "invalid_mapping");
      }
      let origin: string;
      try {
        origin = new URL(cdp.currentUrl).origin;
      } catch {
        return cardResult(command.commandId, "not_started", "origin_not_approved");
      }
      let summary;
      try {
        summary = await vault.summary();
      } catch {
        return expired()
          ? expirePayment()
          : cardResult(command.commandId, "not_started", "card_not_found");
      }
      if (expired()) return expirePayment();
      if (!summary.aliases.includes(command.cardAlias)) {
        return cardResult(command.commandId, "not_started", "card_not_found");
      }
      if (
        !this.assignment.allowedOrigins.includes(origin) ||
        !summary.approvedOrigins.includes(origin)
      ) {
        return cardResult(command.commandId, "not_started", "origin_not_approved");
      }
      if (!cdp.hasCurrentRefs(refs)) {
        return cardResult(command.commandId, "not_started", "stale_ref");
      }
      if (expired()) return expirePayment();

      cdp.pinSensitiveOrigin(origin);
      this.sensitive = true;
      try {
        await this.host.enterSensitive(this);
        if (expired()) return expirePayment();
        if (!(await cdp.stopPendingSensitiveNavigation(origin))) {
          return expired()
            ? expirePayment()
            : cardResult(command.commandId, "not_started", "origin_not_approved");
        }
        if (expired()) return expirePayment();
        let authorization;
        try {
          authorization = await vault.authorizePayment(command.cardAlias, origin);
        } catch (error) {
          if (expired()) return expirePayment();
          if (error instanceof CardVaultExpiredError) {
            return cardResult(command.commandId, "not_started", "card_not_found");
          }
          throw error;
        }
        if (expired()) return expirePayment();
        if (authorization === null) {
          return cardResult(command.commandId, "not_started", "card_not_found");
        }
        const card = authorization.card;
        const fields = paymentFields(command, card);
        if (expired()) return expirePayment();
        const result = await cdp.submitSensitiveFields(
          fields,
          command.submitRef,
          origin,
          () => {
            bytesMayHaveBeenInserted = true;
          },
          () => {
            submissionAttempted = true;
          },
          async () =>
            !storedPaymentCardExpired(card.expiryMonth, card.expiryYear) &&
            (await vault.paymentAuthorizationStillValid(authorization)),
        );
        bytesMayHaveBeenInserted ||= result.cardBytesMayHaveBeenInserted;
        submissionAttempted ||= result.submissionAttempted;
        if (expired()) return expirePayment();
        if (result.insertionRefused === true) {
          return cardResult(command.commandId, "not_started", "card_not_found");
        }
        if (result.originMismatch) {
          return cardResult(command.commandId, "not_started", "origin_not_approved");
        }
        if (result.stale) {
          return cardResult(command.commandId, "not_started", "stale_ref");
        }
        if (submissionAttempted) {
          return cardResult(command.commandId, "outcome_unknown", "submission_attempted");
        }
        return cardResult(
          command.commandId,
          bytesMayHaveBeenInserted ? "outcome_unknown" : "not_started",
          "input_failed",
        );
      } catch {
        return expired() ? expirePayment() : deadlineResult();
      } finally {
        await cdp.detach().catch(() => {});
        this.cdp = null;
      }
    })();

    let timer!: ReturnType<typeof setTimeout>;
    const timedOut = new Promise<Event>((resolve) => {
      timer = setTimeout(() => {
        void expirePayment().then(resolve);
      }, remainingAtStart);
    });
    return Promise.race([execution, timedOut]).finally(() => clearTimeout(timer));
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

function paymentRefs(command: Extract<Command, { type: "submit_card" }>): string[] {
  return [
    command.numberRef,
    ...(command.expiry.kind === "combined"
      ? [command.expiry.ref]
      : [command.expiry.monthRef, command.expiry.yearRef]),
    command.cvvRef,
    ...(command.cardholderNameRef === undefined ? [] : [command.cardholderNameRef]),
    command.submitRef,
  ];
}

function paymentFields(
  command: Extract<Command, { type: "submit_card" }>,
  card: ValidatedPaymentCard,
): Array<{ ref: string; text: string }> {
  return [
    ...(command.cardholderNameRef === undefined
      ? []
      : [{ ref: command.cardholderNameRef, text: card.cardholderName }]),
    { ref: command.numberRef, text: card.pan },
    ...(command.expiry.kind === "combined"
      ? [
          {
            ref: command.expiry.ref,
            text: `${card.expiryMonth}/${card.expiryYear.slice(-2)}`,
          },
        ]
      : [
          { ref: command.expiry.monthRef, text: card.expiryMonth },
          { ref: command.expiry.yearRef, text: card.expiryYear },
        ]),
    { ref: command.cvvRef, text: card.cvv },
  ];
}

function cardResult(
  commandId: string,
  status: "not_started" | "outcome_unknown",
  reason:
    | "card_not_found"
    | "origin_not_approved"
    | "stale_ref"
    | "invalid_mapping"
    | "input_failed"
    | "submission_attempted",
): Event {
  return { type: "card_submission_result", commandId, status, reason };
}
