<!-- Content type: Reference -->

# Meet the extension-local payment-card vault requirements

## Decision

Understudy uses a user-autonomy contract: a user may persist a payment card,
including CVV, in the installed extension and authorize an agent to select form
fields on exact locally approved origins. The backend never stores, decrypts,
backs up, recovers, exports, or receives card data.

This is a security boundary, not a claim that the card is safe from every actor.
The design does not protect card data from the controlling agent's field
selection, an approved payment origin after insertion, the installed extension
or its update authority, the browser/operating system, or a compromised user
machine.

## Product-risk record

CVV is sensitive authentication data. [PCI SSC FAQ 1574](https://www.pcisecuritystandards.org/faqs/1574/)
states that organizations providing consumer-device software or password-vault
functionality may not store card verification codes on a consumer's behalf,
even when encrypted or approved by the customer. The FAQ distinguishes a
consumer entering their own data into their own device, but determining which
scenario applies is external to this implementation.

Persisting CVV is an intentional maintainer product-risk decision. This file
does not determine PCI DSS scope or compliance and does not claim that local
storage or encryption creates an exemption. Rollout does not add a QSA or legal
counsel approval gate; maintainers own the decision and may remove persisted CVV
without changing the rest of the vault boundary.

## Stored data and cryptography

The extension-origin IndexedDB database contains:

- one persisted, non-extractable AES-256-GCM `CryptoKey`;
- card records with an opaque UUID, non-sensitive alias, schema version,
  purpose, random IV, and ciphertext;
- a local list of exact approved payment origins.

Each write uses a fresh random 96-bit IV. Additional authenticated data is the
canonical encoding of the schema version, record UUID, and purpose
`payment-card`. The encrypted plaintext contains cardholder name, PAN,
expiration month/year, and CVV. No masked PAN or last-four value is stored or
returned separately.

The key is generated locally, is non-extractable, and remains usable after
browser and service-worker restart. There is no unlock prompt because
always-unattended use is a product requirement. The vault is never copied to
sync storage, the backend, analytics, logs, export, recovery, or backup.

Extension removal or explicit full deletion removes records and key. Recovery
is intentionally impossible. If records exist but the key is missing, the vault
fails closed and requires explicit deletion; it must not generate a replacement
key. Envelope or authentication failure is reported as local corruption without
returning record-derived text. Repeated deletion is harmless.

## Enrollment

Enrollment, edit, origin policy, and deletion exist only in the extension side
panel. Content scripts and externally connectable pages cannot access them.

Before encryption:

- alias matches `[A-Za-z0-9._-]`, is 1–64 characters, and contains no card
  digits;
- PAN contains 12–19 digits and passes Luhn;
- expiration month is valid and the card has not expired;
- expiration year is four digits;
- CVV is exactly three or four digits;
- cardholder name is bounded.

Expiration is checked again after local decryption and immediately before field
insertion. A card that expired after enrollment fails as `not_started` without
placing any card bytes in the page.

After a successful commit, the UI clears form state. Temporary byte buffers used
for encryption or decryption are overwritten when practical in JavaScript.

## Model-facing contract

Protocol 3 exposes only:

```ts
browser_list_cards(): {
  aliases: string[];
  approvedOrigins: string[];
}
```

and:

```ts
browser_submit_card({
  cardAlias,
  numberRef,
  expiry,
  cvvRef,
  cardholderNameRef?,
  submitRef,
}): {
  status: "not_started" | "outcome_unknown";
  reason:
    | "card_not_found"
    | "origin_not_approved"
    | "stale_ref"
    | "invalid_mapping"
    | "input_failed"
    | "submission_attempted";
}
```

Aliases and fixed enums are the only card-related values allowed past the
extension. The server has no card storage or resolution path. The retired
`fill_secret`, `browser_fill_secret`, and `browser_list_secrets` interfaces are
not compatible fallbacks.

## Authorization and field mapping

The model owns semantic field selection. Local code checks only:

- current attachment and latest snapshot generation;
- all supplied refs are distinct;
- refs belong to the current owned tab;
- the current top-level origin is permitted by the backend session policy;
- the same exact origin is permitted by the extension-local payment policy;
- the selected alias exists.

Vault mutations advance a local authorization revision. Sensitive execution
captures that revision only after ingress is stopped and revalidates it, card
existence, origin approval, and expiration at the exact boundary before the
first card byte is inserted. Editing or deleting the card, deleting the vault,
or changing payment origins during preparation therefore fails as
`not_started`.

Origins are exact scheme/host/port origins. Subdomains are independent. The
local payment policy never syncs to the backend and cannot widen the general
policy.

## Sensitive execution boundary

Card handlers are outside the generic command router. Before decrypting a card,
the extension enters sensitive mode, stops page observation, and refuses
ordinary command ingress.

Before that boundary, a non-sensitive preflight verifies distinct refs, the
current snapshot generation, alias presence, and the general/local exact-origin
intersection. A rejected preflight returns a fixed `not_started` result without
decrypting the card or tearing down the session. The caller must obtain a new
snapshot before retrying stale or corrected mappings.

The operation fills every supplied field and invokes `submitRef` as one atomic
sensitive attempt. From sensitive-mode entry onward, it destroys the controlled
tab and clears refs/runtime on success, authorization revalidation failure,
input failure, timeout, worker interruption, tab closure, or extension update.

Sensitive mode pins the approved top-level origin before decryption, stops any
already-continued navigation, and blocks all new top-level navigation until
submission begins. The executor re-reads the live main-frame origin before
inserting any value, keeps navigation-driven ref invalidation active, and then
permits only the pinned origin, even when another origin is allowed for ordinary
browser work.

From sensitive-mode entry onward, suppress:

- accessibility and DOM snapshots;
- screenshots and captions;
- URLs, titles, dialogs, and tab/window metadata;
- page-derived errors and exception strings;
- console and network artifacts;
- generic commands and runtime evaluation;
- clipboard and download helpers;
- analytics, arbitrary logs, crash details, and command-journal payloads.

The device-control socket sends no hello or heartbeat inventory while any local
assignment is sensitive. This withholds all tab/window metadata without making
the backend interpret a redacted inventory as physical divergence. If the
control socket reconnects during the operation, it retries without sending a
hello until sensitive teardown has completed. A failed durable sensitive-state
write aborts before decryption and keeps the in-memory suppression latch set
until the tab is confirmed closed.

Local code does not inspect the page after insertion and does not infer payment
approval. If failure occurs before the first card byte is inserted, the result
is `not_started` and a human may choose to retry after a fresh snapshot. Once
any byte is inserted, every exit is `outcome_unknown`; no automatic retry is
permitted. A later, fresh session may inspect a receipt or status page.

## Required verification

Automated and real-Chrome tests cover:

- unique IVs, non-extractable key, restart persistence, AAD mismatch, corrupted
  ciphertext, key loss, migration, deletion, and idempotent deletion;
- no sync/backend traffic and no marker in logs or telemetry;
- alias and card validation;
- exact-origin policy intersection;
- stale refs, duplicate refs, combined and split expiry;
- sensitive mode entered before decryption;
- failure before insertion versus unknown outcome after insertion;
- closure and cleanup on every exit path;
- attempted exfiltration through accessibility, screenshot, dialog, URL/title,
  tab metadata, console, exception, network, DOM/runtime evaluation, clipboard,
  download, crash report, WSS frame, journal, analytics, and logs.

A synthetic marker may appear only inside the local executor and the approved
page during the attempt. Any other occurrence fails release acceptance.

## Explicit exclusions

The vault does not provide card export, backup, recovery, cloud migration,
merchant adapters, amount verification, amount limits, issuer integration, or
payment-status inference. API credentials require the separate future design in
`DEFERRED.md`. One signed extension package with dedicated vault/payment modules
is deliberate logical separation; it is not a separate code-signing principal.
