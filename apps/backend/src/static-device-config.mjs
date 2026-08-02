const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const DEVICE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEVICE_FIELDS = [
  "allowedOrigins",
  "credentialVersion",
  "deviceId",
  "policyVersion",
  "tenantId",
];

export function parseStaticDeviceTokens(value) {
  if (!isRecord(value) || Object.keys(value).length === 0) {
    throw new Error("DEVICE_TOKENS must be a nonempty object");
  }
  const deviceIds = new Set();
  const parsed = {};
  for (const [digest, entry] of Object.entries(value)) {
    if (!DIGEST_PATTERN.test(digest) || !isRecord(entry)) {
      throw new Error("DEVICE_TOKENS contains an invalid entry");
    }
    if (!sameStrings(Object.keys(entry).sort(), DEVICE_FIELDS)) {
      throw new Error("DEVICE_TOKENS entry fields do not match the runtime contract");
    }
    if (
      typeof entry.tenantId !== "string" ||
      entry.tenantId.length === 0 ||
      entry.tenantId.includes("/") ||
      typeof entry.deviceId !== "string" ||
      !DEVICE_ID_PATTERN.test(entry.deviceId) ||
      !positiveInteger(entry.credentialVersion) ||
      !positiveInteger(entry.policyVersion)
    ) {
      throw new Error("DEVICE_TOKENS contains an invalid device identity");
    }
    const deviceId = entry.deviceId.toLowerCase();
    if (deviceIds.has(deviceId)) {
      throw new Error("DEVICE_TOKENS contains more than one credential for a device");
    }
    deviceIds.add(deviceId);
    parsed[digest] = {
      tenantId: entry.tenantId,
      deviceId,
      credentialVersion: entry.credentialVersion,
      allowedOrigins: validateCanonicalOrigins(entry.allowedOrigins),
      policyVersion: entry.policyVersion,
    };
  }
  return parsed;
}

function validateCanonicalOrigins(value) {
  if (!Array.isArray(value) || value.length > 32) {
    throw new Error("allowedOrigins must contain at most 32 origins");
  }
  const canonical = value.map(canonicalOrigin);
  const normalized = [...new Set(canonical)].sort();
  if (!sameStrings(value, normalized)) {
    throw new Error("allowedOrigins must be sorted, unique, and canonical");
  }
  return normalized;
}

function canonicalOrigin(value) {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    value.includes("*") ||
    value.includes("?") ||
    value.includes("#")
  ) {
    throw new Error("allowedOrigins contains an invalid origin");
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("allowedOrigins contains an invalid origin");
  }
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]" ||
    url.hostname.endsWith(".localhost");
  if (
    url.username !== "" ||
    url.password !== "" ||
    (url.pathname !== "" && url.pathname !== "/") ||
    url.search !== "" ||
    url.hash !== "" ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    value !== url.origin
  ) {
    throw new Error("allowedOrigins contains a noncanonical origin");
  }
  return url.origin;
}

function positiveInteger(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameStrings(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
