<!-- Content type: Reference -->

# Deferred work

Known defects and design gaps that are recorded rather than fixed, with enough
evidence that a fresh session can act on them without redoing the
investigation. Each entry states what is wrong, how it was observed, why it was
deferred, and what "done" looks like.

Line numbers are as-of the baseline commit named in each entry and must be
re-confirmed before editing.

---

## Attended session status cannot express "connected but not attached"

**Baseline:** branch `dev`, commit `d6fab0de4aea6be587e158b59faea21c6c4bed06`.
**Found:** 2026-07-29, during the Phase 3a attended-compatibility scenario.
**Severity:** consumers can be told a session is ready when it cannot execute
anything. No silent success, but a status that is affirmatively wrong.

### What was observed

With an attended session attached and working, the operator pressed **Detach
tab** in the side panel. The session then reported:

```json
{"mode":"attended","status":"connected","browser":{...},"tabs":[{"tabId":2134210639,...}]}
```

while every command answered:

```json
{"type":"action_result","ok":false,"error":"no active CDP session"}
```

So `status` said `connected`, `browser` was populated, and `tabs` still listed a
tab that was no longer under control.

### Why it happens — two independent causes

**1. The attended enum has no state for it.** `packages/protocol/src/index.ts:382`:

```ts
export const AttendedSessionStatusSchema = strictObject({
  mode: z.literal("attended").optional(),
  status: z.enum(["pending", "connected", "detached"]),
```

Three states, and the real machine has at least four: no socket; socket up with
no tab attached; socket up with a tab attached; socket gone. `connected`
currently covers the middle two, which are the two that differ in whether a
command can succeed.

The unattended lifecycle in the same file (`:367`) models its machine properly,
which is the contrast worth noting — the attended path was simply never given
the same treatment:

```ts
export const UnattendedSessionLifecycleSchema = z.enum([
  "allocating", "provisioning", "connected", "recovering",
  "closing", "closed", "expired", "lost",
]);
```

**2. The extension never tells the backend.** `apps/extension/src/entrypoints/background.ts:648`:

