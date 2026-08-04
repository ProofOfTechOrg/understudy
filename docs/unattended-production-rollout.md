<!-- Content type: How-to -->

# Finish the protocol-3 production rollout

This runbook defines the release sequence after PR #24 merged the protocol-3 implementation into `dev`. Source integration and the local automated checks are complete. The first automatic staging deployment stopped before upload because the `staging` GitHub environment had no `CLOUDFLARE_API_TOKEN`; no staging Worker change occurred. Staging credentials and provisioning, network disruption tests, publishing, production changes, destructive cleanup, canary acceptance, and the HTTPS Strict Transport Security (HSTS) apex rollout still require operator action.

## Handoff baseline

Use this table to establish the source and environment before you act:

| Field | Recorded value |
| --- | --- |
| Integration branch | `dev` |
| Integration pull request | PR #24, merged 2026-08-04 |
| Feature head | `414aa35d30115e5e157d81e1abe3add88dfe9e21` |
| Integration merge | `a35b8221111df6757ec6d87745cd7110e804536e` |
| Historical comparison base | `origin/dev` at `857e0e3ebb8312be3e260e7339968f602703afdf` |
| Semantic tranche base | `554a09c53dd4a9b64755da38d0260d4da37fa3d2` (`feat: add guarded deployment workflow`) |
| Release source | Current `origin/dev`; refresh it and resolve with `git rev-parse origin/dev` before acting |
| Node.js | 24.16.0; repository minimum is 22 |
| pnpm | 11.5.2; the root manifest pins this version |
| Production state last inspected | 2026-08-04 for HTTP/HTTPS health; DNS inventory remains from 2026-08-02; refresh every external value before acting |

The merged stack includes the local card-vault requirements, protocol-3/card-vault implementation, guarded deployment workflow, and semantic-elements tranche. Do not split or rebase this stack onto the historical remote ref without re-running the compatibility review. Do not deploy a dirty tree or a later unreviewed commit.

## Implemented release

The coordinated release contains these versions:

| Artifact | Target |
| --- | --- |
| `@understudy/protocol` | 0.9.0; wire protocol 3 |
| `@understudy/connector` | 0.6.0 |
| Extension | 0.2.0 |
| Backend | 0.2.0 |

The implementation removes the cloud vault, `fill_secret`, both MCP secret tools, legacy `usk_v1` acceptance, and OAuth grants without current device binding. It adds browser-bound authentication, direct extension pairing, versioned origin policy, suspended lease adoption, physical-window convergence, attended `idle`, provenance reporting, HSTS response headers, the extension-local payment-card vault, and bounded semantic-element capture, search, inspection, continuation, deltas, and live ref validation.

No cloud-vault values migrate into the local card vault. Users must enroll cards again in the extension.

## Verified local gates

These results apply to the source code in this branch. A code or configuration change invalidates the relevant result.

| Gate | Evidence | State |
| --- | --- | --- |
| Unit and integration tests | 2026-08-04: 783 tests; protocol 52, connector 29, extension 307 plus 3 release integration tests, backend 383 plus 9 deployment integration tests | Passed |
| Typecheck and build | `pnpm typecheck` and `pnpm build` after all review fixes | Passed |
| Dependency audit | 2026-08-04: 0 critical/high; 2 moderate and 2 low transitive advisories remain | Passed release threshold |
| Local Chrome end-to-end | Vault restart, Chrome DevTools Protocol submission, worker-eviction recovery, deletion, and synthetic-marker non-egress | Passed |
| Store package | Pre-workflow `0.2.0` artifact SHA-256 `3b492a1608131088c607e5254317708165e8785c67ee73c393c40578fff9b54f` | Superseded; rebuild after the deployment changes |
| Wrangler | Generated types current; deployment dry run completed without upload | Passed |
| Review lanes | Independent clean-code, architecture, and quality-assurance reviews returned clean after fixes | Passed |
| Integration workflows | PR #24 and post-merge CI passed; Version run `30883763357` opened release PR #25 | Passed |
| Automatic staging deployment | Run `30883763461` passed install, build, typecheck, tests, Worker types, extension verification, and dry run, then failed before upload because the `staging` environment had no `CLOUDFLARE_API_TOKEN` | Blocked; no staging mutation |
| Network baseline | Test A 10s and 30s passed; Test A 60s and 120s plus Test B 30s remain | Partial |
| Production HSTS | 2026-08-04 probes found no HTTP upgrade and no HTTPS HSTS header; the 2026-08-02 DNS inventory found no apex address record | Pending |
| Cloud-vault cleanup | No values, namespace, or production secrets were deleted | Pending |

