import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";

const SHA = "a".repeat(40);
const SCRIPT = fileURLToPath(new URL("deploy-target.sh", import.meta.url));
const MANUAL_SCRIPT = fileURLToPath(new URL("deploy-production.sh", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const temporary = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("deployment target integration", () => {
  it("writes verified evidence tied to the active source version", async () => {
    const fixture = await deploymentFixture({ FAKE_SYSTEM_DNS: "missing" });
    const result = runDeployment(fixture);

    assert.equal(result.status, 0, commandFailure(result));
    const evidence = JSON.parse(await readFile(fixture.evidence, "utf8"));
    assert.equal(evidence.outcome, "verified");
    assert.equal(evidence.activeWorkerVersion.id, "v1");
    assert.equal(evidence.sourceReleaseVersion.id, "v1");
    assert.equal(evidence.priorDeployment.versions[0].version_id, "v0");
    const log = await readFile(fixture.log, "utf8");
    assert.match(log, /@understudy\/protocol build auth=absent/);
    assert.match(log, /wrangler deploy --dry-run.*auth=absent/);
    assert.match(log, /wrangler deployments status --json.*auth=present/);
    assert.match(log, /wrangler deploy --strict.*auth=present/);
  });

  it("records rollback evidence when the active version has wrong provenance", async () => {
    const fixture = await deploymentFixture({ FAKE_VERSION_TAG: "wrong" });
    const result = runDeployment(fixture);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /expected source provenance/);
    assert.match(await readFile(fixture.log, "utf8"), /deploy --strict/);
    const evidence = JSON.parse(await readFile(fixture.evidence, "utf8"));
    assertFailedEvidence(evidence, result, "verification");
    assert.equal(evidence.priorDeployment.versions[0].version_id, "v0");
  });

  it("records failed evidence when health provenance never converges", async () => {
    const fixture = await deploymentFixture({ FAKE_HEALTH: "wrong" });
    const result = runDeployment(fixture);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /health provenance did not converge/);
    const evidence = JSON.parse(await readFile(fixture.evidence, "utf8"));
    assertFailedEvidence(evidence, result, "verification");
    assert.equal(evidence.health, null);
  });

  it("records failed evidence when deployment credentials are missing", async () => {
    const fixture = await deploymentFixture({ FAKE_REQUIRE_AUTH: "true" });
    delete fixture.env.CLOUDFLARE_API_TOKEN;
    const result = runDeployment(fixture);

    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /Cloudflare API token required/,
      commandFailure(result),
    );
    const evidence = JSON.parse(await readFile(fixture.evidence, "utf8"));
    assertFailedEvidence(evidence, result, "prior-deployment");
    assert.equal(evidence.priorDeployment, null);
  });

  it("rejects malformed prior-deployment JSON before upload", async () => {
    const fixture = await deploymentFixture({
      FAKE_PRIOR_DEPLOYMENT_JSON: "{not-json",
    });
    const result = runDeployment(fixture);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /prior deployment did not return a JSON object/);
    const evidence = JSON.parse(await readFile(fixture.evidence, "utf8"));
    assertFailedEvidence(evidence, result, "prior-deployment");
    assert.equal(evidence.priorDeployment, null);
    assert.doesNotMatch(await readFile(fixture.log, "utf8"), /deploy --strict/);
  });

  it("records build failures before any control-plane access", async () => {
    const fixture = await deploymentFixture({ FAKE_BUILD_FAILURE: "true" });
    const result = runDeployment(fixture);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /protocol build failed/);
    const evidence = JSON.parse(await readFile(fixture.evidence, "utf8"));
    assertFailedEvidence(evidence, result, "build");
    assert.equal(evidence.priorDeployment, null);
    assert.doesNotMatch(await readFile(fixture.log, "utf8"), /deployments status/);
  });
});

