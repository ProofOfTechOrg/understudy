# CLAUDE.md

## Overview

Cloudflare Worker (Hono) + one Agents-SDK Durable Object per session (`SessionAgent`). The consumer-facing command API for M3; the backend peer to the M2 extension.

## Files

| File | What | When to read |
| --- | --- | --- |
| `README.md` | Architecture, decision rationale, invariants (invisible knowledge) | Understanding why the service is structured this way |
| `package.json` | Scripts (`dev`/`deploy`/`typecheck`/`test`), deps (hono, agents, zod ^4) | Adding a dep, changing a script |
| `wrangler.jsonc` | Worker config: `SESSION` DO binding, `VAULT` KV binding, required secrets, compat date/flags | Changing bindings, deploying, adding a secret |
| `tsconfig.json` | TS config (workers-types, bundler resolution, strict) | Adjusting compiler options |
| `vitest.config.ts` | Workers-pool test config (`@cloudflare/vitest-pool-workers`); imports `./test/tokens` | Adjusting test runner/pool config |
| `.dev.vars.example` | Template for local `wrangler dev` secrets; matches `stub-consumer.mjs` defaults | Setting up local dev |
| `.secrets.production.env` | Operator-local backup of the DEPLOYED worker's secrets (gitignored via `.secrets*`; absent in a fresh clone; the worker is canonical) | Recovering/rotating prod secrets — see README "Secrets" |
| `src/index.ts` | Worker entry: Hono adapters (`/v1/sessions*`, `/health`) over `src/api/sessions.ts` + `routeAgentRequest` with pre-accept WS/HTTP auth hooks (`gateAgentRequest`) + result→status mapping; re-exports `SessionAgent` | Adding/changing a route, changing auth order, changing failure statuses |
| `src/api/sessions.ts` | Transport-neutral session service layer: the /v1 handler bodies as `(env, actor, input) → typed result union`; the single admission path (tenant gates, quotas, telemetry) every caller class shares | Adding a caller surface (MCP, RPC), changing session/command semantics for all callers at once |
| `src/session.ts` | `SessionAgent` — the per-session Durable Object: WS auth, event routing, `dispatch`/`fillSecret` RPCs (typed `DispatchOutcome`, write-replay cache) | Changing session lifecycle, dryRun behavior, fill_secret dispatch, idempotent replay |
| `src/coordinator.ts` | `SessionCoordinator` — portable command↔event correlation interface + failure-prefix constants, no Cloudflare imports | Understanding the portable seam, swapping the CF impl |
| `src/coordinator-cf.ts` | `CfSessionCoordinator` — CF impl: pending map (+ duplicate-in-flight guard) + persisted awaiting-marker + hibernation reconciliation | Debugging a stuck/timed-out command, hibernation edge cases |
| `src/auth.ts` | Caller bearer-token auth, fresh/idempotent sessionId minting, HMAC tenant scope, extension-token verification, composite device auth (`udt_` via directory + 60s positive cache), `taggedHmacHex` | Changing auth, session creation, token types, or 401/404 behavior |
| `src/account-directory.ts` | `AccountDirectory` — singleton SQLite DO: users (acct- tenants), email OTP, dashboard cookie sessions, paired devices, pairing codes, `usk_` MCP tokens; daily sweep alarm | Changing accounts, OTP/pairing semantics, credential formats, or display-once rules |
| `src/account-agent.ts` | `AccountAgent` — per-tenant DO for MCP: session binding, refsValid/refsEpoch staleness guard, one-command mutex, dispatch retry/poll loops over the service layer | Changing MCP session lifecycle, ref guard, or retry semantics |
| `src/oauth.ts` | The `OAuthProvider` instance (apiRoute `/mcp`, DCR, S256-only PKCE, RFC 8414/9728 metadata); delegated to by `src/index.ts` for a closed path list | Changing OAuth endpoints, scopes, or token TTLs |
| `src/mcp/` | MCP surface: `props` (shared auth shape + 401), `static-auth` (usk_ fast path + 60s cache), `handler` (rate limit + serve), `mcp-agent` (`UnderstudyMcp` DO), `tools` (14-tool catalog), `outcomes` (single result mapper), `dispatch-loop` (testable retry/poll/busy loop) | Adding/changing tools, auth branches, result texts, or retry thresholds |
| `src/dashboard/` | The provider's defaultHandler: `app` (routes + the app-wide same-origin gate and response security headers), `pages` (hono/html + CSP-nonced client JS), `auth` (cookie/CSRF/next guards), `email` (OTP send seam), `vault-upload` (ECDH unseal → re-seal) | Changing dashboard routes, consent, sign-in, the vault upload, or the response security headers — `Referrer-Policy` is load-bearing for the CSRF gate in `auth` |
| `src/tenant-coordinator.ts` | `TenantDeviceCoordinator` — per-tenant raw-SQLite DO: device registry, lease admission (`isSubset` of the request's origins against the device's `origin_policy_json` snapshot), capacity, quotas, idempotency, device liveness/revocation | Changing lease or origin enforcement, capacity, or device-loss timing |
| `src/validation.ts` | Bounded body reads, strict JSON parsing, `canonicalizeOrigins` (the allowed-origin grammar), `isLoopback` | Changing the origin grammar or request-body limits |
| `src/canonical.ts` | Canonical host/origin + derived MCP/dashboard URLs — one edit to change the domain | Changing the service domain |
| `src/cache.ts` | `createPositiveCache` — the shared positive-only TTL cache (device creds, usk_ tokens) | Changing cache eviction/TTL semantics |
| `src/secrets.ts` | `resolveSecret` — vault lookup only, no dispatch | Changing the vault backend, debugging secret resolution failures |
| `src/vault.ts` | AES-256-GCM envelope codec + `EncryptedKvVault` (get/put/list) + `createVault`/`writeVaultSecret`/`listVaultSecretNames` — KV holds ciphertext only; reads and writes both go through the wrapper | Changing the envelope format/key handling (mirror `scripts/vault-put.mjs`) |
| `src/base64url.ts` | base64url codec shared by auth.ts and vault.ts | Rarely — codec changes |
| `src/types.ts` | Shared `Env`, `SessionState` (incl. `completedWrites`), `SessionStatus`, `VaultBinding`, `DispatchOutcome` | Adding a binding, changing DO state shape, changing the RPC outcome union |
| `scripts/stub-consumer.mjs` | Throwaway Node runbook harness (not a workspace member) driving the API against a real extension | Running the attended M3 end-to-end verification |
| `scripts/vault-put.mjs` | Seeds one vault secret as an envelope via `wrangler kv key put` (plaintext from stdin; `--local` for dev) | Seeding/rotating vault values (never raw `kv key put`) |
| `test/service.test.ts` | Hono route tests: auth, tenant scoping, idempotent session minting, dryRun, fill_secret routing, pre-accept WS gate, write replay | Verifying/extending the command API |
| `test/session.test.ts` | `SessionAgent`/coordinator tests: in-DO WS auth (defense in depth), onClose stamping, resolve correlation, hibernation-resume | Verifying/extending DO behavior |
| `test/auth.test.ts` | Auth module unit tests | Verifying/extending auth.ts |
| `test/coordinator.test.ts` | Coordinator unit tests (timeout, duplicate guard, abandon, no-leak logging) | Verifying/extending coordinator-cf.ts |
| `test/secrets.test.ts` | Vault resolution unit tests | Verifying/extending secrets.ts |
| `test/vault.test.ts` | Envelope round-trip/tamper/wrong-key + `EncryptedKvVault` fail-closed tests | Verifying/extending vault.ts |
| `test/account-directory.test.ts` | OTP/pairing/token/device consume-once + tenant-class + composite/heartbeat device auth | Verifying/extending account-directory.ts or the acct- class |
| `test/agent-gate.test.ts` | Deny-by-default `/agents/*` gate + OAuth delegated-path routing/redirect/metadata | Verifying the delegation seam or agent gate |
| `test/mcp-auth.test.ts` | Static usk_ auth, positive cache, discovery-grade 401 fall-through | Verifying/extending MCP auth branches |
| `test/mcp-tools.test.ts` | Live streamable-HTTP handshake, 14-tool catalog, ref guard, cross-tenant isolation, outcome mapping | Verifying/extending the tool surface |
| `test/dispatch-loop.test.ts` | Unit tests for the retry/poll/busy loop thresholds (injected deps) | Changing retry/poll counts or the loop |
| `test/dashboard-auth.test.ts` | Sign-in/CSRF/vault-upload + full DCR→consent→PKCE→MCP flow; OTP email seam; the `sameOriginRequest` branch table (Sec-Fetch-Site/Origin) and the `Referrer-Policy` pin | Verifying/extending the dashboard, consent, or the same-origin gate |
| `test/pairing.test.ts` | `/v1/pairing/claim` config contract + connect-ticket + heartbeat liveness | Verifying/extending pairing |
| `test/helpers.ts` | Workers-runtime test helpers: session stub, WS extraction, `directory()`, `fetchApp()`, `mintUser()`, `CANONICAL` | Writing a new Workers-pool test |
| `test/tokens.ts` | Shared test-only token constants (used by vitest.config.ts and suites) | Adding a test caller/extension identity |
| `test/tsconfig.json` | Test typecheck project (extends root config, includes `test/**`) | Adjusting test typecheck scope |
| `test/env.d.ts` | Ambient `cloudflare:test`/`Env` typing for test files | Adding a new Env binding used in tests |
