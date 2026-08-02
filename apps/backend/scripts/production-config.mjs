import { parseStaticDeviceTokens } from "../src/static-device-config.mjs";

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const EXTENSION_ID_PATTERN = /^[a-p]{32}$/;

export function validateProductionDeviceTokens(value, canaryDigest) {
  if (!DIGEST_PATTERN.test(canaryDigest)) {
    throw new Error("canary credential digest is invalid");
  }
  const parsed = parseStaticDeviceTokens(value);
  if (!Object.hasOwn(parsed, canaryDigest)) {
    throw new Error("DEVICE_TOKENS does not contain the canary credential");
  }
  return { deviceCount: Object.keys(parsed).length };
}

export function validateProductionExtensionId(value) {
  if (!EXTENSION_ID_PATTERN.test(value)) {
    throw new Error("extension ID must be one published Chrome extension ID");
  }
  return value;
}