```ts
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

`broadcastState()` updates the side panel only. No frame goes over the
WebSocket, so even with a richer enum the backend could not make the
transition. The same is true of the involuntary path,
`background.ts:595` — which matters more, because it is the one a user
triggers by accident:

```ts
async function onDetach(source: { tabId?: number }, reason: string): Promise<void> {
  await profileClient.sessions.onDebuggerDetach(source);
  const active = session;
  if (active === null || source.tabId !== active.tabId) return;
  await fenceStartedAttendedWrites();
  await clearAttachment();
  log(`debugger detached from tab ${active.tabId} (${reason})`);
  broadcastState();
}
```

`chrome.debugger.onDetach` fires when the controlled tab is closed, or when the
user clicks **Cancel** on Chrome's debugger banner. Both leave the session
reporting `connected`. This is the mechanical reason
`apps/extension/RUNBOOK.md` instructs operators not to touch that banner — the
instruction exists, but the reason is not written down anywhere.

For completeness, `detached` today is set only on socket-level events, in
`apps/backend/src/session.ts` at lines `529`, `1132`, `1164`, `1198` and `1231`:
connection close, session reconnect / browser-epoch change, device credential
revocation, and terminal close. Losing the debugger attachment is not among
them.

### Why it was deferred

It is not a correctness hole in execution. A consumer that sends a command gets
an explicit `ok: false` with a specific reason, not a false success, and
Metamind's connector surfaces that. The exposure is limited to a consumer that
gates on `status` alone and concludes the session is usable.

It also cannot be fixed in one repo. Adding a value to
`AttendedSessionStatusSchema` is a **breaking protocol change**: the schema is
exported from `@understudy/protocol` and consumers parse responses with it, so
`z.enum` rejects an unknown value. Shipping it needs a protocol major, a
connector release, and a consumer upgrade — coordination that did not belong in
the middle of a canary acceptance run.

### Proposed fix

Model the machine, then report the transition. Both halves are required; either
alone changes nothing.

1. **Protocol.** Add a state meaning "extension socket present, no tab
   attached". Recommended name `idle`, giving
   `pending | idle | connected | detached`, and keep `connected` meaning
   *ready to execute*. Preserving the existing meaning of `connected` is the
   point: consumers that already gate on `status === "connected"` keep working
   and simply stop treating a detached session as usable.

   *Rejected:* renaming the ready state to `attached` and repurposing
   `connected` to mean socket-up. Cleaner on paper, but it silently flips the
   meaning of a value existing consumers already branch on — the failure mode
   would be worse than the bug.

2. **Extension.** Send an explicit frame on both detach paths — the deliberate
   `detach()` and the involuntary `onDetach()` — so the backend can transition
   to `idle`. It must carry the tab identity so a late frame from a superseded
   attachment cannot clear a newer one; `sendIfPeerCurrent` in
   `apps/extension/src/core/peer-binding.ts` is the existing guard for exactly
   this class of post-await staleness and should be reused rather than
   reinvented.

3. **Backend.** Clear `tabs` and `browser` alongside the transition. Reporting a
   `tabId` that is no longer controlled is part of the same wrongness and should
   not survive the fix.

### Out of scope

- The unattended lifecycle. It already models its machine and must not be
  touched by this work.
- `SessionAgent`'s existing `detached` transitions. They are correct for what
  they describe — socket-level loss — and this adds a state beside them rather
  than redefining them.

### Verification

- A unit test asserting the full attended sequence: `pending` on create,
  `connected` after hello, `idle` after a detach frame, `detached` after the
  socket closes.
- A test that a detach frame naming a superseded tab does **not** move a live
  session out of `connected`.
- Manually, the scenario that found it: attach, confirm `connected`, press
  **Detach tab**, confirm `idle` and empty `tabs`; then repeat by closing the
  controlled tab instead of pressing the button, which must reach the same
  state.
- Quality gate: clean-code, architecture, and QA lanes, since this is a protocol
  change with cross-repo consumers.

---

## A lost lease leaks a browser window

**Baseline:** branch `dev`, commit `76eaf68`.
**Found:** 2026-07-29, Phase 3b soak run 1.
**Severity:** every device-loss incident strands a Chrome window that only a human will close. Compounds without bound.

### What was observed

The soak's device missed its heartbeat past `DEVICE_LOST_MS`, so the coordinator marked its lease `lost`. Hours later the server reported `used 1/2` and the side panel reported `1/2` — both correct — while **two** `example.com` windows were open on screen. Tab `2134210655` belonged to the destroyed lease and was never closed.

### Why it happens

Declaring a device lost sets `status = 'lost'` **and `release_at`** on its leases. But the closure list a device receives on sync, in `apps/backend/src/tenant-coordinator.ts:300`, is:

```sql
SELECT * FROM lease
 WHERE device_id = ? AND status IN ('closing','expired') AND release_at IS NULL
 ORDER BY created_at
