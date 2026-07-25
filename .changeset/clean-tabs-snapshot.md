---
"@understudy/protocol": minor
"@understudy/connector": minor
---

Bind every snapshot and accessibility ref to the exact browser target that
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
