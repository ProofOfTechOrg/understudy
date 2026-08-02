#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ALLOWED_SECRET_NAMES = new Set(["DEVICE_TOKENS"]);

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
  const [, , secretName, expectedSha256] = process.argv;
  if (
    process.argv.length !== 4 ||
    secretName === undefined ||
    !ALLOWED_SECRET_NAMES.has(secretName) ||
    expectedSha256 === undefined
  ) {
    throw new Error("usage: put-validated-secret.mjs DEVICE_TOKENS expected-sha256");
  }
  const source = verifiedSecretBytes(await readFile(0), expectedSha256);
  const result = spawnSync(
    "pnpm",
    ["exec", "wrangler", "secret", "put", secretName],
    { input: source, stdio: ["pipe", "inherit", "inherit"] },
  );
  if (result.error !== undefined) throw result.error;
  if (result.signal !== null) {
    throw new Error(`wrangler secret upload terminated by ${result.signal}`);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
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