```

`release_at IS NULL` excludes exactly the leases that were just released. The server frees the slot and considers itself done; the extension is never told to close the tab, so it doesn't.

### Proposed fix

Close the loop on reconnect rather than widening the query blindly — a `lost` lease has `release_at` set precisely because the server has finished with it, and other logic depends on that.

**Recommended:** on device sync, send a separate *orphan* list — leases with `release_at` set whose device is now back — instructing the extension to close those tabs and forget the assignments. It is advisory, needs no acknowledgement, and is safe to repeat.

*Rejected:* dropping `release_at IS NULL` from the closure query. Closures are part of the release handshake; feeding already-released leases into it would have the extension re-acknowledge closures the server has settled.

**Also acceptable and complementary:** have the extension, on reconnect, close any controlled tab whose assignment the server does not acknowledge. That defends against the general case rather than this one path.

### Verification

- Coordinator test: a device that reconnects after its leases were lost receives the orphan list.
- Extension test: receiving it closes exactly those tabs and leaves untracked user tabs alone.
- Manually: force a device loss, reconnect, confirm no window survives and the count matches the side panel.

---

## Reconnect backoff does not survive service-worker eviction

**Baseline:** branch `dev`, commit `76eaf68`.
**Found:** 2026-07-29, inferred from soak run 1 timings. **Mechanism not yet proven** — see the test plan in `docs/plan-network-blip-resilience.md`.
**Severity:** suspected cause of a six-second network blip costing every session on a device.

### Evidence

Both reconnect paths schedule with `setTimeout`:

- `apps/extension/src/core/ws-client.ts:134` — `this.reconnectTimer = setTimeout(...)`, backoff 500 ms doubling to a 30 s cap (`:14`, `:15`).
- `apps/extension/src/core/profile-client.ts:716` — `this.retryTimer = setTimeout(...)`, same shape (`:28`, `:29`). This is the **device control socket**, the one carrying the heartbeat.

An MV3 service worker is evicted when idle, and a `setTimeout` dies with it. Losing the socket removes the very activity that was keeping the worker alive, so the pending retry is discarded at the moment it is most needed. Recovery then depends on the 30-second `ws-backstop` alarm (`apps/extension/src/entrypoints/background.ts:99`).

That should still bound recovery near 30 seconds, which is why this is **suspected rather than established**: run 1's device stayed offline for minutes, not tens of seconds. Either the alarm was delayed, or reconnect attempts were firing and failing for another reason — DNS, in the incident that produced this. The test plan is designed to tell those apart.

### Proposed fix (contingent on the test)

Do not fix before the mechanism is confirmed; the wrong fix here is easy to justify and useless. If reconnection proves to be timer-death:

- drive retries from `chrome.alarms` rather than `setTimeout`, accepting the 30-second floor, and keep `setTimeout` only for sub-30-second attempts while the worker is known alive;
- treat the backstop alarm as the authority for "should I be connected", which it nearly is already.

### Verification

Reproduce per the plan, capture whether the worker was evicted, whether the alarm fired, and whether reconnect attempts occurred at all. Only then choose the fix.

---

## Ninety seconds without a heartbeat destroys every session on a device

**Baseline:** branch `dev`, commit `76eaf68`.
**Found:** 2026-07-29, Phase 3b soak run 1.
**Severity:** design question for unattended operation, not a coding error.

### The numbers

`apps/backend/src/tenant-coordinator.ts:10-11`:

```ts
const DEVICE_OFFLINE_MS = 75_000;   // reported offline
const DEVICE_LOST_MS    = 90_000;   // every lease on the device -> 'lost'
```

Ninety seconds is roughly four missed heartbeats (`HEARTBEAT_MS = 22_000`). Crossing it sets `status = 'lost'` and `release_at` on every lease the device holds — terminal, `410` to the consumer, work discarded, and a leaked window per the entry above.

### Why it is a problem

The tolerance is thinner than the recovery path it must accommodate. Recovery is gated on a 30-second alarm, leaving at most three alarm cycles of slack, and only if every one succeeds. Meanwhile the events that cause a gap this size are utterly routine: a VPN connecting, a Wi-Fi roam, a DNS change. One was enough on 2026-07-29 — and 1Password's socket, hit by the same event, was back in six seconds.

For an attended session an operator notices and retries. An unattended fleet silently discards in-flight work.

### Proposed fix

**Recommended:** separate *capacity reclamation* from *lease destruction*. Freeing a device slot quickly is legitimate; destroying the consumer's session is a different decision that does not need the same deadline. Add a suspended state where the lease stops counting against capacity but remains adoptable if the device returns within a longer window, and destroy only past that.

*Rejected:* simply raising `DEVICE_LOST_MS`. It trades one arbitrary number for another and delays capacity reclamation for every genuine loss to buy tolerance for transient ones.

Consider alongside the reconnect entry above — a fix there reduces how often this threshold is reached, but does not make the threshold right.

### Out of scope

`DEVICE_OFFLINE_MS`. Reporting a device offline after 75 seconds is accurate and harmless; it destroys nothing.

---

## A leaked browser window is invisible to API monitoring

**Baseline:** branch `dev`, commit `76eaf68`.
**Found:** 2026-07-29 — the window leak above surfaced only because an operator looked at their own screen.
**Severity:** an acceptance gate that measures less than its name claims.

The Phase 3b soak checks `capacity_leak` as `deviceUsed > 1`, which is server-side accounting. In the observed leak that accounting was **correct** — the server had released the slot. The leak was entirely client-side, and no API-driven check can see it: nothing exposes how many tabs or windows the extension actually holds versus how many the server believes it holds.

Any soak or monitor built on the public API therefore cannot enforce "no capacity leak" as written; it can only enforce "no server-side capacity leak".

**Proposed fix:** have the device report its observed controlled-tab count in the heartbeat, and have the coordinator flag a divergence from its own lease count. That makes the leak detectable remotely and turns the gate into what it claims to be. Until then, treat the gate as partial and confirm tab counts visually during acceptance.

---

## Chrome's debugger banner appears across profiles

**Baseline:** branch `dev`, commit `76eaf68`. **Chrome behaviour, not a defect in this repo.**
**Severity:** an operator can detach the canary's debugger by accident, from a window they have no reason to associate with it.

Attaching `chrome.debugger` shows the "controlled by automated test software" banner on windows belonging to **other Chrome profiles**, not only the controlled one. Confirmed by the canary operator as long-standing behaviour on this machine.

`apps/extension/RUNBOOK.md` instructs operators not to click that banner's detach control, but the instruction reads as being about the controlled window. Someone seeing the banner over an unrelated profile may reasonably dismiss it there — detaching the canary and, per the reconnect entries above, potentially destroying its leases.

It also means the banner is **not** a per-tab indicator of whether a given tab is under CDP control, so it cannot be used as a diagnostic. That mistake was made once already during this rollout.

**Proposed fix:** documentation only. State in the extension runbook that the banner is process-wide, that dismissing it anywhere detaches the canary, and that it must not be read as evidence about a particular tab.

---

## The account plane has no HSTS, so a first plaintext request still crosses the wire

**Baseline:** branch `dev`, commit `1522cdc` (deployed version `dc9c378e-6e6b-416b-b7ef-038411bc4ae5`).
**Found:** 2026-07-31, during the review of the dashboard CSRF fix.
**Severity:** a first-visit plaintext sign-in POST exposes an email address and a live OTP code to anyone on the path.

`apps/backend/src/index.ts` now redirects the account plane to `https://` when `url.origin !== CANONICAL_ORIGIN` — but a 308 only fires *after* the request has already been received, body included. Nothing tells a browser not to send the plaintext request in the first place, because no response sets `Strict-Transport-Security`. Cloudflare's Always-Use-HTTPS is an account setting, not a property of this repo, and was off when this was written (`http://understudy.proofof.tech/dashboard` returned `200` before the scheme pin landed).

