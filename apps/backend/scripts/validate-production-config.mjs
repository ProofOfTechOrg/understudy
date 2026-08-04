#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  validateProductionDeviceTokens,
  validateProductionExtensionId,
} from "./production-config.mjs";

if (process.argv.length !== 5) {
  process.stderr.write(
    "usage: validate-production-config.mjs device-tokens.json extension-id.txt canary-credential.txt\n",
  );
  process.exit(2);
}

const [, , deviceTokensPath, extensionIdPath, canaryCredentialPath] = process.argv;

try {
  const [deviceTokensSource, extensionIdSource, canaryCredentialSource] =
    await Promise.all([
      readFile(deviceTokensPath, "utf8"),
      readFile(extensionIdPath, "utf8"),
      readFile(canaryCredentialPath, "utf8"),
    ]);
  const extensionId = validateProductionExtensionId(
    singleLine(extensionIdSource, "extension ID"),
  );
  const canaryCredential = singleLine(
    canaryCredentialSource,
    "canary credential",
  );
  if (canaryCredential.length === 0) {
    throw new Error("canary credential is empty");
  }
  const canaryDigest = createHash("sha256")
    .update(canaryCredential)
    .digest("hex");
  const normalizedDeviceTokensSource = deviceTokensSource.trimEnd();
  const deviceTokens = JSON.parse(normalizedDeviceTokensSource);
  const { deviceCount } = validateProductionDeviceTokens(
    deviceTokens,
    canaryDigest,
  );
  process.stdout.write(
    JSON.stringify({
      deviceTokensSha256: createHash("sha256")
        .update(normalizedDeviceTokensSource)
        .digest("hex"),
      extensionId,
      canaryCredentialPresent: true,
      deviceCount,
    }),
  );
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : "production configuration is invalid"}\n`,
  );
  process.exit(2);
}

function singleLine(source, label) {
  const value = source.endsWith("\n") ? source.slice(0, -1) : source;
  if (value.includes("\n") || value.includes("\r")) {
    throw new Error(`${label} source must contain exactly one line`);
  }
  if (value !== value.trim()) {
    throw new Error(`${label} source must not contain surrounding whitespace`);
  }
  return value;
}
