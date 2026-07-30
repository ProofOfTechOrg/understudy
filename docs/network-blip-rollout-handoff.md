<!--
Content type: Reference
Goal: Let a fresh session resume the unattended rollout without repeating the investigation or overstating incomplete evidence.
Audience: The engineer implementing the recovery fixes and the canary operator running production acceptance.
Content plan: Record the baseline, evidence, open hypotheses, defects, required fixes, execution order, reuse map, exclusions, and verification.
Open questions: Which recovery mechanism fails at longer outages; whether DNS-specific recovery differs; whether sustained backgrounding contributes; the adoption-window service-level objective.
-->

# Resume the unattended rollout without repeating the network-blip investigation

This handoff records the exact rollout state on 2026-07-30, the evidence gathered so far, every defect that should be fixed, and the remaining execution order. A fresh session should be able to continue from this file without re-deriving the incident or asking the canary operator to repeat completed work.

## Start from this baseline

The repository and production state below were rechecked before this handoff. Line numbers in this file are as of the Understudy baseline and must be re-confirmed before editing.

| Surface | Baseline |
|---|---|
| Understudy source | `dev` at `b5a1e8100c200d683a736eb7589f8ed5babb4761`; refreshed `origin/dev` matches |
| Understudy worktree before this handoff | Clean |
| Understudy production source release | `3493b243c0aa61fb06ec19ad5dcb4eb197a2d670`, version `e0673967-0ca5-4cca-81ee-50d4088cec33` |
| Active Understudy production | Deployment `7eeb9775-ae36-4d99-8cf0-832e9f334a8c`, version `ca459527-145d-4765-b170-8cb72ef6b789`, created by a secret change at `2026-07-29T05:06:20Z` |
| Production code identity | Active and source-release versions share script etag `12488be988cde6fcff10c45ee41a9e6fa1b3c43bfe450e149c8ab68c999ed3c1` |
| Production rollout flags | `UNATTENDED_ENABLED_TENANTS=["metamind"]`; `SAFE_WRITE_REQUIRED_TENANTS=["metamind"]` |
| Extension | Production build `0.1.1`, loaded in Chrome `150.0.0.0` |
| Canary device | `aaf119f2-a85f-46b4-8b53-8e92196d6275`, credential version 2 |
| Device state at `2026-07-30T18:06:17Z` | `online`, capacity 2, used 0, fresh heartbeat |
| Metamind consumer | `master` at `b70c40e39b74a98f79199634a5390d32610b180e`; refreshed `origin/master` matches |
| Rollout | Phase 3a passed 15 of 16 scenarios; only elapsed expiry remains. Phase 3b has no active soak and must restart from zero after this work |

The active version differs from the allowlist version because device-credential rotation created secret-derived versions. The script etag and both rollout flags match the allowlist release. Record both the source-release version and the current active version in future ledger updates.

Operator credentials live under `~/.understudy-canary/` with mode `0600`. Never copy their values into a repository, test log, issue, or chat transcript.

The persistent Test A harness is outside the repository:

| Artifact | State |
|---|---|
| Script | `~/.understudy-canary/network-blip-test-a.sh`, mode `0700` |
| Script SHA-256 | `b86623312e2622f70a6fa6b9269a9c78cd8d32bd602a34ecfe5333ef60a5bd48` |
| Evidence | `~/.understudy-canary/network-blip-test-a.jsonl`, mode `0600` |

The harness reads the caller token without printing it, resolves current A and AAAA records, installs tagged IPv4 and IPv6 `OUTPUT` rejection rules, restores and verifies those rules under traps, persists the idempotency key before creation, replays it after a failed create response, waits for a post-break `lastSeenAt` value that differs from the pre-break value, and cleans up the session. The harness is operator-local evidence, not a canonical repository tool.

Nested `codex` review processes could not initialize in the restricted filesystem, so the harness received three explicitly separated in-session reviews. Those reviews found and fixed silent firewall-rule removal failure and the possibility of losing an allocated session after an ambiguous create response. The remaining pre-block observation pause is an operational usability fix, not a firewall-safety gap.

## Resume at three remaining baseline runs

Complete the baseline diagnosis before changing deployed extension or backend behavior. The remaining operator work is exactly three runs:

1. Test A at 60s
2. Test A at 120s
3. Test B once at 30s

Do not expand Test B into all four Test A durations. One 30s DNS-reconfiguration run crosses a heartbeat interval and is enough to compare the actual trigger with the already valid 30s pure-egress result.

If code changes, schedule one separate post-fix batch of three runs: Test A 30s, Test A 120s, and Test B 30s. If every baseline network test returns within 30s, schedule one sustained-backgrounding observation instead of inventing more outage durations. Tell the operator which batch is starting before asking for browser work.

Before the next run, add an explicit pre-block pause to the operator-local harness. Session creation opens a Chrome window that can cover the extension card. The pause must happen after session provisioning and before firewall changes, so the operator can make the card visible and then press Enter. Once the harness reports connectivity blocked, the operator must not click, move, focus, or inspect any Chrome window.

Do not open the service-worker DevTools link during the primary test. Inspecting the worker changes the condition by keeping it active. Observe only whether the `chrome://extensions` card changes to `service worker (Inactive)`.

