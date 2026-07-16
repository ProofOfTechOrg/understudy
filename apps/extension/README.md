# Extension (M2)

WXT + React MV3 extension that puppets a user's already-logged-in Chromium tab
over a WebSocket. It holds the WS connection, runs a CDP session against a
single designated tab via `chrome.debugger`, and executes protocol Commands
(`snapshot`, `click`, `type`, `navigate`, `key`, `scroll`, `wait`, `resolve_ref`,
`get_tabs`, `switch_tab`) as schema-valid `@understudy/protocol` Events. The peer in M2 is
a throwaway stub server (`scripts/stub-server.mjs`); the real Hono backend is
M3.

## Layout

| Path | What |
| --- | --- |
| `src/driver/a11y.ts` | `buildA11ySnapshot` — pure AX-tree → pruned, generation-namespaced `A11yNode[]` + ref map. No `chrome.*`. |
| `src/driver/keymap.ts` | `parseKeys` — pure key-spec parser (`"Ctrl+Enter"` etc.) → CDP `Input.dispatchKeyEvent` fields. No `chrome.*`. |
| `src/driver/cdp-events.ts` | `classifyCdpEvent` — pure classifier turning a raw CDP event into the effects the background worker should apply. No `chrome.*`. |
| `src/driver/cdp.ts` | `CdpSession` — the one `chrome.debugger` channel per attached tab: FIFO command queue, per-command timeouts, and the executors backing every protocol Command. |
| `src/core/ws-client.ts` | `ReconnectingWs` — WebSocket with backoff reconnect and a self-driven pong heartbeat. |
| `src/core/router.ts` | `routeCommand` — dispatches a parsed `Command` to a `CdpSession` executor or a tab-management handler, always returning exactly one `Event`. |
| `src/events.ts`, `src/tabs.ts`, `src/messaging.ts` | Shared leaf helpers (`action_result` builder, tab-info query) and the sidepanel↔service-worker `Port` message types. |
| `src/entrypoints/background.ts` | The MV3 service worker: owns the WS connection, the CDP session, wake-time reattachment, and the alarm/heartbeat keepalive. |
| `src/entrypoints/sidepanel/` | React panel (WS status, WS URL field, Attach/Detach, live log) talking to the background worker over a `chrome.runtime.Port`. |
| `scripts/stub-server.mjs` | Throwaway M2 verification peer — validates every extension-emitted Event against the real protocol schemas. |

## Develop

Run from the repo root (`pnpm-workspace.yaml` scopes `@understudy/extension`):

```bash
pnpm --filter @understudy/extension dev         # wxt dev server (throwaway profile — no logins)
pnpm --filter @understudy/extension build       # wxt build -> .output/chrome-mv3/
pnpm --filter @understudy/extension typecheck   # wxt prepare && tsc --noEmit
pnpm --filter @understudy/extension test        # vitest run
pnpm --filter @understudy/extension stub        # node scripts/stub-server.mjs
```

`@understudy/protocol` resolves from source via a WXT `alias` in
`wxt.config.ts` (not `exports`/`dist`), so typecheck and dev don't depend on
the protocol package being built first. The stub server is the exception — it
imports the built `dist/`, so run `pnpm --filter @understudy/protocol build`
before `pnpm --filter @understudy/extension stub`.

## Manifest

`wxt.config.ts` declares:

- `minimum_chrome_version: "116"` — the version whose MV3 service-worker idle
  timer is reset by WebSocket traffic, which the heartbeat in
  `src/core/ws-client.ts` relies on.
- `permissions: ["debugger", "tabs", "activeTab", "storage", "alarms"]` (WXT
  auto-adds `sidePanel`) and `host_permissions: ["<all_urls>"]`. No
  `offscreen` permission and no content script — deliberately deferred until a
  real agent loop shows eviction pain (see the repo-root `docs/technical-plan.md`).

## Verifying end-to-end

Unit tests (`pnpm --filter @understudy/extension test`) cover the pure driver
logic and the router. They do not prove the extension against a real,
logged-in Chromium tab over the real WebSocket wire — for that, follow
[`RUNBOOK.md`](RUNBOOK.md): build the protocol dist, build the extension, load
it unpacked, start the stub server, and drive it with real commands while
watching for `EVENT SCHEMA VIOLATION` logs.
