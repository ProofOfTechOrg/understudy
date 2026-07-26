import {
  DEVICE_CONTROL_FRAME_MAX_BYTES,
  PROTOCOL_CAPABILITIES,
  PROTOCOL_VERSION,
  safeParseDeviceControlServerFrame,
  type DeviceControlClientFrame,
} from "@understudy/protocol";
import { ReconnectingWs } from "./ws-client";
import { SessionManager } from "./session-manager";

const BROWSER_EPOCH_KEY = "understudy:browserEpoch";
const CONFIG_KEYS = [
  "serviceOrigin",
  "unattendedEnabled",
  "deviceId",
  "deviceCredential",
  "originPolicy",
] as const;

export interface ProfileConfig {
  serviceOrigin: string;
  unattendedEnabled: boolean;
  deviceId: string;
  deviceCredential: string;
  originPolicy: string[];
}

export type ProfileStatus = "disabled" | "connecting" | "connected" | "error";

export class ProfileClient {
  readonly sessions: SessionManager;
  private config: ProfileConfig | null = null;
  private epoch = "";
  private control: ReconnectingWs | null = null;
  private status: ProfileStatus = "disabled";
  private controlFrameTail: Promise<void> = Promise.resolve();

  constructor(private readonly onStatus?: (status: ProfileStatus) => void) {
    this.sessions = new SessionManager(
      () => this.requiredConfig().serviceOrigin,
      () => this.epoch,
    );
  }

  async start(): Promise<void> {
    await this.restrictLocalStorage();
    this.epoch = await this.loadBrowserEpoch();
    this.config = await this.loadConfig();
    await this.sessions.restoreSameEpoch();
    if (this.config?.unattendedEnabled === true) {
      await this.connectControl();
    } else {
      this.setStatus("disabled");
    }
  }

  browserEpoch(): string {
    return this.epoch;
  }

  currentStatus(): ProfileStatus {
    return this.status;
  }

  publicConfig(): Omit<ProfileConfig, "deviceCredential"> | null {
    if (this.config === null) return null;
    return {
      serviceOrigin: this.config.serviceOrigin,
      unattendedEnabled: this.config.unattendedEnabled,
      deviceId: this.config.deviceId,
      originPolicy: [...this.config.originPolicy],
    };
  }

  async configure(config: ProfileConfig): Promise<void> {
    const normalized = normalizeProfileConfig(config);
    await browser.storage.local.set(normalized);
    this.config = normalized;
    if (!normalized.unattendedEnabled) {
      await this.closeAllAndAcknowledge();
      this.control?.stop();
      this.control = null;
      this.setStatus("disabled");
      return;
    }
    this.control?.stop();
    this.control = null;
    await this.connectControl();
  }

  async stopAll(): Promise<void> {
    await this.closeAllAndAcknowledge();
    this.control?.stop();
    this.control = null;
    if (this.config !== null) {
      this.config = { ...this.config, unattendedEnabled: false };
      await browser.storage.local.set({ unattendedEnabled: false });
    }
    this.setStatus("disabled");
  }

  private async closeAllAndAcknowledge(): Promise<void> {
    const assignments = this.sessions.assignments();
    for (const assignment of assignments) {
      const closed = await this.sessions.closeLease(assignment);
      if (!closed) continue;
      this.sendControl({
        type: "closed",
        sessionId: assignment.sessionId,
        leaseId: assignment.leaseId,
        leaseEpoch: assignment.leaseEpoch,
        browserEpoch: assignment.browserEpoch,
      });
    }
  }

