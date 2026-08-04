import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  contentDigest,
  validateRelease,
  validateStoreManifest,
  validateZipEntries,
} from "./store-release.mjs";

const temporary = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("store release gate", () => {
  it("uses the canonical sha256sum inventory format", async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, "nested"));
    await writeFile(join(root, "a.txt"), "alpha");
    await writeFile(join(root, "nested", "b.txt"), "beta");
    expect(await contentDigest(root)).toBe(
      "8db717a4b1da7a7c1e8a2e1ac67a4099f96053b1eb0f400d59725b1eb3f7391f",
    );
  });

  it("requires a published release and full source provenance for production", () => {
    const release = releaseMarker({ status: "in_review", sourceCommit: null });
    expect(() => validateRelease(release)).toThrow(/not published/);
    expect(validateRelease(release, true)).toEqual(release);
    expect(() =>
      validateRelease(releaseMarker({ status: "published", sourceCommit: null })),
    ).toThrow(/source commit/);
  });

  it("rejects staging authority in a store manifest", () => {
    const manifest = storeManifest();
    manifest.homepage_url = "https://staging.understudy.proofof.tech/dashboard";
    expect(() => validateStoreManifest(manifest, "0.2.0")).toThrow(/homepage/);
    manifest.homepage_url = "https://understudy.proofof.tech/dashboard";
    manifest.key = "staging-key";
    expect(() => validateStoreManifest(manifest, "0.2.0")).toThrow(/pinned/);
  });

  it("rejects unsafe, duplicate, and symlinked store entries", async () => {
    expect(() => validateZipEntries(["../manifest.json"])).toThrow(/unsafe/);
    expect(() => validateZipEntries(["manifest.json", "manifest.json"])).toThrow(
      /duplicate/,
    );
    const root = await temporaryDirectory();
    await writeFile(join(root, "outside"), "secret");
    await symlink(join(root, "outside"), join(root, "linked"));
    await expect(contentDigest(root)).rejects.toThrow(/symlinks/);
  });
});

async function temporaryDirectory() {
  const root = await mkdtemp(join(tmpdir(), "understudy-store-test-"));
  temporary.push(root);
  return root;
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

function releaseMarker(overrides = {}) {
  return {
    schemaVersion: 1,
    extensionId: "lbmbdjjaodgipnleaggclnobbijpadee",
    version: "0.2.0",
    status: "published",
    sourceCommit: "a".repeat(40),
    zipSha256: "a".repeat(64),
    contentSha256: "b".repeat(64),
    ...overrides,
  };
}