Scope it accurately before acting. The dashboard session cookie is `__Host-`-prefixed and therefore `Secure`, so a session token never traverses plaintext regardless. The real exposure is narrower and still worth closing: the `email` field and the 6-digit `code` field of a sign-in POST, on a first visit, before any redirect has been cached. `usk_` MCP bearers are a second case — a client calling `http://understudy.proofof.tech/mcp` now receives a 308, and 308 preserves the body and headers, so the token has already crossed by then.

**Proposed fix:** add `Strict-Transport-Security: max-age=31536000; includeSubDomains` to the dashboard middleware's header block in `apps/backend/src/dashboard/app.ts` (alongside `Cache-Control`, `Referrer-Policy`, and the CSP), and to the `/mcp` and OAuth responses if they are to be covered too — the header is only honoured when served over https, so it must ride the responses a client actually receives on the canonical origin. Consider `preload` only after confirming no sibling subdomain of `proofof.tech` needs plaintext, since `includeSubDomains` applies to all of them. Enabling Always-Use-HTTPS on the zone is a complementary control, not a substitute, because it lives outside this repo and is invisible to review here.

**Why deferred:** it is an addition beyond what the CSRF fix set out to do, not a defect in it, and the fix was shipping against a live outage.

---

## Allowed origins are a pairing-time seed, not a live authorization policy