The store ZIP is ignored build output. Rebuild it from the merged release commit and record its new size and SHA-256 before submission.

## Follow the release sequence

Complete the remaining work in this order:

| Step | Action | Required authority or input | Completion evidence |
| ---: | --- | --- | --- |
| 1 | Run the remaining pre-fix network baseline | No active soak; caller credential; exact device and origin; approval immediately before firewall or Tailscale mutation | Mode-0600 JSONL evidence outside Git |
| 2 | Apply the deterministic reconnect result | Baseline evidence from step 1 | Selected branch recorded; any required code change reviewed and verified |
| 3 | Add the missing staging-scoped `CLOUDFLARE_API_TOKEN`, provision staging, and rerun the automatic deployment; PR #24 is already merged | Staging GitHub-environment and Cloudflare authority | Scoped token present, staging secrets provisioned, merge SHA, and verified automatic deployment evidence |
| 4 | Verify staging with the pinned staging extension | Staging account and dedicated Chrome profile | Pairing, OAuth/MCP, and hosted-control evidence |
| 5 | Publish protocol 0.9.0 and connector 0.6.0 | Package-registry release authority | Registry versions and package integrity values |
| 6 | Build, submit, and publish extension 0.2.0 | Chrome Web Store authority | Submitted ZIP, normalized content digest, published status, and source SHA in `store-release.json` |
| 7 | Promote `dev` to `master` with production automation disabled | Repository write authority | Production gates pass and deployment reports disabled |
| 8 | Deploy the protocol-3 compatibility backend manually | Production Cloudflare authority; validated mode-0600 inputs | Deployment evidence with matching source SHA and three matching health reads |
| 9 | Enable routine production deployment | Production GitHub environment authority | `PRODUCTION_AUTODEPLOY_ENABLED=true` after verified cutover |
| 10 | Upgrade the Metamind canary consumer and extension | Canary host and browser access | Version inventory and healthy control connection |
| 11 | Execute the authentication and cloud-vault hard cut | Declared maintenance window and fresh destructive confirmation | Epoch evidence, revoked credentials, deleted vault inventory, removed secrets |
| 12 | Re-pair browsers and reconnect MCP clients | Account owners and active browser profiles | New device-bound credentials and successful `tools/list` |
| 13 | Run canary security and lifecycle acceptance | Synthetic card only; approved test origin | Sanitized canary evidence with no marker egress |
| 14 | Run the post-fix network matrix | Same authority as step 1 | Recovery and lease evidence for all three cases |
| 15 | Complete expiry, soak, and traffic ramps | Production monitoring and rollback owner | 15-minute expiry, governed proof, soak, and ramp ledgers |
| 16 | Finish apex HTTPS and HSTS preload | DNS, TLS, Cloudflare zone, and preload submission authority | HTTPS inventory, staged headers, preload eligibility, and pending or preloaded status |

Do not combine steps 8 and 11 into one unobserved change. First prove that the compatibility deployment is healthy. Then start the separately confirmed hard-cut window.

The GitHub `staging` environment exists, but its environment-secret inventory was empty when checked on 2026-08-04. Restrict it to `dev`, add a `CLOUDFLARE_API_TOKEN` secret scoped only to the staging Worker and its required resources, then provision the six staging Worker secrets with the backend command documented below. The separate `production` environment also exists with an empty secret inventory; restrict it to `master`, add a production-scoped token before deployment, and leave `PRODUCTION_AUTODEPLOY_ENABLED=false` until step 9. Never reuse either deployment token or any Worker runtime secret across targets.

## Run the remaining network baseline

Read `docs/network-blip-rollout-handoff.md` before running the harness. Confirm that no production soak is active. Ask for approval immediately before each firewall or Tailscale change.

Keep credentials and raw evidence outside Git. Both files must use mode `0600`.

```bash
export UNDERSTUDY_DEVICE_ID="00000000-0000-4000-8000-000000000001"
export UNDERSTUDY_TEST_ORIGIN="https://allowed.example"
export UNDERSTUDY_SOAK_CONFIRMED_INACTIVE=yes

scripts/network-blip-harness.sh a 60 \
  /absolute/private/caller-token.json \
  /absolute/private/network-blip.jsonl
scripts/network-blip-harness.sh a 120 \
  /absolute/private/caller-token.json \
  /absolute/private/network-blip.jsonl
scripts/network-blip-harness.sh b 30 \
  /absolute/private/caller-token.json \
  /absolute/private/network-blip.jsonl
```

