import { useEffect, useRef, useState } from "react";
import type { FormEvent, ReactElement } from "react";
import type { Browser } from "wxt/browser";
import type {
  AttachedTab,
  LogEntry,
  PairingState,
  PanelMsg,
  ProfileBlockReason,
  SwMsg,
} from "../../messaging";

const DEFAULT_WS_URL = "ws://localhost:8787";
const WS_URL_STORAGE_KEY = "session:wsUrl";
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

  useEffect(() => {
    let cancelled = false;
    void storage
      .getItem<string>(WS_URL_STORAGE_KEY, { fallback: DEFAULT_WS_URL })
      .then((stored) => {
        if (!cancelled) setSeedWsUrl(stored);
      })
      .catch((cause: unknown) => {
        console.warn("understudy: failed to read stored wsUrl", cause);
      });
    return () => {
      cancelled = true;
    };
  }, []);

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
          setSwState((previous) =>
            previous === null
              ? previous
              : { ...previous, logs: [...previous.logs, msg.entry] },
          );
        }
      });
      port.onDisconnect.addListener(() => {
        if (portRef.current === port) portRef.current = null;
        if (disposed) return;
        reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
      });
      port.postMessage({ type: "getState" } satisfies PanelMsg);
    };

    connect();
    return () => {
      disposed = true;
      clearTimeout(reconnectTimer);
      portRef.current?.disconnect();
      portRef.current = null;
    };
  }, []);

  const wsStatus = swState?.wsStatus ?? "connecting";
  const wsUrl = swState?.wsUrl ?? seedWsUrl;
  const attached = swState?.attached ?? null;
  const profileStatus = swState?.profileStatus ?? "disabled";
  const profileStatusReason = swState?.profileStatusReason;
  const pairing = swState?.pairing ?? null;
  const controlledTabs = swState?.controlledTabs ?? 0;
  const profileConfig = swState?.profileConfig ?? null;
  const logs = swState?.logs ?? [];
  const formKey = JSON.stringify(profileConfig);

  const commitWsUrl = (rawUrl: string): void => {
    const trimmed = rawUrl.trim();
    if (trimmed.length === 0 || trimmed === wsUrl) return;
    send({ type: "setWsUrl", url: trimmed });
  };

  const submitPairing = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const code = String(data.get("pairingCode") ?? "").trim();
    if (code.length === 0) return;
    send({ type: "pair", code });
    const input = event.currentTarget.elements.namedItem("pairingCode");
    if (input instanceof HTMLInputElement) input.value = "";
  };

  const configureProfile = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const originPolicy = String(data.get("originPolicy") ?? "")
      .split(/\r?\n/)
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0);
    send({
      type: "configureProfile",
      serviceOrigin: String(data.get("serviceOrigin") ?? "").trim(),
      deviceId: String(data.get("deviceId") ?? "").trim(),
      deviceCredential: String(data.get("deviceCredential") ?? ""),
      originPolicy,
      enabled: data.get("enabled") === "on",
    });
    const credential = event.currentTarget.elements.namedItem("deviceCredential");
    if (credential instanceof HTMLInputElement) credential.value = "";
  };

  return (
    <main className="panel">
      <header className="masthead">
        <div>
          <p className="eyebrow">Browser control plane</p>
          <h1>Understudy</h1>
        </div>
        <span className={`status status-${profileStatus}`} aria-live="polite">
          {profileStatus}
        </span>
      </header>

      <section className="capacity-strip" aria-label="Unattended host capacity">
        <div>
          <span className="metric">{controlledTabs}</span>
          <span className="metric-total"> / 2</span>
        </div>
        <p>controlled tabs</p>
        <span className={`signal signal-${profileStatus}`} aria-hidden="true" />
      </section>

      <section className="card">
        <div className="section-heading">
          <div>
            <p className="section-index">00</p>
            <h2>Pair with your account</h2>
          </div>
        </div>
        <form className="enrollment-form" onSubmit={submitPairing}>
          <label>
            <span>Pairing code</span>
            <input
              name="pairingCode"
              type="text"
              required
              placeholder="K7Q2-M9XR"
              spellCheck={false}
              autoCapitalize="characters"
              autoComplete="off"
            />
          </label>
          <div className="form-actions">
            <button
              className="button button-primary"
              type="submit"
              disabled={pairing?.phase === "pairing"}
            >
              {pairing?.phase === "pairing" ? "Pairing…" : "Pair"}
            </button>
          </div>
        </form>
        <PairingStatus pairing={pairing} statusReason={profileStatusReason} />
        <p className="privacy-note">
          Get a code from your dashboard at understudy.proofof.tech/dashboard. Pairing replaces
          this browser&rsquo;s previous enrollment.
        </p>
      </section>

      <section className="card">
        <div className="section-heading">
          <div>
            <p className="section-index">01</p>
            <h2>Dedicated profile host</h2>
          </div>
          <button className="button button-danger" type="button" onClick={() => send({ type: "stopAll" })}>
            Stop all
          </button>
        </div>
        <details>
        <summary>Advanced: manual configuration</summary>
        <form className="enrollment-form" key={formKey} onSubmit={configureProfile}>
          <label>
            <span>Service origin</span>
            <input
              name="serviceOrigin"
              type="url"
              required
              defaultValue={profileConfig?.serviceOrigin ?? ""}
              placeholder="https://understudy.example.com"
              spellCheck={false}
              autoCapitalize="off"
            />
          </label>
          <label>
            <span>Device ID</span>
            <input
              name="deviceId"
              type="text"
              required
              defaultValue={profileConfig?.deviceId ?? ""}
              placeholder="00000000-0000-4000-8000-000000000000"
              spellCheck={false}
              autoCapitalize="off"
            />
          </label>
          <label>
            <span>Device credential</span>
            <input
              name="deviceCredential"
              type="password"
              required
              placeholder="Required on every save; never read back"
              autoComplete="off"
            />
          </label>
          <label>
            <span>Local origin policy</span>
            <textarea
              name="originPolicy"
              required
              rows={4}
              defaultValue={profileConfig?.originPolicy.join("\n") ?? ""}
              placeholder={"https://portal.example.com\nhttps://admin.example.com"}
              spellCheck={false}
              autoCapitalize="off"
            />
          </label>
          <div className="form-actions">
            <label className="toggle">
              <input
                name="enabled"
                type="checkbox"
                defaultChecked={profileConfig?.unattendedEnabled ?? false}
              />
              <span>Enable unattended hosting</span>
            </label>
            <button className="button button-primary" type="submit">
              Save enrollment
            </button>
          </div>
        </form>
        </details>
        <p className="privacy-note">
          Credential input is write-only. Execution state stays in browser session storage and clears on restart.
        </p>
      </section>

      <section className="card">
        <div className="section-heading">
          <div>
            <p className="section-index">02</p>
            <h2>Attended session</h2>
          </div>
          <span className={`status status-${wsStatus}`}>{wsStatus}</span>
        </div>
        <label className="stacked-field">
          <span>Session WebSocket URL</span>
          <input
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
        </label>
        <AttendedControls attached={attached} send={send} />
      </section>

      <LogBook logs={logs} />
    </main>
  );
}

