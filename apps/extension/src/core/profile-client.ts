import {
  DEVICE_CONTROL_FRAME_MAX_BYTES,
  PROTOCOL_CAPABILITIES,
  PROTOCOL_VERSION,
  WS_CLOSE_REPLACED,
  WS_CLOSE_SESSION_TERMINAL,
  safeParseDeviceControlServerFrame,
  type DeviceControlClientFrame,
} from "@understudy/protocol";
import type { ProfileBlockReason } from "../messaging";
import {
  SessionManager,
  StaleProvisionError,
  type ClosureRecord,
} from "./session-manager";
import { RetryableStartupGate } from "./startup-gate";
import {
  RequestDeadlineError,
  readBoundedJson,
  withRequestDeadline,
} from "./request-deadline";
import { ReconnectingWs } from "./ws-client";
import type { CardVault } from "../payment/card-vault";

const BROWSER_EPOCH_KEY = "understudy:browserEpoch";
const STAGED_CONFIG_KEY = "understudy:stagedProfile";
const CREDENTIAL_REVOKED_KEY = "understudy:credentialRevoked";
const CONTROL_BLOCK_KEY = "understudy:controlBlock";
const CONFIG_KEYS = [
  "serviceOrigin",
  "unattendedEnabled",
  "deviceId",
  "deviceCredential",
  "originPolicy",
  "policyVersion",
] as const;
const PROFILE_STATE_KEYS = [
  ...CONFIG_KEYS,
  STAGED_CONFIG_KEY,
  CREDENTIAL_REVOKED_KEY,
  CONTROL_BLOCK_KEY,
] as const;
const TICKET_BACKOFF_BASE_MS = 500;
const TICKET_BACKOFF_CAP_MS = 30_000;
const TICKET_REQUEST_TIMEOUT_MS = 15_000;
const TICKET_RESPONSE_MAX_BYTES = 16 * 1024;

type ControlPurpose = "hosting" | "cleanup";
type ControlBlockReason = "replaced" | "terminal_close" | "ticket_rejected" | "invalid_ticket";

interface ControlBlock {
  version: 1;
  profileKey: string;
  reason: ControlBlockReason;
}

interface ControlAttempt {
  generation: number;
  config: ProfileConfig;
  purpose: ControlPurpose;
  controller: AbortController;
  helloSent: boolean;
}

export interface ProfileConfig {
  serviceOrigin: string;
  unattendedEnabled: boolean;
  deviceId: string;
  deviceCredential: string;
  originPolicy: string[];
  policyVersion: number;
}

export type ProfileStatus = "disabled" | "connecting" | "connected" | "error";