**Baseline:** branch `dev`, commit `1522cdc` (deployed version `dc9c378e-6e6b-416b-b7ef-038411bc4ae5`).
**Found:** 2026-07-31, during architectural review of the dashboard card reorder.
**Severity:** the dashboard presents a control that reads as an authorization boundary and is not one. Removing an origin does not withdraw it.

`setAllowedOrigins` (`apps/backend/src/account-directory.ts`) writes **only** `users.allowed_origins`. Nothing touches the paired device's row, and there is no push path to a connected extension. The list reaches a device exactly once, at pairing: `claimPairingCode` copies `user.allowedOrigins` into the `devices` row and returns it as `originPolicy`; the extension persists it and re-declares it on every connect; `DeviceAgent.onMessage` canonicalizes it into `registerDevice`, which stores `origin_policy_json`; and `createLease` (`apps/backend/src/tenant-coordinator.ts`) enforces `isSubset(input.allowedOrigins, origin_policy_json)` against **that** snapshot. `createSession` (`apps/backend/src/api/sessions.ts`) never reads the account's live list. After pairing, the account list has zero runtime effect.

The consequence is asymmetric with the UI's implication. Adding an origin does nothing until re-pairing — which the copy said. **Removing one also does nothing**, which it did not: the paired browser keeps driving the withdrawn origin until the device is revoked. Re-pairing does not withdraw it either, because `claimPairingCode` inserts a *new* device row and never revokes the predecessor, which remains `revoked_at IS NULL` carrying the older, broader policy. In practice the extension overwrites its own local config so the orphaned `udt_` credential stops being used, but nothing server-side enforces that.

Mitigated for now in copy only (`apps/backend/src/dashboard/pages.ts`, the Allowed origins card): the card now states that editing does not affect an already-paired browser and that withdrawing an origin requires revoking the browser.

**Proposed fix:** make the origin policy server-authoritative. Resolve a device's allowed origins from `users.allowed_origins` at lease time — or push them on connect/heartbeat — and treat the extension's declared list as an upper bound to intersect with, never as the authority. Dashboard edits then take effect immediately in both directions, the narrowing gap closes, and pairing-time origins become irrelevant, so the empty-list gate on the pairing button could be deleted for free. Separately, have `claimPairingCode` revoke the superseded device row.

**Why deferred:** it is a protocol change with a version-skew story (an older extension must keep working against a newer backend), not a UI change, and it was found while shipping an unrelated one-card reorder. Do not fold it into that commit.

**Note on the gate:** do NOT "simplify" by allowing pairing with an empty origin list before doing the above. Four layers refuse it, and the last one is the trap. (1) The dashboard's disabled button is advisory only. (2) `createPairingCode` (`apps/backend/src/account-directory.ts`) returns `no_origins`, which the route turns into a 303 to `/dashboard?notice=no-origins`. (3) `claimPairingCode` repeats the check for origins emptied between minting and redemption, collapsed to a 404 because every pairing failure mode is deliberately indistinguishable. (4) **`normalizeProfileConfig` (`apps/extension/src/core/profile-client.ts`) is ON the pairing path, not merely a manual-config backstop**: `pairDevice` (`apps/extension/src/entrypoints/background.ts`) feeds the claim response straight into `profileClient.configure()`, whose first statement normalizes and which rejects `originPolicy.length < 1`. `redeemPairingCode` does not check length, so nothing catches it earlier. The wire invariant for the rework is therefore: the claim response must carry at least one canonical origin, or the extension's validator must be relaxed and rolled out FIRST — otherwise every pairing fails with a generic "Pairing failed" after the server has already consumed the single-use code and emitted paired telemetry.

