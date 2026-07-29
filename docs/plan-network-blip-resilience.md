<!-- Content type: How-to -->

# Plan: diagnose and fix network-blip session loss

**Baseline:** branch `dev`, commit `76eaf68`. Understudy version
`e0673967-0ca5-4cca-81ee-50d4088cec33`. Extension `0.1.1` from
`5cc969024b32380f1a3e14ff6f72e8d0c808b086`. Canary device
`aaf119f2-a85f-46b4-8b53-8e92196d6275`, credential version 2.

Line numbers are as-of that commit and must be re-confirmed before editing.

## What happened, and what is actually established

Phase 3b soak run 1 died 40 minutes in. `docs/unattended-production-rollout.md`
holds the full record; the essentials:

| Fact | How it is known |
|---|---|
| Tailscale activated its interface and **reconfigured DNS** at `06:02:16Z` | `journalctl`, inside the failure window |
| A second long-lived socket (1Password's notifier) dropped at `06:03:00Z` and recovered at `06:03:06Z` | same journal — **six seconds** |
| Understudy's device was still `offline` at `06:09:49Z`, lease already `lost` | soak sample |
| The machine never slept and Chrome never restarted | four-week uptime, zero suspend records, Chrome process older than the soak |

**The problem is not the outage. It is the recovery.** A six-second
interruption that another application shrugged off cost this device every
session it held, terminally, plus a leaked window.

## What is NOT established

Be careful here — two plausible mechanisms have already been written down and
one has already been wrongly declared dead.

1. **Timer death.** Both reconnect paths use `setTimeout`
   (`apps/extension/src/core/ws-client.ts:134`,
   `apps/extension/src/core/profile-client.ts:716`), which does not survive
   service-worker eviction. But the `ws-backstop` alarm
   (`apps/extension/src/entrypoints/background.ts:99`) fires every 30 seconds
   and calls `ensureConnection`, which *should* bound recovery near 30 seconds.
   It did not. So either the alarm was delayed, or attempts were firing and
   failing.
2. **DNS.** The trigger was a DNS reconfiguration, not a plain link drop. If
   resolution for `understudy.proofof.tech` stayed broken or poisoned inside
   Chrome for minutes, reconnect attempts would fail no matter how promptly they
   were scheduled. 1Password may well have been holding an established
   connection or a cached address, which would explain its six-second recovery
   without contradicting this.
3. **Backgrounded Chrome / MV3 eviction.** Still open. An 18-minute attempt to
   test it was **invalid** — the operator was switching windows throughout, so
   the condition never held. Do not cite that run as evidence in either
   direction.

The tests below are designed to separate these, not to confirm a favourite.

## Sequencing

**These tests destroy any running soak.** Breaking connectivity is exactly the
condition that kills a lease. Either let the current soak finish and record its
result first, or accept restarting it — do not run both and then argue about
which caused what. Phase 3b's clock restarts either way.

## Instrumentation

The monitor cannot live on the machine whose network is being broken. It does
not need to: **the recovery latency is measurable from the server side alone.**

- `t_break` and `t_restore` are chosen by the operator, so both are known exactly.
- `GET /v1/devices` returns `lastSeenAt`. Polls during the outage fail; that is
  fine. The first poll after `t_restore` whose `lastSeenAt` is fresh (< 30 s old)
  gives `t_device_back`.
- **`recovery_latency = t_device_back − t_restore`** is the number this plan
  exists to produce. Run 1 implies minutes. Anything above a few seconds is the
  defect.

Capture at the same time, because they discriminate between mechanisms and only
an operator at the machine can see them:

- `chrome://extensions` — does the card read `service worker` or
  `service worker (Inactive)` during the outage? Answers eviction directly.
- The service-worker console — are reconnect attempts logged during the outage,
  and do they fail with a DNS error or a connection error? Answers 1 versus 2.
- The side panel's local event log, which survives longer than the console.
- Tab and window count afterwards, for the leak.

## Test A — pure connectivity loss, DNS untouched

Isolates "does reconnection work at all" from anything DNS-specific. Block
egress to the service without disturbing the resolver:

```bash
# resolve first so the rule pins addresses, not names
getent ahosts understudy.proofof.tech
sudo iptables -I OUTPUT -d <each-resolved-ip> -j REJECT
# ... wait the test duration ...
sudo iptables -D OUTPUT -d <each-resolved-ip> -j REJECT
```

Run at **10 s, 30 s, 60 s, 120 s**, with a live session each time, recording
`recovery_latency` and whether the lease survived.

Expected if healthy: recovery within a few seconds of restore at every
duration; the lease survives 10 s and 30 s, and is `lost` at 120 s by policy
(`DEVICE_LOST_MS = 90_000`).

The interesting failure is a **short** outage producing a **long** recovery.
That is run 1's signature and points at mechanism 1.

## Test B — replicate the actual trigger

```bash
sudo tailscale down    # observe
sudo tailscale up      # observe
```

Same measurements. This reconfigures DNS, which Test A deliberately does not.

- Test A clean, Test B slow → the problem is DNS-specific, and the fix is about
  resolution and connection re-establishment, not timers.
- Both slow → reconnection is broken generally; timers or alarm delivery.
- Both clean at every duration → the mechanism is not reproducible this way, and
  the next suspect is sustained backgrounding, tested properly this time: machine
  genuinely untouched, Chrome fully occluded, sampled from elsewhere.

## Fixes, chosen after the tests and not before

Deliberately not pre-committed — the wrong fix here is easy to justify and
useless, and two mechanisms are still live.

**If timer death (1):** drive retries from `chrome.alarms` rather than
`setTimeout`, keeping `setTimeout` only for sub-30-second attempts while the
worker is known alive, and treat the backstop alarm as the authority on whether
a connection should exist — which it nearly is already.

**If DNS (2):** the socket must be re-established in a way that re-resolves
rather than reusing a poisoned or cached answer, and repeated resolution failure
must not push the backoff to its 30-second cap and stay there.

**Independent of both, and worth doing regardless** — these are already recorded
in `DEFERRED.md` and are what convert a blip into destroyed work:

- **Ninety seconds destroys every session on the device.** Separate capacity
  reclamation from lease destruction: free the slot promptly, but keep the lease
  adoptable for a longer window and destroy only past that.
- **A lost lease leaks a browser window.** Send an orphan list on device sync so
  the extension closes tabs for leases the server has already released.

Fixing recovery lowers how often the cliff is reached. It does not make the
cliff the right shape.

## Verification

- Test A at 10 s and 30 s: lease survives, `recovery_latency` within a few
  seconds, no leaked window.
- Test A at 120 s: lease is `lost` **by policy**, and — once the leak fix lands —
  no window survives.
- Test B: indistinguishable from Test A at the same durations.
- A soak that spans at least one real network transition without losing its
  session.
- Quality gate on any code change: clean-code, architecture, and QA lanes.

## Out of scope

- `DEVICE_OFFLINE_MS`. Reporting a device offline at 75 seconds is accurate and
  destroys nothing.
- The heartbeat interval. 22 seconds is not implicated; the heartbeat was fine
  until the socket went away.
- Metamind. Its sweep already handles a terminal understudy session correctly —
  it settles the lease rather than retrying forever. Nothing here needs a
  consumer change.
