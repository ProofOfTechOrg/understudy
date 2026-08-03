<!-- Content type: Reference -->

# Host Understudy sessions in Chrome

The Manifest V3 extension controls one attended user tab or at most two extension-owned unattended windows. It also owns the local encrypted payment-card vault. Unattended profiles are tenant-dedicated because sessions share cookies, browser storage, installed extensions, and the extension update authority.

## Runtime modules

| Module | Responsibility |
|---|---|
| `core/profile-client.ts` | Pairing credential, browser epoch, control tickets, policy acknowledgement, and reconciliation |
| `core/session-manager.ts` | Assignment maps, owned-window registry, closure outbox, and exact orphan cleanup |
| `core/session-runtime.ts` | One controlled tab, CDP session, command queue, journal, dialog outbox, and sensitive payment boundary |
| `payment/card-vault.ts` | AES-GCM envelope format and vault operations |
| `payment/indexeddb-card-store.ts` | Extension-origin IndexedDB records, key, schema, and local payment origins |
| `driver/cdp.ts` | CDP queue, deadlines, frame sessions, actions, ref validation, navigation containment, and atomic card-field insertion |
| `driver/semantic/` | Multi-frame hybrid capture, safe normalization, bounded immutable cache, projections, search, inspect, pagination, and deltas |
| `entrypoints/sidepanel/` | Pairing, hosting state, card enrollment, and local payment-origin editor |

Each unattended lease creates a new unfocused `about:blank` window. The extension never adopts an existing tab for unattended work.

## Semantic element boundary

The extension captures one DOM snapshot per distinct debugger session and one
AX tree per frame, then stitches same-process frames and OOPIFs in parent-first
order. DOM capture is used only for backend node identity, tag/type and safe
form hints, frame ownership, clickability, bounds, and scroll offsets. Raw
attributes and live input values are discarded during conversion and are
never cached, logged, persisted, or returned.

The normalized cache is memory-only and capped at 20,000 nodes and 8 MiB of
page-derived strings. Each result is capped at 200 descriptors and 32 KiB.
Capture traversals are iterative; an AX surface above the fixed 40,000-node
work ceiling fails with `page_too_large` before normalization. Nodes within
that ceiling all reach semantic priority selection, so a late focused or urgent
node is not discarded by an input-order prefix limit.
Structural noise and duplicate static text are pruned; editable values, HTML,
selectors, XPath, IDs, classes, test IDs, scripts, and arbitrary attributes are
excluded. A failed child-frame capture becomes a bounded partial-coverage
placeholder rather than disappearing.

Refs are generation-fenced records containing frame/session ownership, allowed
actions, and an action-specific semantic fingerprint. Before any ref action,
the extension re-reads one partial AX node and allowlisted DOM metadata. A
changed, hidden, disabled, readonly, detached, or wrong-frame target returns a
fixed failure. Generation and frame ownership are checked after live reads,
and focus/pointer preparation is revalidated before dispatch. The extension
never retargets or self-heals a failed write.

## Build and test

```bash
pnpm --filter @understudy/protocol build
pnpm --filter @understudy/extension typecheck
pnpm --filter @understudy/extension test
pnpm --filter @understudy/extension test:e2e
pnpm --filter @understudy/extension build:staging
pnpm --filter @understudy/extension verify:staging-build
pnpm --filter @understudy/extension build:store
pnpm --filter @understudy/extension zip:store
```

`test:e2e` launches local Chrome with the store build. It verifies bounded
semantic capture on a 10,000-element document, offscreen find, inspect,
pagination, same-process and OOPIF frames, shadow DOM, structured deltas, and
stale refs. It also enrolls and submits a synthetic card through semantic refs,
verifies a non-extractable persisted key and encrypted envelope, reloads the
extension, deletes the vault, and checks that the synthetic marker did not
appear in network, console, or exception events.

Load `.output/chrome-mv3/` for internal testing, `.output/chrome-mv3-staging/` for hosted staging, or `.output/chrome-mv3-store/` for store acceptance. The staging build has the stable extension ID `ebpcldlibljfjhcfknagjcdmhggeknfc` and connects only to `https://staging.understudy.proofof.tech`. The store build connects only to `https://understudy.proofof.tech` and has no pinned key.

`store-release.json` records the manually submitted or published Chrome Web Store artifact for ID `lbmbdjjaodgipnleaggclnobbijpadee`. Production deployment requires `status: "published"` and normalized build contents equal to that record. ZIP timestamps and compression do not affect this gate.

