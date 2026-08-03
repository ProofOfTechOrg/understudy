import { describe, expect, it } from "vitest";
import {
  assertCurrentBranchHead,
  assertSourceSnapshot,
  deploymentContext,
} from "../scripts/deployment-policy.mjs";

const SHA = "a".repeat(40);
const FINGERPRINT = "b".repeat(64);

function ciContext(mode: "production-auto" | "staging-ci") {
  const branch = mode === "production-auto" ? "master" : "dev";
  return {
    mode,
    fullSha: SHA,
    dirty: false,
    fingerprint: FINGERPRINT,
    githubActions: true,
    githubRef: `refs/heads/${branch}`,
    githubSha: SHA,
    productionEnabled: true,
  };
}

describe("deployment policy", () => {
  it("maps only the current clean CI branches to hosted targets", () => {
    expect(deploymentContext(ciContext("staging-ci"))).toMatchObject({
      branch: "dev",
      target: "staging",
      sourceTag: SHA,
    });
    expect(deploymentContext(ciContext("production-auto"))).toMatchObject({
      branch: "master",
      target: "production",
      sourceTag: SHA,
    });
  });

  it("rejects local, cross-branch, dirty, and disabled CI deployment attempts", () => {
    expect(() =>
      deploymentContext({ ...ciContext("staging-ci"), githubActions: false }),
    ).toThrow(/GitHub Actions/);
    expect(() =>
      deploymentContext({ ...ciContext("staging-ci"), githubRef: "refs/heads/master" }),
    ).toThrow(/dev/);
    expect(() =>
      deploymentContext({ ...ciContext("staging-ci"), dirty: true }),
    ).toThrow(/clean workflow commit/);
    expect(() =>
      deploymentContext({
        ...ciContext("production-auto"),
        productionEnabled: false,
      }),
    ).toThrow(/not enabled/);
  });

  it("permits a dirty local tree only for staging and gives it a content tag", () => {
    expect(
      deploymentContext({
        ...ciContext("staging-ci"),
        mode: "staging-local",
        githubActions: false,
        dirty: true,
      }),
    ).toEqual({
      branch: null,
      target: "staging",
      sourceTag: `local-${SHA.slice(0, 12)}-dirty-${FINGERPRINT.slice(0, 12)}`,
    });
  });

  it("rejects stale branch heads and source changes after capture", () => {
    expect(() => assertCurrentBranchHead("dev", SHA, "c".repeat(40))).toThrow(
      /no longer the head/,
    );
    expect(() =>
      assertSourceSnapshot(SHA, SHA, FINGERPRINT, "c".repeat(64)),
    ).toThrow(/source changed/);
    expect(() =>
      assertSourceSnapshot(SHA, "c".repeat(40), FINGERPRINT, FINGERPRINT),
    ).toThrow(/source changed/);
  });
});
