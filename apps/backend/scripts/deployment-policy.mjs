#!/usr/bin/env node

import { pathToFileURL } from "node:url";

const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

export function deploymentContext({
  mode,
  fullSha,
  dirty,
  fingerprint,
  githubActions,
  githubRef,
  githubSha,
  productionEnabled,
}) {
  assertCommit(fullSha, "source commit");
  if (!FINGERPRINT_PATTERN.test(fingerprint)) {
    throw new Error("source fingerprint is invalid");
  }
  if (typeof dirty !== "boolean") throw new Error("dirty state is invalid");

  if (mode === "staging-local") {
    if (githubActions) throw new Error("staging-local is not available in GitHub Actions");
    return {
      branch: null,
      sourceTag: dirty
        ? `local-${fullSha.slice(0, 12)}-dirty-${fingerprint.slice(0, 12)}`
        : fullSha,
      target: "staging",
    };
  }

  const production = mode === "production-auto";
  const branch = production ? "master" : mode === "staging-ci" ? "dev" : null;
  if (branch === null) throw new Error(`unknown deployment mode: ${mode}`);
  if (!githubActions || githubRef !== `refs/heads/${branch}`) {
    throw new Error(`${mode} is restricted to the ${branch} GitHub Actions workflow`);
  }
  if (production && !productionEnabled) {
    throw new Error("production automatic deployment is not enabled");
  }
  if (dirty || githubSha !== fullSha) {
    throw new Error(`${mode} requires the clean workflow commit`);
  }
  return { branch, sourceTag: fullSha, target: production ? "production" : "staging" };
}

export function assertCurrentBranchHead(branch, sourceSha, remoteSha) {
  if (branch !== "dev" && branch !== "master") throw new Error("branch is invalid");
  assertCommit(sourceSha, "source commit");
  assertCommit(remoteSha, "remote branch commit");
  if (sourceSha !== remoteSha) {
    throw new Error(`deployment source is no longer the head of origin/${branch}`);
  }
}

export function assertSourceSnapshot(initialSha, currentSha, initialFingerprint, currentFingerprint) {
  assertCommit(initialSha, "initial source commit");
  assertCommit(currentSha, "current source commit");
  if (
    !FINGERPRINT_PATTERN.test(initialFingerprint) ||
    !FINGERPRINT_PATTERN.test(currentFingerprint)
  ) {
    throw new Error("source fingerprint is invalid");
  }
  if (initialSha !== currentSha || initialFingerprint !== currentFingerprint) {
    throw new Error("source changed after deployment provenance was captured");
  }
}

function assertCommit(value, label) {
  if (!COMMIT_PATTERN.test(value)) throw new Error(`${label} is invalid`);
}

function booleanEnvironment(name) {
  return process.env[name] === "true";
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "context" && args.length === 4) {
    const [mode, fullSha, state, fingerprint] = args;
    if (state !== "clean" && state !== "dirty") throw new Error("state is invalid");
    process.stdout.write(
      `${JSON.stringify(
        deploymentContext({
          mode,
          fullSha,
          dirty: state === "dirty",
          fingerprint,
          githubActions: booleanEnvironment("GITHUB_ACTIONS"),
          githubRef: process.env.GITHUB_REF,
          githubSha: process.env.GITHUB_SHA,
          productionEnabled: booleanEnvironment("PRODUCTION_AUTODEPLOY_ENABLED"),
        }),
      )}\n`,
    );
    return;
  }
  if (command === "current-ref" && args.length === 3) {
    assertCurrentBranchHead(args[0], args[1], args[2]);
    return;
  }
  if (command === "unchanged" && args.length === 4) {
    assertSourceSnapshot(args[0], args[1], args[2], args[3]);
    return;
  }
  throw new Error("usage: deployment-policy.mjs context|current-ref|unchanged ...");
}

if (
  process.env.VITEST !== "true" &&
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "deployment policy failed"}\n`);
    process.exit(2);
  }
}