  private async connectControl(): Promise<void> {
    const config = this.requiredConfig();
    this.setStatus("connecting");
    let ticket: { ticket: string; websocketPath: string };
    try {
      const response = await fetch(
        new URL("/v1/device/connect-ticket", config.serviceOrigin).toString(),
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${config.deviceCredential}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ browserEpoch: this.epoch }),
        },
      );
      if (!response.ok) throw new Error(`device ticket request failed with ${response.status}`);
      const value = (await response.json()) as Partial<typeof ticket>;
      if (
        typeof value.ticket !== "string" ||
        typeof value.websocketPath !== "string"
      ) {
        throw new Error("device ticket response was malformed");
      }
      ticket = { ticket: value.ticket, websocketPath: value.websocketPath };
    } catch {
      this.setStatus("error");
      return;
    }

    const url = new URL(ticket.websocketPath, config.serviceOrigin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("ticket", ticket.ticket);
    let peer!: ReconnectingWs;
    peer = new ReconnectingWs(
      () => url.toString(),
      {
        onCommand: (raw) => {
          if (peer !== this.control) return;
          const handleIfCurrent = async () => {
            if (peer === this.control) await this.onControlFrame(raw);
          };
          const handling = this.controlFrameTail.then(
            handleIfCurrent,
            handleIfCurrent,
          );
          this.controlFrameTail = handling.catch(() => {});
        },
        onOpen: () => {
          if (peer !== this.control) return;
          this.setStatus("connected");
          this.sendControl({
            type: "device_hello",
            protocolVersion: PROTOCOL_VERSION,
            capabilities: [...PROTOCOL_CAPABILITIES],
            deviceId: config.deviceId,
            browserEpoch: this.epoch,
            browser: navigator.userAgent,
            extVersion: browser.runtime.getManifest().version,
            allowedOrigins: config.originPolicy,
          });
        },
        onClose: () => {
          if (peer !== this.control) return;
          peer.stop();
          this.control = null;
          this.setStatus("connecting");
          setTimeout(() => void this.connectControl(), 500);
        },
        heartbeatFrame: () => ({
          type: "heartbeat",
          deviceId: config.deviceId,
          browserEpoch: this.epoch,
          leaseIds: this.sessions.assignments().map((assignment) => assignment.leaseId),
        }),
      },
      DEVICE_CONTROL_FRAME_MAX_BYTES,
    );
    this.control = peer;
  }

  private async onControlFrame(raw: unknown): Promise<void> {
    const parsed = safeParseDeviceControlServerFrame(raw);
    if (!parsed.success) return;
    const frame = parsed.data;
    switch (frame.type) {
      case "provision":
        try {
          const tab = await this.sessions.provision(frame);
          this.sendControl({
            type: "provisioned",
            sessionId: frame.sessionId,
            leaseId: frame.leaseId,
            leaseEpoch: frame.leaseEpoch,
            browserEpoch: frame.browserEpoch,
            tab,
          });
        } catch {
          this.sendControl({
            type: "provision_failed",
            sessionId: frame.sessionId,
            leaseId: frame.leaseId,
            leaseEpoch: frame.leaseEpoch,
            browserEpoch: frame.browserEpoch,
            reason: "local provisioning failed",
          });
        }
        return;
      case "close_lease":
        if (await this.sessions.closeLease(frame)) {
          this.sendControl({
            type: "closed",
            sessionId: frame.sessionId,
            leaseId: frame.leaseId,
            leaseEpoch: frame.leaseEpoch,
            browserEpoch: frame.browserEpoch,
          });
        }
        return;
      case "session_ticket":
        this.sessions.connectSessionTicket(frame);
        return;
      case "credential_revoked":
        this.control?.stop();
        this.control = null;
        await this.sessions.stopAll();
        this.setStatus("error");
        return;
    }
  }

  private sendControl(frame: DeviceControlClientFrame): void {
    this.control?.send(frame);
  }

  private async loadBrowserEpoch(): Promise<string> {
    const stored = await browser.storage.session.get(BROWSER_EPOCH_KEY);
    const value = stored[BROWSER_EPOCH_KEY];
    if (typeof value === "string" && value.length > 0) return value;
    const epoch = crypto.randomUUID();
    await browser.storage.session.set({ [BROWSER_EPOCH_KEY]: epoch });
    return epoch;
  }

  private async loadConfig(): Promise<ProfileConfig | null> {
    const stored = await browser.storage.local.get([...CONFIG_KEYS]);
    const candidate = {
      serviceOrigin: stored.serviceOrigin,
      unattendedEnabled: stored.unattendedEnabled,
      deviceId: stored.deviceId,
      deviceCredential: stored.deviceCredential,
      originPolicy: stored.originPolicy,
    };
    try {
      return normalizeProfileConfig(candidate);
    } catch {
      return null;
    }
  }

  private async restrictLocalStorage(): Promise<void> {
    const area = browser.storage.local as Browser.storage.StorageArea & {
      setAccessLevel?: (options: {
        accessLevel: "TRUSTED_CONTEXTS";
      }) => Promise<void>;
    };
    await area.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" });
  }

  private requiredConfig(): ProfileConfig {
    if (this.config === null) throw new Error("unattended profile is not configured");
    return this.config;
  }

  private setStatus(status: ProfileStatus): void {
    this.status = status;
    this.onStatus?.(status);
  }
}

function normalizeProfileConfig(value: unknown): ProfileConfig {
  if (typeof value !== "object" || value === null) throw new Error("invalid profile config");
  const input = value as Partial<ProfileConfig>;
  const origin = typeof input.serviceOrigin === "string" ? new URL(input.serviceOrigin) : null;
  const serviceLoopback =
    origin !== null &&
    (origin.hostname === "localhost" ||
      origin.hostname === "127.0.0.1" ||
      origin.hostname === "[::1]" ||
      origin.hostname.endsWith(".localhost"));
  if (
    origin === null ||
    (origin.protocol !== "https:" &&
      !(origin.protocol === "http:" && serviceLoopback)) ||
    origin.username !== "" ||
    origin.password !== "" ||
    origin.pathname !== "/" ||
    origin.search !== "" ||
    origin.hash !== "" ||
    typeof input.unattendedEnabled !== "boolean" ||
    typeof input.deviceId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      input.deviceId,
    ) ||
    typeof input.deviceCredential !== "string" ||
    input.deviceCredential.length < 1 ||
    input.deviceCredential.length > 4 * 1024 ||
    !Array.isArray(input.originPolicy) ||
    input.originPolicy.length < 1 ||
    input.originPolicy.length > 32 ||
    !input.originPolicy.every((item) => typeof item === "string")
  ) {
    throw new Error("invalid profile config");
  }
  const originPolicy = [...new Set(input.originPolicy.map(canonicalOrigin))].sort();
  return {
    serviceOrigin: origin.origin,
    unattendedEnabled: input.unattendedEnabled,
    deviceId: input.deviceId.toLowerCase(),
    deviceCredential: input.deviceCredential,
    originPolicy,
  };
}

function canonicalOrigin(value: string): string {
  if (value !== value.trim() || value.includes("*") || value.includes("?") || value.includes("#")) {
    throw new Error("invalid local origin policy");
  }
  const url = new URL(value);
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]" ||
    url.hostname.endsWith(".localhost");
  if (
    url.username !== "" ||
    url.password !== "" ||
    (url.pathname !== "" && url.pathname !== "/") ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
  ) {
    throw new Error("invalid local origin policy");
  }
  return url.origin;
}
