import {
  ELEMENTS_RESULT_MAX_BYTES,
  MAX_ELEMENT_DESCRIPTORS,
  MAX_SEMANTIC_NODES,
  utf8ByteLength,
  type ActionFailureReason,
  type ElementAction,
  type ElementDescriptor,
  type ElementsFailureReason,
  type ElementsResult,
  type Event,
} from "@understudy/protocol";
import type { Protocol } from "devtools-protocol";
import { errorMessage } from "../events";
import { a11yRefPrefix, buildA11ySnapshot } from "./a11y";
import { parseKeys } from "./keymap";
import {
  buildSemanticCache,
  deltaDescriptors,
  findDescriptors,
  inspectDescriptors,
  snapshotDescriptors,
} from "./semantic/cache";
import {
  captureSemanticPage,
  SemanticCaptureError,
} from "./semantic/capture";
import {
  allowlistedDomMetadata,
} from "./semantic/dom";
import {
  decodeAxNode,
  normalizePageString,
} from "./semantic/normalize";
import type {
  DebuggerFrameSession,
  FrameTopologyEntry,
  RefRecord,
  SemanticCache,
  SemanticFingerprint,
} from "./semantic/types";
import { backendIdentityKey } from "./semantic/types";

type WaitFor = "load" | "idle" | "ms";

// A hung/wedged page must still resolve to a reportable action_result instead
// of leaving a peer's pending-map stuck forever.
const SEND_TIMEOUT_MS = 15000;
const LOAD_TIMEOUT_MS = 15000;
const IDLE_QUIET_MS = 500;
// The backend coordinator abandons commands at 30s. One budget covers the
// entire identity/capture/persist/identity bracket so its sequential CDP calls
// cannot each consume their independent 15s send timeout.
const SNAPSHOT_DEADLINE_MS = 25_000;
const CURSOR_TTL_MS = 10 * 60 * 1_000;
const MAX_ACTIVE_CURSORS = 16;

interface ElementCursor {
  token: string;
  snapshotId: string;
  generation: number;
  elements: readonly ElementDescriptor[];
  offset: number;
  pageSize: number;
  expiresAt: number;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function quadCenter(quad: Protocol.DOM.Quad): { x: number; y: number } {
  if (quad.length < 8) {
    throw new Error(`Unexpected box-model quad of length ${quad.length}`);
  }
  const x = ((quad[0] ?? 0) + (quad[2] ?? 0) + (quad[4] ?? 0) + (quad[6] ?? 0)) / 4;
  const y = ((quad[1] ?? 0) + (quad[3] ?? 0) + (quad[5] ?? 0) + (quad[7] ?? 0)) / 4;
  return { x, y };
}

function quadBounds(
  quad: Protocol.DOM.Quad,
): { x: number; y: number; width: number; height: number } | undefined {
  if (quad.length < 8) return undefined;
  const xs = [quad[0], quad[2], quad[4], quad[6]];
  const ys = [quad[1], quad[3], quad[5], quad[7]];
  if (
    xs.some((value) => value === undefined || !Number.isFinite(value)) ||
    ys.some((value) => value === undefined || !Number.isFinite(value))
  ) {
    return undefined;
  }
  const x = Math.min(...(xs as number[]));
  const y = Math.min(...(ys as number[]));
  return {
    x,
    y,
    width: Math.max(...(xs as number[])) - x,
    height: Math.max(...(ys as number[])) - y,
  };
}

function sameFingerprintField<K extends keyof SemanticFingerprint>(
  expected: SemanticFingerprint,
  actual: SemanticFingerprint,
  field: K,
): boolean {
  if (
    (field === "tagName" || field === "inputType") &&
    !expected.domMetadataKnown
  ) {
    return true;
  }
  return expected[field] === actual[field];
}

function fingerprintMatches(
  expected: SemanticFingerprint,
  actual: SemanticFingerprint,
  action: ElementAction,
): boolean {
  const fields: Record<ElementAction, ReadonlyArray<keyof SemanticFingerprint>> = {
    click: [
      "role",
      "name",
      "description",
      "tagName",
      "inputType",
      "hidden",
      "disabled",
      "checked",
      "selected",
      "expanded",
      "pressed",
    ],
    type: [
      "role",
      "name",
      "description",
      "tagName",
      "inputType",
      "hidden",
      "disabled",
      "readonly",
      "editable",
    ],
    key: ["role", "name", "hidden", "disabled", "focusable"],
    scroll: ["hidden", "scrollable"],
    inspect: [
      "role",
      "name",
      "description",
      "tagName",
      "inputType",
      "hidden",
      "disabled",
      "readonly",
      "editable",
      "checked",
      "selected",
      "expanded",
      "pressed",
      "focusable",
      "scrollable",
    ],
  };
  return fields[action].every((field) => sameFingerprintField(expected, actual, field));
}

// One session per attached tab, one CDP channel. Every executor runs through
// `run`/`enqueue`, which chains onto `queue` so commands stay FIFO even if the
// peer pipelines several at once — interleaved multi-step executors (e.g.
// focus-then-insertText) would otherwise corrupt each other on a shared channel.
export class CdpSession {
  enabled = false;
  generation = 0;
  private refs: Map<string, RefRecord> = new Map();
  private refRecordsByBackendIdentity = new Map<string, readonly RefRecord[]>();
  currentUrl = "";
  mainFrameId = "";
  readonly frameSessions = new Map<string, DebuggerFrameSession>();

  replaceRefMap(value: Map<string, RefRecord>): void {
    this.refs = new Map(
      [...value].map(([ref, record]) => [
        ref,
        Object.freeze({
          ...record,
          actions: new Set(record.actions),
          fingerprint: Object.freeze({ ...record.fingerprint }),
        }),
      ]),
    );
    const indexed = new Map<string, RefRecord[]>();
    for (const record of this.refs.values()) {
      const key = backendIdentityKey(record.debuggerSessionId, record.backendNodeId);
      const records = indexed.get(key) ?? [];
      records.push(record);
      indexed.set(key, records);
    }
    this.refRecordsByBackendIdentity = indexed;
  }

  get refCount(): number {
    return this.refs.size;
  }

  private loadInFlight = false;
  private readonly loadWaiters = new Set<() => void>();
  private queue: Promise<unknown> = Promise.resolve();
  // Chained (not fire-and-forget) so concurrent bumpGeneration() calls persist
  // in order instead of racing to overwrite browser.storage.session.
  private genPersistChain: Promise<unknown> = Promise.resolve();
  private allowedOrigins: Set<string> | null = null;
  private sensitiveOrigin: string | null = null;
  private sensitiveSubmissionArmed = false;
  private semanticCache: SemanticCache | null = null;
  private deltaBaseline: SemanticCache | null = null;
  private readonly cursors = new Map<string, ElementCursor>();
  private readonly frameParents = new Map<string, string | undefined>();

  private constructor(
    readonly tabId: number,
    private refScopeId: string,
  ) {}

  static async create(
    tabId: number,
    refScopeId: string = crypto.randomUUID(),
  ): Promise<CdpSession> {
    const session = new CdpSession(tabId, refScopeId);
    await session.loadGeneration();
    return session;
  }

  private static genKey(tabId: number): string {
    return `understudy:cdp:gen:${tabId}`;
  }

  private async loadGeneration(): Promise<void> {
    const key = CdpSession.genKey(this.tabId);
    const stored = await browser.storage.session.get(key);
    const value = stored[key];
    this.generation = typeof value === "number" ? value : 0;
  }

