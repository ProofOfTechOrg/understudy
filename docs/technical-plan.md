<!-- Content type: Conceptual -->

# Understand the Understudy protocol-3 architecture

## Release contract

The coordinated hard cut publishes `@understudy/protocol` 0.9.0 with wire
protocol 3, `@understudy/connector` 0.6.0, extension 0.2.0, and backend 0.2.0.
Changesets produce the public package versions; private app versions are set in
their package manifests.

Protocol 3 removes `fill_secret`. The MCP surface removes
`browser_fill_secret` and `browser_list_secrets`; the dashboard and backend
remove cloud-vault routes, bindings, keys, and scripts. Old `usk_v1` tokens and
OAuth grants without a current device, authentication epoch, and contract
version fail closed.

## Trust and ownership

- `AccountDirectory` is authoritative for users, authentication epochs,
  devices, versioned general origin policy, browser-bound `usk_v2` tokens, and
  OAuth connection ownership.
- `TenantDeviceCoordinator` owns device liveness, allocation, lease fences,
  capacity, inventory reconciliation, suspension, adoption, and exact orphan
  cleanup.
- `DeviceAgent` authenticates one device control connection and exchanges
  policy/inventory/provision/cleanup frames.
- `SessionAgent` owns one session connection, browser state, generation-scoped
  refs, command delivery, result correlation, and attended attachment state.
- `AccountAgent` serializes MCP commands per account and binds the OAuth/token
  credential to one active device.
- The extension owns physical windows and the local card vault. The backend
  never receives card fields, encrypted records, keys, or masked card data.

Every MCP request revalidates device revocation and `auth_epoch`; a delayed KV
grant cleanup cannot keep a revoked browser credential alive.

## Pairing and policy

`users.allowed_origins` is only the default for a new device. Empty defaults are
valid, but cannot allocate a session. `devices.allowed_origins`,
`policy_version`, and `policy_updated_at` are authoritative after pairing.

Pairing is a CSRF-protected dashboard POST that creates a single-use offer. The
offer is sent through Chrome external messaging only from the exact canonical
dashboard page. The extension verifies `sender.url`, rejects query/hash
variants, and parses a strict message schema. Only the extension receives the
`udt_v2` credential. Re-pairing a live installation rotates its credential
without changing its authoritative origin policy or releasing its assignments.
A locally detected revocation omits the dead credential. If an offline
installation instead presents a credential revoked since its last connection,
the backend recognizes the revoked same-account row and returns a new device
identity; the extension discards the old local ownership before activating it.
Revoked device rows retain only their non-replayable credential digest and
identity metadata and are kept as durable re-pairing tombstones. The extension
persists a fail-closed discard marker before local cleanup, so a worker restart
cannot report old assignments under the replacement identity. A new browser
profile also creates another device.

Policy narrowing fences affected leases and terminalizes sessions before the
new policy is recorded and pushed. Additions are recorded immediately but are
not allocatable until the extension acknowledges the exact version. Offline or
outdated devices stay paired but unavailable. Provisioning frames carry the
policy version; the extension rejects a mismatch or wider policy.

Static-device configuration uses one exact schema parser in deployment
preflight and Worker authentication. When a connected or returning static
policy advances, `DeviceAgent` atomically moves the coordinator from any lower
version before pushing it to the extension; an offline device need not observe
intermediate secret versions. Directory-backed updates remain contiguous and
coordinator-first through the dashboard transaction.

## OAuth and MCP

OAuth authorization requires a nonempty, exact 43-character base64url S256
challenge before consent rendering and again after signed consent decoding,
before grant completion. Missing method, `plain`, malformed or altered
challenge, wrong verifier, replay, old epoch, revoked device, and legacy props
fail closed.

Consent selects one active device and persists `deviceId`, `authEpoch`, and
contract version in grant metadata and props. The dashboard lists and revokes
provider grants through `listUserGrants` and `revokeGrant`.

ChatGPT and Claude receive the canonical `/mcp` URL and use their documented
connector UI. CLI/JSON clients use a browser-bound `usk_v2` token.

All page-derived text, including URLs, titles, semantic elements, legacy
accessibility nodes, dialogs, errors, and screenshot metadata, is returned as
untrusted data. Every MCP tool has an output schema and structured content;
compact text fallbacks use a random boundary and JSON-quoted page strings.

Protocol 3 advertises `semantic-elements-v1`. The extension owns a bounded,
memory-only normalized cache assembled from per-session DOM capture and
per-frame AX trees. It exposes deterministic capture, find, inspect,
continuation, and identity-aware same-document deltas, not raw DOM, selectors,
XPath, arbitrary attributes, or editable values. A fresh capture or navigation
invalidates refs; find, inspect, continuation, and scrolling preserve them.
Every ref action revalidates frame ownership, action capability, live AX state,
and allowlisted DOM identity. A changed target fails with a fixed reason and is
never automatically retargeted.

## Provisioning and physical windows

Provisioning outcomes stay distinct:

- initialization failure or `requestProvision() === false` performs an
  exact-fence release to `closed`, reconciles `SessionAgent`, and returns the
  terminal handle;
- a thrown device RPC preserves ambiguity as `closing` and returns the polling
  handle with `202`, `Location`, and `Retry-After`;
