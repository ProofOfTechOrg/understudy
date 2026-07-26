import type { TabInfo } from "@understudy/protocol";
import type { Browser } from "wxt/browser";
import {
  SessionRuntime,
  type CleanupIntent,
  type ManagedAssignment,
  type RuntimeAssignment,
  type RuntimeHost,
} from "./session-runtime";

const MANAGER_STATE_KEY = "understudy:assignments";
const CAPACITY = 2;
const SERVER_RECORD_CAP = 100;

export interface ProvisionInput {
  sessionId: string;
  leaseId: string;
  leaseEpoch: number;
  browserEpoch: string;
  allowedOrigins: string[];
  sessionTicket: string;
}

export type ClosureRecord = Pick<
  RuntimeAssignment,
  "sessionId" | "leaseId" | "leaseEpoch" | "browserEpoch"
>;

interface PersistedManagerState {
  version: 3;
  assignments: ManagedAssignment[];
  closedOutbox: ClosureRecord[];
  vacatedLeases: ClosureRecord[];
}

export class SessionManager implements RuntimeHost {
  private readonly bySession = new Map<string, SessionRuntime>();
  private readonly byLease = new Map<string, SessionRuntime>();
  private readonly byTab = new Map<number, SessionRuntime>();
  private closedOutbox: ClosureRecord[] = [];
  private vacated: ClosureRecord[] = [];
  private persistTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly getServiceOrigin: () => string,
    private readonly getBrowserEpoch: () => string,
  ) {}

  serviceOrigin(): string {
    return this.getServiceOrigin();
  }

  browserEpoch(): string {
    return this.getBrowserEpoch();
  }

  isCurrent(runtime: SessionRuntime): boolean {
    return (
      runtime.assignment.browserEpoch === this.browserEpoch() &&
      this.bySession.get(runtime.sessionId) === runtime &&
      this.byLease.get(runtime.leaseId) === runtime &&
      this.byTab.get(runtime.tabId) === runtime
    );
  }

  async provision(
    input: ProvisionInput,
    isCurrent: () => boolean = () => true,
  ): Promise<TabInfo> {
    if (!isCurrent()) throw new StaleProvisionError();
    const existing = this.byLease.get(input.leaseId);
    if (existing !== undefined) {
      if (
        existing.sessionId !== input.sessionId ||
        existing.assignment.leaseEpoch !== input.leaseEpoch ||
        existing.assignment.browserEpoch !== input.browserEpoch
      ) {
        throw new Error("lease assignment conflict");
      }
      const tab = await this.tabInfo(existing.tabId);
      if (!isCurrent()) {
        await this.cleanup(existing, "release");
        throw new StaleProvisionError();
      }
      existing.connect(input.sessionTicket);
      return tab;
    }
    const vacated = this.vacated.find(
      (entry) => entry.leaseId === input.leaseId,
    );
    if (vacated !== undefined && !sameClosure(vacated, input)) {
      throw new Error("vacated lease assignment conflict");
    }
    if (input.browserEpoch !== this.browserEpoch()) {
      throw new Error("browser epoch mismatch");
    }
    if (this.byLease.size >= CAPACITY) {
      throw new Error("controlled-tab capacity exhausted");
    }

    const createdWindow = await browser.windows.create({
      focused: false,
      type: "normal",
      url: "about:blank",
    });
    const tab = createdWindow?.tabs?.[0];
    if (createdWindow?.id === undefined || tab?.id === undefined) {
      throw new Error("Chrome did not return the extension-owned automation tab");
    }
    const assignment: ManagedAssignment = {
      sessionId: input.sessionId,
      leaseId: input.leaseId,
      leaseEpoch: input.leaseEpoch,
      browserEpoch: input.browserEpoch,
      allowedOrigins: input.allowedOrigins,
      tabId: tab.id,
      windowId: createdWindow.id,
    };
    const runtime = new SessionRuntime(assignment, this);
    this.install(runtime);
    await this.persist();
    if (!isCurrent()) {
      await this.cleanup(runtime, "release");
      throw new StaleProvisionError();
    }

    try {
      await runtime.attach();
      if (!isCurrent()) {
        await this.cleanup(runtime, "release");
        throw new StaleProvisionError();
      }
      const info = await this.tabInfo(runtime.tabId);
      if (!isCurrent()) {
        await this.cleanup(runtime, "release");
        throw new StaleProvisionError();
      }
      runtime.connect(input.sessionTicket);
      if (vacated !== undefined) {
        await this.consumeVacated(vacated);
        if (!isCurrent()) {
          await this.cleanup(runtime, "release");
          throw new StaleProvisionError();
        }
      }
      return info;
    } catch (error) {
      if (this.isCurrent(runtime) && runtime.assignment.cleanupIntent === undefined) {
        await this.cleanup(
          runtime,
          error instanceof StaleProvisionError ? "release" : "discard",
        );
      }
      throw error;
    }
  }

  connectSessionTicket(input: {
    sessionId: string;
    leaseId: string;
    leaseEpoch: number;
    browserEpoch: string;
    sessionTicket: string;
  }): boolean {
    const runtime = this.byLease.get(input.leaseId);
    if (
      runtime === undefined ||
      runtime.sessionId !== input.sessionId ||
      runtime.assignment.leaseEpoch !== input.leaseEpoch ||
      runtime.assignment.browserEpoch !== input.browserEpoch ||
      runtime.assignment.cleanupIntent !== undefined
    ) {
      return false;
    }
    try {
      runtime.connect(input.sessionTicket);
      return true;
    } catch {
      return false;
    }
  }

  async closeLease(
    input: ClosureRecord,
    intent: CleanupIntent = "release",
  ): Promise<boolean> {
    const runtime = this.byLease.get(input.leaseId);
    if (
      runtime === undefined ||
      runtime.sessionId !== input.sessionId ||
      runtime.assignment.leaseEpoch !== input.leaseEpoch ||
      runtime.assignment.browserEpoch !== input.browserEpoch
    ) {
      const vacated = this.vacated.find((entry) => sameClosure(entry, input));
      if (vacated !== undefined) {
        const previousOutbox = [...this.closedOutbox];
        const previousVacated = this.vacated;
        if (intent === "release") {
          this.enqueueClosure(vacated);
        }
        this.vacated = this.vacated.filter(
          (entry) => !sameClosure(entry, vacated),
        );
        try {
          await this.persist();
        } catch (error) {
          this.closedOutbox = previousOutbox;
          this.vacated = previousVacated;
          throw error;
        }
        return true;
      }
      return intent === "release" && this.hasOutboxEntry(input);
    }
    return this.cleanup(runtime, intent);
  }

  async restoreSameEpoch(
    unreconciledIntent: CleanupIntent = "recover",
  ): Promise<void> {
    const stored = await browser.storage.session.get(MANAGER_STATE_KEY);
    const persisted = parseManagerState(stored[MANAGER_STATE_KEY]);
    this.closedOutbox = persisted.closedOutbox;
    this.vacated = persisted.vacatedLeases;
    if (unreconciledIntent === "release") {
      this.promoteVacatedLeases();
    } else if (unreconciledIntent === "discard") {
      this.closedOutbox = [];
      this.vacated = [];
    }
    const targets = await browser.debugger.getTargets();
    for (const raw of persisted.assignments) {
      if (raw.browserEpoch !== this.browserEpoch()) continue;
      const runtime = new SessionRuntime({ ...raw }, this);
      this.install(runtime);
      if (runtime.assignment.cleanupIntent !== undefined) {
        if (
          unreconciledIntent === "discard" ||
          (unreconciledIntent === "release" &&
            runtime.assignment.cleanupIntent === "recover")
        ) {
          runtime.beginCleanup(unreconciledIntent);
        }
        continue;
      }
      const target = targets.find((candidate) => candidate.tabId === raw.tabId);
      if (target?.attached !== true) {
        runtime.beginCleanup(unreconciledIntent);
        continue;
      }
      try {
        await runtime.reconcileSameEpoch();
      } catch {
        runtime.beginCleanup(unreconciledIntent);
      }
    }
    await this.persist();
    await this.retryCleanup();
  }

  async retryCleanup(): Promise<void> {
    for (const runtime of [...this.byLease.values()]) {
      const intent = runtime.assignment.cleanupIntent;
      if (intent !== undefined) await this.cleanup(runtime, intent);
    }
  }

  async onCdpEvent(
    source: { tabId?: number },
    method: string,
    params: unknown,
  ): Promise<void> {
    if (source.tabId === undefined) return;
    const runtime = this.byTab.get(source.tabId);
    if (runtime === undefined) return;
    await runtime.onCdpEvent(method, params);
  }

  async onDebuggerDetach(source: { tabId?: number }): Promise<void> {
    if (source.tabId === undefined) return;
    const runtime = this.byTab.get(source.tabId);
    if (runtime === undefined) return;
    await runtime.onDebuggerDetach();
  }

  async closeRelatedPopup(tab: Browser.tabs.Tab): Promise<void> {
    if (
      tab.id !== undefined &&
      tab.openerTabId !== undefined &&
      this.byTab.has(tab.openerTabId) &&
      !this.byTab.has(tab.id)
    ) {
      await browser.tabs.remove(tab.id).catch(() => {});
    }
  }

  async stopAll(intent: CleanupIntent = "release"): Promise<void> {
    if (intent === "release") {
      const previousOutbox = [...this.closedOutbox];
      const previousVacated = this.vacated;
      try {
        this.promoteVacatedLeases();
        await this.persist();
      } catch (error) {
        this.closedOutbox = previousOutbox;
        this.vacated = previousVacated;
        throw error;
      }
    } else if (intent === "discard") {
      this.closedOutbox = [];
      this.vacated = [];
      await this.persist();
    }
    for (const runtime of [...this.byLease.values()]) {
      await this.cleanup(runtime, intent);
    }
  }

  assignments(): ManagedAssignment[] {
    return [...this.byLease.values()].map((runtime) => ({
      ...runtime.assignment,
      allowedOrigins: [...runtime.assignment.allowedOrigins],
    }));
  }

  pendingCleanup(): boolean {
    return [...this.byLease.values()].some(
      (runtime) => runtime.assignment.cleanupIntent !== undefined,
    );
  }

  pendingReleaseCleanup(): boolean {
    return [...this.byLease.values()].some(
      (runtime) => runtime.assignment.cleanupIntent === "release",
    );
  }

  closureOutbox(): ClosureRecord[] {
    return this.closedOutbox.map((entry) => ({ ...entry }));
  }

  vacatedLeases(): ClosureRecord[] {
    return this.vacated.map((entry) => ({ ...entry }));
  }

  async acknowledgeClosure(entry: ClosureRecord): Promise<void> {
    const previous = this.closedOutbox;
    this.closedOutbox = previous.filter(
      (candidate) => !sameClosure(candidate, entry),
    );
    try {
      await this.persist();
    } catch (error) {
      this.closedOutbox = previous;
      throw error;
    }
  }

  async discardServerState(): Promise<void> {
    if (this.closedOutbox.length === 0 && this.vacated.length === 0) return;
    const previousOutbox = this.closedOutbox;
    const previousVacated = this.vacated;
    this.closedOutbox = [];
    this.vacated = [];
    try {
      await this.persist();
    } catch (error) {
      this.closedOutbox = previousOutbox;
      this.vacated = previousVacated;
      throw error;
    }
  }

  async onFenced(runtime: SessionRuntime): Promise<void> {
    if (!this.isCurrent(runtime)) return;
    await this.cleanup(runtime, "recover");
  }

  async onTabChanged(_runtime: SessionRuntime): Promise<void> {
    // URLs and titles are intentionally not persisted.
  }

  private install(runtime: SessionRuntime): void {
    this.bySession.set(runtime.sessionId, runtime);
    this.byLease.set(runtime.leaseId, runtime);
    this.byTab.set(runtime.tabId, runtime);
  }

  private uninstall(runtime: SessionRuntime): void {
    if (this.bySession.get(runtime.sessionId) === runtime) {
      this.bySession.delete(runtime.sessionId);
    }
    if (this.byLease.get(runtime.leaseId) === runtime) {
      this.byLease.delete(runtime.leaseId);
    }
    if (this.byTab.get(runtime.tabId) === runtime) {
      this.byTab.delete(runtime.tabId);
    }
  }

  private async cleanup(
    runtime: SessionRuntime,
    intent: CleanupIntent,
  ): Promise<boolean> {
    if (!this.isCurrent(runtime)) return false;
    runtime.beginCleanup(intent);
    await this.persist();
    if (!(await runtime.close(true))) {
      await this.persist();
      return false;
    }
    if (runtime.assignment.cleanupIntent === "release") {
      this.enqueueClosure(runtime.assignment);
    } else if (runtime.assignment.cleanupIntent === "recover") {
      this.enqueueVacated(runtime.assignment);
    }
    this.uninstall(runtime);
    await this.persist();
    return true;
  }

  private enqueueClosure(assignment: ClosureRecord): void {
    const entry: ClosureRecord = {
      sessionId: assignment.sessionId,
      leaseId: assignment.leaseId,
      leaseEpoch: assignment.leaseEpoch,
      browserEpoch: assignment.browserEpoch,
    };
    if (this.hasOutboxEntry(entry)) return;
    if (this.closedOutbox.length >= SERVER_RECORD_CAP) {
      throw new Error("closure outbox capacity exhausted");
    }
    this.closedOutbox.push(entry);
  }

  private enqueueVacated(assignment: ClosureRecord): void {
    const entry: ClosureRecord = {
      sessionId: assignment.sessionId,
      leaseId: assignment.leaseId,
      leaseEpoch: assignment.leaseEpoch,
      browserEpoch: assignment.browserEpoch,
    };
    if (this.vacated.some((candidate) => sameClosure(candidate, entry))) return;
    if (this.vacated.length >= SERVER_RECORD_CAP) {
      throw new Error("vacated lease capacity exhausted");
    }
    this.vacated.push(entry);
  }

  private promoteVacatedLeases(): void {
    for (const entry of this.vacated) this.enqueueClosure(entry);
    this.vacated = [];
  }

  private async consumeVacated(entry: ClosureRecord): Promise<void> {
    const previous = this.vacated;
    this.vacated = previous.filter(
      (candidate) => !sameClosure(candidate, entry),
    );
    try {
      await this.persist();
    } catch (error) {
      this.vacated = previous;
      throw error;
    }
  }

  private hasOutboxEntry(entry: ClosureRecord): boolean {
    return this.closedOutbox.some((candidate) => sameClosure(candidate, entry));
  }

  private async persist(): Promise<void> {
    const write = this.persistTail.then(async () => {
      const state: PersistedManagerState = {
        version: 3,
        assignments: this.assignments(),
        closedOutbox: this.closureOutbox(),
        vacatedLeases: this.vacatedLeases(),
      };
      await browser.storage.session.set({ [MANAGER_STATE_KEY]: state });
    });
    this.persistTail = write.catch(() => {});
    await write;
  }

  private async tabInfo(tabId: number): Promise<TabInfo> {
    const tab = await browser.tabs.get(tabId);
    return {
      tabId,
      url: tab.url ?? "about:blank",
      title: tab.title ?? "",
      active: tab.active,
    };
  }
}

