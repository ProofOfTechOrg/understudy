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
| `src/index.ts` | Worker entry: Hono app (`/v1/sessions*`, `/health`) + `routeAgentRequest` with pre-accept WS/HTTP auth hooks (`gateAgentRequest`) + `DispatchOutcome`→status mapping; re-exports `SessionAgent` | Adding/changing a route, changing auth order, changing failure statuses |
| `src/session.ts` | `SessionAgent` — the per-session Durable Object: WS auth, event routing, `dispatch`/`fillSecret` RPCs (typed `DispatchOutcome`, write-replay cache) | Changing session lifecycle, dryRun behavior, fill_secret dispatch, idempotent replay |
| `src/coordinator.ts` | `SessionCoordinator` — portable command↔event correlation interface + failure-prefix constants, no Cloudflare imports | Understanding the portable seam, swapping the CF impl |
| `src/coordinator-cf.ts` | `CfSessionCoordinator` — CF impl: pending map (+ duplicate-in-flight guard) + persisted awaiting-marker + hibernation reconciliation | Debugging a stuck/timed-out command, hibernation edge cases |
| `src/auth.ts` | Caller bearer-token auth, sessionId mint/scope (HMAC), extension token verify | Changing auth, adding a token type, debugging 401/404 |
| `src/secrets.ts` | `resolveSecret` — vault lookup only, no dispatch | Changing the vault backend, debugging secret resolution failures |
| `src/vault.ts` | AES-256-GCM envelope codec + `EncryptedKvVault`/`createVault` — KV holds ciphertext only | Changing the envelope format/key handling (mirror `scripts/vault-put.mjs`) |
| `src/base64url.ts` | base64url codec shared by auth.ts and vault.ts | Rarely — codec changes |
| `src/types.ts` | Shared `Env`, `SessionState` (incl. `completedWrites`), `SessionStatus`, `VaultBinding`, `DispatchOutcome` | Adding a binding, changing DO state shape, changing the RPC outcome union |
| `scripts/stub-consumer.mjs` | Throwaway Node runbook harness (not a workspace member) driving the API against a real extension | Running the attended M3 end-to-end verification |
| `scripts/vault-put.mjs` | Seeds one vault secret as an envelope via `wrangler kv key put` (plaintext from stdin; `--local` for dev) | Seeding/rotating vault values (never raw `kv key put`) |
| `test/service.test.ts` | Hono route tests: auth, tenant scoping, dryRun, fill_secret routing, pre-accept WS gate, idempotent write replay | Verifying/extending the command API |
| `test/session.test.ts` | `SessionAgent`/coordinator tests: in-DO WS auth (defense in depth), onClose stamping, resolve correlation, hibernation-resume | Verifying/extending DO behavior |
| `test/auth.test.ts` | Auth module unit tests | Verifying/extending auth.ts |
| `test/coordinator.test.ts` | Coordinator unit tests (timeout, duplicate guard, abandon, no-leak logging) | Verifying/extending coordinator-cf.ts |
| `test/secrets.test.ts` | Vault resolution unit tests | Verifying/extending secrets.ts |
| `test/vault.test.ts` | Envelope round-trip/tamper/wrong-key + `EncryptedKvVault` fail-closed tests | Verifying/extending vault.ts |
| `test/helpers.ts` | Workers-runtime test helpers (session stub, WS extraction) | Writing a new Workers-pool test |
| `test/tokens.ts` | Shared test-only token constants (used by vitest.config.ts and suites) | Adding a test caller/extension identity |
| `test/tsconfig.json` | Test typecheck project (extends root config, includes `test/**`) | Adjusting test typecheck scope |
| `test/env.d.ts` | Ambient `cloudflare:test`/`Env` typing for test files | Adding a new Env binding used in tests |