Apply exactly one result:

1. If any Test A recovery exceeds 30 seconds or loses its lease, make `chrome.alarms` authoritative for both WebSocket retry paths. Persist desired state, retry deadline, and bounded backoff. Retain `setTimeout` only for acceleration below 30 seconds.
2. If every Test A case recovers within 30 seconds but Test B exceeds 30 seconds or has a worse lease outcome, keep only `https://understudy.proofof.tech`. Request a fresh connect ticket on every durable alarm, discard stale socket attempts, and treat the ticket request as the connectivity and Domain Name System (DNS) probe.
3. If every baseline case recovers within 30 seconds, run sustained backgrounding with Chrome occluded and no local interaction. Fix the first failed layer shown by evidence.

Do not add a secondary control origin. If step 2 requires code changes, or step 3 exposes a defect, rerun the full repository gate and all three independent review lanes before merge.

## Merge and publish the source artifacts

Before merge, require continuous integration or rerun this exact gate at the release head:

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm --filter @understudy/extension test:e2e
pnpm --filter @understudy/extension build:store
pnpm --filter @understudy/extension zip:store
cd apps/backend
pnpm exec wrangler types --check
pnpm exec wrangler deploy --dry-run
```

Use `.changeset/protocol-three-hard-cut.md` with the repository’s Changesets release flow. Confirm that the registry contains protocol 0.9.0 and connector 0.6.0 before upgrading consumers.

After the staging checks and Version Packages merge, rebuild the Chrome Web Store package from the exact final `dev` commit. Submit that ZIP and wait for Web Store ID `lbmbdjjaodgipnleaggclnobbijpadee` to report `published`. Run `record:store-release` with the build commit, commit the resulting marker on `dev`, then promote `dev` to `master`. Do not use the staging extension ID for production pairing.

## Deploy the compatibility backend

Prepare four absolute paths outside the repository:

- A new evidence path that does not exist
- A mode-0600 protocol-3 `DEVICE_TOKENS` JSON file
- A mode-0600 file containing the published extension ID
- A mode-0600 file containing the current canary device credential

Every static device entry must contain authoritative `allowedOrigins` and `policyVersion`. The deploy script validates the schema, source cleanliness, pnpm version, lockfile, canary credential digest, and immutable worktree before it asks for confirmation.

Run the guarded deployment from the repository root:

```bash
pnpm --filter @understudy/backend deploy:production -- \
  /absolute/private/deployment-evidence.json \
  /absolute/private/device-tokens.json \
  /absolute/private/extension-id.txt \
  /absolute/private/canary-device-credential.txt
```

Type `DEPLOY` only after the script identifies the intended full source SHA. The script uploads validated `DEVICE_TOKENS` and `EXTENSION_ID`, deploys with a full-SHA tag and message, then requires three consecutive `/health` responses that match the source commit.

Preserve the generated mode-0600 evidence outside Git. It separates the source release, compatibility-secret version, active Worker version, active deployment, dependency snapshot, and any secret-derived version.

## Upgrade and verify the canary

Upgrade the canary consumer to the published connector and protocol versions. Install the published extension 0.2.0 in the canary browser profile.

Verify these compatibility-deployment properties before the hard cut:

- `/health` reports the deployed source SHA, Worker version ID, and deployment timestamp
- `fill_secret`, cloud-vault routes, and retired MCP tools fail closed
- Existing non-secret attended reads continue where temporary protocol compatibility allows them
- The canary device connects only to `https://understudy.proofof.tech`
- Device inventory reconciles before the backend allocates new work
- `device_hello` advertises `semantic-elements-v1` before the backend enables
  semantic MCP tools for the canary
- `tools/list` exposes input and output schemas for `browser_snapshot`,
  `browser_find`, `browser_inspect`, and `browser_snapshot_next`
- Structured output, compact fallback text, find, inspect, continuation,
  same-document deltas, and stale-ref recovery work in both ChatGPT and Claude

Stop here if the source SHA, active deployment, or canary inventory differs from the recorded evidence.

## Execute the authentication and vault hard cut

Declare a maintenance window. Resolve the exact affected account, OAuth grant, token, secret, and KV namespace inventory before requesting destructive confirmation. Never include credential or vault values in the evidence.

Set the one-time authentication latch from `apps/backend`:

```bash
printf '%s' 'protocol-3-auth-hard-cut' | \
  pnpm exec wrangler secret put AUTH_EPOCH_CUTOVER
```