const REJECTED_CREDENTIAL =
  "The service rejected this browser's credential. Pair again with a fresh code.";
const BLOCK_REASON_COPY: Record<ProfileBlockReason, string> = {
  ticket_rejected: REJECTED_CREDENTIAL,
  invalid_ticket: REJECTED_CREDENTIAL,
  replaced: "Another browser took over this pairing. Pair again with a fresh code.",
  terminal_close: "The service ended this browser's enrollment. Pair again with a fresh code.",
  credential_revoked:
    "This browser's pairing was revoked in the dashboard. Pair again with a fresh code.",
};

function PairingStatus({
  pairing,
  statusReason,
}: {
  pairing: PairingState | null;
  statusReason: ProfileBlockReason | undefined;
}): ReactElement | null {
  // A live block reason supersedes a stale "paired" success: the dominant
  // path to a block is pair → later revoke, and pairingState stays "paired"
  // for the service-worker's life, so without this precedence the revoke copy
  // would never render.
  if (statusReason !== undefined) {
    return <p className="warning">{BLOCK_REASON_COPY[statusReason]}</p>;
  }
  if (pairing?.phase === "error") {
    return <p className="warning">{pairing.message ?? "Pairing failed. Try a fresh code."}</p>;
  }
  if (pairing?.phase === "paired") {
    return <p className="privacy-note">Paired. Unattended hosting is enabled on this browser.</p>;
  }
  return null;
}

function AttendedControls({
  attached,
  send,
}: {
  attached: AttachedTab | null;
  send: (message: PanelMsg) => void;
}): ReactElement {
  if (attached === null) {
    return (
      <button className="button button-secondary" type="button" onClick={() => send({ type: "attach" })}>
        Attach active tab
      </button>
    );
  }
  return (
    <div className="attached-block">
      <button className="button button-secondary" type="button" onClick={() => send({ type: "detach" })}>
        Detach tab
      </button>
      <p className="warning">Chrome’s “being debugged” banner is expected. Do not detach from that banner.</p>
      <p className="tab-detail">
        {attached.title ?? "Untitled tab"}
        {attached.url ? ` — ${attached.url}` : ""}
      </p>
    </div>
  );
}

function LogBook({ logs }: { logs: LogEntry[] }): ReactElement {
  return (
    <section className="logbook">
      <div className="section-heading">
        <div>
          <p className="section-index">03</p>
          <h2>Local event log</h2>
        </div>
        <span className="log-count">{logs.length}</span>
      </div>
      <ol className="log-list">
        {logs.length === 0 ? <li className="log-empty">No local events.</li> : null}
        {logs.map((entry, index) => (
          <li key={`${entry.timestamp}:${index}`} className={entry.level ? `log-${entry.level}` : undefined}>
            <time>{formatTimestamp(entry.timestamp)}</time>
            <span>{entry.message}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function formatTimestamp(ms: number): string {
  return new Date(ms).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}
