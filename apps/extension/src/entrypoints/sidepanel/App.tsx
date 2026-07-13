import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import type { Browser } from "wxt/browser";
import type { AttachedTab, LogEntry, PanelMsg, SwMsg } from "../../messaging";

const DEFAULT_WS_URL = "ws://localhost:8787";
const WS_URL_STORAGE_KEY = "local:wsUrl";
const RECONNECT_DELAY_MS = 500;

type StateSnapshot = Extract<SwMsg, { type: "state" }>;

export function App(): ReactElement {
  const [swState, setSwState] = useState<StateSnapshot | null>(null);
  const [seedWsUrl, setSeedWsUrl] = useState<string>(DEFAULT_WS_URL);
  const portRef = useRef<Browser.runtime.Port | null>(null);

  const send = (msg: PanelMsg): void => {
    try {
      portRef.current?.postMessage(msg);
    } catch (cause) {
      console.warn("understudy: failed to send panel message", cause);
    }
  };

  // Seed the wsUrl field from persisted storage so it has a sensible value
  // before the first streamed `state` message arrives; state.wsUrl is the
  // single source of truth once it does.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const stored = await storage.getItem<string>(WS_URL_STORAGE_KEY, {
          fallback: DEFAULT_WS_URL,
        });
        if (!cancelled) setSeedWsUrl(stored);
      } catch (cause) {
        console.warn("understudy: failed to read stored wsUrl", cause);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Port connection lifecycle (DL-008): connect on mount; on an
  // eviction-driven disconnect, reconnect (which wakes the SW) and
  // re-request state, without a manual reload.
  useEffect(() => {
    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

    const connect = (): void => {
      if (disposed) return;
      const port = browser.runtime.connect({ name: "panel" });
      portRef.current = port;
      port.onMessage.addListener((raw) => {
        const msg = raw as SwMsg;
        if (msg.type === "state") {
          setSwState(msg);
        } else {
          setSwState((prev) =>
            prev === null ? prev : { ...prev, logs: [...prev.logs, msg.entry] },
          );
        }
      });
      port.onDisconnect.addListener(() => {
        if (portRef.current === port) portRef.current = null;
        if (disposed) return;
        reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
      });
      send({ type: "getState" });
    };

    connect();

    return () => {
      disposed = true;
      clearTimeout(reconnectTimer);
      portRef.current?.disconnect();
      portRef.current = null;
    };
  }, []);

  const wsStatus: StateSnapshot["wsStatus"] = swState?.wsStatus ?? "connecting";
  const wsUrl: string = swState?.wsUrl ?? seedWsUrl;
  const attached: AttachedTab | null = swState?.attached ?? null;
  const logs: LogEntry[] = swState?.logs ?? [];

  const commitWsUrl = (rawUrl: string): void => {
    const trimmed = rawUrl.trim();
    if (trimmed.length === 0 || trimmed === wsUrl) return;
    send({ type: "setWsUrl", url: trimmed });
  };

  return (
    <div className="panel">
      <header className="panel-header">
        <h1>understudy</h1>
        <span className={`status-pill status-${wsStatus}`}>{wsStatus}</span>
      </header>

      <section className="field">
        <label htmlFor="ws-url">WebSocket URL</label>
        <input
          id="ws-url"
          key={wsUrl}
          type="text"
          defaultValue={wsUrl}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          onBlur={(event) => commitWsUrl(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
        />
      </section>

      <section className="attach">
        {attached === null ? (
          <button type="button" onClick={() => send({ type: "attach" })}>
            Attach
          </button>
        ) : (
          <>
            <button type="button" onClick={() => send({ type: "detach" })}>
              Detach
            </button>
            <p className="attach-banner">
              This tab is being controlled by understudy — the yellow "being debugged" banner is
              expected.
            </p>
            <p className="attach-info">
              {attached.title ?? "Untitled tab"}
              {attached.url ? ` — ${attached.url}` : ""}
            </p>
          </>
        )}
      </section>

      <section className="log">
        <h2>Log</h2>
        <ul className="log-list">
          {logs.map((entry, index) => (
            <li key={index} className={entry.level ? `log-${entry.level}` : undefined}>
              <span className="log-time">{formatTimestamp(entry.timestamp)}</span>
              <span className="log-message">{entry.message}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function formatTimestamp(ms: number): string {
  return new Date(ms).toLocaleTimeString();
}
