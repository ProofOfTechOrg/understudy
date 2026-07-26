import type { TabInfo } from "@understudy/protocol";
import type { Browser } from "wxt/browser";
import {
  SessionRuntime,
  type RuntimeAssignment,
  type RuntimeHost,
} from "./session-runtime";

const ASSIGNMENTS_KEY = "understudy:assignments";
const CAPACITY = 2;

export interface ProvisionInput {
  sessionId: string;
  leaseId: string;
  leaseEpoch: number;
  browserEpoch: string;
  allowedOrigins: string[];
  sessionTicket: string;
}

export class SessionManager implements RuntimeHost {
  private readonly bySession = new Map<string, SessionRuntime>();
  private readonly byLease = new Map<string, SessionRuntime>();
  private readonly byTab = new Map<number, SessionRuntime>();

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

  async provision(input: ProvisionInput): Promise<TabInfo> {
    const existing = this.byLease.get(input.leaseId);
    if (existing !== undefined) {
      if (
        existing.sessionId !== input.sessionId ||
        existing.assignment.leaseEpoch !== input.leaseEpoch ||
        existing.assignment.browserEpoch !== input.browserEpoch
      ) {
        throw new Error("lease assignment conflict");
      }
      existing.connect(input.sessionTicket);
      return this.tabInfo(existing.tabId);
    }
    if (input.browserEpoch !== this.browserEpoch()) {
      throw new Error("browser epoch mismatch");
    }
    if (this.byLease.size >= CAPACITY) throw new Error("controlled-tab capacity exhausted");

    const createdWindow = await browser.windows.create({
      focused: false,
      type: "normal",
      url: "about:blank",
    });
    const tab = createdWindow?.tabs?.[0];
    if (createdWindow?.id === undefined || tab?.id === undefined) {
      throw new Error("Chrome did not return the extension-owned automation tab");
    }
    const assignment: RuntimeAssignment = {
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
    try {
      await runtime.attach();
      runtime.connect(input.sessionTicket);
      return this.tabInfo(runtime.tabId);
    } catch (error) {
      await this.remove(runtime, true);
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
      runtime.assignment.browserEpoch !== input.browserEpoch
    ) {
      return false;
    }
    runtime.connect(input.sessionTicket);
    return true;
  }

  async closeLease(input: {
    sessionId: string;
    leaseId: string;
    leaseEpoch: number;
    browserEpoch: string;
  }): Promise<boolean> {
    const runtime = this.byLease.get(input.leaseId);
    if (
      runtime === undefined ||
      runtime.sessionId !== input.sessionId ||
      runtime.assignment.leaseEpoch !== input.leaseEpoch ||
      runtime.assignment.browserEpoch !== input.browserEpoch
    ) {
      return false;
    }
    return this.remove(runtime, true);
  }

  async restoreSameEpoch(): Promise<void> {
    const stored = await browser.storage.session.get(ASSIGNMENTS_KEY);
    const value = stored[ASSIGNMENTS_KEY];
    if (!Array.isArray(value)) return;
    const targets = await browser.debugger.getTargets();
    for (const raw of value) {
      if (!isAssignment(raw) || raw.browserEpoch !== this.browserEpoch()) continue;
      const target = targets.find((candidate) => candidate.tabId === raw.tabId);
      if (target?.attached !== true) continue;
      const runtime = new SessionRuntime(raw, this);
      this.install(runtime);
      try {
        await runtime.reconcileSameEpoch();
      } catch {
        this.uninstall(runtime);
      }
    }
    await this.persist();
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

  async stopAll(): Promise<void> {
    for (const runtime of [...this.byLease.values()]) {
      await this.remove(runtime, true);
    }
  }

  assignments(): RuntimeAssignment[] {
    return [...this.byLease.values()].map((runtime) => runtime.assignment);
  }

  async onFenced(runtime: SessionRuntime): Promise<void> {
    if (!this.isCurrent(runtime)) return;
    this.uninstall(runtime);
    await this.persist();
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
    if (this.bySession.get(runtime.sessionId) === runtime) this.bySession.delete(runtime.sessionId);
    if (this.byLease.get(runtime.leaseId) === runtime) this.byLease.delete(runtime.leaseId);
    if (this.byTab.get(runtime.tabId) === runtime) this.byTab.delete(runtime.tabId);
  }

  private async remove(runtime: SessionRuntime, closeTab: boolean): Promise<boolean> {
    if (!(await runtime.close(closeTab))) return false;
    this.uninstall(runtime);
    await this.persist().catch(() => {});
    return true;
  }

  private async persist(): Promise<void> {
    await browser.storage.session.set({
      [ASSIGNMENTS_KEY]: this.assignments(),
    });
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

function isAssignment(value: unknown): value is RuntimeAssignment {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Partial<RuntimeAssignment>;
  return (
    typeof item.sessionId === "string" &&
    typeof item.leaseId === "string" &&
    typeof item.leaseEpoch === "number" &&
    typeof item.browserEpoch === "string" &&
    Array.isArray(item.allowedOrigins) &&
    item.allowedOrigins.every((origin) => typeof origin === "string") &&
    typeof item.tabId === "number" &&
    typeof item.windowId === "number"
  );
}
