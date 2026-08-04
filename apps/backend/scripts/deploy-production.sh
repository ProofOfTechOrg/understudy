#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 4 || "$1" != /* || "$2" != /* || "$3" != /* || "$4" != /* ]]; then
  echo "usage: $0 /absolute/path/evidence.json /absolute/path/device-tokens.json /absolute/path/extension-id.txt /absolute/path/canary-credential.txt" >&2
  exit 2
fi

UNDERSTUDY_CLOUDFLARE_API_TOKEN="${CLOUDFLARE_API_TOKEN:-}"
unset CLOUDFLARE_API_TOKEN

for command in curl cut git jq mktemp node pnpm realpath sha256sum stat; do
  command -v "$command" >/dev/null || {
    echo "required command not found: $command" >&2
    exit 2
  }
done

repo_root="$(git rev-parse --show-toplevel)"
source "$repo_root/apps/backend/scripts/deploy-lib.sh"
evidence_path="$1"
device_tokens_path="$2"
extension_id_path="$3"
canary_credential_path="$4"
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
if [[ -e "$evidence_path" ]]; then
  echo "refusing to overwrite existing evidence: $evidence_path" >&2
  exit 2
fi
for source_path in "$device_tokens_path" "$extension_id_path" "$canary_credential_path"; do
  if [[ ! -f "$source_path" ]]; then
    echo "credential source does not exist or is not a regular file: $source_path" >&2
    exit 2
  fi
