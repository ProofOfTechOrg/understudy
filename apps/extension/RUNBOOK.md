<!-- Content type: How-to -->

# Verify the Understudy extension in Chrome

This runbook covers the protocol-3 extension, pairing, policy reconciliation,
owned-window recovery, and the extension-local payment-card vault. Use a
dedicated Chrome profile. Chrome's debugger banner is process-wide and cannot
be suppressed; dismissing it can detach a controlled tab.

## Automated gate

From the repository root, with Node 22 or newer:

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm --filter @understudy/extension test:e2e
pnpm --filter @understudy/extension build:staging
pnpm --filter @understudy/extension verify:staging-build
pnpm --filter @understudy/extension build:store
pnpm --filter @understudy/extension zip:store
```

`test:e2e` uses local Chrome and the existing `ws` package. It loads the store
build, exercises bounded semantic discovery across large pages, frames, and
shadow DOM, then exercises the real panel message boundary and IndexedDB. It
verifies a non-extractable persisted key and encrypted record, reloads the
extension, and deletes the vault. No card marker may appear in protocol frames,
network, console, exception, storage, journal, or ordinary log output.

## Verify semantic discovery

1. Confirm `device_hello` advertises `semantic-elements-v1` before enabling the
   new MCP tools for a canary.
2. Capture the default viewport-interactive snapshot. It must return at most 80
   descriptors and 32 KiB, even on the 10,000-element fixture.
3. Find the late offscreen target by exact label. The result must not emit the
   intervening fixture text.
4. Inspect the target and continue the original cursor. Both operations must
   preserve snapshot ID, generation, and refs without a full capture.
5. Find targets inside a same-process iframe, a cross-origin OOPIF, and open
   shadow DOM. An unresolved child frame must produce partial coverage and a
   bounded placeholder.
6. Trigger the fixture's custom click handler, then request `changesOnly`. The
   same loader, URL, and frame topology must produce a structured delta; a
   navigation must return a normal snapshot with `delta.applied: false`.
7. Replace or rename a retained target. The old ref must return a fixed stale or
   target-changed reason and must never dispatch to a replacement.
8. Evict the extension worker. Old cursors must return `cursor_expired`; old
   refs must not revive from the persisted generation.
9. Confirm editable, password, and synthetic card values never appear in
   protocol events, WSS, MCP output, logs, journals, storage, or analytics.
10. Enter payment sensitive mode. Semantic capture, find, inspect,
    continuation, screenshots, page-derived errors, and automatic retry remain
    unavailable before any page data is read.

## Load the release build

1. Build with `pnpm --filter @understudy/extension build:store`.
2. Open `chrome://extensions`, enable Developer mode, and choose Load unpacked.
3. Select `apps/extension/.output/chrome-mv3-store/`.
4. Confirm the manifest requests only the expected debugger, storage, alarms,
   side-panel, and canonical-host permissions.

Do not use WXT development mode for release acceptance.

## Verify staging pairing

Use the pinned staging build to test hosted changes before store submission:

1. Build with `pnpm --filter @understudy/extension build:staging`.
2. Run `pnpm --filter @understudy/extension verify:staging-build`.
3. Load `apps/extension/.output/chrome-mv3-staging/` through `chrome://extensions`.
4. Confirm Chrome reports extension ID `ebpcldlibljfjhcfknagjcdmhggeknfc`.
5. Sign in at `https://staging.understudy.proofof.tech/dashboard` and pair the browser.
6. Reject pairing messages from production, loopback, query-bearing, fragment-bearing, and trailing-slash sender URLs.
7. Verify hosted control, OAuth, Model Context Protocol (MCP), dashboard, privacy, and side-panel links remain on staging.

The staging extension retains internal controls and broad host permissions. Do not submit it to the Chrome Web Store.

## Pair and reconcile policy

1. Sign in at `https://understudy.proofof.tech/dashboard`.
2. Set the default general origins. An empty default is valid but cannot open a
   session.
3. Select **Pair this browser**. The dashboard must send a one-time offer
   directly to the extension; no offer appears in a URL or copy field.
4. Confirm the side panel reports the device label, online state, policy
   version, and zero owned windows.
5. Add an exact origin. It must remain unavailable until the extension
   acknowledges the new version, then become available without re-pairing.
6. Remove an origin used by a controlled tab. The backend must fence the lease,
   terminalize the session, and push the narrower policy immediately.
7. Replay or alter the pairing offer and try it from another origin. Each must
   fail. Pairing the same installation again must rotate its credential rather
   than leave a live predecessor.

## Exercise lifecycle convergence

