<!-- Content type: How-to -->

# Finish the unattended production rollout

This runbook is the canonical operator record for Understudy’s unattended production rollout. Keep it current in every implementation, deployment, canary, and ramp pull request until the final 24-hour operational soak passes.

## Define the finish line

The rollout is complete only when every condition below holds:

- Understudy’s additive Durable Object migration `v2` and dual-protocol backend are live
- The production Chromium acceptance suite passes
- The read-only 24-hour soak passes
- Metamind proves an unattended workflow governed by FlowSafe approvals and Breakwater connectors
- Correlated audit evidence proves durable session cleanup and no write before approval
- Allowlisted production traffic completes the `1 → 5 → all` ramp
- The final 24-hour operational soak passes
- This runbook records full release SHAs, deployment and version IDs, proof artifacts, metrics evidence, and the rollback baseline

Do not declare the project finished from a code merge, package release, Worker deployment, or single proof run.

## Update the status ledger

Update this table in the pull request that changes a gate. Use only `Not started`, `In progress`, `Blocked`, `Passed`, or `Rolled back` as the state.

| Field | Required evidence |
|---|---|
| Gate | Named phase and acceptance gate |
| State | `Not started`, `In progress`, `Blocked`, `Passed`, or `Rolled back` |
| Approved SHA | Full Git commit, never a branch name |
| Deployment | Cloudflare deployment and version IDs, or an explicit reason that no deployment applies |
| Evidence | Continuous integration (CI) run, proof artifact, query result, or operator record |
| Completed | Coordinated Universal Time (UTC) timestamp |
| Owner | Engineering, release operator, or canary operator |

Never mark a gate `Passed` without its approved SHA, deployment disposition, evidence, completion timestamp, and owner. Use `Pending` for evidence that does not exist yet. Do not use a branch name as temporary SHA evidence.