describe("manual production cutover integration", () => {
  it("attributes each new secret version from newest-first inventories", async () => {
    const fixture = await manualDeploymentFixture();
    const result = runManualDeployment(fixture);

    assert.equal(result.status, 0, commandFailure(result));
    const evidence = JSON.parse(await readFile(fixture.evidence, "utf8"));
    assert.equal(evidence.outcome, "verified");
    assert.equal(evidence.deviceTokensSecretVersion.id, "device-secret-new");
    assert.equal(evidence.extensionIdSecretVersion.id, "extension-secret-new");
    assert.notEqual(
      evidence.deviceTokensSecretVersion.id,
      evidence.extensionIdSecretVersion.id,
    );
    assert.deepEqual(
      evidence.priorVersions.map((version) => version.id),
      ["old-secret", "old-code"],
    );
    const log = await readFile(fixture.log, "utf8");
    assert.match(log, /install --frozen-lockfile --offline auth=absent/);
    assert.match(log, /secret put DEVICE_TOKENS.*auth=present/);
    assert.match(log, /secret put EXTENSION_ID.*auth=present/);
  });

  it("records missing production credentials before secret mutation", async () => {
    const fixture = await manualDeploymentFixture({ FAKE_REQUIRE_AUTH: "true" });
    delete fixture.env.CLOUDFLARE_API_TOKEN;
    const result = runManualDeployment(fixture);

    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /Cloudflare API token required/,
      commandFailure(result),
    );
    const evidence = JSON.parse(await readFile(fixture.evidence, "utf8"));
    assertFailedEvidence(evidence, result, "prior-deployment");
    assert.equal(evidence.priorDeployment, null);
    assert.equal(evidence.secretMutationPossible, false);
    assert.doesNotMatch(await readFile(fixture.log, "utf8"), /secret put/);
  });

  it("attributes a post-secret source-ref failure", async () => {
    const fixture = await manualDeploymentFixture({
      FAKE_LATE_SOURCE_FAILURE: "true",
    });
    const result = runManualDeployment(fixture);

    assert.notEqual(result.status, 0);
    const evidence = JSON.parse(await readFile(fixture.evidence, "utf8"));
    assertFailedEvidence(evidence, result, "source-ref");
    assert.equal(evidence.secretMutationPossible, true);
    const log = await readFile(fixture.log, "utf8");
    assert.match(log, /secret put DEVICE_TOKENS/);
    assert.match(log, /secret put EXTENSION_ID/);
    assert.doesNotMatch(log, /deploy --strict/);
  });
});

async function deploymentFixture(overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), "understudy-deploy-test-"));
  temporary.push(root);
  const bin = join(root, "bin");
  const state = join(root, "state");
  const evidence = join(root, "evidence.json");
  const log = join(root, "commands.log");
  await Promise.all([mkdir(bin), mkdir(state)]);
  await executable(
    join(bin, "git"),
    `#!/usr/bin/env bash
set -eu
case "$*" in
  *"rev-parse --show-toplevel"*) printf '%s\\n' "$FAKE_REPO_ROOT" ;;
  *"rev-parse refs/remotes/origin/dev"*) printf '%s\\n' "$FAKE_SHA" ;;
  *"rev-parse HEAD"*) printf '%s\\n' "$FAKE_SHA" ;;
  *"status --porcelain"*|*"diff --binary HEAD"*|*"ls-files --others"*) ;;
  *"fetch --quiet origin"*) ;;
  *) printf 'unexpected git command: %s\\n' "$*" >&2; exit 9 ;;
esac
`,
  );
  await executable(
    join(bin, "pnpm"),
    `#!/usr/bin/env bash
set -eu
auth=absent
if [[ -n "\${CLOUDFLARE_API_TOKEN:-}" ]]; then auth=present; fi
printf '%s auth=%s\\n' "$*" "$auth" >>"$FAKE_LOG"
case "$*" in
  "--filter @understudy/protocol build")
    if [[ "\${FAKE_BUILD_FAILURE:-}" == "true" ]]; then
      printf 'protocol build failed\n' >&2
      exit 1
    fi
    ;;
  "--version") printf '11.5.2\\n' ;;
  *"wrangler deploy --dry-run"*) ;;
  *"wrangler deploy --strict"*) ;;
  *"wrangler versions list --json"*)
    printf '[{"id":"v1","annotations":{"workers/tag":"%s","workers/message":"source %s"}}]\\n' "\${FAKE_VERSION_TAG:-$FAKE_SHA}" "$FAKE_SHA"
    ;;
  *"wrangler deployments status --json"*)
    if [[ "\${FAKE_REQUIRE_AUTH:-}" == "true" && "$auth" == "absent" ]]; then
      printf 'Cloudflare API token required\n' >&2
      exit 1
    fi
    if [[ -n "\${FAKE_PRIOR_DEPLOYMENT_JSON:-}" ]]; then
      printf '%s\n' "$FAKE_PRIOR_DEPLOYMENT_JSON"
      exit 0
    fi
    count_file="$FAKE_STATE/status-count"
    count=0
    if [[ -f "$count_file" ]]; then count="$(<"$count_file")"; fi
    count=$((count + 1))
    printf '%s' "$count" >"$count_file"
    if (( count == 1 )); then version=v0; else version=v1; fi
    printf '{"versions":[{"version_id":"%s","percentage":100}]}\\n' "$version"
    ;;
  *) printf 'unexpected pnpm command: %s\\n' "$*" >&2; exit 9 ;;
esac
`,
  );
  await executable(
    join(bin, "curl"),
    `#!/usr/bin/env bash
set -eu
commit="$FAKE_SHA"
if [[ "\${FAKE_SYSTEM_DNS:-}" == "missing" && "$*" != *"--doh-url"* ]]; then
  exit 6
fi
if [[ "\${FAKE_HEALTH:-}" == "wrong" ]]; then commit="cccccccccccccccccccccccccccccccccccccccc"; fi
printf '{"ok":true,"commit":"%s","versionId":"v1","deployedAt":"2030-01-01T00:00:00Z"}\\n' "$commit"
`,
  );
  await executable(join(bin, "sleep"), "#!/usr/bin/env bash\nexit 0\n");
  return {
    root,
    evidence,
    log,
    env: {
      ...process.env,
      ...overrides,
      PATH: `${bin}:${process.env.PATH}`,
      FAKE_LOG: log,
      FAKE_REPO_ROOT: REPO_ROOT,
      FAKE_SHA: SHA,
      FAKE_STATE: state,
      CLOUDFLARE_API_TOKEN: "test-deployment-token",
      GITHUB_ACTIONS: "true",
      GITHUB_REF: "refs/heads/dev",
      GITHUB_SHA: SHA,
    },
  };
}