Run the remaining Test A cases with:

```bash
~/.understudy-canary/network-blip-test-a.sh 60
~/.understudy-canary/network-blip-test-a.sh 120
```

Test B needs a sibling harness before involving the operator. Reuse Test A’s creation, polling, evidence, trap structure, and lease cleanup. Replace the firewall disruption with `sudo tailscale down`, a 30s wait, and `sudo tailscale up`. Its exit traps must always attempt `sudo tailscale up`.

After the three runs, select one recovery branch:

| Result | Decision |
|---|---|
| Test A slows or fails | Fix general reconnect scheduling and alarm authority |
| Test A returns within 30s but Test B exceeds 30s or has a worse lease outcome | Fix DNS-specific reconnection, using a redundant control origin rather than pretending the WebSocket API can flush Chrome DNS |
| Both return within 30s and leases behave as policy predicts | Run sustained backgrounding correctly, with Chrome fully occluded and the machine untouched |

Changing the extension before these runs invalidates the comparison with the production incident. Documentation, operator-local harness corrections, and read-only inspection do not alter the deployed condition.

## Preserve the completed evidence

The original incident and the valid Test A runs establish a narrow set of facts. They do not yet select a recovery fix.

### Original production incident

The full history remains in `docs/unattended-production-rollout.md`. The decision-driving facts are:

| Fact | Evidence |
|---|---|
| Tailscale reconfigured DNS at `2026-07-29T06:02:16Z` | System journal |
| 1Password’s long-lived notifier disconnected at `06:03:00Z` and reconnected at `06:03:06Z` | System journal |
| Understudy remained offline at `06:09:49Z`; its lease was already terminally `lost` | Soak evidence |
| The machine did not suspend and Chrome did not restart | Uptime, journal, and process start time |
| The lost session’s `example.com` window remained open after server capacity was released | Server state, side-panel count, and operator observation |

The outage was about six seconds. The defect is the multi-minute recovery and its destructive consequences.

### Valid Test A results

`deviceBack` is the first poll that observes an online device with a fresh `lastSeenAt` different from the pre-break value. It is a server-observed recovery measurement, not a timestamp from Chrome’s WebSocket `open` event.

| Run | Block | Restore to observed device return | Lease | Worker card | Browser cleanup |
|---|---:|---:|---|---|---|
| `test-a-10s-20260729T193833Z-3353608` | 10s | `12,045 ms` | Survived, `connected`, one tab, no reconciliation | Never inactive, operator observed | Test window closed |
| `test-a-30s-20260730T120310Z-1249532` | 30s | `7,140 ms` | Survived, `connected`, one tab, no reconciliation | Never inactive, operator observed | Cleanup confirmed and test window closed |

These runs prove that short pure-egress interruptions recovered without losing the lease while the worker stayed active. They do not prove that reconnect timers survive worker eviction. The 7s and 12s measurements also do not explain the original seven-minute failure.

### Excluded and aborted runs

Keep invalid evidence excluded:

- `test-a-10s-20260729T193322Z-3312893`: the new test window covered the extension card, so the operator moved windows during the outage. Browser interaction could wake the worker. Exclude both worker-state and recovery conclusions
- `test-a-30s-20260729T194024Z-3369293`: session creation returned `503 {"error":"device connection unavailable"}` before firewall rules were installed. This is not a network-blip run. It exposed the ghost-lease defect below
- The earlier 18-minute backgrounding attempt: the operator switched windows throughout. Chrome was never sustainedly backgrounded. It is evidence only for stability during interactive use

The original run 1 orphan window’s current visual presence is unverified after the computer restart. Check before using browser-window counts as evidence.

## Keep the hypotheses honest

The current evidence leaves all three recovery mechanisms open at the conditions that matter:

| Hypothesis | Status |
|---|---|
| `setTimeout` retry dies with Manifest V3 service-worker eviction | Suspected and unproven. The worker did not become inactive during valid 10s or 30s tests |
| Chrome DNS remained broken after Tailscale reconfiguration | Untested. Test B has not run |
| Sustainedly backgrounded Chrome delays or loses recovery | Open. The prior attempt did not hold the condition |
| General reconnect works during short pure-egress loss while the worker stays active | Verified by valid 10s and 30s Test A runs |
| Ninety seconds without heartbeat terminally loses every lease on the device | Verified by source and the production incident |
| A lost lease can leave its Chrome window open | Verified by source and the production incident |

Do not convert “suspected,” “untested,” or “open” into a conclusion when updating the ledger.

## Fix failed provisioning that reserves an uncloseable ghost lease

This is the highest-confidence newly discovered defect. It is independent of the network-blip mechanism and already occurred in production.

### What happened

The aborted 30s attempt returned `503 {"error":"device connection unavailable"}` before any firewall rule existed. The device then reported server usage `1/2` while the side panel reported `0/2` controlled tabs and no window opened. Fresh heartbeats did not release the slot. Restarting Chrome changed the browser epoch and returned the server to `0/2`.

The restart was a recovery action, not a product fix.

### Why it happens

`POST /v1/sessions` allocates a durable lease before asking `DeviceAgent` to send the provision frame. A `false` return or any exception enters one catch block, changes the lease to `closing`, and returns a bare 503 without the session ID.

