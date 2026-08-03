#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const HEALTH_URL = "https://understudy.proofof.tech/health";
const MARKER_PATH = "apps/backend/production-compatibility.json";
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const REQUIRED_SECRETS = [
  "AUTH_HMAC_SECRET",
  "CALLER_TOKENS",
  "DEVICE_TOKENS",
  "EXTENSION_ID",
  "EXTENSION_TOKENS",
  "WS_TICKET_SECRET",
];
const GUARDED_FILES = [
  "apps/backend/scripts/production-config.mjs",
  "apps/backend/scripts/validate-production-config.mjs",
  "apps/backend/src/static-device-config.mjs",
];

export function validateCompatibilityMarker(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("production compatibility marker must be an object");
  }
  if (value.schemaVersion !== 1 || value.contractVersion !== 3) {
    throw new Error("production compatibility marker version is invalid");
  }
  if (JSON.stringify(value.requiredSecrets) !== JSON.stringify(REQUIRED_SECRETS)) {
    throw new Error("production required-secret contract is invalid");
  }
  if (typeof value.files !== "object" || value.files === null || Array.isArray(value.files)) {
    throw new Error("production compatibility file inventory is invalid");
  }
  const paths = Object.keys(value.files).sort();
  if (JSON.stringify(paths) !== JSON.stringify(GUARDED_FILES)) {
    throw new Error("production compatibility file paths are invalid");
  }
  if (paths.some((path) => !SHA256_PATTERN.test(value.files[path]))) {
    throw new Error("production compatibility file digest is invalid");
  }
  return value;
}

export async function verifyCurrentContract(repoRoot) {
  const marker = validateCompatibilityMarker(
    JSON.parse(await readFile(resolve(repoRoot, MARKER_PATH), "utf8")),
  );
  for (const [path, expected] of Object.entries(marker.files)) {
    const actual = createHash("sha256")
      .update(await readFile(resolve(repoRoot, path)))
      .digest("hex");
    if (actual !== expected) {
      throw new Error(`production compatibility file changed without a cutover: ${path}`);
    }
  }
  return marker;
}

export function validateHealthProvenance(value) {
  if (
    typeof value !== "object" ||
    value === null ||
    value.ok !== true ||
    !COMMIT_PATTERN.test(value.commit ?? "")
  ) {
    throw new Error("production health has no protocol-3 source provenance");
  }
  return value.commit;
}

export async function verifyLiveContract(repoRoot, healthUrl = HEALTH_URL) {
  const current = await verifyCurrentContract(repoRoot);
  const response = await fetch(healthUrl, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`production health returned HTTP ${response.status}`);
  const activeCommit = validateHealthProvenance(await response.json());
  const candidateCommit = git(repoRoot, ["rev-parse", "HEAD"]).trim();
  if (!COMMIT_PATTERN.test(candidateCommit)) throw new Error("candidate commit is invalid");
  const ancestor = spawnSync(
    "git",
    ["-C", repoRoot, "merge-base", "--is-ancestor", activeCommit, candidateCommit],
    { stdio: "ignore" },
  );
  if (ancestor.error !== undefined) throw ancestor.error;
  if (ancestor.status !== 0) {
    throw new Error("active production commit is not an ancestor of the candidate");
  }
  const active = validateCompatibilityMarker(
    JSON.parse(git(repoRoot, ["show", `${activeCommit}:${MARKER_PATH}`])),
  );
  if (JSON.stringify(active) !== JSON.stringify(current)) {
    throw new Error("production compatibility contract requires a manual cutover");
  }
  return { activeCommit, candidateCommit, contractVersion: current.contractVersion };
}

function git(repoRoot, args) {
  const result = spawnSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

async function main() {
  const mode = process.argv[2];
  if (mode !== "current" && mode !== "live") {
    throw new Error("usage: verify-production-compatibility.mjs current|live [health-url]");
  }
  const repoRoot = git(process.cwd(), ["rev-parse", "--show-toplevel"]).trim();
  const result =
    mode === "current"
      ? await verifyCurrentContract(repoRoot)
      : await verifyLiveContract(repoRoot, process.argv[3]);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (
  process.env.VITEST !== "true" &&
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "production compatibility check failed"}\n`,
    );
    process.exit(2);
  });
}