export class ProfileClient {
  readonly sessions: SessionManager;
  private config: ProfileConfig | null = null;
  private stagedConfig: ProfileConfig | null = null;
  private credentialRevoked = false;
  private controlBlock: ControlBlock | null = null;
  private blockedProfileIdentity: string | null = null;
  private activeProfileKey: string | null = null;
  private epoch = "";
  private control: ReconnectingWs | null = null;
  private controlAttempt: ControlAttempt | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private ticketBackoffMs = TICKET_BACKOFF_BASE_MS;
  private generation = 0;
  private status: ProfileStatus = "disabled";
  private controlFrameTail: Promise<void> = Promise.resolve();
  private configWriteTail: Promise<void> = Promise.resolve();
  private readonly initialization = new RetryableStartupGate(() =>
    this.initialize(),
  );
  private lifecycleTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly onStatus?: (status: ProfileStatus) => void,
    private readonly requiredServiceOrigin?: string,
  ) {
    this.sessions = new SessionManager(
      () => this.requiredConfig().serviceOrigin,
      () => this.epoch,
    );
  }

  start(): Promise<void> {
    return this.startRequest(this.generation);
  }

  private async startRequest(generation: number): Promise<void> {
    await this.enqueueLifecycle(async () => {
      await this.ensureInitialized();
    });
    await this.resumeForGeneration(generation);
  }

  private ensureInitialized(): Promise<void> {
    return this.initialization.wait();
  }

  private async initialize(): Promise<void> {
    await this.restrictLocalStorage();
    this.epoch = await this.loadBrowserEpoch();
    const stored = await this.loadProfileState();
    this.config = stored.active;
    this.stagedConfig = stored.staged;
    this.credentialRevoked = stored.credentialRevoked;
    this.controlBlock = stored.controlBlock;
    if (this.config !== null) {
      this.activeProfileKey = await profileKey(this.config);
    }
    if (this.config !== null && this.controlBlock !== null) {
      if (this.activeProfileKey === this.controlBlock.profileKey) {
        this.blockedProfileIdentity = profileIdentity(this.config);
      } else {
        this.controlBlock = null;
        await browser.storage.local.remove(CONTROL_BLOCK_KEY);
      }
    } else if (this.controlBlock !== null) {
      this.controlBlock = null;
      await browser.storage.local.remove(CONTROL_BLOCK_KEY);
    }

    const restoreIntent =
      this.credentialRevoked ||
      this.blockedProfileIdentity !== null ||
      this.config === null
        ? "discard"
        : this.config.unattendedEnabled && this.stagedConfig === null
          ? "recover"
          : "release";
    await this.sessions.restoreSameEpoch(restoreIntent);

    if (this.config === null) {
      await this.sessions.discardServerState();
      this.setStatus("disabled");
      return;
    }
    if (this.credentialRevoked || this.blockedProfileIdentity !== null) {
      await this.sessions.discardServerState();
      this.setStatus("error");
    }
  }

  browserEpoch(): string {
    return this.epoch;
  }

  currentStatus(): ProfileStatus {
    return this.status;
  }

  /**
   * Why reconnects are suppressed, when known — read-only over the
   * already-parsed ControlBlock and the revocation flag; touches no
   * connect/backoff path. Briefly null while a fresh block is still being
   * persisted (the panel polls state, so the reason appears on the next
   * push).
   */
  blockedReason(): ProfileBlockReason | null {
    if (this.credentialRevoked) return "credential_revoked";
    if (this.isControlBlocked() && this.controlBlock !== null) {
      return this.controlBlock.reason;
    }
    return null;
  }

  publicConfig(): Omit<ProfileConfig, "deviceCredential"> | null {
    if (this.config === null) return null;
    return {
      serviceOrigin: this.config.serviceOrigin,
      unattendedEnabled: this.config.unattendedEnabled,
      deviceId: this.config.deviceId,
      originPolicy: [...this.config.originPolicy],
      policyVersion: this.config.policyVersion,
    };
  }

  async pairingCredential(): Promise<string | undefined> {
    await this.ensureInitialized();
    return this.credentialRevoked ? undefined : this.config?.deviceCredential;
  }

  async pairingTransitionPersisted(expected: ProfileConfig): Promise<boolean> {
    await this.ensureInitialized();
    await this.configWriteTail;
    const stored = await browser.storage.local.get([
      ...CONFIG_KEYS,
      STAGED_CONFIG_KEY,
      CREDENTIAL_REVOKED_KEY,
    ]);
    if (
      stored[STAGED_CONFIG_KEY] !== null &&
      stored[STAGED_CONFIG_KEY] !== undefined
    ) {
      return false;
    }
    let active: ProfileConfig;
    try {
      active = normalizeProfileConfig({
        serviceOrigin: stored.serviceOrigin,
        unattendedEnabled: stored.unattendedEnabled,
        deviceId: stored.deviceId,
        deviceCredential: stored.deviceCredential,
        originPolicy: stored.originPolicy,
        policyVersion: stored.policyVersion,
      });
    } catch {
      return false;
    }
    return (
      stored[CREDENTIAL_REVOKED_KEY] !== true &&
      samePairingAuthority(active, normalizeProfileConfig(expected))
    );
  }

  paymentVault(): CardVault {
    return this.sessions.paymentVault();
  }

  configure(config: ProfileConfig): Promise<void> {
    return this.configureWithTransition(config, false, false);
  }

  configurePaired(
    config: ProfileConfig,
    previousCredential: string | undefined,
  ): Promise<void> {
    const discardPrevious =
      previousCredential !== undefined &&
      this.config?.deviceCredential === previousCredential &&
      this.config.deviceId !== config.deviceId;
    return this.configureWithTransition(config, discardPrevious, true);
  }

  private configureWithTransition(
    config: ProfileConfig,
    discardPrevious: boolean,
    requireCommit: boolean,
  ): Promise<void> {
    const normalized = normalizeProfileConfig(config);
    this.assertServiceOrigin(normalized);
    const generation = this.invalidateControl();
    const cleanupIntent = discardPrevious
      ? "discard"
      : this.configureCleanupIntent(normalized);
    if (cleanupIntent !== null) {
      this.sessions.beginStopAll(cleanupIntent);
    }
    return this.configureRequest(
      normalized,
      generation,
      discardPrevious,
      requireCommit,
    );
  }

  private async configureRequest(
    normalized: ProfileConfig,
    generation: number,
    discardPrevious: boolean,
    requireCommit: boolean,
  ): Promise<void> {
    await this.enqueueLifecycle(async () => {
      await this.ensureInitialized();
      if (!this.isGenerationCurrent(generation)) return;
      await this.configureInitialized(normalized, generation, discardPrevious);
    });
    await this.resumeForGeneration(generation);
    if (requireCommit && !this.pairedTransitionCommitted(normalized, generation)) {
      throw new Error("paired profile configuration was superseded");
    }
  }

  private async configureInitialized(
    normalized: ProfileConfig,
    generation: number,
    discardPrevious: boolean,
  ): Promise<void> {
    const cleanupIntent = discardPrevious
      ? "discard"
      : this.configureCleanupIntent(normalized);
    if (cleanupIntent !== null) {
      this.sessions.beginStopAll(cleanupIntent);
    }
    const normalizedKey = await profileKey(normalized);
    if (!this.isGenerationCurrent(generation)) return;
    this.blockedProfileIdentity = null;
    this.controlBlock = null;
    const wasCredentialRevoked = this.credentialRevoked;
    if (wasCredentialRevoked || discardPrevious) {
      const active = { ...normalized, unattendedEnabled: false };
      this.config = active;
      this.activeProfileKey = normalizedKey;
      this.stagedConfig = normalized;
      this.credentialRevoked = true;
      if (!(await this.persistProfileState(active, normalized, generation))) return;
      await this.sessions.stopAll("discard");
      if (!this.isGenerationCurrent(generation)) return;
      await this.sessions.discardServerState();
      if (!this.isGenerationCurrent(generation)) return;
      return;
    }
    this.credentialRevoked = false;
    const current = this.config;
    const identityChanged =
      current !== null && profileIdentity(current) !== profileIdentity(normalized);
    const rotatesCurrentDevice =
      current !== null &&
      identityChanged &&
      sameDeviceAuthority(current, normalized);
    const ownsOldWork =
      current !== null &&
      (current.unattendedEnabled ||
        this.sessions.assignments().length > 0 ||
        this.sessions.closureOutbox().length > 0 ||
        this.sessions.vacatedLeases().length > 0);

    if (current !== null && rotatesCurrentDevice) {
      if (
        normalized.policyVersion < current.policyVersion ||
        (normalized.policyVersion === current.policyVersion &&
          !sameOrigins(normalized.originPolicy, current.originPolicy))
      ) {
        throw new Error("paired profile policy conflicts with local authority");
      }
      if (normalized.policyVersion > current.policyVersion) {
        await this.sessions.applyPolicy(
          normalized.policyVersion,
          normalized.originPolicy,
        );
        if (!this.isGenerationCurrent(generation)) return;
      }
    }

    if (current !== null && identityChanged && !rotatesCurrentDevice && ownsOldWork) {
      this.config = { ...current, unattendedEnabled: false };
      this.stagedConfig = normalized;
      if (
        !(await this.persistProfileState(
          this.config,
          this.stagedConfig,
          generation,
        ))
      ) {
        return;
      }
      await this.sessions.stopAll("release");
      if (!this.isGenerationCurrent(generation)) return;
      return;
    }

    this.config = normalized;
    this.activeProfileKey = normalizedKey;
    this.stagedConfig = null;
    if (!(await this.persistProfileState(normalized, null, generation))) return;
    if (!normalized.unattendedEnabled) {
      await this.sessions.stopAll("release");
      if (!this.isGenerationCurrent(generation)) return;
    }
  }

  stopAll(): Promise<void> {
    const generation = this.invalidateControl();
    this.sessions.beginStopAll(
      this.credentialRevoked ? "discard" : "release",
    );
    return this.stopAllRequest(generation);
  }

  private async stopAllRequest(generation: number): Promise<void> {
    await this.enqueueLifecycle(async () => {
      await this.ensureInitialized();
      if (!this.isGenerationCurrent(generation)) return;
      await this.stopAllInitialized(generation);
    });
    await this.resumeForGeneration(generation);
  }

  private async stopAllInitialized(generation: number): Promise<void> {
    const intent = this.credentialRevoked ? "discard" : "release";
    this.sessions.beginStopAll(intent);
    this.stagedConfig = null;
    if (this.config !== null) {
      this.config = { ...this.config, unattendedEnabled: false };
      if (!(await this.persistStoppedProfile(generation))) return;
    }
    await this.sessions.stopAll(intent);
    if (!this.isGenerationCurrent(generation)) return;
  }

  ensureConnection(): Promise<void> {
    return this.ensureConnectionRequest();
  }

  private async ensureConnectionRequest(): Promise<void> {
    let generation = this.generation;
    await this.enqueueLifecycle(async () => {
      await this.ensureInitialized();
      generation = this.generation;
      await this.sessions.retryCleanup();
      if (this.credentialRevoked && this.stagedConfig !== null) {
        await this.sessions.discardServerState();
      }
    });
    if (!this.isGenerationCurrent(generation)) return;
    const attempt = this.controlAttempt;
    if (attempt !== null && this.control !== null) {
      await this.flushClosureOutbox(attempt, this.control);
      return;
    }
    await this.resumeForGeneration(generation);
  }

  private async resumeForGeneration(generation: number): Promise<void> {
    if (!this.isGenerationCurrent(generation)) return;
    if (this.credentialRevoked && this.stagedConfig !== null) {
      if (this.sessions.pendingCleanup()) {
        this.setStatus("error");
        return;
      }
      const active = this.requiredConfig();
      this.credentialRevoked = false;
      try {
        if (!(await this.persistProfileState(active, this.stagedConfig, generation))) {
          return;
        }
      } catch (error) {
        if (this.isGenerationCurrent(generation)) {
          this.credentialRevoked = true;
        }
        throw error;
      }
    }
    if (this.credentialRevoked || this.isControlBlocked()) {
      this.setStatus("error");
      return;
    }
    const config = this.config;
    if (config === null) {
      this.setStatus("disabled");
      return;
    }

    if (
      this.sessions.closureOutbox().length > 0 ||
      this.sessions.pendingReleaseCleanup()
    ) {
      await this.connectControl(config, "cleanup", generation);
      return;
    }

    if (this.sessions.pendingCleanup()) {
      if (config.unattendedEnabled && this.stagedConfig === null) {
        await this.connectControl(config, "hosting", generation);
      } else {
        this.setStatus("disabled");
      }
      return;
    }

    if (this.stagedConfig !== null) {
      await this.promoteStaged(generation);
      return;
    }

    if (config.unattendedEnabled) {
      await this.connectControl(config, "hosting", generation);
    } else {
      this.setStatus("disabled");
    }
  }

  private async connectControl(
    config: ProfileConfig,
    purpose: ControlPurpose,
    generation: number,
  ): Promise<void> {
    if (
      !this.controlDesired(config, purpose, generation) ||
      this.control !== null ||
      this.controlAttempt !== null ||
      this.retryTimer !== null
    ) {
      return;
    }

    this.setStatus("connecting");
    const attempt: ControlAttempt = {
      generation,
      config: cloneConfig(config),
      purpose,
      controller: new AbortController(),
      helloSent: false,
    };
    this.controlAttempt = attempt;
    let response: Response;
    try {
      response = await withRequestDeadline(
        TICKET_REQUEST_TIMEOUT_MS,
        (deadlineSignal) => {
          const signal = AbortSignal.any([
            attempt.controller.signal,
            deadlineSignal,
          ]);
          return fetch(
            new URL("/v1/device/connect-ticket", config.serviceOrigin).toString(),
            {
              method: "POST",
              headers: {
                authorization: `Bearer ${config.deviceCredential}`,
                "content-type": "application/json",
              },
              body: JSON.stringify({ browserEpoch: this.epoch }),
              signal,
            },
          );
        },
      );
    } catch (error) {
      if (!this.isAttemptCurrent(attempt)) return;
      this.controlAttempt = null;
      if (isAbortError(error) && !(error instanceof RequestDeadlineError)) return;
      this.scheduleRetry(attempt);
      return;
    }
    if (!this.isAttemptCurrent(attempt)) return;
    if (!response.ok) {
      this.controlAttempt = null;
      if (isRetryableTicketStatus(response.status)) {
        this.scheduleRetry(attempt);
      } else if (response.status === 401 || response.status === 404) {
        this.invalidateControl();
        this.sessions.beginStopAll("discard");
        await this.enqueueLifecycle(async () => {
          await this.handleCredentialRevoked();
        });
      } else {
        await this.blockControlAfterTicketError(
          attempt.config,
          "ticket_rejected",
        );
      }
      return;
    }

    let value: unknown;
    try {
      value = await withRequestDeadline(
        TICKET_REQUEST_TIMEOUT_MS,
        (deadlineSignal) =>
          readBoundedJson(
            response,
            AbortSignal.any([attempt.controller.signal, deadlineSignal]),
            TICKET_RESPONSE_MAX_BYTES,
          ),
      );
    } catch (error) {
      if (!this.isAttemptCurrent(attempt)) return;
      this.controlAttempt = null;
      if (error instanceof RequestDeadlineError) {
        this.scheduleRetry(attempt);
        return;
      }
      await this.blockControlAfterTicketError(
        attempt.config,
        "invalid_ticket",
      );
      return;
    }
    if (!this.isAttemptCurrent(attempt)) return;
    if (!isTicketResponse(value)) {
      this.controlAttempt = null;
      await this.blockControlAfterTicketError(
        attempt.config,
        "invalid_ticket",
      );
      return;
    }
    let authoritativeOrigins: string[];
    try {
      authoritativeOrigins = normalizeOriginPolicy(value.allowedOrigins);
    } catch {
      this.controlAttempt = null;
      await this.blockControlAfterTicketError(attempt.config, "invalid_ticket");
      return;
    }
    if (
      value.policyVersion < config.policyVersion ||
      (value.policyVersion === config.policyVersion &&
        !sameOrigins(authoritativeOrigins, config.originPolicy))
    ) {
      this.controlAttempt = null;
      await this.blockControlAfterTicketError(attempt.config, "invalid_ticket");
      return;
    }
    if (value.policyVersion > config.policyVersion) {
      try {
        const applied = await this.applyAuthoritativePolicy(
          value.policyVersion,
          authoritativeOrigins,
          attempt.generation,
          () => this.isAttemptCurrent(attempt),
        );
        if (applied === null) {
          this.retryPolicyReconciliation(attempt);
          return;
        }
        attempt.config.policyVersion = applied.policyVersion;
        attempt.config.originPolicy = [...applied.originPolicy];
      } catch {
        this.retryPolicyReconciliation(attempt);
        return;
      }
    }

    let url: URL;
    try {
      url = new URL(value.websocketPath, config.serviceOrigin);
      if (
        url.origin !== config.serviceOrigin ||
        (url.protocol !== "https:" && url.protocol !== "http:")
      ) {
        throw new Error("ticket websocket path changed service origin");
      }
    } catch {
      this.controlAttempt = null;
      await this.blockControlAfterTicketError(
        attempt.config,
        "invalid_ticket",
      );
      return;
    }
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("ticket", value.ticket);
    if (!this.isAttemptCurrent(attempt)) return;

    let peer!: ReconnectingWs;
    peer = new ReconnectingWs(
      () => url.toString(),
      {
        onCommand: (raw) => {
          if (!this.isPeerCurrent(attempt, peer)) return;
          const handleIfCurrent = async () => {
            if (this.isPeerCurrent(attempt, peer)) {
              await this.onControlFrame(raw, attempt, peer);
            }
          };
          const handling = this.controlFrameTail.then(
            handleIfCurrent,
            handleIfCurrent,
          );
          this.controlFrameTail = handling.catch(() => {});
        },
        onOpen: () => {
          if (!this.isPeerCurrent(attempt, peer)) return;
          const inventory = this.sessions.controlInventory();
          if (inventory === null) {
            peer.stop();
            if (this.control === peer) this.control = null;
            if (this.controlAttempt === attempt) this.controlAttempt = null;
            this.scheduleRetry(attempt);
            return;
          }
          this.ticketBackoffMs = TICKET_BACKOFF_BASE_MS;
          this.setStatus("connected");
          if (
            attempt.purpose === "cleanup" ||
            this.sessions.pendingReleaseCleanup()
          ) {
            void this.sessions
              .retryCleanup()
              .then(() => this.flushClosureOutbox(attempt, peer))
              .catch(() => {});
            return;
          }
          if (this.sessions.closureOutbox().length > 0) {
            void this.flushClosureOutbox(attempt, peer).catch(() => {});
            return;
          }
          attempt.helloSent = true;
          peer.send({
            type: "device_hello",
            protocolVersion: PROTOCOL_VERSION,
            capabilities: [...PROTOCOL_CAPABILITIES],
            deviceId: config.deviceId,
            browserEpoch: this.epoch,
            browser: navigator.userAgent,
            extVersion: browser.runtime.getManifest().version,
            allowedOrigins: attempt.config.originPolicy,
            policyVersion: attempt.config.policyVersion,
            assignments: inventory.assignments,
            ownedWindows: inventory.ownedWindows,
          } satisfies DeviceControlClientFrame);
          void this.flushClosureOutbox(attempt, peer).catch(() => {});
        },
        onClose: (event) => {
          if (!this.isPeerCurrent(attempt, peer)) return;
          if (
            event.code === WS_CLOSE_REPLACED ||
            event.code === WS_CLOSE_SESSION_TERMINAL
          ) {
            const reason =
              event.code === WS_CLOSE_REPLACED
                ? "replaced"
                : "terminal_close";
            this.blockedProfileIdentity = profileIdentity(attempt.config);
            this.invalidateControl();
            this.sessions.beginStopAll("discard");
            this.setStatus("error");
            void this.enqueueLifecycle(async () => {
              await this.ensureInitialized();
              await this.persistControlBlockAndDiscard(
                attempt.config,
                reason,
              );
            }).catch(() => {
              this.setStatus("error");
            });
            return;
          }
          peer.stop();
          this.control = null;
          this.controlAttempt = null;
          if (
            this.controlDesired(
              attempt.config,
              attempt.purpose,
              attempt.generation,
            )
          ) {
            this.scheduleRetry(attempt);
          } else {
            void this.resumeForGeneration(attempt.generation);
          }
        },
        heartbeatFrame: () => {
          if (this.sessions.closureOutbox().length > 0) {
            void this.flushClosureOutbox(attempt, peer).catch(() => {});
            return null;
          }
          if (!attempt.helloSent) return null;
          const inventory = this.sessions.controlInventory();
          return inventory === null
            ? null
            : {
                type: "heartbeat",
                deviceId: config.deviceId,
                browserEpoch: this.epoch,
                assignments: inventory.assignments,
                ownedWindows: inventory.ownedWindows,
              };
        },
      },
      DEVICE_CONTROL_FRAME_MAX_BYTES,
    );
    if (!this.isAttemptCurrent(attempt)) {
      peer.stop();
      return;
    }
    this.control = peer;
  }

  private async onControlFrame(
    raw: unknown,
    attempt: ControlAttempt,
    peer: ReconnectingWs,
  ): Promise<void> {
    if (!this.isPeerCurrent(attempt, peer)) return;
    const parsed = safeParseDeviceControlServerFrame(raw);
    if (!parsed.success || !this.isPeerCurrent(attempt, peer)) return;
    const frame = parsed.data;
    switch (frame.type) {
      case "provision":
        if (attempt.purpose !== "hosting") return;
        if (
          frame.policyVersion !== attempt.config.policyVersion ||
          !frame.allowedOrigins.every((origin) =>
            attempt.config.originPolicy.includes(origin),
          )
        ) {
          return;
        }
        try {
          const tab = await this.sessions.provision(
            frame,
            () => this.isHostingPeerCurrent(attempt, peer),
          );
          if (!this.isHostingPeerCurrent(attempt, peer)) return;
          peer.send({
            type: "provisioned",
            sessionId: frame.sessionId,
            leaseId: frame.leaseId,
            leaseEpoch: frame.leaseEpoch,
            browserEpoch: frame.browserEpoch,
            tab,
          } satisfies DeviceControlClientFrame);
        } catch (error) {
          if (
            error instanceof StaleProvisionError ||
            !this.isHostingPeerCurrent(attempt, peer)
          ) {
            await this.ensureConnection();
            return;
          }
          peer.send({
            type: "provision_failed",
            sessionId: frame.sessionId,
            leaseId: frame.leaseId,
            leaseEpoch: frame.leaseEpoch,
            browserEpoch: frame.browserEpoch,
            reason: "local provisioning failed",
          } satisfies DeviceControlClientFrame);
        }
        return;
      case "policy_update":
        if (frame.policyVersion <= attempt.config.policyVersion) return;
        try {
          const applied = await this.applyAuthoritativePolicy(
            frame.policyVersion,
            frame.allowedOrigins,
            attempt.generation,
            () => this.isPeerCurrent(attempt, peer),
          );
          if (applied === null) {
            this.retryPolicyReconciliation(attempt, peer);
            return;
          }
          attempt.config.policyVersion = applied.policyVersion;
          attempt.config.originPolicy = [...applied.originPolicy];
        } catch {
          this.retryPolicyReconciliation(attempt, peer);
          return;
        }
        if (!this.isPeerCurrent(attempt, peer)) return;
        peer.send({
          type: "policy_ack",
          deviceId: attempt.config.deviceId,
          browserEpoch: this.epoch,
          policyVersion: frame.policyVersion,
        } satisfies DeviceControlClientFrame);
        return;
      case "close_orphan":
        await this.sessions.closeOrphan(frame);
        return;
      case "close_lease":
        await this.sessions.closeLease(frame, "release");
        if (!this.isPeerCurrent(attempt, peer)) return;
        await this.flushClosureOutbox(attempt, peer);
        return;
      case "session_ticket":
        if (attempt.purpose !== "hosting") return;
        if (!this.isHostingPeerCurrent(attempt, peer)) return;
        this.sessions.connectSessionTicket(frame);
        return;
      case "credential_revoked":
        this.invalidateControl();
        this.sessions.beginStopAll("discard");
        await this.enqueueLifecycle(async () => {
          await this.handleCredentialRevoked();
        });
        return;
      case "closed_ack": {
        const acknowledged = await this.sessions.acknowledgeClosure(frame);
        if (!acknowledged || !this.isPeerCurrent(attempt, peer)) return;
        await this.flushClosureOutbox(attempt, peer);
        return;
      }
    }
  }

  private async flushClosureOutbox(
    attempt: ControlAttempt,
    peer: ReconnectingWs,
  ): Promise<void> {
    for (const entry of this.sessions.closureOutbox()) {
      if (!this.isPeerCurrent(attempt, peer)) return;
      if (!peer.send(closedFrame(entry))) return;
    }
    if (
      !attempt.helloSent &&
      !this.sessions.pendingReleaseCleanup() &&
      this.sessions.closureOutbox().length === 0
    ) {
      peer.stop();
      if (this.control === peer) this.control = null;
      if (this.controlAttempt === attempt) this.controlAttempt = null;
      await this.resumeForGeneration(attempt.generation);
    }
  }

  private async promoteStaged(generation: number): Promise<void> {
    const staged = this.stagedConfig;
    if (staged === null || !this.isGenerationCurrent(generation)) return;
    const stagedKey = await profileKey(staged);
    if (!this.isGenerationCurrent(generation)) return;
    if (!(await this.persistProfileState(staged, null, generation))) return;
    if (!this.isGenerationCurrent(generation)) return;
    this.config = staged;
    this.activeProfileKey = stagedKey;
    this.stagedConfig = null;
    if (staged.unattendedEnabled) {
      await this.connectControl(staged, "hosting", generation);
    } else {
      this.setStatus("disabled");
    }
  }

  private async handleCredentialRevoked(): Promise<void> {
    this.sessions.beginStopAll("discard");
    this.credentialRevoked = true;
    this.blockedProfileIdentity = null;
    this.controlBlock = null;
    this.stagedConfig = null;
    if (this.config !== null) {
      this.config = { ...this.config, unattendedEnabled: false };
      if (!(await this.persistStoppedProfile(this.generation))) return;
    }
    await this.sessions.stopAll("discard");
    await this.sessions.discardServerState();
    this.setStatus("error");
  }

  private async blockControlAfterTicketError(
    config: ProfileConfig,
    reason: ControlBlockReason,
  ): Promise<void> {
    this.sessions.beginStopAll("discard");
    this.blockedProfileIdentity = profileIdentity(config);
    this.invalidateControl();
    await this.enqueueLifecycle(async () => {
      await this.persistControlBlockAndDiscard(config, reason);
    });
  }

  private async persistControlBlockAndDiscard(
    config: ProfileConfig,
    reason: ControlBlockReason,
  ): Promise<void> {
    this.sessions.beginStopAll("discard");
    if (
      this.config === null ||
      profileIdentity(this.config) !== profileIdentity(config)
    ) {
      if (this.blockedProfileIdentity === profileIdentity(config)) {
        this.blockedProfileIdentity = null;
      }
      return;
    }
    this.blockedProfileIdentity = profileIdentity(config);
    const key = this.activeProfileKey;
    if (key === null) return;
    const block: ControlBlock = {
      version: 1,
      profileKey: key,
      reason,
    };
    this.controlBlock = block;
    await browser.storage.local.set({ [CONTROL_BLOCK_KEY]: block });
    if (!this.isControlBlocked()) return;
    await this.sessions.stopAll("discard");
    if (!this.isControlBlocked()) return;
    await this.sessions.discardServerState();
    if (!this.isControlBlocked()) return;
    this.setStatus("error");
  }

  private scheduleRetry(attempt: ControlAttempt): void {
    if (!this.controlDesired(attempt.config, attempt.purpose, attempt.generation)) {
      return;
    }
    if (this.retryTimer !== null) return;
    const delayMs = this.ticketBackoffMs;
    this.ticketBackoffMs = Math.min(
      this.ticketBackoffMs * 2,
      TICKET_BACKOFF_CAP_MS,
    );
    this.setStatus("connecting");
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connectControl(
        attempt.config,
        attempt.purpose,
        attempt.generation,
      );
    }, delayMs);
  }

  private retryPolicyReconciliation(
    attempt: ControlAttempt,
    peer?: ReconnectingWs,
  ): void {
    if (peer === undefined) {
      if (!this.isAttemptCurrent(attempt)) return;
    } else {
      if (!this.isPeerCurrent(attempt, peer)) return;
      this.control = null;
      peer.stop();
    }
    if (this.controlAttempt === attempt) this.controlAttempt = null;
    this.scheduleRetry(attempt);
  }

  private invalidateControl(): number {
    this.generation += 1;
    this.controlAttempt?.controller.abort();
    this.controlAttempt = null;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.ticketBackoffMs = TICKET_BACKOFF_BASE_MS;
    this.control?.stop();
    this.control = null;
    this.controlFrameTail = Promise.resolve();
    return this.generation;
  }

  private isGenerationCurrent(generation: number): boolean {
    return generation === this.generation;
  }

  private isAttemptCurrent(attempt: ControlAttempt): boolean {
    return (
      this.controlAttempt === attempt &&
      this.controlDesired(
        attempt.config,
        attempt.purpose,
        attempt.generation,
      )
    );
  }

  private isPeerCurrent(
    attempt: ControlAttempt,
    peer: ReconnectingWs,
  ): boolean {
    return this.control === peer && this.isAttemptCurrent(attempt);
  }

  private isHostingPeerCurrent(
    attempt: ControlAttempt,
    peer: ReconnectingWs,
  ): boolean {
    return (
      attempt.purpose === "hosting" &&
      this.isPeerCurrent(attempt, peer) &&
      this.config?.unattendedEnabled === true &&
      this.stagedConfig === null
    );
  }

  private controlDesired(
    config: ProfileConfig,
    purpose: ControlPurpose,
    generation: number,
  ): boolean {
    if (
      !this.isGenerationCurrent(generation) ||
      this.config === null ||
      this.isControlBlocked()
    ) {
      return false;
    }
    if (profileIdentity(this.config) !== profileIdentity(config)) return false;
    if (purpose === "hosting") {
      return this.config.unattendedEnabled && this.stagedConfig === null;
    }
    return (
      this.controlAttempt?.purpose === "cleanup" ||
      this.sessions.closureOutbox().length > 0 ||
      this.sessions.pendingReleaseCleanup()
    );
  }

  private configureCleanupIntent(
    normalized: ProfileConfig,
  ): "release" | "discard" | null {
    if (this.credentialRevoked) return "discard";
    const current = this.config;
    if (current === null) return null;
    const identityChanged =
      profileIdentity(current) !== profileIdentity(normalized);
    const disabling = current.unattendedEnabled && !normalized.unattendedEnabled;
    const switchesAuthority = identityChanged && !sameDeviceAuthority(current, normalized);
    if (!switchesAuthority && !disabling) return null;
    const ownsOldWork =
      current.unattendedEnabled ||
      this.sessions.assignments().length > 0 ||
      this.sessions.closureOutbox().length > 0 ||
      this.sessions.vacatedLeases().length > 0;
    return ownsOldWork ? "release" : null;
  }

  private async persistProfileState(
    active: ProfileConfig,
    staged: ProfileConfig | null,
    generation?: number,
  ): Promise<boolean> {
    let written = false;
    const write = this.configWriteTail.then(async () => {
      if (
        generation !== undefined &&
        !this.isGenerationCurrent(generation)
      ) {
        return;
      }
      await browser.storage.local.set({
        ...active,
        [STAGED_CONFIG_KEY]: staged === null ? null : cloneConfig(staged),
        [CREDENTIAL_REVOKED_KEY]: this.credentialRevoked,
        [CONTROL_BLOCK_KEY]: this.controlBlock,
      });
      written =
        generation === undefined || this.isGenerationCurrent(generation);
    });
    this.configWriteTail = write.catch(() => {});
    await write;
    return written;
  }

  private async persistStoppedProfile(generation: number): Promise<boolean> {
    const config = this.requiredConfig();
    try {
      return await this.persistProfileState(config, null, generation);
    } catch (firstError) {
      if (!this.isGenerationCurrent(generation)) return false;
      try {
        return await this.persistProfileState(config, null, generation);
      } catch (secondError) {
        if (!this.isGenerationCurrent(generation)) return false;
        try {
          await browser.storage.local.remove([...PROFILE_STATE_KEYS]);
        } catch (removeError) {
          throw new AggregateError(
            [firstError, secondError, removeError],
            "could not persist or clear the stopped profile",
          );
        }
        return this.isGenerationCurrent(generation);
      }
    }
  }

  private async loadBrowserEpoch(): Promise<string> {
    const stored = await browser.storage.session.get(BROWSER_EPOCH_KEY);
    const value = stored[BROWSER_EPOCH_KEY];
    if (typeof value === "string" && value.length > 0) return value;
    const epoch = crypto.randomUUID();
    await browser.storage.session.set({ [BROWSER_EPOCH_KEY]: epoch });
    return epoch;
  }

  private async loadProfileState(): Promise<{
    active: ProfileConfig | null;
    staged: ProfileConfig | null;
    credentialRevoked: boolean;
    controlBlock: ControlBlock | null;
  }> {
    const stored = await browser.storage.local.get([...PROFILE_STATE_KEYS]);
    const candidate = {
      serviceOrigin: stored.serviceOrigin,
      unattendedEnabled: stored.unattendedEnabled,
      deviceId: stored.deviceId,
      deviceCredential: stored.deviceCredential,
      originPolicy: stored.originPolicy,
      // Protocol-2 profiles predate versioned policy but already carry the
      // authoritative origin snapshot. Preserve their device credential and
      // migrate that snapshot to the initial version instead of treating the
      // whole installation as corrupt and forcing an identity-changing pair.
      policyVersion: stored.policyVersion ?? 1,
    };
    let active: ProfileConfig | null;
    try {
      active = normalizeProfileConfig(candidate);
    } catch {
      active = null;
    }
    if (active !== null && stored.policyVersion === undefined) {
      await browser.storage.local.set({ policyVersion: active.policyVersion });
    }
    let staged: ProfileConfig | null;
    try {
      staged =
        stored[STAGED_CONFIG_KEY] === null ||
        stored[STAGED_CONFIG_KEY] === undefined
          ? null
          : normalizeProfileConfig(stored[STAGED_CONFIG_KEY]);
    } catch {
      staged = null;
    }
    if (
      this.requiredServiceOrigin !== undefined &&
      stored.serviceOrigin !== undefined &&
      (active === null ||
        active.serviceOrigin !== this.requiredServiceOrigin)
    ) {
      await browser.storage.local.remove([...PROFILE_STATE_KEYS]);
      return {
        active: null,
        staged: null,
        credentialRevoked: false,
        controlBlock: null,
      };
    }
    if (
      this.requiredServiceOrigin !== undefined &&
      stored[STAGED_CONFIG_KEY] !== null &&
      stored[STAGED_CONFIG_KEY] !== undefined &&
      (staged === null ||
        staged.serviceOrigin !== this.requiredServiceOrigin)
    ) {
      staged = null;
      await browser.storage.local.remove(STAGED_CONFIG_KEY);
    }
    return {
      active,
      staged,
      credentialRevoked: stored[CREDENTIAL_REVOKED_KEY] === true,
      controlBlock: parseControlBlock(stored[CONTROL_BLOCK_KEY]),
    };
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
    if (this.config === null) {
      throw new Error("unattended profile is not configured");
    }
    return this.config;
  }

  private async applyAuthoritativePolicy(
    policyVersion: number,
    origins: string[],
    generation: number,
    isCurrent: () => boolean,
  ): Promise<ProfileConfig | null> {
    let applied: ProfileConfig | null = null;
    await this.enqueueLifecycle(async () => {
      if (!this.isGenerationCurrent(generation) || !isCurrent()) return;
      const current = this.requiredConfig();
      const normalized = normalizeOriginPolicy(origins);
      if (policyVersion < current.policyVersion) return;
      if (policyVersion === current.policyVersion) {
        if (!sameOrigins(normalized, current.originPolicy)) {
          throw new Error("authoritative policy conflicts at the current version");
        }
        applied = cloneConfig(current);
        return;
      }
      await this.sessions.applyPolicy(policyVersion, normalized);
      if (!this.isGenerationCurrent(generation) || !isCurrent()) return;
      const updated = {
        ...this.requiredConfig(),
        originPolicy: normalized,
        policyVersion,
      };
      if (!(await this.persistProfileState(updated, this.stagedConfig, generation))) {
        return;
      }
      if (!isCurrent()) return;
      this.config = updated;
      applied = cloneConfig(updated);
    });
    return applied;
  }

  private assertServiceOrigin(config: ProfileConfig): void {
    if (
      this.requiredServiceOrigin !== undefined &&
      config.serviceOrigin !== this.requiredServiceOrigin
    ) {
      throw new Error("profile service origin is not allowed in this build");
    }
  }

  private pairedTransitionCommitted(
    expected: ProfileConfig,
    generation: number,
  ): boolean {
    return (
      this.isGenerationCurrent(generation) &&
      this.config !== null &&
      sameProfileConfig(this.config, expected) &&
      this.stagedConfig === null &&
      !this.credentialRevoked
    );
  }

  private isControlBlocked(): boolean {
    return (
      this.config !== null &&
      this.blockedProfileIdentity === profileIdentity(this.config)
    );
  }

  private enqueueLifecycle(operation: () => Promise<void>): Promise<void> {
    const run = this.lifecycleTail.then(operation, operation);
    this.lifecycleTail = run.catch(() => {});
    return run;
  }

  private setStatus(status: ProfileStatus): void {
    this.status = status;
    this.onStatus?.(status);
  }
}

