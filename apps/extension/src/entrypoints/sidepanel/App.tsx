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

const DASHBOARD_URL = "https://understudy.proofof.tech/dashboard";
const PRIVACY_URL = "https://understudy.proofof.tech/privacy";
const SUPPORT_URL = "https://github.com/ProofOfTechOrg/understudy/issues";
const RECONNECT_DELAY_MS = 500;

type StateSnapshot = Extract<SwMsg, { type: "state" }>;
type HostStatus =
  | "Not paired"
  | "Connecting"
  | "Connected"
  | "Paused"
  | "Needs attention";

export function App(): ReactElement {
  const [swState, setSwState] = useState<StateSnapshot | null>(null);
  const [pairingCode, setPairingCode] = useState("");
  const portRef = useRef<Browser.runtime.Port | null>(null);
  const pairingInputRef = useRef<HTMLInputElement>(null);
  const previousPairingPhase = useRef<PairingState["phase"] | undefined>(
    undefined,
  );

  const send = (msg: PanelMsg): void => {
    try {
      portRef.current?.postMessage(msg);
    } catch (cause) {
      console.warn("understudy: failed to send panel message", cause);
    }
  };

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

  const pairing = swState?.pairing;
  useEffect(() => {
    const previous = previousPairingPhase.current;
    const current = pairing?.phase;
    previousPairingPhase.current = current;
    if (previous === "pairing" && current === "success") {
      setPairingCode("");
    } else if (current === "error") {
      pairingInputRef.current?.focus();
      pairingInputRef.current?.select();
    }
  }, [pairing?.phase]);

  const isLoading = swState === null;
  const isPairing = pairing?.phase === "pairing";
  const profileConfig = swState?.profileConfig ?? null;
  const controlledTabs = swState?.controlledTabs ?? 0;
  const isPaired = profileConfig !== null;
  const status = deriveHostStatus(swState);
  const canStop =
    !isLoading &&
    (profileConfig?.unattendedEnabled === true || controlledTabs > 0);
  const pairingNotice = pairingNoticeFor(
    pairing ?? null,
    swState?.profileStatus,
    swState?.profileStatusReason,
  );

  const submitPairing = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const code = pairingCode.trim();
    if (code.length === 0 || isLoading || isPairing) return;
    send({ type: "pair", code });
  };

  const stopHosting = (): void => {
    if (!canStop) return;
    const confirmed = window.confirm(
      "Stop hosting? Any active sessions will end, and you will need a fresh pairing code to resume.",
    );
    if (confirmed) send({ type: "stopAll" });
  };

  return (
    <main className="panel">
      <header className="masthead">
        <div>
          <p className="eyebrow">Authorized browser host</p>
          <h1>Understudy</h1>
        </div>
        <div className="masthead-status">
          {__UNDERSTUDY_STORE__ ? <span className="beta-tag">Beta</span> : null}
          <span
            className={`status status-${statusClass(status)}`}
            role="status"
            aria-live="polite"
          >
            {isLoading ? "Loading extension…" : status}
          </span>
        </div>
      </header>

      {isLoading ? (
        <section className="loading-card" role="status" aria-live="polite">
          <span className="loading-mark" aria-hidden="true" />
          <div>
            <strong>Loading extension…</strong>
            <p>Waiting for the secure background service.</p>
          </div>
        </section>
      ) : null}

      <section className="card onboarding-card">
        <div className="section-heading">
          <div>
            <p className="section-index">01 / Pair</p>
            <h2>{isPaired ? "Replace pairing" : "Pair this browser"}</h2>
          </div>
        </div>
        <p className="card-intro">
          Generate a one-time code in your dashboard, then enter it here to
          authorize this Chrome profile.
        </p>
        <form className="enrollment-form" onSubmit={submitPairing}>
          <label>
            <span>Pairing code</span>
            <input
              ref={pairingInputRef}
              name="pairingCode"
              type="text"
              required
              value={pairingCode}
              onChange={(event) => setPairingCode(event.currentTarget.value)}
              placeholder="K7Q2-M9XR"
              spellCheck={false}
              autoCapitalize="characters"
              autoComplete="off"
              disabled={isLoading || isPairing}
              aria-describedby={
                pairingNotice === null
                  ? "pairing-help"
                  : "pairing-help pairing-result"
              }
            />
          </label>
          <div className="form-actions">
            <a
              className="dashboard-link"
              href={DASHBOARD_URL}
              target="_blank"
              rel="noreferrer"
            >
              Open dashboard
            </a>
            <button
              className="button button-primary"
              type="submit"
              disabled={
                isLoading || isPairing || pairingCode.trim().length === 0
              }
            >
              {isPairing
                ? "Pairing…"
                : isPaired
                  ? "Replace pairing"
                  : "Pair browser"}
            </button>
          </div>
        </form>
        <PairingStatus notice={pairingNotice} />
        <p className="privacy-note" id="pairing-help">
          Pairing replaces this browser’s previous enrollment. Only sites
          allowed in your dashboard can be operated.
        </p>
      </section>

      <section className="card host-card">
        <div className="section-heading">
          <div>
            <p className="section-index">02 / Host</p>
            <h2>Hosted profile</h2>
          </div>
          <span className={`signal signal-${statusClass(status)}`} aria-hidden="true" />
        </div>
        <HostStatusCopy
          status={status}
          reason={swState?.profileStatusReason}
        />
        {isPaired ? (
          <div className="capacity-strip" aria-label="Controlled tab capacity">
            <div>
              <span className="metric">{controlledTabs}</span>
              <span className="metric-total"> / 2</span>
            </div>
            <p>controlled tabs</p>
          </div>
        ) : null}
        <button
          className="button button-danger stop-button"
          type="button"
          onClick={stopHosting}
          disabled={!canStop || isPairing}
        >
          Stop hosting
        </button>
      </section>

      {__UNDERSTUDY_STORE__ ? null : (
        <InternalTools
          state={swState}
          isLoading={isLoading}
          send={send}
        />
      )}

      <LogBook logs={swState?.logs ?? []} />

      <footer className="panel-footer">
        <a href={PRIVACY_URL} target="_blank" rel="noreferrer">
          Privacy
        </a>
        <span aria-hidden="true">·</span>
        <a href={SUPPORT_URL} target="_blank" rel="noreferrer">
          Support
        </a>
      </footer>
    </main>
  );
}

