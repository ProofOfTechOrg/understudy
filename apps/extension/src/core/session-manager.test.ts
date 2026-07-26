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

type SocketListener = (event: Event) => void;

class FakeSessionSocket {
  static readonly OPEN = 1;
  static instances: FakeSessionSocket[] = [];

  readyState = 0;
  closed = false;
  private readonly listeners = new Map<string, SocketListener[]>();

  constructor(readonly url: string) {
    FakeSessionSocket.instances.push(this);
  }

  addEventListener(type: string, listener: SocketListener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(): void {}

  close(): void {
    this.closed = true;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SessionManager cleanup ownership", () => {
  it("retains failed recover cleanup and records a vacated lease after confirmed removal", async () => {
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
    expect(manager.vacatedLeases()).toEqual([]);

    tabExists = false;
    await manager.retryCleanup();
    expect(manager.assignments()).toEqual([]);
    expect(manager.closureOutbox()).toEqual([]);
    expect(manager.vacatedLeases()).toEqual([
      {
        sessionId: ASSIGNMENT.sessionId,
        leaseId: ASSIGNMENT.leaseId,
        leaseEpoch: ASSIGNMENT.leaseEpoch,
        browserEpoch: ASSIGNMENT.browserEpoch,
      },
    ]);
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
    expect(manager.vacatedLeases()).toEqual([]);
  });

  it("promotes a vacated lease when the server requests closure", async () => {
    const sessionState: Record<string, unknown> = {
      "understudy:assignments": {
        version: 3,
        assignments: [],
        closedOutbox: [],
        vacatedLeases: [
          {
            sessionId: ASSIGNMENT.sessionId,
            leaseId: ASSIGNMENT.leaseId,
            leaseEpoch: ASSIGNMENT.leaseEpoch,
            browserEpoch: ASSIGNMENT.browserEpoch,
          },
        ],
      },
    };
    installBrowser(
      sessionState,
      async () => {},
      async () => {
        throw new Error("tab not found");
      },
    );
    const manager = new SessionManager(
      () => "https://service.example",
      () => EPOCH,
    );

    await manager.restoreSameEpoch();
    await expect(manager.closeLease(ASSIGNMENT)).resolves.toBe(true);

    expect(manager.vacatedLeases()).toEqual([]);
    expect(manager.closureOutbox()).toEqual([
      {
        sessionId: ASSIGNMENT.sessionId,
        leaseId: ASSIGNMENT.leaseId,
        leaseEpoch: ASSIGNMENT.leaseEpoch,
        browserEpoch: ASSIGNMENT.browserEpoch,
      },
    ]);
  });

  it.each(["release", "discard"] as const)(
    "retires attached assignments without reconciling during %s restoration",
    async (intent) => {
      const sessionState: Record<string, unknown> = {
        "understudy:assignments": {
          version: 3,
          assignments: [ASSIGNMENT],
          closedOutbox: [],
          vacatedLeases: [],
        },
      };
      const fixture = installBrowser(
        sessionState,
        async () => {},
        async () => {
          throw new Error("tab not found");
        },
        [{ tabId: ASSIGNMENT.tabId, attached: true }],
      );
      const manager = new SessionManager(
        () => "https://service.example",
        () => EPOCH,
      );

      await manager.restoreSameEpoch(intent);

      expect(fixture.getTargets).not.toHaveBeenCalled();
      expect(fixture.sendCommand).not.toHaveBeenCalled();
      expect(fixture.remove).toHaveBeenCalledWith(ASSIGNMENT.tabId);
      expect(manager.assignments()).toEqual([]);
      expect(manager.closureOutbox()).toEqual(
        intent === "release"
          ? [
              {
                sessionId: ASSIGNMENT.sessionId,
                leaseId: ASSIGNMENT.leaseId,
                leaseEpoch: ASSIGNMENT.leaseEpoch,
                browserEpoch: ASSIGNMENT.browserEpoch,
              },
            ]
          : [],
      );
    },
  );

  it("reconciles a healthy attached assignment during ordinary recovery", async () => {
    const sessionState: Record<string, unknown> = {
      "understudy:assignments": {
        version: 3,
        assignments: [ASSIGNMENT],
        closedOutbox: [],
        vacatedLeases: [],
      },
    };
    const fixture = installBrowser(
      sessionState,
      async () => {},
      async () => ({ id: ASSIGNMENT.tabId }),
      [{ tabId: ASSIGNMENT.tabId, attached: true }],
    );
    const manager = new SessionManager(
      () => "https://service.example",
      () => EPOCH,
    );

    await manager.restoreSameEpoch("recover");

    expect(fixture.sendCommand).toHaveBeenCalledWith(
      { tabId: ASSIGNMENT.tabId },
      "Page.getFrameTree",
      undefined,
    );
    expect(fixture.remove).not.toHaveBeenCalled();
    expect(manager.assignments()).toHaveLength(1);
    expect(manager.assignments()[0]?.cleanupIntent).toBeUndefined();
  });

  it("fences every runtime and stops every session socket before a failed Stop All write", async () => {
    FakeSessionSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeSessionSocket);
    const second = {
      ...ASSIGNMENT,
      sessionId: "session-2",
      leaseId: "lease-2",
      tabId: 8,
      windowId: 4,
    };
    const sessionState: Record<string, unknown> = {
      "understudy:assignments": {
        version: 3,
        assignments: [ASSIGNMENT, second],
        closedOutbox: [],
        vacatedLeases: [],
      },
    };
    const fixture = installBrowser(
      sessionState,
      async () => {},
      async (tabId) => ({ id: tabId }),
      [
        { tabId: ASSIGNMENT.tabId, attached: true },
        { tabId: second.tabId, attached: true },
      ],
    );
    const manager = new SessionManager(
      () => "https://service.example",
      () => EPOCH,
    );
    await manager.restoreSameEpoch("recover");
    expect(
      manager.connectSessionTicket({
        ...ASSIGNMENT,
        sessionTicket: "ticket-1",
      }),
    ).toBe(true);
    expect(
      manager.connectSessionTicket({
        ...second,
        sessionTicket: "ticket-2",
      }),
    ).toBe(true);
    expect(FakeSessionSocket.instances).toHaveLength(2);
    fixture.sessionSet.mockRejectedValueOnce(new Error("persist failed"));

    const stopping = manager.stopAll("release");

    expect(manager.assignments()).toEqual([
      expect.objectContaining({ leaseId: "lease-1", cleanupIntent: "release" }),
      expect.objectContaining({ leaseId: "lease-2", cleanupIntent: "release" }),
    ]);
    expect(FakeSessionSocket.instances.every((socket) => socket.closed)).toBe(
      true,
    );
    await expect(stopping).rejects.toThrow("persist failed");
    expect(manager.assignments()).toEqual([
      expect.objectContaining({ leaseId: "lease-1", cleanupIntent: "release" }),
      expect.objectContaining({ leaseId: "lease-2", cleanupIntent: "release" }),
    ]);
  });
});

