<!-- Content type: Reference -->

# Deferred work

Known defects and design gaps that are recorded rather than fixed, with enough
evidence that a fresh session can act on them without redoing the
investigation. Each entry states what is wrong, how it was observed, why it was
deferred, and what "done" looks like.

Line numbers are as-of the baseline commit named in each entry and must be
re-confirmed before editing.

---

## Attended session status cannot express "connected but not attached"

**Baseline:** branch `dev`, commit `d6fab0de4aea6be587e158b59faea21c6c4bed06`.
**Found:** 2026-07-29, during the Phase 3a attended-compatibility scenario.
**Severity:** consumers can be told a session is ready when it cannot execute
anything. No silent success, but a status that is affirmatively wrong.

### What was observed

With an attended session attached and working, the operator pressed **Detach
tab** in the side panel. The session then reported:

```json
{"mode":"attended","status":"connected","browser":{...},"tabs":[{"tabId":2134210639,...}]}
```

while every command answered:

```json
{"type":"action_result","ok":false,"error":"no active CDP session"}
```

So `status` said `connected`, `browser` was populated, and `tabs` still listed a
tab that was no longer under control.

### Why it happens — two independent causes

**1. The attended enum has no state for it.** `packages/protocol/src/index.ts:382`:

```ts
export const AttendedSessionStatusSchema = strictObject({
  mode: z.literal("attended").optional(),
  status: z.enum(["pending", "connected", "detached"]),
```

Three states, and the real machine has at least four: no socket; socket up with
no tab attached; socket up with a tab attached; socket gone. `connected`
currently covers the middle two, which are the two that differ in whether a
command can succeed.

The unattended lifecycle in the same file (`:367`) models its machine properly,
which is the contrast worth noting — the attended path was simply never given
the same treatment:

```ts
export const UnattendedSessionLifecycleSchema = z.enum([
  "allocating", "provisioning", "connected", "recovering",
  "closing", "closed", "expired", "lost",
]);
```

**2. The extension never tells the backend.** `apps/extension/src/entrypoints/background.ts:648`:

```ts
async function detach(): Promise<void> {
  const active = session;
  try {
    if (active !== null) await active.detach();
  } catch (cause) {
    log(`detach error (continuing): ${errorMessage(cause)}`, "warn");
  }
  await clearAttachment();
  log("detached");
  broadcastState();
}
```

`broadcastState()` updates the side panel only. No frame goes over the
WebSocket, so even with a richer enum the backend could not make the
transition. The same is true of the involuntary path,
`background.ts:595` — which matters more, because it is the one a user
triggers by accident:

```ts
async function onDetach(source: { tabId?: number }, reason: string): Promise<void> {
  await profileClient.sessions.onDebuggerDetach(source);
  const active = session;
  if (active === null || source.tabId !== active.tabId) return;
  await fenceStartedAttendedWrites();
  await clearAttachment();
  log(`debugger detached from tab ${active.tabId} (${reason})`);
  broadcastState();
}
```

`chrome.debugger.onDetach` fires when the controlled tab is closed, or when the
user clicks **Cancel** on Chrome's debugger banner. Both leave the session
reporting `connected`. This is the mechanical reason
`apps/extension/RUNBOOK.md` instructs operators not to touch that banner — the
instruction exists, but the reason is not written down anywhere.

For completeness, `detached` today is set only on socket-level events, in
`apps/backend/src/session.ts` at lines `529`, `1132`, `1164`, `1198` and `1231`:
connection close, session reconnect / browser-epoch change, device credential
revocation, and terminal close. Losing the debugger attachment is not among
them.

### Why it was deferred

It is not a correctness hole in execution. A consumer that sends a command gets
an explicit `ok: false` with a specific reason, not a false success, and
Metamind's connector surfaces that. The exposure is limited to a consumer that
gates on `status` alone and concludes the session is usable.

It also cannot be fixed in one repo. Adding a value to
`AttendedSessionStatusSchema` is a **breaking protocol change**: the schema is
exported from `@understudy/protocol` and consumers parse responses with it, so
`z.enum` rejects an unknown value. Shipping it needs a protocol major, a
connector release, and a consumer upgrade — coordination that did not belong in
the middle of a canary acceptance run.

### Proposed fix

Model the machine, then report the transition. Both halves are required; either
alone changes nothing.

1. **Protocol.** Add a state meaning "extension socket present, no tab
   attached". Recommended name `idle`, giving
   `pending | idle | connected | detached`, and keep `connected` meaning
   *ready to execute*. Preserving the existing meaning of `connected` is the
   point: consumers that already gate on `status === "connected"` keep working
   and simply stop treating a detached session as usable.

   *Rejected:* renaming the ready state to `attached` and repurposing
   `connected` to mean socket-up. Cleaner on paper, but it silently flips the
   meaning of a value existing consumers already branch on — the failure mode
   would be worse than the bug.

2. **Extension.** Send an explicit frame on both detach paths — the deliberate
   `detach()` and the involuntary `onDetach()` — so the backend can transition
   to `idle`. It must carry the tab identity so a late frame from a superseded
   attachment cannot clear a newer one; `sendIfPeerCurrent` in
   `apps/extension/src/core/peer-binding.ts` is the existing guard for exactly
   this class of post-await staleness and should be reused rather than
   reinvented.

3. **Backend.** Clear `tabs` and `browser` alongside the transition. Reporting a
   `tabId` that is no longer controlled is part of the same wrongness and should
   not survive the fix.

### Out of scope

- The unattended lifecycle. It already models its machine and must not be
  touched by this work.
- `SessionAgent`'s existing `detached` transitions. They are correct for what
  they describe — socket-level loss — and this adds a state beside them rather
  than redefining them.

### Verification

- A unit test asserting the full attended sequence: `pending` on create,
  `connected` after hello, `idle` after a detach frame, `detached` after the
  socket closes.
- A test that a detach frame naming a superseded tab does **not** move a live
  session out of `connected`.
- Manually, the scenario that found it: attach, confirm `connected`, press
  **Detach tab**, confirm `idle` and empty `tabs`; then repeat by closing the
  controlled tab instead of pressing the button, which must reach the same
  state.
- Quality gate: clean-code, architecture, and QA lanes, since this is a protocol
  change with cross-repo consumers.
