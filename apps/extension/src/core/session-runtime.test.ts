import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionStorageArea } from "./dedupe";
import { SessionRuntime, type RuntimeAssignment, type RuntimeHost } from "./session-runtime";

const ASSIGNMENT: RuntimeAssignment = {
  sessionId: "session-1",
  leaseId: "lease-1",
  leaseEpoch: 1,
  browserEpoch: "epoch-1",
  allowedOrigins: ["https://example.com"],
  tabId: 7,
  windowId: 3,
};

function host(): RuntimeHost & { onFenced: ReturnType<typeof vi.fn> } {
  return {
    serviceOrigin: () => "https://understudy.example",
    browserEpoch: () => "epoch-1",
    isCurrent: () => true,
    onFenced: vi.fn(async () => {}),
    onTabChanged: vi.fn(async () => {}),
  };
}

function stubBrowser(
  remove: () => Promise<void>,
  get = vi.fn(),
  storage: SessionStorageArea = {
    get: vi.fn(async () => ({})),
    set: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
  },
): void {
  vi.stubGlobal("browser", {
    storage: { session: storage },
    tabs: { remove: vi.fn(remove), get },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SessionRuntime close fencing", () => {
  it("never downgrades release or discard cleanup ownership", () => {
    stubBrowser(async () => {});
    const release = new SessionRuntime(
      { ...ASSIGNMENT, cleanupIntent: "release" },
      host(),
    );
    release.beginCleanup("recover");
    expect(release.assignment.cleanupIntent).toBe("release");

    const discard = new SessionRuntime(
      { ...ASSIGNMENT, cleanupIntent: "discard" },
      host(),
    );
    discard.beginCleanup("release");
    expect(discard.assignment.cleanupIntent).toBe("discard");
  });

  it("does not let an intentional debugger detach revoke ownership before tab removal", async () => {
    let confirmRemoval!: () => void;
    stubBrowser(
      () =>
        new Promise<void>((resolve) => {
          confirmRemoval = resolve;
        }),
    );
    const runtimeHost = host();
    const runtime = new SessionRuntime(ASSIGNMENT, runtimeHost);

    const closing = runtime.close(true);
    await runtime.onDebuggerDetach();
    expect(runtimeHost.onFenced).not.toHaveBeenCalled();
    confirmRemoval();
    await expect(closing).resolves.toBe(true);
  });

  it("refuses to confirm cleanup when Chrome reports the owned tab still exists", async () => {
    stubBrowser(
      async () => {
        throw new Error("remove failed");
      },
      vi.fn(async () => ({ id: ASSIGNMENT.tabId })),
    );
    const runtime = new SessionRuntime(ASSIGNMENT, host());

    await expect(runtime.close(true)).resolves.toBe(false);
  });
});

describe("SessionRuntime dialog handling", () => {
  it("answers Page.handleJavaScriptDialog without waiting for a stalled outbox write", async () => {
    let markSetStarted!: () => void;
    const setStarted = new Promise<void>((resolve) => {
      markSetStarted = resolve;
    });
    let releaseSet!: () => void;
    const setBlocked = new Promise<void>((resolve) => {
      releaseSet = resolve;
    });
    const values: Record<string, unknown> = {};
    const storage: SessionStorageArea = {
      get: vi.fn(async (key: string) => ({ [key]: values[key] })),
      set: vi.fn(async (items: Record<string, unknown>) => {
        markSetStarted();
        await setBlocked;
        Object.assign(values, items);
      }),
      remove: vi.fn(async (key: string) => {
        delete values[key];
      }),
    };
    stubBrowser(async () => {}, vi.fn(), storage);
    const runtime = new SessionRuntime(ASSIGNMENT, host());
    const cdpSend = vi.fn(async () => {});
    const send = vi.fn();
    Object.assign(runtime, {
      cdp: {
        currentUrl: "https://example.com/",
        mainFrameId: "main",
        send: cdpSend,
      },
      send,
    });

    const handling = runtime.onCdpEvent("Page.javascriptDialogOpening", {
      type: "confirm",
      message: "Continue?",
      url: "https://example.com/",
    });
    await setStarted;

    expect(cdpSend).toHaveBeenCalledWith("Page.handleJavaScriptDialog", {
      accept: false,
    });
    expect(send).not.toHaveBeenCalled();

    releaseSet();
    await handling;
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "dialog",
        dialogType: "confirm",
        disposition: "dismiss",
      }),
    );
  });
});
