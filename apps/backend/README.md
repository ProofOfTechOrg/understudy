<!-- Content type: Reference -->

# Operate the Understudy backend

The backend is a Cloudflare Worker with Hono, OAuth Provider, Agents SDK Durable Objects, SQLite coordination, Analytics Engine telemetry, and a rate-limit backstop. It coordinates browser work but never runs Chromium or stores payment cards.

## Object topology

| Binding | Class | Authority |
|---|---|---|
| `SESSION` | `SessionAgent` | Session socket, lifecycle, command journal, results, dialogs, and attended attachment |
| `DEVICE` | `DeviceAgent` | One authoritative control socket per paired browser |
| `TENANT_CONTROL` | `TenantDeviceCoordinator` | Device inventory, policy acknowledgement, leases, capacity, idempotency, and alarms |
| `ACCOUNT_DIRECTORY` | `AccountDirectory` | Accounts, pairing offers, browser credentials, API tokens, and auth epochs |
| `ACCOUNT` | `AccountAgent` | Per-device MCP browser bindings and ref-generation guards within one tenant |
| `MCP_AGENT` | `UnderstudyMcp` | Streamable HTTP MCP connection |

Migrations `v1` through `v4` are additive. Do not remove them during rollback.

## HTTP and MCP surfaces

All `/v1` caller endpoints require `Authorization: Bearer <caller-token>`. Unknown or cross-tenant session IDs return `404`.

| Endpoint | Result |
|---|---|
| `POST /v1/sessions` with no body | Create an attended session |
| `POST /v1/sessions` with an unattended body | Allocate and provision a device lease |
| `GET /v1/devices` | Read logical and physical inventory, capacity, and divergence |
| `GET /v1/sessions/:id` | Read active or terminal state |
| `DELETE /v1/sessions/:id` | Retire authority and converge browser cleanup |
| `POST /v1/sessions/:id/commands` | Admit a strict command |
| `GET /v1/sessions/:id/commands/:commandId` | Poll a pending protocol-3 command |
| `POST /v1/device/connect-ticket` | Mint a single-use device ticket |
| `POST /v1/pairing/claim` | Redeem one opaque pairing offer from the extension |
| `POST /mcp` | OAuth or device-bound `usk_v2` MCP transport |

Unattended creation requires a UUID `Idempotency-Key` and a strict body:

```json
{
  "mode": "unattended",
  "deviceId": "00000000-0000-4000-8000-000000000001",
  "allowedOrigins": ["https://portal.example"],
  "profileStateKey": "portal_account_a"
}
```

The API canonicalizes origins and tenant-hashes the profile key. It persists neither raw profile key nor page content in coordinator state.

Known-unsent provisioning failures release the exact fence and return a terminal `closed` handle. A thrown device RPC preserves ambiguity as pollable `closing`. Extension-reported provisioning failure retains a durable release outbox until closure acknowledgement. `DELETE` also preserves that polling handle when close delivery throws after the exact-fenced `closing` state has been committed.

## Authentication hard cut

- Static MCP tokens use `usk_v2`, bind one active browser and the account’s current `auth_epoch`, and are revalidated on every request.
- OAuth consent requires selecting one active browser. Grant metadata and props carry device ID, auth epoch, and contract version.
- OAuth authorization requires an exact 43-character base64url S256 challenge on both consent render and submission. Plain, missing, malformed, or altered requests fail closed.
- Browser revocation immediately invalidates every bound API and OAuth credential.
- Pre-cutover OAuth props, `usk_v1`, cloud-vault routes, `fill_secret`, `browser_fill_secret`, and `browser_list_secrets` are retired.

A normal deployment does not advance authentication epochs. During the
separately confirmed maintenance window, set the optional Worker secret
`AUTH_EPOCH_CUTOVER` to the exact value `protocol-3-auth-hard-cut`. The next
`AccountDirectory` activation advances every existing user once, before it
validates any token or grant; a durable migration marker makes the latch
idempotent. Remove the secret after cutover evidence is recorded.

## Device policy and lifecycle

`users.allowed_origins` is the default for a newly paired browser. `devices.allowed_origins` is authoritative after pairing and carries a monotonic policy version.

- Narrowing terminalizes affected leases before the policy is recorded and pushed.
- Additions remain unavailable until the extension acknowledges the exact version.
- Offline or stale-policy devices remain paired but cannot receive new work.
- Provision frames carry the policy version and a subset origin list.