Use two sessions to reach the default capacity and verify profile and origin
collisions independently.

- After a control-socket interruption, the device becomes `recovering` at 75
  seconds and the sessions remain pollable.
- At 90 seconds, sessions become `suspended` and capacity is reclaimed. Their
  profile and origin collisions still apply.
- A same-browser-epoch inventory can recover the exact assignment.
- A new browser epoch adopts by incrementing the lease fence only when current
  capacity, profile, and policy permit it.
- Failed adoption terminalizes the old session as `lost`.
- After 15 minutes suspended, the lease becomes `lost` and exact orphan cleanup
  is sent.

Create a controlled window, terminate the extension worker immediately after
Chrome creates it, then wake the worker. The `storage.session` checkpoint and
content-free `storage.local` recovery mirror must contain the browser epoch,
IDs, and full lease fence before the runtime assignment. Recovery may close
registered unowned windows and server-reported exact orphans, but it must not
close an ordinary restored tab.

Then exit Chrome completely so `storage.session` is cleared, reopen the same
profile, and wake the extension. It must reconstruct the exact assignment and
owned-window registry from the local recovery mirror without closing the owned
window or adopting an ordinary restored tab.

For attended mode, detach deliberately and through Chrome's debugger banner.
The extension must send the current attachment UUID and tab ID. The backend
enters `idle`, clears browser data, tabs, URL, and dialogs, and ignores a stale
detach from an older attachment. Socket loss remains `detached`.

## Enroll and submit a synthetic card

Use test data only.

1. In the side panel, add a card alias containing only letters, digits, `.`,
   `_`, or `-`. The alias must contain no card digits.
2. Confirm invalid Luhn data, expired dates, and a CVV outside three or four
   digits are rejected before storage.
3. Save a valid synthetic card. Confirm the form is cleared.
4. Add the checkout's exact top-level origin to the local payment-origin list.
5. Open a session whose general policy includes the same origin.
6. Call `browser_list_cards`. It may return only aliases and approved origins.
7. Snapshot the form and map distinct refs for PAN, combined or split expiry,
   CVV, optional cardholder name, and submit.
8. Call `browser_submit_card` once. From sensitive-mode entry onward, no
   snapshot, screenshot, dialog, URL, title, tab metadata, page error, console,
   network artifact, generic command, clipboard, download, or arbitrary log may
   escape. The payment tab closes on every exit path.
9. A failure before any card byte is inserted returns `not_started`. Any later
   result is `outcome_unknown`, including a completed submit. Never retry the
   latter automatically or inspect the destroyed tab for approval.
10. Delete the card, then delete the whole vault. Repeating deletion must be
    harmless. Losing the key while records exist must fail closed as key loss,
    not silently create a new key.

## Network-blip diagnosis

Run `scripts/network-blip-harness.sh` from the repository root. The credential
file and evidence JSONL must be absolute paths outside Git and mode `0600`.
Set the three required environment variables shown below and confirm no
production soak is active. The harness asks for `BREAK` immediately before
changing firewall or Tailscale state and restores state through traps.

Required baseline cases remain:

```bash
UNDERSTUDY_DEVICE_ID='<device-uuid>' \
UNDERSTUDY_TEST_ORIGIN='https://allowed.example' \
UNDERSTUDY_SOAK_CONFIRMED_INACTIVE=yes \
scripts/network-blip-harness.sh a 60 /absolute/credential.json /absolute/test-a-60.jsonl

UNDERSTUDY_DEVICE_ID='<device-uuid>' \
UNDERSTUDY_TEST_ORIGIN='https://allowed.example' \
UNDERSTUDY_SOAK_CONFIRMED_INACTIVE=yes \
scripts/network-blip-harness.sh a 120 /absolute/credential.json /absolute/test-a-120.jsonl

UNDERSTUDY_DEVICE_ID='<device-uuid>' \
UNDERSTUDY_TEST_ORIGIN='https://allowed.example' \
UNDERSTUDY_SOAK_CONFIRMED_INACTIVE=yes \
scripts/network-blip-harness.sh b 30 /absolute/credential.json /absolute/test-b-30.jsonl
```

Do not add a secondary control origin. Use the result table in
`docs/network-blip-rollout-handoff.md` to select any retry change.

## Acceptance record

Record the source SHA, extension version, browser version, device ID, policy
version, session/lease fences, observed timestamps, and fixed outcome enums.
Keep card data, raw credentials, and raw outage evidence outside Git.

Release only when automated checks pass, the physical-window and sensitive-mode
negative paths pass in real Chrome, and all three independent review lanes are
clean.
