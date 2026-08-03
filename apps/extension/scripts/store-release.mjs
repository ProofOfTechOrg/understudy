#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
  rename,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const targets = JSON.parse(
  await readFile(new URL("../../../deployment-targets.json", import.meta.url), "utf8"),
);
const EXTENSION_ID = targets.production.extensionId;
const PRODUCTION_ORIGIN = targets.production.origin;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;

export async function contentDigest(root) {
  const absoluteRoot = resolve(root);
  const paths = await regularFiles(absoluteRoot, absoluteRoot);
  paths.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  const inventory = [];
  for (const path of paths) {
    const bytes = await readFile(join(absoluteRoot, path));
    inventory.push(`${sha256(bytes)}  ./${path}\n`);
  }
  return sha256(Buffer.from(inventory.join("")));
}

export function validateRelease(value, allowInReview = false) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("store release must be an object");
  }
  const expectedFields = [
    "contentSha256",
    "extensionId",
    "schemaVersion",
    "sourceCommit",
    "status",
    "version",
    "zipSha256",
  ];
  const fields = Object.keys(value).sort();
  if (JSON.stringify(fields) !== JSON.stringify(expectedFields)) {
    throw new Error("store release fields are invalid");
  }
  if (value.schemaVersion !== 1 || value.extensionId !== EXTENSION_ID) {
    throw new Error("store release identity is invalid");
  }
  if (!/^\d+\.\d+\.\d+$/.test(value.version)) {
    throw new Error("store release version is invalid");
  }
  if (value.status !== "published" && value.status !== "in_review") {
    throw new Error("store release status is invalid");
  }
  if (value.status !== "published" && !allowInReview) {
    throw new Error("store release is not published");
  }
  if (
    (value.sourceCommit !== null && !COMMIT_PATTERN.test(value.sourceCommit)) ||
    (value.status === "published" && value.sourceCommit === null)
  ) {
    throw new Error("store release source commit is invalid");
  }
  if (!SHA256_PATTERN.test(value.zipSha256) || !SHA256_PATTERN.test(value.contentSha256)) {
    throw new Error("store release digest is invalid");
  }
  return value;
}

export function validateStoreManifest(manifest, expectedVersion, allowLegacyPairing = false) {
  if (manifest.name !== "Understudy Beta" || manifest.version !== expectedVersion) {
    throw new Error("store manifest identity does not match the release");
  }
  if (Object.hasOwn(manifest, "key")) {
    throw new Error("store manifest must not contain a pinned extension key");
  }
  if (manifest.homepage_url !== `${PRODUCTION_ORIGIN}/dashboard`) {
    throw new Error("store manifest homepage is not production");
  }
  const externalMatches = manifest.externally_connectable?.matches;
  const legacyPairing = allowLegacyPairing && externalMatches === undefined;
  if (
    JSON.stringify(manifest.host_permissions) !==
      JSON.stringify([`${PRODUCTION_ORIGIN}/*`]) ||
    (!legacyPairing &&
      JSON.stringify(externalMatches) !== JSON.stringify([`${PRODUCTION_ORIGIN}/*`]))
  ) {
    throw new Error("store manifest network origins are not production-only");
  }
}

export async function verifyStoreRelease({
  releasePath,
  directory,
  zipPath,
  candidateCommit,
  allowInReview = false,
  repository = process.cwd(),
}) {
  const release = validateRelease(
    JSON.parse(await readFile(releasePath, "utf8")),
    allowInReview,
  );
  const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
  validateStoreManifest(
    manifest,
    release.version,
    allowInReview && release.version === "0.1.2",
  );
  const directoryDigest = await contentDigest(directory);
  if (directoryDigest !== release.contentSha256) {
    throw new Error("store build content does not match the recorded release");
  }
  const resolvedZip = zipPath ?? defaultZipPath(directory, manifest.version);
  const zipBytes = await readFile(resolvedZip);
  const candidateZipSha256 = sha256(zipBytes);
  const extracted = await extractZip(resolvedZip);
  try {
    if ((await contentDigest(extracted)) !== release.contentSha256) {
      throw new Error("store ZIP contents do not match the recorded release");
    }
  } finally {
    await rm(dirname(extracted), { recursive: true, force: true });
  }
  if (release.status === "published") {
    assertPublishedSourceAncestor(release.sourceCommit, candidateCommit, repository);
  }
  return { release, candidateZipSha256 };
}

export function assertPublishedSourceAncestor(
  sourceCommit,
  candidateCommit,
  repository = process.cwd(),
) {
  if (!COMMIT_PATTERN.test(sourceCommit ?? "") || candidateCommit === undefined) {
    throw new Error("published release verification requires source and candidate commits");
  }
  const result = spawnSync(
    "git",
    ["-C", repository, "merge-base", "--is-ancestor", sourceCommit, candidateCommit],
    { stdio: "ignore" },
  );
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error("published extension source is not an ancestor of the deployment");
  }
}

