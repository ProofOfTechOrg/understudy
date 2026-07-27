<!-- Content type: Conceptual -->

# How Understudy runs attended and unattended browser sessions

Understudy routes governed browser commands to a user-controlled Chromium profile. The Cloudflare service coordinates sessions, devices, leases, and command outcomes. The installed Manifest V3 extension owns every browser tab and Chrome DevTools Protocol (CDP) attachment. Understudy runs no model, approval workflow, role-based access control, or durable audit sink.

## Current architecture

The current design supports two session modes:

- **Attended**: a person attaches one existing tab. Closing the session detaches CDP but never closes that tab
- **Unattended**: an enrolled, tenant-dedicated profile creates an extension-owned `about:blank` tab in an unfocused window

An enrolled device may control at most two tabs. Capacity counts extension-controlled leased tabs, not every Chrome tab. The two unattended sessions share the profile’s cookies, local storage, IndexedDB, and other browser state.

```text
Consumer application
  Mastra agent + breakwater + flowsafe
             |
             | HTTPS command API
             v
Cloudflare Worker
  Hono API
  TenantDeviceCoordinator per tenant
  DeviceAgent per enrolled profile
  SessionAgent per browser session
             |
             | authenticated WebSockets
             v
Tenant-dedicated Chromium profile
  ProfileClient
  SessionManager
  SessionRuntime per extension-owned tab
  CdpSession per controlled tab
```

The consumer remains authoritative for approvals, role-based access control (RBAC), policies, and durable audit records. Understudy emits content-free operational telemetry only.

## Cloudflare responsibilities

Three Durable Object classes divide authority:

- **`SessionAgent`**: owns one session data socket, command journal, durable results, deadlines, dialog deduplication, and vault resolution
- **`DeviceAgent`**: owns one authoritative device-control socket and sends provision, close, and session-ticket frames
- **`TenantDeviceCoordinator`**: serializes allocation, lifecycle transitions, exact quotas, create idempotency, and lease expiry for one tenant

`SessionAgent` uses Agents SDK schedules for command deadlines. `TenantDeviceCoordinator` uses one raw Durable Object alarm for its earliest lease or liveness deadline. Code persists local state before cross-object remote procedure calls and never holds a SQLite transaction across one.

The Worker exposes:

| Endpoint | Purpose |
|---|---|
| `POST /v1/sessions` | Create an attended or unattended session |
| `GET /v1/sessions/:id` | Read active status or a terminal `410` tombstone |
| `DELETE /v1/sessions/:id` | Start or confirm session cleanup |
| `POST /v1/sessions/:id/commands` | Admit one bounded, strict command request |
| `GET /v1/sessions/:id/commands/:commandId` | Poll a durable command outcome |
| `GET /v1/devices` | List tenant-visible device health and capacity |
| `POST /v1/device/connect-ticket` | Mint a 60-second, single-use control-socket ticket |

No-body `POST /v1/sessions` keeps the original attended contract and returns `200`.

## Unattended session creation

An unattended request has this shape:

```typescript
type UnattendedSessionRequest = {
  mode: "unattended";
  deviceId?: string;
  allowedOrigins: string[];
  profileStateKey: string;
};
```

The request requires a UUID `Idempotency-Key`. The service canonicalizes exact origins with `URL.origin`, deduplicates them, and sorts them. Production origins require HTTPS. HTTP is accepted only for loopback development origins.

The service rejects wildcards, credentials, paths, queries, fragments, unknown fields, duplicate meanings under one idempotency key, and caller-controlled time-to-live values. It hashes `profileStateKey` with an HMAC key and tenant domain separation. Neither status nor telemetry exposes the raw value or hash.

Creation waits up to 5s for provisioning:

| Status | Meaning |
|---|---|
| `201` | The first request created and connected the session |
| `202` | Provisioning continues; poll the URL in `Location` after `Retry-After` |
| `200` | An idempotent replay found the connected session |
| `429` | Compatible device capacity is exhausted |
| `409` | The request conflicts with an origin, profile key, or prior idempotency fingerprint |
| `404` | An explicit device does not exist in the tenant |
| `503` | No compatible online device is available |

An explicit `deviceId` never falls back to another device. Automatic selection sorts by used capacity, oldest assignment time, then lexical device ID.

Two leases can share a device only when their exact origin sets are disjoint and their profile-state hashes differ. Both origin sets must fit the device’s local policy.

