import { afterEach, describe, expect, it, vi } from "vitest";
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

function stubBrowser(remove: () => Promise<void>, get = vi.fn()): void {
  vi.stubGlobal("browser", {
    storage: { session: {} },
    tabs: { remove: vi.fn(remove), get },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SessionRuntime close fencing", () => {
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