function normalizeProfileConfig(value: unknown): ProfileConfig {
  if (typeof value !== "object" || value === null) {
    throw new Error("invalid profile config");
  }
  const input = value as Partial<ProfileConfig>;
  const origin =
    typeof input.serviceOrigin === "string"
      ? new URL(input.serviceOrigin)
      : null;
  const serviceLoopback =
    (typeof __UNDERSTUDY_STORE__ === "undefined" ||
      !__UNDERSTUDY_STORE__) &&
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
    input.originPolicy.length > 32 ||
    !input.originPolicy.every((item) => typeof item === "string") ||
    typeof input.policyVersion !== "number" ||
    !Number.isInteger(input.policyVersion) ||
    input.policyVersion < 1
  ) {
    throw new Error("invalid profile config");
  }
  const originPolicy = normalizeOriginPolicy(input.originPolicy);
  return {
    serviceOrigin: origin.origin,
    unattendedEnabled: input.unattendedEnabled,
    deviceId: input.deviceId.toLowerCase(),
    deviceCredential: input.deviceCredential,
    originPolicy,
    policyVersion: input.policyVersion,
  };
}

function canonicalOrigin(value: string): string {
  if (
    value !== value.trim() ||
    value.includes("*") ||
    value.includes("?") ||
    value.includes("#")
  ) {
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
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && loopback))
  ) {
    throw new Error("invalid local origin policy");
  }
  return url.origin;
}

