import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceControlServerFrame } from "@understudy/protocol";
import { ProfileClient, type ProfileConfig } from "./profile-client";

const CONFIG: ProfileConfig = {
  serviceOrigin: "https://old.example",
  unattendedEnabled: true,
  deviceId: "00000000-0000-4000-8000-000000000001",
  deviceCredential: "old-credential",
  originPolicy: ["https://app.example"],
};
const EPOCH = "browser-epoch-1";

type Listener = (event: Event & { code?: number; data?: unknown }) => void;

class FakeWebSocket {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];

  readyState = 0;
  readonly sent: unknown[] = [];
  closeCount = 0;
  private readonly listeners = new Map<string, Listener[]>();

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(value: string): void {
    this.sent.push(JSON.parse(value));
  }

  close(code = 1000): void {
    this.closeCount += 1;
    this.readyState = 3;
    this.emit("close", { code });
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open");
  }

  message(frame: DeviceControlServerFrame): void {
    this.emit("message", { data: JSON.stringify(frame) });
  }

  emit(type: string, init: { code?: number; data?: unknown } = {}): void {
    const event = { type, ...init } as Event & {
      code?: number;
      data?: unknown;
    };
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

interface BrowserFixture {
  local: Record<string, unknown>;
  session: Record<string, unknown>;
  localArea: ReturnType<typeof storageArea>;
  sessionArea: ReturnType<typeof storageArea>;
  removeTab: ReturnType<typeof vi.fn>;
  getTab: ReturnType<typeof vi.fn>;
  createWindow: ReturnType<typeof vi.fn>;
}

function installBrowser(
  initial: {
    local?: Record<string, unknown>;
    session?: Record<string, unknown>;
  } = {},
): BrowserFixture {
  const local = { ...(initial.local ?? {}) };
  const session = { ...(initial.session ?? {}) };
  const localArea = storageArea(local);
  const sessionArea = storageArea(session);
  const removeTab = vi.fn(async () => {});
  const getTab = vi.fn(async (tabId: number) => ({
    id: tabId,
    url: "about:blank",
    title: "",
    active: false,
  }));
  const createWindow = vi.fn();
  const attachedTabs = new Set<number>();
  vi.stubGlobal("browser", {
    storage: { local: localArea, session: sessionArea },
    runtime: { getManifest: () => ({ version: "0.1.0" }) },
    debugger: {
      attach: vi.fn(async (target: { tabId: number }) => {
        attachedTabs.add(target.tabId);
      }),
      detach: vi.fn(async (target: { tabId: number }) => {
        attachedTabs.delete(target.tabId);
      }),
      sendCommand: vi.fn(
        async (target: { tabId: number }, method: string) => {
          if (
            method === "Page.getFrameTree" &&
            !attachedTabs.has(target.tabId)
          ) {
            throw new Error("debugger is not attached");
          }
          return method === "Page.getFrameTree"
            ? {
                frameTree: {
                  frame: {
                    id: "main-frame",
                    loaderId: "loader-1",
                    url: "about:blank",
                  },
                },
              }
            : {};
        },
      ),
    },
    tabs: { remove: removeTab, get: getTab },
    windows: { create: createWindow },
  });
  return {
    local,
    session,
    localArea,
    sessionArea,
    removeTab,
    getTab,
    createWindow,
  };
}

function storageArea(state: Record<string, unknown>) {
  return {
    get: vi.fn(async (keys: string | string[]) => {
      const requested = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(
        requested
          .filter((key) => key in state)
          .map((key) => [key, state[key]]),
      );
    }),
    set: vi.fn(async (values: Record<string, unknown>) => {
      Object.assign(state, values);
    }),
    remove: vi.fn(async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete state[key];
    }),
    setAccessLevel: vi.fn(async () => {}),
  };
}

function ticketResponse(
  status = 200,
  json: () => Promise<unknown> = async () => ({
    ticket: crypto.randomUUID(),
    websocketPath: "/agents/device/device",
  }),
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json,
  } as Response;
}

