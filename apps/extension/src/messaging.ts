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

export type PanelMsg =
  | GetStateMsg
  | AttachMsg
  | DetachMsg
  | SetWsUrlMsg
  | ConfigureProfileMsg
  | StopAllMsg;

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
  logs: LogEntry[];
}

export interface LogMsg {
  type: "log";
  entry: LogEntry;
}

export type SwMsg = StateMsg | LogMsg;