function normalizeOriginPolicy(origins: readonly string[]): string[] {
  return [...new Set(origins.map(canonicalOrigin))].sort();
}

function cloneConfig(config: ProfileConfig): ProfileConfig {
  return { ...config, originPolicy: [...config.originPolicy] };
}

function profileIdentity(config: ProfileConfig): string {
  return JSON.stringify({
    serviceOrigin: config.serviceOrigin,
    deviceId: config.deviceId,
    deviceCredential: config.deviceCredential,
  });
}

function sameDeviceAuthority(left: ProfileConfig, right: ProfileConfig): boolean {
  return (
    left.serviceOrigin === right.serviceOrigin && left.deviceId === right.deviceId
  );
}

function samePairingAuthority(left: ProfileConfig, right: ProfileConfig): boolean {
  return (
    left.serviceOrigin === right.serviceOrigin &&
    left.deviceId === right.deviceId &&
    left.deviceCredential === right.deviceCredential &&
    left.policyVersion === right.policyVersion &&
    sameOrigins(left.originPolicy, right.originPolicy)
  );
}

function sameProfileConfig(left: ProfileConfig, right: ProfileConfig): boolean {
  return (
    left.serviceOrigin === right.serviceOrigin &&
    left.unattendedEnabled === right.unattendedEnabled &&
    left.deviceId === right.deviceId &&
    left.deviceCredential === right.deviceCredential &&
    left.policyVersion === right.policyVersion &&
    sameOrigins(left.originPolicy, right.originPolicy)
  );
}

