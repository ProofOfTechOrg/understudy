#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

const targets = JSON.parse(
  await readFile(new URL("../../../deployment-targets.json", import.meta.url), "utf8"),
);
const STAGING_ORIGIN = targets.staging.origin;
const STAGING_EXTENSION_ID = targets.staging.extensionId;

if (process.argv.length !== 4 || process.argv[2] !== "staging") {
  process.stderr.write("usage: verify-build-target.mjs staging build-directory\n");
  process.exit(2);
}

try {
  const directory = resolve(process.argv[3]);
  const manifest = JSON.parse(await readFile(`${directory}/manifest.json`, "utf8"));
  if (
    manifest.name !== "Understudy Staging" ||
    manifest.homepage_url !== `${STAGING_ORIGIN}/dashboard` ||
    JSON.stringify(manifest.host_permissions) !== JSON.stringify(["<all_urls>"]) ||
    JSON.stringify(manifest.externally_connectable?.matches) !==
      JSON.stringify([`${STAGING_ORIGIN}/*`]) ||
    typeof manifest.key !== "string" ||
    manifest.key !== targets.staging.extensionPublicKey ||
    extensionId(manifest.key) !== STAGING_EXTENSION_ID
  ) {
    throw new Error("staging manifest identity, authority, or pinned key is invalid");
  }
  const bundledSource = await readBundleSource(directory);
  if (
    !bundledSource.includes(STAGING_ORIGIN) ||
    bundledSource.includes(targets.production.origin)
  ) {
    throw new Error("staging bundle is not pinned exclusively to the staging origin");
  }
  process.stdout.write(`${JSON.stringify({ extensionId: STAGING_EXTENSION_ID })}\n`);
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : "staging build verification failed"}\n`,
  );
  process.exit(2);
}

async function readBundleSource(directory) {
  const entries = await readdir(`${directory}/chunks`);
  const sources = await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".js"))
      .map((entry) => readFile(`${directory}/chunks/${entry}`, "utf8")),
  );
  sources.push(await readFile(`${directory}/background.js`, "utf8"));
  return sources.join("\n");
}

function extensionId(publicKey) {
  const digest = createHash("sha256")
    .update(Buffer.from(publicKey, "base64"))
    .digest()
    .subarray(0, 16);
  const alphabet = "abcdefghijklmnop";
  return Array.from(digest, (byte) => alphabet[byte >> 4] + alphabet[byte & 15]).join("");
}