  bumpGeneration(preserveDeltaBaseline = false): Promise<number> {
    this.deltaBaseline = preserveDeltaBaseline
      ? (this.semanticCache ?? this.deltaBaseline)
      : null;
    this.generation += 1;
    this.replaceRefMap(new Map());
    this.semanticCache = null;
    this.cursors.clear();
    const value = this.generation;
    const write = this.genPersistChain.then(() =>
      browser.storage.session.set({ [CdpSession.genKey(this.tabId)]: value }),
    );
    this.genPersistChain = write.then(
      () => undefined,
      () => undefined,
    );
    return write.then(() => value);
  }

  async send<R>(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs = SEND_TIMEOUT_MS,
    debuggerSessionId?: string,
  ): Promise<R> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    try {
      const raw: unknown = await Promise.race([
        browser.debugger.sendCommand(
          {
            tabId: this.tabId,
            ...(debuggerSessionId === undefined ? {} : { sessionId: debuggerSessionId }),
          },
          method,
          params,
        ),
        timeout,
      ]);
      return raw as R;
    } finally {
      clearTimeout(timer);
    }
  }

  private sendInSession<R>(
    method: string,
    params: Record<string, unknown> | undefined,
    debuggerSessionId?: string,
    timeoutMs = SEND_TIMEOUT_MS,
  ): Promise<R> {
    return this.send<R>(method, params, timeoutMs, debuggerSessionId);
  }

  async attach(): Promise<void> {
    await browser.debugger.attach({ tabId: this.tabId }, "1.3");
  }

  async detach(): Promise<void> {
    this.enabled = false;
    this.sensitiveOrigin = null;
    this.sensitiveSubmissionArmed = false;
    this.frameSessions.clear();
    this.frameParents.clear();
    this.semanticCache = null;
    this.deltaBaseline = null;
    this.cursors.clear();
    this.replaceRefMap(new Map());
    await browser.debugger.detach({ tabId: this.tabId });
  }

  async enableDomains(): Promise<void> {
    if (this.enabled) return;
    await this.send("Accessibility.enable");
    await this.send("DOM.enable");
    await this.send("Page.enable");
    await this.send("Runtime.enable");
    const identity = await this.mainFrameIdentity();
    this.mainFrameId = identity.frameId;
    this.currentUrl = identity.url;
    await this.refreshFrameTopology();
    await this.configureAutoAttach(undefined, false);
    this.enabled = true;
  }

  async enableUnattendedContainment(allowedOrigins: readonly string[]): Promise<void> {
    this.allowedOrigins = new Set(allowedOrigins);
    await this.send("Fetch.enable", {
      patterns: [
        {
          urlPattern: "*",
          resourceType: "Document",
          requestStage: "Request",
        },
      ],
    });
    await this.configureAutoAttach(undefined, true);
  }

  private configureAutoAttach(
    debuggerSessionId: string | undefined,
    unattended: boolean,
  ): Promise<unknown> {
    return this.sendInSession(
      "Target.setAutoAttach",
      {
        autoAttach: true,
        waitForDebuggerOnStart: unattended,
        flatten: true,
        filter: unattended
          ? [
              { type: "page", exclude: false },
              { type: "iframe", exclude: false },
            ]
          : [{ type: "iframe", exclude: false }],
      },
      debuggerSessionId,
    );
  }

  async handleAttachedTarget(
    sourceSessionId: string | undefined,
    params: unknown,
    unattended: boolean,
  ): Promise<void> {
    const event = params as {
      sessionId?: unknown;
      targetInfo?: { targetId?: unknown; type?: unknown };
    };
    const childSessionId = event.sessionId;
    const targetId = event.targetInfo?.targetId;
    const targetType = event.targetInfo?.type;
    if (typeof childSessionId !== "string" || typeof targetId !== "string") return;
    if (targetType === "page") {
      if (unattended) {
        await this.sendInSession(
          "Target.closeTarget",
          { targetId },
          sourceSessionId,
        );
      }
      return;
    }
    if (targetType !== "iframe") return;

    const tracked: DebuggerFrameSession = {
      sessionId: childSessionId,
      targetId,
      frameId: targetId,
      ...(sourceSessionId === undefined ? {} : { parentSessionId: sourceSessionId }),
      targetType: "iframe",
      ready: false,
    };
    this.frameSessions.set(targetId, tracked);
    try {
      await Promise.all([
        this.sendInSession("Accessibility.enable", undefined, childSessionId),
        this.sendInSession("DOM.enable", undefined, childSessionId),
        this.sendInSession("Page.enable", undefined, childSessionId),
        this.sendInSession("Runtime.enable", undefined, childSessionId),
      ]);
      await this.configureAutoAttach(childSessionId, unattended);
      await this.sendInSession(
        "Runtime.runIfWaitingForDebugger",
        undefined,
        childSessionId,
      ).catch(() => {});
      const identity = await this.frameIdentity(childSessionId);
      if (identity.frameId !== targetId) {
        this.frameSessions.delete(targetId);
        tracked.frameId = identity.frameId;
        this.frameSessions.set(identity.frameId, tracked);
      }
      tracked.ready = true;
    } catch {
      this.frameSessions.delete(tracked.frameId);
      await this.bumpGeneration();
    }
  }

  handleDetachedTarget(params: unknown): boolean {
    const sessionId = (params as { sessionId?: unknown })?.sessionId;
    if (typeof sessionId !== "string") return false;
    const detachedSessions = new Set([sessionId]);
    let removed = false;
    let found = true;
    while (found) {
      found = false;
      for (const [frameId, tracked] of this.frameSessions) {
        if (
          !detachedSessions.has(tracked.sessionId ?? "") &&
          !detachedSessions.has(tracked.parentSessionId ?? "")
        ) {
          continue;
        }
        if (tracked.sessionId !== undefined) detachedSessions.add(tracked.sessionId);
        this.frameSessions.delete(frameId);
        this.frameParents.delete(frameId);
        removed = true;
        found = true;
      }
    }
    return removed;
  }