Trigger an authenticated account-directory request. Verify that the durable cutover marker exists through behavior: every old `usk_v1`, old-epoch `usk_v2`, and pre-cutover OAuth grant must fail. A secret-version creation alone does not prove the Durable Object migration ran.

List provider grants through the dashboard, revoke the pre-cutover grants, and revoke old API tokens. Confirm that device revocation invalidates bound access immediately even if OAuth KV cleanup has not completed.

Remove the latch only after cutover evidence is complete:

```bash
pnpm exec wrangler secret delete AUTH_EPOCH_CUTOVER
```

Inventory the retired vault namespace before deletion:

```bash
pnpm exec wrangler kv namespace list
pnpm exec wrangler kv key list \
  --namespace-id retired_vault_namespace_id \
  --remote
```

Replace `retired_vault_namespace_id` with the exact ID returned by the namespace inventory.

Request fresh destructive confirmation that names the exact namespace ID, key count, and these two production secrets:

- `VAULT_MASTER_KEY`
- `VAULT_UPLOAD_PRIVATE_KEY`

Delete only the inventoried vault keys. Delete the namespace only if the read-only inventory proves it serves no other binding or application. Do not use a wildcard or reuse the OAuth KV namespace.

After the confirmed deletion, remove the retired secrets:

```bash
pnpm exec wrangler secret delete VAULT_MASTER_KEY
pnpm exec wrangler secret delete VAULT_UPLOAD_PRIVATE_KEY
```

Record secret-derived Worker version IDs separately from the source deployment. Confirm that no dashboard vault route, upload key, vault KV binding, or server secret resolver is reachable after cleanup.

## Re-pair browsers and reconnect MCP clients

Re-pair each intended browser profile through the dashboard’s one-time external-messaging flow. A re-paired existing installation must rotate its device row and credential. A genuinely new Chrome profile must create a separate device.

For every browser:

- Set its authoritative general origins and wait for the exact policy acknowledgement
- Set payment origins locally in the extension; never copy them to the backend
- Create API tokens only after selecting that active browser
- Complete new OAuth consent with S256 Proof Key for Code Exchange (PKCE) and the selected browser
- Confirm device label and revocation state in API-token and OAuth-connection lists

