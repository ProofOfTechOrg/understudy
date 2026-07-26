import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "./session-manager";

const EPOCH = "browser-epoch-1";
const ASSIGNMENT = {
  sessionId: "session-1",
  leaseId: "lease-1",
  leaseEpoch: 1,
  browserEpoch: EPOCH,
  allowedOrigins: ["https://app.example"],
  tabId: 7,
  windowId: 3,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SessionManager cleanup ownership", () => {
  it("retains failed recover cleanup and removes it on a later retry without a closure frame", async () => {
    const sessionState: Record<string, unknown> = {
      "understudy:assignments": {
        version: 2,
        assignments: [{ ...ASSIGNMENT, cleanupIntent: "recover" }],
        closedOutbox: [],
      },
    };
    let tabExists = true;
    const remove = vi.fn(async () => {
      if (tabExists) throw new Error("remove failed");
    });
    installBrowser(sessionState, remove, async () => {
      if (tabExists) return { id: ASSIGNMENT.tabId };
      throw new Error("tab not found");
    });
    const manager = new SessionManager(
      () => "https://service.example",
      () => EPOCH,
    );

    await manager.restoreSameEpoch();
    expect(manager.assignments()).toEqual([
      expect.objectContaining({ cleanupIntent: "recover" }),
    ]);
    expect(manager.closureOutbox()).toEqual([]);

    tabExists = false;
    await manager.retryCleanup();
    expect(manager.assignments()).toEqual([]);
    expect(manager.closureOutbox()).toEqual([]);
  });

  it("upgrades pending recovery to release and queues closure only after removal", async () => {
    const sessionState: Record<string, unknown> = {
      "understudy:assignments": {
        version: 2,
        assignments: [{ ...ASSIGNMENT, cleanupIntent: "recover" }],
        closedOutbox: [],
      },
    };
    let tabExists = true;
    const remove = vi.fn(async () => {
      if (tabExists) throw new Error("remove failed");
    });
    installBrowser(sessionState, remove, async () => {
      if (tabExists) return { id: ASSIGNMENT.tabId };
      throw new Error("tab not found");
    });
    const manager = new SessionManager(
      () => "https://service.example",
      () => EPOCH,
    );

    await manager.restoreSameEpoch("release");
    expect(manager.closureOutbox()).toEqual([]);
    expect(manager.assignments()).toEqual([
      expect.objectContaining({ cleanupIntent: "release" }),
    ]);

    tabExists = false;
    await manager.retryCleanup();
    expect(manager.assignments()).toEqual([]);
    expect(manager.closureOutbox()).toEqual([
      {
        sessionId: ASSIGNMENT.sessionId,
        leaseId: ASSIGNMENT.leaseId,
        leaseEpoch: ASSIGNMENT.leaseEpoch,
        browserEpoch: ASSIGNMENT.browserEpoch,
      },
    ]);
  });
});

function installBrowser(
  sessionState: Record<string, unknown>,
  remove: (tabId: number) => Promise<void>,
  get: (tabId: number) => Promise<unknown>,
): void {
  vi.stubGlobal("browser", {
    storage: {
      session: {
        get: vi.fn(async (key: string) => ({
          [key]: sessionState[key],
        })),
        set: vi.fn(async (values: Record<string, unknown>) => {
          Object.assign(sessionState, values);
        }),
      },
    },
    debugger: {
      getTargets: vi.fn(async () => []),
    },
    tabs: {
      remove: vi.fn(remove),
      get: vi.fn(get),
    },
  });
}
