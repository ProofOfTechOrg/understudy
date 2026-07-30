export type WsStatus = "connecting" | "open" | "closed";

export type LogLevel = "info" | "warn" | "error";

export interface LogEntry {
  message: string;
  timestamp: number;
  level?: LogLevel;
}

export interface AttachedTab {
  tabId: number;
  title?: string;
  url?: string;
}

export interface GetStateMsg {
  type: "getState";
}

export interface AttachMsg {
  type: "attach";
}

export interface DetachMsg {
  type: "detach";
}

export interface SetWsUrlMsg {
  type: "setWsUrl";
  url: string;
}

export interface ConfigureProfileMsg {
  type: "configureProfile";
  serviceOrigin: string;
  enabled: boolean;
  deviceId: string;
  deviceCredential: string;
  originPolicy: string[];
}

export interface StopAllMsg {
  type: "stopAll";
}

export interface PairMsg {
  type: "pair";
  code: string;
  /** Overrides the production service origin (dev/support only). */
  serviceOrigin?: string;
}

export type PanelMsg =
  | GetStateMsg
  | AttachMsg
  | DetachMsg
  | SetWsUrlMsg
  | ConfigureProfileMsg
  | StopAllMsg
  | PairMsg;

export type PairingPhase = "pairing" | "paired" | "error";

export interface StateMsg {
  type: "state";
  wsStatus: WsStatus;
  wsUrl: string;
  attached: AttachedTab | null;
  profileStatus: "disabled" | "connecting" | "connected" | "error";
  controlledTabs: number;
  profileConfig: {
    serviceOrigin: string;
    unattendedEnabled: boolean;
    deviceId: string;
    originPolicy: string[];
  } | null;
  /** Progress of the most recent side-panel pairing attempt, if any. */
  pairing?: { phase: PairingPhase; message?: string };
  /**
   * Why profileStatus is "error", when the client knows (ControlBlock reason
   * or a revoked credential) — the panel renders per-reason recovery copy.
   */
  profileStatusReason?: string;
  logs: LogEntry[];
}

export interface LogMsg {
  type: "log";
  entry: LogEntry;
}

export type SwMsg = StateMsg | LogMsg;
