# CLAUDE.md

## Overview

WXT + React MV3 extension driving protocol Commands into a real Chromium tab via `chrome.debugger` CDP.

## Index

| File | Contents (WHAT) | Read When (WHEN) |
| --- | --- | --- |
| `README.md` | Layer map, dev/build/test/stub scripts, manifest permissions | Onboarding to this package |
| `RUNBOOK.md` | Human-run M2 end-to-end verification steps | Verifying a real Chromium tab end-to-end |
| `package.json` | Scripts (`dev`/`build`/`typecheck`/`test`/`stub`), deps | Adding a dep, changing a script |
| `wxt.config.ts` | WXT config: `srcDir`, React module, `@understudy/protocol` source alias, manifest (`minimum_chrome_version`, permissions) | Changing manifest permissions, resolving protocol from source vs dist |
| `tsconfig.json` | TS project config (extends WXT-generated `.wxt/tsconfig.json`) | Adjusting compiler options |
| `scripts/stub-server.mjs` | Throwaway M2 WS peer: validates every Event with real protocol schemas, sends Commands from stdin | Driving/debugging the extension over the real WS wire |
| `src/events.ts` | `errorMessage`, `actionError` — shared error-to-`action_result` helpers | Adding an executor that can fail |
| `src/tabs.ts` | `queryTabInfos` — `chrome.tabs.query` to `TabInfo[]` | Changing tab metadata reported to the backend |
| `src/messaging.ts` | `PanelMsg`/`SwMsg` discriminated unions for the sidepanel↔service-worker `Port` | Changing panel/background message shapes |
| `src/driver/a11y.ts` | `buildA11ySnapshot` — pure AX-tree → pruned `A11yNode[]` + generation-namespaced ref map | Changing which roles are surfaced, ref format, or snapshot pruning |
| `src/driver/a11y.test.ts` | Unit tests for `buildA11ySnapshot` against a hand-authored AX fixture | Verifying a11y pruning/re-parenting behavior |
| `src/driver/keymap.ts` | `parseKeys` — key-spec string → CDP `Input.dispatchKeyEvent` fields | Adding a named key or modifier alias |
| `src/driver/keymap.test.ts` | Unit tests for `parseKeys` (modifiers, named keys, printable chars) | Verifying key-spec parsing |
| `src/driver/cdp-events.ts` | `classifyCdpEvent` — raw CDP event → effects decision (`CdpDecision`) | Handling a new CDP event type, changing navigation/dialog handling |
| `src/driver/cdp-events.test.ts` | Unit tests for `classifyCdpEvent` (main-frame filter, load URL, generation bumps, dialog dismiss) | Verifying CDP event classification |
| `src/driver/cdp.ts` | `CdpSession` — FIFO-queued `chrome.debugger` channel; executors for every protocol Command (`snapshotA11y`, `screenshot`, `click`, `type`, `key`, `scroll`, `wait`, `navigate`, `resolveRefCheck`) | Adding/changing a command executor, debugging a CDP call |
| `src/driver/cdp.test.ts` | Unit tests for `resolveRefCheck` — the dry-run probe's no-snapshot/no-generation-bump invariant | Changing resolveRefCheck or the ref/generation model |
| `src/core/ws-client.ts` | `ReconnectingWs` — WebSocket with backoff reconnect and self-driven pong heartbeat | Changing reconnect/backoff/heartbeat behavior |
| `src/core/router.ts` | `routeCommand` — dispatches a parsed `Command` to a `CdpSession` executor or tab handler | Adding a new protocol Command type |
| `src/core/router.test.ts` | Unit tests for `routeCommand` (one Event per Command, error paths) | Verifying command routing |
| `src/core/dedupe.ts` | `WriteDedupe` — `claim()` (execute / replay a completed write / drop an in-flight duplicate) + `remember`/`release`/`clear`; idempotent-retry contract, storage.session-mirrored, cap 100 | Changing write replay/dedupe/in-flight behavior |
| `src/core/dedupe.test.ts` | Unit tests for `WriteDedupe` (claim decisions, concurrent-claim atomicity, in-flight drop, cap, eviction survival, clear-on-session-change) | Verifying dedupe behavior |
| `src/entrypoints/background.ts` | MV3 service worker: WS lifecycle, CDP session ownership, write dedupe, wake-time reattachment, alarm/heartbeat keepalive, panel `Port` host | Debugging SW eviction/reconnect, attach/detach flow, keepalive |
| `src/entrypoints/sidepanel/index.html` | Sidepanel HTML entry | Changing the sidepanel document shell |
| `src/entrypoints/sidepanel/main.tsx` | React root mount for the sidepanel | Changing sidepanel bootstrap |
| `src/entrypoints/sidepanel/App.tsx` | Sidepanel UI: WS status, WS URL field, Attach/Detach, live log, `Port` reconnect on SW eviction | Changing sidepanel UI or panel↔SW messaging |
| `src/entrypoints/sidepanel/style.css` | Sidepanel styling | Changing sidepanel appearance |