Configured static devices use the same exact schema validator during deployment and at runtime. A connected or returning static device can atomically advance the coordinator from any lower policy version, including across versions it missed while offline, before the extension receives the update. Directory-backed policy remains contiguous and is advanced by the dashboard transaction before it is pushed.

At 75 seconds without a heartbeat, active leases become `recovering`. At 90 seconds they become `suspended`, stop consuming capacity, and receive a 15-minute adoption deadline. Suspended leases still reserve their profile and origins. Same-epoch exact inventory can reconnect them; an exact physical closure terminalizes them as `closed`; new-epoch adoption bumps the lease fence and reprovisions only if capacity, profile, and policy still permit. The deadline terminalizes `lost` and creates exact orphan cleanup. An exact-fenced `closing` or `expired` lease is instead released at the 90-second device-loss boundary, so an unreachable browser cannot reserve capacity indefinitely.

The extension reports managed assignments and owned windows. A newly registered
device remains unavailable until the hello inventory has passed the same
reconciliation used for heartbeats. `/v1/devices` exposes server usage, both
physical counts, missing IDs, divergence, and comparison time. The backend asks
Chrome to close only exact reported orphan fences.

## Configure secrets and variables

Wrangler requires:

| Secret | Purpose |
|---|---|
| `AUTH_HMAC_SECRET` | Session IDs, hashes, request fingerprints, CSRF/consent signatures, and telemetry pseudonyms |
| `CALLER_TOKENS` | Legacy caller token to actor and tenant |
| `EXTENSION_TOKENS` | Attended extension token map |
| `DEVICE_TOKENS` | Bootstrap device identities still using configured digests |
| `EXTENSION_ID` | Published Chrome extension ID for direct pairing messages |
| `WS_TICKET_SECRET` | Single-use control and session tickets |

There is no vault KV binding, vault master key, or vault upload key.

`UNATTENDED_ENABLED_TENANTS` and `SAFE_WRITE_REQUIRED_TENANTS` accept exact tenant IDs or audited `prefix:` classes; `"*"` enables nothing. `QUOTA_POLICY` contains session, command, tenant, device-ticket, and total-command limits. No credential-fill quota remains.

Copy `.dev.vars.example` to `.dev.vars` for local development. Never commit `.dev.vars`.

## Transport and response policy

The canonical host is `https://understudy.proofof.tech`. Canonical HTTP requests receive `308` before routing. Every canonical HTTPS response—including errors, redirects, dashboard, OAuth, MCP, well-known metadata, and `/v1`—carries HSTS. The current staged value is five minutes; do not add `includeSubDomains; preload` until every `proofof.tech` hostname is valid HTTPS and the apex ramp is complete.

`/health` returns the Worker source tag, active version ID, and deployment timestamp from the `VERSION` metadata binding.

## Telemetry boundary

Telemetry is content-free. Never add page URL, title, content, dialog text, screenshot data, refs, card aliases, card values, credentials, tickets, or complete socket URLs.

## Verify

```bash
pnpm --filter @understudy/backend typecheck
pnpm --filter @understudy/backend test
cd apps/backend
pnpm exec wrangler types --check
pnpm exec wrangler deploy --dry-run --env ""
pnpm exec wrangler deploy --dry-run --env staging
```

The Workers test pool needs permission to bind loopback ports. `worker-configuration.d.ts` is generated by `wrangler types` and is the source of truth for runtime bindings; `src/types.ts` extends it only with bindings that the OAuth provider injects per request and the optional cutover latch.

## Deploy staging

The `dev` deployment workflow updates `understudy-backend-staging` at `https://staging.understudy.proofof.tech`. Staging uses a separate OAuth KV namespace, Durable Object state, telemetry dataset, rate-limit namespace, runtime secrets, and extension ID. It enables only the `prefix:acct-` unattended account class.

Provision the six staging secrets from mode-0600 files outside the repository:

```bash
pnpm --filter @understudy/backend provision:staging -- \
  /absolute/private/staging-auth-hmac.txt \
  /absolute/private/staging-caller-tokens.json \
  /absolute/private/staging-extension-tokens.json \
  /absolute/private/staging-device-tokens.json \
  /absolute/private/staging-extension-id.txt \
  /absolute/private/staging-ws-ticket.txt
```