export async function recordStoreRelease(options) {
  assertRecordingSource(options.sourceCommit, options.repository);
  const manifest = JSON.parse(
    await readFile(join(options.directory, "manifest.json"), "utf8"),
  );
  validateStoreManifest(manifest, manifest.version);
  const zipPath = options.zipPath ?? defaultZipPath(options.directory, manifest.version);
  const extracted = await extractZip(zipPath);
  let extractedDigest;
  try {
    extractedDigest = await contentDigest(extracted);
  } finally {
    await rm(dirname(extracted), { recursive: true, force: true });
  }
  const directoryDigest = await contentDigest(options.directory);
  if (directoryDigest !== extractedDigest) {
    throw new Error("store ZIP contents differ from the store build directory");
  }
  const sourceCommit = options.sourceCommit;
  const release = validateRelease(
    {
      schemaVersion: 1,
      extensionId: EXTENSION_ID,
      version: manifest.version,
      status: options.status,
      sourceCommit,
      zipSha256: sha256(await readFile(zipPath)),
      contentSha256: directoryDigest,
    },
    true,
  );
  const temporary = `${options.releasePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(release, null, 2)}\n`, { flag: "wx" });
    await rename(temporary, options.releasePath);
  } finally {
    await rm(temporary, { force: true });
  }
  return release;
}

export function assertRecordingSource(sourceCommit, repository = process.cwd()) {
  if (!COMMIT_PATTERN.test(sourceCommit ?? "")) {
    throw new Error("recording a store release requires a full source commit");
  }
  const head = run("git", ["-C", repository, "rev-parse", "HEAD"]).trim();
  if (head !== sourceCommit) {
    throw new Error("store release source commit is not the current HEAD");
  }
  const status = run("git", [
    "-C",
    repository,
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  if (status !== "") throw new Error("store release recording requires a clean tree");
}

async function regularFiles(root, directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = join(directory, entry.name);
    const metadata = await lstat(absolute);
    if (metadata.isSymbolicLink()) throw new Error("store output must not contain symlinks");
    if (entry.isDirectory()) {
      files.push(...(await regularFiles(root, absolute)));
    } else if (entry.isFile()) {
      const path = relative(root, absolute).split(sep).join("/");
      if (path.includes("\n") || path.includes("\r")) {
        throw new Error("store output path contains a line break");
      }
      files.push(path);
    } else {
      throw new Error("store output contains a non-regular file");
    }
  }
  return files;
}

async function extractZip(zipPath) {
  const listing = run("unzip", ["-Z1", zipPath]).trimEnd().split(/\r?\n/);
  validateZipEntries(listing);
  const parent = await mkdtemp(join(tmpdir(), "understudy-store-"));
  const destination = join(parent, "contents");
  run("unzip", ["-q", zipPath, "-d", destination]);
  return destination;
}

export function validateZipEntries(listing) {
  const seen = new Set();
  for (const entry of listing) {
    if (
      entry.length === 0 ||
      entry.startsWith("/") ||
      entry.includes("\\") ||
      entry.split("/").includes("..") ||
      seen.has(entry)
    ) {
      throw new Error("store ZIP contains an unsafe or duplicate path");
    }
    seen.add(entry);
  }
}

function defaultZipPath(directory, version) {
  return join(dirname(resolve(directory)), `understudyextension-${version}-chrome-store.zip`);
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseOptions(argv) {
  const [command, ...rest] = argv;
  if (command !== "verify" && command !== "record") throw new Error("expected verify or record");
  const values = { command };
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (flag === "--allow-in-review") {
      values.allowInReview = true;
      continue;
    }
    const value = rest[index + 1];
    if (!flag?.startsWith("--") || value === undefined) throw new Error("invalid arguments");
    values[flag.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
    index += 1;
  }
  if (values.release === undefined || values.directory === undefined) {
    throw new Error("--release and --directory are required");
  }
  return values;
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const common = {
    releasePath: resolve(options.release),
    directory: resolve(options.directory),
    zipPath: options.zip === undefined ? undefined : resolve(options.zip),
  };
  const release =
    options.command === "verify"
      ? await verifyStoreRelease({
          ...common,
          candidateCommit: options.candidateCommit,
          allowInReview: options.allowInReview === true,
          repository: process.cwd(),
        })
      : await recordStoreRelease({
          ...common,
          status: options.status,
          sourceCommit: options.sourceCommit,
          repository: process.cwd(),
        });
  process.stdout.write(`${JSON.stringify(release)}\n`);
}

if (
  process.env.VITEST !== "true" &&
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "store release failed"}\n`);
    process.exit(2);
  });
}
