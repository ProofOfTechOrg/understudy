import { parseStaticDeviceTokens } from "../src/static-device-config.mjs";
import targets from "../../../deployment-targets.json" with { type: "json" };

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const PRODUCTION_EXTENSION_ID = targets.production.extensionId;

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
  if (value !== PRODUCTION_EXTENSION_ID) {
    throw new Error("extension ID must match the published Chrome extension");
  }
  return value;
}
