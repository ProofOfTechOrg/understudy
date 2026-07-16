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

Dispatch failures map to status codes by error-message prefix (the only signal
that survives the DO RPC boundary; the constants live in `src/coordinator.ts`):
**503** `{error: "extension not connected"}` when the session has no live,
onConnect-authorized extension socket — the gate consults that delivery
predicate directly (not the persisted `status` scalar, which a late close from
a replaced socket can leave stale), fails fast instead of burning the 30s
timeout, and answers non-2xx deliberately: a 200 `ok:false` Event would be
cached by a consumer's idempotency store and replayed after reconnect;
**504** `{error: "command timed out"}` when a connected extension never
answered; anything else is a uniform JSON **500** via `app.onError`. A real
`fill_secret` checks the same predicate *before* touching the vault, so no
plaintext is ever resolved for a command that cannot dispatch. Exception:
a ref-less dryRun write (e.g. navigate) still short-circuits to simulated
`ok:true` without touching the wire — it was never a liveness signal.

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

`onConnect` runs an async token check (`verifyExtensionToken`) before marking a
connection `connection.setState({ authorized: true })`. The Agents SDK accepts a
socket — and admits it to the connection set `getConnections()` returns — before
that async check resolves, so an unauthenticated or wrong-tenant socket can sit in
the connection set during that window. Four things close this gap:

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
- **The vault binding (`Env.VAULT`) is a KV namespace, not CF Secrets/Secrets
  Store**: `fill_secret`'s `secretRef` is chosen per-call at runtime, and CF's
  Secrets/Secrets Store bindings are static — one binding per fixed secret name —
  which cannot address an arbitrary runtime-chosen key. KV's `get(key)` can. The
  `wrangler.jsonc` `VAULT` KV namespace id is a dev-only placeholder
  (`REPLACE_WITH_VAULT_KV_NAMESPACE_ID`); because KV values are readable back at
  rest, a stronger backend (per-tenant KMS, or a Secrets-Store-via-API binding)
  must replace it behind the same `VaultBinding.get` seam (`types.ts`) before any
  real credential is stored — this is a pre-production gate, not yet done.
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
  error instead (503/504/500 — see the failure mapping above).
- `fill_secret` plaintext never enters `setState`, logs, the Event response, or an
  error string; the coordinator logs only `{commandId, type}`.
- One Durable Object per `sessionId`; a sessionId whose embedded tenant disagrees
  with the authenticated caller is refused with 404, never 403.
- A mid-command DO hibernation cannot happen (see above); an interrupting
  shutdown/restart is bounded by the per-command timeout, and the persisted
  awaiting-marker reconciles any orphaned late result rather than mis-resolving it.
- The service runs no LLM and imports no agent framework.
- `SessionCoordinator` is the only Cloudflare-coupling seam; `coordinator.ts`
  itself imports nothing Cloudflare-specific.
- `dryRun` never dispatches a mutating command and never resolves a secret; it
  always returns a simulated `action_result` from a read-only ref check.
- An accepted-but-not-yet-authorized WebSocket connection can neither receive a
  command nor have its inbound messages processed (see WebSocket security model).