| Gate | State | Approved SHA | Deployment | Evidence | Completed | Owner |
|---|---|---|---|---|---|---|
| Phase 0a: release-flow baseline | Passed | `4843b6bccd8e1028c8fb6dba7812d643a4106778` | Not applicable: package and branch-flow gate | [PR #20](https://github.com/ProofOfTechOrg/understudy/pull/20), [PR #21](https://github.com/ProofOfTechOrg/understudy/pull/21), [master CI](https://github.com/ProofOfTechOrg/understudy/actions/runs/30255565127), [Version](https://github.com/ProofOfTechOrg/understudy/actions/runs/30255262164), [Release](https://github.com/ProofOfTechOrg/understudy/actions/runs/30255565196) | `2026-07-27T09:51:30Z` | Release operator |
| Phase 0b: rollout runbook merged | Passed | `464763bd6c39b86f6154fcb7c95ed3edfe75ef4e` | Not applicable: documentation gate | [PR #22](https://github.com/ProofOfTechOrg/understudy/pull/22) merged; [CI](https://github.com/ProofOfTechOrg/understudy/actions/runs/30323913062) and [Version](https://github.com/ProofOfTechOrg/understudy/actions/runs/30323913036) passing. Release workflow is a no-op: no pending changesets, no published-package code changed | `2026-07-28T02:51:30Z` | Engineering |
| Phase 1a: Metamind implementation | Passed | Metamind `fb6a7b706106306d95861ebe4a7abf0f5c65c6b8` (merged to `dev`) | Not applicable: implementation gate; production still on the baseline | [PR #17](https://github.com/ProofOfTechOrg/metamind/pull/17) merged, [CI passing](https://github.com/ProofOfTechOrg/metamind/actions/runs/30325493776) (app, worker, preflight). Worker lane covers typecheck, 716 tests, Biome, proof-runner self-test in both modes, `pnpm build` + `validate-build.sh`. Both migration copies apply to SQLite with identical schemas; the additive file is idempotent | `2026-07-28T03:21:33Z` | Engineering |
| Phase 1b: Metamind attended deployment and proof | In progress | Metamind `5fb1e118487377132e6d5b571607b13fcb669f4d` (merged to `master`) | Deployment `906afcb2-aca0-4f51-b985-2b1f9b411b00`, version `2143000b-0171-49c9-991d-dc05af8c894b` at `2026-07-28T03:47:58Z`. Deployment message `release 5fb1e118487377132e6d5b571607b13fcb669f4d` | D1 lease migration applied BEFORE the promotion: `changes: 1, changed_db: true, num_tables: 34`; verification returns `browser_session_leases` with both indexes and is queryable post-deploy (`COUNT(*) = 0`). `/health.commit` = `5fb1e118487377132e6d5b571607b13fcb669f4d`, confirmed by five consecutive matching reads. [PR #18](https://github.com/ProofOfTechOrg/metamind/pull/18), [CI](https://github.com/ProofOfTechOrg/metamind/actions/runs/30326639077). Smoke: `/` 302 to `/app/`, `/app/` 200, `/v1` 401 unauthenticated. Deployed with `UNDERSTUDY_SESSION_MODE=attended`. The first proof attempt FAILED and surfaced two production bugs that broke attended mode end to end — see "Attended mode was broken" below; both are fixed, Metamind's fix awaits [PR #19](https://github.com/ProofOfTechOrg/metamind/pull/19). **Remaining: rerun the attended production proof**, which needs an operator at a Chromium browser | Pending | Release operator |
| Phase 2: Understudy `v2`, flags-off rollback baseline | In progress | `dd7c100343cfc15e02802d93831600e0535670ed` | Deployment `1c32a8e9-bf87-49eb-89a5-253ea4e47d1a`, version **`7eff2d11-2ba5-420b-b1f2-113faf0d6f73`** at `2026-07-28T04:29:57Z`, message `release dd7c100343cfc15e02802d93831600e0535670ed`. Previous baseline was version `41434382-ecdd-4f95-a27c-811c4337b6bd` | Verified at the approved SHA on a detached checkout: `pnpm install --frozen-lockfile`, `build`, `typecheck`, `test` (408 tests: 194 backend, 139 extension, 43 protocol, 32 connector), `wrangler deploy --dry-run`. All six secret names confirmed present — `DEVICE_TOKENS` and `WS_TICKET_SECRET` were MISSING and were provisioned first (see below). Active version exports `SessionAgent`, `DeviceAgent`, `TenantDeviceCoordinator`; binds `SESSION`, `DEVICE`, `TENANT_CONTROL`, `ANALYTICS`, `RATE_LIMITER`, `VAULT`, all six secrets, `QUOTA_POLICY`, and both rollout variables at `"[]"`. `/health` returns `{"ok":true}`; an unmapped token gets `401`; a well-formed unattended request gets `503 unattended sessions are disabled`, proving the flags-off baseline. Caller token rotated on both sides (Metamind confirmed as the only caller). The attended `curl` smoke test returns `200` with a `sessionId` after Understudy `e0351f6` (version `8ec9be79-76bb-4140-9530-402b4a46a40e`) fixed the empty-body discrimination — it had answered `400` for every over-the-wire caller. **Remaining: the Metamind attended proof** | Pending | Release operator |
| Phase 3a: canary device acceptance | Not started | Pending | Pending | Pending | Pending | Canary operator |
| Phase 3b: 24-hour read-only soak | Not started | Pending | Pending | Pending | Pending | Canary operator |
| Phase 4: governed Metamind unattended proof | Not started | Pending | Pending | Pending | Pending | Canary operator |
| Phase 5a: one-record production gate | Not started | Pending | Pending | Pending | Pending | Canary operator |
| Phase 5b: five-record production gate | Not started | Pending | Pending | Pending | Pending | Canary operator |
| Phase 5c: all-allowlisted 24-hour gate | Not started | Pending | Pending | Pending | Pending | Canary operator |
| Phase 6: rollout closeout | Not started | Pending | Pending | Pending | Pending | Release operator |

## Unplanned Phase 1b deployment (2026-07-28)

Pushing the Metamind Phase 1a branch `feat/unattended-phase-1` deployed it to **production**. Nothing was merged; the push alone was sufficient.

A built branch does not preview here, it deploys. Non-production branch builds normally produce a preview version because Cloudflare runs `wrangler versions upload` for them — the preview behavior comes from the COMMAND, not the branch. Metamind's configured deploy command is `npx wrangler deploy`, which creates a deployment at 100% traffic on whatever branch it runs. Deployment `0b7c23c4-8c32-41ac-ac68-92cca84d255c` records exactly that: version `998ca9c2` at 100%, not a version upload.

| Fact | Value |
|---|---|
| Deployed version | `998ca9c2-95cb-4731-a2a0-29bf94163acd` at `2026-07-28T02:46:04Z` |
| Displaced baseline | version `b7890ecc-b4c4-489f-a67f-3cafbca67b6a` |
| `/health.commit` | `e602b3b32426e35490d8f1df6bdc3f7ebebbd9de` — an unmerged pull-request branch |
| D1 state | `browser_session_leases` absent; the deployed code queries it |

Impact is confined to browser enrichment: `POST /v1/intake/records/:id/enrich-website` fails because the lease table is missing, and the 15-minute sweep logs `browser-lease-sweep-error` each tick. The primary lead-intake workflow, authentication, CRM commit, and Gmail draft paths are untouched, and the approval-resume lease release is internally contained, so approval decisions still land.

This inverts the ordering Phase 1b requires — the additive D1 migration must be applied **before** deploying code that queries the table — and the deployment carries no `/health` verification and no attended proof, so it is not a passed gate.

### Resolution

Rolled back at `2026-07-28T02:54:56Z`. Deployment `09d99cf6-6ef7-404b-81dd-99d36319ac77` restored version `b7890ecc-b4c4-489f-a67f-3cafbca67b6a`, and `/health.commit` reads `local` again — the documented baseline. Production D1 was never modified, which is the correct state for the restored code. Rolling back rather than applying the migration was chosen because the displaced version had no `/health` verification and no attended proof behind it, so it was an unrecorded state rather than a passed gate; returning to a known baseline lets Phase 1b run in the order this runbook specifies.

Metamind pull request #17 (Phase 1a) is held open and green, unmerged, because merging it would trigger another branch build and redeploy production.

Before any further Metamind deployment:

1. **Done `2026-07-28T03:1xZ`.** Non-production branch builds are Disabled in the Metamind Workers Builds configuration (production branch `master`). Verified by pushing to the branch afterwards: no new deployment record, `/health.commit` unchanged at `local`, and the `Workers Builds: metamind` check no longer appears on the pull request — it was present on the push that caused this incident. If branch builds are ever wanted back, their deploy command must be `wrangler versions upload`; and even a correct preview binds production D1, KV, and Durable Objects here, because there is one wrangler environment with top-level bindings.
2. **Done.** Metamind's `docs/deploy.md` corrected in `8173ddd`, merged with [PR #17](https://github.com/ProofOfTechOrg/metamind/pull/17).

Phase 1a is merged. Phase 1b remains, and its ordering is below.

### Phase 1b ordering, with the auto-deploy in the picture

The promotion to Metamind's default branch **is** the production deploy. `pnpm deploy:prod` is not what ships production in the normal flow — the merge is. That removes the window this runbook's Phase 1 sequence assumes between deploying code and applying its schema, so:

Apply `packages/worker/sql/add-browser-session-leases.sql` to production D1 **before** promoting to `master`, not after. The deployed code queries that table on the enrichment path; promoting first repeats the failure this section records.

**Chosen and in force:** the default-branch auto-deploy stays enabled, and its Workers Builds commands were changed so that it runs the source-controlled deploy script rather than a bare `wrangler deploy`:

| Setting | Value |
|---|---|
| Production branch | `master` |
| Build command | `pnpm build` |
| Deploy command | `bash scripts/deploy.sh --skip-build` |
| Non-production branch builds | Disabled |

Every production deploy therefore carries a SHA-stamped `--var COMMIT` and deployment message plus a `/health.commit` verification, with the logic reviewable in the repository and only a one-line reference in the dashboard. Confirmed working on the Phase 1b deployment: deployment `906afcb2` records the message `release 5fb1e118…`, which only `scripts/deploy.sh` produces.

State what this does and does not gate. The clean-tree checks are genuine pre-deploy gates but apply only to local `pnpm deploy:prod` runs, since a CI checkout is clean by construction. The `/health.commit` check runs AFTER `wrangler deploy` has landed, so it detects a mismatch and fails the run loudly — it cannot reject a deployment that already happened. Treat a red verification as "roll back", not "nothing shipped".

### Verifying `/health.commit` after a deployment

A deployment propagates across the edge over seconds to minutes, and during that window `/health` legitimately answers with EITHER version depending on which isolate serves the request — observed mixed for roughly two minutes after the rollback below. A single `curl` is therefore not a verification: it can read an un-propagated isolate and reject a good deployment, and one matching read only proves one isolate updated while traffic may still run the old code.

Poll for at least three minutes and require several CONSECUTIVE matching reads before accepting the gate. Metamind's `scripts/deploy.sh` does this (`8173ddd`); a hand-run check must do the same.

The deployment was only detectable because Phase 1's build-time provenance stamp was already in place. Under the previous `COMMIT=local` placeholder, `/health` would have reported `local` both before and after, and this would have been invisible.

## Attended mode was broken (2026-07-28)

The first attended proof attempt failed at `POST /records/:id/enrich-website` with a bare `502`. Two independent production bugs, both of which made attended enrichment impossible, and neither of which any test suite caught.

### 1. An empty request body was not treated as attended

Attended creation is defined as "no body" and was checked as `c.req.raw.body === null`. That holds only for a Request constructed in-process. Over the wire a bodiless POST is not bodiless: every client sends `Content-Length: 0`, which arrives as an empty but non-null stream — curl, Node's fetch, and a Worker subrequest to a public hostname alike. So the request fell through to the unattended branch and failed schema validation with `400 invalid body`.

Understudy's own suite stayed green because its tests call `exports.default.fetch(new Request(url, { method: "POST" }))` in-process, which is the one path that does produce a null body.

Fixed in Understudy `e0351f6`, deployed as version `8ec9be79-76bb-4140-9530-402b4a46a40e`. The body is read once, bounded, and an empty result takes the attended branch; a non-empty one is validated exactly as before, so a malformed body still cannot open an attended session. The regression test builds the request the way the wire delivers it.

### 2. Provisioning and workflow start were a single call

With the body fixed, the run reached the workflow and failed with `understudy service 503`. The workflow's first step dry-runs two navigations, and `SessionAgent.dispatchV2` checks `hasAuthorizedConnection()` BEFORE it considers `dryRun` — so a dry run needs an attached browser like any other dispatch.

That made the attended sequence impossible. `enrich-website` minted the session and started the workflow in one call, and an operator can only attach once a `sessionId` exists, so the preview always ran against an unattached session. The preview cannot simply move after the approval either: the approval payload embeds it, which is what the reviewer approves against.

Fixed in Metamind `7f92720` by splitting the two: `POST /records/:id/browser-session` provisions the leased session and returns it — with the `webSocketUrl` in attended mode — without touching the workflow. The operator attaches, then POSTs `enrich-website`, which adopts the same session rather than minting a second. Unattended keeps the single call, since the enrolled device attaches itself. The proof runner is reordered to provision → attach → start.

### Why diagnosis was slow

The route caught every unmapped error and returned `502` without logging it, so Workers request logs showed a clean `ok` outcome with no exception and no clue. The 502 fallback now logs the error before returning. An error path that discards its own cause is not a failure mode worth preserving.

## The lease sweep cannot reach Understudy from cron (2026-07-28, OPEN)

The SWEEP_CRON recovery pass — the durable backstop for browser-session cleanup — cannot call Understudy. Three orphaned `minting` leases have been retrying every 15 minutes and failing identically:

```json
{"type":"browser-lease-recovery-error","state":"minting","transient":false,
 "error":"Error: understudy session mint failed (404)"}
```

## The attended production proof PASSED (2026-07-28)

Run `metamind_efefdb2e-2aed-441a-af6b-527e640c816f`, record `rec_nDHTDg3Z9UbzyyG7`, against Metamind `434c1a7f` and Understudy `5cc96902`.

| Gate | Evidence |
|---|---|
| Extension connected, tab attached | Chrome 150, extension `0.1.1`, `https://example.com/` |
| Approval by a present human | `decidedByPresent: true`, `decision: approve` |
| Workflow run | `status: "success"` |
| Public page datum | matched `Example Domain` |
| **Authenticated datum** | matched `Secure Area` — behind the portal login, filled from the vault |
| Context line | non-empty, 77 characters |
| Audit trail | 13 `connector.execute` entries correlated on `targetId == runId` |
| Lease cleanup | `released` — a CONFIRMED 204, `last_error` null |

Real Chromium, real CDP, human-in-the-loop approval, a vaulted credential, and a datum read from behind a login — with the audit trail and the durable lease both closing correctly. **Phases 1b and 2 are closed.**

The run needed three attempts, and the first two failed on defects in this repo's consumer rather than on anything the operator did.

### The sweep tore down a session mid-attach

Provisioning and starting are two calls with a human between them, so between them the lease has NO run. `recoverActiveLease` read a missing run as a finished one and queued cleanup five minutes after provisioning — while the operator was still loading an extension. The attach took twenty minutes; the enrichment then failed with `lease_conflict`.

**Only the cron routing fault prevented data loss.** The sweep's DELETE hit the same unreachable-host 404 as everything else, so Understudy never received it and the session survived. Fixing the routing without fixing this would have destroyed live sessions.

Fixed in Metamind: a missing run counts as finished only past a 30-minute attach window. The test that asserted the old behaviour had encoded the bug, which is why it looked deliberate.

### The step-up expired mid-proof

The admin step-up lives fifteen minutes and the attended flow spends most of that waiting for a human, so the credential was dead by the audit read — discarding a proof whose browser writes had all succeeded. The audit read now re-reads the file and asks the operator to re-stage. The trailing audit for the passing run was completed by hand.

### Correction: the first evidence chain rested on a dead instrument

An earlier revision of this section concluded the same thing from a `wrangler tail` that had **silently failed to start**. Run from `apps/backend` without an account, it exits immediately with:

```
✘ [ERROR] More than one account available but unable to select one in non-interactive mode.
```

It writes nothing to stdout, so "zero requests during the tick" was indistinguishable from "the tail never ran". Understudy's Worker lives on account `056cbaa6f5c3d8ff5584f1aa84bbe050`, so the tail must be started as:

```bash
CLOUDFLARE_ACCOUNT_ID=056cbaa6f5c3d8ff5584f1aa84bbe050 npx wrangler tail --format json
```

**Always validate a tail before drawing a negative conclusion from it** — issue a known request (`curl .../health`) and confirm it appears. Every observation below was taken on a tail validated that way.

### Evidence, in the order it rules things out

| Observation | Rules out |
|---|---|
| `POST /v1/sessions` replaying the leases' **original** idempotency keys returns `200` from curl | The keys, the route, the payload, idempotent-replay state |
| Missing or garbage bearer tokens return `401`, never `404`; a valid token returns `200` with or without an idempotency key | The caller token — no auth failure can present as `404` |
| The deployed bindings of Metamind version `3f1ba280` carry `UNDERSTUDY_URL=https://understudy-backend.gcharang.workers.dev` and `UNDERSTUDY_TENANT_ID=metamind` | Configuration drift (see the two-config trap below) |
| Breakwater's `egressFetch` **throws** `EgressDeniedError` on denial and never synthesizes a `Response` | The egress guard manufacturing the `404` |
| The Metamind fetch-context mint at `05:46:42Z` succeeded and minted a real session | Metamind's caller token and `UNDERSTUDY_URL` at runtime |
| Across the `07:45:31Z` tick Metamind logged 3 × `404` while Understudy received **zero** sweep requests — the only requests in that window were my own probes, identifiable by `user-agent: curl/8.5.0` and `cf-connecting-ip` | Understudy rejecting it — the request never arrives |

Because `createAttendedSession` fails on `!response.ok`, the fetch **resolved with a real 404 Response**; it did not throw. Something between Metamind's scheduled handler and Understudy answers it.

Confidence: **high** that the sweep's subrequest does not reach Understudy; **unknown** as to Cloudflare's precise reason — do not guess it into the record.

### The two-config trap

Metamind has **two** Wrangler configs, and reading the wrong one sends you chasing a phantom:

| File | Purpose | `UNDERSTUDY_URL` |
|---|---|---|
| `wrangler.jsonc` (repo root) | **Production.** `scripts/deploy.sh` runs from the root, so this is what deploys | `https://understudy-backend.gcharang.workers.dev` |
| `packages/worker/wrangler.jsonc` | Local dev | `http://localhost:8790` |

`wrangler deploy --dry-run` run from `packages/worker` prints the **dev** bindings and looks alarming. Verify what is actually live with `wrangler versions view <id>` instead.

### Impact

Phase 1's durable cleanup guarantee is not met in production. The synchronous release on the resume path still works — that is what released the one successful run's lease — but the crash backstop does not, so a lease orphaned by a crash stays orphaned and its device slot is held until Understudy's own idle expiry. The Phase 5 ramp gate "no stale `minting`, `active`, or `cleanup_pending` lease after a terminal workflow" cannot pass while this holds.

### Next step: read the 404's body

The bare status is why this cost hours. Metamind now reports the response's content type and a bounded body snippet on a failed mint (`describeFailure` in `packages/worker/src/intake/browser-session.ts`), which separates the two possibilities without further guesswork:

- a JSON body (`{"error":…}`) means **Understudy answered** — fix the call;
- an HTML body means **the edge synthesized it** — fix the routing.

### Two candidate fixes, neither applied

1. **Service binding.** The correct Worker-to-Worker mechanism for two Workers on one account: no DNS, no public hop, no egress. But session management deliberately routes through breakwater's egress pin — `browser-session.ts` states it "must not be the one hole in the egress pin" — and a service binding bypasses that guard entirely. It is therefore not a drop-in: it needs `egressFetch` to gain a service-binding transport, or it weakens a deliberate security boundary.
2. **Custom domain for Understudy.** Point `UNDERSTUDY_URL` at a routed domain instead of `*.workers.dev`. This keeps the egress guard intact and only changes a hostname, and it retires a personal `gcharang.workers.dev` subdomain as the production address of a service other repos consume. It needs a hostname decision from the owner.

Given the egress-pin constraint, (2) is now preferred on architecture as well as speed — the reverse of this document's earlier recommendation. Either way, verify by tailing Understudy — **validated** as above — across a cron tick and confirming the sweep's request arrives.

**(2) is blocked on one decision only: the hostname.** `understudy.proofof.tech` is the obvious default. Adding it is a DNS change on a domain the owner controls, so it is not taken unilaterally.

### What the diagnostic cost, and what it found on the way

The observability change is Metamind PR #20, not yet merged or deployed. It grew well past a logging fix, because the "who answered?" question turns out to gate an irreversible action: `mintLeasedSession` abandons a durable lease on a refusal, on the premise that a refusal proves nothing was created. Four review rounds each found that premise applied wrongly, and the last two found defects that predate this investigation:

| Defect | Why it mattered |
|---|---|
| Any non-2xx raised the refusal type in unattended mode | An edge-synthesized 404 retired a lease whose session may exist |
| Ambiguity resolved toward "Understudy answered" | Any JSON-speaking proxy in front of Understudy could strand a session |
| Understudy's own `{"error":"internal error"}` at **500** passed the envelope check | That 500 is raised while waiting for the extension — *after* the session exists |
| The sweep replayed permanently-failing mints forever | A rotated token or disabled tenant crowds out recoverable leases, since the sweep pages oldest-attempt-first |

Only the statuses Understudy declines with — 409, 429, 503 — are now read as refusals, and a lease that never learned a session id is retired after 24 hours under its own `browser-lease-quarantined` log type.

Relevant to the ramp gates: the Phase 5 gate forbidding stale leases assumed the sweep could clear them. It cannot reach Understudy at all (above), and until it can, the gate measures the routing fault rather than the lease machinery.

## Start from the verified baseline

The following state was verified on 2026-07-27. Recheck it before operational work because deployments and remote refs can change.

### Repository and release baseline

| Repository state | Verified value |
|---|---|
| Understudy working baseline | `dev@e4b98e6824b2dbee078a7c57da37a11f389010b9` |
| Understudy release baseline | `origin/master@4843b6bccd8e1028c8fb6dba7812d643a4106778` |
| Understudy local `master` | Stale at `46b210f745793cbc3d57fb06c96b28a627552429`; never deploy it without refreshing remote refs |
| Metamind release baseline | Clean `master@ee94790ddf92b8fabebba10a502e76005a57e17d` |
| Metamind baseline CI | [Passing run](https://github.com/ProofOfTechOrg/metamind/actions/runs/30179532157) |
| Published packages | `@understudy/protocol@0.8.0`, `@understudy/connector@0.5.1` |

The package release is complete. Do not create another package release unless later work changes a published package.

### Production deployment baseline

| Service | Deployment | Version | Known state |
|---|---|---|---|
| Understudy | `b73220f0-8035-40d2-9987-243770d96306` | `41434382-ecdd-4f95-a27c-811c4337b6bd` | Migration `v1`; no unattended Durable Object bindings, telemetry binding, rate limiter, or rollout variables |
| Metamind | `f85a53c6-7b90-4b6f-a427-2e8cef7df637` | `b7890ecc-b4c4-489f-a67f-3cafbca67b6a` | `COMMIT=local`; deployment provenance is not verifiable |

### Operator prerequisites

Real-Chromium verification works only under these conditions:

- Chrome 125 or newer
- One tenant-dedicated Chrome profile
- Chrome startup set to **New Tab**
- The production extension build, not WXT development mode
- No DevTools attached to a controlled tab
- An awake machine, browser, and network for each soak
- Access to both GitHub repositories, both Cloudflare Workers, production D1, Worker secrets, and the canary profile

## Phase 0: Freeze the release baseline

Freeze branch and evidence state before implementation begins. Merge this runbook before any operational deployment.

1. Refresh remote refs in each repository:

   ```bash
   git fetch --prune
   git status --short
   git rev-parse HEAD
   git rev-parse origin/dev
   git rev-parse origin/master
   ```

2. Confirm each working tree is clean. Resolve any output from `git status --short` before deployment.
3. Merge feature work into `dev` through reviewed pull requests.
4. Promote reviewed `dev` commits to `master` through a `dev → master` pull request.
5. Never merge `master` back into `dev`.
6. Merge the rollout-document pull request before Phase 1.
7. Update this runbook in every later implementation and deployment pull request.

Record the merged SHA for this runbook in Phase 0b. Do not copy the pre-merge `dev` SHA into that field.

## Phase 1: Make Metamind compatible and recoverable

Complete and deploy this phase while production remains in attended mode. Understudy’s current backend must continue to serve the attended proof during this phase.

### Upgrade the Understudy client packages

In Metamind, change `packages/worker/package.json` to:

```json
{
  "@understudy/connector": "^0.5.1",
  "@understudy/protocol": "^0.8.0"
}
```

Run `pnpm install` to update `pnpm-lock.yaml`, then review the dependency diff. Do not publish new Understudy package versions unless their package code changes.

### Add the mode configuration

Add these non-secret bindings to both `wrangler.jsonc` files, `packages/worker/src/env.ts`, and generated Worker types:

| Binding | Contract |
|---|---|
| `UNDERSTUDY_SESSION_MODE` | `attended` or `unattended`; default and initial production value is `attended` |
| `UNDERSTUDY_DEVICE_ID` | Required UUID in unattended mode |
| `UNDERSTUDY_ALLOWED_ORIGINS` | JSON array of canonical exact origins; maximum 32 |
| `UNDERSTUDY_PROFILE_STATE_KEY` | Required non-secret account-state identifier in unattended mode |

Set the synthetic canary origins to exactly:

```json
["https://example.com", "https://practice.expandtesting.com"]
```

Reject a record origin that is absent from this list before creating an Understudy session. Expanding production scope requires one reviewed change that updates both Metamind’s source-controlled allowlist and the extension’s local origin policy.

The list binds BOTH modes whenever it is set, covers every origin the workflow visits (the record’s own and the portal it authenticates against), and is re-checked at each approved side-effect boundary so a run suspended across a policy narrowing cannot resume against origins the list no longer permits. Note the operational consequence: once Phase 1b deploys these canary origins while the mode is still `attended`, attended enrichment of any other origin is refused with `403 origin_not_allowed` until that origin is added by reviewed change. That is the intended fail-closed behavior, not a regression.

### Create attended and unattended sessions correctly

Attended creation must omit both `body` and `Content-Type`. Understudy treats any body, including `"{}"`, as an unattended request.

Unattended creation must send the JSON request with:

- `mode: "unattended"`
- The configured device UUID
- The exact allowed origins required by the record
- The configured profile-state key

If unattended creation returns `202`, poll its status URL every 2s for at most 30s. Accept only a connected `200` or `201`. Treat `410` as terminal. Treat a timeout or any other failure as an operational error.

### Return a mode-discriminated enrichment response

Change `POST /v1/intake/records/:id/enrich-website` to return these fields in both modes:

- `workflowId`
- `runId`
- `sessionId`
- `mode`
- `status`
- `approvalIds`

Attended responses also return `webSocketUrl`. Unattended responses must never expose or require a session WebSocket URL.

The response contract must discriminate on `mode`:

```typescript
type EnrichmentStartResponse = {
  workflowId: string;
  runId: string;
  sessionId: string;
  status: string;
  approvalIds: string[];
} & (
  | { mode: "attended"; webSocketUrl: string }
  | { mode: "unattended" }
);
```

### Centralize connector outcome handling

Handle protocol-2 outcomes in one shared path:

| Outcome | Required handling |
|---|---|
| `pending` | Poll the same command ID |
| `not_started` | Retry the same logical command and business idempotency key |
| `timed_out` | Retry reads and dry runs only |
| `unknown` | Never retry; fail the workflow and preserve audit evidence |

Do not infer retry safety from an HTTP status alone. Use the connector’s typed outcome and `safeToRetry` contract.

### Add durable browser-session leases

Add `browser_session_leases` to `packages/worker/migrations/0001_init.sql` for new databases. Add the same schema as `packages/worker/sql/add-browser-session-leases.sql` for the existing production database. Keep Metamind’s single consolidated baseline migration; do not add a second file to `packages/worker/migrations/`.

The table must contain:

- `run_id`
- `record_id`
- `idempotency_key`
- `mode`
- `request_json`
- Nullable `session_id`
- `state`
- Nullable `last_error`
- `created_at`
- `updated_at`

Use this state machine:

```text
minting → active → cleanup_pending → released
                                   ↘ abandoned
```

`released` means Understudy CONFIRMED cleanup with `204`. `abandoned` is a separate terminal state for a lease that provably owns nothing — Understudy refused the creation outright, or had already disposed of the session. The two are deliberately distinct: an operator auditing confirmed cleanups must not silently get rows where nothing was ever confirmed, and a lease left in `cleanup_pending` for a session that never existed would retry and alert forever, failing the ramp gate on what is ordinary, self-clearing device contention.

Persist the mint intent before calling Understudy, and the session id before waiting for it to connect. A crash must not lose the business idempotency key or request needed to recover the mint; recording the id before the connect wait is what lets an interrupted creation be resolved with a `DELETE` instead of another creation.

Classify a failed mint before cleaning up after it. A refusal (`409`, `429`, `503`) means nothing was created, so the lease is abandoned. Any other failure means the outcome is unknown and something may exist, so the lease is LEFT in `minting` for the sweep to replay and discover — moving it out disables the only path that can find that orphan.

Never re-mint under a terminal lease that held a session. Flowsafe can forget a completed run once its retention window passes, so "no run found" is not proof that none ever ran; re-minting would silently re-execute the workflow's browser writes. Refuse with a conflict and require a fresh idempotency key.

On workflow-start failure or a terminal FlowSafe status, move the lease to `cleanup_pending`. Terminal statuses are `success`, `failed`, `tripwire`, `canceled`, `bailed`, and `skipped`.

Preserve leases for the nonterminal statuses `pending`, `running`, `waiting`, `suspended`, and `paused`.

Extend the existing 15-minute maintenance cron to recover `minting` rows and retry `DELETE` for `cleanup_pending` rows:

- Treat `204` as released
- Treat `202` as cleanup still pending
- Retain and alert on persistent `401`, `403`, `404`, or `5xx`
- Never mark an unresolved cleanup as released
- Use compare-and-clear updates so a stale sweep cannot overwrite newer state

Apply the production D1 migration before deploying code that queries the table:

```bash
pnpm exec wrangler d1 execute metamind --remote \
  --file packages/worker/sql/add-browser-session-leases.sql
pnpm exec wrangler d1 execute metamind --remote \
  --command "SELECT name FROM sqlite_schema WHERE name='browser_session_leases'"
```

Apply the additive file once. Save both command results as Phase 1 evidence.

### Update the production proof runner

Update `packages/worker/scripts/enrich-browser-runbook.mjs` to support attended and unattended modes. Its self-test must cover both.

The unattended path must:

- Verify the configured device is online and has capacity
- Create or replay the unattended lease
- Poll creation until the session is connected
- Avoid extension-token input
- Avoid manual tab attachment
- Verify cleanup and device usage after terminal workflow completion

Keep the existing attended path and extension-token handling for attended proof only.

### Stamp Metamind deployment provenance

Replace the static `COMMIT=local` deployment path with an automated clean-tree deploy. The source-controlled deployment command must calculate the full SHA, reject a dirty tree, pass the SHA through Wrangler’s `COMMIT` variable, and include it in the deployment message.

A deploy-time `--var` alone is not sufficient, because it stamps only the path that passes it. Metamind also auto-deploys its default branch through Cloudflare Workers Builds, whose deploy command is a bare `wrangler deploy` — that path would ship the `COMMIT` placeholder from `wrangler.jsonc` and silently un-stamp a previously stamped deployment, invalidating recorded evidence after the fact and with no signal. The commit is therefore ALSO baked into the bundle at build time (`packages/worker/vite.config.ts`, from `WORKERS_CI_COMMIT_SHA` or `git rev-parse HEAD`) and preferred by `/health`. Both deploy paths then report a real SHA.

Confirm before Phase 1b that a merge to Metamind’s default branch cannot land an unstamped deployment over a stamped one — either the auto-deploy is disabled for the rollout, or it is running a build that carries the SHA.

The automated command must implement this sequence:

```bash
metamind_release_sha="$(git rev-parse HEAD)"
test -z "$(git status --short)"
pnpm build
test -z "$(git status --short)"
pnpm exec wrangler deploy \
  --var "COMMIT:$metamind_release_sha" \
  --message "release $metamind_release_sha"
```

After deployment, verify provenance:

```bash
metamind_release_sha="$(git rev-parse HEAD)"
curl --fail-with-body --silent \
  https://metamind.proofof.tech/health |
  jq -e --arg sha "$metamind_release_sha" \
    '.status == "ok" and .commit == $sha'
pnpm exec wrangler deployments status --json
```

Reject the deployment if `/health.commit` differs from the approved SHA.

### Verify and deploy Phase 1

Run the Metamind Worker lane from the Metamind repository:

```bash
pnpm --filter @repo/worker typecheck
pnpm --filter @repo/worker test
pnpm exec biome check packages/worker
node packages/worker/scripts/enrich-browser-runbook.mjs --self-test
pnpm build
bash scripts/validate-build.sh
git diff --check
```

Promote the reviewed Metamind change to `master`, deploy it with `UNDERSTUDY_SESSION_MODE=attended`, and rerun the existing attended production proof. Record:

- The full Metamind SHA
- CI URL
- D1 migration result
- Deployment and version IDs
- `/health` result
- Attended proof artifact and UTC completion time

Do not begin Phase 2 until the attended proof passes.

## Phase 2: Deploy the Understudy migration-v2 baseline

Deploy migration `v2` with all unattended tenant flags off. This deployment becomes the rollback baseline for every later Understudy configuration deployment.

### Verify the exact release source

Refresh refs and check out the approved full SHA. Do not deploy the stale local `master`.

Set `understudy_release_sha` to the full SHA approved in the ledger:

```bash
understudy_release_sha="full_approved_sha_here"
git fetch --prune
test -z "$(git status --short)"
git cat-file -e "$understudy_release_sha^{commit}"
git switch --detach "$understudy_release_sha"
test "$(git rev-parse HEAD)" = "$understudy_release_sha"
```

Run from the Understudy repository:

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
pnpm --filter @understudy/backend exec wrangler deploy --dry-run \
  --outdir /tmp/understudy-unattended-worker
pnpm --filter @understudy/backend exec wrangler secret list
```

Confirm these six secret names exist:

- `AUTH_HMAC_SECRET`
- `CALLER_TOKENS`
- `EXTENSION_TOKENS`
- `DEVICE_TOKENS`
- `WS_TICKET_SECRET`
- `VAULT_MASTER_KEY`

Do not print or record secret values.

### Deploy with flags off

Confirm the source-controlled configuration contains:

```json
{
  "UNATTENDED_ENABLED_TENANTS": "[]",
  "SAFE_WRITE_REQUIRED_TENANTS": "[]"
}
```

Deploy with a message containing the full approved SHA:

```bash
understudy_release_sha="$(git rev-parse HEAD)"
test -z "$(git status --short)"
pnpm --filter @understudy/backend exec wrangler deploy \
  --message "release $understudy_release_sha"
pnpm --filter @understudy/backend exec wrangler deployments status --json
```

Read the active version ID from the status result, then inspect it:

```bash
understudy_version_id="active_version_uuid_here"
pnpm --filter @understudy/backend exec wrangler versions view \
  "$understudy_version_id" --json
```

Verify the active version contains:

- Migration tag `v2`
- Exports for `SessionAgent`, `DeviceAgent`, and `TenantDeviceCoordinator`
- Durable Object bindings `SESSION`, `DEVICE`, and `TENANT_CONTROL`
- `ANALYTICS`
- `RATE_LIMITER`
- `VAULT`
- All six required secrets
- Quota configuration
- Both rollout variables

Then verify:

```bash
curl --fail-with-body \
  https://understudy-backend.gcharang.workers.dev/health
```

Send one attended session request with no body and no `Content-Type`:

```bash
curl --fail-with-body \
  --request POST \
  --header "Authorization: Bearer caller_token_here" \
  --header "Idempotency-Key: 00000000-0000-4000-8000-000000000021" \
  https://understudy-backend.gcharang.workers.dev/v1/sessions
```

Confirm it succeeds, then rerun the Metamind attended proof.

**Correction (2026-07-28).** An earlier revision of this file recorded that this command "cannot pass and should be replaced", on the reasoning that no external HTTP client can produce a request workerd surfaces as `body === null`. The observation was right; the conclusion was wrong. The command was correct and the SERVICE was wrong.

Attended creation is defined as "no body" and was checked as `c.req.raw.body === null`, which only holds for a Request constructed in-process. Over the wire every client sends `Content-Length: 0`, arriving as an empty but non-null stream — curl, Node's fetch, and a Worker subrequest to a public hostname alike. So attended creation answered `400 invalid body` for every real caller, including Metamind's own `createAttendedSession`, while the backend suite stayed green because its tests build the Request in-process.

That was not a smoke-test problem. Attended mode is the consumer-side rollback path this rollout depends on, and it did not work at all.

Fixed in Understudy `e0351f6` (deployed as version `8ec9be79-76bb-4140-9530-402b4a46a40e`): the body is read once, bounded, and an empty result takes the attended branch; a non-empty one is validated exactly as before. The regression test builds the request the way the wire delivers it. **The command above now returns `200` with a `sessionId`** — verified against production.

### Caller token rotated

Production `CALLER_TOKENS` could not be read back and the local `packages/worker/.dev.vars` value is the `dev-tenant` token, so the credential was rotated on both sides after confirming Metamind is the only production caller:

- Understudy `CALLER_TOKENS` = `{"<token>": {"actor": "metamind", "tenantId": "metamind"}}`
- Metamind `UNDERSTUDY_TOKEN` = the same value

The token is at `~/.understudy-canary/caller-token.json`, mode `0600`. Metamind's `/health.commit` still reports `5fb1e118…` afterwards, confirming a secret update does not disturb the build-time provenance stamp.

Record the exact active version ID as `UNDERSTUDY_V2_FLAGS_OFF_VERSION` in the Phase 2 ledger row and operator record. Also record the deployment ID, approved SHA, status JSON, health result, and attended proof.

**`UNDERSTUDY_V2_FLAGS_OFF_VERSION` = `7eff2d11-2ba5-420b-b1f2-113faf0d6f73`** (deployment `1c32a8e9-bf87-49eb-89a5-253ea4e47d1a`, `2026-07-28T04:29:57Z`). This is the rollback target for every later Understudy configuration deployment.

### Two required secrets were missing

`wrangler secret list` returned only four of the six names: `DEVICE_TOKENS` and `WS_TICKET_SECRET` did not exist. This is exactly what the Phase 2 secret check is for — with `UNATTENDED_ENABLED_TENANTS` at `"[]"` the gap would not have surfaced until Phase 3 tried to enroll a device.

Both were provisioned before the deploy. `wrangler secret put` refuses while an undeployed version exists ("the latest version of your Worker isn't currently deployed"), so `wrangler versions secret put` was used instead, which stages a secret onto a new version without deploying it.

`WS_TICKET_SECRET` is opaque HMAC key material — 32 random bytes, base64url, same treatment as `AUTH_HMAC_SECRET`.

`DEVICE_TOKENS` was populated with the Phase 3 canary identity, since provisioning it needs no physical device:

```json
{ "<sha256hex(credential)>": { "tenantId": "metamind", "deviceId": "<uuid>", "credentialVersion": 1 } }
```

Device UUID `aaf119f2-a85f-46b4-8b53-8e92196d6275`. Only the credential's SHA-256 digest is stored in Cloudflare; the raw credential is at `~/.understudy-canary/device-credential.json`, mode `0600`, for the operator to enter during extension enrollment. Rotating it means generating a new credential, bumping `credentialVersion`, and re-putting the secret.

The initial `v1 → v2` migration is a stop-and-forward-fix boundary. Do not attempt to remove `v2` or roll back to the current `v1` version.

## Phase 3: Provision and accept the canary device

Use one enrolled, tenant-dedicated production profile for acceptance. Build the extension from the same approved Understudy SHA deployed in Phase 2.

### Build and load the extension

Run:

```bash
pnpm --filter @understudy/protocol build
pnpm --filter @understudy/extension typecheck
pnpm --filter @understudy/extension test
pnpm --filter @understudy/extension build
```

Load `apps/extension/.output/chrome-mv3/` through `chrome://extensions`. Do not use a development build.

### Enroll the canary

Provision one device UUID and one raw credential. Store only the credential’s SHA-256 digest in `DEVICE_TOKENS`.

Enroll the dedicated profile with exactly:

- `https://example.com`
- `https://practice.expandtesting.com`

Confirm the device reports:

- Protocol 2
- Expected extension and browser versions
- Capacity 2
- Usage 0
- A recent heartbeat

After the upgraded Metamind connector is live, deploy this Understudy configuration:

```json
{
  "UNATTENDED_ENABLED_TENANTS": "[\"metamind\"]",
  "SAFE_WRITE_REQUIRED_TENANTS": "[\"metamind\"]"
}
```

Do not use `"*"`.

Record the allowlist deployment and version IDs before running acceptance.

### Run the Chromium acceptance suite

Execute every scenario in [`apps/extension/RUNBOOK.md`](../apps/extension/RUNBOOK.md):

- Two-tab routing isolation
- Capacity failure
- Origin collision failure
- Profile-state collision failure
- Redirect containment
- Paused-popup containment
- One-slot cleanup
- Extension service-worker eviction
- Chrome restart
- Unknown write outcome
- Device credential rotation
- Hard and idle expiry
- Attended compatibility

Stop the rollout on any cross-tab routing, duplicate tab, capacity leak, unexpected recovery, origin escape, expiry mismatch, or granted write replay.

### Run the read-only soak

Run the complete 24-hour read-only soak. Do not proceed if any event remains unexplained:

- `command_unknown`
- Duplicate controlled tab
- Capacity leak
- Unexpected browser recovery
- Origin escape
- Hard-expiry or idle-expiry mismatch

Record the device acceptance operator record, extension SHA, Understudy deployment and version IDs, start and end timestamps, telemetry, and final device usage.

## Phase 4: Switch Metamind to unattended and prove governance

Switch only the synthetic canary workflow. FlowSafe remains the approval authority, and Breakwater remains the connector governance and audit boundary.

### Configure and deploy Metamind

Set production Metamind to:

```json
{
  "UNDERSTUDY_SESSION_MODE": "unattended",
  "UNDERSTUDY_DEVICE_ID": "enrolled_canary_uuid_here",
  "UNDERSTUDY_ALLOWED_ORIGINS":
    "[\"https://example.com\",\"https://practice.expandtesting.com\"]",
  "UNDERSTUDY_PROFILE_STATE_KEY": "metamind-practice-account"
}
```

Verify the Phase 1 D1 lease migration before deploying. Do not rerun the additive SQL if the table exists:

```bash
pnpm exec wrangler d1 execute metamind --remote \
  --command "SELECT name FROM sqlite_schema WHERE name='browser_session_leases'"
```

Deploy a clean, approved Metamind `master` SHA through the stamped deployment command. Confirm `/health.commit` equals that full SHA.

### Run the governed unattended proof

The proof must complete every step:

1. Create or replay the unattended lease.
2. Reach connected status without manual tab attachment.
3. Produce both dry-run previews.
4. Suspend at the FlowSafe approval.
5. Prove no real write occurred before approval.
6. Approve with the expected actor and suspension fingerprint.
7. Read the public page.
8. Type the non-secret username.
9. Fill the vaulted password.
10. Observe the authenticated marker.
11. Persist enrichment evidence.
12. Correlate FlowSafe, Breakwater, Metamind audit, Understudy session, and command IDs.
13. Reach a terminal workflow state.
14. Confirm `DELETE` reaches `204`.
15. Confirm device usage returns to zero.
16. Confirm the lease row reaches `released`.

Fail the gate if the run retries an unknown outcome, writes before approval, loses audit correlation, or leaves a stale lease.

### Store the proof evidence

Store the proof artifact with mode `0600`. It must contain no raw credentials, tokens, secret values, password text, or credential-bearing URLs.

Record:

- Artifact path and SHA-256 hash
- Proof start and end timestamps
- Understudy and Metamind full release SHAs
- Both deployment IDs
- Both version IDs
- D1 migration evidence
- Session, command, workflow, run, approval, and audit correlation IDs
- Final lease state and device usage

Update the Phase 4 ledger row in the same evidence pull request.

## Phase 5: Ramp allowlisted production traffic

Add a real website only when its exact origin appears in both Metamind’s source-controlled allowlist and the extension enrollment. Do not use `"*"` or dashboard-only configuration.

Keep execution sequential while all workflows use `metamind-practice-account`. The shared profile-state key is an intentional account-concurrency fence.

### Stage 1: Run one record

Run one operator-selected production record. Observe it for 2 hours.

### Stage 2: Run five records

After Stage 1 passes, run five production records sequentially. Observe them for 8 hours.

### Stage 3: Enable all reviewed origins

After Stage 2 passes, enable all traffic for the reviewed allowlisted origins. Observe it for 24 hours.

### Apply every ramp gate

Require all conditions at each stage:

- No unexpected unknown write
- No retry after an unknown outcome
- No write before approval
- No stale `minting`, `active`, or `cleanup_pending` lease after a terminal workflow
- Device usage returns to zero
- No origin-policy rejection for an approved origin
- No cross-tab routing
- No duplicate controlled tab
- No unexpected browser recovery
- Correct FlowSafe decision and Breakwater audit correlation
- Expected session creation, provisioning, release, and expiry telemetry
- No material increase in Worker error rate or handler duration

Before each stage, record the comparison interval and numeric error-rate and handler-duration thresholds. Do not choose a threshold after observing the stage.

Record the Analytics Engine result with this query:

```sql
SELECT
  blob1 AS event,
  blob2 AS outcome,
  count() AS total
FROM understudy_telemetry
WHERE timestamp > NOW() - INTERVAL '1' DAY
GROUP BY event, outcome
ORDER BY event, outcome
```

Run the query through the [Analytics Engine SQL API](https://developers.cloudflare.com/analytics/analytics-engine/sql-api/). Preserve the query, UTC interval, raw result, and operator interpretation with each stage’s evidence.

Do not advance a stage on an unexplained anomaly. Set the current gate to `Blocked`, attach the evidence, and either fix forward or execute rollback.

## Phase 6: Close the rollout

Close the rollout only after the all-allowlisted 24-hour soak passes.

1. Leave `UNATTENDED_ENABLED_TENANTS=["metamind"]`.
2. Leave `SAFE_WRITE_REQUIRED_TENANTS=["metamind"]`.
3. Do not switch either flag to wildcard enablement.
4. Fill every ledger field with full SHAs, CI URLs, deployment and version IDs, D1 evidence, device acceptance, telemetry, proof artifacts, and UTC timestamps.
5. Verify the recorded rollback version still exists among Cloudflare’s available Worker versions.
6. Mark Phase 6 `Passed`.
7. Move optional future work into separate issues.

Do not convert a failed release gate into a TODO.

## Roll back safely

Migration `v2` is additive and irreversible. Cloudflare blocks rollback when a Durable Object class lifecycle change separates the active and target versions. The current migration-`v1` production version is therefore not a valid rollback target after `v2` deploys. See [Cloudflare Worker rollback constraints](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/).

Execute rollback in this order:

1. Switch Metamind back to `UNDERSTUDY_SESSION_MODE=attended`.
2. Roll Understudy back to `UNDERSTUDY_V2_FLAGS_OFF_VERSION`, or redeploy its exact approved source state.
3. Confirm new unattended leases are disabled.
4. `DELETE` every active unattended lease and poll each `202` until `204`.
5. Let the durable sweeper retain and retry unresolved cleanup.
6. Preserve migration `v2`, coordinator data, audit evidence, and unknown-outcome records.
7. Never replay a command with an unknown external outcome.
8. Rerun the attended production proof.
9. Mark affected ledger gates `Rolled back` with deployment IDs, evidence, UTC time, and owner.

Use the recorded version ID:

```bash
UNDERSTUDY_V2_FLAGS_OFF_VERSION="version_uuid_here"
pnpm --filter @understudy/backend exec wrangler rollback \
  "$UNDERSTUDY_V2_FLAGS_OFF_VERSION" \
  --message "rollback to migration-v2 flags-off baseline"
pnpm --filter @understudy/backend exec wrangler deployments status --json
```

If Cloudflare refuses the rollback, stop. Confirm the version’s exports, migrations, and bindings. Fix forward from migration `v2`; never remove its Durable Object classes.

Rollback is complete only when attended proof passes, no new unattended lease can start, all resolvable leases reach `released`, and unresolved leases remain durable with alerts.

## Verify implementation changes

Run the full Understudy checks for any Understudy implementation or configuration change:

```bash
pnpm build
pnpm typecheck
pnpm test
git diff --check
```

Run the Metamind Worker lane for every Metamind implementation or configuration change:

```bash
pnpm --filter @repo/worker typecheck
pnpm --filter @repo/worker test
pnpm exec biome check packages/worker
node packages/worker/scripts/enrich-browser-runbook.mjs --self-test
pnpm build
bash scripts/validate-build.sh
git diff --check
```

The required automated scenarios are:

- Attended creation sends no request body and works with old and new Understudy backends
- Unattended creation validates exact origins, device UUID, profile key, idempotent replay, `202` polling, terminal status, and timeout
- Attended responses contain `webSocketUrl`; unattended responses omit it
- Pending commands poll the same ID
- Not-started retries reuse the logical key
- Unknown outcomes never retry
- Timed-out writes never retry automatically
- Crashes after mint intent, Understudy creation, FlowSafe start, terminal cleanup, and compare-and-clear converge without losing or double-releasing a lease
- Cleanup handles `DELETE 202 → 204`, transient `5xx`, and terminal workflow states
- The proof-runner self-test covers both modes
- `/health.commit` matches the deployed full SHA
- Existing Metamind and Understudy tests remain green

## Preserve rollout decisions

These decisions remain in force until a reviewed change updates this runbook:

- **Canonical runbook**: Keep execution details here so the technical plan remains a conceptual architecture document
- **Metamind proof**: Require a real governed consumer to prove FlowSafe, Breakwater, audit correlation, and cleanup together
- **Attended toggle**: Preserve it until rollout closes so consumer rollback does not depend on unattended recovery
- **Exact origin allowlists**: Keep Metamind and extension policy reviewable and identical
- **Durable D1 cleanup**: Use persisted leases and the existing maintenance cron so Worker crashes cannot lose cleanup work
- **Staged ramp**: Use `1 → 5 → all` to constrain blast radius and require evidence between stages
- **Source-controlled variables**: Make each production configuration reviewable and reproducible
- **Migration-`v2` baseline**: Establish a flags-off version because Cloudflare cannot roll back across the class lifecycle change

The rollout rejected:

- **Immediate unattended-only cutover**: It removes the attended recovery path before unattended proof exists
- **Best-effort cleanup**: Idle expiry cannot replace durable ownership and explicit release
- **Arbitrary record origins**: Dynamic policy would bypass source review and extension enrollment
- **Wildcard tenant enablement**: It expands the failure domain beyond the proven consumer
- **Dashboard-only configuration**: It breaks reproducibility and review
- **Direct rollback to migration `v1`**: Cloudflare blocks the incompatible Durable Object lifecycle rollback

## Keep excluded work out of the rollout

Do not add these features while executing this runbook:

- Automated extension distribution or enrollment
- Dynamic fleet or origin-policy administration
- Cross-tenant profiles
- Storage isolation between tabs in one profile
- More than two controlled tabs per device
- New browser providers
- Local daemons
- Automatic URL restoration
- New package releases unless package code changes
- Changes to Metamind’s primary intake workflow
- Any Gmail send path

These exclusions do not waive release gates or permit temporary unsafe behavior.

## Appendix: current-state anchors

These anchors pin the initial edit targets. Understudy snippets are from `e4b98e6824b2dbee078a7c57da37a11f389010b9`. Metamind snippets are from `ee94790ddf92b8fabebba10a502e76005a57e17d`. Re-read each file and symbol before editing because line numbers and surrounding code will drift.

### Release flow is complete

`README.md`, `Release published packages`:

```markdown
1. Merge `Version Packages` into `dev`.
2. Verify the versioned `dev` commit.
3. Open and merge a promotion pull request from `dev` to `master`.
```

This supports the Phase 0 decision to avoid another package release unless package code changes.

### Understudy distinguishes attended creation by an absent body

`apps/backend/src/index.ts`, `POST /v1/sessions`:

```typescript
if (c.req.raw.body === null) {
```

Metamind currently violates that contract in `packages/worker/src/intake/browser-connectors.ts`, `createBrowserSession`:

```typescript
headers: {
  "content-type": "application/json",
  authorization: `Bearer ${config.UNDERSTUDY_TOKEN}`,
  "idempotency-key": idempotencyKey,
},
body: "{}",
```

Implement attended mode with no `body` property and no `content-type` header. Implement unattended mode with the JSON body and header.

### Metamind uses older client packages

`packages/worker/package.json`:

```json
		"@understudy/connector": "^0.4.0",
		"@understudy/protocol": "^0.6.0",
```

Upgrade these dependencies to the Phase 1 versions and update the lockfile.

### The enrichment route always exposes an attended socket

`packages/worker/src/routes/intake.ts`, `POST /records/:id/enrich-website`:

```typescript
return c.json(
  {
    workflowId: LEAD_ENRICH_BROWSER_WORKFLOW_ID,
    ...started,
    webSocketUrl: browserWebSocketUrl(c.env, started.sessionId),
  },
  202,
);
```

Replace this shape with the mode-discriminated response from Phase 1.

### Durable recovery has a reusable pattern

`packages/worker/src/intake/resume-recovery.ts`, resume sweep:

```typescript
		const parked = await listResumeRecoveries(env.DB);
		for (const entry of parked) {
			try {
				await enqueueJobs(env, [
					{
						kind: "resume",
						recordId: entry.recordId,
						record: entry.record as ApprovalRecord,
						attempt: 1,
					},
				]);
				await clearResumeRecovery(env.DB, entry.recordId, entry.recordJson);
```

Reuse its durable marker, retry containment, and compare-and-clear pattern for browser-session leases.

### Metamind deployment provenance is not stamped

Both Metamind Wrangler configurations currently contain:

```json
		"VERSION": "0.0.0-dev",
		"COMMIT": "local",
```

The live Worker also reports `COMMIT=local`. Phase 1 must replace this deployment path before unattended proof evidence is accepted.

### Understudy source and production infrastructure differ

`apps/backend/wrangler.jsonc` declares:

```json
{ "name": "DEVICE", "class_name": "DeviceAgent" },
{ "name": "TENANT_CONTROL", "class_name": "TenantDeviceCoordinator" }
```

It also declares:

```json
{
  "tag": "v2",
  "new_sqlite_classes": ["DeviceAgent", "TenantDeviceCoordinator"]
}
```

The production baseline remains on migration `v1` with only `SessionAgent`. This difference makes Phase 2 the first infrastructure deployment and makes the `v2`, flags-off version the first safe rollback target.
