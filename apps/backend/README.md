# Backend (M3)

## Overview

Consumer apps (metamind, smart-compliance) drive a user's real, logged-in browser by
POSTing protocol Commands to this service and getting back the correlated Event. The
service holds no LLM and imports no agent framework (Topology 1) — the agent brain,
tool loop, and governance (breakwater/flowsafe) live in the consumer, not here. This
service's only job is: terminate the M2 extension's WebSocket, hold the live CDP
session per browser session, correlate each Command to its Event, enforce caller
auth + tenant isolation, and resolve `fill_secret` against a vault without ever
exposing plaintext outside this Worker.

## Architecture

A Hono HTTP front door and one Agents-SDK Durable Object per session (`SessionAgent`)
share the Worker's `fetch` handler: `routeAgentRequest` claims the
`/agents/session/:sessionId` WebSocket path (the M2 extension's connection target;
`session` is kebab-cased from the `SESSION` binding name in `wrangler.jsonc`, not
from the `SessionAgent` class name); the Hono app claims everything else, including
`/v1/sessions*` and `/health`.

Command flow: `POST /v1/sessions/:sessionId/commands` → `authenticate` (bearer
caller token → `{actor, tenantId}`, 401 on failure) → `scopeSession` (verifies the
sessionId's embedded tenant matches the caller's, 404 on mismatch) → `safeParseCommand`
(400 on an unparseable body or schema failure) → `stub.dispatch()` or, for `fill_secret`, `stub.fillSecret()`
→ the correlated Event is returned as JSON. This order is load-bearing: an
unauthenticated or cross-tenant request never reaches parsing or dispatch.

Expected dispatch failures cross the DO RPC boundary as a typed
`DispatchOutcome` (`src/types.ts`), never as a rejected RPC promise — workerd
logs every server-side RPC rejection as an uncaught exception even when the
caller handles it, and a typed reason beats message-prefix parsing at the
route (internally the coordinator still rejects with the `src/coordinator.ts`
prefix constants; `SessionAgent.dispatchFailure` maps them in-isolate). The
route maps reasons to statuses:
**503** `{error: "extension not connected"}` when the session has no live,
onConnect-authorized extension socket — the gate consults that delivery
predicate directly (not the persisted `status` scalar), fails fast instead of
burning the 30s timeout, and answers non-2xx deliberately: a 200 `ok:false`
Event would be cached by a consumer's idempotency store and replayed after
reconnect; **503** `{error: "session resynced mid-command"}` when a fresh
`hello` abandoned the in-flight command (the extension reconnected — same
retryable family, its own honest reason); **504** `{error: "command timed
out"}` when a connected extension never answered; **409** `{error: "command
already in flight"}` for a concurrent duplicate of a still-pending write
commandId; anything else is a genuine bug and remains a uniform JSON **500**
via `app.onError`. A real `fill_secret` checks the liveness predicate
*before* touching the vault, so no plaintext is ever resolved for a command
that cannot dispatch. Exception: a ref-less dryRun write (e.g. navigate)
still short-circuits to simulated `ok:true` without touching the wire — it
was never a liveness signal.

Completed **writes** are additionally recorded per commandId
(`SessionState.completedWrites`, capped at 100): a retry under the same
commandId — the connector derives it from the breakwater idempotency key —
replays the recorded Event instead of executing twice, closing the
write-performed-but-response-lost retry gap. Reads never replay.

Inside the DO, `SessionAgent` holds a `CfSessionCoordinator` (the Cloudflare
implementation of the portable `SessionCoordinator` interface). `send(cmd)` writes
the command to the extension WebSocket, parks a `{resolve, reject, timer}` in an
in-memory `Map` keyed by `commandId`, and persists the commandId into
`SessionState.awaitingCommandIds`. `onMessage` parses every inbound frame as a
protocol Event and routes `*_result`/`pong` to `coordinator.resolvePending`, which
matches by `commandId`, resolves the parked promise, clears the timer, and drops the
id from the awaiting-marker set.

`SessionCoordinator` (`coordinator.ts`) is a Cloudflare-import-free interface;
`CfSessionCoordinator` (`coordinator-cf.ts`) is the only file that couples it to
Cloudflare, via a constructor-injected `CoordinatorHost` rather than a direct import
of `session.ts` (which would be circular) or the `agents` package. A raw-DO or
Node self-host swap only needs a new implementation of this one interface — the
command API (`index.ts`, `session.ts`) is unaffected.