async function manualDeploymentFixture(overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), "understudy-manual-deploy-test-"));
  temporary.push(root);
  const bin = join(root, "bin");
  const state = join(root, "state");
  const evidence = join(root, "evidence.json");
  const log = join(root, "commands.log");
  const deviceTokens = join(root, "device-tokens.json");
  const extensionId = join(root, "extension-id.txt");
  const canaryCredential = join(root, "canary.txt");
  await Promise.all([mkdir(bin), mkdir(state)]);

  const credential = `udt_v2_${"b".repeat(43)}`;
  const digest = createHash("sha256").update(credential).digest("hex");
  await Promise.all([
    writeFile(
      deviceTokens,
      JSON.stringify({
        [digest]: {
          tenantId: "metamind",
          deviceId: "00000000-0000-4000-8000-000000000001",
          credentialVersion: 1,
          allowedOrigins: [],
          policyVersion: 1,
        },
      }),
      { mode: 0o600 },
    ),
    writeFile(extensionId, "lbmbdjjaodgipnleaggclnobbijpadee", { mode: 0o600 }),
    writeFile(canaryCredential, credential, { mode: 0o600 }),
  ]);

  await executable(
    join(bin, "git"),
    `#!/usr/bin/env bash
set -eu
case "$*" in
  *"rev-parse --show-toplevel"*) printf '%s\\n' "$FAKE_REPO_ROOT" ;;
  *"rev-parse refs/remotes/origin/master"*)
    count_file="$FAKE_STATE/master-ref-count"
    count=0
    if [[ -f "$count_file" ]]; then count="$(<"$count_file")"; fi
    count=$((count + 1))
    printf '%s' "$count" >"$count_file"
    if [[ "\${FAKE_LATE_SOURCE_FAILURE:-}" == "true" && "$count" -ge 3 ]]; then
      printf '%s\\n' "c\${FAKE_SHA:1}"
    else
      printf '%s\\n' "$FAKE_SHA"
    fi
    ;;
  *"rev-parse HEAD"*) printf '%s\\n' "$FAKE_SHA" ;;
  *"status --porcelain"*) ;;
  *"fetch --quiet origin"*) ;;
  *"worktree add --detach"*)
    snapshot="$6"
    mkdir -p "$snapshot"
    ln -s "$FAKE_REPO_ROOT/apps" "$snapshot/apps"
    ln -s "$FAKE_REPO_ROOT/package.json" "$snapshot/package.json"
    ln -s "$FAKE_REPO_ROOT/pnpm-lock.yaml" "$snapshot/pnpm-lock.yaml"
    ;;
  *"worktree remove --force"*) ;;
  *) printf 'unexpected git command: %s\\n' "$*" >&2; exit 9 ;;
esac
`,
  );
  await executable(
    join(bin, "node"),
    `#!/usr/bin/env bash
exec "$REAL_NODE" --preserve-symlinks-main "$@"
`,
  );
  await executable(
    join(bin, "pnpm"),
    `#!/usr/bin/env bash
set -eu
auth=absent
if [[ -n "\${CLOUDFLARE_API_TOKEN:-}" ]]; then auth=present; fi
printf '%s auth=%s\\n' "$*" "$auth" >>"$FAKE_LOG"
case "$*" in
  "--version") printf '11.5.2\\n' ;;
  "install --frozen-lockfile --offline"|"--filter @understudy/protocol build"|"--filter @understudy/extension build:store"|"--filter @understudy/extension zip:store") ;;
  "--silent --filter @understudy/extension verify:store-release") printf '{}\\n' ;;
  *"wrangler deploy --dry-run"*|*"wrangler deploy --strict"*) ;;
  *"wrangler secret put"*) IFS= read -r _ || true ;;
  *"wrangler deployments status --json"*)
    if [[ "\${FAKE_REQUIRE_AUTH:-}" == "true" && "$auth" == "absent" ]]; then
      printf 'Cloudflare API token required\n' >&2
      exit 1
    fi
    count_file="$FAKE_STATE/deployment-count"
    count=0
    if [[ -f "$count_file" ]]; then count="$(<"$count_file")"; fi
    count=$((count + 1))
    printf '%s' "$count" >"$count_file"
    if (( count == 1 )); then version=v0; else version=v1; fi
    printf '{"versions":[{"version_id":"%s","percentage":100}]}\\n' "$version"
    ;;
  *"wrangler versions list --json"*)
    count_file="$FAKE_STATE/version-count"
    count=0
    if [[ -f "$count_file" ]]; then count="$(<"$count_file")"; fi
    count=$((count + 1))
    printf '%s' "$count" >"$count_file"
    case "$count" in
      1) printf '[{"id":"old-secret","annotations":{"workers/triggered_by":"secret"}},{"id":"old-code","annotations":{"workers/triggered_by":"upload"}}]\\n' ;;
      2) printf '[{"id":"device-secret-new","annotations":{"workers/triggered_by":"secret"}},{"id":"old-secret","annotations":{"workers/triggered_by":"secret"}},{"id":"old-code","annotations":{"workers/triggered_by":"upload"}}]\\n' ;;
      3) printf '[{"id":"extension-secret-new","annotations":{"workers/triggered_by":"secret"}},{"id":"device-secret-new","annotations":{"workers/triggered_by":"secret"}},{"id":"old-secret","annotations":{"workers/triggered_by":"secret"}},{"id":"old-code","annotations":{"workers/triggered_by":"upload"}}]\\n' ;;
      *) printf '[{"id":"v1","annotations":{"workers/tag":"%s","workers/message":"source %s"}},{"id":"extension-secret-new","annotations":{"workers/triggered_by":"secret"}},{"id":"device-secret-new","annotations":{"workers/triggered_by":"secret"}}]\\n' "$FAKE_SHA" "$FAKE_SHA" ;;
    esac
    ;;
  *) printf 'unexpected pnpm command: %s\\n' "$*" >&2; exit 9 ;;
esac
`,
  );
  await executable(
    join(bin, "curl"),
    `#!/usr/bin/env bash
printf '{"ok":true,"commit":"%s","versionId":"v1","deployedAt":"2030-01-01T00:00:00Z"}\\n' "$FAKE_SHA"
`,
  );
  await executable(join(bin, "sleep"), "#!/usr/bin/env bash\nexit 0\n");

  return {
    evidence,
    deviceTokens,
    extensionId,
    canaryCredential,
    log,
    env: {
      ...process.env,
      ...overrides,
      PATH: `${bin}:${process.env.PATH}`,
      FAKE_LOG: log,
      FAKE_REPO_ROOT: REPO_ROOT,
      FAKE_SHA: SHA,
      FAKE_STATE: state,
      REAL_NODE: process.execPath,
      CLOUDFLARE_API_TOKEN: "test-production-token",
    },
  };
}

function runDeployment(fixture) {
  return spawnSync("bash", [SCRIPT, "staging-ci", fixture.evidence], {
    cwd: REPO_ROOT,
    env: fixture.env,
    encoding: "utf8",
  });
}

function runManualDeployment(fixture) {
  return spawnSync(
    "bash",
    [
      MANUAL_SCRIPT,
      fixture.evidence,
      fixture.deviceTokens,
      fixture.extensionId,
      fixture.canaryCredential,
    ],
    {
      cwd: REPO_ROOT,
      env: fixture.env,
      input: "DEPLOY\n",
      encoding: "utf8",
    },
  );
}

function commandFailure(result) {
  return JSON.stringify({
    status: result.status,
    signal: result.signal,
    error: result.error?.message,
    stdout: result.stdout,
    stderr: result.stderr,
  });
}

function assertFailedEvidence(evidence, result, failureStage) {
  assert.notEqual(result.status, 0);
  assert.equal(evidence.outcome, "failed");
  assert.equal(evidence.failureStage, failureStage);
  assert.equal(evidence.exitCode, result.status);
}

async function executable(path, contents) {
  await writeFile(path, contents);
  await chmod(path, 0o755);
}
