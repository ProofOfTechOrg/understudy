#!/usr/bin/env bash
set -euo pipefail

readonly SERVICE_ORIGIN="https://understudy.proofof.tech"
readonly SERVICE_HOST="understudy.proofof.tech"
readonly CURL_CONNECT_TIMEOUT_SECONDS=5
readonly CURL_MAX_TIME_SECONDS=20

usage() {
  echo "usage: $0 <a|b> <duration-seconds> <credential-file> <evidence-jsonl>" >&2
  echo "requires UNDERSTUDY_DEVICE_ID, UNDERSTUDY_TEST_ORIGIN, and UNDERSTUDY_SOAK_CONFIRMED_INACTIVE=yes" >&2
}

if [[ $# -ne 4 ]]; then
  usage
  exit 2
fi

readonly mode="$1"
readonly duration="$2"
readonly credential_file="$3"
readonly evidence_input="$4"
evidence_path="$evidence_input"

case "$mode:$duration" in
  a:30|a:60|a:120|b:30) ;;
  *) usage; exit 2 ;;
esac
if [[ "${UNDERSTUDY_SOAK_CONFIRMED_INACTIVE:-}" != "yes" ]]; then
  echo "refusing to disrupt connectivity until the operator confirms no soak is active" >&2
  exit 2
fi
if [[ ! "${UNDERSTUDY_DEVICE_ID:-}" =~ ^[0-9a-fA-F-]{36}$ ]]; then
  echo "UNDERSTUDY_DEVICE_ID must be the exact paired browser UUID" >&2
  exit 2
fi
if [[ -z "${UNDERSTUDY_TEST_ORIGIN:-}" ]]; then
  echo "UNDERSTUDY_TEST_ORIGIN must be an allowed exact HTTPS origin" >&2
  exit 2
fi
test_origin="$(
  node -e '
    const value = process.argv[1];
    const url = new URL(value);
    if (url.protocol !== "https:" || url.origin !== value.replace(/\/$/, "")) process.exit(1);
    process.stdout.write(url.origin);
  ' "$UNDERSTUDY_TEST_ORIGIN"
)" || {
  echo "UNDERSTUDY_TEST_ORIGIN must be an exact HTTPS origin" >&2
  exit 2
}

for command in curl git grep jq node seq stat sudo; do
  command -v "$command" >/dev/null || {
    echo "required command not found: $command" >&2
    exit 2
  }
done
if [[ ! -f "$credential_file" || "$(stat -c '%a' "$credential_file")" != "600" ]]; then
  echo "credential file must be a regular mode-0600 file" >&2
  exit 2
fi
caller_token="$(jq -r '
  if type == "string" then .
  elif type == "object" and (.token | type) == "string" then .token
  elif type == "object" and length == 1 then keys[0]
  else empty end
' "$credential_file")"
if [[ -z "$caller_token" || "$caller_token" == *$'\n'* ]]; then
  echo "credential file must contain one JSON string, a token field, or a one-key token map" >&2
  exit 2
fi