  hasMeaningfulAccessibilityUpdate(
    params: unknown,
    debuggerSessionId?: string,
  ): boolean {
    const nodes = (params as { nodes?: unknown })?.nodes;
    if (!Array.isArray(nodes)) return false;
    for (const candidate of nodes) {
      const node = candidate as Protocol.Accessibility.AXNode;
      const backendNodeId = node.backendDOMNodeId;
      const axIdentity =
        backendNodeId === undefined && node.frameId !== undefined
          ? `ax:${debuggerSessionId ?? "root"}:${node.frameId}:${node.nodeId}`
          : undefined;
      const cached =
        backendNodeId === undefined
          ? this.semanticCache?.byIdentity.get(axIdentity ?? "")
          : this.semanticCache?.byBackendIdentity.get(
              backendIdentityKey(debuggerSessionId, backendNodeId),
            );
      const records =
        backendNodeId === undefined
          ? []
          : (this.refRecordsByBackendIdentity.get(
              backendIdentityKey(debuggerSessionId, backendNodeId),
            ) ?? []);
      const expectedFingerprints = [
        ...(cached === undefined ? [] : [cached.fingerprint]),
        ...records.map((record) => record.fingerprint),
      ];
      const decoded = decodeAxNode(node, {
        role: cached?.descriptor.role ?? expectedFingerprints[0]?.role,
        editable: cached?.fingerprint.editable ?? expectedFingerprints[0]?.editable,
      });
      for (const expected of expectedFingerprints) {
        if (
          (node.role !== undefined &&
            expected.role !== (decoded.role ?? "unknown")) ||
          (node.name !== undefined &&
            expected.name !== decoded.name) ||
          (node.description !== undefined &&
            expected.description !== decoded.description)
        ) {
          return true;
        }
        const fingerprintUpdates = {
          hidden: decoded.hidden,
          disabled: decoded.states?.disabled,
          readonly: decoded.states?.readonly,
          checked: decoded.states?.checked,
          selected: decoded.states?.selected,
          expanded: decoded.states?.expanded,
          pressed: decoded.states?.pressed,
        };
        for (const [property, actual] of Object.entries(fingerprintUpdates)) {
          if (!decoded.presentProperties.has(property)) continue;
          if (expected[property as keyof typeof fingerprintUpdates] !== actual) return true;
        }
      }
      if (cached !== undefined && node.properties !== undefined) {
        for (const [property, field] of [
          ["required", "required"],
          ["invalid", "invalid"],
          ["level", "level"],
          ["modal", "modal"],
          ["hasPopup", "hasPopup"],
        ] as const) {
          if (!decoded.presentProperties.has(property)) continue;
          if (cached.descriptor.states?.[field] !== decoded.states?.[field]) return true;
        }
        const hasRangeUpdate =
          node.value !== undefined ||
          ["valuemin", "valuemax", "valuenow", "valuetext"].some((property) =>
            decoded.presentProperties.has(property),
          );
        if (
          hasRangeUpdate &&
          JSON.stringify(cached.descriptor.range) !==
          JSON.stringify(decoded.range)
        ) {
          return true;
        }
      }
    }
    return false;
  }

  async handleFetchRequestPaused(params: unknown): Promise<void> {
    const event = params as {
      requestId?: unknown;
      request?: { url?: unknown };
      frameId?: unknown;
      resourceType?: unknown;
    };
    if (typeof event.requestId !== "string") return;
    const isMainDocument =
      event.resourceType === "Document" &&
      typeof event.frameId === "string" &&
      event.frameId === this.mainFrameId;
    const url = event.request?.url;
    if (
      isMainDocument &&
      (typeof url !== "string" ||
        !this.isAllowedTopLevelUrl(url) ||
        !this.isSensitiveTopLevelUrl(url))
    ) {
      await this.send("Fetch.failRequest", {
        requestId: event.requestId,
        errorReason: "BlockedByClient",
      });
      await this.bumpGeneration();
      return;
    }
    await this.send("Fetch.continueRequest", { requestId: event.requestId });
  }

  isAllowedTopLevelUrl(value: string): boolean {
    if (value === "about:blank") return true;
    if (this.allowedOrigins === null) return true;
    try {
      return this.allowedOrigins.has(new URL(value).origin);
    } catch {
      return false;
    }
  }

  pinSensitiveOrigin(origin: string): void {
    this.sensitiveOrigin = origin;
    this.sensitiveSubmissionArmed = false;
  }

  async stopPendingSensitiveNavigation(expectedOrigin: string): Promise<boolean> {
    await this.send("Page.stopLoading");
    try {
      return new URL((await this.mainFrameIdentity()).url).origin === expectedOrigin;
    } catch {
      return false;
    }
  }

  async reconcile(): Promise<void> {
    this.enabled = false;
    await this.enableDomains();
    await this.bumpGeneration();
  }

  // Generation-namespaced refs (see driver/a11y.ts) make staleness detectable:
  // a ref from a prior snapshot generation fails the prefix check below.
  resolveRef(ref: string): RefRecord | null {
    const prefix = a11yRefPrefix({
      scopeId: this.refScopeId,
      generation: this.generation,
    });
    if (!ref.startsWith(prefix)) return null;
    const record = this.refs.get(ref);
    return record?.generation === this.generation ? record : null;
  }

  hasCurrentRefs(refs: readonly string[]): boolean {
    return refs.every((ref) => this.resolveRef(ref) !== null);
  }

  preflightSensitiveRefs(
    fieldRefs: readonly string[],
    submitRef: string,
  ): Promise<boolean> {
    return this.enqueue(async () => {
      for (const ref of fieldRefs) {
        const record = this.resolveRef(ref);
        if (record === null || !(await this.validateRef(record, "type")).ok) {
          return false;
        }
      }
      const submit = this.resolveRef(submitRef);
      return submit !== null && (await this.validateRef(submit, "click")).ok;
    });
  }

  submitSensitiveFields(
    fields: ReadonlyArray<{ ref: string; text: string }>,
    submitRef: string,
    expectedOrigin: string,
    onBeforeInsert: () => void,
    onBeforeSubmit: () => void,
    canBeginInsertion: () => boolean | Promise<boolean> = () => true,
  ): Promise<{
    stale: boolean;
    originMismatch: boolean;
    cardBytesMayHaveBeenInserted: boolean;
    submissionAttempted: boolean;
    insertionRefused?: true;
  }> {
    return this.enqueue(async () => {
      const expectedGeneration = this.generation;
      const resolvedFields = fields.map((field) => ({
        ...field,
        record: this.resolveRef(field.ref),
      }));
      const submitRecord = this.resolveRef(submitRef);
      if (
        resolvedFields.some((field) => field.record === null) ||
        submitRecord === null
      ) {
        return {
          stale: true,
          originMismatch: false,
          cardBytesMayHaveBeenInserted: false,
          submissionAttempted: false,
        };
      }
      let currentOrigin: string;
      try {
        currentOrigin = new URL((await this.mainFrameIdentity()).url).origin;
      } catch {
        currentOrigin = "";
      }
      if (currentOrigin !== expectedOrigin) {
        return {
          stale: false,
          originMismatch: true,
          cardBytesMayHaveBeenInserted: false,
          submissionAttempted: false,
        };
      }
      let cardBytesMayHaveBeenInserted = false;
      let submissionAttempted = false;
      try {
        for (const field of resolvedFields) {
          if (this.generation !== expectedGeneration) break;
          await this.focus(
            field.record!.backendNodeId,
            field.record!.debuggerSessionId,
          );
          await this.dispatchKey(
            parseKeys("Ctrl+a"),
            field.record!.debuggerSessionId,
          );
          if (this.generation !== expectedGeneration) break;
          if (!cardBytesMayHaveBeenInserted && !(await canBeginInsertion())) {
            return {
              stale: false,
              originMismatch: false,
              cardBytesMayHaveBeenInserted: false,
              submissionAttempted: false,
              insertionRefused: true,
            };
          }
          cardBytesMayHaveBeenInserted = true;
          onBeforeInsert();
          await this.sendInSession(
            "Input.insertText",
            { text: field.text },
            field.record!.debuggerSessionId,
          );
        }
        if (
          this.generation !== expectedGeneration ||
          resolvedFields.length === 0 ||
          !cardBytesMayHaveBeenInserted
        ) {
          return {
            stale: !cardBytesMayHaveBeenInserted,
            originMismatch: false,
            cardBytesMayHaveBeenInserted,
            submissionAttempted: false,
          };
        }
        submissionAttempted = true;
        this.sensitiveSubmissionArmed = true;
        onBeforeSubmit();
        await this.dispatchClick(
          submitRecord.backendNodeId,
          submitRecord.debuggerSessionId,
        );
      } catch {
        // The fixed result exposes only whether insertion or submission may have started.
      }
      return {
        stale: false,
        originMismatch: false,
        cardBytesMayHaveBeenInserted,
        submissionAttempted,
      };
    });
  }

