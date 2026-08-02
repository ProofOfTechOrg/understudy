/**
 * Pairing-offer redemption. The dashboard sends the short-lived offer through
 * Chrome external messaging; this module exchanges it for a profile config.
 *
 * A current credential proves an existing installation so re-pairing rotates
 * that device instead of leaving a live predecessor.
 */

import {
  RequestDeadlineError,
  readBoundedJson,
  withRequestDeadline,
} from "./request-deadline";

export const DEFAULT_SERVICE_ORIGIN = "https://understudy.proofof.tech";
export const PAIRING_CLAIM_KEY = "understudy:pairingClaim";
const PAIRING_REQUEST_TIMEOUT_MS = 15_000;
const PAIRING_RESPONSE_MAX_BYTES = 16 * 1024;

interface PairingClaimStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface PairingClaim {
  offer: string;
  claimId: string;
  previousCredential: string | undefined;
}

type PairingClaimPhase = "preparing" | "ready" | "dispatched";

interface PairingIntent extends PairingClaim {
  phase: PairingClaimPhase;
}

interface QueuedPairingIntent {
  offer: string;
  claimId: string;
}

interface PairingIntentState {
  active: PairingIntent;
  queued: QueuedPairingIntent | null;
  stopRequested: boolean;
}

export interface PairingDisposition {
  allowHosting: boolean;
  queued: boolean;
  stopRequested: boolean;
}

export class PairingClaimCoordinator {
  private operationTail: Promise<void> = Promise.resolve();

  constructor(private readonly storage: PairingClaimStorage) {}

  request(offer: string): Promise<void> {
    return this.exclusive(async () => {
      const stored = await loadPairingState(this.storage);
      if (stored === null) {
        await putPairingState(this.storage, {
          active: newPairingIntent(offer),
          queued: null,
          stopRequested: false,
        });
        return;
      }
      if (stored.active.offer === offer) {
        return;
      }
      if (stored.active.phase === "dispatched") {
        await putPairingState(this.storage, {
          active: stored.active,
          queued:
            stored.queued?.offer === offer
              ? stored.queued
              : { offer, claimId: createPairingClaimId() },
          stopRequested: false,
        });
        return;
      }
      await putPairingState(this.storage, {
        active: newPairingIntent(offer),
        queued: null,
        stopRequested: false,
      });
    });
  }

  next(
    targetOffer: string | null,
    getCurrentCredential: () => Promise<string | undefined>,
  ): Promise<PairingClaim | null> {
    return this.exclusive(async () => {
      const stored = await loadPairingState(this.storage);
      if (stored === null) return null;
      if (
        targetOffer !== null &&
        stored.active.phase !== "dispatched" &&
        stored.active.offer !== targetOffer
      ) {
        return null;
      }
      if (stored.active.phase !== "preparing") {
        return toPairingClaim(stored.active);
      }
      const resolved: PairingIntentState = {
        ...stored,
        active: {
          ...stored.active,
          previousCredential: await getCurrentCredential(),
          phase: "ready",
        },
      };
      await putPairingState(this.storage, resolved);
      return toPairingClaim(resolved.active);
    });
  }

  markDispatched(expected: PairingClaim): Promise<boolean> {
    return this.exclusive(async () => {
      const stored = await loadPairingState(this.storage);
      if (stored === null || !samePairingClaim(stored.active, expected)) {
        return false;
      }
      if (stored.active.phase === "preparing") return false;
      if (stored.active.phase === "ready") {
        await putPairingState(this.storage, {
          ...stored,
          active: { ...stored.active, phase: "dispatched" },
        });
      }
      return true;
    });
  }

  disposition(expected: PairingClaim): Promise<PairingDisposition | null> {
    return this.exclusive(async () => {
      const stored = await loadPairingState(this.storage);
      if (stored === null || !samePairingClaim(stored.active, expected)) {
        return null;
      }
      return {
        allowHosting: !stored.stopRequested && stored.queued === null,
        queued: stored.queued !== null,
        stopRequested: stored.stopRequested,
      };
    });
  }

  complete(expected: PairingClaim): Promise<boolean> {
    return this.exclusive(async () => {
      const stored = await loadPairingState(this.storage);
      if (stored === null || !samePairingClaim(stored.active, expected)) {
        return false;
      }
      if (stored.queued === null) {
        await this.storage.remove(PAIRING_CLAIM_KEY);
      } else {
        await putPairingState(this.storage, {
          active: {
            ...stored.queued,
            previousCredential: undefined,
            phase: "preparing",
          },
          queued: null,
          stopRequested: false,
        });
      }
      return true;
    });
  }

