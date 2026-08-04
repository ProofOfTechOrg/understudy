import type { AssignmentInventory, OwnedWindow, TabInfo } from "@understudy/protocol";
import type { Browser } from "wxt/browser";
import { controlledTabInfo } from "../tabs";
import { CardVault } from "../payment/card-vault";
import { IndexedDbCardVaultStore } from "../payment/indexeddb-card-store";
import {
  ownedWindowBootstrapUrl,
  ownedWindowFromBootstrapUrl,
} from "./owned-window-marker";
import {
  SessionRuntime,
  type CleanupIntent,
  type ManagedAssignment,
  type RuntimeAssignment,
  type RuntimeHost,
} from "./session-runtime";
import { closeWindowAndConfirm } from "./window-lifecycle";

const MANAGER_STATE_KEY = "understudy:assignments";
const DURABLE_MANAGER_RECOVERY_KEY = "understudy:durableManagerRecovery";
const CAPACITY = 2;
const SERVER_RECORD_CAP = 100;

export interface ProvisionInput {
  sessionId: string;
  leaseId: string;
  leaseEpoch: number;
  browserEpoch: string;
  allowedOrigins: string[];
  policyVersion: number;
  sessionTicket: string;
}

export type ClosureRecord = Pick<
  RuntimeAssignment,
  "sessionId" | "leaseId" | "leaseEpoch" | "browserEpoch"
>;

class OwnedWindowCheckpointError extends Error {
  constructor(readonly cause: unknown) {
    super("could not checkpoint the extension-owned automation window");
  }
}

interface PersistedManagerState {
  version: 4;
  assignments: ManagedAssignment[];
  ownedWindows: OwnedWindow[];
  closedOutbox: ClosureRecord[];
  vacatedLeases: ClosureRecord[];
}

interface ProvisionReservation {
  input: ProvisionInput;
}

type ProvisionAdmission =
  | { existing: SessionRuntime; reservation?: never }
  | { existing?: never; reservation: ProvisionReservation };

interface ManagerMutationSnapshot {
  bySession: Map<string, SessionRuntime>;
  byLease: Map<string, SessionRuntime>;
  byTab: Map<number, SessionRuntime>;
  pendingProvisions: Map<string, ProvisionReservation>;
  ownedWindows: OwnedWindow[];
  closedOutbox: ClosureRecord[];
  vacated: ClosureRecord[];
  runtimeAssignments: Map<SessionRuntime, ManagedAssignment>;
}

export class SessionManager implements RuntimeHost {
  private readonly bySession = new Map<string, SessionRuntime>();
  private readonly byLease = new Map<string, SessionRuntime>();
  private readonly byTab = new Map<number, SessionRuntime>();
  private readonly pendingProvisions = new Map<string, ProvisionReservation>();
  private ownedWindowRegistry: OwnedWindow[] = [];
  private closedOutbox: ClosureRecord[] = [];
  private vacated: ClosureRecord[] = [];
  private persistTail: Promise<void> = Promise.resolve();
  private mutationTail: Promise<void> = Promise.resolve();
  private readonly cards = new CardVault(new IndexedDbCardVaultStore());

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