function persistedConfig(
  config: ProfileConfig,
): Record<string, unknown> {
  return {
    ...config,
    originPolicy: [...config.originPolicy],
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("navigator", { userAgent: "Chrome/125" });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("ProfileClient generation fencing", () => {
  it("does not construct a socket when disable supersedes a pending ticket fetch", async () => {
    installBrowser();
    let resolveFetch!: (response: Response) => void;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new ProfileClient();

    const configuring = client.configure(CONFIG);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await client.stopAll();
    resolveFetch(ticketResponse());
    await configuring;

    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(client.currentStatus()).toBe("disabled");
  });

  it("does not construct a socket when disable supersedes response parsing", async () => {
    installBrowser();
    let resolveJson!: (value: unknown) => void;
    const json = vi.fn(
      () =>
        new Promise<unknown>((resolve) => {
          resolveJson = resolve;
        }),
    );
    vi.stubGlobal("fetch", vi.fn(async () => ticketResponse(200, json)));
    const client = new ProfileClient();

    const configuring = client.configure(CONFIG);
    await vi.waitFor(() => expect(json).toHaveBeenCalledOnce());
    await client.stopAll();
    resolveJson({
      ticket: crypto.randomUUID(),
      websocketPath: "/agents/device/device",
    });
    await configuring;

    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("retries transient ticket failures exponentially and resets after open", async () => {
    installBrowser();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(ticketResponse(429))
      .mockResolvedValueOnce(ticketResponse(503))
      .mockResolvedValue(ticketResponse());
    vi.stubGlobal("fetch", fetchMock);
    const client = new ProfileClient();

    await client.configure(CONFIG);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(499);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(FakeWebSocket.instances).toHaveLength(1);

    FakeWebSocket.instances[0]?.open();
    FakeWebSocket.instances[0]?.emit("close", { code: 1006 });
    await vi.advanceTimersByTimeAsync(499);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("treats permanent ticket errors and replacement close as terminal", async () => {
    installBrowser();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(ticketResponse())
      .mockResolvedValue(ticketResponse(400));
    vi.stubGlobal("fetch", fetchMock);
    const client = new ProfileClient();
    await client.configure(CONFIG);
    FakeWebSocket.instances[0]?.open();
    FakeWebSocket.instances[0]?.emit("close", { code: 4001 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(client.currentStatus()).toBe("error");

    await client.configure({
      ...CONFIG,
      deviceCredential: "replacement-credential",
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(client.currentStatus()).toBe("error");
  });

  it("persists replacement fencing across alarms and service-worker restart until an explicit save", async () => {
    const fixture = installBrowser({
      session: { "understudy:browserEpoch": EPOCH },
    });
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        ticketResponse(),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new ProfileClient();
    await client.configure(CONFIG);
    FakeWebSocket.instances[0]?.open();

    FakeWebSocket.instances[0]?.emit("close", { code: 4001 });
    await vi.waitFor(() =>
      expect(fixture.local["understudy:controlBlock"]).toMatchObject({
        version: 1,
        reason: "replaced",
      }),
    );
    await client.ensureConnection();

    const restarted = new ProfileClient();
    await restarted.start();
    await restarted.ensureConnection();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(restarted.currentStatus()).toBe("error");

    await restarted.configure(CONFIG);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fixture.local["understudy:controlBlock"]).toBeNull();
  });

  it("lets an explicit save queued behind replacement cleanup clear the terminal latch", async () => {
    const fixture = installBrowser({
      session: { "understudy:browserEpoch": EPOCH },
    });
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL) => ticketResponse(),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new ProfileClient();
    await client.configure(CONFIG);
    FakeWebSocket.instances[0]?.open();

    FakeWebSocket.instances[0]?.emit("close", { code: 4001 });
    const replacement = {
      ...CONFIG,
      deviceCredential: "replacement-credential",
    };
    await client.configure(replacement);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fixture.local.deviceCredential).toBe("replacement-credential");
    expect(fixture.local["understudy:controlBlock"]).toBeNull();
    expect(client.currentStatus()).toBe("connecting");
  });

  it("completes epoch initialization before a concurrent configure request", async () => {
    const fixture = installBrowser({
      session: { "understudy:browserEpoch": EPOCH },
    });
    const originalGet = fixture.sessionArea.get.getMockImplementation();
    if (originalGet === undefined) throw new Error("storage get mock missing");
    let releaseEpoch!: () => void;
    const epochGate = new Promise<void>((resolve) => {
      releaseEpoch = resolve;
    });
    fixture.sessionArea.get.mockImplementation(
      async (keys: string | string[]) => {
        const requested = Array.isArray(keys) ? keys : [keys];
        if (requested.includes("understudy:browserEpoch")) await epochGate;
        return originalGet(keys);
      },
    );
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        ticketResponse(),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new ProfileClient();

    const starting = client.start();
    await vi.waitFor(() => expect(fixture.sessionArea.get).toHaveBeenCalled());
    const configuring = client.configure(CONFIG);
    releaseEpoch();
    await Promise.all([starting, configuring]);

    expect(client.browserEpoch()).toBe(EPOCH);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual({
      browserEpoch: EPOCH,
    });
  });

  it("restores ownership before a Stop All request that arrives during startup", async () => {
    const assignment = {
      sessionId: "session-startup",
      leaseId: "lease-startup",
      leaseEpoch: 1,
      browserEpoch: EPOCH,
      allowedOrigins: ["https://app.example"],
      tabId: 7,
      windowId: 3,
    };
    const fixture = installBrowser({
      local: persistedConfig(CONFIG),
      session: {
        "understudy:browserEpoch": EPOCH,
        "understudy:assignments": {
          version: 2,
          assignments: [assignment],
          closedOutbox: [],
        },
      },
    });
    const originalGet = fixture.sessionArea.get.getMockImplementation();
    if (originalGet === undefined) throw new Error("storage get mock missing");
    let releaseEpoch!: () => void;
    const epochGate = new Promise<void>((resolve) => {
      releaseEpoch = resolve;
    });
    fixture.sessionArea.get.mockImplementation(
      async (keys: string | string[]) => {
        const requested = Array.isArray(keys) ? keys : [keys];
        if (requested.includes("understudy:browserEpoch")) await epochGate;
        return originalGet(keys);
      },
    );
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        ticketResponse(),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new ProfileClient();

    const starting = client.start();
    await vi.waitFor(() => expect(fixture.sessionArea.get).toHaveBeenCalled());
    const stopping = client.stopAll();
    releaseEpoch();
    await Promise.all([starting, stopping]);

    expect(client.browserEpoch()).toBe(EPOCH);
    expect(fixture.removeTab).toHaveBeenCalledWith(assignment.tabId);
    expect(client.sessions.assignments()).toEqual([]);
    expect(client.sessions.vacatedLeases()).toEqual([]);
    expect(client.sessions.closureOutbox()).toEqual([
      {
        sessionId: assignment.sessionId,
        leaseId: assignment.leaseId,
        leaseEpoch: assignment.leaseEpoch,
        browserEpoch: assignment.browserEpoch,
      },
    ]);
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual({
      browserEpoch: EPOCH,
    });
  });

  it("rejects a ticket websocket URL that changes the configured service origin", async () => {
    installBrowser();
    const fetchMock = vi.fn(async () =>
      ticketResponse(200, async () => ({
        ticket: crypto.randomUUID(),
        websocketPath: "https://attacker.example/agents/device/device",
      })),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new ProfileClient();

    await client.configure(CONFIG);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(client.currentStatus()).toBe("error");
  });

  it("persists credential revocation and cancels all ticket reconnects", async () => {
    const fixture = installBrowser();
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL) => ticketResponse(),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new ProfileClient();
    await client.configure(CONFIG);
    const control = FakeWebSocket.instances[0];
    control?.open();

    control?.message({
      type: "credential_revoked",
    });
    await vi.waitFor(() => expect(client.currentStatus()).toBe("error"));
    await vi.advanceTimersByTimeAsync(60_000);

    expect(fixture.local.unattendedEnabled).toBe(false);
    expect(fixture.local["understudy:credentialRevoked"]).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("releases a provision that finishes after Stop All without acknowledging provision", async () => {
    const fixture = installBrowser({
      session: { "understudy:browserEpoch": EPOCH },
    });
    vi.stubGlobal("fetch", vi.fn(async () => ticketResponse()));
    let resolveWindow!: (window: unknown) => void;
    fixture.createWindow.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveWindow = resolve;
        }),
    );
    const client = new ProfileClient();
    await client.start();
    await client.configure(CONFIG);
    const hosting = FakeWebSocket.instances[0];
    hosting?.open();
    hosting?.message({
      type: "provision",
      sessionId: "session-1",
      leaseId: "lease-1",
      leaseEpoch: 1,
      browserEpoch: EPOCH,
      allowedOrigins: ["https://app.example"],
      sessionTicket: "session-ticket",
    });
    await vi.waitFor(() => expect(fixture.createWindow).toHaveBeenCalledOnce());

    await client.stopAll();
    resolveWindow({
      id: 3,
      tabs: [{ id: 7 }],
    });
    await vi.waitFor(() =>
      expect(FakeWebSocket.instances).toHaveLength(2),
    );
    const cleanup = FakeWebSocket.instances[1];
    cleanup?.open();
    await vi.waitFor(() =>
      expect(cleanup?.sent).toContainEqual({
        type: "closed",
        sessionId: "session-1",
        leaseId: "lease-1",
        leaseEpoch: 1,
        browserEpoch: EPOCH,
      }),
    );

    expect(hosting?.sent).not.toContainEqual(
      expect.objectContaining({ type: "provisioned" }),
    );
    expect(
      FakeWebSocket.instances.filter((socket) =>
        socket.url.includes("/agents/session/"),
      ),
    ).toHaveLength(0);
  });

  it("clears a profile durably when disabled profile persistence keeps failing", async () => {
    const fixture = installBrowser({
      session: { "understudy:browserEpoch": EPOCH },
    });
    fixture.createWindow.mockResolvedValue({
      id: 3,
      tabs: [{ id: 7 }],
    });
    vi.stubGlobal("fetch", vi.fn(async () => ticketResponse()));
    const client = new ProfileClient();
    await client.configure(CONFIG);
    const control = FakeWebSocket.instances[0];
    control?.open();
    control?.message({
      type: "provision",
      sessionId: "session-1",
      leaseId: "lease-1",
      leaseEpoch: 1,
      browserEpoch: EPOCH,
      allowedOrigins: ["https://app.example"],
      sessionTicket: "session-ticket",
    });
    await vi.waitFor(() =>
      expect(control?.sent).toContainEqual(
        expect.objectContaining({ type: "provisioned" }),
      ),
    );
    const sessionSocket = FakeWebSocket.instances.find((socket) =>
      socket.url.includes("/agents/session/"),
    );
    if (sessionSocket === undefined) throw new Error("session socket missing");
    fixture.localArea.set.mockRejectedValue(new Error("profile write failed"));

    const stopping = client.stopAll();

    expect(sessionSocket.closeCount).toBe(1);
    expect(client.sessions.assignments()).toEqual([
      expect.objectContaining({ cleanupIntent: "release" }),
    ]);
    await expect(stopping).resolves.toBeUndefined();
    expect(client.sessions.assignments()).toEqual([]);
    expect(fixture.local.serviceOrigin).toBeUndefined();
    expect(fixture.local.unattendedEnabled).toBeUndefined();

    const socketCount = FakeWebSocket.instances.length;
    const restarted = new ProfileClient();
    await restarted.start();
    expect(restarted.publicConfig()).toBeNull();
    expect(restarted.currentStatus()).toBe("disabled");
    expect(FakeWebSocket.instances).toHaveLength(socketCount);
  });

  it("fences replacement work before hashing or profile persistence", async () => {
    const fixture = installBrowser({
      session: { "understudy:browserEpoch": EPOCH },
    });
    fixture.createWindow.mockResolvedValue({
      id: 3,
      tabs: [{ id: 7 }],
    });
    vi.stubGlobal("fetch", vi.fn(async () => ticketResponse()));
    const client = new ProfileClient();
    await client.configure(CONFIG);
    const control = FakeWebSocket.instances[0];
    control?.open();
    control?.message({
      type: "provision",
      sessionId: "session-1",
      leaseId: "lease-1",
      leaseEpoch: 1,
      browserEpoch: EPOCH,
      allowedOrigins: ["https://app.example"],
      sessionTicket: "session-ticket",
    });
    await vi.waitFor(() =>
      expect(control?.sent).toContainEqual(
        expect.objectContaining({ type: "provisioned" }),
      ),
    );
    const sessionSocket = FakeWebSocket.instances.find((socket) =>
      socket.url.includes("/agents/session/"),
    );
    if (sessionSocket === undefined) throw new Error("session socket missing");
    let releaseHash!: () => void;
    const hashGate = new Promise<void>((resolve) => {
      releaseHash = resolve;
    });
    const digest = vi
      .spyOn(crypto.subtle, "digest")
      .mockImplementation(async () => {
        await hashGate;
        return new Uint8Array(32).buffer;
      });
    const writesBefore = fixture.localArea.set.mock.calls.length;
    const replacement = {
      ...CONFIG,
      serviceOrigin: "https://new.example",
      deviceCredential: "new-credential",
    };

    const configuring = client.configure(replacement);

    expect(sessionSocket.closeCount).toBe(1);
    expect(digest).not.toHaveBeenCalled();
    expect(fixture.localArea.set).toHaveBeenCalledTimes(writesBefore);
    await vi.waitFor(() => expect(digest).toHaveBeenCalledOnce());
    expect(fixture.localArea.set).toHaveBeenCalledTimes(writesBefore);
    releaseHash();
    await configuring;
  });

  it("keeps a credential-revoked runtime fenced when profile persistence fails", async () => {
    const fixture = installBrowser({
      session: { "understudy:browserEpoch": EPOCH },
    });
    fixture.createWindow.mockResolvedValue({
      id: 3,
      tabs: [{ id: 7 }],
    });
    vi.stubGlobal("fetch", vi.fn(async () => ticketResponse()));
    const client = new ProfileClient();
    await client.configure(CONFIG);
    const control = FakeWebSocket.instances[0];
    control?.open();
    control?.message({
      type: "provision",
      sessionId: "session-1",
      leaseId: "lease-1",
      leaseEpoch: 1,
      browserEpoch: EPOCH,
      allowedOrigins: ["https://app.example"],
      sessionTicket: "session-ticket",
    });
    await vi.waitFor(() =>
      expect(control?.sent).toContainEqual(
        expect.objectContaining({ type: "provisioned" }),
      ),
    );
    const sessionSocket = FakeWebSocket.instances.find((socket) =>
      socket.url.includes("/agents/session/"),
    );
    if (sessionSocket === undefined) throw new Error("session socket missing");
    fixture.localArea.set.mockRejectedValueOnce(new Error("profile write failed"));

    control?.message({ type: "credential_revoked" });

    await vi.waitFor(() => expect(sessionSocket.closeCount).toBe(1));
    expect(client.sessions.assignments()).toEqual([
      expect.objectContaining({ cleanupIntent: "discard" }),
    ]);
  });
});

describe("ProfileClient startup cleanup", () => {
  it("retries initialization after a startup failure", async () => {
    const fixture = installBrowser({
      session: { "understudy:browserEpoch": EPOCH },
    });
    fixture.localArea.setAccessLevel.mockRejectedValueOnce(
      new Error("storage unavailable"),
    );
    const client = new ProfileClient();

    await expect(client.start()).rejects.toThrow("storage unavailable");
    await expect(client.start()).resolves.toBeUndefined();

    expect(fixture.localArea.setAccessLevel).toHaveBeenCalledTimes(2);
    expect(client.currentStatus()).toBe("disabled");
  });

  it("rejects configuration outside a build-pinned service origin", () => {
    const fixture = installBrowser();
    const client = new ProfileClient(
      undefined,
      "https://understudy.proofof.tech",
    );

    expect(() => client.configure(CONFIG)).toThrow(
      "profile service origin is not allowed in this build",
    );
    expect(fixture.localArea.set).not.toHaveBeenCalled();
  });

  it("discards a persisted profile outside a build-pinned service origin", async () => {
    const fixture = installBrowser({
      local: persistedConfig(CONFIG),
      session: { "understudy:browserEpoch": EPOCH },
    });
    const fetchMock = vi.fn(async () => ticketResponse());
    vi.stubGlobal("fetch", fetchMock);
    const client = new ProfileClient(
      undefined,
      "https://understudy.proofof.tech",
    );

    await client.start();

    expect(client.publicConfig()).toBeNull();
    expect(client.currentStatus()).toBe("disabled");
    expect(fixture.local.serviceOrigin).toBeUndefined();
    expect(fixture.local.deviceCredential).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("retains and resends a closure until the backend acknowledges its exact fence", async () => {
    const closure = {
      sessionId: "session-closed",
      leaseId: "lease-closed",
      leaseEpoch: 2,
      browserEpoch: EPOCH,
    };
    const fixture = installBrowser({
      local: persistedConfig({ ...CONFIG, unattendedEnabled: false }),
      session: {
        "understudy:browserEpoch": EPOCH,
        "understudy:assignments": {
          version: 3,
          assignments: [],
          closedOutbox: [closure],
          vacatedLeases: [],
        },
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => ticketResponse()));
    const client = new ProfileClient();
    await client.start();
    const first = FakeWebSocket.instances[0];
    first?.open();
    await vi.waitFor(() =>
      expect(first?.sent).toContainEqual({ type: "closed", ...closure }),
    );
    expect(client.sessions.closureOutbox()).toEqual([closure]);

    first?.emit("close", { code: 1006 });
    await vi.advanceTimersByTimeAsync(500);
    expect(FakeWebSocket.instances).toHaveLength(2);
    const second = FakeWebSocket.instances[1];
    second?.open();
    await vi.waitFor(() =>
      expect(second?.sent).toContainEqual({ type: "closed", ...closure }),
    );
    expect(client.sessions.closureOutbox()).toEqual([closure]);

    second?.message({ type: "closed_ack", ...closure });
    await vi.waitFor(() => expect(client.sessions.closureOutbox()).toEqual([]));
    expect(
      (
        fixture.session["understudy:assignments"] as {
          closedOutbox: unknown[];
        }
      ).closedOutbox,
    ).toEqual([]);
    await vi.waitFor(() => expect(client.currentStatus()).toBe("disabled"));
  });

  it("consumes a vacated lease only after its replacement runtime is installed", async () => {
    const vacated = {
      sessionId: "session-vacated",
      leaseId: "lease-vacated",
      leaseEpoch: 2,
      browserEpoch: EPOCH,
    };
    const fixture = installBrowser({
      local: persistedConfig(CONFIG),
      session: {
        "understudy:browserEpoch": EPOCH,
        "understudy:assignments": {
          version: 3,
          assignments: [],
          closedOutbox: [],
          vacatedLeases: [vacated],
        },
      },
    });
    fixture.createWindow.mockResolvedValue({
      id: 3,
      tabs: [{ id: 7 }],
    });
    vi.stubGlobal("fetch", vi.fn(async () => ticketResponse()));
    const client = new ProfileClient();
    await client.start();
    const control = FakeWebSocket.instances[0];
    control?.open();

    control?.message({
      type: "provision",
      ...vacated,
      allowedOrigins: ["https://app.example"],
      sessionTicket: "session-ticket",
    });

    await vi.waitFor(() =>
      expect(control?.sent).toContainEqual(
        expect.objectContaining({
          type: "provisioned",
          sessionId: vacated.sessionId,
          leaseId: vacated.leaseId,
        }),
      ),
    );
    expect(client.sessions.vacatedLeases()).toEqual([]);
    expect(client.sessions.assignments()).toEqual([
      expect.objectContaining({
        sessionId: vacated.sessionId,
        leaseId: vacated.leaseId,
      }),
    ]);
  });

  it("promotes a vacated lease through the old profile before committing a replacement", async () => {
    const vacated = {
      sessionId: "session-vacated",
      leaseId: "lease-vacated",
      leaseEpoch: 2,
      browserEpoch: EPOCH,
    };
    const fixture = installBrowser({
      local: persistedConfig(CONFIG),
      session: {
        "understudy:browserEpoch": EPOCH,
        "understudy:assignments": {
          version: 3,
          assignments: [],
          closedOutbox: [],
          vacatedLeases: [vacated],
        },
      },
    });
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL) => ticketResponse(),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new ProfileClient();
    await client.start();
    const hosting = FakeWebSocket.instances[0];
    hosting?.open();

    const replacement: ProfileConfig = {
      ...CONFIG,
      serviceOrigin: "https://new.example",
      deviceCredential: "new-credential",
    };
    await client.configure(replacement);
    const cleanup = FakeWebSocket.instances[1];
    cleanup?.open();

    await vi.waitFor(() =>
      expect(cleanup?.sent).toContainEqual({ type: "closed", ...vacated }),
    );
    expect(client.sessions.closureOutbox()).toEqual([vacated]);
    expect(FakeWebSocket.instances).toHaveLength(2);
    cleanup?.message({ type: "closed_ack", ...vacated });
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(3));
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://old.example/v1/device/connect-ticket",
      "https://old.example/v1/device/connect-ticket",
      "https://new.example/v1/device/connect-ticket",
    ]);
    expect(fixture.local.serviceOrigin).toBe("https://new.example");
  });

  it("discards local ownership without ticket churn after durable credential revocation", async () => {
    const assignment = {
      sessionId: "session-1",
      leaseId: "lease-1",
      leaseEpoch: 1,
      browserEpoch: EPOCH,
      allowedOrigins: ["https://app.example"],
      tabId: 7,
      windowId: 3,
    };
    const fixture = installBrowser({
      local: {
        ...persistedConfig({ ...CONFIG, unattendedEnabled: false }),
        "understudy:credentialRevoked": true,
      },
      session: {
        "understudy:browserEpoch": EPOCH,
        "understudy:assignments": {
          version: 2,
          assignments: [assignment],
          closedOutbox: [
            {
              sessionId: assignment.sessionId,
              leaseId: assignment.leaseId,
              leaseEpoch: assignment.leaseEpoch,
              browserEpoch: assignment.browserEpoch,
            },
          ],
        },
      },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const client = new ProfileClient();

    await client.start();

    expect(fixture.removeTab).toHaveBeenCalledWith(assignment.tabId);
    expect(client.sessions.assignments()).toEqual([]);
    expect(client.sessions.closureOutbox()).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(client.currentStatus()).toBe("error");
  });

  it("releases same-epoch assignments while the persisted profile is disabled", async () => {
    const assignment = {
      sessionId: "session-1",
      leaseId: "lease-1",
      leaseEpoch: 1,
      browserEpoch: EPOCH,
      allowedOrigins: ["https://app.example"],
      tabId: 7,
      windowId: 3,
    };
    const fixture = installBrowser({
      local: persistedConfig({ ...CONFIG, unattendedEnabled: false }),
      session: {
        "understudy:browserEpoch": EPOCH,
        "understudy:assignments": [assignment],
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => ticketResponse()));
    const client = new ProfileClient();

    await client.start();
    expect(fixture.removeTab).toHaveBeenCalledWith(7);
    expect(FakeWebSocket.instances).toHaveLength(1);
    FakeWebSocket.instances[0]?.open();
    await vi.waitFor(() =>
      expect(FakeWebSocket.instances[0]?.sent).toContainEqual({
        type: "closed",
        sessionId: "session-1",
        leaseId: "lease-1",
        leaseEpoch: 1,
        browserEpoch: EPOCH,
      }),
    );
    expect(client.sessions.closureOutbox()).toHaveLength(1);
    FakeWebSocket.instances[0]?.message({
      type: "closed_ack",
      sessionId: "session-1",
      leaseId: "lease-1",
      leaseEpoch: 1,
      browserEpoch: EPOCH,
    });
    await vi.waitFor(() =>
      expect(client.currentStatus()).toBe("disabled"),
    );
  });

  it("keeps an offline replacement staged behind the old cleanup identity", async () => {
    const assignment = {
      sessionId: "session-1",
      leaseId: "lease-1",
      leaseEpoch: 1,
      browserEpoch: EPOCH,
      allowedOrigins: ["https://app.example"],
      tabId: 7,
      windowId: 3,
    };
    const fixture = installBrowser({
      local: persistedConfig(CONFIG),
      session: {
        "understudy:browserEpoch": EPOCH,
        "understudy:assignments": [assignment],
      },
    });
    fixture.removeTab.mockRejectedValue(new Error("tab still exists"));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(ticketResponse())
      .mockRejectedValue(new Error("old control offline"));
    vi.stubGlobal("fetch", fetchMock);
    const client = new ProfileClient();
    await client.start();
    expect(FakeWebSocket.instances).toHaveLength(1);

    fixture.removeTab.mockResolvedValue(undefined);
    const replacement: ProfileConfig = {
      ...CONFIG,
      serviceOrigin: "https://new.example",
      deviceCredential: "new-credential",
    };
    await client.configure(replacement);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "https://old.example/v1/device/connect-ticket",
    );
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(client.publicConfig()).toMatchObject({
      serviceOrigin: "https://old.example",
      unattendedEnabled: false,
    });
    expect(fixture.local.serviceOrigin).toBe("https://old.example");
    expect(fixture.local.unattendedEnabled).toBe(false);
    expect(fixture.local["understudy:stagedProfile"]).toEqual(replacement);
    expect(client.sessions.closureOutbox()).toHaveLength(1);
  });

  it("promotes a replacement only after an exact durable closure acknowledgement", async () => {
    const assignment = {
      sessionId: "session-1",
      leaseId: "lease-1",
      leaseEpoch: 1,
      browserEpoch: EPOCH,
      allowedOrigins: ["https://app.example"],
      tabId: 7,
      windowId: 3,
    };
    const fixture = installBrowser({
      local: persistedConfig(CONFIG),
      session: {
        "understudy:browserEpoch": EPOCH,
        "understudy:assignments": [assignment],
      },
    });
    fixture.removeTab.mockRejectedValueOnce(new Error("tab still exists"));
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) =>
      ticketResponse(),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new ProfileClient();
    await client.start();

    fixture.removeTab.mockResolvedValue(undefined);
    const replacement: ProfileConfig = {
      ...CONFIG,
      serviceOrigin: "https://new.example",
      deviceCredential: "new-credential",
    };
    await client.configure(replacement);

    expect(fixture.local.serviceOrigin).toBe(CONFIG.serviceOrigin);
    expect(fixture.local.unattendedEnabled).toBe(false);
    expect(fixture.local["understudy:stagedProfile"]).toEqual(replacement);
    expect(FakeWebSocket.instances).toHaveLength(2);

    const cleanup = FakeWebSocket.instances[1];
    cleanup?.open();
    await vi.waitFor(() =>
      expect(cleanup?.sent).toContainEqual({
        type: "closed",
        sessionId: assignment.sessionId,
        leaseId: assignment.leaseId,
        leaseEpoch: assignment.leaseEpoch,
        browserEpoch: assignment.browserEpoch,
      }),
    );
    expect(client.sessions.closureOutbox()).toHaveLength(1);
    cleanup?.message({
      type: "closed_ack",
      sessionId: assignment.sessionId,
      leaseId: assignment.leaseId,
      leaseEpoch: assignment.leaseEpoch + 1,
      browserEpoch: assignment.browserEpoch,
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(client.sessions.closureOutbox()).toHaveLength(1);
    expect(FakeWebSocket.instances).toHaveLength(2);

    cleanup?.message({
      type: "closed_ack",
      sessionId: assignment.sessionId,
      leaseId: assignment.leaseId,
      leaseEpoch: assignment.leaseEpoch,
      browserEpoch: assignment.browserEpoch,
    });
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(3));
    expect(client.sessions.closureOutbox()).toEqual([]);
    expect(
      (
        fixture.session["understudy:assignments"] as {
          closedOutbox: unknown[];
        }
      ).closedOutbox,
    ).toEqual([]);

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://old.example/v1/device/connect-ticket",
      "https://old.example/v1/device/connect-ticket",
      "https://new.example/v1/device/connect-ticket",
    ]);
    expect(fixture.local.serviceOrigin).toBe(replacement.serviceOrigin);
    expect(fixture.local.unattendedEnabled).toBe(true);
    expect(fixture.local["understudy:stagedProfile"]).toBeNull();
  });

  it("rejects provisions and session tickets on cleanup-only connectivity", async () => {
    const assignment = {
      sessionId: "session-1",
      leaseId: "lease-1",
      leaseEpoch: 1,
      browserEpoch: EPOCH,
      allowedOrigins: ["https://app.example"],
      tabId: 7,
      windowId: 3,
      cleanupIntent: "release",
    };
    const fixture = installBrowser({
      local: persistedConfig({ ...CONFIG, unattendedEnabled: false }),
      session: {
        "understudy:browserEpoch": EPOCH,
        "understudy:assignments": {
          version: 2,
          assignments: [assignment],
          closedOutbox: [],
        },
      },
    });
    fixture.removeTab.mockRejectedValue(new Error("tab still exists"));
    vi.stubGlobal("fetch", vi.fn(async () => ticketResponse()));
    const client = new ProfileClient();

    await client.start();
    const cleanup = FakeWebSocket.instances[0];
    cleanup?.open();
    cleanup?.message({
      type: "provision",
      sessionId: "session-2",
      leaseId: "lease-2",
      leaseEpoch: 1,
      browserEpoch: EPOCH,
      allowedOrigins: ["https://app.example"],
      sessionTicket: "session-ticket-2",
    });
    cleanup?.message({
      type: "session_ticket",
      sessionId: "session-1",
      leaseId: "lease-1",
      leaseEpoch: 1,
      browserEpoch: EPOCH,
      sessionTicket: "replacement-ticket",
    });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(fixture.createWindow).not.toHaveBeenCalled();
    expect(
      FakeWebSocket.instances.filter((socket) =>
        socket.url.includes("/agents/session/"),
      ),
    ).toHaveLength(0);
    expect(client.sessions.assignments()).toEqual([
      expect.objectContaining({ cleanupIntent: "release" }),
    ]);
  });
});