async function profileKey(config: ProfileConfig): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(profileIdentity(config)),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function parseControlBlock(value: unknown): ControlBlock | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<ControlBlock>;
  if (
    candidate.version !== 1 ||
    typeof candidate.profileKey !== "string" ||
    !/^[0-9a-f]{64}$/.test(candidate.profileKey) ||
    (candidate.reason !== "replaced" &&
      candidate.reason !== "terminal_close" &&
      candidate.reason !== "ticket_rejected" &&
      candidate.reason !== "invalid_ticket")
  ) {
    return null;
  }
  return candidate as ControlBlock;
}

function isTicketResponse(
  value: unknown,
): value is {
  ticket: string;
  websocketPath: string;
  allowedOrigins: string[];
  policyVersion: number;
} {
  if (typeof value !== "object" || value === null) return false;
  const ticket = value as {
    ticket?: unknown;
    websocketPath?: unknown;
    allowedOrigins?: unknown;
    policyVersion?: unknown;
  };
  return (
    typeof ticket.ticket === "string" &&
    ticket.ticket.length > 0 &&
    typeof ticket.websocketPath === "string" &&
    ticket.websocketPath.length > 0 &&
    Array.isArray(ticket.allowedOrigins) &&
    ticket.allowedOrigins.length <= 32 &&
    ticket.allowedOrigins.every((origin) => typeof origin === "string") &&
    typeof ticket.policyVersion === "number" &&
    Number.isInteger(ticket.policyVersion) &&
    ticket.policyVersion >= 1
  );
}

function sameOrigins(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((origin, index) => origin === right[index]);
}

function isRetryableTicketStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function closedFrame(entry: ClosureRecord): DeviceControlClientFrame {
  return { type: "closed", ...entry };
}