The coordinator then sends `close_lease` forever. The extension never received the provision frame, so `SessionManager.closeLease()` has no runtime, vacated record, or closure-outbox entry to acknowledge. The closing lease remains capacity-bearing until the device epoch changes or the device itself reaches the loss threshold.

The same class exists in the extension’s local `provision_failed` path. A non-stale provisioning exception cleans the runtime with intent `discard`, which never creates a closure-outbox record. The backend still changes the lease to `closing` and waits for the closure acknowledgement that `discard` suppresses. This source path is verified but has not been reproduced live.

### Required state-machine change

Implement the whole class, not only the observed `requestProvision() === false` case:

| Event | Current transition | Required transition |
|---|---|---|
| `initializeUnattended` fails before provisioning is attempted | `provisioning → closing`; bare 503 | Exact-fence release to terminal `closed`; reconcile the Session Agent to unattended terminal state; return the session handle and terminal lifecycle |
| `requestProvision` returns `false` | `provisioning → closing`; bare 503 | Exact-fence release to terminal `closed`, because source proves no provision frame was sent |
| `requestProvision` throws | `provisioning → closing`; bare 503 | Preserve ambiguity as `closing`; return `202`, `Location`, `Retry-After`, session ID, and lifecycle |
| Extension sends `provision_failed` | Cleanup intent `discard`; server waits for impossible closure acknowledgement | Persist cleanup intent `release`; close the tab if one exists; retain and flush the closure outbox until acknowledged |
| Heartbeat reports no matching assignment for `closing` or `expired` lease | Server resends `close_lease` forever | Treat the authoritative absence as cleanup confirmation and release the exact fenced lease |
| A late `provisioned` arrives after release | Coordinator rejects it | Keep the existing rejection and `close_lease` response so the late browser resource is removed |

Reuse the existing terminal replay response for known-unsent failures instead of inventing a third response shape. Reuse the existing `202` polling response for ambiguous dispatch failures.

Add a coordinator method dedicated to known-unsent release. It must compare `sessionId`, `leaseId`, `deviceId`, `leaseEpoch`, `browserEpoch`, current status, and `release_at IS NULL` before setting `status='closed'`, `release_at`, and `needs_reconciliation=0`.

`SessionAgent.markLifecycle()` is a no-op before `initializeUnattended()` has populated `state.unattended`. Make initialization retry-safe and ensure a failed initialization is reconciled before `GET /v1/sessions/:sessionId` can report attended `pending`. A terminal idempotency replay must return the same unattended lifecycle even when the first initialization RPC failed.

Update heartbeat reconciliation so an absent `closing` lease becomes `closed` and an absent `expired` lease remains `expired`, both with `release_at` set. A reported lease must continue through the current extension-close handshake.

### Rejected fixes

Do not ship any of these:

- Restarting Chrome when capacity is stuck: it hides the defect and destroys every active browser epoch
- Returning the session ID without releasing or reconciling the lease: callers can observe the ghost but capacity still leaks
- Treating every thrown RPC as “nothing was sent”: a failed remote call is ambiguous and the provision frame might already be in flight
- Dropping the lease after a timeout without checking the extension’s reported lease IDs: that can abandon a real browser resource

### Required tests

Add focused tests for:

- Session initialization failure before device dispatch
- Status GET and idempotency replay after an ambiguous initialization RPC
- `requestProvision()` returning `false`
- Device RPC throwing before or after its side effect
- Extension local provisioning failure before window creation
- Extension local provisioning failure after window creation
- Cleanup retry when the first tab close fails
- Heartbeat absence settling `closing` and `expired`
- Heartbeat presence preserving the close handshake
- Late `provisioned` after server release
- Idempotency replay returning the same terminal or pollable handle
- Device capacity returning to zero without a browser restart

## Select and fix the reconnect mechanism after the remaining tests

Do not merge a timer or DNS fix before Test A 60s, Test A 120s, and Test B 30s select it.

### If Test A is slow or fails

Make `chrome.alarms` authoritative for durable retry scheduling:

- Persist whether each attended or device-control connection is desired
- Persist the next retry deadline and current bounded backoff
- Use `setTimeout` only for sub-30s acceleration while the worker is alive
- Recreate or advance the alarm whenever desired connection state changes
- On every worker start and alarm, reconcile desired state against an open socket
- Prevent the in-memory timer and the alarm from opening competing sockets
- Reset backoff only after a successful connection and hello

Apply the same policy to `ReconnectingWs.scheduleReconnect()` and `ProfileClient.scheduleRetry()`. The device control path is the production-critical path because it carries `device_hello` and heartbeats.

### If only Test B is slow

JavaScript’s WebSocket API cannot force Chrome to flush or bypass its host resolver. Implement bounded control-origin failover instead:

- Keep `https://understudy.proofof.tech` as primary
- Use the still-live `https://understudy-backend.gcharang.workers.dev` endpoint as the fallback
- Fetch a new connect ticket from the selected origin
- Accept a returned WebSocket URL only when its origin matches the selected origin
- Never rewrite a ticket URL from one origin to another
- Fail back to primary only after a successful bounded probe
- Record the selected origin and failure class without recording credentials, tickets, or full URLs

