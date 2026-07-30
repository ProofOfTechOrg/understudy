/**
 * Pairing-code redemption (D6): the side panel pastes one short-lived code,
 * this module exchanges it at POST /v1/pairing/claim for a full profile
 * config, and background.ts feeds that into the SAME profileClient.configure
 * path the manual form uses. All redemption logic lives here so
 * profile-client.ts takes no diff at all.
 *
 * Because redeeming always mints a fresh deviceId AND credential, the
 * resulting profileKey never matches a stored ControlBlock — "pair again
 * with a new code" is the universal, reinstall-free recovery from a blocked
 * profile.
 */

export const DEFAULT_SERVICE_ORIGIN = "https://understudy.proofof.tech";

/**
 * Uppercase, strip separators, map the Crockford confusables (O→0, I/L→1).
 * Mirrors the server's normalizePairingCode (apps/backend/src/
 * account-directory.ts); the two must stay in sync.
 */
export function normalizePairingCode(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
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
  unattendedEnabled: boolean;
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
    typeof body.unattendedEnabled !== "boolean"
  ) {
    return null;
  }
  return {
    serviceOrigin: body.serviceOrigin,
    deviceId: body.deviceId,
    deviceCredential: body.deviceCredential,
    originPolicy: body.originPolicy,
    unattendedEnabled: body.unattendedEnabled,
  };
}

export async function redeemPairingCode(
  code: string,
  serviceOrigin: string = DEFAULT_SERVICE_ORIGIN,
): Promise<PairingResult> {
  const normalized = normalizePairingCode(code);
  if (!/^[0-9A-Z]{8}$/.test(normalized)) {
    throw new PairingError(
      "That doesn't look like a pairing code — it has 8 letters and digits, like K7Q2-M9XR.",
    );
  }
  let response: Response;
  try {
    response = await fetch(new URL("/v1/pairing/claim", serviceOrigin).toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: normalized }),
    });
  } catch {
    throw new PairingError(
      "Could not reach the pairing service. Check your connection and try again.",
    );
  }
  if (response.status === 404) {
    throw new PairingError(
      "That code is invalid or has expired. Generate a fresh one in the dashboard.",
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
    body = await response.json();
  } catch {
    throw new PairingError("The pairing service sent an unreadable reply. Try again.");
  }
  const result = parsePairingResult(body);
  if (result === null) {
    throw new PairingError("The pairing service sent an unreadable reply. Try again.");
  }
  return result;
}
