#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const PRODUCTION_SECRET_NAMES = new Set(["DEVICE_TOKENS"]);
const STAGING_SECRET_NAMES = new Set([
  "AUTH_HMAC_SECRET",
  "CALLER_TOKENS",
  "EXTENSION_TOKENS",
  "DEVICE_TOKENS",
  "EXTENSION_ID",
  "WS_TICKET_SECRET",
]);

export function verifiedSecretBytes(source, expectedSha256) {
  if (!(source instanceof Uint8Array) || !SHA256_PATTERN.test(expectedSha256)) {
    throw new Error("validated secret input is invalid");
  }
  const normalized = Buffer.from(Buffer.from(source).toString("utf8").trimEnd());
  const actual = createHash("sha256").update(normalized).digest();
  const expected = Buffer.from(expectedSha256, "hex");
  if (!timingSafeEqual(actual, expected)) {
    throw new Error("secret source changed after validation");
  }
  return normalized;
}

async function main() {
  const [, , secretName, expectedSha256, environment] = process.argv;
  const allowedNames =
    environment === undefined
      ? PRODUCTION_SECRET_NAMES
      : environment === "staging"
        ? STAGING_SECRET_NAMES
        : new Set();
  if (
    (process.argv.length !== 4 && process.argv.length !== 5) ||
    secretName === undefined ||
    !allowedNames.has(secretName) ||
    expectedSha256 === undefined
  ) {
    throw new Error(
      "usage: put-validated-secret.mjs secret-name expected-sha256 [staging]",
    );
  }
  const source = verifiedSecretBytes(await readStdin(), expectedSha256);
  const args = ["exec", "wrangler", "secret", "put", secretName];
  args.push("--env", environment === "staging" ? "staging" : "");
  const result = spawnSync(
    "pnpm",
    args,
    {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      input: source,
      stdio: ["pipe", "inherit", "inherit"],
    },
  );
  if (result.error !== undefined) throw result.error;
  if (result.signal !== null) {
    throw new Error(`wrangler secret upload terminated by ${result.signal}`);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "secret upload failed"}\n`,
    );
    process.exit(2);
  });
}