For ChatGPT, copy the canonical `/mcp` URL and open [ChatGPT Plugins](https://chatgpt.com/plugins). For Claude, copy `/mcp` and follow [Claude’s custom connector flow](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp). Keep command-line and JSON client configuration available for other clients.

Exercise signed-out login, consent, cancellation, expired state, unsupported-client rejection, metadata refresh, and `tools/list` in the real clients. Do not treat backend unit tests as evidence that the external client user interface completed these flows.

## Run canary acceptance

Use a synthetic card marker and an approved test payment origin. Never use a real payment card for release acceptance.

The canary must pass:

- Pairing replay, expiry, concurrent redemption, credential rotation, and empty default origins
- Online and offline policy changes, stale acknowledgement rejection, and policy widening only after acknowledgement
- Known and ambiguous provisioning failures, close retry, late provision, orphan redelivery, and physical divergence
- Same-epoch recovery, new-epoch adoption, capacity conflict, 15-minute expiry, worker eviction, and full Chrome restart
- Attended deliberate detach, debugger detach, stale attachment rejection, and `idle` artifact clearing
- Bounded semantic capture on a 10,000-element page, offscreen find,
  same-process iframe, OOPIF, shadow DOM, custom click handlers, pagination,
  deltas, worker eviction, and replaced-target rejection
- Vault enrollment, restart persistence, key loss, corruption, deletion, exact-origin intersection, and split or combined expiry mapping
- Pre-fill `not_started`, post-fill `outcome_unknown`, and tab closure on every sensitive completion path
- Revoked browser, old epoch, old OAuth props, legacy token, retired route, retired command, and retired MCP-tool rejection

After the first synthetic card byte enters the page, attempt every documented
egress path: semantic capture, legacy accessibility capture, screenshot,
dialogs, URL and title, tab metadata, console, exception, network capture,
runtime evaluation, clipboard, download, crash report, WebSocket frame,
command journal, analytics, and logs. The marker may appear only inside the
executor and approved page.

Stop on any marker egress, page-derived sensitive result, automatic retry after insertion, duplicate window or lease, stale detach acceptance, or credential surviving device revocation.

## Run post-fix network and soak acceptance

After the selected reconnect change and canary upgrade, run:

```bash
scripts/network-blip-harness.sh a 30 \
  /absolute/private/caller-token.json \
  /absolute/private/network-blip-post-fix.jsonl
scripts/network-blip-harness.sh a 120 \
  /absolute/private/caller-token.json \
  /absolute/private/network-blip-post-fix.jsonl
scripts/network-blip-harness.sh b 30 \
  /absolute/private/caller-token.json \
  /absolute/private/network-blip-post-fix.jsonl
```

Each case must recover within 30 seconds, produce a newer heartbeat, preserve or recover the exact lease without duplication, reach terminal cleanup, restore capacity, and send no credential to a secondary origin.

Then complete these production proofs:

1. Let a suspended lease reach the exact 15-minute adoption expiry and verify terminal `lost` plus exact orphan cleanup.
2. Run the declared unattended soak with Chrome occluded and no local interaction.
3. Complete the governed unattended proof with the release monitoring active.
4. Ramp 1 record, then 5 records, then the full approved origin set.

Record start and end times, source SHA, Worker version, extension version, device ID, policy version, lease outcomes, and stop-condition checks. Keep raw evidence outside Git.

## Finish HTTPS, HSTS, and preload

The last read-only inventory on 2026-08-02 found MX and TXT records at the apex, mail-related subdomains, and proxied hosts for Understudy, Metamind, Momo, and Dubai Parking. The apex had no A, AAAA, or CNAME record. Treat this as stale evidence and refresh the complete zone before changing HSTS.

Complete the apex rollout in stages:

1. Inventory every apex and subdomain record, including DNS-only, internal, mail, redirect, and delegated names.
2. Give `proofof.tech` valid DNS, TLS, and an HTTP-to-HTTPS redirect.
3. Make every hostname serve valid HTTPS for its intended route.
4. Enable Cloudflare zone-wide Always Use HTTPS for proxied hosts.
5. Ramp apex HSTS through 5 minutes, 1 day, 1 week, and 1 year. Record the start, end, and probe results for each stage.
6. Add `includeSubDomains; preload` only after every hostname passes.
7. Submit `proofof.tech` to [HSTS Preload](https://hstspreload.org/).

Run these probes after each relevant stage:

```bash
curl -sSI http://understudy.proofof.tech/health
curl -sSI https://understudy.proofof.tech/health
curl -fsS https://understudy.proofof.tech/health
curl -fsS \
  'https://hstspreload.org/api/v2/preloadable?domain=proofof.tech'
curl -fsS \
  'https://hstspreload.org/api/v2/status?domain=proofof.tech'
```

Done means HTTP upgrades at the edge, every HTTPS response carries the intended HSTS policy, health matches the deployed SHA, preload eligibility reports no errors, and preload status becomes pending or preloaded.

An `includeSubDomains` header on `understudy.proofof.tech` does not affect sibling hosts. Preload submission requires the registrable apex and every descendant to meet the HTTPS contract.

## Record final evidence

Close the handoff only after the operator records:

- Pull request URL and merge SHA
- Published protocol and connector versions plus integrity values
- Extension artifact SHA-256, submitted version, review state, and published ID
- Pre-fix and post-fix network JSONL evidence paths and sanitized verdicts
- Deployment source SHA, Worker version ID, active deployment, secret-derived versions, pnpm version, and lockfile SHA-256
- Authentication epoch cutover evidence and old-credential rejection results
- Exact vault namespace and key counts before and after deletion; never record values
- Re-paired device IDs, labels, policy versions, and revoked predecessor state
- Real-client OAuth and `tools/list` results
- Canary, 15-minute expiry, soak, governed proof, and traffic-ramp verdicts
- DNS inventory, HTTPS probes, HSTS stage dates, preload eligibility, and final preload status

## Stop and rollback safely

Stop the rollout on any credential surviving revocation, policy widening before acknowledgement, duplicate lease or window, card marker outside the local executor and approved page, non-fixed sensitive result, unmatched health SHA, failed HSTS probe, or substantive review finding.

Rollback must not restore `fill_secret`, cloud-vault routes, `usk_v1`, pre-cutover OAuth props, or a secondary credential-bearing origin. Disable new leases, terminalize or suspend active assignments with exact fences, preserve external evidence, and fix the failing release layer.

## Keep deferred features out of this release

`DEFERRED.md` records a future API-credential vault. It requires separate records, reviewed service adapters, and its own security review. It is not a protocol-3 release blocker and must not reuse the card-vault plaintext interfaces.

The card-vault requirements record that persisted card verification values conflict with PCI SSC FAQ 1574. This handoff makes no compliance determination and adds no QSA or counsel rollout gate.
