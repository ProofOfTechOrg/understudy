#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "usage: $0 production-auto|staging-ci|staging-local [/absolute/path/evidence.json]" >&2
  exit 2
fi

readonly MODE="$1"
UNDERSTUDY_CLOUDFLARE_API_TOKEN="${CLOUDFLARE_API_TOKEN:-}"
unset CLOUDFLARE_API_TOKEN
for command in curl cut git jq mktemp node pnpm sha256sum; do
  command -v "$command" >/dev/null || {
    echo "required command not found: $command" >&2
    exit 2
  }
done

repo_root="$(git rev-parse --show-toplevel)"
backend_dir="$repo_root/apps/backend"
source "$backend_dir/scripts/deploy-lib.sh"
full_sha="$(git -C "$repo_root" rev-parse HEAD)"
[[ "$full_sha" =~ ^[0-9a-f]{40}$ ]] || {
  echo "could not resolve a full source commit" >&2
  exit 1
}

worktree_fingerprint() {
  {
    git -C "$repo_root" status --porcelain=v1 -z --untracked-files=all
    git -C "$repo_root" diff --binary HEAD
    while IFS= read -r -d '' path; do
      printf '%s\0' "$path"
      sha256sum "$repo_root/$path"
    done < <(git -C "$repo_root" ls-files --others --exclude-standard -z | LC_ALL=C sort -z)
  } | sha256sum | cut -d ' ' -f 1
}

initial_status="$(git -C "$repo_root" status --porcelain=v1 --untracked-files=all)"
initial_fingerprint="$(worktree_fingerprint)"
source_state="clean"
if [[ -n "$initial_status" ]]; then source_state="dirty"; fi
deployment_context="$(
  node "$backend_dir/scripts/deployment-policy.mjs" context \
    "$MODE" "$full_sha" "$source_state" "$initial_fingerprint"
)"
target="$(jq -r '.target' <<<"$deployment_context")"
source_tag="$(jq -r '.sourceTag' <<<"$deployment_context")"
branch="$(jq -r '.branch // empty' <<<"$deployment_context")"

