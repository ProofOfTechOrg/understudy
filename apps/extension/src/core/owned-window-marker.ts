import type { OwnedWindow } from "@understudy/protocol";

const BOOTSTRAP_PATH = "/unattended-bootstrap.html";
const HASH_PREFIX = "#owned=";
const MAX_MARKER_BYTES = 1024;

type OwnedWindowFence = Pick<
  OwnedWindow,
  "sessionId" | "leaseId" | "leaseEpoch" | "browserEpoch"
>;

export function ownedWindowBootstrapUrl(
  extensionRoot: string,
  fence: OwnedWindowFence,
): string {
  const url = new URL(BOOTSTRAP_PATH, extensionRoot);
  const marker: OwnedWindowFence = {
    sessionId: fence.sessionId,
    leaseId: fence.leaseId,
    leaseEpoch: fence.leaseEpoch,
    browserEpoch: fence.browserEpoch,
  };
  url.hash = `${HASH_PREFIX}${base64urlEncode(
    new TextEncoder().encode(JSON.stringify(marker)),
  )}`;
  return url.toString();
}

export function ownedWindowFromBootstrapUrl(
  extensionRoot: string,
  value: string,
  windowId: number,
  tabId: number | null,
): OwnedWindow | null {
  let expected: URL;
  let url: URL;
  try {
    expected = new URL(BOOTSTRAP_PATH, extensionRoot);
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== expected.protocol ||
    url.host !== expected.host ||
    url.pathname !== expected.pathname ||
    url.search.length > 0 ||
    !url.hash.startsWith(HASH_PREFIX)
  ) {
    return null;
  }
  const encoded = url.hash.slice(HASH_PREFIX.length);
  if (encoded.length === 0 || encoded.length > MAX_MARKER_BYTES) return null;
  let valueFromMarker: unknown;
  try {
    valueFromMarker = JSON.parse(
      new TextDecoder().decode(base64urlDecode(encoded)),
    ) as unknown;
  } catch {
    return null;
  }
  if (!isOwnedWindowFence(valueFromMarker)) return null;
  return { ...valueFromMarker, tabId, windowId };
}

function isOwnedWindowFence(value: unknown): value is OwnedWindowFence {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    Object.keys(candidate).length === 4 &&
    validId(candidate.sessionId) &&
    validId(candidate.leaseId) &&
    typeof candidate.leaseEpoch === "number" &&
    Number.isInteger(candidate.leaseEpoch) &&
    candidate.leaseEpoch >= 0 &&
    validId(candidate.browserEpoch)
  );
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 128;
}

function base64urlEncode(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid base64url");
  const standard = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(standard + "=".repeat((4 - (standard.length % 4)) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
