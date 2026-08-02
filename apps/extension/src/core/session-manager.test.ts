import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "./session-manager";
import type { SessionRuntime } from "./session-runtime";
import { ownedWindowBootstrapUrl } from "./owned-window-marker";

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
  it("restores exact window ownership after storage.session is cleared", async () => {
    const assignment = { ...ASSIGNMENT, policyVersion: 1 };
    const sessionState: Record<string, unknown> = {
      "understudy:assignments": {
        version: 4,
        assignments: [assignment],
        ownedWindows: [assignment],
        closedOutbox: [],
        vacatedLeases: [],
      },
    };
    const fixture = installBrowser(
      sessionState,
      async () => {},
      async (tabId) => ({ id: tabId }),
    );
    const first = new SessionManager(
      () => "https://service.example",
      () => EPOCH,
    );
    await first.restoreSameEpoch();
    expect(fixture.localState["understudy:durableManagerRecovery"]).toBeDefined();

    delete sessionState["understudy:assignments"];
    const restarted = new SessionManager(
      () => "https://service.example",
      () => EPOCH,
    );
    await restarted.restoreSameEpoch();

    expect(restarted.assignments()).toEqual([expect.objectContaining(assignment)]);
    expect(restarted.ownedWindows()).toEqual([expect.objectContaining(assignment)]);
    expect(fixture.windowRemove).not.toHaveBeenCalled();
  });

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

  it("rolls back an in-memory discard when its durable checkpoint fails", async () => {
    const closure = {
      sessionId: ASSIGNMENT.sessionId,
      leaseId: ASSIGNMENT.leaseId,
      leaseEpoch: ASSIGNMENT.leaseEpoch,
      browserEpoch: ASSIGNMENT.browserEpoch,
    };
    const sessionState: Record<string, unknown> = {
      "understudy:assignments": {
        version: 4,
        assignments: [],
        ownedWindows: [],
        closedOutbox: [closure],
        vacatedLeases: [closure],
      },
    };
    const fixture = installBrowser(
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
    fixture.sessionSet.mockRejectedValueOnce(new Error("persist failed"));

    await expect(manager.stopAll("discard")).rejects.toThrow("persist failed");

    expect(manager.closureOutbox()).toEqual([closure]);
    expect(manager.vacatedLeases()).toEqual([closure]);
    expect(manager.pendingCleanup()).toBe(true);
  });

  it("rolls back assignment policy mutations when their checkpoint fails", async () => {
    const assignment = { ...ASSIGNMENT, policyVersion: 1 };
    const sessionState: Record<string, unknown> = {
      "understudy:assignments": {
        version: 4,
        assignments: [assignment],
        ownedWindows: [assignment],
        closedOutbox: [],
        vacatedLeases: [],
      },
    };
    const fixture = installBrowser(
      sessionState,
      async () => {},
      async (tabId) => ({ id: tabId }),
    );
    const manager = new SessionManager(
      () => "https://service.example",
      () => EPOCH,
    );
    await manager.restoreSameEpoch();
    fixture.sessionSet.mockRejectedValueOnce(new Error("persist failed"));

    await expect(
      manager.applyPolicy(2, ["https://app.example"]),
    ).rejects.toThrow("persist failed");

    expect(manager.assignments()).toEqual([
      expect.objectContaining({ policyVersion: 1 }),
    ]);
  });

  it("restores managed ownership when the post-close checkpoint fails", async () => {
    const assignment = { ...ASSIGNMENT, policyVersion: 1 };
    const sessionState: Record<string, unknown> = {
      "understudy:assignments": {
        version: 4,
        assignments: [assignment],
        ownedWindows: [assignment],
        closedOutbox: [],
        vacatedLeases: [],
      },
    };
    const fixture = installBrowser(
      sessionState,
      async () => {},
      async (tabId) => ({ id: tabId }),
    );
    const manager = new SessionManager(
      () => "https://service.example",
      () => EPOCH,
    );
    await manager.restoreSameEpoch();
    fixture.sessionSet
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("post-close persist failed"));

    await expect(manager.stopAll("discard")).rejects.toThrow(
      "post-close persist failed",
    );
    expect(manager.assignments()).toEqual([
      expect.objectContaining({ leaseId: assignment.leaseId, cleanupIntent: "discard" }),
    ]);
    expect(manager.ownedWindows()).toEqual([assignment]);
    expect(manager.pendingCleanup()).toBe(true);

    await manager.retryCleanup();
    expect(manager.assignments()).toEqual([]);
    expect(manager.ownedWindows()).toEqual([]);
    expect(manager.pendingCleanup()).toBe(false);
  });

  it("serializes a concurrent provision behind cleanup rollback", async () => {
    const assignment = { ...ASSIGNMENT, policyVersion: 1 };
    const second = {
      ...assignment,
      sessionId: "session-2",
      leaseId: "lease-2",
      tabId: 8,
      windowId: 4,
    };
    const sessionState: Record<string, unknown> = {
      "understudy:assignments": {
        version: 4,
        assignments: [assignment],
        ownedWindows: [assignment],
        closedOutbox: [],
        vacatedLeases: [],
      },
    };
    const fixture = installBrowser(
      sessionState,
      async () => {},
      async (tabId) => ({ id: tabId }),
    );
    const manager = new SessionManager(
      () => "https://service.example",
      () => EPOCH,
    );
    await manager.restoreSameEpoch();
    fixture.windowCreate.mockResolvedValueOnce({
      id: second.windowId,
      tabs: [{ id: second.tabId }],
    });
    let releaseClose!: () => void;
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    fixture.windowRemove.mockImplementationOnce(async () => closeGate);
    let failCheckpoint = false;
    fixture.sessionSet.mockImplementation(async (values) => {
      if (failCheckpoint) {
        failCheckpoint = false;
        throw new Error("post-close persist failed");
      }
      Object.assign(sessionState, values);
    });

    const stopping = manager.stopAll("discard");
    await vi.waitFor(() => expect(fixture.windowRemove).toHaveBeenCalledOnce());
    let currentChecks = 0;
    const provisioning = manager.provision(
      {
        ...second,
        sessionTicket: "session-ticket",
      },
      () => {
        currentChecks += 1;
        return currentChecks === 1;
      },
    );
    const provisioningFailure = provisioning.then(
      () => null,
      (error: unknown) => error,
    );
    await vi.waitFor(() => expect(fixture.windowCreate).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(
        fixture.sessionSet.mock.calls.some(([values]) => {
          const state = values["understudy:assignments"] as
            | { ownedWindows?: unknown[] }
            | undefined;
          return state?.ownedWindows?.length === 2;
        }),
      ).toBe(true),
    );

    failCheckpoint = true;
    releaseClose();
    await expect(stopping).rejects.toThrow("post-close persist failed");
    expect(await provisioningFailure).toEqual(
      expect.objectContaining({ message: "provisioning was superseded" }),
    );

    expect(manager.ownedWindows()).toEqual([assignment]);
  });

  it("does not admit a third provision while capacity cleanup is uncommitted", async () => {
    const first = { ...ASSIGNMENT, policyVersion: 1 };
    const second = {
      ...first,
      sessionId: "session-2",
      leaseId: "lease-2",
      tabId: 8,
      windowId: 4,
    };
    const sessionState: Record<string, unknown> = {
      "understudy:assignments": {
        version: 4,
        assignments: [first, second],
        ownedWindows: [first, second],
        closedOutbox: [],
        vacatedLeases: [],
      },
    };
    const fixture = installBrowser(
      sessionState,
      async () => {},
      async (tabId) => ({ id: tabId }),
    );
    const manager = new SessionManager(
      () => "https://service.example",
      () => EPOCH,
    );
    await manager.restoreSameEpoch();
    let releaseClose!: () => void;
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    fixture.windowRemove.mockImplementationOnce(async () => closeGate);

    const closing = manager.closeLease(first, "discard");
    await vi.waitFor(() => expect(fixture.windowRemove).toHaveBeenCalledOnce());
    await expect(
      manager.provision({
        sessionId: "session-3",
        leaseId: "lease-3",
        leaseEpoch: 1,
        browserEpoch: EPOCH,
        allowedOrigins: ["https://app.example"],
        policyVersion: 1,
        sessionTicket: "session-ticket",
      }),
    ).rejects.toThrow("controlled-tab capacity exhausted");
    expect(fixture.windowCreate).not.toHaveBeenCalled();

    releaseClose();
    await closing;
  });

  it("does not orphan a checkpointed window while its provision is still pending", async () => {
    const sessionState: Record<string, unknown> = {};
    const fixture = installBrowser(
      sessionState,
      async () => {},
      async (tabId) => ({ id: tabId }),
    );
    let releaseUpdate!: () => void;
    const updateGate = new Promise<void>((resolve) => {
      releaseUpdate = resolve;
    });
    fixture.tabUpdate.mockImplementationOnce(async (tabId: number) => {
      await updateGate;
      return { id: tabId, url: "about:blank" };
    });
    const manager = new SessionManager(
      () => "https://service.example",
      () => EPOCH,
    );

    const provisioning = manager.provision({
      ...ASSIGNMENT,
      policyVersion: 1,
      sessionTicket: "session-ticket",
    });
    await vi.waitFor(() => expect(fixture.tabUpdate).toHaveBeenCalledOnce());

    await manager.retryCleanup();

    expect(fixture.windowRemove).not.toHaveBeenCalled();
    expect(manager.ownedWindows()).toEqual([
      expect.objectContaining({ leaseId: ASSIGNMENT.leaseId }),
    ]);
    releaseUpdate();
    await expect(provisioning).resolves.toMatchObject({ tabId: ASSIGNMENT.tabId });
    expect(manager.assignments()).toEqual([
      expect.objectContaining({ leaseId: ASSIGNMENT.leaseId }),
    ]);
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
      );
      const manager = new SessionManager(
        () => "https://service.example",
        () => EPOCH,
      );

      await manager.restoreSameEpoch(intent);

      expect(fixture.sendCommand).not.toHaveBeenCalled();
      expect(fixture.windowRemove).toHaveBeenCalledWith(ASSIGNMENT.windowId);
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

  it("cleans up an assignment when its scoped debugger session is gone", async () => {
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
      async () => {
        throw new Error("debugger is not attached");
      },
    );
    const manager = new SessionManager(
      () => "https://service.example",
      () => EPOCH,
    );

    await manager.restoreSameEpoch("recover");

    expect(fixture.windowRemove).toHaveBeenCalledWith(ASSIGNMENT.windowId);
    expect(manager.assignments()).toEqual([]);
    expect(manager.vacatedLeases()).toEqual([
      {
        sessionId: ASSIGNMENT.sessionId,
        leaseId: ASSIGNMENT.leaseId,
        leaseEpoch: ASSIGNMENT.leaseEpoch,
        browserEpoch: ASSIGNMENT.browserEpoch,
      },
    ]);
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

  it("closes only registered unowned windows during worker-wake reconciliation", async () => {
    const ownedWindow = {
      sessionId: ASSIGNMENT.sessionId,
      leaseId: ASSIGNMENT.leaseId,
      leaseEpoch: ASSIGNMENT.leaseEpoch,
      browserEpoch: ASSIGNMENT.browserEpoch,
      tabId: ASSIGNMENT.tabId,
      windowId: ASSIGNMENT.windowId,
    };
    const sessionState: Record<string, unknown> = {
      "understudy:assignments": {
        version: 4,
        assignments: [],
        ownedWindows: [ownedWindow],
        closedOutbox: [],
        vacatedLeases: [],
      },
    };
    const fixture = installBrowser(
      sessionState,
      async () => {},
      async () => ({ id: 999 }),
    );
    const manager = new SessionManager(
      () => "https://service.example",
      () => EPOCH,
    );

    await manager.restoreSameEpoch();

    expect(fixture.windowRemove).toHaveBeenCalledOnce();
    expect(fixture.windowRemove).toHaveBeenCalledWith(ASSIGNMENT.windowId);
    expect(fixture.remove).not.toHaveBeenCalled();
    expect(manager.ownedWindows()).toEqual([]);
  });

  it("persists the full owned-window fence immediately after Chrome creates it", async () => {
    const sessionState: Record<string, unknown> = {};
    const fixture = installBrowser(
      sessionState,
      async () => {},
      async (tabId) => ({ id: tabId, url: "about:blank", title: "" }),
    );
    const manager = new SessionManager(
      () => "https://service.example",
      () => EPOCH,
    );
    let currentChecks = 0;

    await expect(
      manager.provision(
        {
          sessionId: ASSIGNMENT.sessionId,
          leaseId: ASSIGNMENT.leaseId,
          leaseEpoch: ASSIGNMENT.leaseEpoch,
          browserEpoch: ASSIGNMENT.browserEpoch,
          allowedOrigins: ASSIGNMENT.allowedOrigins,
          policyVersion: 1,
          sessionTicket: "ticket",
        },
        () => {
          currentChecks += 1;
          return currentChecks === 1;
        },
      ),
    ).rejects.toThrow("provisioning was superseded");

    expect(fixture.sessionSet.mock.calls[0]?.[0]).toEqual({
      "understudy:assignments": {
        version: 4,
        assignments: [],
        ownedWindows: [
          {
            sessionId: ASSIGNMENT.sessionId,
            leaseId: ASSIGNMENT.leaseId,
            leaseEpoch: ASSIGNMENT.leaseEpoch,
            browserEpoch: ASSIGNMENT.browserEpoch,
            tabId: ASSIGNMENT.tabId,
            windowId: ASSIGNMENT.windowId,
          },
        ],
        closedOutbox: [],
        vacatedLeases: [],
      },
    });
  });

  it("leaves the bootstrap window discoverable until a failed ownership checkpoint can retry", async () => {
    const sessionState: Record<string, unknown> = {};
    const fixture = installBrowser(
      sessionState,
      async () => {},
      async (tabId) => ({ id: tabId, url: "about:blank", title: "" }),
    );
    fixture.sessionSet.mockRejectedValueOnce(new Error("checkpoint failed"));
    const manager = new SessionManager(
      () => "https://service.example",
      () => EPOCH,
    );

    await expect(
      manager.provision({
        sessionId: ASSIGNMENT.sessionId,
        leaseId: ASSIGNMENT.leaseId,
        leaseEpoch: ASSIGNMENT.leaseEpoch,
        browserEpoch: ASSIGNMENT.browserEpoch,
        allowedOrigins: ASSIGNMENT.allowedOrigins,
        policyVersion: 1,
        sessionTicket: "ticket",
      }),
    ).rejects.toThrow("could not checkpoint");

    expect(fixture.windowRemove).not.toHaveBeenCalled();
    expect(manager.ownedWindows()).toEqual([
      expect.objectContaining({ leaseId: ASSIGNMENT.leaseId }),
    ]);

    await manager.retryCleanup();

    expect(fixture.windowRemove).toHaveBeenCalledWith(ASSIGNMENT.windowId);
    expect(manager.ownedWindows()).toEqual([]);
    expect(manager.closureOutbox()).toEqual([
      {
        sessionId: ASSIGNMENT.sessionId,
        leaseId: ASSIGNMENT.leaseId,
        leaseEpoch: ASSIGNMENT.leaseEpoch,
        browserEpoch: ASSIGNMENT.browserEpoch,
      },
    ]);
  });

  it("records and closes a created window when Chrome omits its tab", async () => {
    const sessionState: Record<string, unknown> = {};
    const fixture = installBrowser(
      sessionState,
      async () => {},
      async () => ({ id: 999 }),
    );
    fixture.windowCreate.mockResolvedValueOnce({
      id: ASSIGNMENT.windowId,
      tabs: [],
    });
    const manager = new SessionManager(
      () => "https://service.example",
      () => EPOCH,
    );

    await expect(
      manager.provision({
        sessionId: ASSIGNMENT.sessionId,
        leaseId: ASSIGNMENT.leaseId,
        leaseEpoch: ASSIGNMENT.leaseEpoch,
        browserEpoch: ASSIGNMENT.browserEpoch,
        allowedOrigins: ASSIGNMENT.allowedOrigins,
        policyVersion: 1,
        sessionTicket: "ticket",
      }),
    ).rejects.toThrow("Chrome did not return");

    expect(fixture.sessionSet.mock.calls[0]?.[0]).toEqual({
      "understudy:assignments": expect.objectContaining({
        ownedWindows: [expect.objectContaining({
          tabId: null,
          windowId: ASSIGNMENT.windowId,
        })],
      }),
    });
    expect(fixture.windowRemove).toHaveBeenCalledWith(ASSIGNMENT.windowId);
    expect(manager.ownedWindows()).toEqual([]);
  });

  it("retries an unassigned owned-window closure after Chrome initially refuses it", async () => {
    const partial = { ...ASSIGNMENT, tabId: null };
    const sessionState: Record<string, unknown> = {
      "understudy:assignments": {
        version: 4,
        assignments: [],
        ownedWindows: [partial],
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
    );
    fixture.windowRemove.mockRejectedValueOnce(new Error("window still exists"));
    fixture.windowRemove.mockRejectedValueOnce(new Error("window still exists"));
    const manager = new SessionManager(
      () => "https://service.example",
      () => EPOCH,
    );

    await manager.restoreSameEpoch("discard");
    expect(manager.pendingCleanup()).toBe(true);
    expect(manager.pendingReleaseCleanup()).toBe(true);
    expect(manager.ownedWindows()).toEqual([partial]);
    await expect(
      manager.provision({
        sessionId: partial.sessionId,
        leaseId: partial.leaseId,
        leaseEpoch: partial.leaseEpoch,
        browserEpoch: partial.browserEpoch,
        allowedOrigins: ["https://app.example"],
        policyVersion: 1,
        sessionTicket: "session-ticket",
      }),
    ).rejects.toThrow("lease physical cleanup is still in progress");
    expect(fixture.windowCreate).not.toHaveBeenCalled();

    await manager.retryCleanup();
    expect(fixture.windowRemove).toHaveBeenCalledTimes(3);
    expect(manager.ownedWindows()).toEqual([]);
    expect(manager.closureOutbox()).toEqual([
      {
        sessionId: partial.sessionId,
        leaseId: partial.leaseId,
        leaseEpoch: partial.leaseEpoch,
        browserEpoch: partial.browserEpoch,
      },
    ]);
    expect(manager.pendingCleanup()).toBe(true);
    await manager.acknowledgeClosure(partial);
    expect(manager.pendingCleanup()).toBe(false);
  });

  it("retains physical ownership when the closure outbox is full", async () => {
    const partial = { ...ASSIGNMENT, tabId: null };
    const closedOutbox = Array.from({ length: 100 }, (_, index) => ({
      sessionId: `closed-session-${index}`,
      leaseId: `closed-lease-${index}`,
      leaseEpoch: 1,
      browserEpoch: EPOCH,
    }));
    const sessionState: Record<string, unknown> = {
      "understudy:assignments": {
        version: 4,
        assignments: [],
        ownedWindows: [partial],
        closedOutbox,
        vacatedLeases: [],
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

    await expect(manager.restoreSameEpoch()).rejects.toThrow(
      "closure outbox capacity exhausted",
    );

    expect(manager.ownedWindows()).toEqual([partial]);
    expect(manager.closureOutbox()).toEqual(closedOutbox);
    expect(manager.pendingCleanup()).toBe(true);
  });

  it("discovers and closes a window created before its ownership checkpoint", async () => {
    const sessionState: Record<string, unknown> = {};
    const fixture = installBrowser(
      sessionState,
      async () => {},
      async () => {
        throw new Error("tab not found");
      },
    );
    fixture.windowGetAll.mockResolvedValue([
      {
        id: ASSIGNMENT.windowId,
        tabs: [
          {
            id: ASSIGNMENT.tabId,
            url: ownedWindowBootstrapUrl(
              "chrome-extension://understudy/",
              ASSIGNMENT,
            ),
          },
        ],
      },
    ]);
    const manager = new SessionManager(
      () => "https://service.example",
      () => EPOCH,
    );

    await manager.restoreSameEpoch();

    expect(fixture.windowRemove).toHaveBeenCalledWith(ASSIGNMENT.windowId);
    expect(manager.ownedWindows()).toEqual([]);
    expect(manager.closureOutbox()).toEqual([
      {
        sessionId: ASSIGNMENT.sessionId,
        leaseId: ASSIGNMENT.leaseId,
        leaseEpoch: ASSIGNMENT.leaseEpoch,
        browserEpoch: ASSIGNMENT.browserEpoch,
      },
    ]);
    expect(fixture.sessionSet).toHaveBeenCalledWith({
      "understudy:assignments": expect.objectContaining({
        ownedWindows: [expect.objectContaining({ leaseId: ASSIGNMENT.leaseId })],
      }),
    });
  });

  it("withholds the complete control inventory while any assignment is sensitive", async () => {
    const sessionState: Record<string, unknown> = {
      "understudy:assignments": {
        version: 4,
        assignments: [{ ...ASSIGNMENT, policyVersion: 1, sensitive: true }],
        ownedWindows: [{ ...ASSIGNMENT }],
        closedOutbox: [],
        vacatedLeases: [],
      },
    };
    installBrowser(
      sessionState,
      async () => {
        throw new Error("tab close failed");
      },
      async () => ({ id: ASSIGNMENT.tabId }),
    );
    const manager = new SessionManager(
      () => "https://service.example",
      () => EPOCH,
    );

    await manager.restoreSameEpoch();

    expect(manager.controlInventory()).toBeNull();
  });

  it("keeps control inventory suppressed when the sensitive-state write fails", async () => {
    const sessionState: Record<string, unknown> = {
      "understudy:assignments": {
        version: 4,
        assignments: [{ ...ASSIGNMENT, policyVersion: 1 }],
        ownedWindows: [{ ...ASSIGNMENT }],
        closedOutbox: [],
        vacatedLeases: [],
      },
    };
    const fixture = installBrowser(
      sessionState,
      async () => {
        throw new Error("tab close failed");
      },
      async () => ({ id: ASSIGNMENT.tabId }),
    );
    const manager = new SessionManager(
      () => "https://service.example",
      () => EPOCH,
    );
    await manager.restoreSameEpoch();
    const runtime = (
      manager as unknown as { byLease: Map<string, SessionRuntime> }
    ).byLease.get(ASSIGNMENT.leaseId);
    if (runtime === undefined) throw new Error("restored runtime missing");
    fixture.sessionSet.mockRejectedValueOnce(new Error("persist failed"));

    await expect(manager.enterSensitive(runtime)).rejects.toThrow("persist failed");

    expect(manager.assignments()).toEqual([
      expect.objectContaining({ sensitive: true }),
    ]);
    expect(manager.controlInventory()).toBeNull();
  });

  it("persists release intent before closing a sensitive window", async () => {
    const assignment = { ...ASSIGNMENT, policyVersion: 1 };
    const sessionState: Record<string, unknown> = {
      "understudy:assignments": {
        version: 4,
        assignments: [assignment],
        ownedWindows: [assignment],
        closedOutbox: [],
        vacatedLeases: [],
      },
    };
    const fixture = installBrowser(
      sessionState,
      async () => {},
      async (tabId) => ({ id: tabId }),
    );
    const manager = new SessionManager(
      () => "https://service.example",
      () => EPOCH,
    );
    await manager.restoreSameEpoch();
    const runtime = (
      manager as unknown as { byLease: Map<string, SessionRuntime> }
    ).byLease.get(ASSIGNMENT.leaseId);
    if (runtime === undefined) throw new Error("restored runtime missing");
    await manager.enterSensitive(runtime);
    const generalCleanup = vi.spyOn(runtime, "beginCleanup");
    fixture.sessionSet.mockRejectedValueOnce(new Error("release checkpoint failed"));

    await expect(manager.prepareSensitiveComplete(runtime)).rejects.toThrow(
      "release checkpoint failed",
    );

    expect(runtime.assignment.cleanupIntent).toBe("release");
    expect(generalCleanup).not.toHaveBeenCalled();
    expect(fixture.windowRemove).not.toHaveBeenCalled();
    await manager.retryCleanup();
    expect(fixture.windowRemove).toHaveBeenCalledWith(ASSIGNMENT.windowId);
    expect(manager.assignments()).toEqual([]);
    expect(manager.closureOutbox()).toEqual([
      expect.objectContaining({ leaseId: ASSIGNMENT.leaseId }),
    ]);
  });
});

function installBrowser(
  sessionState: Record<string, unknown>,
  remove: (tabId: number) => Promise<void>,
  get: (tabId: number) => Promise<unknown>,
  command: (
    target: unknown,
    method: string,
  ) => Promise<unknown> = async (_target, method) =>
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
): {
  remove: ReturnType<typeof vi.fn>;
  windowRemove: ReturnType<typeof vi.fn>;
  windowCreate: ReturnType<typeof vi.fn>;
  windowGetAll: ReturnType<typeof vi.fn>;
  tabUpdate: ReturnType<typeof vi.fn>;
  sessionSet: ReturnType<typeof vi.fn>;
  sendCommand: ReturnType<typeof vi.fn>;
  localState: Record<string, unknown>;
} {
  const removeMock = vi.fn(remove);
  const sessionSet = vi.fn(async (values: Record<string, unknown>) => {
    Object.assign(sessionState, values);
  });
  const localState: Record<string, unknown> = {};
  const localSet = vi.fn(async (values: Record<string, unknown>) => {
    Object.assign(localState, values);
  });
  const sendCommand = vi.fn(command);
  const windowRemove = vi.fn(remove);
  const windowCreate = vi.fn(async () => ({
    id: ASSIGNMENT.windowId,
    tabs: [{ id: ASSIGNMENT.tabId }],
  }));
  const windowGetAll = vi.fn(async () => [{ id: ASSIGNMENT.windowId }]);
  const tabUpdate = vi.fn(async (tabId: number) => ({ id: tabId, url: "about:blank" }));
  vi.stubGlobal("browser", {
    runtime: {
      getURL: (path: string) => new URL(path, "chrome-extension://understudy/").toString(),
    },
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: localState[key] })),
        set: localSet,
      },
      session: {
        get: vi.fn(async (key: string) => ({
          [key]: sessionState[key],
        })),
        set: sessionSet,
      },
    },
    debugger: {
      attach: vi.fn(async () => {}),
      detach: vi.fn(async () => {}),
      sendCommand,
    },
    tabs: {
      remove: removeMock,
      get: vi.fn(get),
      update: tabUpdate,
    },
    windows: {
      create: windowCreate,
      remove: windowRemove,
      getAll: windowGetAll,
    },
  });
  return {
    remove: removeMock,
    windowRemove,
    windowCreate,
    windowGetAll,
    tabUpdate,
    sessionSet,
    sendCommand,
    localState,
  };
}