const REJECTED_CREDENTIAL =
  "The service rejected this browser’s credential. Pair again with a fresh code.";
const BLOCK_REASON_COPY: Record<ProfileBlockReason, string> = {
  ticket_rejected: REJECTED_CREDENTIAL,
  invalid_ticket: REJECTED_CREDENTIAL,
  replaced: "Another browser took over this pairing. Pair again with a fresh code.",
  terminal_close: "The service ended this browser’s enrollment. Pair again with a fresh code.",
  credential_revoked:
    "This browser’s pairing was revoked in the dashboard. Pair again with a fresh code.",
};

function deriveHostStatus(state: StateSnapshot | null): HostStatus {
  if (state === null || state.profileConfig === null) return "Not paired";
  if (
    state.profileStatusReason !== undefined ||
    state.profileStatus === "error"
  ) {
    return "Needs attention";
  }
  if (!state.profileConfig.unattendedEnabled) return "Paused";
  if (state.profileStatus === "connected") return "Connected";
  return "Connecting";
}

function statusClass(status: HostStatus): string {
  return status.toLowerCase().replaceAll(" ", "-");
}

interface PairingNotice {
  message: string;
  warning: boolean;
}

function pairingNoticeFor(
  pairing: PairingState | null,
  profileStatus: StateSnapshot["profileStatus"] | undefined,
  statusReason: ProfileBlockReason | undefined,
): PairingNotice | null {
  let message: string | undefined;
  let warning = false;
  if (pairing?.phase === "pairing") {
    message = "Checking the pairing code and securing this browser…";
  } else if (pairing?.phase === "error") {
    message = pairing.message ?? "Pairing failed. Try a fresh code.";
    warning = true;
  } else if (statusReason !== undefined) {
    message = BLOCK_REASON_COPY[statusReason];
    warning = true;
  } else if (
    pairing?.phase === "success" &&
    profileStatus !== "connected" &&
    profileStatus !== "error"
  ) {
    message = "Pairing complete. Connecting to Understudy…";
  }
  return message === undefined ? null : { message, warning };
}

function PairingStatus({
  notice,
}: {
  notice: PairingNotice | null;
}): ReactElement | null {
  if (notice === null) return null;
  return (
    <p
      className={notice.warning ? "warning" : "result-note"}
      id="pairing-result"
      role="status"
      aria-live="polite"
    >
      {notice.message}
    </p>
  );
}

function HostStatusCopy({
  status,
  reason,
}: {
  status: HostStatus;
  reason: ProfileBlockReason | undefined;
}): ReactElement {
  if (reason !== undefined) {
    return <p className="host-copy">{BLOCK_REASON_COPY[reason]}</p>;
  }
  const copy: Record<HostStatus, string> = {
    "Not paired":
      "This browser is not available to your authorized AI client.",
    Connecting:
      "Pairing is saved. The extension is establishing its secure hosted connection.",
    Connected:
      "Ready for your authorized AI client to open controlled tabs on allowed sites.",
    Paused:
      "Hosting is paused. Pair with a fresh code when you want to resume.",
    "Needs attention":
      "Hosting stopped because the service could not authorize this browser. Pair again.",
  };
  return <p className="host-copy">{copy[status]}</p>;
}