---

## A paired extension dials a hardcoded localhost dev socket forever

**Baseline:** branch `dev`, commit `1522cdc`.
**Found:** 2026-07-31, on a freshly installed extension paired through the dashboard.
**Severity:** continuous console errors on every user's browser, and a permanent reconnect loop doing no work.

`DEFAULT_WS_URL = "ws://localhost:8787"` is hardcoded in both `apps/extension/src/entrypoints/background.ts` and `apps/extension/src/entrypoints/sidepanel/App.tsx`. It is the **attended** (legacy) session socket's default, pointing at a local `wrangler dev`. A real user never has one. The backstop alarm calls `ensureConnection()` → `connectWs()` → `ReconnectingWs`, which dials it and retries indefinitely.

Measured on a paired, working browser driving real sessions — not merely at install:

```
[error] network :: WebSocket connection to 'ws://localhost:8787/' failed:
        Error in connection establishment: net::ERR_CONNECTION_REFUSED
        (chrome-extension://<id>/background.js)
```

Two consecutive 25-second samples of the service-worker console counted **24** then **48** occurrences. `ReconnectingWs` backs off 500 ms doubling to a 30 s cap (`BACKOFF_BASE_MS`/`BACKOFF_CAP_MS` in `apps/extension/src/core/ws-client.ts`), so one instance should settle to ~2/minute. Observing ~1–2/second, and *rising* between samples, means reconnect loops are accumulating rather than backing off — the count should have fallen, not doubled. The accumulation mechanism was not isolated; `ensureConnection` does guard on `ws !== null`, so whoever fixes this should diagnose where additional `ReconnectingWs` instances come from rather than assume the guard is sufficient.

Note this is unattended-path collateral: the browser was paired via the dashboard and never configured for attended mode, yet the attended peer dials regardless.

**Proposed fix:** do not connect at all without a configured attended session. The `DEFAULT_WS_URL` constant should go; `currentWsUrl` should be `null` until the panel supplies one, and `ensureConnection` should return early on a null URL. Then fix the instance accumulation separately, since a single leaked loop against a *reachable* backend would be invisible in the console while still burning a socket.

**Do not fix by catching the error.** The message is emitted by Chrome's network stack, not by application code — there is no promise to catch and no handler that suppresses it. Only not dialing removes it.

---

## Pairing and per-browser authorization need to be rebuilt

**Baseline:** branch `dev`, commit `1522cdc`.
**Raised:** 2026-07-31 by the maintainer, after running the first full end-to-end pairing.
**Type:** requirements for a follow-up design, not a defect report.

The current flow — one account-wide origin list, snapshotted once into a device by a copy-pasted 8-character code, with account-wide API tokens — is the minimum that worked. Three changes are wanted, and they interlock enough to be designed together rather than piecemeal:

1. **Origins settable per browser, and kept in sync.** Today the list is per *account* and reaches a device only at pairing (see "Allowed origins are a pairing-time seed, not a live authorization policy" above). Two browsers paired to one account cannot be given different reach — a personal profile and a work profile get identical authority. The fix for the sync half is the server-authoritative resolution described in that entry; this adds that the authoritative record should be **per device**, with the account list acting as a default for new pairings rather than the only value.

2. **Link-based pairing instead of code transcription.** The user reads an 8-character code off the dashboard and types it into the side panel. It should be a click: the dashboard offers a link (or QR) that the extension consumes directly. Note the constraint that makes this non-trivial — the code is redeemed by the *extension*, which has no dashboard session, so a clickable link must carry a one-time secret to a context the browser can route to the extension without the page being able to read it. `chrome.runtime.onMessageExternal` with an `externally_connectable` entry for the canonical origin is the obvious mechanism; it changes the manifest and therefore the install-time permission prompt.