The three token-map files must contain `{}`. The extension-ID file must contain `ebpcldlibljfjhcfknagjcdmhggeknfc`. Never copy production token maps or signing secrets into staging.

Deploy clean or dirty local code to the shared staging target:

```bash
pnpm --filter @understudy/backend deploy:staging
```

The command records local dirty provenance and writes evidence under `/tmp`. The next `dev` deployment can replace the local deployment.

Before the first `dev` merge, create a GitHub `staging` environment restricted to `dev`, add a staging-scoped `CLOUDFLARE_API_TOKEN`, and run `provision:staging`. Create a separate `production` environment restricted to `master`, add a production-scoped token, and keep `PRODUCTION_AUTODEPLOY_ENABLED=false` until the manual compatibility cutover has passed. Workflow deployment tokens are exposed only to their deployment step.

Every deployment writes an `attempting`, `failed`, or `verified` evidence artifact. Failed post-upload evidence includes `priorDeployment`, the exact deployment state captured before upload. Recover staging with its prior 100% version:

```bash
previous_version="$(jq -r '.priorDeployment.versions[] | select(.percentage == 100) | .version_id' /absolute/path/staging-deployment.json)"
pnpm --filter @understudy/backend exec wrangler rollback "$previous_version" \
  --env staging --message "recover failed staging deployment" --yes
curl --fail --silent --show-error https://staging.understudy.proofof.tech/health | jq
```

Use the same process for production with `--env ""` and the production evidence artifact. Do not roll back merely because an older workflow was rerun: CI rejects any source commit that is no longer the current `origin/dev` or `origin/master` head before upload.

## Deploy production

Routine production deployment runs from the `master` GitHub Actions workflow. It is disabled until the protocol-3 manual cutover completes. GitHub stores only a scoped Cloudflare deployment token; existing Worker secrets remain in Cloudflare.

From a committed clean tree:

```bash
pnpm --filter @understudy/backend deploy:production -- \
  /absolute/path/outside-the-repository/deployment-evidence.json \
  /absolute/path/outside-the-repository/device-tokens.json \
  /absolute/path/outside-the-repository/extension-id.txt \
  /absolute/path/outside-the-repository/canary-device-credential.txt
```

The three credential/configuration inputs must be mode 0600. `device-tokens.json`
must use the protocol-3 static-device shape, including `allowedOrigins` and
`policyVersion` for every digest; the canary credential's digest must be present.
The extension-ID file must contain the published Chrome ID
`lbmbdjjaodgipnleaggclnobbijpadee`. The
script creates a detached worktree at the validated full SHA, verifies the
committed pnpm version, installs the committed lockfile offline and frozen,
builds the local protocol and store extension, verifies the published artifact and production compatibility contract, and performs the dry run and deployment from
that immutable dependency snapshot. It refreshes `origin/master` and requires
the source SHA to remain its current head before preparation, secret upload,
and deployment. It also rechecks the original tree before secret upload and
immediately before deployment. After
confirmation, it uploads the validated `DEVICE_TOKENS` and `EXTENSION_ID` and
deploys with `--strict --tag <full-sha> --message "source <full-sha>"`. Bounded
health requests must return three matching reads before mode-0600 evidence is
written with configuration hashes, the compatibility secret version, source
release, pnpm version, lockfile SHA-256, active Worker version, active
deployment, the pre-mutation deployment and version inventories, each
secret-derived version, and any secret-derived active version separately. The
evidence file exists before the first secret upload and is updated to `failed`
or `verified` by an exit trap.
The device-token upload helper applies Wrangler's trailing-whitespace
normalization before hashing, passes those exact normalized bytes to Wrangler,
and aborts before invoking it if the normalized source changed after preflight.

A production code rollback does not by itself prove that `DEVICE_TOKENS` and
`EXTENSION_ID` returned to their prior values. Retain the previously approved
mode-0600 sources through the cutover. If evidence reports
`secretMutationPossible: true`, compare `priorVersions`,
`deviceTokensSecretVersion`, and `extensionIdSecretVersion`, restore the prior
secret sources when required, and verify health and pairing before resuming.

After the cutover, set `PRODUCTION_AUTODEPLOY_ENABLED=true` in the production GitHub environment. A later compatibility-contract change blocks automatic deployment and requires this wrapper again. Credential revocation, cloud-vault deletion, DNS changes, and HSTS ramp changes remain explicit operator actions. See the [production rollout](../../docs/unattended-production-rollout.md).
