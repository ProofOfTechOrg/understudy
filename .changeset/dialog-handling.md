---
"@understudy/protocol": minor
"@understudy/connector": minor
---

Add JavaScript-dialog handling breadth.

- **protocol**: new `dialog` Event (`{ type, tabId, dialogType: alert | confirm | prompt | beforeunload, message, url, defaultPrompt?, disposition: accept | dismiss }`) plus `DialogTypeSchema` / `DialogDispositionSchema` exports. Emitted unsolicited (like `page_event`) after the extension locally handles a page dialog, so a consumer learns what the page said and how it was answered.
- **connector**: `browser.observe` gains a `get_dialogs` read returning the session's recent dialogs (`ObserveOutput.dialogs`), read from `GET /v1/sessions/:id`.

The extension now applies a type-aware local disposition (alert/beforeunload accept, confirm/prompt dismiss) instead of blindly dismissing every dialog — a `beforeunload` dismiss previously cancelled navigations. Dispositions are decided synchronously extension-side because an open dialog blocks the single CDP channel; the consumer is notified, never in the response path.
