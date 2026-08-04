# CLAUDE.md

## Overview

WXT + React MV3 extension driving protocol-3 commands into attended tabs and
extension-owned unattended windows through `chrome.debugger` CDP. The same
extension owns the local encrypted payment-card vault.

## Index

| File | Contents (WHAT) | Read When (WHEN) |
| --- | --- | --- |
| `README.md` | Layer map, dev/build/test/stub scripts, manifest permissions | Onboarding to this package |
| `RUNBOOK.md` | Human-run M2 end-to-end verification steps | Verifying a real Chromium tab end-to-end |
| `package.json` | Scripts (`dev`, build/store packaging, typecheck, unit/E2E tests, stub), deps | Adding a dep, changing a script |
| `wxt.config.ts` | WXT config: `srcDir`, React module, `@understudy/protocol` source alias, manifest (`minimum_chrome_version`, permissions) | Changing manifest permissions, resolving protocol from source vs dist |
| `tsconfig.json` | TS project config (extends WXT-generated `.wxt/tsconfig.json`) | Adjusting compiler options |
| `scripts/stub-server.mjs` | Throwaway M2 WS peer: validates every Event with real protocol schemas, sends Commands from stdin | Driving/debugging the extension over the real WS wire |
| `scripts/e2e.mjs` | Local-Chrome store-build test for semantic capture, frame/shadow traversal, ref fencing, local-vault persistence, and marker non-egress | Changing semantic discovery, the vault boundary, service-worker restart behavior, or the store manifest |
| `scripts/store-release.mjs` | Published store-artifact recorder and normalized-content deployment gate | Building, submitting, recording, or promoting a store release |
| `scripts/verify-build-target.mjs` | Staging manifest authority and pinned-ID verifier | Changing staging mode, origin, permissions, or key |
| `src/events.ts` | `errorMessage`, `actionError`: shared error-to-`action_result` helpers | Adding an executor that can fail |
| `src/tabs.ts` | `controlledTabInfo`: scoped CDP URL/title plus non-sensitive tab state for one controlled tab | Changing tab metadata reported to the backend |
| `src/messaging.ts` | `PanelMsg`/`SwMsg` discriminated unions for the sidepanel↔service-worker `Port` | Changing panel/background message shapes |
| `src/driver/a11y.ts` | `buildA11ySnapshot`: pure AX-tree → pruned `A11yNode[]` + opaque session/attachment/generation-bound ref map | Changing which roles are surfaced, ref format, or snapshot pruning |
| `src/driver/a11y.test.ts` | Unit tests for `buildA11ySnapshot` against a hand-authored AX fixture, including scope isolation | Verifying a11y pruning/re-parenting or ref-binding behavior |
| `src/driver/keymap.ts` | `parseKeys`: key-spec string → CDP `Input.dispatchKeyEvent` fields | Adding a named key or modifier alias |
| `src/driver/keymap.test.ts` | Unit tests for `parseKeys` (modifiers, named keys, printable chars) | Verifying key-spec parsing |
| `src/driver/cdp-events.ts` | `classifyCdpEvent`: raw CDP event → effects decision (`CdpDecision`) | Handling a new CDP event type, changing navigation/dialog handling |
| `src/driver/cdp-events.test.ts` | Unit tests for `classifyCdpEvent` + `dialogDisposition` (main-frame filter, load URL, generation bumps, per-type dialog disposition) | Verifying CDP event classification |
| `src/driver/cdp.ts` | `CdpSession`: serialized `chrome.debugger` channel, semantic cache/cursors, live ref validation, legacy snapshots, and every protocol command executor | Adding or changing a command executor, semantic generation behavior, or a CDP call |
| `src/driver/cdp.test.ts` | Unit tests for ref probes/binding, action fingerprints, exact snapshot target brackets, failure invalidation, and aggregate deadlines | Changing action validation, snapshot identity/deadlines, or the ref/generation model |
| `src/driver/semantic/types.ts` | Internal hybrid-capture, normalized-node, fingerprint, cache, and projection types | Changing the semantic data boundary or cache model |
| `src/driver/semantic/capture.ts` | Parent-first frame topology plus DOMSnapshot, per-frame AX, DOM fallback, and partial-capture orchestration | Changing multi-frame capture, fallback behavior, or capture limits |
| `src/driver/semantic/capture.test.ts` | Capture tests for multi-session frames, failure degradation, and AX work limits | Verifying semantic capture orchestration and partial coverage |
| `src/driver/semantic/dom.ts` | DOMSnapshot conversion and iterative `DOM.getDocument` fallback using allowlisted metadata | Changing DOM capture fields, bounds, or deep-tree fallback |
| `src/driver/semantic/dom.test.ts` | DOM conversion and adversarial deep-tree fallback tests | Verifying DOM metadata filtering or traversal bounds |
| `src/driver/semantic/normalize.ts` | Iterative AX normalization, semantic classification, Unicode bounds, editable-value omission, and fingerprints | Changing descriptor semantics, text normalization, or action identity |
| `src/driver/semantic/normalize.test.ts` | Normalization tests for Unicode, roles, values, deep/wide trees, and action fingerprints | Verifying semantic normalization and data omission |
| `src/driver/semantic/cache.ts` | Immutable bounded cache, projections, deterministic search, inspect, and identity-aware deltas | Changing cache selection, cursors, search ranking, inspect, or deltas |
| `src/driver/semantic/cache.test.ts` | Cache tests for truncation priority, projections, search, inspect, and deltas | Verifying cache bounds and semantic query behavior |
| `src/driver/semantic/cdp-semantic.test.ts` | `CdpSession` tests for capture/delta generations, cursor expiry/eviction, and worker-eviction fences | Verifying semantic state-machine integration |
| `src/core/external-pairing.ts` | Strict sender-URL and message-schema validation for dashboard-to-extension pairing offers | Changing `externally_connectable` pairing ingress |
| `src/core/external-pairing.test.ts` | Wrong-origin, extra-field, and malformed-offer rejection tests | Verifying external-message trust boundaries |
| `src/core/pairing-client.ts` | `createPairingClaimId`/`redeemPairingOffer`/`PairingError`: replay-safe offer redemption at `/v1/pairing/claim` and existing-installation credential rotation | Changing pairing claim contracts or error copy |
| `src/core/pairing-client.test.ts` | Offer validation, retry identity, credential rotation, and per-status error tests | Verifying pairing redemption |
| `src/core/ws-client.ts` | `ReconnectingWs`: WebSocket with backoff reconnect and self-driven pong heartbeat | Changing reconnect/backoff/heartbeat behavior |
| `src/core/ws-client.test.ts` | Unit tests for ordinary reconnect and terminal backend replacement close code 4001 | Changing reconnect termination behavior |
| `src/core/command-ingress.ts` | `CommandIngress`: serial command-admission queue plus drain barrier for WebSocket session changes | Changing wire-order or session-switch command draining |
| `src/core/command-ingress.test.ts` | Unit tests for dedupe-hydration order, drain ordering, and captured-peer responses | Verifying command ingress/session-switch concurrency |
| `src/core/attended-switch.ts` | `resolveAttendedTransition`: derives replay isolation and peer ownership from serialized committed state | Changing attended endpoint switching |
| `src/core/attended-switch.test.ts` | Unit tests for queued endpoint retries after isolation failures | Verifying attended switch failure recovery |
| `src/core/peer-binding.ts` | `sendIfPeerCurrent`: drops delayed hello/page/dialog sends after peer authority changes | Changing post-await WebSocket event routing |
| `src/core/peer-binding.test.ts` | Unit tests for current-peer send/drop behavior | Verifying cross-session event isolation |
| `src/core/startup-gate.ts` | `RetryableStartupGate`: coalesces store cleanup, caches success, and permits retry after failure | Changing hosted-build startup ordering |
| `src/core/startup-gate.test.ts` | Unit tests for startup coalescing, downstream blocking, and retry | Verifying store startup gating |
| `src/core/router.ts` | `routeCommand`: dispatches a parsed `Command` to a `CdpSession` executor or tab handler | Adding a new protocol Command type |
| `src/core/router.test.ts` | Unit tests for `routeCommand` (one Event per Command, error paths) | Verifying command routing |
| `src/core/session-manager.ts` | Unattended assignment lifecycle, owned-window registry, cleanup outboxes, policy reconciliation, and payment sensitive-mode teardown | Changing physical-window ownership or unattended convergence |
| `src/core/session-runtime.ts` | Per-lease protocol-3 runtime, ref fencing, card-list/submit handlers, and fixed-result sensitive execution | Changing unattended commands or payment submission |
| `src/core/profile-client.ts` | Device-control connection, durable alarm reconnect, full inventory reconciliation, policy ack, and session adoption | Changing hosted-profile control-plane behavior |
| `src/core/write-journal.ts` | Durable write handshake state containing only scrubbed action results or fixed payment result enums | Changing crash/retry semantics for writes |
| `src/core/dedupe.ts` | `WriteDedupe`: `claim()` (execute / replay a completed write / drop an in-flight duplicate) + `remember`/`release`/`clear`; idempotent-retry contract, storage.session-mirrored, cap 100 | Changing write replay/dedupe/in-flight behavior |
| `src/core/dedupe.test.ts` | Unit tests for `WriteDedupe` (claim decisions, concurrent-claim atomicity, in-flight drop, cap, eviction survival, clear-on-session-change) | Verifying dedupe behavior |
| `src/payment/card-validation.ts` | Alias, PAN/Luhn, future-expiration, CVV, and exact payment-origin validation | Changing card enrollment rules |
| `src/payment/indexeddb-card-store.ts` | Extension-origin IndexedDB stores for the non-extractable AES key, encrypted records, and payment origins | Changing local persistence or migrations |
| `src/payment/card-vault.ts` | Serialized AES-256-GCM card operations with unique IVs and record-bound AAD | Changing encryption, corruption, or key-loss behavior |
| `src/service-origin.ts` | Build-target-specific service origin validation shared by background and pairing flows | Changing local, staging, or production service authority |
| `src/entrypoints/background.ts` | MV3 service worker: attended and hosted WS lifecycle, external pairing, CDP ownership, write journal, wake reconciliation, alarm keepalive, and panel host | Debugging eviction/reconnect, attach/detach, pairing, or panel messaging |
| `src/entrypoints/sidepanel/index.html` | Sidepanel HTML entry | Changing the sidepanel document shell |
| `src/entrypoints/sidepanel/main.tsx` | React root mount for the sidepanel | Changing sidepanel bootstrap |
| `src/entrypoints/sidepanel/App.tsx` | Pairing/hosting status, local-card enrollment/deletion, payment-origin editor, internal attended controls, and `Port` reconnect | Changing sidepanel UI or panel↔SW messaging |
| `src/entrypoints/sidepanel/card-save.ts` | Correlated card-save requests, acknowledgements, disconnect rejection, and post-commit form reset | Changing card enrollment acknowledgement or form-clearing behavior |
| `src/entrypoints/sidepanel/card-save.test.ts` | Card-save acknowledgement, failure, disconnect, and form-preservation tests | Verifying card enrollment UI commit behavior |
| `src/entrypoints/sidepanel/style.css` | Sidepanel styling | Changing sidepanel appearance |