if [[ "$evidence_path" != /* ]]; then
  echo "evidence path must be absolute" >&2
  exit 2
fi
repo_root="$(git rev-parse --show-toplevel)"
evidence_dir="$(dirname "$evidence_path")"
if [[ ! -d "$evidence_dir" ]]; then
  echo "evidence directory does not exist: $evidence_dir" >&2
  exit 2
fi
evidence_dir="$(cd "$evidence_dir" && pwd -P)"
evidence_path="$evidence_dir/$(basename "$evidence_path")"
if [[ "$evidence_path" == "$repo_root"/* ]]; then
  echo "raw outage evidence must remain outside the repository" >&2
  exit 2
fi
umask 077
touch "$evidence_path"
chmod 600 "$evidence_path"
if [[ "$(stat -c '%a' "$evidence_path")" != "600" ]]; then
  echo "could not enforce mode 0600 on evidence" >&2
  exit 1
fi

temporary_dir="$(mktemp -d)"
response_file="$temporary_dir/response.json"
readonly run_id="network-blip-${mode}-${duration}-$(date -u +%Y%m%dT%H%M%SZ)-$$"
readonly idempotency_key="$(node -e 'process.stdout.write(crypto.randomUUID())')"
readonly rule_tag="understudy-$run_id"
session_id=""
baseline_used=""
baseline_last_seen=""
pre_break_last_seen=""
network_restored=true
tailscale_restore_required=false
blocked_v4=()
blocked_v6=()

record() {
  local payload="$1"
  jq -c --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg runId "$run_id" \
    '. + {at: $at, runId: $runId}' <<<"$payload" >>"$evidence_path"
}

api_get() {
  curl --connect-timeout "$CURL_CONNECT_TIMEOUT_SECONDS" \
    --max-time "$CURL_MAX_TIME_SECONDS" --fail --silent --show-error \
    --header "Authorization: Bearer $caller_token" \
    "$SERVICE_ORIGIN$1"
}

restore_network() {
  if [[ "$network_restored" == true ]]; then return 0; fi
  local failed=0
  if [[ "$mode" == "a" ]]; then
    local ip
    for ip in "${blocked_v4[@]}"; do
      sudo iptables -D OUTPUT -d "$ip" -m comment --comment "$rule_tag" -j REJECT \
        >/dev/null 2>&1 || true
    done
    for ip in "${blocked_v6[@]}"; do
      sudo ip6tables -D OUTPUT -d "$ip" -m comment --comment "$rule_tag" -j REJECT \
        >/dev/null 2>&1 || true
    done
    if sudo iptables-save | grep -F -- "$rule_tag" >/dev/null; then failed=1; fi
    if command -v ip6tables-save >/dev/null &&
      sudo ip6tables-save | grep -F -- "$rule_tag" >/dev/null; then failed=1; fi
  elif [[ "$tailscale_restore_required" == true ]]; then
    sudo tailscale up >/dev/null || failed=1
    tailscale_restore_required=false
  fi
  if (( failed == 0 )); then
    network_restored=true
    record '{"event":"network_restored","verified":true}'
  else
    network_restored=false
    record '{"event":"network_restored","verified":false}'
    echo "network restoration verification failed" >&2
  fi
  return "$failed"
}

cleanup_session() {
  [[ -n "$session_id" ]] || return 0
  local delete_status
  delete_status="$(curl --connect-timeout "$CURL_CONNECT_TIMEOUT_SECONDS" \
    --max-time "$CURL_MAX_TIME_SECONDS" --silent --show-error --output /dev/null --write-out '%{http_code}' \
    --request DELETE --header "Authorization: Bearer $caller_token" \
    "$SERVICE_ORIGIN/v1/sessions/$session_id" || true)"
  local terminal=false
  local status_code
  for _ in $(seq 1 30); do
    status_code="$(curl --connect-timeout "$CURL_CONNECT_TIMEOUT_SECONDS" \
      --max-time "$CURL_MAX_TIME_SECONDS" --silent --show-error --output "$response_file" --write-out '%{http_code}' \
      --header "Authorization: Bearer $caller_token" \
      "$SERVICE_ORIGIN/v1/sessions/$session_id" || true)"
    if [[ "$status_code" == "404" || "$status_code" == "410" ]]; then
      terminal=true
      break
    fi
    sleep 2
  done
  local final_used=""
  local devices
  if devices="$(api_get /v1/devices 2>/dev/null)"; then
    final_used="$(jq -r --arg id "$UNDERSTUDY_DEVICE_ID" '
      first(.devices[] | select(.deviceId == $id) | .used) // empty
    ' <<<"$devices")"
  fi
  record "$(jq -cn \
    --arg deleteStatus "$delete_status" \
    --argjson terminal "$terminal" \
    --arg baselineUsed "$baseline_used" \
    --arg finalUsed "$final_used" \
    '{event:"session_cleanup",deleteStatus:$deleteStatus,terminal:$terminal,baselineUsed:$baselineUsed,finalUsed:$finalUsed,capacityRestored:($baselineUsed != "" and $baselineUsed == $finalUsed)}')"
  [[ "$terminal" == true && -n "$baseline_used" && "$baseline_used" == "$final_used" ]]
}

finish() {
  local exit_status=$?
  trap - EXIT INT TERM
  set +e
  restore_network
  local restore_status=$?
  cleanup_session
  local cleanup_status=$?
  record "$(jq -cn --argjson originalStatus "$exit_status" \
    --argjson restorationStatus "$restore_status" \
    --argjson cleanupStatus "$cleanup_status" \
    '{event:"run_finished",originalStatus:$originalStatus,restorationStatus:$restorationStatus,cleanupStatus:$cleanupStatus}')"
  rm -rf "$temporary_dir"
  if (( exit_status == 0 && restore_status == 0 && cleanup_status == 0 )); then
    exit 0
  fi
  exit 1
}
trap finish EXIT INT TERM

devices="$(api_get /v1/devices)"
device="$(jq -c --arg id "$UNDERSTUDY_DEVICE_ID" '
  first(.devices[] | select(.deviceId == $id)) // empty
' <<<"$devices")"
if [[ -z "$device" || "$(jq -r '.status' <<<"$device")" != "online" ]]; then
  echo "selected browser is not online" >&2
  exit 1
fi
baseline_used="$(jq -r '.used' <<<"$device")"
baseline_last_seen="$(jq -r '.lastSeenAt // empty' <<<"$device")"
if [[ -z "$baseline_last_seen" ]]; then
  echo "selected browser has no baseline lastSeenAt" >&2
  exit 1
fi
record "$(jq -cn \
  --arg mode "$mode" --argjson duration "$duration" \
  --arg deviceId "$UNDERSTUDY_DEVICE_ID" --arg origin "$test_origin" \
  --arg idempotencyKey "$idempotency_key" --arg baselineLastSeenAt "$baseline_last_seen" \
  --arg baselineUsed "$baseline_used" \
  '{event:"run_started",mode:$mode,durationSeconds:$duration,deviceId:$deviceId,origin:$origin,idempotencyKey:$idempotencyKey,baselineLastSeenAt:$baselineLastSeenAt,baselineUsed:$baselineUsed}')"

request_body="$(jq -cn \
  --arg deviceId "$UNDERSTUDY_DEVICE_ID" --arg origin "$test_origin" \
  --arg profileStateKey "$run_id" \
  '{mode:"unattended",deviceId:$deviceId,allowedOrigins:[$origin],profileStateKey:$profileStateKey}')"
create_status="$(curl --connect-timeout "$CURL_CONNECT_TIMEOUT_SECONDS" \
  --max-time "$CURL_MAX_TIME_SECONDS" --silent --show-error --output "$response_file" --write-out '%{http_code}' \
  --request POST \
  --header "Authorization: Bearer $caller_token" \
  --header "Idempotency-Key: $idempotency_key" \
  --header "Content-Type: application/json" \
  --data "$request_body" \
  "$SERVICE_ORIGIN/v1/sessions" || true)"
if [[ ! "$create_status" =~ ^20[012]$ ]]; then
  record "$(jq -cn --arg status "$create_status" '{event:"create_retry",firstStatus:$status}')"
  create_status="$(curl --connect-timeout "$CURL_CONNECT_TIMEOUT_SECONDS" \
    --max-time "$CURL_MAX_TIME_SECONDS" --silent --show-error --output "$response_file" --write-out '%{http_code}' \
    --request POST \
    --header "Authorization: Bearer $caller_token" \
    --header "Idempotency-Key: $idempotency_key" \
    --header "Content-Type: application/json" \
    --data "$request_body" \
    "$SERVICE_ORIGIN/v1/sessions" || true)"
fi
if [[ ! "$create_status" =~ ^20[012]$ ]]; then
  echo "session creation failed with HTTP $create_status" >&2
  exit 1
fi
session_id="$(jq -r '.sessionId // empty' "$response_file")"
if [[ -z "$session_id" ]]; then
  echo "session response omitted sessionId" >&2
  exit 1
fi
record "$(jq -cn --arg status "$create_status" --arg sessionId "$session_id" \
  '{event:"session_allocated",httpStatus:$status,sessionId:$sessionId}')"

if [[ "$create_status" == "202" ]]; then
  connected=false
  for _ in $(seq 1 15); do
    session_status="$(curl --connect-timeout "$CURL_CONNECT_TIMEOUT_SECONDS" \
      --max-time "$CURL_MAX_TIME_SECONDS" --silent --show-error --output "$response_file" --write-out '%{http_code}' \
      --header "Authorization: Bearer $caller_token" \
      "$SERVICE_ORIGIN/v1/sessions/$session_id" || true)"
    if [[ "$session_status" == "200" && "$(jq -r '.status // empty' "$response_file")" == "connected" ]]; then
      connected=true
      break
    fi
    sleep 2
  done
  if [[ "$connected" != true ]]; then
    echo "session did not connect before disruption" >&2
    exit 1
  fi
fi

if [[ "$mode" == "a" ]]; then
  for command in getent awk sort iptables iptables-save; do
    command -v "$command" >/dev/null || {
      echo "required command not found for Test A: $command" >&2
      exit 2
    }
  done
  mapfile -t ipv4 < <(getent ahostsv4 "$SERVICE_HOST" | awk '{print $1}' | sort -u)
  mapfile -t ipv6 < <(getent ahostsv6 "$SERVICE_HOST" | awk '{print $1}' | sort -u)
  if (( ${#ipv4[@]} == 0 )); then
    echo "canonical service has no resolved IPv4 addresses" >&2
    exit 1
  fi
  if (( ${#ipv6[@]} > 0 )); then
    for command in ip6tables ip6tables-save; do
      command -v "$command" >/dev/null || {
        echo "required command not found for resolved IPv6 Test A target: $command" >&2
        exit 2
      }
    done
  fi
else
  command -v tailscale >/dev/null || {
    echo "tailscale is required for Test B" >&2
    exit 2
  }
fi

read -r -p "Expose the extension card without opening service-worker DevTools, confirm no soak is active, then type BREAK: " confirmation
if [[ "$confirmation" != "BREAK" ]]; then
  echo "network test cancelled" >&2
  exit 1
fi

pre_break_devices="$(api_get /v1/devices)"
pre_break_last_seen="$(jq -r --arg id "$UNDERSTUDY_DEVICE_ID" '
  first(.devices[] | select(.deviceId == $id) | .lastSeenAt) // empty
' <<<"$pre_break_devices")"
if [[ -z "$pre_break_last_seen" ]]; then
  echo "selected browser has no immediately pre-break lastSeenAt" >&2
  exit 1
fi
record "$(jq -cn --arg preBreakLastSeenAt "$pre_break_last_seen" \
  '{event:"pre_break_inventory",preBreakLastSeenAt:$preBreakLastSeenAt}')"

network_restored=false
if [[ "$mode" == "a" ]]; then
  for ip in "${ipv4[@]}"; do
    blocked_v4+=("$ip")
    sudo iptables -I OUTPUT -d "$ip" -m comment --comment "$rule_tag" -j REJECT
  done
  for ip in "${ipv6[@]}"; do
    blocked_v6+=("$ip")
    sudo ip6tables -I OUTPUT -d "$ip" -m comment --comment "$rule_tag" -j REJECT
  done
else
  tailscale_restore_required=true
  sudo tailscale down
fi
record "$(jq -cn --arg mode "$mode" --argjson duration "$duration" \
  '{event:"connectivity_blocked",mode:$mode,durationSeconds:$duration}')"

for _ in $(seq 1 "$duration"); do sleep 1; done
restored_ms="$(date +%s%3N)"
restore_network

device_back_ms=""
lease_status="unknown"
for _ in $(seq 1 90); do
  if devices="$(api_get /v1/devices 2>/dev/null)"; then
    device="$(jq -c --arg id "$UNDERSTUDY_DEVICE_ID" '
      first(.devices[] | select(.deviceId == $id)) // empty
    ' <<<"$devices")"
    current_seen="$(jq -r '.lastSeenAt // empty' <<<"${device:-{}}")"
    if [[ -n "$device" && "$(jq -r '.status' <<<"$device")" == "online" &&
      -n "$current_seen" && "$current_seen" != "$pre_break_last_seen" ]]; then
      device_back_ms="$(date +%s%3N)"
      break
    fi
  fi
  sleep 2
done
if [[ -z "$device_back_ms" ]]; then
  echo "device did not produce a fresh post-break lastSeenAt" >&2
  exit 1
fi
session_http="$(curl --connect-timeout "$CURL_CONNECT_TIMEOUT_SECONDS" \
  --max-time "$CURL_MAX_TIME_SECONDS" --silent --show-error --output "$response_file" --write-out '%{http_code}' \
  --header "Authorization: Bearer $caller_token" \
  "$SERVICE_ORIGIN/v1/sessions/$session_id" || true)"
if [[ "$session_http" == "200" || "$session_http" == "410" ]]; then
  lease_status="$(jq -r '.status // "unknown"' "$response_file")"
fi
recovery_ms=$((device_back_ms - restored_ms))
record "$(jq -cn \
  --argjson recoveryMs "$recovery_ms" --arg leaseStatus "$lease_status" \
  --arg preBreakLastSeenAt "$pre_break_last_seen" --arg postBreakLastSeenAt "$current_seen" \
  '{event:"device_recovered",recoveryMs:$recoveryMs,leaseStatus:$leaseStatus,preBreakLastSeenAt:$preBreakLastSeenAt,postBreakLastSeenAt:$postBreakLastSeenAt}')"

if (( recovery_ms > 30000 )) || [[ "$lease_status" != "connected" ]]; then
  echo "diagnostic threshold exceeded: recovery=${recovery_ms}ms lease=$lease_status" >&2
  exit 1
fi