This design needs security and architecture review because it sends the device credential to either configured backend origin. Both origins currently route to the same Worker, but the trust boundary must remain explicit.

Do not make the personal `gcharang.workers.dev` hostname a permanent production dependency. If Test B selects failover, use it to prove the mechanism, then choose an organization-owned secondary origin in an independent DNS namespace with an explicit retirement and ownership policy before widening the rollout.

### If both tests stay bounded

Run sustained backgrounding with no operator interaction:

1. Start server-side sampling
2. Fully occlude Chrome
3. Leave the machine untouched longer than the worker eviction and alarm cycle
4. Keep sampling after any session becomes terminal
5. Record worker state only through non-inspecting telemetry

Do not cite the earlier interactive 18-minute run.

## Separate device capacity reclamation from lease destruction

The current 90s transition turns a transient device outage into terminal session loss. Improving reconnect frequency does not repair this state-machine shape.

### Current transition

At 75s without heartbeat, the device reports `offline` and active leases enter `recovering`. At 90s, every unreleased lease becomes `lost`, receives `release_at`, and returns 410 forever.

### Required transition

Introduce an adoptable suspended lifecycle:

1. Keep the 75s `offline` report and `recovering` transition
2. At the capacity-reclamation deadline, move the lease to `suspended` and stop counting it against device capacity
3. Keep the session pollable and nonterminal during a separately named adoption window
4. On reconnect, readopt suspended leases only when capacity, profile-key, and origin constraints still allow it
5. Terminalize and close any suspended lease that cannot be readopted
6. Move an unadopted lease to `lost` only when the adoption window expires

Adding `suspended` changes `UnattendedSessionLifecycleSchema`. Publish coordinated protocol and connector versions, then upgrade Metamind before production uses the new value.

Do not choose the adoption-window duration from the original 90s constant. Define the recovery service-level objective first. The incident proves the window must tolerate at least a seven-minute recovery if session preservation is a goal, but it does not establish the correct final duration.

### Rejected fix

Do not raise `DEVICE_LOST_MS` and leave the model unchanged. That delays capacity reclamation for genuine loss while preserving the same terminal cliff.

## Close released and untracked windows on reconnect

The coordinator currently returns only unreleased `closing` and `expired` leases in its closure list. A `lost` lease already has `release_at`, so it never reaches the extension close path.

Fix tracked stale assignments through the lease IDs already reported by the extension heartbeat:

1. Compare reported lease IDs with the coordinator’s active lease set
2. Return exact fenced orphan records only for reported IDs whose server rows are terminal or released
3. Send those records through the existing `close_lease` frame
4. Let `SessionManager` close the controlled tab and persist removal
5. Reuse `confirmClosed()`, which already acknowledges an exact released `closed`, `expired`, or `lost` lease
6. Stop returning the orphan after the extension no longer reports it

This server reconciliation is necessary but insufficient for the observed incident. The leaked window was absent from the side panel’s assignment count. Add the durable owned-window registry described under “Expose physical window divergence through the device API,” then close registered windows that remain after assignment hydration and cleanup recovery.

Do not remove `release_at IS NULL` from the general closure query. That would replay every historical released lease on every heartbeat.

Add tests for same-epoch reconnect after `lost`, exact-fence mismatch, already-removed assignment, repeated orphan delivery, closure acknowledgement, an untracked registered window, and physical window count matching the owned-window registry after recovery.

## Add recovery telemetry that does not change worker lifetime

The current diagnostic plan asks for evidence that the product cannot retain:

- Opening the service-worker console keeps the inspected worker active
- The side-panel log is a module-memory ring buffer and is recreated on every worker wake
- `ProfileClient` changes status during ticket and socket retries but does not persist attempt outcomes
- `DeviceAgent.onClose()` clears `activeConnectionId` without recording a disconnect timestamp or reason

After baseline tests select a mechanism, add a bounded redacted journal to extension storage. Store only event enums, timestamps, attempt numbers, selected origin labels, close codes, and coarse error classes. Never store ticket URLs, query strings, credentials, raw request errors, session tokens, or caller tokens.

Useful events include:

- Service worker started
- Backstop alarm fired
- Ticket request started, succeeded, or failed by error class
- WebSocket connecting, opened, or closed by code
- Device hello sent
- Heartbeat sent
- Retry scheduled with deadline
- Retry reconciled by alarm

Add backend telemetry for authoritative device connection close and next registration. This provides a server-side disconnect-to-register duration without requiring DevTools.

Do not deploy diagnostic instrumentation before the remaining baseline tests. An extension rebuild can alter service-worker lifetime and invalidate the comparison.

## Expose physical window divergence through the device API

Current source sends every managed lease ID in `heartbeatFrame()`, and the coordinator receives `reportedLeaseIds`. That value is not a physical controlled-window count.

The production incident proves the distinction. The server reported `used 1/2`, the side panel reported one managed assignment, and two `example.com` windows existed. The leaked window was no longer represented by `SessionManager.assignments()`, so comparing current heartbeat lease IDs with server leases would not have found it.

Add a durable extension-owned window registry separate from live assignments:

