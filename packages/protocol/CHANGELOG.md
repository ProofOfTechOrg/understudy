# @understudy/protocol

## 0.9.0

### Minor Changes

- 72b482d: Release protocol 3, remove the cloud-secret command and credential connector,
  and add the `semantic-elements-v1` capability.

  Add bounded semantic capture, deterministic find, inspect, continuation,
  same-document deltas, fixed action failures, device-policy, physical-window
  inventory, suspended-session adoption, attended-idle, and extension-local
  payment-card command contracts. Card submission returns only fixed not-started
  or outcome-unknown results.

## 0.8.0

### Minor Changes

- b3212ed: Add strict device-control closure acknowledgements for durable, replayable session retirement.

## 0.7.0

### Minor Changes

- Add protocol 2 capabilities and bounded strict schemas for HTTP command requests, session frames, device-control frames, device status, unattended session status, durable command polling, and pending command responses.
- Add the prepare, ready, grant, result, and acknowledgement frames required for at-most-once write execution with explicit pending and unknown outcomes.
- Add `dialogId`, `occurredAt`, dialog acknowledgements, single-owned-tab limits, and bounded accessibility, URL, text, key, ref, identifier, browser, and payload fields.
- Export `WS_CLOSE_REPLACED` (`4001`) and `WS_CLOSE_SESSION_TERMINAL` (`4003`). Both codes stop reconnects before owner close callbacks. A terminal session close also stops command admission and browser control.

## 0.6.0

### Minor Changes

- ebfa8a6: Bind every snapshot and accessibility ref to the exact browser target that
  produced it.

  - `@understudy/protocol`: `snapshot_result` and `screenshot_result` now require
    the attached CDP `tabId` and main-frame `url`. Accessibility refs remain
    opaque, but are now namespaced to the extension session, CDP attachment, and
    snapshot generation so a ref cannot resolve against a replacement browser
    connection or tab.
  - `@understudy/connector`: snapshot reads expose `target: { tabId, url }`.
    Driver failures, including expected-tab mismatches and pages that change
    during capture, return structured `{ ok: false, error }` output with the
    original reason.

  This is a breaking wire change. Upgrade and deploy the protocol, service,
  extension, and connector together. Protocol 0.6 rejects snapshot events from
  older extensions because they lack the required target fields, and connector
  0.4 requires protocol 0.6.

## 0.5.0

### Minor Changes

- 432e2cc: Add JavaScript-dialog handling breadth.

  - **protocol**: new `dialog` Event (`{ type, tabId, dialogType: alert | confirm | prompt | beforeunload, message, url, defaultPrompt?, disposition: accept | dismiss }`) plus `DialogTypeSchema` / `DialogDispositionSchema` exports. Emitted unsolicited (like `page_event`) after the extension locally handles a page dialog, so a consumer learns what the page said and how it was answered.
  - **connector**: `browser.observe` gains a `get_dialogs` read returning the session's recent dialogs (`ObserveOutput.dialogs`), read from `GET /v1/sessions/:id`.

  The extension now applies a type-aware local disposition (alert/beforeunload accept, confirm/prompt dismiss) instead of blindly dismissing every dialog — a `beforeunload` dismiss previously cancelled navigations. Dispositions are decided synchronously extension-side because an open dialog blocks the single CDP channel; the consumer is notified, never in the response path.

## 0.4.0

### Minor Changes

- a29e4b8: Idempotent write retries and a single write-classification source of truth.

  - `@understudy/protocol` now exports `WRITE_COMMAND_TYPES` (and its
    `WriteCommandType` union) as the one classification downstream layers derive
    from, and reclassifies `scroll` / `switch_tab` as writes — so
    `isWriteCommand` returns `true` for them. They are user-visible side effects:
    a `dryRun` must simulate (not perform) them and an idempotent retry must
    replay (not repeat) them, so a relative-`dy` `scroll` never double-scrolls.
    No schema change.
  - `@understudy/connector`'s `act` / `fillCredential` derive the wire
    `commandId` from the breakwater idempotency key (`ik_<key>`) instead of a
    random UUID, so a retry after a lost or unparseable response replays the
    service's recorded write Event instead of executing the write twice.
    Dry-runs keep random ids. The `act` union is now pinned at compile time to
    the protocol's write class minus `fill_secret` (no divergence to reconcile,
    now that `scroll`/`switch_tab` are protocol writes).
