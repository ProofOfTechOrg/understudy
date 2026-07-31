<!-- Content type: How-to -->

# Verify unattended sessions in a real Chromium profile

This runbook verifies the production extension against one tenant-dedicated Chrome profile. Automated tests do not prove Chrome focus behavior, paused-popup containment, restart recovery, or a real authenticated website session.

## Prepare the operator environment

Before you start:

- Use Chrome 125 or newer
- Create or designate a profile used by one tenant only
- Configure Chrome startup to **New Tab**, not **Continue where you left off**
- Log into the required sites and complete Multi-Factor Authentication (MFA) or CAPTCHA
- Keep the machine, Chrome, and network awake
- Do not open DevTools on a controlled tab
- Treat Chrome’s debugger banner as process-wide: it may appear in unrelated profiles or windows
- Do not dismiss the debugger banner anywhere; doing so can detach the controlled tab
- Do not use the banner as a per-tab diagnostic

Two sessions in one profile share cookies, local storage, IndexedDB, and browser extensions. Use separate profiles when the sessions require different browser identities.

## Build and load the extension

From the repository root:

```bash
pnpm --filter @understudy/protocol build
pnpm --filter @understudy/extension typecheck
pnpm --filter @understudy/extension test
pnpm --filter @understudy/extension build
```

Then:

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Select **Load unpacked**
4. Choose `apps/extension/.output/chrome-mv3/`
5. Approve debugger, storage, alarms, and host permissions

Use this production build. Do not use WXT development mode for acceptance.

## Enroll one device

Provision a device UUID and credential in the backend’s `DEVICE_TOKENS` secret. Store only the credential’s SHA-256 digest in that mapping.

Open the extension side panel and enter:

1. The backend HTTPS origin
2. The device UUID
3. The raw device credential
4. One exact allowed origin per line
5. **Enable unattended hosting**

Select **Save enrollment**. The status must become `connected`.

Confirm the device through the caller API:

```bash
curl --fail-with-body \
  -H 'Authorization: Bearer caller_token_here' \
  https://understudy.example/v1/devices
```

Done means the response reports the device online with capacity 2, usage 0, current browser and extension versions, and a recent `lastSeenAt`.

## Create two isolated runtimes

Use disjoint origin sets and different profile keys:

```bash
curl --fail-with-body \
  -X POST \
  -H 'Authorization: Bearer caller_token_here' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: 00000000-0000-4000-8000-000000000011' \
  --data '{"mode":"unattended","allowedOrigins":["https://one.example"],"profileStateKey":"account_one"}' \
  https://understudy.example/v1/sessions
```

Repeat with another UUID, `https://two.example`, and `account_two`.

Done means:

- Each response reaches `connected`, either immediately or through status polling
- Chrome contains two extension-owned tabs
- Each session status reports one tab only
- `GET /v1/devices` reports usage 2

Create a third session. It must fail with `429`.

Try an overlapping origin and then a reused profile key. Each must fail with `409`.

## Verify command routing

Send concurrent reads to both session IDs. Confirm each result reports only its session-owned tab.

Send input actions to both sessions. Confirm text and clicks never cross tabs. If inactive-tab `Input.*` fails or targets the wrong tab, stop rollout and add the planned profile-wide focus mutex for input operations.

For one session:

1. Navigate within its allowed origin and confirm success
2. Trigger a redirect to another origin and confirm rejection
3. Trigger JavaScript top-level navigation to another origin and confirm rejection
4. Open a popup and confirm Chrome closes it before its first request
5. Load a cross-origin image or frame and confirm it still works

Paused-popup containment is a release gate. Do not weaken the exact-origin boundary if the production build cannot prove it.

## Verify one-slot cleanup

Delete one session:

```bash
curl --fail-with-body \
  -X DELETE \
  -H 'Authorization: Bearer caller_token_here' \
  https://understudy.example/v1/sessions/session_id_here
```

Poll status if DELETE returns `202`.

Done means Chrome closes exactly one leased tab, the other session remains functional, and device usage becomes 1.

## Evict the service worker

Open the extension’s service-worker inspection page from `chrome://extensions` and stop the worker. Do not inspect a controlled tab.

Wake the extension by reopening the side panel or sending a command.

Done means:

- The same browser epoch restores assignments from session storage
- The extension does not create duplicate tabs
- A completed unacknowledged result replays
- Unrelated tabs remain untouched

## Restart Chrome

Close and reopen Chrome within 90s. This is a deliberate destructive acceptance step for active browser execution.

Done means:

