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

/**
 * Why the client is suppressing reconnects: a persisted ControlBlock reason
 * or a revoked credential. Owned here (the message shape) so the side panel
 * and profile-client agree on the exact set and every reason gets copy.
 */
export type ProfileBlockReason =
  | "replaced"
  | "terminal_close"
  | "ticket_rejected"
  | "invalid_ticket"
  | "credential_revoked";

export interface PairingState {
  phase: PairingPhase;
  message?: string;
}

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
  pairing?: PairingState;
  /** Why profileStatus is "error", when the client knows the reason. */
  profileStatusReason?: ProfileBlockReason;
  logs: LogEntry[];
}

export interface LogMsg {
  type: "log";
  entry: LogEntry;
}

export type SwMsg = StateMsg | LogMsg;