function InternalTools({
  state,
  isLoading,
  send,
}: {
  state: StateSnapshot | null;
  isLoading: boolean;
  send: (message: PanelMsg) => void;
}): ReactElement {
  const wsUrl = state?.wsUrl ?? null;
  const profileConfig = state?.profileConfig ?? null;
  const formKey = JSON.stringify(profileConfig);

  const commitWsUrl = (rawUrl: string): void => {
    const trimmed = rawUrl.trim();
    if (trimmed.length === 0 || trimmed === wsUrl) return;
    send({ type: "setWsUrl", url: trimmed });
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
    const credential =
      event.currentTarget.elements.namedItem("deviceCredential");
    if (credential instanceof HTMLInputElement) credential.value = "";
  };

  return (
    <>
      <section className="card internal-card">
        <div className="section-heading">
          <div>
            <p className="section-index">Internal</p>
            <h2>Manual configuration</h2>
          </div>
        </div>
        <form
          className="enrollment-form"
          key={formKey}
          onSubmit={configureProfile}
        >
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
              disabled={isLoading}
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
              disabled={isLoading}
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
              disabled={isLoading}
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
              disabled={isLoading}
            />
          </label>
          <div className="form-actions">
            <label className="toggle">
              <input
                name="enabled"
                type="checkbox"
                defaultChecked={profileConfig?.unattendedEnabled ?? false}
                disabled={isLoading}
              />
              <span>Enable unattended hosting</span>
            </label>
            <button
              className="button button-primary"
              type="submit"
              disabled={isLoading}
            >
              Save enrollment
            </button>
          </div>
        </form>
        <p className="privacy-note">
          Credential input is write-only. Execution state stays in browser
          session storage and clears on restart.
        </p>
      </section>

      <section className="card internal-card">
        <div className="section-heading">
          <div>
            <p className="section-index">Internal</p>
            <h2>Attended session</h2>
          </div>
          <span className={`status status-${state?.wsStatus ?? "idle"}`}>
            {state?.wsStatus ?? "idle"}
          </span>
        </div>
        <label className="stacked-field">
          <span>Session WebSocket URL</span>
          <input
            key={wsUrl ?? "unconfigured"}
            type="text"
            defaultValue={wsUrl ?? ""}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            disabled={isLoading}
            onBlur={(event) => commitWsUrl(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
          />
        </label>
        <AttendedControls
          attached={state?.attached ?? null}
          disabled={isLoading}
          send={send}
        />
      </section>
    </>
  );
}

function AttendedControls({
  attached,
  disabled,
  send,
}: {
  attached: AttachedTab | null;
  disabled: boolean;
  send: (message: PanelMsg) => void;
}): ReactElement {
  if (attached === null) {
    return (
      <button
        className="button button-secondary"
        type="button"
        disabled={disabled}
        onClick={() => send({ type: "attach" })}
      >
        Attach active tab
      </button>
    );
  }
  return (
    <div className="attached-block">
      <button
        className="button button-secondary"
        type="button"
        disabled={disabled}
        onClick={() => send({ type: "detach" })}
      >
        Detach tab
      </button>
      <p className="warning">
        Chrome’s debugger banner is process-wide. Dismissing it in any Chrome
        window can detach this controlled tab; the banner does not identify
        which tab is controlled.
      </p>
      <p className="tab-detail">
        {attached.title ?? "Untitled tab"}
        {attached.url ? ` · ${attached.url}` : ""}
      </p>
    </div>
  );
}

function LogBook({ logs }: { logs: LogEntry[] }): ReactElement {
  return (
    <details className="troubleshooting">
      <summary>
        <span>Troubleshooting</span>
        <span className="log-count">{logs.length}</span>
      </summary>
      <ol className="log-list">
        {logs.length === 0 ? (
          <li className="log-empty">No local events.</li>
        ) : null}
        {logs.map((entry, index) => (
          <li
            key={`${entry.timestamp}:${index}`}
            className={entry.level ? `log-${entry.level}` : undefined}
          >
            <time>{formatTimestamp(entry.timestamp)}</time>
            <span>{entry.message}</span>
          </li>
        ))}
      </ol>
    </details>
  );
}

function formatTimestamp(ms: number): string {
  return new Date(ms).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}