export class StaleProvisionError extends Error {
  constructor() {
    super("provisioning was superseded");
  }
}

function parseManagerState(value: unknown): PersistedManagerState {
  if (Array.isArray(value)) {
    return {
      version: 3,
      assignments: value.filter(isManagedAssignment),
      closedOutbox: [],
      vacatedLeases: [],
    };
  }
  if (typeof value !== "object" || value === null) return emptyManagerState();
  const candidate = value as {
    version?: unknown;
    assignments?: unknown;
    closedOutbox?: unknown;
    vacatedLeases?: unknown;
  };
  if (
    candidate.version === 2 &&
    Array.isArray(candidate.assignments) &&
    Array.isArray(candidate.closedOutbox)
  ) {
    return {
      version: 3,
      assignments: candidate.assignments.filter(isManagedAssignment),
      closedOutbox: candidate.closedOutbox.filter(isClosureRecord),
      vacatedLeases: [],
    };
  }
  if (
    candidate.version !== 3 ||
    !Array.isArray(candidate.assignments) ||
    !Array.isArray(candidate.closedOutbox) ||
    !Array.isArray(candidate.vacatedLeases)
  ) {
    return emptyManagerState();
  }
  return {
    version: 3,
    assignments: candidate.assignments.filter(isManagedAssignment),
    closedOutbox: candidate.closedOutbox.filter(isClosureRecord),
    vacatedLeases: candidate.vacatedLeases.filter(isClosureRecord),
  };
}