## Lease lifecycle and expiry

An unattended session moves through `allocating`, `provisioning`, `connected`, `recovering`, `closing`, and a terminal state. Terminal states are `closed`, `expired`, and `lost`.

Each lease has:

- A hard expiry exactly 24 hours after creation
- A rolling idle expiry 2 hours after the last admitted valid command, capped by hard expiry
- A 30s provisioning reconciliation deadline
- A 90s total liveness and recovery grace

Devices send heartbeats every 22s. The coordinator considers a device offline after 75s without a valid heartbeat. Offline time still counts toward both session expiries.

DELETE and expiry persist `closing` before any remote call. New commands then return `410`. Capacity remains reserved until the extension acknowledges a fenced close or the device-loss deadline releases it. A late provision or recovery acknowledgement receives a close instruction.

## Command safety contract

Protocol 2 implements at-most-once write execution with explicit pending and unknown outcomes. It does not claim exactly-once external outcomes: Chromium can die after an external side effect but before result persistence.

Only one distinct command owns a session’s admission slot. Another distinct command receives `429 session_busy`. A duplicate command ID must carry the same keyed request fingerprint, including `dryRun`, or receives `409 command_id_conflict`.

A write follows this durable sequence:

```text
HTTP admission
  -> persist preparing
  -> send metadata-only write_prepare
  -> extension persists prepared
  -> receive write_ready
  -> persist granted
  -> send write_grant with the command
  -> extension persists started
  -> execute one CDP operation
  -> extension persists completed_unacked
  -> backend persists the result
  -> send result_ack
```

The extension-ready deadline is 5s. Granted work has a 25s aggregate deadline. The synchronous HTTP wait is 20s, so work that remains valid can return `202` with `retryPolicy: "poll_same_command"`.

| Status | Outcome |
|---|---|
| `200` | Durable terminal event |
| `202` | Granted or pending; poll the same command |
| `409 command_outcome_unknown` | A side effect may have occurred; do not retry |
| `409 command_id_conflict` | The ID fingerprint changed |
| `504 command_not_started` | The backend won before grant; retrying the same logical command is safe |
| `504 command_timed_out` | A read timed out and is safe to retry |
| `429 session_busy` | Another distinct command owns the slot |
| `410` | The lease is terminal |
| `426` | The extension lacks safe-write protocol capability |
| `503` | The session connection is unavailable |

Once granted, the backend never resends a write payload after reconnect. A same-epoch extension restart replays `completed_unacked` results, cancels ungranted preparations, and marks started writes without results unknown. An unknown write blocks further writes for that session.

`fill_secret` fingerprints `secretRef` but resolves plaintext only after `write_ready`. Plaintext exists only in the in-memory grant frame and never enters SQLite, Agent state, schedules, extension storage, results, or telemetry.

## Extension ownership and restart behavior

`ProfileClient` owns enrollment and the device socket. `SessionManager` indexes runtimes by session ID, lease ID, and tab ID. Each `SessionRuntime` owns one `CdpSession`, one session socket, one command queue, one write journal, and one dialog outbox.

Commands in one runtime execute first-in, first-out and single-flight. Two runtimes may execute concurrently. Every CDP event routes by tab ID and rechecks the lease, browser epoch, and runtime identity after asynchronous operations.

The extension never attaches, reports, activates through the command API, or closes an arbitrary profile tab. `get_tabs`, `hello`, and `switch_tab` expose only the session-owned tab.

Execution metadata uses `chrome.storage.session`. It survives service-worker eviction and clears on a browser or extension restart. A changed browser epoch:

1. Demotes prior-epoch authority
2. Marks incomplete granted writes unknown
3. Creates fresh `about:blank` tabs for live leases within the recovery grace
4. Rotates tab attachments and ref generations
5. Never restores a prior URL
6. Blocks new writes until the caller deletes the session

Restored Chrome tabs remain uncontrolled and are never closed automatically.

## Origin and popup containment

`allowedOrigins` constrains top-level navigation. The extension prechecks explicit navigation and uses CDP Fetch interception for main-frame requests, redirects, and JavaScript navigation. It permits the initial internal `about:blank`.

Cross-origin subresources and iframes remain functional. This control is not an egress firewall.

The extension auto-attaches and pauses targets related to a controlled tab, then closes popups before their first request executes. `tabs.onCreated` provides defense in depth. Unattended rollout remains blocked until the production Chromium acceptance run proves paused-popup containment.

