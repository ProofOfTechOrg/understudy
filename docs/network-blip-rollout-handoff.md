# Network-blip diagnosis and rollout handoff

## Current state

This record applies to release branch `feat/protocol-3-local-card-vault`, which starts at implementation base `3d7ddeedafa90c6b28cbe7204ae411cda93bffa4`. Production still serves the pre-change Worker until an operator runs the gated release process.

Historical sanitized observations:

| Case | Disruption | Recovery | Lease | Status |
| --- | ---: | ---: | --- | --- |
| Test A | 10 seconds | 12,045 ms | connected | Passed |
| Test A | 30 seconds | 7,140 ms | connected | Passed |
| Test A | 60 seconds | Pending | Pending | Pending |
| Test A | 120 seconds | Pending | Pending | Pending |
| Test B | 30 seconds | Pending | Pending | Pending |

The pending cases must run before selecting reconnect changes. No production
soak may be active. Firewall or Tailscale mutation requires explicit operator
confirmation immediately before the break.

## Repository harness

`scripts/network-blip-harness.sh` is the sanitized authoritative harness. Raw
evidence and credentials stay outside Git and must be mode `0600`.
Every control request has bounded connection and total response deadlines, so a
stalled probe terminates and reaches the cleanup trap instead of hanging the
outage test indefinitely.

```bash
export UNDERSTUDY_DEVICE_ID='<exact paired UUID>'
export UNDERSTUDY_TEST_ORIGIN='https://<exact allowed origin>'
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

Test A blocks every currently resolved IPv4/IPv6 address for
`understudy.proofof.tech`. Test B takes Tailscale down and restores it. The
harness persists the create idempotency key before disruption, captures an
immediate pre-break `lastSeenAt`, requires a changed post-break value, records
the lease outcome, and verifies network restoration and capacity cleanup
through traps.

The credential file accepts one JSON string, `{ "token": "..." }`, or a
one-key legacy token map. Its value is never written to evidence or stdout.

## Deterministic result rule

Apply exactly one branch:

1. If any Test A recovery exceeds 30 seconds or loses the lease, make
   `chrome.alarms` authoritative for both WebSocket retry paths. Persist desired
   state, retry deadline, and bounded backoff. Retain `setTimeout` only as
   sub-30-second acceleration.
2. If all Test A cases recover within 30 seconds but Test B exceeds 30 seconds
   or has a worse lease outcome, retain only the canonical origin. On every
   durable alarm request a fresh connect ticket as the connectivity/DNS probe,
   discard stale socket attempts, and keep retrying against
   `https://understudy.proofof.tech`. The 15-minute suspended state preserves
   the assignment while the client resolver recovers.
3. If every baseline case is within 30 seconds, run sustained backgrounding
   with Chrome occluded and no local interaction. Fix the first observed failed
   layer.

Do not add a second control origin. A second registrable DNS zone might help an
authoritative-zone outage, but it does not address the suspected local
Tailscale/resolver path and expands where device credentials can be sent.

## Post-fix acceptance

After any selected retry fix, rerun Test A 30 seconds, Test A 120 seconds, and
Test B 30 seconds. Done means:

- recovery is at most 30 seconds;
- the device produces a fresh post-break heartbeat;
- the exact lease is connected or recovers through the documented suspension
  and adoption path without duplication;
- cleanup reaches a terminal session and restores capacity;
- no secondary origin receives a ticket or credential;
- the three independent review lanes and the full repository gate pass.