  paymentVault(): CardVault {
    return this.cards;
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
    const admission = await this.reserveProvision(input, isCurrent);
    const existing = admission.existing;
    if (existing !== undefined) {
      const tab = await this.tabInfo(existing.tabId);
      if (!isCurrent() || !this.isCurrent(existing)) {
        await this.cleanup(existing, "release");
        throw new StaleProvisionError();
      }
      existing.connect(input.sessionTicket);
      return tab;
    }
    const reservation = admission.reservation;
    let ownedWindow: OwnedWindow | undefined;
    let ownedWindowCheckpointed = false;
    let runtime: SessionRuntime | undefined;
    let provisionClosureRecorded = false;
    try {
      const bootstrapUrl = ownedWindowBootstrapUrl(
        browser.runtime.getURL("/"),
        input,
      );
      const createdWindow = await browser.windows.create({
        focused: false,
        type: "normal",
        url: bootstrapUrl,
      });
      if (createdWindow?.id === undefined) {
        throw new Error("Chrome did not return the extension-owned automation tab");
      }
      const tab = createdWindow.tabs?.[0];
      ownedWindow = {
        sessionId: input.sessionId,
        leaseId: input.leaseId,
        leaseEpoch: input.leaseEpoch,
        browserEpoch: input.browserEpoch,
        tabId: tab?.id ?? null,
        windowId: createdWindow.id,
      };
      await this.registerOwnedWindow(ownedWindow);
      ownedWindowCheckpointed = true;
      if (tab?.id === undefined) {
        provisionClosureRecorded = await this.closeRegisteredWindow(ownedWindow);
        throw new Error("Chrome did not return the extension-owned automation tab");
      }
      await browser.tabs.update(tab.id, { url: "about:blank" });
      const assignment: ManagedAssignment = {
        sessionId: input.sessionId,
        leaseId: input.leaseId,
        leaseEpoch: input.leaseEpoch,
        browserEpoch: input.browserEpoch,
        allowedOrigins: [...input.allowedOrigins],
        policyVersion: input.policyVersion,
        tabId: tab.id,
        windowId: createdWindow.id,
      };
      runtime = new SessionRuntime(assignment, this);
      await this.commitProvision(reservation, runtime, isCurrent);
      if (!isCurrent()) {
        await this.cleanup(runtime, "release");
        throw new StaleProvisionError();
      }
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
      const vacated = this.vacated.find((entry) => sameClosure(entry, input));
      if (vacated !== undefined) {
        await this.consumeVacatedSerialized(vacated);
        if (!isCurrent()) {
          await this.cleanup(runtime, "release");
          throw new StaleProvisionError();
        }
      }
      return info;
    } catch (error) {
      if (
        runtime !== undefined &&
        this.isCurrent(runtime) &&
        runtime.assignment.cleanupIntent === undefined
      ) {
        await this.cleanup(
          runtime,
          "release",
        );
      } else if (
        ownedWindow !== undefined &&
        ownedWindowCheckpointed &&
        !provisionClosureRecorded
      ) {
        await this.closeRegisteredWindow(ownedWindow);
      } else if (ownedWindow === undefined && !provisionClosureRecorded) {
        await this.recordProvisionClosure(input);
      }
      throw error;
    } finally {
      await this.releaseProvisionReservation(reservation);
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
        await this.mutateAndPersist(() => {
          const current = this.vacated.find((entry) => sameClosure(entry, input));
          if (current === undefined) return false;
          if (intent === "release") this.enqueueClosure(current);
          this.vacated = this.vacated.filter(
            (entry) => !sameClosure(entry, current),
          );
          return true;
        }, Boolean);
        return true;
      }
      return intent === "release" && this.hasOutboxEntry(input);
    }
    return this.cleanup(runtime, intent);
  }

  async restoreSameEpoch(
    unreconciledIntent: CleanupIntent = "recover",
  ): Promise<void> {
    const [sessionStored, durableStored] = await Promise.all([
      browser.storage.session.get(MANAGER_STATE_KEY),
      browser.storage.local.get(DURABLE_MANAGER_RECOVERY_KEY),
    ]);
    const durableValue = durableStored[DURABLE_MANAGER_RECOVERY_KEY];
    const persisted = parseManagerState(
      durableValue === undefined ? sessionStored[MANAGER_STATE_KEY] : durableValue,
    );
    const discovered = await this.discoverBootstrapWindows();
    this.ownedWindowRegistry = dedupeOwnedWindows(
      [...persisted.ownedWindows, ...discovered],
    );
    this.closedOutbox = persisted.closedOutbox;
    this.vacated = persisted.vacatedLeases;
    if (unreconciledIntent === "release") {
      this.promoteVacatedLeases();
    } else if (unreconciledIntent === "discard") {
      this.closedOutbox = [];
      this.vacated = [];
    }
    const currentAssignments = persisted.assignments.filter(
      (assignment) => assignment.browserEpoch === this.browserEpoch(),
    );
    const restored: SessionRuntime[] = [];
    for (const raw of currentAssignments) {
      if (!this.ownedWindowRegistry.some((owned) => sameOwnedWindow(raw, owned))) continue;
      const runtime = new SessionRuntime({ ...raw }, this);
      this.install(runtime);
      if (raw.sensitive === true) runtime.beginCleanup("release");
      restored.push(runtime);
    }
    // Checkpoint discovered markers before physical cleanup. If the worker is
    // terminated after Chrome closes a window, the next wake can still finish
    // the exact closure outbox transition from this registry entry. Restored
    // assignments are installed first so this checkpoint cannot erase them.
    await this.persist();
    for (const owned of [...this.ownedWindowRegistry]) {
      if (currentAssignments.some((assignment) => sameOwnedWindow(assignment, owned))) continue;
      await this.closeRegisteredWindow(owned);
    }
    if (
      unreconciledIntent === "release" ||
      unreconciledIntent === "discard"
    ) {
      for (const runtime of restored) {
        runtime.beginCleanup(unreconciledIntent);
      }
      await this.persist();
      await this.retryCleanup();
      return;
    }

    for (const runtime of restored) {
      if (runtime.assignment.cleanupIntent !== undefined) {
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
    for (const owned of [...this.ownedWindowRegistry]) {
      const runtime = this.byLease.get(owned.leaseId);
      const pending = this.pendingProvisions.get(owned.leaseId);
      if (pending !== undefined && sameClosure(pending.input, owned)) continue;
      if (runtime === undefined || !sameOwnedWindow(runtime.assignment, owned)) {
        await this.closeRegisteredWindow(owned);
      }
    }
    for (const runtime of [...this.byLease.values()]) {
      const intent = runtime.assignment.cleanupIntent;
      if (intent !== undefined) await this.cleanup(runtime, intent);
    }
  }

  async onCdpEvent(
    source: Browser.debugger.DebuggerSession,
    method: string,
    params: unknown,
  ): Promise<void> {
    if (source.tabId === undefined) return;
    const runtime = this.byTab.get(source.tabId);
    if (runtime === undefined) return;
    await runtime.onCdpEvent(source, method, params);
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
    this.beginStopAll(intent);
    if (intent === "release") {
      await this.mutateAndPersist(() => this.promoteVacatedLeases());
    } else if (intent === "discard") {
      await this.mutateAndPersist(() => {
        this.closedOutbox = [];
        this.vacated = [];
      });
    }
    for (const runtime of [...this.byLease.values()]) {
      await this.cleanup(runtime, intent);
    }
  }

  beginStopAll(intent: CleanupIntent): void {
    for (const runtime of [...this.byLease.values()]) {
      runtime.beginCleanup(intent);
    }
  }

  assignments(): ManagedAssignment[] {
    return [...this.byLease.values()].map((runtime) => ({
      ...runtime.assignment,
      allowedOrigins: [...runtime.assignment.allowedOrigins],
    }));
  }

  inventory(): AssignmentInventory[] {
    return this.assignments().map((assignment) => ({
      sessionId: assignment.sessionId,
      leaseId: assignment.leaseId,
      leaseEpoch: assignment.leaseEpoch,
      browserEpoch: assignment.browserEpoch,
      tabId: assignment.tabId,
      windowId: assignment.windowId,
    }));
  }

  ownedWindows(): OwnedWindow[] {
    return this.ownedWindowRegistry.map((owned) => ({ ...owned }));
  }

  controlInventory(): {
    assignments: AssignmentInventory[];
    ownedWindows: OwnedWindow[];
  } | null {
    if ([...this.byLease.values()].some((runtime) => runtime.assignment.sensitive === true)) {
      return null;
    }
    return {
      assignments: this.inventory(),
      ownedWindows: this.ownedWindows(),
    };
  }

  async applyPolicy(
    policyVersion: number,
    allowedOrigins: string[],
  ): Promise<void> {
    const allowed = new Set(allowedOrigins);
    for (const runtime of [...this.byLease.values()]) {
      if (!runtime.assignment.allowedOrigins.every((origin) => allowed.has(origin))) {
        await this.cleanup(runtime, "release");
        continue;
      }
    }
    await this.mutateAndPersist(() => {
      for (const runtime of [...this.byLease.values()]) {
        if (runtime.assignment.cleanupIntent === undefined) {
          runtime.assignment.policyVersion = policyVersion;
        }
      }
    });
  }

  async closeOrphan(orphan: OwnedWindow): Promise<boolean> {
    const owned = this.ownedWindowRegistry.find((entry) => sameOwnedWindow(entry, orphan));
    if (owned === undefined) return false;
    const runtime = this.byLease.get(owned.leaseId);
    if (runtime !== undefined && sameOwnedWindow(runtime.assignment, owned)) {
      return this.cleanup(runtime, "release");
    }
    return this.closeRegisteredWindow(owned);
  }

  pendingCleanup(): boolean {
    return (
      this.pendingProvisions.size > 0 ||
      this.ownedWindowRegistry.some((owned) => {
        const runtime = this.byLease.get(owned.leaseId);
        return runtime === undefined || !sameOwnedWindow(runtime.assignment, owned);
      }) ||
      this.closedOutbox.length > 0 ||
      this.vacated.length > 0 ||
      [...this.byLease.values()].some(
        (runtime) => runtime.assignment.cleanupIntent !== undefined,
      )
    );
  }

  pendingReleaseCleanup(): boolean {
    return (
      this.ownedWindowRegistry.some((owned) => {
        const runtime = this.byLease.get(owned.leaseId);
        return runtime === undefined || !sameOwnedWindow(runtime.assignment, owned);
      }) ||
      [...this.byLease.values()].some(
        (runtime) => runtime.assignment.cleanupIntent === "release",
      )
    );
  }

  closureOutbox(): ClosureRecord[] {
    return this.closedOutbox.map((entry) => ({ ...entry }));
  }

  vacatedLeases(): ClosureRecord[] {
    return this.vacated.map((entry) => ({ ...entry }));
  }

  acknowledgeClosure(entry: ClosureRecord): Promise<boolean> {
    return this.mutateAndPersist(() => {
      if (!this.hasOutboxEntry(entry)) return false;
      this.closedOutbox = this.closedOutbox.filter(
        (candidate) => !sameClosure(candidate, entry),
      );
      return true;
    }, Boolean);
  }

  discardServerState(): Promise<void> {
    return this.mutateAndPersist(() => {
      if (this.closedOutbox.length === 0 && this.vacated.length === 0) return false;
      this.closedOutbox = [];
      this.vacated = [];
      return true;
    }, Boolean).then(() => undefined);
  }

  async onFenced(runtime: SessionRuntime): Promise<void> {
    if (!this.isCurrent(runtime)) return;
    await this.cleanup(runtime, "recover");
  }

  async onTabChanged(_runtime: SessionRuntime): Promise<void> {
    // URLs and titles are intentionally not persisted.
  }

  async prepareSensitiveComplete(runtime: SessionRuntime): Promise<boolean> {
    if (!this.isCurrent(runtime)) return false;
    runtime.beginSensitiveCompletion();
    await this.serializeMutation(() => this.persist());
    if (!(await runtime.closeSensitiveTab())) {
      return false;
    }
    return this.mutateAndPersist(() => {
      if (!this.isCurrent(runtime)) return false;
      runtime.assignment.cleanupIntent = "release";
      this.enqueueClosure(runtime.assignment);
      this.ownedWindowRegistry = this.ownedWindowRegistry.filter(
        (owned) => !sameOwnedWindow(owned, runtime.assignment),
      );
      return true;
    }, Boolean);
  }

  finalizeSensitiveComplete(runtime: SessionRuntime): Promise<void> {
    runtime.finishSensitive();
    return this.mutateAndPersist(() => {
      if (!this.isCurrent(runtime)) return false;
      this.uninstall(runtime);
      return true;
    }, Boolean).then(() => undefined);
  }

  async abortSensitive(runtime: SessionRuntime): Promise<void> {
    if (!this.isCurrent(runtime)) return;
    await this.cleanup(runtime, "release");
  }

  enterSensitive(runtime: SessionRuntime): Promise<void> {
    return this.serializeMutation(async () => {
      if (!this.isCurrent(runtime)) throw new Error("session runtime is no longer current");
      runtime.assignment.sensitive = true;
      // Persistence is the gate before decryption, but the in-memory suppression
      // latch must fail closed until teardown confirms that the tab is gone.
      await this.persist();
    });
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

  private reserveProvision(
    input: ProvisionInput,
    isCurrent: () => boolean,
  ): Promise<ProvisionAdmission> {
    return this.serializeMutation(async () => {
      if (!isCurrent()) throw new StaleProvisionError();
      const existing = this.byLease.get(input.leaseId);
      if (existing !== undefined) {
        if (
          existing.sessionId !== input.sessionId ||
          existing.assignment.leaseEpoch !== input.leaseEpoch ||
          existing.assignment.browserEpoch !== input.browserEpoch ||
          existing.assignment.policyVersion !== input.policyVersion ||
          existing.assignment.cleanupIntent !== undefined ||
          !sameOrigins(existing.assignment.allowedOrigins, input.allowedOrigins)
        ) {
          throw new Error("lease assignment conflict");
        }
        return { existing };
      }
      if (this.pendingProvisions.has(input.leaseId)) {
        throw new Error("lease provisioning is already in progress");
      }
      if (
        this.ownedWindowRegistry.some(
          (owned) =>
            owned.leaseId === input.leaseId || owned.sessionId === input.sessionId,
        )
      ) {
        throw new Error("lease physical cleanup is still in progress");
      }
      const vacated = this.vacated.find((entry) => entry.leaseId === input.leaseId);
      if (vacated !== undefined && !sameClosure(vacated, input)) {
        throw new Error("vacated lease assignment conflict");
      }
      if (input.browserEpoch !== this.browserEpoch()) {
        throw new Error("browser epoch mismatch");
      }
      if (this.ownedWindowRegistry.length + this.pendingProvisions.size >= CAPACITY) {
        throw new Error("controlled-tab capacity exhausted");
      }
      if (this.bySession.has(input.sessionId)) {
        throw new Error("session assignment conflict");
      }
      const reservation: ProvisionReservation = {
        input: { ...input, allowedOrigins: [...input.allowedOrigins] },
      };
      this.pendingProvisions.set(input.leaseId, reservation);
      return { reservation };
    });
  }

  private commitProvision(
    reservation: ProvisionReservation,
    runtime: SessionRuntime,
    isCurrent: () => boolean,
  ): Promise<void> {
    return this.mutateAndPersist(() => {
      if (
        this.pendingProvisions.get(reservation.input.leaseId) !== reservation ||
        !isCurrent()
      ) {
        throw new StaleProvisionError();
      }
      if (
        this.byLease.size >= CAPACITY ||
        this.byLease.has(runtime.leaseId) ||
        this.bySession.has(runtime.sessionId) ||
        this.byTab.has(runtime.tabId)
      ) {
        throw new Error("provisioning reservation conflict");
      }
      this.install(runtime);
      this.pendingProvisions.delete(reservation.input.leaseId);
    });
  }

  private releaseProvisionReservation(reservation: ProvisionReservation): Promise<void> {
    return this.serializeMutation(async () => {
      if (this.pendingProvisions.get(reservation.input.leaseId) === reservation) {
        this.pendingProvisions.delete(reservation.input.leaseId);
      }
    });
  }

  private async cleanup(
    runtime: SessionRuntime,
    intent: CleanupIntent,
  ): Promise<boolean> {
    if (!this.isCurrent(runtime)) return false;
    runtime.beginCleanup(intent);
    await this.serializeMutation(() => this.persist());
    if (!(await runtime.close(true))) {
      await this.serializeMutation(() => this.persist());
      return false;
    }
    return this.mutateAndPersist(() => {
      if (!this.isCurrent(runtime)) return false;
      if (runtime.assignment.cleanupIntent === "release") {
        this.enqueueClosure(runtime.assignment);
      } else if (runtime.assignment.cleanupIntent === "recover") {
        this.enqueueVacated(runtime.assignment);
      }
      this.uninstall(runtime);
      this.ownedWindowRegistry = this.ownedWindowRegistry.filter(
        (owned) => !sameOwnedWindow(owned, runtime.assignment),
      );
      return true;
    }, Boolean);
  }

  private async closeRegisteredWindow(owned: OwnedWindow): Promise<boolean> {
    await this.serializeMutation(async () => {
      if (!this.hasOutboxEntry(owned) && this.closedOutbox.length >= SERVER_RECORD_CAP) {
        throw new Error("closure outbox capacity exhausted");
      }
      await this.persist();
    });
    if (!(await closeWindowAndConfirm(owned.windowId))) return false;
    return this.mutateAndPersist(() => {
      this.ownedWindowRegistry = this.ownedWindowRegistry.filter(
        (entry) => !sameOwnedWindow(entry, owned),
      );
      this.enqueueClosure(owned);
      return true;
    });
  }

  private recordProvisionClosure(input: ProvisionInput): Promise<void> {
    return this.mutateAndPersist(() => {
      this.enqueueClosure(input);
    });
  }

  private registerOwnedWindow(owned: OwnedWindow): Promise<void> {
    return this.serializeMutation(() => this.registerOwnedWindowExclusive(owned));
  }

  private async registerOwnedWindowExclusive(owned: OwnedWindow): Promise<void> {
    this.ownedWindowRegistry.push(owned);
    try {
      await this.persist();
    } catch (persistError) {
      // Keep both the discoverable bootstrap marker and the in-memory entry.
      // Physical closure is forbidden until a later retry checkpoints the
      // exact fence, otherwise worker termination can erase every recovery path.
      throw new OwnedWindowCheckpointError(persistError);
    }
  }

  private async discoverBootstrapWindows(): Promise<OwnedWindow[]> {
    const extensionRoot = browser.runtime.getURL("/");
    const windows = await browser.windows.getAll({ populate: true });
    const discovered: OwnedWindow[] = [];
    for (const window of windows) {
      if (window.id === undefined) continue;
      for (const tab of window.tabs ?? []) {
        const value = tab.url ?? tab.pendingUrl;
        if (typeof value !== "string") continue;
        const owned = ownedWindowFromBootstrapUrl(
          extensionRoot,
          value,
          window.id,
          tab.id ?? null,
        );
        if (owned !== null) discovered.push(owned);
      }
    }
    return discovered;
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

  private consumeVacatedSerialized(entry: ClosureRecord): Promise<void> {
    return this.mutateAndPersist(() => {
      const size = this.vacated.length;
      this.vacated = this.vacated.filter(
        (candidate) => !sameClosure(candidate, entry),
      );
      return this.vacated.length !== size;
    }, Boolean).then(() => undefined);
  }

  private hasOutboxEntry(entry: ClosureRecord): boolean {
    return this.closedOutbox.some((candidate) => sameClosure(candidate, entry));
  }

  private async persist(): Promise<void> {
    const write = this.persistTail.then(async () => {
      const state: PersistedManagerState = {
        version: 4,
        assignments: this.assignments(),
        ownedWindows: this.ownedWindows(),
        closedOutbox: this.closureOutbox(),
        vacatedLeases: this.vacatedLeases(),
      };
      // storage.session survives worker eviction but not a full browser exit.
      // The local mirror contains only ownership fences and cleanup intent—no
      // page data—and is authoritative so restored automation windows can
      // never become indistinguishable from ordinary user tabs after restart.
      await browser.storage.local.set({ [DURABLE_MANAGER_RECOVERY_KEY]: state });
      await browser.storage.session.set({ [MANAGER_STATE_KEY]: state });
    });
    this.persistTail = write.catch(() => {});
    await write;
  }

  private serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mutationTail.then(operation, operation);
    this.mutationTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private mutateAndPersist<T>(
    operation: () => T | Promise<T>,
    shouldPersist: (result: T) => boolean = () => true,
  ): Promise<T> {
    return this.serializeMutation(async () => {
      const snapshot = this.snapshotMutationState();
      try {
        const result = await operation();
        if (shouldPersist(result)) await this.persist();
        return result;
      } catch (error) {
        this.restoreMutationState(snapshot);
        throw error;
      }
    });
  }

  private snapshotMutationState(): ManagerMutationSnapshot {
    const runtimes = new Set([
      ...this.bySession.values(),
      ...this.byLease.values(),
      ...this.byTab.values(),
    ]);
    return {
      bySession: new Map(this.bySession),
      byLease: new Map(this.byLease),
      byTab: new Map(this.byTab),
      pendingProvisions: new Map(this.pendingProvisions),
      ownedWindows: this.ownedWindows(),
      closedOutbox: this.closureOutbox(),
      vacated: this.vacatedLeases(),
      runtimeAssignments: new Map(
        [...runtimes].map((runtime) => [runtime, cloneAssignment(runtime.assignment)]),
      ),
    };
  }

  private restoreMutationState(snapshot: ManagerMutationSnapshot): void {
    for (const [runtime, assignment] of snapshot.runtimeAssignments) {
      restoreAssignment(runtime.assignment, assignment);
    }
    replaceMap(this.bySession, snapshot.bySession);
    replaceMap(this.byLease, snapshot.byLease);
    replaceMap(this.byTab, snapshot.byTab);
    replaceMap(this.pendingProvisions, snapshot.pendingProvisions);
    this.ownedWindowRegistry = snapshot.ownedWindows;
    this.closedOutbox = snapshot.closedOutbox;
    this.vacated = snapshot.vacated;
  }

  private async tabInfo(tabId: number): Promise<TabInfo> {
    return controlledTabInfo(tabId);
  }
}

export class StaleProvisionError extends Error {
  constructor() {
    super("provisioning was superseded");
  }
}

function parseManagerState(value: unknown): PersistedManagerState {
  if (Array.isArray(value)) {
    const assignments = parseManagedAssignments(value);
    return {
      version: 4,
      assignments,
      ownedWindows: assignments.map(toOwnedWindow),
      closedOutbox: [],
      vacatedLeases: [],
    };
  }
  if (typeof value !== "object" || value === null) return emptyManagerState();
  const candidate = value as {
    version?: unknown;
    assignments?: unknown;
    ownedWindows?: unknown;
    closedOutbox?: unknown;
    vacatedLeases?: unknown;
  };
  if (
    candidate.version === 2 &&
    Array.isArray(candidate.assignments) &&
    Array.isArray(candidate.closedOutbox)
  ) {
    const assignments = parseManagedAssignments(candidate.assignments);
    return {
      version: 4,
      assignments,
      ownedWindows: assignments.map(toOwnedWindow),
      closedOutbox: candidate.closedOutbox.filter(isClosureRecord),
      vacatedLeases: [],
    };
  }
  if (
    candidate.version === 3 &&
    Array.isArray(candidate.assignments) &&
    Array.isArray(candidate.closedOutbox) &&
    Array.isArray(candidate.vacatedLeases)
  ) {
    const assignments = parseManagedAssignments(candidate.assignments);
    return {
      version: 4,
      assignments,
      ownedWindows: assignments.map(toOwnedWindow),
      closedOutbox: candidate.closedOutbox.filter(isClosureRecord),
      vacatedLeases: candidate.vacatedLeases.filter(isClosureRecord),
    };
  }
  if (
    candidate.version !== 4 ||
    !Array.isArray(candidate.assignments) ||
    !Array.isArray(candidate.ownedWindows) ||
    !Array.isArray(candidate.closedOutbox) ||
    !Array.isArray(candidate.vacatedLeases)
  ) {
    return emptyManagerState();
  }
  return {
    version: 4,
    assignments: parseManagedAssignments(candidate.assignments),
    ownedWindows: candidate.ownedWindows.filter(isOwnedWindow),
    closedOutbox: candidate.closedOutbox.filter(isClosureRecord),
    vacatedLeases: candidate.vacatedLeases.filter(isClosureRecord),
  };
}

function emptyManagerState(): PersistedManagerState {
  return {
    version: 4,
    assignments: [],
    ownedWindows: [],
    closedOutbox: [],
    vacatedLeases: [],
  };
}

function parseManagedAssignments(values: unknown[]): ManagedAssignment[] {
  return values.flatMap((value) => {
    if (!isAssignmentShape(value)) return [];
    const item = value as Omit<ManagedAssignment, "policyVersion"> & {
      policyVersion?: unknown;
    };
    return [{
      ...item,
      policyVersion:
        typeof item.policyVersion === "number" &&
        Number.isInteger(item.policyVersion) &&
        item.policyVersion >= 1
          ? item.policyVersion
          : 1,
    }];
  });
}

function isAssignmentShape(value: unknown): boolean {
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
      item.cleanupIntent === "discard") &&
    (item.sensitive === undefined || item.sensitive === true)
  );
}

function isOwnedWindow(value: unknown): value is OwnedWindow {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Partial<OwnedWindow>;
  return (
    typeof item.sessionId === "string" &&
    typeof item.leaseId === "string" &&
    typeof item.leaseEpoch === "number" &&
    typeof item.browserEpoch === "string" &&
    (item.tabId === null || typeof item.tabId === "number") &&
    typeof item.windowId === "number"
  );
}

function toOwnedWindow(assignment: ManagedAssignment): OwnedWindow {
  return {
    sessionId: assignment.sessionId,
    leaseId: assignment.leaseId,
    leaseEpoch: assignment.leaseEpoch,
    browserEpoch: assignment.browserEpoch,
    tabId: assignment.tabId,
    windowId: assignment.windowId,
  };
}

function sameOwnedWindow(
  left: Pick<OwnedWindow, keyof OwnedWindow>,
  right: Pick<OwnedWindow, keyof OwnedWindow>,
): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.leaseId === right.leaseId &&
    left.leaseEpoch === right.leaseEpoch &&
    left.browserEpoch === right.browserEpoch &&
    left.tabId === right.tabId &&
    left.windowId === right.windowId
  );
}

function dedupeOwnedWindows(values: OwnedWindow[]): OwnedWindow[] {
  const unique: OwnedWindow[] = [];
  for (const value of values) {
    if (!unique.some((candidate) => sameOwnedWindow(candidate, value))) {
      unique.push(value);
    }
  }
  return unique;
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

function sameOrigins(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((origin, index) => origin === right[index]);
}

function cloneAssignment(assignment: ManagedAssignment): ManagedAssignment {
  return {
    ...assignment,
    allowedOrigins: [...assignment.allowedOrigins],
  };
}

function restoreAssignment(
  target: ManagedAssignment,
  snapshot: ManagedAssignment,
): void {
  delete target.cleanupIntent;
  delete target.sensitive;
  Object.assign(target, cloneAssignment(snapshot));
}

function replaceMap<K, V>(target: Map<K, V>, snapshot: ReadonlyMap<K, V>): void {
  target.clear();
  for (const [key, value] of snapshot) target.set(key, value);
}
