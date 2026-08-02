#!/usr/bin/env bash
set -euo pipefail

readonly HEALTH_URL="https://understudy.proofof.tech/health"
readonly REQUIRED_MATCHES=3
readonly MAX_POLLS=30
readonly CURL_CONNECT_TIMEOUT_SECONDS=5
readonly CURL_MAX_TIME_SECONDS=20

if [[ $# -ne 4 || "$1" != /* || "$2" != /* || "$3" != /* || "$4" != /* ]]; then
  echo "usage: $0 /absolute/path/evidence.json /absolute/path/device-tokens.json /absolute/path/extension-id.txt /absolute/path/canary-credential.txt" >&2
  exit 2
fi

for command in curl cut git jq mktemp node pnpm realpath sha256sum stat; do
  command -v "$command" >/dev/null || {
    echo "required command not found: $command" >&2
    exit 2
  }
done

repo_root="$(git rev-parse --show-toplevel)"
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

assert_source_unchanged() {
  if [[ "$(git -C "$repo_root" rev-parse HEAD)" != "$full_sha" ]] ||
    [[ -n "$(git -C "$repo_root" status --porcelain=v1 --untracked-files=all)" ]]; then
    echo "source changed after deployment commit was captured" >&2
    return 1
  fi
}

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
pnpm exec wrangler deploy --dry-run

read -r -p "Upload validated DEVICE_TOKENS and EXTENSION_ID, then deploy commit $full_sha? Type DEPLOY: " confirmation
if [[ "$confirmation" != "DEPLOY" ]]; then
  echo "deployment cancelled" >&2
  exit 1
fi

assert_source_unchanged
node "$backend_dir/scripts/put-validated-secret.mjs" \
  DEVICE_TOKENS "$device_tokens_sha256" <"$device_tokens_path"
printf '%s' "$extension_id" | pnpm exec wrangler secret put EXTENSION_ID
compatibility_versions="$(pnpm exec wrangler versions list --json)"
compatibility_secret_version="$(jq '
  map(select(.annotations["workers/triggered_by"] == "secret")) | last // null
' <<<"$compatibility_versions")"
assert_source_unchanged
pnpm exec wrangler deploy --strict --tag "$full_sha" --message "source $full_sha"

matches=0
polls=0
health='null'
while (( matches < REQUIRED_MATCHES && polls < MAX_POLLS )); do
  polls=$((polls + 1))
  if candidate="$(curl --connect-timeout "$CURL_CONNECT_TIMEOUT_SECONDS" \
    --max-time "$CURL_MAX_TIME_SECONDS" --fail --silent --show-error "$HEALTH_URL")" &&
    jq -e --arg sha "$full_sha" '
      .ok == true and .commit == $sha and
      (.versionId | type == "string" and length > 0) and
      (.deployedAt | type == "string" and length > 0)
    ' >/dev/null <<<"$candidate"; then
    health="$candidate"
    matches=$((matches + 1))
  else
    matches=0
  fi
  if (( matches < REQUIRED_MATCHES )); then sleep 2; fi
done
if (( matches < REQUIRED_MATCHES )); then
  echo "health provenance did not converge after $polls polls" >&2
  exit 1
fi

versions="$(pnpm exec wrangler versions list --json)"
deployment="$(pnpm exec wrangler deployments status --json)"
active_version_id="$(jq -r '.versionId' <<<"$health")"
active_version="$(jq --arg id "$active_version_id" '
  map(select(.id == $id)) | first // null
' <<<"$versions")"
source_release="$(jq --arg sha "$full_sha" '
  map(select(
    .annotations["workers/tag"] == $sha or
    .annotations["workers/message"] == ("source " + $sha)
  )) | last // null
' <<<"$versions")"
if [[ "$source_release" == "null" || "$active_version" == "null" ]]; then
  echo "Wrangler version inventory did not contain the source or active version" >&2
  exit 1
fi
if ! jq -e --arg id "$active_version_id" '
  any(.versions[]; .version_id == $id and .percentage == 100)
' >/dev/null <<<"$deployment"; then
  echo "active deployment is not serving the health-reported version at 100%" >&2
  exit 1
fi

secret_derived="$(jq '
  if .annotations["workers/triggered_by"] == "secret" then . else null end
' <<<"$active_version")"
recorded_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
umask 077
temporary="$(mktemp "$evidence_dir/.understudy-deploy.XXXXXX")"
jq -n \
  --arg recordedAt "$recorded_at" \
  --arg sourceSha "$full_sha" \
  --arg pnpmVersion "$pnpm_version" \
  --arg lockfileSha256 "$lockfile_sha256" \
  --argjson compatibilityConfiguration "$compatibility_config" \
  --argjson health "$health" \
  --argjson sourceReleaseVersion "$source_release" \
  --argjson activeWorkerVersion "$active_version" \
  --argjson activeDeployment "$deployment" \
  --argjson compatibilitySecretVersion "$compatibility_secret_version" \
  --argjson secretDerivedVersion "$secret_derived" \
  '{
    recordedAt: $recordedAt,
    sourceSha: $sourceSha,
    dependencySnapshot: {
      pnpmVersion: $pnpmVersion,
      lockfileSha256: $lockfileSha256
    },
    compatibilityConfiguration: $compatibilityConfiguration,
    health: $health,
    sourceReleaseVersion: $sourceReleaseVersion,
    activeWorkerVersion: $activeWorkerVersion,
    activeDeployment: $activeDeployment,
    compatibilitySecretVersion: $compatibilitySecretVersion,
    secretDerivedVersion: $secretDerivedVersion
  }' >"$temporary"
chmod 600 "$temporary"
mv "$temporary" "$evidence_path"
temporary=""
cleanup
trap - EXIT
echo "deployment verified; evidence: $evidence_path"