3. **API keys scoped per pairing.** `usk_` tokens are account-wide, so one leaked token drives every paired browser and revoking it breaks all of them. A token should be issuable against a single device, so blast radius and revocation both follow the browser. This also gives the MCP surface a natural answer to "which browser should this call drive?" when an account has several — today `browser_open` picks, and with per-device tokens the token itself decides.

**Why deferred:** each of the three changes the pairing wire contract, and (2) changes the extension manifest, so all three carry a version-skew story between an installed extension and a deployed backend. They want one design pass and one coordinated rollout, not three independent commits — and must ship separately from any dashboard copy or layout work.

---

## Page URLs reach the model outside the UNTRUSTED PAGE CONTENT delimiters

**Baseline:** branch `dev`, commit `1522cdc`.
**Found:** 2026-07-31, while verifying the `understudy-browser` skill against the tool surface.
**Severity:** a prompt-injection surface the code's own header comment says is closed.

`apps/backend/src/mcp/outcomes.ts` opens by stating that page-derived text — "a11y trees, **page URLs**, extension error strings that may embed page content" — is wrapped in `UNTRUSTED PAGE CONTENT` delimiters. Page URLs are not. `event.url` is interpolated outside the markers in at least `Page snapshot of ${event.url}`, the screenshot caption, and the post-navigation `Now at: ${event.url}.`

A URL is attacker-influenceable: a redirect, a crafted link, or any page that controls its own query string can put arbitrary text there, and it arrives in the client model's context as trusted server prose. The delimiters are explicitly described in that same comment as the weakest mitigation in the stack, which makes a gap in them cheap to exploit and easy to overlook.

This matters more now that `.claude/skills/understudy-browser/SKILL.md` ships: it instructs an agent that content inside the markers is data and, by implication, that text outside them is the server speaking.

**Proposed fix:** wrap the URL, or strip it to origin + path and escape it, at every interpolation site in `outcomes.ts`. Prefer one helper so the guarantee is enforced in a single place, matching that module's stated reason for existing. Then re-read the header comment and make it true of every site, or narrow the claim.

**Why deferred:** it is a distinct surface from the dashboard CSRF work this was found alongside, and it wants a single-helper fix plus a test that pins delimiter placement rather than a scattered patch.

---

## The MCP surface tells clients refs are single-use; the extension does not consume them

**Baseline:** branch `dev`, commit `1522cdc`.
**Found:** 2026-07-31, verifying skill guidance against the implementation.
**Severity:** every MCP client is instructed to take a redundant snapshot per action.

Three places tell clients refs are single-use — `apps/backend/src/mcp/outcomes.ts` ("Refs are fresh for this page state, SINGLE-USE, and die on any navigation") and two descriptions in `apps/backend/src/mcp/tools.ts`. The extension does not implement that: `CdpSession.resolveRef` (`apps/extension/src/driver/cdp.ts`) is `this.refMap.get(ref) ?? null`, a pure lookup with no delete. Refs are scoped to a snapshot generation and remain valid for the whole epoch; `tools.ts` even says elsewhere that scrolling does not invalidate them.

So the stated contract is stricter than the enforced one. A client obeying it round-trips an extra `browser_snapshot` before every action, which on this surface costs a full command through the queue, the device, and back.

**Proposed fix:** decide which is true and make both say it. Either consume the ref in `resolveRef` (making the contract real, at the cost of breaking any client that reuses one) or relax the wording to what is enforced — refs are valid until the page navigates or the generation changes. The second is cheaper and matches observed behavior; the first is defensible if single-use is wanted as a guard against an agent acting on a stale mental model.

**Why deferred:** it is a contract change visible to every connected client, so it wants deciding deliberately rather than as a side effect of a docs pass.