## Pair a browser

Sign in at `https://understudy.proofof.tech/dashboard` and select **Pair this browser**. The CSRF-protected POST mints an opaque single-use offer. The dashboard sends it directly to the installed extension with `chrome.runtime.sendMessage`; the offer never enters a URL, browser history, or referrer.

The extension accepts only the exact sender page `https://understudy.proofof.tech/dashboard/pair`, an exact two-field schema, and a 43-character base64url offer. Re-pairing a live installation rotates the existing device credential without releasing its assignments. A locally detected revocation omits its dead credential. If a browser was revoked while offline and still submits that credential, pairing returns a fresh device identity and the extension durably fences and discards stale local ownership before activating it, including across service-worker restarts. A different Chrome profile creates a separate browser.

An empty default origin policy is valid, but the device cannot accept a session until configured.

## General origin policy

The dashboard owns the authoritative per-device policy. Removed origins immediately fence affected leases. Added origins are unusable until the extension persists and acknowledges the new version. The extension rejects a provision frame with a mismatched version or origins wider than its current policy.

Origins match exactly. `https://example.com` does not include `https://www.example.com`.

## Owned windows and recovery

Immediately after `chrome.windows.create`, the extension persists the new window ID, tab ID, browser epoch, session ID, lease ID, and lease epoch before installing a runtime. It writes both a fast `storage.session` checkpoint and a content-free `storage.local` recovery mirror so ownership survives a full Chrome restart. On worker wake it reconciles:

- Stored owned windows
- Managed assignments
- The closure outbox
- Server assignment and orphan inventory

Only a registered exact orphan can be closed. Ordinary restored tabs are never inferred to be owned.

After a full Chrome restart, exact closure records from the old browser epoch are delivered and acknowledged before the new epoch sends `device_hello`. A transient Chrome close failure keeps the connection in cleanup-only mode until physical removal succeeds. Pending closure records also take priority over reconnect hello and heartbeat inventory, so the backend cannot recover or reprovision a window that the extension has already closed locally.

Same-epoch inventory can recover a suspended lease. A browser restart creates a new epoch; accepted adoption carries a bumped lease fence and always starts in a fresh blank window. Old URLs, refs, and tasks are not restored.

## Card vault

The vault uses extension-origin IndexedDB, one locally persisted non-extractable AES-256-GCM key, a fresh 96-bit IV per write, and AAD containing schema version, record UUID, and `payment-card`. It encrypts cardholder name, PAN, expiration, and CVV.

The vault has no sync, export, backup, recovery, backend copy, analytics copy, or content-script API. Removing the extension or selecting **Delete vault** destroys recovery. There is no unlock prompt because unattended operation requires the persisted key to remain usable after worker and browser restart.

Enrollment validates alias, Luhn checksum, PAN length, future expiration, and 3–4 digit CVV before encryption. Payment origins are exact HTTPS origins maintained only in the extension.

`browser_submit_card` validates distinct current refs and the intersection of the server session policy with the local payment policy. It then enters sensitive mode before decryption, stops ordinary command and page-event ingress, and obtains a local authorization revision for the selected card and payment origin. It rechecks that revision and card expiration immediately before the first byte is inserted. A card edit, deletion, vault deletion, or payment-origin edit during preparation therefore fails before insertion. The operation fills every mapped field, invokes submit, closes the tab, and returns only a fixed result. It never reads a receipt or infers payment success.

Alias, origin-policy, distinct-ref, and current-generation checks are a non-sensitive preflight. A rejected preflight returns a fixed `not_started` result without decrypting card data or tearing down the session. Once sensitive mode begins, every exit closes the controlled tab.

See [local card-vault requirements](../../docs/local-card-vault-security-requirements.md) for the trust and risk contract.

## Sensitive-mode containment

After sensitive mode begins, suppress snapshots, screenshots, URLs, titles, dialogs, tab metadata, page errors, console/network artifacts, ordinary commands, and arbitrary logs. On success, failure, timeout, worker interruption, tab closure, or extension update, close the controlled tab and clear its runtime.

Once insertion may have begun, every outcome is `outcome_unknown`; never retry automatically.

## Attended detach

Each attended attachment has a UUID incarnation. Deliberate or debugger-driven detach sends that UUID and tab ID. The backend ignores stale frames, clears browser-derived artifacts for the current attachment, and reports `idle`. Socket loss reports `detached`. Detaching never closes the user’s tab.

Follow [`RUNBOOK.md`](RUNBOOK.md) for real-Chrome release acceptance.