if [[ $# -eq 2 ]]; then
  evidence_path="$2"
else
  if [[ "$MODE" != "staging-local" ]]; then
    echo "CI deployment modes require an absolute evidence path" >&2
    exit 2
  fi
  evidence_path="/tmp/understudy-staging-${full_sha:0:12}-$$.json"
fi
if [[ "$evidence_path" != /* || -e "$evidence_path" ]]; then
  echo "evidence path must be absolute and must not exist: $evidence_path" >&2
  exit 2
fi
evidence_dir="$(dirname "$evidence_path")"
if [[ ! -d "$evidence_dir" ]]; then
  echo "evidence directory does not exist: $evidence_dir" >&2
  exit 2
fi
evidence_dir="$(cd "$evidence_dir" && pwd -P)"
evidence_path="$evidence_dir/$(basename "$evidence_path")"
if [[ "$evidence_path" == "$repo_root"/* ]]; then
  echo "deployment evidence must remain outside the repository" >&2
  exit 2
fi

assert_source_unchanged() {
  node "$backend_dir/scripts/deployment-policy.mjs" unchanged \
    "$full_sha" "$(git -C "$repo_root" rev-parse HEAD)" \
    "$initial_fingerprint" "$(worktree_fingerprint)"
}

dry_run_dir="$(mktemp -d)"
temporary=""
cleanup() {
  if [[ -n "$temporary" ]]; then rm -f "$temporary"; fi
  rm -rf "$dry_run_dir"
}
trap cleanup EXIT

pnpm_version="$(pnpm --version)"
lockfile_sha256="$(sha256sum "$repo_root/pnpm-lock.yaml" | cut -d ' ' -f 1)"
store_release='null'
compatibility='null'
UNDERSTUDY_PRIOR_DEPLOYMENT='null'
UNDERSTUDY_HEALTH='null'
UNDERSTUDY_SOURCE_RELEASE='null'
UNDERSTUDY_ACTIVE_VERSION='null'
UNDERSTUDY_DEPLOYMENT='null'
deployment_stage="prepared"

write_evidence() {
  local outcome="$1"
  local failure_stage="${2:-}"
  local exit_code="${3:-0}"
  local recorded_at
  recorded_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  umask 077
  temporary="$(mktemp "$evidence_dir/.understudy-deploy.XXXXXX")"
  jq -n \
    --arg recordedAt "$recorded_at" \
    --arg outcome "$outcome" \
    --arg failureStage "$failure_stage" \
    --argjson exitCode "$exit_code" \
    --arg mode "$MODE" \
    --arg target "$target" \
    --arg sourceSha "$full_sha" \
    --arg sourceTag "$source_tag" \
    --arg sourceFingerprint "$initial_fingerprint" \
    --arg pnpmVersion "$pnpm_version" \
    --arg lockfileSha256 "$lockfile_sha256" \
    --argjson health "$UNDERSTUDY_HEALTH" \
    --argjson sourceReleaseVersion "$UNDERSTUDY_SOURCE_RELEASE" \
    --argjson activeWorkerVersion "$UNDERSTUDY_ACTIVE_VERSION" \
    --argjson activeDeployment "$UNDERSTUDY_DEPLOYMENT" \
    --argjson storeRelease "$store_release" \
    --argjson productionCompatibility "$compatibility" \
    --argjson priorDeployment "$UNDERSTUDY_PRIOR_DEPLOYMENT" \
    '{
    recordedAt: $recordedAt,
    outcome: $outcome,
    failureStage: (if $failureStage == "" then null else $failureStage end),
    exitCode: $exitCode,
    mode: $mode,
    target: $target,
    sourceSha: $sourceSha,
    sourceTag: $sourceTag,
    sourceFingerprint: $sourceFingerprint,
    dependencySnapshot: {
      pnpmVersion: $pnpmVersion,
      lockfileSha256: $lockfileSha256
    },
    health: $health,
    sourceReleaseVersion: $sourceReleaseVersion,
    activeWorkerVersion: $activeWorkerVersion,
    activeDeployment: $activeDeployment,
    priorDeployment: $priorDeployment,
    storeRelease: $storeRelease,
    productionCompatibility: $productionCompatibility
    }' >"$temporary"
  chmod 600 "$temporary"
  mv "$temporary" "$evidence_path"
  temporary=""
}

record_failed_deployment() {
  local exit_code="$?"
  trap - EXIT
  set +e
  UNDERSTUDY_HEALTH="$(understudy_json_or_null "$UNDERSTUDY_HEALTH")"
  UNDERSTUDY_SOURCE_RELEASE="$(understudy_json_or_null "$UNDERSTUDY_SOURCE_RELEASE")"
  UNDERSTUDY_ACTIVE_VERSION="$(understudy_json_or_null "$UNDERSTUDY_ACTIVE_VERSION")"
  UNDERSTUDY_DEPLOYMENT="$(understudy_json_or_null "$UNDERSTUDY_DEPLOYMENT")"
  UNDERSTUDY_PRIOR_DEPLOYMENT="$(understudy_json_or_null "$UNDERSTUDY_PRIOR_DEPLOYMENT")"
  store_release="$(understudy_json_or_null "$store_release")"
  compatibility="$(understudy_json_or_null "$compatibility")"
  write_evidence "failed" "$deployment_stage" "$exit_code"
  cleanup
  exit "$exit_code"
}

write_evidence "attempting"
trap record_failed_deployment EXIT
deployment_stage="build"
cd "$repo_root"
pnpm --filter @understudy/protocol build
if [[ "$MODE" == "production-auto" ]]; then
  pnpm --filter @understudy/extension build:store
  pnpm --filter @understudy/extension zip:store
  store_release="$(pnpm --silent --filter @understudy/extension verify:store-release)"
  compatibility="$(node "$backend_dir/scripts/verify-production-compatibility.mjs" live)"
fi
assert_source_unchanged

understudy_deploy_init "$target" "$backend_dir" "$full_sha" "$source_tag"
deployment_stage="dry-run"
understudy_deploy_dry_run "$dry_run_dir"
assert_source_unchanged

deployment_stage="prior-deployment"
UNDERSTUDY_PRIOR_DEPLOYMENT="$(understudy_wrangler_control_plane deployments status --json)"
understudy_require_json_type "$UNDERSTUDY_PRIOR_DEPLOYMENT" object "prior deployment"

if [[ -n "$branch" ]]; then
  deployment_stage="source-ref"
  git -C "$repo_root" fetch --quiet origin \
    "+refs/heads/$branch:refs/remotes/origin/$branch"
  remote_sha="$(git -C "$repo_root" rev-parse "refs/remotes/origin/$branch")"
  node "$backend_dir/scripts/deployment-policy.mjs" current-ref \
    "$branch" "$full_sha" "$remote_sha"
  assert_source_unchanged
fi

deployment_stage="upload"
understudy_deploy_release
deployment_stage="verification"
understudy_verify_deployment
deployment_stage="evidence"
write_evidence "verified"
trap - EXIT
cleanup
echo "deployment verified; evidence: $evidence_path"