  private isSensitiveTopLevelUrl(value: string): boolean {
    if (this.sensitiveOrigin === null) return true;
    if (!this.sensitiveSubmissionArmed) return false;
    try {
      return new URL(value).origin === this.sensitiveOrigin;
    } catch {
      return false;
    }
  }

  invalidateRefsForSessionChange(nextScopeId: string = crypto.randomUUID()): Promise<void> {
    return this.enqueue(async () => {
      this.refScopeId = nextScopeId;
      // Scope rotation + the synchronous generation increment/refMap clear are
      // the security boundary. A stuck storage.session write must not prevent
      // the WebSocket session barrier from connecting its replacement peer.
      void this.bumpGeneration().catch(() => {});
    });
  }

  markLoadStarted(): void {
    this.loadInFlight = true;
  }

  notifyLoadEventFired(): void {
    this.loadInFlight = false;
    const waiters = [...this.loadWaiters];
    this.loadWaiters.clear();
    for (const wake of waiters) wake();
  }

  private waitForLoad(timeoutMs: number): Promise<void> {
    if (!this.loadInFlight) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      const wake = (): void => {
        clearTimeout(timer);
        this.loadWaiters.delete(wake);
        resolve();
      };
      timer = setTimeout(() => {
        this.loadInFlight = false;
        wake();
      }, timeoutMs);
      this.loadWaiters.add(wake);
    });
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn, fn);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private run(
    commandId: string,
    body: () => Promise<Event>,
    deadlineAt?: number,
    semanticOperation?: ElementsResult["operation"],
  ): Promise<Event> {
    let started = false;
    let expiredInQueue = false;
    const timeoutEvent = (): Event =>
      semanticOperation === undefined
        ? this.actionFailure(commandId, "timeout", true, true)
        : this.semanticFailure(commandId, semanticOperation, "capture_failed");
    const execution = this.enqueue<Event>(async () => {
      if (
        expiredInQueue ||
        (deadlineAt !== undefined && Date.now() >= deadlineAt)
      ) {
        return timeoutEvent();
      }
      started = true;
      try {
        return await body();
      } catch {
        return semanticOperation === undefined
          ? this.actionFailure(commandId, "action_failed", false, true)
          : this.semanticFailure(commandId, semanticOperation, "capture_failed");
      }
    });
    if (deadlineAt === undefined) return execution;

    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) {
      expiredInQueue = true;
      void execution.catch(() => {});
      return Promise.resolve(timeoutEvent());
    }
    return new Promise<Event>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!started) {
          expiredInQueue = true;
          resolve(timeoutEvent());
        }
      }, remainingMs);
      void execution.then(
        (event) => {
          clearTimeout(timer);
          resolve(event);
        },
        (cause: unknown) => {
          clearTimeout(timer);
          reject(cause);
        },
      );
    });
  }

  private actionSuccess(
    commandId: string,
    refsStale: boolean,
    refreshRecommended: boolean,
    url?: string,
  ): Event {
    return {
      type: "action_result",
      commandId,
      ok: true,
      generation: this.generation,
      refsStale,
      refreshRecommended,
      ...(url === undefined ? {} : { url }),
    };
  }

  private actionFailure(
    commandId: string,
    reason: ActionFailureReason,
    refsStale: boolean,
    refreshRecommended: boolean,
  ): Event {
    return {
      type: "action_result",
      commandId,
      ok: false,
      reason,
      generation: this.generation,
      refsStale,
      refreshRecommended,
    };
  }

  private async optional<T>(action: Promise<T>): Promise<T | undefined> {
    try {
      return await action;
    } catch {
      return undefined;
    }
  }

  private async mainFrameIdentity(deadlineAt?: number): Promise<{
    frameId: string;
    loaderId: string;
    url: string;
  }> {
    return this.frameIdentity(undefined, deadlineAt);
  }

  private async frameIdentity(
    debuggerSessionId?: string,
    deadlineAt?: number,
  ): Promise<{
    frameId: string;
    loaderId: string;
    url: string;
  }> {
    const read = (): Promise<Protocol.Page.GetFrameTreeResponse> =>
      this.sendInSession("Page.getFrameTree", undefined, debuggerSessionId);
    const { frameTree } =
      deadlineAt === undefined
        ? await read()
        : await this.withSnapshotDeadline(deadlineAt, read);
    const frame = frameTree.frame;
    return {
      frameId: frame.id,
      loaderId: frame.loaderId,
      url: `${frame.url}${frame.urlFragment ?? ""}`,
    };
  }

  private async refreshFrameTopology(deadlineAt?: number): Promise<FrameTopologyEntry[]> {
    const read = (): Promise<Protocol.Page.GetFrameTreeResponse> =>
      this.send("Page.getFrameTree");
    const { frameTree } =
      deadlineAt === undefined
        ? await read()
        : await this.withSnapshotDeadline(deadlineAt, read);
    const prior = new Map(this.frameSessions);
    const next = new Map<string, DebuggerFrameSession>();
    const topology: FrameTopologyEntry[] = [];
    let order = 0;
    const visit = (
      tree: Protocol.Page.FrameTree,
      parentFrameId: string | undefined,
    ): void => {
      const existing = prior.get(tree.frame.id);
      const debuggerSessionId = existing?.sessionId;
      next.set(tree.frame.id, {
        ...(debuggerSessionId === undefined ? {} : { sessionId: debuggerSessionId }),
        targetId: existing?.targetId ?? tree.frame.id,
        frameId: tree.frame.id,
        ...(existing?.parentSessionId === undefined
          ? {}
          : { parentSessionId: existing.parentSessionId }),
        targetType: parentFrameId === undefined ? "page" : "iframe",
        ready: existing?.ready ?? debuggerSessionId === undefined,
      });
      this.frameParents.set(tree.frame.id, parentFrameId);
      topology.push({
        frameId: tree.frame.id,
        ...(parentFrameId === undefined ? {} : { parentFrameId }),
        ...(debuggerSessionId === undefined ? {} : { debuggerSessionId }),
        order: order++,
      });
      for (const child of tree.childFrames ?? []) visit(child, tree.frame.id);
    };
    visit(frameTree, undefined);
    for (const [frameId, tracked] of prior) {
      if (next.has(frameId) || !tracked.ready) continue;
      next.set(frameId, tracked);
      topology.push({
        frameId,
        ...(this.frameParents.get(frameId) === undefined
          ? {}
          : { parentFrameId: this.frameParents.get(frameId) }),
        ...(tracked.sessionId === undefined ? {} : { debuggerSessionId: tracked.sessionId }),
        order: order++,
      });
    }
    this.frameSessions.clear();
    for (const [frameId, tracked] of next) this.frameSessions.set(frameId, tracked);
    return topology;
  }

  private invalidateIncompleteSnapshot(generation: number): void {
    this.replaceRefMap(new Map());
    if (this.generation !== generation) return;
    // bumpGeneration mutates the security boundary synchronously. Persistence
    // remains best-effort and must not extend an already-expired snapshot past
    // the coordinator's response deadline.
    void this.bumpGeneration().catch(() => {});
  }

  private async withSnapshotDeadline<T>(
    deadlineAt: number,
    start: () => Promise<T>,
  ): Promise<T> {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) {
      throw new Error(`snapshot timed out after ${SNAPSHOT_DEADLINE_MS}ms`);
    }
    const operation = start();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`snapshot timed out after ${SNAPSHOT_DEADLINE_MS}ms`));
      }, remainingMs);
    });
    try {
      // Promise.race installs rejection handlers on both inputs, so a browser
      // API promise that rejects after the aggregate deadline is still handled.
      return await Promise.race([operation, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Binds a snapshot artifact to one stable main document. CDP events can run
   * while a queued command awaits a response, so main-frame identity reads
   * bracket the capture and the generation catches same-document DOM changes.
   * A changed page invalidates the prior ref map and yields no snapshot result
   * for a consumer to trust.
   */
  private async captureStableSnapshot<T>(
    deadlineAt: number,
    capture: () => Promise<T>,
    mintGeneration = false,
  ): Promise<{ captured: T; generation: number; url: string }> {
    const baselineGeneration = this.generation;
    try {
      const before = await this.mainFrameIdentity(deadlineAt);
      const captured = await this.withSnapshotDeadline(deadlineAt, capture);
      let generation = baselineGeneration;
      if (mintGeneration) {
        if (this.generation !== baselineGeneration) {
          throw new Error("page changed during snapshot");
        }
        generation = await this.withSnapshotDeadline(deadlineAt, () =>
          this.bumpGeneration(),
        );
      }
      const after = await this.mainFrameIdentity(deadlineAt);
      if (
        this.generation !== generation ||
        after.frameId !== before.frameId ||
        after.loaderId !== before.loaderId ||
        after.url !== before.url
      ) {
        throw new Error("page changed during snapshot");
      }
      this.mainFrameId = after.frameId;
      this.currentUrl = after.url;
      return { captured, generation, url: after.url };
    } catch (cause) {
      this.invalidateIncompleteSnapshot(baselineGeneration);
      throw cause;
    }
  }

  private async prepareClick(
    backendNodeId: number,
    debuggerSessionId?: string,
  ): Promise<{ x: number; y: number }> {
    await this.optional(
      this.sendInSession(
        "DOM.scrollIntoViewIfNeeded",
        { backendNodeId },
        debuggerSessionId,
      ),
    );
    const { model } = await this.sendInSession<Protocol.DOM.GetBoxModelResponse>(
      "DOM.getBoxModel",
      { backendNodeId },
      debuggerSessionId,
    );
    const { x, y } = quadCenter(model.content);
    await this.sendInSession(
      "Input.dispatchMouseEvent",
      { type: "mouseMoved", x, y },
      debuggerSessionId,
    );
    return { x, y };
  }

  private async dispatchPreparedClick(
    point: { x: number; y: number },
    debuggerSessionId?: string,
  ): Promise<void> {
    const { x, y } = point;
    await this.sendInSession("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      buttons: 1,
      clickCount: 1,
    }, debuggerSessionId);
    await this.sendInSession("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      buttons: 0,
      clickCount: 1,
    }, debuggerSessionId);
  }

  private async dispatchClick(
    backendNodeId: number,
    debuggerSessionId?: string,
  ): Promise<void> {
    const point = await this.prepareClick(backendNodeId, debuggerSessionId);
    await this.dispatchPreparedClick(point, debuggerSessionId);
  }

  private focus(
    backendNodeId: number,
    debuggerSessionId?: string,
  ): Promise<void> {
    return this.sendInSession("DOM.focus", { backendNodeId }, debuggerSessionId);
  }

  private async dispatchKey(
    parsed: ReturnType<typeof parseKeys>,
    debuggerSessionId?: string,
  ): Promise<void> {
    const base: Record<string, unknown> = {
      modifiers: parsed.modifiers,
      key: parsed.key,
      code: parsed.code,
      windowsVirtualKeyCode: parsed.windowsVirtualKeyCode,
    };
    const keyDown: Record<string, unknown> = {
      ...base,
      type: parsed.text === undefined ? "rawKeyDown" : "keyDown",
    };
    if (parsed.text !== undefined) {
      keyDown.text = parsed.text;
      keyDown.unmodifiedText = parsed.text;
    }
    await this.sendInSession("Input.dispatchKeyEvent", keyDown, debuggerSessionId);
    await this.sendInSession(
      "Input.dispatchKeyEvent",
      { ...base, type: "keyUp" },
      debuggerSessionId,
    );
  }

  snapshotA11y(commandId: string): Promise<Event> {
    const deadlineAt = Date.now() + SNAPSHOT_DEADLINE_MS;
    return this.run(
      commandId,
      async () => {
        const { captured, generation, url } = await this.captureStableSnapshot(
          deadlineAt,
          () =>
            this.send<Protocol.Accessibility.GetFullAXTreeResponse>(
              "Accessibility.getFullAXTree",
            ),
          true,
        );
        const { tree, refMap } = buildA11ySnapshot(captured.nodes, {
          scopeId: this.refScopeId,
          generation,
        });
        const nodesByBackend = new Map(
          captured.nodes
            .filter((node) => node.backendDOMNodeId !== undefined)
            .map((node) => [node.backendDOMNodeId!, node]),
        );
        this.replaceRefMap(
          new Map(
            [...refMap].map(([ref, backendNodeId]) => {
              const ax = nodesByBackend.get(backendNodeId);
              const role = normalizePageString(ax?.role?.value) ?? "unknown";
              const name = normalizePageString(ax?.name?.value);
              const description = normalizePageString(ax?.description?.value);
              const actions = new Set<ElementAction>(["inspect"]);
              if (
                [
                  "button",
                  "link",
                  "checkbox",
                  "radio",
                  "switch",
                  "menuitem",
                  "tab",
                ].includes(role)
              ) {
                actions.add("click");
                actions.add("key");
              }
              if (["textbox", "searchbox", "combobox"].includes(role)) {
                actions.add("type");
                actions.add("key");
              }
              const fingerprint: SemanticFingerprint = {
                role,
                ...(name === undefined ? {} : { name }),
                ...(description === undefined ? {} : { description }),
                domMetadataKnown: false,
                hidden: false,
                disabled: false,
                readonly: false,
                editable: actions.has("type"),
                focusable: actions.has("key"),
                scrollable: false,
              };
              return [
                ref,
                {
                  backendNodeId,
                  frameId: this.mainFrameId,
                  generation,
                  actions,
                  fingerprint,
                  identity: `be:root:${this.mainFrameId}:${backendNodeId}`,
                } satisfies RefRecord,
              ];
            }),
          ),
        );
        return { type: "snapshot_result", commandId, tree, tabId: this.tabId, url };
      },
      deadlineAt,
    );
  }

  private semanticFailure(
    commandId: string,
    operation: ElementsResult["operation"],
    reason: ElementsFailureReason,
  ): ElementsResult {
    const retryable = new Set<ElementsFailureReason>([
      "capture_failed",
      "page_changed",
      "stale_ref",
      "target_changed",
      "frame_changed",
      "snapshot_expired",
      "cursor_expired",
    ]).has(reason);
    return {
      type: "elements_result",
      commandId,
      operation,
      status: "error",
      reason,
      retryable,
    };
  }

  private topologyKey(frames: readonly FrameTopologyEntry[]): string {
    return frames
      .map(
        (frame) =>
          `${frame.debuggerSessionId ?? "root"}:${frame.frameId}:${frame.parentFrameId ?? "-"}`,
      )
      .join("|");
  }

  private async captureFreshSemantic(
    scope: "viewport" | "document",
    view: "interactive" | "content" | "all",
    deadlineAt: number,
  ): Promise<{ cache: SemanticCache; previous: SemanticCache | null }> {
    const previous = this.semanticCache ?? this.deltaBaseline;
    const { captured, generation } = await this.captureStableSnapshot(
      deadlineAt,
      async () => {
        const identity = await this.mainFrameIdentity(deadlineAt);
        const frames = await this.refreshFrameTopology(deadlineAt);
        return captureSemanticPage({
          send: <R>(method: string, params: Record<string, unknown> | undefined, sessionId?: string) =>
            this.withSnapshotDeadline(deadlineAt, () =>
              this.sendInSession<R>(method, params, sessionId),
            ),
          frames,
          mainFrameId: identity.frameId,
          loaderId: identity.loaderId,
          url: identity.url,
        });
      },
      true,
    );
    const afterFrames = await this.refreshFrameTopology(deadlineAt);
    if (this.topologyKey(afterFrames) !== captured.topologyKey) {
      this.invalidateIncompleteSnapshot(generation);
      throw new SemanticCaptureError("page_changed");
    }
    const snapshot = {
      id: crypto.randomUUID(),
      generation,
      capturedAt: captured.capturedAt,
      scope,
      view,
      coverage: captured.coverage,
    } as const;
    const built = buildSemanticCache(
      captured,
      snapshot,
      a11yRefPrefix({ scopeId: this.refScopeId, generation }),
    );
    this.semanticCache = built.cache;
    this.deltaBaseline = built.cache;
    this.replaceRefMap(built.refMap);
    return { cache: built.cache, previous };
  }

  private randomCursorToken(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  private installCursor(cursor: ElementCursor): void {
    while (this.cursors.size >= MAX_ACTIVE_CURSORS) {
      const oldest = this.cursors.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.cursors.delete(oldest);
    }
    this.cursors.set(cursor.token, cursor);
  }

  private elementsPage(
    commandId: string,
    operation: ElementsResult["operation"],
    cache: SemanticCache,
    allElements: readonly ElementDescriptor[],
    pageSize: number,
    offset = 0,
    cursor?: ElementCursor,
    delta?: Extract<ElementsResult, { status: "ok" }>["delta"],
  ): ElementsResult {
    const available = Math.min(allElements.length, MAX_SEMANTIC_NODES);
    const boundedElements = allElements.slice(0, available);
    let returned = boundedElements.slice(
      offset,
      Math.min(offset + pageSize, offset + MAX_ELEMENT_DESCRIPTORS),
    );
    let token = cursor?.token;
    if (offset + returned.length < available && token === undefined) {
      token = this.randomCursorToken();
    }
    const build = (): ElementsResult => {
      const hasMore = offset + returned.length < available;
      return {
        type: "elements_result",
        commandId,
        operation,
        status: "ok",
        tabId: this.tabId,
        url: cache.url,
        snapshot: cache.snapshot,
        elements: returned,
        page: {
          returned: returned.length,
          available,
          hasMore,
          ...(hasMore && token !== undefined ? { cursor: token } : {}),
        },
        ...(delta === undefined ? {} : { delta }),
      };
    };
    let result = build();
    while (
      returned.length > 0 &&
      utf8ByteLength(JSON.stringify(result)) > ELEMENTS_RESULT_MAX_BYTES
    ) {
      returned = returned.slice(0, -1);
      result = build();
    }
    if (utf8ByteLength(JSON.stringify(result)) > ELEMENTS_RESULT_MAX_BYTES) {
      return this.semanticFailure(commandId, operation, "page_too_large");
    }

    const nextOffset = offset + returned.length;
    if (result.status === "ok" && result.page.hasMore && token !== undefined) {
      const nextCursor: ElementCursor = {
        token,
        snapshotId: cache.snapshot.id,
        generation: cache.snapshot.generation,
        elements: boundedElements,
        offset: nextOffset,
        pageSize,
        expiresAt: cursor?.expiresAt ?? Date.now() + CURSOR_TTL_MS,
      };
      if (cursor === undefined) this.installCursor(nextCursor);
      else this.cursors.set(token, nextCursor);
    } else if (token !== undefined) {
      this.cursors.delete(token);
    }
    return result;
  }

  captureElements(
    commandId: string,
    scope: "viewport" | "document",
    view: "interactive" | "content" | "all",
    limit: number,
    changesOnly: boolean,
  ): Promise<Event> {
    const deadlineAt = Date.now() + SNAPSHOT_DEADLINE_MS;
    return this.run(
      commandId,
      async () => {
        if (this.sensitiveOrigin !== null) {
          return this.semanticFailure(commandId, "snapshot", "sensitive_mode");
        }
        try {
          const { cache, previous } = await this.captureFreshSemantic(
            scope,
            view,
            deadlineAt,
          );
          if (
            changesOnly &&
            previous !== null &&
            previous.loaderId === cache.loaderId &&
            previous.url === cache.url &&
            previous.topologyKey === cache.topologyKey
          ) {
            const delta = deltaDescriptors(previous, cache);
            return this.elementsPage(
              commandId,
              "snapshot",
              cache,
              delta.elements,
              limit,
              0,
              undefined,
              {
                requested: true,
                applied: true,
                added: delta.added,
                changed: delta.changed,
                removed: delta.removed,
              },
            );
          }
          return this.elementsPage(
            commandId,
            "snapshot",
            cache,
            snapshotDescriptors(cache, scope, view),
            limit,
            0,
            undefined,
            changesOnly
              ? {
                  requested: true,
                  applied: false,
                  added: 0,
                  changed: 0,
                  removed: 0,
                }
              : undefined,
          );
        } catch (cause) {
          const reason =
            cause instanceof SemanticCaptureError
              ? cause.reason
              : errorMessage(cause).includes("page changed")
                ? "page_changed"
                : "capture_failed";
          return this.semanticFailure(commandId, "snapshot", reason);
        }
      },
      deadlineAt,
      "snapshot",
    );
  }

  findElements(
    commandId: string,
    query: string,
    roles: readonly string[],
    match: "contains" | "exact",
    includeHidden: boolean,
    limit: number,
  ): Promise<Event> {
    const deadlineAt = Date.now() + SNAPSHOT_DEADLINE_MS;
    return this.run(
      commandId,
      async () => {
        if (this.sensitiveOrigin !== null) {
          return this.semanticFailure(commandId, "find", "sensitive_mode");
        }
        try {
          const cache =
            this.semanticCache ??
            (await this.captureFreshSemantic("document", "all", deadlineAt)).cache;
          return this.elementsPage(
            commandId,
            "find",
            cache,
            findDescriptors(cache, { query, roles, match, includeHidden }),
            limit,
          );
        } catch (cause) {
          const reason =
            cause instanceof SemanticCaptureError
              ? cause.reason
              : errorMessage(cause).includes("page changed")
                ? "page_changed"
                : "capture_failed";
          return this.semanticFailure(commandId, "find", reason);
        }
      },
      deadlineAt,
      "find",
    );
  }

  inspectElements(
    commandId: string,
    ref: string,
    depth: number,
    limit: number,
    includeBounds: boolean,
  ): Promise<Event> {
    return this.run(
      commandId,
      async () => {
        if (this.sensitiveOrigin !== null) {
          return this.semanticFailure(commandId, "inspect", "sensitive_mode");
        }
        const cache = this.semanticCache;
        if (cache === null) {
          return this.semanticFailure(commandId, "inspect", "snapshot_expired");
        }
        const record = this.resolveRef(ref);
        if (record === null) {
          return this.semanticFailure(commandId, "inspect", "stale_ref");
        }
        const validation = await this.validateRef(record, "inspect", includeBounds);
        if (!validation.ok) {
          return this.semanticFailure(commandId, "inspect", validation.reason);
        }
        const target = cache.byIdentity.get(record.identity);
        if (target === undefined) {
          return this.semanticFailure(commandId, "inspect", "stale_ref");
        }
        return this.elementsPage(
          commandId,
          "inspect",
          cache,
          inspectDescriptors(cache, target, {
            depth,
            includeBounds,
            targetOverride: validation.descriptor,
            omitTargetFields: validation.omitFields,
          }),
          limit,
        );
      },
      undefined,
      "inspect",
    );
  }

  continueElements(commandId: string, token: string): Promise<Event> {
    return this.run(
      commandId,
      async () => {
        if (this.sensitiveOrigin !== null) {
          return this.semanticFailure(commandId, "next", "sensitive_mode");
        }
        if (!/^[0-9a-f]{32}$/.test(token)) {
          return this.semanticFailure(commandId, "next", "invalid_cursor");
        }
        const cache = this.semanticCache;
        if (cache === null) {
          return this.semanticFailure(commandId, "next", "snapshot_expired");
        }
        const cursor = this.cursors.get(token);
        if (cursor === undefined || cursor.expiresAt <= Date.now()) {
          this.cursors.delete(token);
          return this.semanticFailure(commandId, "next", "cursor_expired");
        }
        if (
          cache.snapshot.id !== cursor.snapshotId ||
          cache.snapshot.generation !== cursor.generation
        ) {
          this.cursors.delete(token);
          return this.semanticFailure(commandId, "next", "cursor_expired");
        }
        return this.elementsPage(
          commandId,
          "next",
          cache,
          cursor.elements,
          cursor.pageSize,
          cursor.offset,
          cursor,
        );
      },
      undefined,
      "next",
    );
  }

  private async validateRef(
    record: RefRecord,
    action: ElementAction,
    includeBounds = false,
    requireFocused = false,
  ): Promise<
    | {
        ok: true;
        descriptor: Partial<ElementDescriptor>;
        omitFields: Array<
          "name" | "description" | "states" | "form" | "range" | "bounds"
        >;
      }
    | { ok: false; reason: "target_changed" | "frame_changed" }
  > {
    const currentFailure = (): "target_changed" | "frame_changed" | undefined => {
      if (record.generation !== this.generation || !record.actions.has(action)) {
        return "target_changed";
      }
      const tracked = this.frameSessions.get(record.frameId);
      if (
        tracked === undefined ||
        (record.debuggerSessionId !== undefined &&
          (tracked.sessionId !== record.debuggerSessionId || tracked.ready !== true))
      ) {
        return "frame_changed";
      }
      return undefined;
    };
    const beforeFailure = currentFailure();
    if (beforeFailure !== undefined) return { ok: false, reason: beforeFailure };

    try {
      const [partial, described] = await Promise.all([
        this.sendInSession<Protocol.Accessibility.GetPartialAXTreeResponse>(
          "Accessibility.getPartialAXTree",
          { backendNodeId: record.backendNodeId, fetchRelatives: false },
          record.debuggerSessionId,
        ),
        this.sendInSession<Protocol.DOM.DescribeNodeResponse>(
          "DOM.describeNode",
          { backendNodeId: record.backendNodeId, depth: 0 },
          record.debuggerSessionId,
        ),
      ]);
      const ax =
        partial.nodes.find(
          (node) => node.backendDOMNodeId === record.backendNodeId,
        ) ?? partial.nodes[0];
      if (ax === undefined || ax.ignored) {
        return { ok: false, reason: "target_changed" };
      }
      const dom = allowlistedDomMetadata(described.node);
      const decoded = decodeAxNode(ax);
      const role = decoded.role ?? "unknown";
      const states = decoded.states;
      const actual: SemanticFingerprint = {
        role,
        ...(decoded.name === undefined ? {} : { name: decoded.name }),
        ...(decoded.description === undefined
          ? {}
          : { description: decoded.description }),
        ...(dom.tagName === undefined ? {} : { tagName: dom.tagName }),
        ...(dom.inputType === undefined ? {} : { inputType: dom.inputType }),
        domMetadataKnown: true,
        hidden: decoded.hidden === true,
        disabled: states?.disabled === true,
        readonly: states?.readonly === true,
        editable: decoded.editable,
        ...(states?.checked === undefined ? {} : { checked: states.checked }),
        ...(states?.selected === undefined ? {} : { selected: states.selected }),
        ...(states?.expanded === undefined ? {} : { expanded: states.expanded }),
        ...(states?.pressed === undefined ? {} : { pressed: states.pressed }),
        focusable: decoded.focusable === true,
        scrollable:
          dom.scrollable ||
          decoded.scrollable === true ||
          role === "scrollbar",
      };
      if (!fingerprintMatches(record.fingerprint, actual, action)) {
        return { ok: false, reason: "target_changed" };
      }
      if (
        actual.hidden ||
        ((action === "click" || action === "type" || action === "key") &&
          actual.disabled) ||
        (action === "type" && (actual.readonly || !actual.editable)) ||
        (action === "scroll" && !actual.scrollable)
      ) {
        return { ok: false, reason: "target_changed" };
      }
      if (requireFocused && states?.focused !== true) {
        return { ok: false, reason: "target_changed" };
      }

      const range = decoded.range;
      let bounds: ElementDescriptor["bounds"];
      if (
        includeBounds &&
        record.frameId === this.mainFrameId &&
        record.debuggerSessionId === undefined
      ) {
        const model = await this.sendInSession<Protocol.DOM.GetBoxModelResponse>(
          "DOM.getBoxModel",
          { backendNodeId: record.backendNodeId },
          record.debuggerSessionId,
        ).catch(() => undefined);
        bounds = model === undefined ? undefined : quadBounds(model.model.content);
      }
      const descriptor: Partial<ElementDescriptor> = {
        role: actual.role,
        ...(actual.name === undefined ? {} : { name: actual.name }),
        ...(actual.description === undefined
          ? {}
          : { description: actual.description }),
        ...(states === undefined ? {} : { states }),
        ...(range === undefined ? {} : { range }),
        ...(dom.inputType === undefined &&
        dom.placeholder === undefined &&
        dom.autocomplete === undefined
          ? {}
          : {
              form: {
                ...(dom.inputType === undefined ? {} : { inputType: dom.inputType }),
                ...(dom.placeholder === undefined
                  ? {}
                  : { placeholder: dom.placeholder }),
                ...(dom.autocomplete === undefined
                  ? {}
                  : { autocomplete: dom.autocomplete }),
              },
            }),
        ...(actual.hidden ? { visibility: "hidden" } : {}),
        ...(bounds === undefined ? {} : { bounds }),
      };
      const omitFields: Array<
        "name" | "description" | "states" | "form" | "range" | "bounds"
      > = [];
      if (actual.name === undefined) omitFields.push("name");
      if (actual.description === undefined) omitFields.push("description");
      if (states === undefined) omitFields.push("states");
      if (range === undefined) omitFields.push("range");
      if (
        dom.inputType === undefined &&
        dom.placeholder === undefined &&
        dom.autocomplete === undefined
      ) {
        omitFields.push("form");
      }
      if (includeBounds && bounds === undefined) omitFields.push("bounds");
      const afterFailure = currentFailure();
      if (afterFailure !== undefined) return { ok: false, reason: afterFailure };
      return { ok: true, descriptor, omitFields };
    } catch {
      const tracked = this.frameSessions.get(record.frameId);
      return record.debuggerSessionId !== undefined &&
        tracked?.sessionId !== record.debuggerSessionId
        ? { ok: false, reason: "frame_changed" }
        : { ok: false, reason: "target_changed" };
    }
  }

  // Pure ref-map lookup: MUST NOT snapshot or bump the generation. This is
  // the dry-run probe's truth source; taking a snapshot here would invalidate
  // the very ref being checked (and every other outstanding ref). Runs through
  // the FIFO queue so it observes any generation bump already in flight.
  resolveRefCheck(commandId: string, ref: string): Promise<Event> {
    return this.run(commandId, async () => {
      const record = this.resolveRef(ref);
      if (record === null) {
        return this.actionFailure(commandId, "stale_ref", true, true);
      }
      const validation = await this.validateRef(record, "inspect");
      if (!validation.ok) {
        return this.actionFailure(commandId, validation.reason, true, true);
      }
      return this.actionSuccess(commandId, false, false);
    });
  }

  screenshot(commandId: string): Promise<Event> {
    const deadlineAt = Date.now() + SNAPSHOT_DEADLINE_MS;
    return this.run(
      commandId,
      async () => {
        if (this.sensitiveOrigin !== null) {
          return this.actionFailure(commandId, "sensitive_mode", true, false);
        }
        const { captured, url } = await this.captureStableSnapshot(deadlineAt, () =>
          this.send<Protocol.Page.CaptureScreenshotResponse>(
            "Page.captureScreenshot",
            {
              format: "png",
            },
          ),
        );
        return {
          type: "screenshot_result",
          commandId,
          mime: "image/png",
          b64: captured.data,
          tabId: this.tabId,
          url,
        };
      },
      deadlineAt,
    );
  }

  click(commandId: string, ref: string): Promise<Event> {
    return this.run(commandId, async () => {
      const record = this.resolveRef(ref);
      if (record === null) {
        return this.actionFailure(commandId, "stale_ref", true, true);
      }
      const validation = await this.validateRef(record, "click");
      if (!validation.ok) {
        return this.actionFailure(commandId, validation.reason, true, true);
      }
      const point = await this.prepareClick(
        record.backendNodeId,
        record.debuggerSessionId,
      );
      const afterPointerMove = await this.validateRef(record, "click");
      if (!afterPointerMove.ok) {
        return this.actionFailure(
          commandId,
          afterPointerMove.reason,
          true,
          true,
        );
      }
      await this.dispatchPreparedClick(point, record.debuggerSessionId);
      return this.actionSuccess(commandId, false, true);
    });
  }

  type(commandId: string, ref: string, text: string, submit?: boolean): Promise<Event> {
    return this.run(commandId, async () => {
      const record = this.resolveRef(ref);
      if (record === null) {
        return this.actionFailure(commandId, "stale_ref", true, true);
      }
      const validation = await this.validateRef(record, "type");
      if (!validation.ok) {
        return this.actionFailure(commandId, validation.reason, true, true);
      }
      await this.focus(record.backendNodeId, record.debuggerSessionId);
      const afterFocus = await this.validateRef(record, "type", false, true);
      if (!afterFocus.ok) {
        return this.actionFailure(commandId, afterFocus.reason, true, true);
      }
      await this.sendInSession(
        "Input.insertText",
        { text },
        record.debuggerSessionId,
      );
      if (submit === true) {
        const beforeSubmit = await this.validateRef(record, "type", false, true);
        if (!beforeSubmit.ok) {
          return this.actionFailure(commandId, beforeSubmit.reason, true, true);
        }
        await this.dispatchKey(parseKeys("Enter"), record.debuggerSessionId);
      }
      return this.actionSuccess(commandId, false, submit === true);
    });
  }

  key(commandId: string, keys: string, ref?: string): Promise<Event> {
    return this.run(commandId, async () => {
      const parsed = parseKeys(keys);
      let debuggerSessionId: string | undefined;
      if (ref !== undefined) {
        const record = this.resolveRef(ref);
        if (record === null) {
          return this.actionFailure(commandId, "stale_ref", true, true);
        }
        const validation = await this.validateRef(record, "key");
        if (!validation.ok) {
          return this.actionFailure(commandId, validation.reason, true, true);
        }
        debuggerSessionId = record.debuggerSessionId;
        await this.sendInSession(
          "DOM.focus",
          { backendNodeId: record.backendNodeId },
          debuggerSessionId,
        );
        const afterFocus = await this.validateRef(record, "key", false, true);
        if (!afterFocus.ok) {
          return this.actionFailure(commandId, afterFocus.reason, true, true);
        }
      }
      await this.dispatchKey(parsed, debuggerSessionId);
      return this.actionSuccess(commandId, false, parsed.key === "Enter");
    });
  }

  scroll(commandId: string, dy: number, ref?: string): Promise<Event> {
    return this.run(commandId, async () => {
      if (ref === undefined) {
        const metrics = await this.send<Protocol.Page.GetLayoutMetricsResponse>(
          "Page.getLayoutMetrics",
        );
        const viewport = metrics.cssVisualViewport ?? metrics.cssLayoutViewport;
        await this.send("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: viewport.clientWidth / 2,
          y: viewport.clientHeight / 2,
          deltaX: 0,
          deltaY: dy,
        });
      } else {
        const record = this.resolveRef(ref);
        if (record === null) {
          return this.actionFailure(commandId, "stale_ref", true, true);
        }
        const validation = await this.validateRef(record, "scroll");
        if (!validation.ok) {
          return this.actionFailure(commandId, validation.reason, true, true);
        }
        const { model } = await this.sendInSession<Protocol.DOM.GetBoxModelResponse>(
          "DOM.getBoxModel",
          { backendNodeId: record.backendNodeId },
          record.debuggerSessionId,
        );
        const { x, y } = quadCenter(model.content);
        const beforeDispatch = await this.validateRef(record, "scroll");
        if (!beforeDispatch.ok) {
          return this.actionFailure(commandId, beforeDispatch.reason, true, true);
        }
        await this.sendInSession("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x,
          y,
          deltaX: 0,
          deltaY: dy,
        }, record.debuggerSessionId);
      }
      return this.actionSuccess(commandId, false, false);
    });
  }

  wait(commandId: string, waitFor: WaitFor, value?: number): Promise<Event> {
    return this.run(commandId, async () => {
      if (waitFor === "ms") {
        await delay(value ?? 0);
      } else if (waitFor === "load") {
        await this.waitForLoad(LOAD_TIMEOUT_MS);
      } else {
        await this.waitForLoad(LOAD_TIMEOUT_MS);
        await delay(IDLE_QUIET_MS);
      }
      return this.actionSuccess(commandId, false, false, this.currentUrl);
    });
  }

  navigate(commandId: string, url: string): Promise<Event> {
    return this.run(commandId, async () => {
      if (!this.isAllowedTopLevelUrl(url)) {
        return this.actionFailure(commandId, "navigation_blocked", true, false);
      }
      await this.bumpGeneration();
      this.markLoadStarted();
      const res = await this.send<Protocol.Page.NavigateResponse>("Page.navigate", { url });
      if (res.errorText !== undefined) {
        this.loadInFlight = false;
        return this.actionFailure(commandId, "action_failed", true, true);
      }
      await this.waitForLoad(LOAD_TIMEOUT_MS);
      return this.actionSuccess(commandId, true, true, this.currentUrl);
    });
  }
}
