# @understudy/protocol

The command protocol for [understudy](https://github.com/ProofOfTechOrg/understudy),
a governed browser-execution service that puppets a user's *already-logged-in*
Chromium browser. This package is the shared contract between the three parties
that speak it:

- the **understudy service** (Cloudflare Worker + per-session Durable Object),
- the **extension driver** (MV3, `chrome.debugger`/CDP), and
- **consumer connectors** (e.g. [`@understudy/connector`](https://github.com/ProofOfTechOrg/understudy/tree/master/packages/connector))
  that drive the service over `POST /v1/sessions/:sessionId/commands`.

Every message is a zod-4 discriminated union tagged by `type`, carries a
`commandId` for request/response correlation, and is validated at every
boundary. Consumers nest these schemas inside their own zod-4 objects, so the
package requires zod 4.

## Install

```sh
pnpm add @understudy/protocol zod
```

## Exports

```ts
import {
  // schemas
  CommandSchema, EventSchema, A11yNodeSchema, TabInfoSchema, SnapshotModeSchema,
  // parsers
  parseCommand, parseEvent, safeParseCommand, safeParseEvent,
  // classification
  isWriteCommand, WRITE_COMMAND_TYPES,
  // types
  type Command, type CommandType, type Event, type WriteCommandType,
  type A11yNode, type TabInfo, type SnapshotMode,
} from "@understudy/protocol";
```

### Runtime support

Pure zod-4 schemas — no platform APIs. Runs anywhere zod does: Workers,
browsers (the extension bundles it), and Node. Deliberately no `engines`
field: constraining Node would only misstate that portability
([`@understudy/connector`](https://github.com/ProofOfTechOrg/understudy/tree/master/packages/connector)
declares `node >= 22`, mirroring its breakwater peer — that constraint lives
there, where it is real).

## Commands (consumer/service → extension)

| type | fields | class |
|---|---|---|
| `snapshot` | `mode: "a11y" \| "dom" \| "screenshot"`, `tabId?` | read |
| `get_tabs` | — | read |
| `wait` | `for: "load" \| "idle" \| "ms"`, `value?` | read |
| `resolve_ref` | `ref` | read (internal — see below) |
| `click` | `ref` | **write** |
| `type` | `ref`, `text`, `submit?` | **write** |
| `key` | `keys`, `ref?` | **write** |
| `navigate` | `url`, `tabId?` | **write** |
| `scroll` | `ref?`, `dy` | **write** |
| `switch_tab` | `tabId` | **write** |
| `fill_secret` | `ref`, `secretRef`, `submit?` | **write** (vaulted) |

`isWriteCommand` / `WRITE_COMMAND_TYPES` classify the write class in the
**operational** sense this system enforces: a command with a user-visible side
effect, which must be gated on approval (D8), simulated (never performed) on a
`dryRun`, and replayed (never repeated) on an idempotent retry. `scroll` and
`switch_tab` are writes here even though they don't mutate the DOM — both change
what the user's browser shows, so a dry-run must not perform them and a
lost-response retry of `scroll` (a *relative* `dy`) must not double-scroll. Two
commands deserve a warning:

- **`fill_secret`** carries an opaque `secretRef` (e.g. `vault://…`), never a
  plaintext secret. The understudy *service* resolves it against the vault and
  types the plaintext over the trusted service↔extension hop — the secret never
  enters the connector input, the model context, or any audit detail. Do **not**
  route credentials through `type.text`.
- **`resolve_ref`** is an internal service↔extension probe (a pure lookup in the
  extension's live ref map — no snapshot, no ref re-minting) that backs the
  service API's `dryRun` flag. Consumers express dry-run intent via
  `{ command, dryRun: true }` on the service API; they never send `resolve_ref`
  themselves.

## Events (extension → service → consumer)

| type | fields |
|---|---|
| `hello` | `browser`, `extVersion`, `tabs` |
| `snapshot_result` | `commandId`, `tree: A11yNode[]` |
| `screenshot_result` | `commandId`, `mime`, `b64` |
| `tabs_result` | `commandId`, `tabs: TabInfo[]` |
| `action_result` | `commandId`, `ok`, `error?`, `url?`, `simulated?` |
| `page_event` | `kind: "navigated" \| "load"`, `tabId`, `url` |
| `pong` | — |

`action_result.simulated` is set only on dry-run responses. A simulated
`ok: true` guarantees *resolvability* (the `ref` maps to a live node in the
current snapshot generation), not *executability*; ref-less commands simulate
`ok: true` without touching the browser at all.

## Element targeting

`A11yNode.ref` is the only element address a consumer's agent ever uses —
opaque, generation-namespaced (`s{gen}e{seq}`), resolved by the extension
against its CDP `backendNodeId` map. Refs are valid only for the snapshot
generation that produced them; a stale ref returns
`action_result{ ok: false }` and the consumer re-snapshots.

## Versioning

- **0.4.0** — exports `WRITE_COMMAND_TYPES` / `WriteCommandType` (the single
  write-classification source downstream layers derive from) and reclassifies
  `scroll` / `switch_tab` as writes, so `isWriteCommand` now returns `true` for
  them (they are user-visible side effects: dry-run must simulate, retry must
  replay). No schema change.
- **0.3.0** — adds the internal `resolve_ref` probe (fixes dry-run: a snapshot
  probe re-mints refs and would invalidate the consumer's outstanding refs).
- **0.2.0** — adds `fill_secret` and the optional `action_result.simulated`
  field; zod 4.