done
device_tokens_path="$(realpath -e "$device_tokens_path")"
extension_id_path="$(realpath -e "$extension_id_path")"
canary_credential_path="$(realpath -e "$canary_credential_path")"
for source_path in "$device_tokens_path" "$extension_id_path" "$canary_credential_path"; do
  if [[ ! -f "$source_path" || "$(stat -c '%a' "$source_path")" != "600" ]]; then
    echo "credential source must be an existing mode-0600 file: $source_path" >&2
    exit 2
  fi
  if [[ "$source_path" == "$repo_root"/* ]]; then
    echo "credential sources must remain outside the repository: $source_path" >&2
    exit 2
  fi
done
if ! compatibility_config="$(node "$repo_root/apps/backend/scripts/validate-production-config.mjs" \
  "$device_tokens_path" "$extension_id_path" "$canary_credential_path")"; then
  echo "production compatibility configuration is invalid" >&2
  exit 2
fi
extension_id="$(jq -r '.extensionId' <<<"$compatibility_config")"
device_tokens_sha256="$(jq -r '.deviceTokensSha256' <<<"$compatibility_config")"
if [[ ! "$device_tokens_sha256" =~ ^[0-9a-f]{64}$ ]]; then
  echo "production compatibility validator returned an invalid digest" >&2
  exit 2
fi
if [[ -n "$(git -C "$repo_root" status --porcelain=v1 --untracked-files=all)" ]]; then
  echo "refusing deployment from a dirty working tree" >&2
  exit 1
fi

full_sha="$(git -C "$repo_root" rev-parse HEAD)"
[[ "$full_sha" =~ ^[0-9a-f]{40}$ ]] || {
  echo "could not resolve a full source commit" >&2
  exit 1
}

assert_current_master_head() {
  git -C "$repo_root" fetch --quiet origin \
    "+refs/heads/master:refs/remotes/origin/master"
  local remote_sha
  remote_sha="$(git -C "$repo_root" rev-parse refs/remotes/origin/master)"
  node "$repo_root/apps/backend/scripts/deployment-policy.mjs" current-ref \
    master "$full_sha" "$remote_sha"
}

assert_source_unchanged() {
  if [[ "$(git -C "$repo_root" rev-parse HEAD)" != "$full_sha" ]] ||
    [[ -n "$(git -C "$repo_root" status --porcelain=v1 --untracked-files=all)" ]]; then
    echo "source changed after deployment commit was captured" >&2
    return 1
  fi
}

assert_current_master_head

snapshot_parent="$(mktemp -d)"
snapshot_root="$snapshot_parent/source"
temporary=""
cleanup() {
  if [[ -n "$temporary" ]]; then rm -f "$temporary"; fi
  git -C "$repo_root" worktree remove --force "$snapshot_root" >/dev/null 2>&1 || true
  rm -rf "$snapshot_parent"
}
trap cleanup EXIT
git -C "$repo_root" worktree add --detach "$snapshot_root" "$full_sha" >/dev/null
backend_dir="$snapshot_root/apps/backend"
if [[ "$(git -C "$snapshot_root" rev-parse HEAD)" != "$full_sha" ]] ||
  [[ -n "$(git -C "$snapshot_root" status --porcelain=v1 --untracked-files=no)" ]]; then
  echo "immutable deployment worktree does not match the captured commit" >&2
  exit 1
fi

expected_pnpm="$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).packageManager' "$snapshot_root/package.json")"
if [[ "$expected_pnpm" != "pnpm@$(pnpm --version)" ]]; then
  echo "deployment pnpm does not match the committed packageManager pin" >&2
  exit 1
fi
pnpm_version="${expected_pnpm#pnpm@}"
lockfile_sha256="$(sha256sum "$snapshot_root/pnpm-lock.yaml" | cut -d ' ' -f 1)"

cd "$snapshot_root"
pnpm install --frozen-lockfile --offline
pnpm --filter @understudy/protocol build
pnpm --filter @understudy/extension build:store
pnpm --filter @understudy/extension zip:store
store_release="$(pnpm --silent --filter @understudy/extension verify:store-release)"
production_contract="$(node "$backend_dir/scripts/verify-production-compatibility.mjs" current)"
if [[ -n "$(git -C "$snapshot_root" status --porcelain=v1 --untracked-files=no)" ]]; then
  echo "dependency preparation changed tracked snapshot files" >&2
  exit 1
fi

snapshot_compatibility_config="$(node "$backend_dir/scripts/validate-production-config.mjs" \
  "$device_tokens_path" "$extension_id_path" "$canary_credential_path")"
if [[ "$snapshot_compatibility_config" != "$compatibility_config" ]]; then
  echo "captured source does not match the preflight compatibility validator" >&2
  exit 1
fi

cd "$backend_dir"
understudy_deploy_init production "$backend_dir" "$full_sha" "$full_sha"
understudy_deploy_dry_run

read -r -p "Upload validated DEVICE_TOKENS and EXTENSION_ID, then deploy commit $full_sha? Type DEPLOY: " confirmation
if [[ "$confirmation" != "DEPLOY" ]]; then
  echo "deployment cancelled" >&2
  exit 1
fi

UNDERSTUDY_PRIOR_DEPLOYMENT='null'
prior_versions='null'
health='null'
active_version='null'
source_release='null'
deployment='null'
device_tokens_secret_version='null'
extension_id_secret_version='null'
secret_derived='null'
secret_mutation_possible='false'
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
    --arg sourceSha "$full_sha" \
    --arg pnpmVersion "$pnpm_version" \
    --arg lockfileSha256 "$lockfile_sha256" \
    --argjson secretMutationPossible "$secret_mutation_possible" \
    --argjson compatibilityConfiguration "$compatibility_config" \
    --argjson productionCompatibility "$production_contract" \
    --argjson storeRelease "$store_release" \
    --argjson health "$health" \
    --argjson sourceReleaseVersion "$source_release" \
    --argjson activeWorkerVersion "$active_version" \
    --argjson activeDeployment "$deployment" \
    --argjson priorDeployment "$UNDERSTUDY_PRIOR_DEPLOYMENT" \
    --argjson priorVersions "$prior_versions" \
    --argjson deviceTokensSecretVersion "$device_tokens_secret_version" \
    --argjson extensionIdSecretVersion "$extension_id_secret_version" \
    --argjson secretDerivedVersion "$secret_derived" \
    '{
      recordedAt: $recordedAt,
      outcome: $outcome,
      failureStage: (if $failureStage == "" then null else $failureStage end),
      exitCode: $exitCode,
      sourceSha: $sourceSha,
      dependencySnapshot: {
        pnpmVersion: $pnpmVersion,
        lockfileSha256: $lockfileSha256
      },
      secretMutationPossible: $secretMutationPossible,
      compatibilityConfiguration: $compatibilityConfiguration,
      productionCompatibility: $productionCompatibility,
      storeRelease: $storeRelease,
      health: $health,
      sourceReleaseVersion: $sourceReleaseVersion,
      activeWorkerVersion: $activeWorkerVersion,
      activeDeployment: $activeDeployment,
      priorDeployment: $priorDeployment,
      priorVersions: $priorVersions,
      deviceTokensSecretVersion: $deviceTokensSecretVersion,
      extensionIdSecretVersion: $extensionIdSecretVersion,
      secretDerivedVersion: $secretDerivedVersion
    }' >"$temporary"
  chmod 600 "$temporary"
  mv "$temporary" "$evidence_path"
  temporary=""
}

record_failed_deployment() {
  local exit_code="$?"
  trap - EXIT
  set +e
  compatibility_config="$(understudy_json_or_null "$compatibility_config")"
  production_contract="$(understudy_json_or_null "$production_contract")"
  store_release="$(understudy_json_or_null "$store_release")"
  health="$(understudy_json_or_null "$health")"
  source_release="$(understudy_json_or_null "$source_release")"
  active_version="$(understudy_json_or_null "$active_version")"
  deployment="$(understudy_json_or_null "$deployment")"
  UNDERSTUDY_PRIOR_DEPLOYMENT="$(understudy_json_or_null "$UNDERSTUDY_PRIOR_DEPLOYMENT")"
  prior_versions="$(understudy_json_or_null "$prior_versions")"
  device_tokens_secret_version="$(understudy_json_or_null "$device_tokens_secret_version")"
  extension_id_secret_version="$(understudy_json_or_null "$extension_id_secret_version")"
  secret_derived="$(understudy_json_or_null "$secret_derived")"
  write_evidence "failed" "$deployment_stage" "$exit_code"
  cleanup
  exit "$exit_code"
}

write_evidence "attempting"
trap record_failed_deployment EXIT
deployment_stage="source-ref"
assert_source_unchanged
assert_current_master_head
deployment_stage="prior-deployment"
UNDERSTUDY_PRIOR_DEPLOYMENT="$(understudy_wrangler_control_plane deployments status --json)"
understudy_require_json_type "$UNDERSTUDY_PRIOR_DEPLOYMENT" object "prior deployment"
prior_versions="$(understudy_versions_json)"
understudy_require_json_type "$prior_versions" array "prior version inventory"
secret_mutation_possible='true'
deployment_stage="device-token-secret"
understudy_with_cloudflare_auth node "$backend_dir/scripts/put-validated-secret.mjs" \
  DEVICE_TOKENS "$device_tokens_sha256" <"$device_tokens_path"
device_tokens_versions="$(understudy_versions_json)"
device_tokens_secret_version="$(
  jq -n --argjson before "$prior_versions" --argjson after "$device_tokens_versions" \
    '{before: $before, after: $after}' |
    node "$backend_dir/scripts/secret-version.mjs"
)"
deployment_stage="extension-id-secret"
printf '%s' "$extension_id" | understudy_with_cloudflare_auth \
  pnpm exec wrangler secret put EXTENSION_ID --env ""
extension_id_versions="$(understudy_versions_json)"
extension_id_secret_version="$(
  jq -n --argjson before "$device_tokens_versions" --argjson after "$extension_id_versions" \
    '{before: $before, after: $after}' |
    node "$backend_dir/scripts/secret-version.mjs"
)"
deployment_stage="source-ref"
assert_source_unchanged
assert_current_master_head
deployment_stage="upload"
understudy_deploy_release
deployment_stage="verification"
understudy_verify_deployment
health="$UNDERSTUDY_HEALTH"
active_version="$UNDERSTUDY_ACTIVE_VERSION"
source_release="$UNDERSTUDY_SOURCE_RELEASE"
deployment="$UNDERSTUDY_DEPLOYMENT"

secret_derived="$(jq '
  if .annotations["workers/triggered_by"] == "secret" then . else null end
' <<<"$active_version")"
deployment_stage="evidence"
write_evidence "verified"
trap - EXIT
cleanup
echo "deployment verified; evidence: $evidence_path"