- Store the registry under a distinct `browser.storage.session` key so service-worker eviction preserves it and browser restart clears it
- Record `browserEpoch`, `windowId`, `tabId`, and the exact lease fence immediately after `browser.windows.create()` returns
- Remove the registry entry only after Chrome confirms that the tab or window no longer exists
- Reconcile the registry against hydrated assignments on every worker start
- Close registered windows that have no live or pending-cleanup assignment
- Report a physical registered-window count with the existing managed lease IDs
- Preserve registry entries across service-worker eviction
- Define browser-restart behavior explicitly so restored ordinary tabs never become extension-owned by accident

Persist and expose the server comparison:

- Coordinator active lease count
- Extension-reported managed lease count
- Extension-reported owned-window count
- Managed lease IDs present only on one side
- Last comparison timestamp

Expose a bounded summary on `GET /v1/devices`, such as server `used`, managed assignment count, owned-window count, and a divergence flag. Emit telemetry when divergence starts and clears. Keep tenant scoping and avoid returning session IDs from the device-list endpoint unless the existing authorization contract permits them.

The registry closes the observed monitoring gap only for windows it recorded. A crash between Chrome creating the window and the registry write remains a narrow residual risk. Keep a visual count in acceptance and add a failure-injection test at that boundary.

## Correct attended status after the unattended rollout is stable

Attended mode still reports `connected` after the operator detaches the debugger. The backend retains stale browser and tab data because neither deliberate nor involuntary detach sends a backend state transition.

Implement the existing deferred design:

- Add attended status `idle` to represent an authorized socket with no attached tab
- Keep `connected` reserved for an attached, executable tab
- Send an explicit detach frame from both `detach()` and `onDetach()`
- Fence the frame by tab or attachment generation so a stale detach cannot clear a newer attachment
- Clear browser, tabs, current URL, and dialogs on accepted detach
- Keep socket-level loss as `detached`

This is a coordinated protocol change. Publish protocol and connector versions, then upgrade Metamind. Do not fold it into the network-blip patch if doing so complicates the recovery state machine.

## Clarify the process-wide Chrome debugger banner

The banner’s detach control can appear over windows from other Chrome profiles. Clicking it there can detach the canary debugger.

Update `apps/extension/RUNBOOK.md` to say:

- The banner is process-wide, not evidence that the visible tab belongs to Understudy
- Dismissing it anywhere can detach the canary
- Operators must use the extension’s **Detach tab** action instead

This is a documentation fix. Do not attempt to suppress or restyle Chrome’s browser-owned banner.

## Repair rollout records and deployment provenance

The current ledger contains verified drift:

- Phase 3a’s table row still says the 13-scenario acceptance suite remains, while the later record and current state say 15 of 16 passed with only expiry outstanding
- Phase 3b’s table row still says run 2 is in progress, while run 2 was deliberately halted and no soak is active
- The table names `e0673967-0ca5-4cca-81ee-50d4088cec33` as the unchanged active version, while credential rotation created active secret-derived version `ca459527-145d-4765-b170-8cb72ef6b789`
- `docs/plan-network-blip-resilience.md` still names baseline `76eaf68` and contains no Test A results
- The plan’s original “fresh under 30s” metric can accept a pre-break heartbeat during short outages. The harness correctly requires a different `lastSeenAt`
- The plan asks for a service-worker console during the primary test, which changes worker lifetime
- The plan says the side-panel log survives longer than the console, but the log is module memory and resets on worker wake
- The new failed-provision ghost lease is absent from `DEFERRED.md`

Update the ledger only after the baseline diagnosis is complete, so one edit can record Test A, Test B, the chosen fix, and the corrected phase state.

Understudy’s `/health` returns only `{"ok":true}`. Secret updates create new active version IDs, so the rollout record cannot identify source from health alone. Add source-controlled deployment provenance:

- Add a full commit stamp to `/health`
- Add a deploy script that rejects a dirty source tree for operator deployments
- Include the full SHA in the deployment message
- Poll `/health` for consecutive matching reads after deploy
- Record source-release version, current active version, deployment ID, and secret-derived provenance separately

Reuse Metamind’s `scripts/deploy.sh` and `/health.commit` pattern as a design reference. Do not copy tenant-specific paths or configuration.

## Make the production test harness reproducible

The `/tmp` harness disappeared on reboot. The persistent replacement works, but a fresh engineer cannot reconstruct it from the repository.

After diagnosis, add a sanitized repository harness that:

- Accepts Test A or Test B as an explicit mode
- Accepts durations from an allowlist
- Reads credentials only from an operator-supplied path or file descriptor
- Never prints credentials or authorization headers
- Writes evidence with mode `0600`
- Persists the idempotency key before request dispatch
- Replays the same key after a transport or non-success result
- Requires a post-break `lastSeenAt` different from the baseline
- Restores and verifies firewall or Tailscale state under exit, interrupt, and termination traps
- Returns the session handle for every allocated outcome
- Confirms lease cleanup and final device capacity
- Inserts the pre-block visual-observation pause while baseline testing still depends on the extension card

Keep raw production evidence outside Git. Commit only the harness and redacted fixtures.

## Reuse existing code instead of creating parallel machinery

Use these existing patterns:

