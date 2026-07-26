<!-- Content type: Reference -->

# Operate the Understudy backend

The backend is a Cloudflare Worker with Hono, Agents SDK Durable Objects, a raw SQLite coordinator, KV vault storage, Analytics Engine telemetry, and a rate-limit backstop. It coordinates attended and unattended sessions but never runs the browser.

## Understand the object topology

The Worker binds three Durable Object classes:

| Binding | Class | Authority |
|---|---|---|
| `SESSION` | `SessionAgent` | Session WebSocket, command journal, schedules, results, dialogs, and vault resolution |
| `DEVICE` | `DeviceAgent` | One authoritative control WebSocket per enrolled profile |
| `TENANT_CONTROL` | `TenantDeviceCoordinator` | Tenant devices, allocations, leases, exact quotas, idempotency, and alarms |

Migration `v1` created `SessionAgent`. Additive migration `v2` creates `DeviceAgent` and `TenantDeviceCoordinator`. Do not remove either migration during rollback.

## Use the HTTP API

All `/v1` caller endpoints require `Authorization: Bearer <caller_token>`. The service returns `404` for malformed, unknown, or cross-tenant session IDs.

| Endpoint | Result |
|---|---|
| `POST /v1/sessions` with no body | Create an attended session |
| `POST /v1/sessions` with an unattended body | Allocate and provision a device lease |
| `GET /v1/devices` | Read device status and capacity |
| `GET /v1/sessions/:id` | Read active or terminal session status |
| `DELETE /v1/sessions/:id` | Retire attended authority or request unattended cleanup |
| `POST /v1/sessions/:id/commands` | Admit a strict command request |
| `GET /v1/sessions/:id/commands/:commandId` | Poll a protocol-2 command |
| `POST /v1/device/connect-ticket` | Mint a device control ticket |

Unattended creation requires a UUID `Idempotency-Key` and this body:

```json
{
  "mode": "unattended",
  "allowedOrigins": ["https://portal.example"],
  "profileStateKey": "portal_account_a"
}
```

The API canonicalizes origins and hashes the profile key with tenant domain separation. It persists neither raw value in coordinator state.

Command requests are limited to 128 KiB and parsed against `CommandRequestSchema`. Unknown fields and malformed `dryRun` values return `400` before WebSocket traffic or durable command mutation.

Protocol-2 connectors send `Understudy-Command-Contract: 2`. They can receive `202` and poll the returned status URL. Legacy connectors never receive `202`.

Attended deletion persists terminal authority immediately, cancels active attempts, closes the extension socket with code `4003`, and returns `204`. Repeated attended deletion also returns `204`. Later commands return `410`, and reconnecting extensions receive code `4003`.

Unattended deletion remains acknowledgement-driven. It returns `202` while the extension still owns the tab or the matching closure frame is pending, then returns `204` after cleanup confirmation.

## Configure secrets

Wrangler requires six secrets:

| Secret | Format | Purpose |
|---|---|---|
| `AUTH_HMAC_SECRET` | Random HMAC key | Session IDs, profile hashes, request fingerprints, and telemetry pseudonyms |
| `CALLER_TOKENS` | JSON object | Caller token to actor and tenant |
| `EXTENSION_TOKENS` | JSON object | Legacy attended extension token to tenant |
| `DEVICE_TOKENS` | JSON object | SHA-256 device credential digest to tenant-bound device identity |
| `WS_TICKET_SECRET` | Independent random HMAC key | 60-second single-use WebSocket tickets |
| `VAULT_MASTER_KEY` | Base64url 32-byte key | AES-256-GCM vault envelope encryption |

`CALLER_TOKENS` uses:

```json
{
  "caller_token_here": {
    "actor": "consumer_worker",
    "tenantId": "tenant_a"
  }
}
```

`DEVICE_TOKENS` uses:

```json
{
  "sha256_device_credential_here": {
    "tenantId": "tenant_a",
    "deviceId": "00000000-0000-4000-8000-000000000001",
    "credentialVersion": 1
  }
}
```

The raw device credential appears only in HTTPS authorization headers and the trusted extension’s local storage. Rotate a device by adding a higher `credentialVersion` entry and removing the old digest. A heartbeat detects revocation and fences the old socket.

Copy `.dev.vars.example` to `.dev.vars` for local development. Never commit `.dev.vars`.

## Configure rollout and quotas

Non-secret Wrangler variables include:

| Variable | Default | Purpose |
|---|---|---|
| `UNATTENDED_ENABLED_TENANTS` | `[]` | Tenant allowlist for new unattended leases |
| `SAFE_WRITE_REQUIRED_TENANTS` | `[]` | Tenant allowlist that rejects protocol-1 writes |
| `QUOTA_POLICY` | Built-in JSON | Exact SQLite quota configuration |

Use `["*"]` only after the protocol-2 extension rollout completes. Keep unattended creation disabled during the initial backend deployment.

The default exact quotas are:

- 10 session creates/min per actor
- 120 commands/min per session
- 600 commands/min per tenant
- 30 credential fills/min per actor
- 30 device tickets/min per device
- 10,000 admitted commands per session

The `RATE_LIMITER` binding allows 300 requests/min per credential pseudonym. It is an abuse backstop, not the authoritative quota mechanism.

## Protect WebSocket authority

Long-lived device credentials never enter WebSocket URLs. A device authenticates over HTTPS, receives a signed ticket, and uses it once on the control socket.

The Worker verifies ticket signature, audience, expiry, and path-bound object name before object routing. The target object consumes the JTI hash atomically and validates current tenant, device, lease, and epoch authority.

Attended protocol-1 sockets retain their legacy `EXTENSION_TOKENS` query flow for compatibility. Unattended sockets require tickets.

## Store vault values

KV stores only `v1.<iv>.<ciphertext>` envelopes. Seed a tenant-scoped key through the encryption script:

```bash
printf '%s' 'secret_value_here' |
  VAULT_MASTER_KEY=base64url_key_here \
  node apps/backend/scripts/vault-put.mjs \
  'vault://tenant_a/portal/password'
```

`fill_secret` rejects a ref outside the session tenant before a KV read. Plaintext exists only after write readiness and only in the in-memory grant frame.

## Emit telemetry

`src/telemetry.ts` writes content-free dimensions to Analytics Engine and structured logs. HMAC pseudonyms replace tenant, actor, device, and session identifiers.

Never add URL, title, page content, dialog content, text, keys, refs, secret references, credentials, tickets, or full WebSocket URLs to telemetry.

## Develop and verify

Run from the repository root:

```bash
pnpm --filter @understudy/backend typecheck
pnpm --filter @understudy/backend test
pnpm --filter @understudy/backend exec wrangler deploy --dry-run \
  --outdir /tmp/understudy-unattended-worker
```

The Miniflare test suite needs permission to bind a loopback port.

## Deploy safely

Deploy the dual-protocol backend with unattended creation disabled:

```bash
pnpm --filter @understudy/backend exec wrangler deploy
```

After one canary extension reports protocol 2, enable only its tenant. Complete the production Chromium acceptance suite and 24-hour soak before broad enablement.

A rollback must:

1. Disable new unattended leases
2. Drain or terminalize active leases and granted commands
3. Roll back application code
4. Retain the additive Durable Object migrations

Do not deploy protocol-1-only code while protocol-2 leases exist.