## WebSocket security model

The first gate is at the **Worker edge**: `routeAgentRequest`'s
`onBeforeConnect`/`onBeforeRequest` hooks (`index.ts::gateAgentRequest`)
verify the extension token and tenant scope before the Durable Object ever
accepts the socket (or serves the SDK's HTTP surface). A bad token is a
plain 401 and a cross-tenant sessionId a 404 (no existence oracle, matching
the /v1 discipline) — the socket never enters the DO's connection set at
all.

The in-DO gate remains as defense in depth for any path that reaches the DO
without that router: `onConnect` runs the same async checks
(`verifyExtensionToken` + `scopeSession`) before marking a connection
`connection.setState({ authorized: true })`, closing with 1008 otherwise.
The Agents SDK accepts a socket — and admits it to the connection set
`getConnections()` returns — before that async check resolves, so an
unauthenticated or wrong-tenant socket could sit in the connection set
during that window. Four things close this gap:

- `sendToExtension` (the coordinator's outbound path) iterates
  `getConnections()` but filters to `isAuthorizedConnection`, so a command is
  never written to a socket still pending auth.
- `onMessage` returns immediately for any connection that isn't yet authorized,
  so an unauthenticated socket cannot inject events.
- `shouldSendProtocolMessages` returns `false` unconditionally, suppressing the
  SDK's own connect-time protocol frames — the extension speaks only the
  `@understudy/protocol` wire shape and already discards anything else, so this
  costs nothing for a legitimate connection.
- `validateStateChange` rejects any state write whose `source` isn't `"server"` —
  the SDK's generic client→server `cf_agent_state` sync path reaches this hook for
  any accepted connection, including one still awaiting auth, and this DO's state
  is server-driven only.

## Design decisions

- **Per-session DO, not per-user**: a user can have multiple concurrent
  cases/sessions; a per-user DO would conflate them and cross tenant boundaries.
  Keying by `sessionId` gives per-tenant/per-case isolation, with the tenant
  recoverable from the id itself.
- **404 for cross-tenant sessions, never 403**: a 403 would confirm the session
  exists for someone who doesn't own it — an existence oracle. Every
  `scopeSession` failure path (bad shape, bad HMAC signature, wrong tenant, decode
  error) collapses to the same `"not-found"` the route turns into 404, so no
  response shape distinguishes "malformed id" from "someone else's session."
- **sessionIds are minted, not looked up**: `mintSessionId` HMAC-signs a payload
  containing the tenant; `scopeSession` verifies the signature and payload rather
  than querying a table. This makes tenant-ownership verification stateless.
- **`fill_secret` resolves service-side, DO-scoped**: the agent (consumer-side)
  only ever sees an opaque `secretRef`. `secrets.ts::resolveSecret` performs vault
  lookup only — it imports neither `session.ts` nor the coordinator, so it cannot
  itself dispatch anything. The actual resolve-then-type happens entirely inside
  `SessionAgent.fillSecret`: the plaintext is fetched, immediately handed to
  `coordinator.send({type: "type", ...})` (whose logging is metadata-only —
  `{commandId, type}`, never the command body), and never written to `setState`,
  never included in the Event response, and never appears in an error string. It
  exists only transiently inside this one Durable Object, for the duration of the
  one service→extension WS hop.
- **`dryRun` is a service-API parameter (`{command, dryRun?}`), not a `Command`
  union field**: adding it to every Command variant would churn the shared,
  published protocol for a cross-cutting concern. On a dryRun WRITE command,
  `dispatch` never dispatches the *mutating* command — instead it sends a
  read-only `resolve_ref` probe (also via `coordinator.send`), which the
  extension answers from its live ref map, returning a simulated
  `action_result` (`simulated: true`) either way. The probe must NOT be a
  `snapshot`: the extension re-mints every ref per snapshot (generation bump),
  so a snapshot probe can never contain the consumer's ref — dryRun would
  always refuse — and it invalidates every outstanding ref, breaking the
  approved command that follows the simulation (the original M3 dry-run bug,
  caught by the attended e2e). `fillSecret` does the same ref-only check on
  dryRun and never calls `resolveSecret` or dispatches a `type` command. This
  is fail-safe by construction: a governance simulation (called *before* an
  approval grant exists) can never actually mutate the page or resolve a
  secret. A dry-run `ok` guarantees *resolvability* (the ref maps to a live
  node in the current generation) — not *executability* of the eventual
  dispatch (e.g. box-model availability), which only the real command proves.
- **The vault binding (`Env.VAULT`) is a KV namespace holding only AES-256-GCM
  envelopes, not CF Secrets/Secrets Store**: `fill_secret`'s `secretRef` is
  chosen per-call at runtime, and CF's Secrets/Secrets Store bindings are
  static — one binding per fixed secret name — which cannot address an
  arbitrary runtime-chosen key. KV's `get(key)` can. Because raw KV values are
  readable back at rest, every value is envelope-encrypted (`src/vault.ts`,
  format `v1.<iv>.<ct>`, fresh IV per value) under `VAULT_MASTER_KEY` — a
  Worker secret that never touches KV or wrangler.jsonc — and decrypted only
  inside the DO via `createVault(env)`. Seed values with
  `scripts/vault-put.mjs` (same envelope, plain Node), never a raw
  `wrangler kv key put`; a legacy plaintext value fails closed at read time
  ("not a recognized envelope"). A per-tenant external KMS remains a possible
  future swap behind the same `VaultBinding.get` seam (`types.ts`).
- **Hibernation cannot lose an in-flight command; only shutdown/restart can**:
  verified against the Cloudflare Durable Objects docs (2026-07-14) — hibernation
  requires no pending timer, no in-progress awaited fetch, no active WS use, and no
  request still being processed, all simultaneously, plus ~10s of subsequent
  idle. A `send()` awaiting its Event violates two of those (a pending timer, a
  request being processed) by itself, so the DO cannot hibernate mid-command; that
  half of the awaiting-marker's job is a platform guarantee, not an assumption.
  What *can* interrupt a command is shutdown/restart (deploys, runtime updates,
  host rebalancing — non-deterministic, ~1-2x/day per the Agents SDK docs), which
  kills the WS outright regardless of hibernation preconditions. The per-command
  timeout is the caller-side bound for that case. The persisted
  `awaitingCommandIds` marker's real job is reconciling an orphaned/late
  `*_result` that arrives for an already-settled (resolved or timed-out)
  commandId after the DO goes idle and wakes again — it's dropped, not
  mis-resolved against unrelated bookkeeping.
- **A fresh `hello` abandons in-flight commands rather than waiting for them**:
  a `hello` means the extension side just resynced (reconnect, SW restart), so
  whatever it had in flight is known-gone; `abandonInFlight` rejects every pending
  command and clears the marker set immediately instead of waiting out their
  timeouts.
- **understudy builds no audit sink**: it may emit a structured non-secret log
  `{ref, secretRef, ok}` for `fill_secret`, but the durable audit trail is
  flowsafe's, consumer-side. This keeps the service framework-light and avoids a
  second, redundant audit system.

## Invariants

- Every *successfully dispatched* `Command` produces exactly one `Event`
  bearing its `commandId`, and the command route returns exactly that Event;
  a command that cannot dispatch or never resolves maps to a non-2xx JSON
  error instead (503/504/409/500 — see the failure mapping above).
- A **write** commandId executes at most once within a session's last 100
  writes: a repeat of a completed write replays its recorded Event
  (`completedWrites`, cap 100), a repeat of a still-pending write is refused
  409, and the extension keeps a matching 100-entry replay + in-flight record
  for the case where the service times out while the extension is still
  executing (a duplicate is dropped, not re-run). A retry delayed beyond 100
  intervening writes degrades to re-execution. Reads never replay.
- `fill_secret` plaintext never enters `setState`, logs, the Event response, or an
  error string; the coordinator logs only `{commandId, type}`. A replayed
  `fill_secret` touches neither the vault nor the wire.
- The vault at rest holds only `v1.<iv>.<ct>` AES-256-GCM envelopes; a value
  that does not decrypt under `VAULT_MASTER_KEY` is refused, never served.
- One Durable Object per `sessionId`; a sessionId whose embedded tenant disagrees
  with the authenticated caller is refused with 404, never 403 — on the /v1
  API and on the agent WS/HTTP path alike.
- A mid-command DO hibernation cannot happen (see above); an interrupting
  shutdown/restart is bounded by the per-command timeout, and the persisted
  awaiting-marker reconciles any orphaned late result rather than mis-resolving it.
- The service runs no LLM and imports no agent framework.
- `SessionCoordinator` is the only Cloudflare-coupling seam; `coordinator.ts`
  itself imports nothing Cloudflare-specific.
- `dryRun` never dispatches a mutating command and never resolves a secret; it
  always returns a simulated `action_result` from a read-only ref check.
- An unauthorized WS upgrade is refused at the Worker edge (401/404) before
  the DO accepts it; any socket that still reaches the DO unauthorized can
  neither receive a command, have its inbound messages processed, nor change
  the session's status by closing (see WebSocket security model).
- Expected delivery failures never cross the DO RPC boundary as rejections
  (no workerd "Uncaught (in promise)" noise); only genuine bugs throw.

## Deploy

First deployed 2026-07-17 to `https://understudy-backend.gcharang.workers.dev`
(account `056cbaa6f5c3d8ff5584f1aa84bbe050`). The account id is deliberately
NOT pinned in `wrangler.jsonc` (public repo, two local accounts): pass it per
command. Runbook, from `apps/backend`:

```sh
export CLOUDFLARE_ACCOUNT_ID=056cbaa6f5c3d8ff5584f1aa84bbe050

# One-time: the ciphertext store (id goes into wrangler.jsonc kv_namespaces)
pnpm exec wrangler kv namespace create VAULT

# Secrets - all four are required; `wrangler deploy` refuses to ship without
# them (wrangler.jsonc `secrets.required`). Mint strong values:
openssl rand -hex 32 | pnpm exec wrangler secret put AUTH_HMAC_SECRET
printf '%s' '{"<caller-token>":{"actor":"<who>","tenantId":"<tenant>"}}' | pnpm exec wrangler secret put CALLER_TOKENS
printf '%s' '{"<extension-token>":"<tenant>"}' | pnpm exec wrangler secret put EXTENSION_TOKENS
openssl rand 32 | basenc --base64url | tr -d '=' | pnpm exec wrangler secret put VAULT_MASTER_KEY

pnpm exec wrangler deploy
curl -s https://understudy-backend.gcharang.workers.dev/health   # {"ok":true}

# Seed a vault secret (encrypts locally; KV never sees plaintext):
printf '%s' 'the-secret' | VAULT_MASTER_KEY=<key> node scripts/vault-put.mjs 'vault://tenant/ref'
```

The extension connects to
`wss://understudy-backend.gcharang.workers.dev/agents/session/<sessionId>?token=<extension-token>`.

### Secrets

All four are **required** — `wrangler deploy` refuses to ship without them
(`wrangler.jsonc` `secrets.required`, which is also the `.dev.vars` allowlist
for local dev). Cloudflare stores them encrypted and **never shows a value
again** after `wrangler secret put`, so the deployed worker is the canonical
copy and the only readable backup is the operator-local, gitignored
`apps/backend/.secrets.production.env` (created out of band, never committed —
`.secrets*` in the root `.gitignore`). Lose that file and a secret can only be
*rotated*, not recovered.

| secret | what it is | regenerate | rotation impact |
|---|---|---|---|
| `AUTH_HMAC_SECRET` | HMAC-SHA256 key signing minted sessionIds (stateless tenant scoping) | `openssl rand -hex 32` | invalidates every outstanding sessionId — consumers must re-mint |
| `CALLER_TOKENS` | JSON map `bearer token → {actor, tenantId}`; a consumer sends the raw token as `Authorization: Bearer …` | token: `printf 'uk_caller_%s\n' "$(openssl rand -hex 24)"` | the affected consumer swaps its `UNDERSTUDY_TOKEN` |
| `EXTENSION_TOKENS` | JSON map `WS token → tenantId`; the extension sends the raw token as `?token=…` | token: `printf 'uk_ext_%s\n' "$(openssl rand -hex 24)"` | that user pastes the new WS URL into the extension panel |
| `VAULT_MASTER_KEY` | base64url 32-byte AES-256-GCM key envelope-encrypting every vault value | `openssl rand 32 \| basenc --base64url \| tr -d '='` | **every stored vault value must be re-sealed** (`vault-put.mjs`) — old envelopes become undecryptable |

**When to rotate:** on suspected exposure of that specific secret, when
offboarding a tenant/user (edit the relevant JSON map and re-put), or on a
periodic schedule for the two keys. `CALLER_TOKENS`/`EXTENSION_TOKENS` are
add/remove-an-entry edits — rotating one caller/extension does not disturb the
others.

**Re-push after editing the backup file** (from `apps/backend`) — one at a
time with `wrangler secret put <NAME>`, or all four via the bulk endpoint (the
`.secrets.production.env` header carries a ready-made env→JSON one-liner that
pipes into `wrangler secret bulk`).