- a thrown close RPC after `DELETE` leaves the already-durable `closing` handle
  pollable while alarms and inventory reconciliation retry cleanup;
- extension `provision_failed` records release cleanup and a durable closure
  outbox for retry;
- heartbeat absence settles exact-fenced `closing`/`expired`; matching inventory
  preserves a still-live handshake.

Immediately after `browser.windows.create()`, the extension persists an owned
window record containing browser epoch, window/tab IDs, session/lease IDs, and
lease epoch. A fast `storage.session` checkpoint handles service-worker
eviction; a content-free `storage.local` recovery mirror survives a full Chrome
restart. Both writes happen before runtime installation. If Chrome returns the
new window without its tab ID, the persisted record uses a null tab ID and the
extension closes by the known window ID. The record is removed only after
Chrome confirms closure.

On every worker wake, the extension reconciles the owned-window registry,
assignments, closure outbox, and server inventory. It closes registered unowned
windows and exact server-reported orphans, never arbitrary restored tabs. A
complete inventory is sent in `device_hello`; allocation remains disabled until
the backend runs that inventory through heartbeat-equivalent reconciliation.
After a browser-epoch change, old-epoch closure records are acknowledged before
the extension sends the new `device_hello`. Pending closures also suppress an
otherwise empty heartbeat inventory until they are delivered.

## Liveness and adoption

- 75 seconds without heartbeat: device and active assignments become
  `offline`/`recovering`.
- 90 seconds: assignments become `suspended`, capacity is reclaimed, and the
  adoption deadline is set to exactly 15 minutes.
- Exact-fenced `closing` and `expired` leases are released at that same
  90-second boundary instead of consuming capacity indefinitely.
- Suspended assignments remain pollable and continue to reserve profile/origin
  collision keys, but do not consume capacity.
- An exact physical closure arriving during suspension terminalizes `closed`
  immediately and is acknowledged; cleanup does not wait for adoption expiry.
- Same-browser-epoch exact inventory recovers the assignment.
- A new epoch increments the lease fence and reprovisions only if current
  capacity, profile, and origin policy permit it.
- Failed adoption closes the old assignment and terminalizes `lost`.
- The 15-minute alarm terminalizes `lost` and creates exact orphan cleanup.

The canonical control origin is always
`https://understudy.proofof.tech`. No alternate credential-bearing origin is
permitted. Durable retry behavior may change only after the remaining baseline
network-blip matrix identifies the failing layer.

## Attended detach

Each attended attachment has a UUID. A deliberate or debugger-driven detach
sends `attended_detached` with the UUID and tab ID. A matching detach enters
`idle` and clears browser details, tabs, URL, and dialogs. Stale detach frames
are ignored. Socket loss remains `detached`.

## Local payment cards

The IndexedDB/AES-GCM format, validation, threat boundary, fixed outcome
contract, and sensitive-mode suppression rules are normative in
`docs/local-card-vault-security-requirements.md`. Payment handlers are outside
the generic command router. General policy and local exact payment policy must
both permit the top-level origin.
Alias, origin, distinct-ref, and current-generation failures are resolved by a
non-sensitive preflight. Once sensitive mode is entered, every completion path
closes the controlled tab.

## HTTPS and provenance

Every application response, redirect, and error receives HSTS. The initial
release value is a five-minute ramp. Cloudflare zone configuration then advances
the apex through one day, one week, and one year. `includeSubDomains; preload`
is enabled only after every apex/subdomain record has valid HTTPS.

`includeSubDomains` on `understudy.proofof.tech` affects only descendants of
that hostname, not sibling names. HSTS preload submission therefore requires
the registrable apex `proofof.tech` to have DNS, TLS, redirect, and the final
header.

Wrangler `version_metadata` exposes Worker version ID, deployment timestamp,
and source tag at `/health`. `apps/backend/scripts/deploy-production.sh`
validates an operator-supplied protocol-3 static-device map, published extension
ID, and matching canary credential before deployment. The inputs stay outside
Git at mode 0600. The script rejects tracked or untracked dirt, creates a
detached worktree at the validated source SHA, verifies the committed pnpm
version, installs the committed lockfile offline and frozen, builds the local
protocol package, and performs the dry run and deployment from that immutable
dependency snapshot. It records the pnpm version and lockfile digest with the
deployment evidence. It rechecks the original tree before
secret upload and again before deployment. After confirmation, it uploads
`DEVICE_TOKENS` and `EXTENSION_ID`, normalizes trailing whitespace exactly as
Wrangler does, refuses to invoke Wrangler if those upload bytes no longer match
the validated digest, and tags the deployment with the full source SHA. Health
polls use bounded connection and response deadlines. Three consecutive matching
reads are required before the script records compatibility configuration,
source, active deployment, Worker version, and secret-derived versions
separately in mode-0600 evidence.

## Release gate

Run the repository commands in `README.md`, the real-Chrome scenarios in
`apps/extension/RUNBOOK.md`, and the three independent clean-code,
architecture, and QA reviews. Production deployment, auth-epoch cut, cloud
vault deletion, DNS/HSTS changes, outage injection, and store upload require
operator confirmation at the mutation boundary.
