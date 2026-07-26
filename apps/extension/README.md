<!-- Content type: Reference -->

# Host Understudy sessions in Chromium

The Manifest V3 extension supports attended control of one selected tab and unattended control of at most two extension-owned tabs. Unattended hosting requires a tenant-dedicated Chrome profile because tabs share profile cookies and browser storage.

## Understand the runtime

The background service worker separates profile and session responsibilities:

| Module | Responsibility |
|---|---|
| `core/profile-client.ts` | Enrollment, browser epoch, device ticket, and control socket |
| `core/session-manager.ts` | Runtime maps by session, lease, and tab |
| `core/session-runtime.ts` | One tab, CDP session, command queue, session socket, journal, and dialog outbox |
| `core/write-journal.ts` | Awaited `prepared`, `started`, `completed_unacked`, and `unknown` states |
| `core/dialog-outbox.ts` | Browser-epoch-scoped dialog acknowledgement and replay |
| `driver/cdp.ts` | CDP execution, aggregate deadlines, top-level origin interception, and popup containment |
| `entrypoints/background.ts` | Profile host plus compatible attended session |
| `entrypoints/sidepanel/` | Enrollment, capacity, emergency stop, and attended controls |

Each unattended lease creates a new `about:blank` tab in an unfocused automation window. The extension never adopts an existing tab for unattended work.

## Build the production extension

Run:

```bash
pnpm --filter @understudy/protocol build
pnpm --filter @understudy/extension typecheck
pnpm --filter @understudy/extension test
pnpm --filter @understudy/extension build
```

Load `apps/extension/.output/chrome-mv3/` through `chrome://extensions`. Use the production build for real-browser tests. WXT development mode creates a disposable profile and does not prove behavior against the operator’s login state.

The manifest requires Chrome 125 or newer and requests debugger, tabs, active tab, storage, alarms, side panel, and host permissions.

## Enroll a dedicated profile

Open the side panel and enter:

- HTTPS service origin
- Device UUID
- Raw device credential
- One exact allowed origin per line
- **Enable unattended hosting**

The credential field is write-only and must be supplied on every save. Panel state and logs never read it back.

The local origin policy is the maximum this profile will host. Each session request must be a subset.

## Understand storage

`chrome.storage.local` contains only:

- Service origin
- Enabled state
- Device ID
- Raw device credential
- Local origin policy

The extension restricts local-storage access to trusted extension contexts.

`chrome.storage.session` contains browser epoch, lease assignments, tab IDs, ref generations, write journal entries, and dialog outbox records. It never contains command bodies, typed text, secret plaintext, secret references, screenshots, accessibility trees, prior URLs, or restoration tasks.

Browser restart clears execution authority. The extension creates fresh blank tabs for live recovering leases and never restores old URLs.

## Control tabs safely

One runtime can see only its own tab. `hello`, `get_tabs`, and `switch_tab` never report or activate another profile tab.

Top-level navigations must remain within `allowedOrigins`. Explicit navigate commands are checked before dispatch. CDP Fetch interception also blocks redirects and JavaScript navigation. Cross-origin subresources and iframes remain allowed; the origin policy is not an egress firewall.

Popup targets related to a controlled tab are paused and closed before execution. `tabs.onCreated` adds a second ownership check.

## Recover command state

Writes use protocol 2:

```text
persist prepared
  -> write_ready
  -> persist started
  -> execute once
  -> persist completed_unacked
  -> replay until result_ack
```

A storage failure before `started` prevents the browser action. A same-epoch service-worker restart:

- Cancels an ungranted preparation unless the backend still recognizes it
- Marks a started write without a durable result unknown
- Replays a completed unacknowledged result

A browser epoch change blocks writes for recovering sessions. Delete the old session and create a new session to resume writes.

## Deliver dialogs

The extension persists each dialog before answering it. It accepts alerts and before-unload dialogs, dismisses confirms and prompts, then replays the record until `dialog_ack`.

The outbox holds at most 256 records and 256 KiB. Overflow still answers the browser dialog and reports content-free health.

## Stop automation

**Stop all** closes only tabs proven to belong to current leases and disables unattended hosting. It does not close unrelated or restored tabs.

Attended **Detach tab** detaches CDP but never closes the selected user tab.

Follow [`RUNBOOK.md`](RUNBOOK.md) for the real-Chromium acceptance and recovery procedure.