  reject(expected: PairingClaim): Promise<boolean> {
    return this.complete(expected);
  }

  cancel(): Promise<void> {
    return this.exclusive(async () => {
      const stored = await loadPairingState(this.storage);
      if (stored?.active.phase !== "dispatched") {
        await this.storage.remove(PAIRING_CLAIM_KEY);
        return;
      }
      await putPairingState(this.storage, {
        active: stored.active,
        queued: null,
        stopRequested: true,
      });
    });
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/** A redemption failure with a message written for the side panel. */
export class PairingError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface PairingResult {
  serviceOrigin: string;
  deviceId: string;
  deviceCredential: string;
  originPolicy: string[];
  policyVersion: number;
  unattendedEnabled: boolean;
}

export function createPairingClaimId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function loadPairingState(
  storage: PairingClaimStorage,
): Promise<PairingIntentState | null> {
  const raw = (await storage.get(PAIRING_CLAIM_KEY))[PAIRING_CLAIM_KEY];
  const state = parsePairingState(raw);
  if (state === null && raw !== undefined) await storage.remove(PAIRING_CLAIM_KEY);
  return state;
}

async function putPairingState(
  storage: PairingClaimStorage,
  state: PairingIntentState,
): Promise<void> {
  await storage.set({
    [PAIRING_CLAIM_KEY]: {
      version: 3,
      active: serializePairingIntent(state.active),
      queued: state.queued,
      stopRequested: state.stopRequested,
    },
  });
}

function parsePairingState(value: unknown): PairingIntentState | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as {
    version?: unknown;
    active?: unknown;
    queued?: unknown;
    stopRequested?: unknown;
    offer?: unknown;
    claimId?: unknown;
    credentialResolved?: unknown;
    previousCredential?: unknown;
  };
  if (candidate.version === 3) {
    const active = parsePairingIntent(candidate.active);
    const queued = parseQueuedPairingIntent(candidate.queued);
    if (
      active === null ||
      queued === undefined ||
      typeof candidate.stopRequested !== "boolean" ||
      (candidate.stopRequested && queued !== null)
    ) {
      return null;
    }
    return { active, queued, stopRequested: candidate.stopRequested };
  }
  return parseLegacyPairingState(candidate);
}

function parseLegacyPairingState(candidate: {
  version?: unknown;
  offer?: unknown;
  claimId?: unknown;
  credentialResolved?: unknown;
  previousCredential?: unknown;
}): PairingIntentState | null {
  const validEnvelope =
    (candidate.version === 1 || candidate.version === 2) &&
    validOffer(candidate.offer) &&
    validClaimId(candidate.claimId) &&
    validPreviousCredential(candidate.previousCredential);
  if (!validEnvelope) return null;
  const credentialResolved =
    candidate.version === 1 ? true : candidate.credentialResolved;
  if (typeof credentialResolved !== "boolean") return null;
  if (!credentialResolved && candidate.previousCredential !== null) return null;
  return {
    active: {
      offer: candidate.offer as string,
      claimId: candidate.claimId as string,
      previousCredential: nullableCredential(candidate.previousCredential),
      phase: credentialResolved ? "ready" : "preparing",
    },
    queued: null,
    stopRequested: false,
  };
}

function parsePairingIntent(value: unknown): PairingIntent | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as {
    offer?: unknown;
    claimId?: unknown;
    previousCredential?: unknown;
    phase?: unknown;
  };
  if (
    !validOffer(candidate.offer) ||
    !validClaimId(candidate.claimId) ||
    !validPreviousCredential(candidate.previousCredential) ||
    (candidate.phase !== "preparing" &&
      candidate.phase !== "ready" &&
      candidate.phase !== "dispatched") ||
    (candidate.phase === "preparing" && candidate.previousCredential !== null)
  ) {
    return null;
  }
  return {
    offer: candidate.offer as string,
    claimId: candidate.claimId as string,
    previousCredential: nullableCredential(candidate.previousCredential),
    phase: candidate.phase,
  };
}

function parseQueuedPairingIntent(value: unknown): QueuedPairingIntent | null | undefined {
  if (value === null) return null;
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as { offer?: unknown; claimId?: unknown };
  return validOffer(candidate.offer) && validClaimId(candidate.claimId)
    ? { offer: candidate.offer as string, claimId: candidate.claimId as string }
    : undefined;
}