| Need | Reuse |
|---|---|
| Exact lease compare-and-set | `TenantDeviceCoordinator.markProvisioned()` and `confirmClosed()` |
| Device authority fencing | `DeviceAgent.captureAuthority()`, `matchesAuthority()`, and `sameAuthorityFence()` |
| Durable extension cleanup | `SessionManager.cleanup()`, closure outbox, vacated leases, and exact `closed_ack` |
| Late provision containment | Existing rejected-`provisioned` branch that sends `close_lease` |
| Reported assignment identity | Existing device heartbeat `leaseIds` |
| Worker wake backstop | Existing `ws-backstop` alarm and `ensureConnection()` calls |
| Redacted backend events | Existing `emitTelemetry()` |
| Cross-repository deployment stamp | Metamind `scripts/deploy.sh` and `/health.commit` |
| Durable consumer recovery | Metamind `packages/worker/src/intake/resume-recovery.ts` compare-and-clear pattern |

## Keep these items out of scope

Do not change these unless new evidence requires it:

- `DEVICE_OFFLINE_MS = 75_000`: reporting offline is accurate and does not itself destroy a lease
- The 22s heartbeat interval: the incident starts when connectivity disappears, not because healthy heartbeats are late
- Metamind’s terminal-session sweep: it settles terminal Understudy leases instead of retrying forever
- The Chrome banner implementation: Chrome owns it
- A backgrounding “fix” before a valid sustained-backgrounding reproduction
- Disabling the tenant allowlists or widening them beyond `metamind`
- Restarting Phase 3b before network recovery, lease suspension, and orphan cleanup pass

Do not cite the invalid first Test A run or the invalid backgrounding run as evidence in either direction.

## Verify the implementation and rollout

Run repository checks from the Understudy root:

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm --filter @understudy/backend exec wrangler deploy --dry-run \
  --config wrangler.jsonc
git diff --check
```

Run focused suites while iterating:

```bash
pnpm --filter @understudy/backend test -- test/tenant-coordinator.test.ts
pnpm --filter @understudy/backend test -- test/device.test.ts
pnpm --filter @understudy/backend test -- test/service.test.ts
pnpm --filter @understudy/extension test -- src/core/session-manager.test.ts
pnpm --filter @understudy/extension test -- src/core/profile-client.test.ts
pnpm --filter @understudy/extension test -- src/core/ws-client.test.ts
```

If a protocol lifecycle changes, also run:

```bash
pnpm --filter @understudy/protocol test
pnpm --filter @understudy/connector test
pnpm --dir /home/gcharang/gitrepos/proofoftech/metamind \
  --filter @repo/worker typecheck
pnpm --dir /home/gcharang/gitrepos/proofoftech/metamind \
  --filter @repo/worker test
```

Every nontrivial code or script change requires independent clean-code, architecture, and quality-assurance review lanes. Fix substantive findings and rerun the affected lane before deployment.

Production verification after the fix must prove:

1. Test A 30s preserves the lease and returns within the chosen recovery objective
2. Test A 120s no longer leaves a browser window, regardless of whether policy suspends or terminalizes the lease
3. Test B 30s returns within 30s with the same lease outcome as Test A 30s
4. A known-unsent provisioning failure releases capacity without a browser restart
5. An ambiguous provisioning failure returns a pollable handle and eventually settles
6. Device API divergence starts and clears in a forced orphan scenario
7. A read-only 24-hour Phase 3b soak restarts from zero and spans at least one real network transition
8. Idle and hard expiry complete the remaining Phase 3a evidence

## Appendix: current-state anchors

All line numbers below are as of `b5a1e8100c200d683a736eb7589f8ed5babb4761`. Read each symbol again before editing.

### Session creation collapses known and ambiguous dispatch failures

`apps/backend/src/index.ts`, `POST /v1/sessions`, lines 162 through 180:

```typescript
if (allocation.created) {
  try {
    await session.initializeUnattended(actor.tenantId, allocation.lease);
    const device = c.env.DEVICE.getByName(
      allocation.lease.deviceId,
    ) as DurableObjectStub<DeviceAgent>;
    if (!(await device.requestProvision(allocation.lease))) {
      throw new Error("device connection unavailable");
    }
  } catch {
    await coordinator.markProvisionFailed({
      sessionId,
      leaseId: allocation.lease.leaseId,
      deviceId: allocation.lease.deviceId,
      leaseEpoch: allocation.lease.leaseEpoch,
      browserEpoch: allocation.lease.browserEpoch,
    });
    await session.markLifecycle("closing", true);
    return c.json({ error: "device connection unavailable" }, 503);
  }
}
```

The target must split initialization failure, a `false` dispatch, and an ambiguous thrown RPC.

### Lifecycle reconciliation requires initialized unattended state

`apps/backend/src/session.ts`, `SessionAgent.markLifecycle()`, lines 1187 through 1204:

```typescript
async markLifecycle(
  status: UnattendedSessionLifecycle,
  needsReconciliation: boolean,
): Promise<void> {
  if (this.state.unattended === undefined) return;
  if (status === "closing" || isTerminalLifecycle(status)) {
    this.terminalizeActiveAttempts();
  }
  this.setState({
    ...this.state,
    activeConnectionId: isTerminalLifecycle(status) ? null : this.state.activeConnectionId,
    status: isTerminalLifecycle(status) ? "detached" : this.state.status,
    unattended: {
      ...this.state.unattended,
      status,
      needsReconciliation,
    },
  });
}
```

If the first initialization RPC fails before state is visible, calling `markLifecycle()` cannot reconcile it.

### A false provision result means no frame was sent

`apps/backend/src/device.ts`, `DeviceAgent.sendProvision()`, lines 486 through 497:

```typescript
const connection = this.authoritativeConnection();
const fence =
  connection === undefined ? null : this.captureAuthority(connection);
