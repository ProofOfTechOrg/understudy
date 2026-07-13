import type { Event } from "@understudy/protocol";

interface WsHandlers {
  onCommand: (cmd: unknown) => void;
  onOpen: () => void;
  onClose?: () => void;
  onConnecting?: () => void;
}

const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 30_000;
// The browser WS API exposes no protocol ping frame to JS, so an app-level pong
// is the only lever; sending one under the MV3 SW's ~30s idle timeout keeps the
// worker alive as long as the socket stays open (chrome.alarms is the backstop
// for when the SW is evicted anyway — see entrypoints/background.ts).
const HEARTBEAT_MS = 22_000;

export class ReconnectingWs {
  private socket: WebSocket | null = null;
  private backoffMs = BACKOFF_BASE_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(
    private readonly getUrl: () => string,
    private readonly handlers: WsHandlers,
  ) {
    this.connect();
  }

  send(ev: Event): void {
    const socket = this.socket;
    if (socket !== null && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(ev));
    }
  }

  startHeartbeat(): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.send({ type: "pong" });
    }, HEARTBEAT_MS);
  }

  stop(): void {
    this.stopped = true;
    this.clearReconnect();
    this.clearHeartbeat();
    const socket = this.socket;
    this.socket = null;
    if (socket !== null) {
      try {
        socket.close();
      } catch {
        // already closing/closed
      }
    }
  }

  private connect(): void {
    if (this.stopped) return;
    this.handlers.onConnecting?.();
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.getUrl());
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.addEventListener("open", () => {
      this.backoffMs = BACKOFF_BASE_MS;
      this.handlers.onOpen();
      this.startHeartbeat();
    });

    socket.addEventListener("message", (ev) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
      } catch {
        return;
      }
      this.handlers.onCommand(parsed);
    });

    socket.addEventListener("close", () => {
      this.clearHeartbeat();
      if (this.socket === socket) this.socket = null;
      if (this.stopped) return;
      this.handlers.onClose?.();
      this.scheduleReconnect();
    });

    socket.addEventListener("error", () => {
      try {
        socket.close();
      } catch {
        // the close event drives reconnect
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    if (this.reconnectTimer !== null) return;
    const delayMs = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_CAP_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delayMs);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}
