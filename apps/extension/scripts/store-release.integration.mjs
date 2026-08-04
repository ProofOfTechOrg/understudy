import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  assertPublishedSourceAncestor,
  recordStoreRelease,
  verifyStoreRelease,
} from "./store-release.mjs";

const temporary = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("store release ZIP integration", () => {
  it("verifies normalized contents across ZIP metadata changes and source ancestry", async () => {
    const fixture = await storeFixture();
    const releasePath = join(fixture.root, "release.json");
    const head = run("git", ["-C", fixture.repository, "rev-parse", "HEAD"]).trim();
    const recorded = await recordStoreRelease({
      directory: fixture.directory,
      zipPath: fixture.zip,
      releasePath,
      status: "published",
      sourceCommit: head,
      repository: fixture.repository,
    });
    const changedTimestamp = new Date("2030-01-01T00:00:00Z");
    await utimes(join(fixture.directory, "payload.js"), changedTimestamp, changedTimestamp);
    zipDirectory(fixture.directory, fixture.zip);

    const verified = await verifyStoreRelease({
      releasePath,
      directory: fixture.directory,
      zipPath: fixture.zip,
      candidateCommit: head,
      repository: fixture.repository,
    });

    assert.equal(verified.release.contentSha256, recorded.contentSha256);
    assert.notEqual(verified.candidateZipSha256, recorded.zipSha256);
    assert.doesNotThrow(() =>
      assertPublishedSourceAncestor(head, head, fixture.repository),
    );
  });

  it("rejects directory and ZIP content mismatches", async () => {
    const fixture = await storeFixture();
    const releasePath = join(fixture.root, "release.json");
    const head = run("git", ["-C", fixture.repository, "rev-parse", "HEAD"]).trim();
    await recordStoreRelease({
      directory: fixture.directory,
      zipPath: fixture.zip,
      releasePath,
      status: "in_review",
      sourceCommit: head,
      repository: fixture.repository,
    });
    await writeFile(join(fixture.directory, "payload.js"), "changed");

    await assert.rejects(
      verifyStoreRelease({
        releasePath,
        directory: fixture.directory,
        zipPath: fixture.zip,
        candidateCommit: "a".repeat(40),
        allowInReview: true,
        repository: fixture.repository,
      }),
      /recorded release/,
    );
  });

  it("rejects stale or dirty source provenance when recording", async () => {
    const fixture = await storeFixture();
    const head = run("git", ["-C", fixture.repository, "rev-parse", "HEAD"]).trim();
    const options = {
      directory: fixture.directory,
      zipPath: fixture.zip,
      releasePath: join(fixture.root, "release.json"),
      status: "in_review",
      sourceCommit: "b".repeat(40),
      repository: fixture.repository,
    };

    await assert.rejects(recordStoreRelease(options), /not the current HEAD/);
    await writeFile(join(fixture.repository, ".gitignore"), "# dirty\n");
    await assert.rejects(
      recordStoreRelease({ ...options, sourceCommit: head }),
      /clean tree/,
    );
  });
});

async function storeFixture() {
  const root = await mkdtemp(join(tmpdir(), "understudy-store-integration-"));
  temporary.push(root);
  const directory = join(root, "build");
  const zip = join(root, "store.zip");
  const repository = join(root, "repository");
  await mkdir(repository);
  await writeFile(join(repository, ".gitignore"), "*\n!.gitignore\n");
  run("git", ["-C", repository, "init", "--quiet"]);
  run("git", ["-C", repository, "add", ".gitignore"]);
  run("git", [
    "-C",
    repository,
    "-c",
    "user.name=Understudy Test",
    "-c",
    "user.email=test@understudy.invalid",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  ]);
  await mkdir(directory);
  await writeFile(join(directory, "manifest.json"), JSON.stringify(storeManifest()));
  await writeFile(join(directory, "payload.js"), "payload");
  zipDirectory(directory, zip);
  return { root, directory, zip, repository };
}

function zipDirectory(directory, destination) {
  run("zip", ["-q", "-X", "-r", destination, "."], directory);
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout;
}

function storeManifest() {
  return {
    name: "Understudy Beta",
    version: "0.2.0",
    homepage_url: "https://understudy.proofof.tech/dashboard",
    host_permissions: ["https://understudy.proofof.tech/*"],
    externally_connectable: {
      matches: ["https://understudy.proofof.tech/*"],
    },
  };
}
