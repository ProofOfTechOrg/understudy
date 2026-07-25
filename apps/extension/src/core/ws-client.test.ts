import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReconnectingWs } from "./ws-client";

type Listener = (event: Event & { code?: number; data?: unknown }) => void;

class FakeWebSocket {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];

  readyState = 0;
  private readonly listeners = new Map<string, Listener[]>();

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(): void {}

  close(): void {
    this.emit("close", { code: 1000 });
  }

  emit(type: string, init: { code?: number; data?: unknown } = {}): void {
    const event = { type, ...init } as Event & { code?: number; data?: unknown };
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

describe("ReconnectingWs", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("does not reconnect after the backend replaces this extension with close code 4001", () => {
    const onClose = vi.fn();
    new ReconnectingWs(() => "ws://example.test/session", {
      onCommand: vi.fn(),
      onOpen: vi.fn(),
      onClose,
    });

    FakeWebSocket.instances[0]?.emit("close", { code: 4001 });
    vi.advanceTimersByTime(60_000);

    expect(onClose).toHaveBeenCalledOnce();
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("reconnects an ordinary close with backoff", () => {
    new ReconnectingWs(() => "ws://example.test/session", {
      onCommand: vi.fn(),
      onOpen: vi.fn(),
    });

    FakeWebSocket.instances[0]?.emit("close", { code: 1006 });
    vi.advanceTimersByTime(499);
    expect(FakeWebSocket.instances).toHaveLength(1);

    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });
});
