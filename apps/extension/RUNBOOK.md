# M2 verification runbook

The exact human-run steps that prove Milestone M2: the extension drives a real,
logged-in Chromium tab over the **real WebSocket wire** and every Event it emits
is schema-valid against `@understudy/protocol`.

The peer is a throwaway stub (`scripts/stub-server.mjs`, Node + `ws`) that runs
`safeParseEvent` on every inbound message and lets you drive protocol Commands
by typing JSON lines into its stdin. The real Hono backend is M3 — this stub is
what M3 replaces (and a reference for M3's `onMessage`).

## Baseline / environment

- Branch `master`, base commit `4a9a946` (`git rev-parse HEAD` to confirm).
- **Node ≥ 22, pnpm 11.5.2** (repo `packageManager`). This machine: Node 24, pnpm 11.5.2.
- **Real Chromium via `wxt build` + Load unpacked — NOT `wxt dev`.** `wxt dev`
  starts a throwaway profile with no logins, which defeats the whole point
  (puppeting a *logged-in* tab). Always load the built `.output/chrome-mv3/`.
- Chromium **≥ 116** (WS traffic resets the MV3 service-worker idle timer; the
  manifest declares `minimum_chrome_version: "116"`).
- Run every `pnpm` command from the repo root.

---

## 1. Build the protocol dist

The stub imports the **real** schemas from `@understudy/protocol`; that package's
`exports` map points at `dist/`, so it must be built first.

```bash
pnpm --filter @understudy/protocol build
```

Expect `packages/protocol/dist/index.js` + `index.d.ts` (exporting
`safeParseEvent` / `safeParseCommand` and the `tabs_result` validators).

## 2. Build the extension

```bash
pnpm --filter @understudy/extension build
```

Produces `apps/extension/.output/chrome-mv3/` with a `manifest.json` whose
`minimum_chrome_version` is `"116"`, whose `permissions` are
`debugger, tabs, activeTab, storage, alarms, sidePanel` (the 5 declared plus
`sidePanel`, which WXT auto-adds; `<all_urls>` is under `host_permissions`), and
which has both a `background` (service worker, `"type": "module"`) and a
`side_panel` entry.

## 3. Load unpacked in real Chromium

1. Open `chrome://extensions`.
2. Toggle **Developer mode** (top-right) on.
3. Click **Load unpacked** and select `apps/extension/.output/chrome-mv3/`.
4. The extension appears; note its service-worker link (used in step 8).

## 4. Start the stub WS server

From the repo root:

```bash
pnpm --filter @understudy/extension stub
```

It prints:

```
listening ws://localhost:8787
```

Leave this terminal focused — you will type command lines into it in step 6.

## 5. Open the side panel and attach

1. Click the extension's toolbar icon (or open the side panel for it) to open
   the panel.
2. Confirm the **wsUrl** field reads `ws://localhost:8787` (the default) and the
   status pill turns **open**. The stub terminal prints `* extension connected`
   and a `< hello …` line (browser, ext version, tab count).
3. In a normal tab, navigate to a **real, logged-in** site (something where being
   logged in is visible, e.g. an account/settings page).
4. In the panel, click **Attach** (targets the active tab). Chromium shows the
   yellow **"… is being debugged"** banner — **this is expected** (it is the
   `chrome.debugger` attach; do NOT click "Cancel", which detaches).

## 6. Drive commands (the core acceptance)

Type each JSON line below into the **stub terminal** (the one running step 4) and
press Enter. `commandId` is auto-filled — you do not type it. Blank lines and
lines starting with `#` are ignored. After each send the stub echoes `> sent …`
and then prints the extension's reply.

> Tip: replace `<ref>` with a real ref (e.g. `s1e7`) copied from the most recent
> `snapshot_result` output. Refs are generation-namespaced — a ref is only valid
> for the snapshot generation that produced it.

```jsonc
# read the page — prints a nested node tree; copy a textbox/searchbox/button ref
{"type":"snapshot","mode":"a11y"}

# type into a field you copied a ref for (submit:false = don't press Enter)
{"type":"type","ref":"<ref>","text":"hello","submit":false}

# click a button/link you copied a ref for
{"type":"click","ref":"<ref>"}

# navigate the tab (a page_event should also arrive)
{"type":"navigate","url":"https://example.com/"}

# reuse a ref copied BEFORE the navigate above — must be rejected as stale
{"type":"click","ref":"<pre-navigation-ref>"}

# list open tabs — copy a tabId for switch_tab
{"type":"get_tabs"}

# activate another tab by its tabId from get_tabs
{"type":"switch_tab","tabId":<n>}

# dom snapshot is intentionally unsupported in M2
{"type":"snapshot","mode":"dom"}

# fixed delay
{"type":"wait","for":"ms","value":500}
```

Expected replies (watch the stub terminal):

| Line | Expected stub output | Visible in Chromium |
|---|---|---|
| `snapshot` a11y | `snapshot_result` with a node count + the first ~15 `{ref role "name"}` indented | — |
| `type` | `action_result … ok=true` | the text appears in the field |
| `click` | `action_result … ok=true` | the element is clicked |
| `navigate` | `action_result … ok=true url=…` **and** a `page_event navigated …` | the tab navigates |
| stale `click` | `action_result … ok=false error=…` (generation mismatch — no input dispatched) | nothing happens |
| `get_tabs` | `tabs_result` listing the open tabs (tabId/title/url) | — |
| `switch_tab` | `action_result … ok=true` | the other tab becomes active |
| `snapshot` dom | `action_result … ok=false error="dom snapshot unsupported"` | — |
| `wait` ms | `action_result … ok=true` | — |

## 7. Idle-survival check

Stop typing and leave everything idle for **~30–40 s**. The stub terminal should
print a `< pong · HH:MM:SS` roughly every **20–25 s** (the SW self-heartbeat,
with a 30 s `chrome.alarms` backstop). Then send any command again, e.g.:

```jsonc
{"type":"snapshot","mode":"a11y"}
```

It must still succeed — proving the service worker stayed alive (or woke) and the
CDP attachment is intact.

## 8. Eviction / reconcile check (DL-007)

1. In `chrome://extensions`, force-stop the service worker: click the extension's
   **service worker** link to open its DevTools and **Stop** it (or toggle the
   extension off and on). This simulates MV3 eviction.
2. Send a command (or reopen the panel):

```jsonc
{"type":"get_tabs"}
```

Expected: the SW **wakes**, reconciles the existing attachment via
`chrome.debugger.getTargets()` (re-enables domains + bumps generation rather than
blindly re-attaching — so **no "Already attached" error**), emits a fresh
`< hello …`, the panel's status pill returns to **open** without a manual reload,
and the command returns its normal result.

---

## Pass signal (the M2 acceptance)

**Zero `EVENT SCHEMA VIOLATION` logs across the entire session.**

Every event the extension emitted — `hello`, `snapshot_result`, `action_result`,
`page_event`, `tabs_result`, `pong` — passed `safeParseEvent` against the real
protocol schemas on the real WS wire. Combined with the visible page effects in
step 6, the stale-ref rejection, `get_tabs`, idle survival (step 7), and
eviction reconcile (step 8), that is M2 proven end-to-end.

If a violation *does* print, it is loud and boxed and includes the raw event plus
`error.issues` — read the issues to see exactly which field of which event type
failed, and fix the emitting executor.
