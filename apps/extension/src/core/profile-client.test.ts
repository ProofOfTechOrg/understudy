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
  vi.stubGlobal("browser", {
    storage: { local: localArea, session: sessionArea },
    runtime: { getManifest: () => ({ version: "0.1.0" }) },
    debugger: {
      getTargets: vi.fn(async () => []),
      attach: vi.fn(async () => {}),
      detach: vi.fn(async () => {}),
      sendCommand: vi.fn(async () => ({})),
    },
    tabs: { remove: removeTab, get: getTab },
    windows: { create: createWindow },
  });
  return { local, session, removeTab, getTab, createWindow };
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
    const fetchMock = vi.fn(async () => ticketResponse());
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
});

describe("ProfileClient startup cleanup", () => {
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

  it("promotes a replacement only after the old control queues its closure frame", async () => {
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
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(3));

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
