#!/usr/bin/env bash
set -euo pipefail

readonly SECRET_NAMES=(
  AUTH_HMAC_SECRET
  CALLER_TOKENS
  EXTENSION_TOKENS
  DEVICE_TOKENS
  EXTENSION_ID
  WS_TICKET_SECRET
)

if [[ $# -ne ${#SECRET_NAMES[@]} ]]; then
  echo "usage: $0 /absolute/auth-hmac /absolute/caller-tokens.json /absolute/extension-tokens.json /absolute/device-tokens.json /absolute/extension-id /absolute/ws-ticket" >&2
  exit 2
fi

for command in git jq node pnpm realpath stat; do
  command -v "$command" >/dev/null || {
    echo "required command not found: $command" >&2
    exit 2
  }
done

repo_root="$(git rev-parse --show-toplevel)"
paths=()
for source_path in "$@"; do
  if [[ "$source_path" != /* || ! -f "$source_path" ]]; then
    echo "staging secret source must be an absolute regular file: $source_path" >&2
    exit 2
  fi
  source_path="$(realpath -e "$source_path")"
  if [[ "$(stat -c '%a' "$source_path")" != "600" ]]; then
    echo "staging secret source must have mode 0600: $source_path" >&2
    exit 2
  fi
  if [[ "$source_path" == "$repo_root"/* ]]; then
    echo "staging secret sources must remain outside the repository" >&2
    exit 2
  fi
  paths+=("$source_path")
done

validation="$(node "$repo_root/apps/backend/scripts/validate-staging-config.mjs" "${paths[@]}")"
backend_dir="$repo_root/apps/backend"
for index in "${!SECRET_NAMES[@]}"; do
  name="${SECRET_NAMES[$index]}"
  digest="$(jq -r --arg name "$name" '.[$name]' <<<"$validation")"
  node "$backend_dir/scripts/put-validated-secret.mjs" \
    "$name" "$digest" staging <"${paths[$index]}"
done

echo "staging secrets provisioned"