if (
  connection === undefined ||
  fence === null ||
  (expectedFence !== undefined && !sameAuthorityFence(fence, expectedFence)) ||
  lease.deviceId !== this.name ||
  lease.browserEpoch !== fence.browserEpoch
) {
  return false;
}
```

After ticket minting, the function checks the authority again. It returns `false` before `this.send(...)` when that fence changed:

`apps/backend/src/device.ts`, `DeviceAgent.sendProvision()`, lines 511 through 527:

```typescript
if (
  !this.matchesAuthority(connection, fence) ||
  lease.deviceId !== this.name ||
  lease.browserEpoch !== this.state.browserEpoch
) {
  return false;
}
this.send(connection, {
  type: "provision",
  sessionId: lease.sessionId,
  leaseId: lease.leaseId,
  leaseEpoch: lease.leaseEpoch,
  browserEpoch: lease.browserEpoch,
  allowedOrigins: lease.allowedOrigins,
  sessionTicket,
});
return true;
```

A thrown call remains ambiguous.

### Provision failure enters a close handshake

`apps/backend/src/tenant-coordinator.ts`, `markProvisionFailed()`, lines 456 through 474:

```typescript
this.ctx.storage.sql.exec(
  `UPDATE lease SET status = 'closing', needs_reconciliation = 1
   WHERE session_id = ? AND lease_id = ? AND device_id = ?
     AND lease_epoch = ? AND browser_epoch = ?
     AND status IN ('provisioning','recovering') AND release_at IS NULL`,
  input.sessionId,
  input.leaseId,
  input.deviceId,
  input.leaseEpoch,
  input.browserEpoch,
);
```

The transition reserves capacity until a matching close acknowledgement or device-loss release.

### Heartbeat returns only unreleased closures

`apps/backend/src/tenant-coordinator.ts`, `heartbeat()`, lines 294 through 307:

```typescript
const assignments = this.leaseRows(
  `SELECT * FROM lease
   WHERE device_id = ? AND status = 'connected' AND release_at IS NULL
   ORDER BY created_at`,
  deviceId,
).map(toLeaseResource);
const closures = this.leaseRows(
  `SELECT * FROM lease
   WHERE device_id = ? AND status IN ('closing','expired') AND release_at IS NULL
   ORDER BY created_at`,
  deviceId,
).map(toLeaseResource);
```

The target must settle absent closures and return only client-reported released leases as orphans.

### An unknown close request cannot produce an acknowledgement

`apps/extension/src/core/session-manager.ts`, `SessionManager.closeLease()`, lines 187 through 215:

```typescript
if (
  runtime === undefined ||
  runtime.sessionId !== input.sessionId ||
  runtime.assignment.leaseEpoch !== input.leaseEpoch ||
  runtime.assignment.browserEpoch !== input.browserEpoch
) {
  const vacated = this.vacated.find((entry) => sameClosure(entry, input));
```

The remainder checks only vacated and outbox records:

```typescript
if (vacated !== undefined) {
  const previousOutbox = [...this.closedOutbox];
  const previousVacated = this.vacated;
  if (intent === "release") {
    this.enqueueClosure(vacated);
  }
  this.vacated = this.vacated.filter(
    (entry) => !sameClosure(entry, vacated),
  );
  try {
    await this.persist();
  } catch (error) {
    this.closedOutbox = previousOutbox;
    this.vacated = previousVacated;
    throw error;
  }
  return true;
}
return intent === "release" && this.hasOutboxEntry(input);
```

For a never-received provision frame, all three lookups miss and the function returns `false`.

### Local provisioning errors discard the closure record

`apps/extension/src/core/session-manager.ts`, `SessionManager.provision()`, lines 147 through 154:

```typescript
} catch (error) {
  if (this.isCurrent(runtime) && runtime.assignment.cleanupIntent === undefined) {
    await this.cleanup(
      runtime,
      error instanceof StaleProvisionError ? "release" : "discard",
    );
  }
  throw error;
}
```

`SessionManager.cleanup()`, lines 431 through 437:

```typescript
if (runtime.assignment.cleanupIntent === "release") {
  this.enqueueClosure(runtime.assignment);
} else if (runtime.assignment.cleanupIntent === "recover") {
  this.enqueueVacated(runtime.assignment);
}
this.uninstall(runtime);
await this.persist();
```

`discard` removes the runtime without a closure or vacated record, while the backend waits in `closing`.

### Device loss is terminal at 90s

`apps/backend/src/tenant-coordinator.ts`, constants at lines 9 through 14:

```typescript
const DEVICE_CAPACITY = 2;
const DEVICE_OFFLINE_MS = 75_000;
const DEVICE_LOST_MS = 90_000;
const PROVISIONING_DEADLINE_MS = 30_000;
const IDLE_EXPIRY_MS = 2 * 60 * 60 * 1000;
const HARD_EXPIRY_MS = 24 * 60 * 60 * 1000;
```

`TenantDeviceCoordinator.alarm()`, lines 893 through 900:

```typescript
for (const deviceId of lostDeviceIds) {
  this.ctx.storage.sql.exec(
    `UPDATE lease SET status = 'lost', release_at = ?, needs_reconciliation = 1
     WHERE device_id = ? AND release_at IS NULL
       AND status IN ('allocating','provisioning','connected','recovering','closing','expired')`,
    now,
    deviceId,
  );
}
```

The target needs separate capacity and terminal-loss transitions.

### Active capacity counts every unreleased lifecycle

`apps/backend/src/tenant-coordinator.ts`, `activeLeasesForDevice()`, lines 962 through 968:

```typescript
return this.leaseRows(
  `SELECT * FROM lease
   WHERE device_id = ? AND release_at IS NULL
     AND status IN ('allocating','provisioning','connected','recovering','closing','expired')`,
  deviceId,
);
```

An adoptable suspended lifecycle needs explicit capacity and collision semantics.

### Both reconnect layers use in-memory timers

`apps/extension/src/core/ws-client.ts`, `ReconnectingWs.scheduleReconnect()`, lines 129 through 138:

```typescript
private scheduleReconnect(): void {
  if (this.stopped) return;
  if (this.reconnectTimer !== null) return;
  const delayMs = this.backoffMs;
  this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_CAP_MS);
  this.reconnectTimer = setTimeout(() => {
    this.reconnectTimer = null;
    this.connect();
  }, delayMs);
}
```

`apps/extension/src/core/profile-client.ts`, `ProfileClient.scheduleRetry()`, lines 705 through 723:

```typescript
if (this.retryTimer !== null) return;
const delayMs = this.ticketBackoffMs;
this.ticketBackoffMs = Math.min(
  this.ticketBackoffMs * 2,
  TICKET_BACKOFF_CAP_MS,
);
this.setStatus("connecting");
this.retryTimer = setTimeout(() => {
  this.retryTimer = null;
  void this.connectControl(
    attempt.config,
    attempt.purpose,
    attempt.generation,
  );
}, delayMs);
```

These timers do not establish that timer death caused the incident. They identify the edit targets if the remaining tests select that mechanism.

### The alarm backstop already wakes both connection paths

`apps/extension/src/entrypoints/background.ts`, `onAlarm()`, lines 878 through 885:

```typescript
function onAlarm(alarm: { name: string }): void {
  if (alarm.name === BACKSTOP_ALARM) {
    fireAndForget("ensureConnection", ensureConnection);
    fireAndForget("ensureProfileConnection", () =>
      profileClient.ensureConnection(),
    );
  }
}
```

The timer fix should strengthen this authority instead of adding another scheduler.

### The side-panel log resets with the worker

`apps/extension/src/entrypoints/background.ts`, module-state comment at lines 44 through 46:

```typescript
// WXT re-runs main() when the service worker is revived, so these are re-created
// from scratch each wake; durable state lives in browser.storage.{local,session}.
```

The log declaration is at line 86:

```typescript
const logBuffer: LogEntry[] = [];
```

This buffer cannot retain the event that killed the worker.

### The heartbeat reports assignments, not physical windows

`apps/extension/src/core/profile-client.ts`, control socket handlers at lines 521 through 528:

```typescript
heartbeatFrame: () => ({
  type: "heartbeat",
  deviceId: config.deviceId,
  browserEpoch: this.epoch,
  leaseIds: this.sessions
    .assignments()
    .map((assignment) => assignment.leaseId),
}),
```

Use these IDs for assignment reconciliation. They cannot count the untracked leaked window observed in run 1.

### Device disconnect has no telemetry

`apps/backend/src/device.ts`, `DeviceAgent.onClose()`, lines 447 through 450:

```typescript
async onClose(connection: Connection): Promise<void> {
  if (this.state.activeConnectionId !== connection.id) return;
  this.setState({ ...this.state, activeConnectionId: null });
}
```

Record only redacted connection lifecycle metadata.

### Attended status lacks an idle value

`packages/protocol/src/index.ts`, `AttendedSessionStatusSchema`, lines 382 through 389:

```typescript
export const AttendedSessionStatusSchema = strictObject({
  mode: z.literal("attended").optional(),
  status: z.enum(["pending", "connected", "detached"]),
  browser: DeviceBrowserSchema.nullable(),
  tabs: z.array(TabInfoSchema),
  currentUrl: UrlStringSchema.nullable(),
  dialogs: z.array(DialogRecordSchema).max(50),
});
```

`apps/extension/src/entrypoints/background.ts`, `detach()`, lines 648 through 657:

```typescript
async function detach(): Promise<void> {
  const active = session;
  try {
    if (active !== null) await active.detach();
  } catch (cause) {
    log(`detach error (continuing): ${errorMessage(cause)}`, "warn");
  }
  await clearAttachment();
  log("detached");
  broadcastState();
}
```

The detach path updates only extension-local state.

### Understudy health has no source stamp

`apps/backend/src/index.ts`, line 56:

```typescript
app.get("/health", (c) => c.json({ ok: true }));
```

This cannot distinguish a source deployment from later secret-derived active versions.