## Authentication and privacy

Long-lived device credentials appear only in HTTPS `Authorization` headers. The service stores their SHA-256 digests in the `DEVICE_TOKENS` secret mapping. WebSocket URLs carry 60-second, single-use signed tickets instead.

Tickets bind audience, tenant, device, session or lease where applicable, browser epoch, lease epoch, Durable Object name, expiry, and a random JTI. The Worker verifies the signature and path before routing. The target object atomically consumes the JTI and validates current authority. Ticket replay cannot replace an authoritative connection.

The extension stores only enrollment configuration in `chrome.storage.local`: service origin, enabled state, device ID, raw device credential, and local origin policy. Storage access is restricted to trusted extension contexts. Panel state and logs never include the credential.

Telemetry uses domain-separated HMAC pseudonyms. It never emits raw tenant, device, or session IDs; URLs; titles; browser content; refs; secret references; tokens; tickets; or WebSocket URLs.

## Dialog delivery

Dialogs have a browser-epoch-scoped delivery guarantee. The extension persists each dialog before answering it, sends the record, and removes it only after `dialog_ack`. The server deduplicates by `dialogId`.

The outbox accepts at most 256 records and 256 KiB. Persistence or capacity failure does not leave the page blocked: the extension answers the dialog, marks delivery `overflow`, and emits content-free health. A browser epoch change marks delivery `interrupted`.

Status returns the newest 50 dialog payloads. Compact seen-ID tombstones remain for the session lifetime.

## Quotas and telemetry

SQLite counters enforce:

| Scope | Limit |
|---|---|
| Session creation per actor | 10/min |
| Commands per session | 120/min |
| Commands per tenant | 600/min |
| Credential fills per actor | 30/min |
| Device tickets per device | 30/min |
| Commands per session lifetime | 10,000 |

`QUOTA_POLICY` may override validated non-secret defaults. A Workers Rate Limiting binding allows 300 requests/min per credential pseudonym as an approximate abuse backstop. SQLite remains authoritative.

Analytics Engine receives content-free events for authentication, allocation, lifecycle, command safety, dialogs, and quota decisions.

## Rollout gates

Production configuration starts with `UNATTENDED_ENABLED_TENANTS=[]`. Deploy the additive Durable Object migration and dual-protocol backend before enabling any tenant.

Rollout order:

1. Build and load the production extension in a tenant-dedicated profile
2. Enroll one canary device and confirm protocol 2
3. Enable one tenant
4. Complete the real-Chromium acceptance suite
5. Run a 24-hour read-only soak
6. Enable remaining tenants after zero unexpected unknown writes and correct expiry behavior

Rollback disables new leases first, drains or terminalizes active leases and granted commands, then rolls back application code. Never remove the additive migration or deploy protocol-1-only code while protocol-2 leases exist.

## Historical attended proof

The original attended design and proof remain historical evidence in Git at `master@797d0e489df2772d0f5d597141982547861881bb`. On 2026-07-25 UTC, Metamind `master@0814deb` used Understudy to observe a public page, cross a flowsafe approval boundary, fill a vaulted credential, and observe the authenticated page. The proof created no email or Gmail draft.

Attended mode remains supported. Its operator procedure is documented in the extension runbook.

## Verification

Run:

```bash
pnpm --filter @understudy/protocol test
pnpm --filter @understudy/backend test
pnpm --filter @understudy/extension test
pnpm --filter @understudy/connector test
pnpm test
pnpm typecheck
pnpm build
pnpm --filter @understudy/backend exec wrangler deploy --dry-run \
  --outdir /tmp/understudy-unattended-worker
```

The production Chromium acceptance remains an operator gate because it requires a real tenant profile, website login, Multi-Factor Authentication (MFA), extension permission approval, and deliberate browser restart.

## Deliberate exclusions

This release does not include:

- Cloudflare Browser Rendering or another server-managed browser
- A local daemon
- Video, GIF, Document Object Model history, or session recording
- Automatic restoration of URLs or tasks
- Automatic attachment to existing tabs
- More than two controlled tabs per device
- Cross-tenant use of one profile
- Cookie or storage isolation between tabs in one profile
- Consumer scheduling, model execution, approval, RBAC, or durable audit
- Upload or download automation
- Iframe-specific control

The profile is tenant-bound, not session-isolated. Consumers that require browser-state isolation must use separate Chrome profiles or devices.