function serializePairingIntent(intent: PairingIntent): Record<string, unknown> {
  return {
    offer: intent.offer,
    claimId: intent.claimId,
    previousCredential: intent.previousCredential ?? null,
    phase: intent.phase,
  };
}

function newPairingIntent(offer: string): PairingIntent {
  return {
    offer,
    claimId: createPairingClaimId(),
    previousCredential: undefined,
    phase: "preparing",
  };
}

function validOffer(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

function validClaimId(value: unknown): value is string {
  return validOffer(value);
}

function validPreviousCredential(value: unknown): boolean {
  return (
    value === null ||
    (typeof value === "string" && /^udt_v[12]_[A-Za-z0-9_-]{43}$/.test(value))
  );
}

function nullableCredential(value: unknown): string | undefined {
  return value === null ? undefined : (value as string);
}

function toPairingClaim(intent: PairingIntent): PairingClaim {
  return {
    offer: intent.offer,
    claimId: intent.claimId,
    previousCredential: intent.previousCredential,
  };
}

function samePairingClaim(left: PairingClaim, right: PairingClaim): boolean {
  return (
    left.offer === right.offer &&
    left.claimId === right.claimId &&
    left.previousCredential === right.previousCredential
  );
}

function parsePairingResult(value: unknown): PairingResult | null {
  if (typeof value !== "object" || value === null) return null;
  const body = value as Partial<PairingResult>;
  if (
    typeof body.serviceOrigin !== "string" ||
    typeof body.deviceId !== "string" ||
    typeof body.deviceCredential !== "string" ||
    !Array.isArray(body.originPolicy) ||
    !body.originPolicy.every((origin) => typeof origin === "string") ||
    typeof body.unattendedEnabled !== "boolean" ||
    typeof body.policyVersion !== "number" ||
    !Number.isInteger(body.policyVersion) ||
    body.policyVersion < 1
  ) {
    return null;
  }
  return {
    serviceOrigin: body.serviceOrigin,
    deviceId: body.deviceId,
    deviceCredential: body.deviceCredential,
    originPolicy: body.originPolicy,
    unattendedEnabled: body.unattendedEnabled,
    policyVersion: body.policyVersion,
  };
}

export async function redeemPairingOffer(
  offer: string,
  previousCredential?: string,
  serviceOrigin: string = DEFAULT_SERVICE_ORIGIN,
  claimId: string = createPairingClaimId(),
): Promise<PairingResult> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(offer)) {
    throw new PairingError("The dashboard sent an invalid pairing offer. Generate a new one.");
  }
  if (
    previousCredential !== undefined &&
    !/^udt_v[12]_[A-Za-z0-9_-]{43}$/.test(previousCredential)
  ) {
    throw new PairingError("The existing browser credential cannot be rotated.");
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(claimId)) {
    throw new PairingError("The browser pairing attempt is invalid. Generate a new offer.");
  }
  let response: Response;
  try {
    response = await withRequestDeadline(PAIRING_REQUEST_TIMEOUT_MS, (signal) =>
      fetch(new URL("/v1/pairing/claim", serviceOrigin).toString(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          offer,
          claimId,
          ...(previousCredential === undefined ? {} : { previousCredential }),
        }),
        signal,
      }),
    );
  } catch {
    throw new PairingError(
      "Could not reach the pairing service. Check your connection and try again.",
    );
  }
  if (response.status === 404) {
    throw new PairingError(
      "That offer is invalid or has expired. Generate a fresh one in the dashboard.",
      404,
    );
  }
  if (response.status === 429) {
    throw new PairingError("Too many attempts — wait a minute and try again.", 429);
  }
  if (!response.ok) {
    throw new PairingError(
      `The pairing service is unavailable right now (HTTP ${response.status}). Try again shortly.`,
      response.status,
    );
  }
  let body: unknown;
  try {
    body = await withRequestDeadline(PAIRING_REQUEST_TIMEOUT_MS, (signal) =>
      readBoundedJson(response, signal, PAIRING_RESPONSE_MAX_BYTES),
    );
  } catch (error) {
    if (error instanceof RequestDeadlineError) {
      throw new PairingError(
        "Could not reach the pairing service. Check your connection and try again.",
      );
    }
    throw new PairingError("The pairing service sent an unreadable reply. Try again.");
  }
  const result = parsePairingResult(body);
  if (result === null) {
    throw new PairingError("The pairing service sent an unreadable reply. Try again.");
  }
  return result;
}
