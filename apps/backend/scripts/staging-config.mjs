import { createHash } from "node:crypto";

import targets from "../../../deployment-targets.json" with { type: "json" };

export const STAGING_EXTENSION_ID = targets.staging.extensionId;

export function validateStagingConfiguration(values) {
  const authHmacSecret = secretLine(values.AUTH_HMAC_SECRET, "AUTH_HMAC_SECRET");
  const wsTicketSecret = secretLine(values.WS_TICKET_SECRET, "WS_TICKET_SECRET");
  if (authHmacSecret.length < 32 || wsTicketSecret.length < 32) {
    throw new Error("staging signing secrets must contain at least 32 characters");
  }
  const extensionId = secretLine(values.EXTENSION_ID, "EXTENSION_ID");
  if (extensionId !== STAGING_EXTENSION_ID) {
    throw new Error("staging EXTENSION_ID does not match the pinned manifest key");
  }
  for (const name of ["CALLER_TOKENS", "EXTENSION_TOKENS", "DEVICE_TOKENS"]) {
    const source = values[name].trimEnd();
    const parsed = JSON.parse(source);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      Object.keys(parsed).length !== 0
    ) {
      throw new Error(`staging ${name} must be an empty JSON object`);
    }
  }
  return Object.fromEntries(
    Object.entries(values).map(([name, source]) => [
      name,
      createHash("sha256").update(source.trimEnd()).digest("hex"),
    ]),
  );
}

function secretLine(source, name) {
  const value = source.endsWith("\n") ? source.slice(0, -1) : source;
  if (value.includes("\n") || value.includes("\r") || value !== value.trim()) {
    throw new Error(`${name} must contain one line without surrounding whitespace`);
  }
  return value;
}
