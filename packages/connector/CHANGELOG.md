# @understudy/connector

## 0.2.0

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

### Patch Changes

- Updated dependencies [a29e4b8]
  - @understudy/protocol@0.4.0