function emptyManagerState(): PersistedManagerState {
  return {
    version: 3,
    assignments: [],
    closedOutbox: [],
    vacatedLeases: [],
  };
}

function isManagedAssignment(value: unknown): value is ManagedAssignment {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Partial<ManagedAssignment>;
  return (
    typeof item.sessionId === "string" &&
    typeof item.leaseId === "string" &&
    typeof item.leaseEpoch === "number" &&
    typeof item.browserEpoch === "string" &&
    Array.isArray(item.allowedOrigins) &&
    item.allowedOrigins.every((origin) => typeof origin === "string") &&
    typeof item.tabId === "number" &&
    typeof item.windowId === "number" &&
    (item.cleanupIntent === undefined ||
      item.cleanupIntent === "recover" ||
      item.cleanupIntent === "release" ||
      item.cleanupIntent === "discard")
  );
}

function isClosureRecord(value: unknown): value is ClosureRecord {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Partial<ClosureRecord>;
  return (
    typeof item.sessionId === "string" &&
    typeof item.leaseId === "string" &&
    typeof item.leaseEpoch === "number" &&
    typeof item.browserEpoch === "string"
  );
}

function sameClosure(left: ClosureRecord, right: ClosureRecord): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.leaseId === right.leaseId &&
    left.leaseEpoch === right.leaseEpoch &&
    left.browserEpoch === right.browserEpoch
  );
}
