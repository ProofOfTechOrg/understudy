#!/usr/bin/env bash

understudy_deploy_init() {
  local target="$1"
  UNDERSTUDY_BACKEND_DIR="$2"
  UNDERSTUDY_SOURCE_SHA="$3"
  UNDERSTUDY_SOURCE_TAG="$4"
  case "$target" in
    production)
      UNDERSTUDY_HEALTH_URL="https://understudy.proofof.tech/health"
      UNDERSTUDY_ENV_ARGS=(--env "")
      ;;
    staging)
      UNDERSTUDY_HEALTH_URL="https://staging.understudy.proofof.tech/health"
      UNDERSTUDY_ENV_ARGS=(--env staging)
      ;;
    *)
      echo "unknown deployment target: $target" >&2
      return 2
      ;;
  esac
}

understudy_wrangler() {
  (
    cd "$UNDERSTUDY_BACKEND_DIR"
    pnpm exec wrangler "$@" "${UNDERSTUDY_ENV_ARGS[@]}"
  )
}

understudy_with_cloudflare_auth() {
  if [[ -n "${UNDERSTUDY_CLOUDFLARE_API_TOKEN:-}" ]]; then
    CLOUDFLARE_API_TOKEN="$UNDERSTUDY_CLOUDFLARE_API_TOKEN" "$@"
  else
    "$@"
  fi
}

understudy_wrangler_control_plane() {
  (
    cd "$UNDERSTUDY_BACKEND_DIR"
    understudy_with_cloudflare_auth \
      pnpm exec wrangler "$@" "${UNDERSTUDY_ENV_ARGS[@]}"
  )
}

understudy_deploy_dry_run() {
  local output_dir="${1:-}"
  if [[ -n "$output_dir" ]]; then
    understudy_wrangler deploy --dry-run --outdir "$output_dir"
  else
    understudy_wrangler deploy --dry-run
  fi
}

understudy_json_or_null() {
  local value="${1:-null}"
  if jq -e -n --argjson value "$value" '$value | type' >/dev/null 2>&1; then
    printf '%s' "$value"
  else
    printf 'null'
  fi
}

understudy_require_json_type() {
  local value="$1"
  local expected_type="$2"
  local label="$3"
  if ! jq -e -n --argjson value "$value" --arg expected "$expected_type" \
    '$value | type == $expected' >/dev/null 2>&1; then
    echo "$label did not return a JSON $expected_type" >&2
    return 1
  fi
}

understudy_versions_json() {
  understudy_wrangler_control_plane versions list --json
}

understudy_deploy_release() {
  understudy_wrangler_control_plane deploy --strict \
    --tag "$UNDERSTUDY_SOURCE_TAG" \
    --message "source $UNDERSTUDY_SOURCE_SHA"
}

understudy_health_read() {
  local response curl_status
  if response="$(
    curl --connect-timeout 5 --max-time 20 --fail --silent "$UNDERSTUDY_HEALTH_URL"
  )"; then
    printf '%s' "$response"
    return
  else
    curl_status="$?"
  fi
  if (( curl_status != 6 )); then
    curl --connect-timeout 5 --max-time 20 --fail --silent --show-error \
      "$UNDERSTUDY_HEALTH_URL"
    return
  fi
  curl --doh-url https://cloudflare-dns.com/dns-query \
    --connect-timeout 5 --max-time 20 --fail --silent --show-error \
    "$UNDERSTUDY_HEALTH_URL"
}

understudy_verify_deployment() {
  local required_matches=3
  local max_polls=30
  local matches=0
  local polls=0
  local candidate
  UNDERSTUDY_HEALTH='null'
  while (( matches < required_matches && polls < max_polls )); do
    polls=$((polls + 1))
    if candidate="$(understudy_health_read)" &&
      jq -e --arg tag "$UNDERSTUDY_SOURCE_TAG" '
        .ok == true and .commit == $tag and
        (.versionId | type == "string" and length > 0) and
        (.deployedAt | type == "string" and length > 0)
      ' >/dev/null <<<"$candidate"; then
      UNDERSTUDY_HEALTH="$candidate"
      matches=$((matches + 1))
    else
      matches=0
    fi
    if (( matches < required_matches )); then sleep 2; fi
  done
  if (( matches < required_matches )); then
    echo "health provenance did not converge after $polls polls" >&2
    return 1
  fi

  UNDERSTUDY_VERSIONS="$(understudy_versions_json)"
  UNDERSTUDY_DEPLOYMENT="$(understudy_wrangler_control_plane deployments status --json)"
  local active_version_id
  active_version_id="$(jq -r '.versionId' <<<"$UNDERSTUDY_HEALTH")"
  UNDERSTUDY_ACTIVE_VERSION="$(jq --arg id "$active_version_id" '
    map(select(.id == $id)) | first // null
  ' <<<"$UNDERSTUDY_VERSIONS")"
  if ! jq -e --arg tag "$UNDERSTUDY_SOURCE_TAG" --arg sha "$UNDERSTUDY_SOURCE_SHA" '
    . != null and
    .annotations["workers/tag"] == $tag and
    .annotations["workers/message"] == ("source " + $sha)
  ' >/dev/null <<<"$UNDERSTUDY_ACTIVE_VERSION"; then
    echo "active Worker version does not carry the expected source provenance" >&2
    return 1
  fi
  UNDERSTUDY_SOURCE_RELEASE="$UNDERSTUDY_ACTIVE_VERSION"
  if ! jq -e --arg id "$active_version_id" '
    any(.versions[]; .version_id == $id and .percentage == 100)
  ' >/dev/null <<<"$UNDERSTUDY_DEPLOYMENT"; then
    echo "active deployment is not serving the health-reported version at 100%" >&2
    return 1
  fi
}