function installBrowser(
  sessionState: Record<string, unknown>,
  remove: (tabId: number) => Promise<void>,
  get: (tabId: number) => Promise<unknown>,
  targets: Array<{ tabId: number; attached: boolean }> = [],
): {
  remove: ReturnType<typeof vi.fn>;
  sessionSet: ReturnType<typeof vi.fn>;
  getTargets: ReturnType<typeof vi.fn>;
  sendCommand: ReturnType<typeof vi.fn>;
} {
  const removeMock = vi.fn(remove);
  const sessionSet = vi.fn(async (values: Record<string, unknown>) => {
    Object.assign(sessionState, values);
  });
  const getTargets = vi.fn(async () => targets);
  const sendCommand = vi.fn(
    async (_target: unknown, method: string) =>
      method === "Page.getFrameTree"
        ? {
            frameTree: {
              frame: {
                id: "main-frame",
                loaderId: "loader-1",
                url: "about:blank",
              },
            },
          }
        : {},
  );
  vi.stubGlobal("browser", {
    storage: {
      session: {
        get: vi.fn(async (key: string) => ({
          [key]: sessionState[key],
        })),
        set: sessionSet,
      },
    },
    debugger: {
      getTargets,
      sendCommand,
    },
    tabs: {
      remove: removeMock,
      get: vi.fn(get),
    },
  });
  return {
    remove: removeMock,
    sessionSet,
    getTargets,
    sendCommand,
  };
}