- Each still-live lease receives a fresh blank tab
- Tab IDs, attachment generations, and accessibility refs change
- No prior URL is restored
- Restored ordinary tabs remain uncontrolled and open
- Session status reports reconciliation
- New writes remain blocked until DELETE and new session creation

## Verify an ambiguous write

Use a non-production test action with an observable idempotent marker. Stop Chrome after the write starts but before the result acknowledgement.

Done means command polling returns `command_outcome_unknown`, `safeToRetry` is false, and the backend blocks further writes for that session. The extension must never execute that granted payload again.

## Rotate the device credential

Add the new credential digest with a higher `credentialVersion`, update the extension enrollment, then remove the old digest.

Done means the old control socket closes, old tickets fail, the new credential reconnects, and no replayed ticket replaces the authoritative socket.

## Run the 24-hour soak

Create a read-only unattended session. Send a valid read less than every 2 hours to refresh idle expiry.

During the soak:

- Confirm the session expires at its exact 24-hour hard deadline despite activity
- Confirm another idle session expires after 2 hours without a valid command
- Compare Durable Object requests and duration before and after
- Confirm billed duration scales with handler execution, not lease wall time
- Confirm no unknown-write surprise, duplicate tab, or leaked capacity

## Verify attended compatibility

Use the side panel’s attended section:

1. Enter the legacy session WebSocket URL
2. Open the intended user-owned tab
3. Select **Attach active tab**
4. Run a snapshot and one approved test action
5. Select **Detach tab**

Done means the command path negotiates protocol 2 after attachment, reports only that tab, and detaching leaves the tab open.

Chrome’s debugger banner is process-wide. Dismissing it in any Chrome profile or window can detach the controlled tab, and its presence does not identify which tab is controlled.

## Run the automated store-release checks

From the repository root:

```bash
pnpm --filter @understudy/protocol build
pnpm --filter @understudy/extension typecheck
pnpm --filter @understudy/extension test
pnpm --filter @understudy/extension build
pnpm --filter @understudy/extension build:store
pnpm --filter @understudy/extension zip:store
pnpm --filter @understudy/backend typecheck
pnpm --filter @understudy/backend exec vitest run test/dashboard-auth.test.ts
pnpm typecheck
pnpm test
```

Inspect the store output:

```bash
zipinfo -1 apps/extension/.output/understudyextension-0.1.2-chrome-store.zip
unzip -p apps/extension/.output/understudyextension-0.1.2-chrome-store.zip manifest.json | jq
rg -a "localhost:8787|Advanced: manual configuration|Attended session" \
  apps/extension/.output/chrome-mv3-store
```

Done means the ZIP has `manifest.json` at its root; its icons and listing metadata are present; permissions are `debugger`, `storage`, `alarms`, and WXT’s `sidePanel`; the only host permission is `https://understudy.proofof.tech/*`; and the final `rg` prints nothing.

## Accept the unlisted store build in Chrome

Use a fresh Chrome profile. Load `apps/extension/.output/chrome-mv3-store/` through `chrome://extensions` → **Load unpacked**; command-line extension loading is not an acceptance substitute.

1. Select the toolbar action. The Understudy side panel must open.
2. Leave the extension unpaired for at least 65 seconds. The service-worker console must show no localhost request, WebSocket attempt, or connection error.
3. Enter an invalid or expired pairing code. The field must retain and select the code, and the panel must show an actionable error.
4. Pair with a valid hosted code. The status must progress through **Connecting** to **Connected**, then show controlled-tab capacity.
5. Confirm **Manual configuration** and **Attended session** are absent.
6. With an active hosted session, select **Stop hosting**. Confirm the warning, then verify the session ends and the panel shows **Paused** without claiming hosting is enabled.
7. Confirm the Privacy and Support links open the intended HTTPS policy and public issue tracker.
8. Confirm `store-assets/screenshot-first-run-1280x800.png` still matches this build. Capture a replacement from the accepted build if the panel changed.

Do not submit the extension until `https://understudy.proofof.tech/privacy` returns `200`.

## Record the release decision

Enable additional tenants only when all conditions hold:

- Two controlled tabs route reads and inputs correctly
- Capacity, origin, and profile collisions fail with the expected statuses
- Redirect and popup containment hold
- Service-worker and browser restart behavior matches this runbook
- Credential rotation fences the predecessor
- The 24-hour and 2-hour expiries hold
- Durable Object duration does not scale with lease wall time
- No granted write executes twice

On failure, disable new leases, close or terminalize active leases and granted commands, and roll back application code. Keep migration `v2`.
