#!/usr/bin/env node

import { pathToFileURL } from "node:url";

export function newSecretVersion(before, after) {
  assertVersionInventory(before, "before");
  assertVersionInventory(after, "after");
  const priorIds = new Set(before.map((version) => version.id));
  const candidates = after.filter(
    (version) =>
      !priorIds.has(version.id) &&
      version.annotations?.["workers/triggered_by"] === "secret",
  );
  if (candidates.length !== 1) {
    throw new Error("secret upload did not create exactly one attributable Worker version");
  }
  return candidates[0];
}

function assertVersionInventory(value, label) {
  if (
    !Array.isArray(value) ||
    value.some(
      (version) =>
        typeof version !== "object" ||
        version === null ||
        typeof version.id !== "string" ||
        version.id.length === 0,
    ) ||
    new Set(value.map((version) => version.id)).size !== value.length
  ) {
    throw new Error(`${label} Worker version inventory is invalid`);
  }
}

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  process.stdout.write(`${JSON.stringify(newSecretVersion(input.before, input.after))}\n`);
}

if (
  process.env.VITEST !== "true" &&
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "secret version check failed"}\n`);
    process.exit(2);
  });
}
