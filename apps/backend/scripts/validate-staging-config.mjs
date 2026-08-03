#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { validateStagingConfiguration } from "./staging-config.mjs";

const NAMES = [
  "AUTH_HMAC_SECRET",
  "CALLER_TOKENS",
  "EXTENSION_TOKENS",
  "DEVICE_TOKENS",
  "EXTENSION_ID",
  "WS_TICKET_SECRET",
];

if (process.argv.length !== NAMES.length + 2) {
  process.stderr.write(
    `usage: validate-staging-config.mjs ${NAMES.map((name) => name.toLowerCase()).join(" ")}\n`,
  );
  process.exit(2);
}

try {
  const sources = await Promise.all(process.argv.slice(2).map((path) => readFile(path, "utf8")));
  const values = Object.fromEntries(NAMES.map((name, index) => [name, sources[index]]));
  process.stdout.write(JSON.stringify(validateStagingConfiguration(values)));
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : "staging configuration is invalid"}\n`,
  );
  process.exit(2);
}
