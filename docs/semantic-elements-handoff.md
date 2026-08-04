<!-- Content type: Reference -->

# Understand the semantic elements implementation

## Objective

Replace the whole-tree MCP accessibility snapshot with a bounded semantic
element layer. Models can capture a projection, search retained document
content, inspect one target, continue a cursor, request a same-document delta,
and act through opaque generation-fenced refs without receiving raw DOM or the
complete accessibility tree.

The implementation selectively adapts Stagehand's multi-frame capture and AX
pruning architecture from commit
`04c8ee48ffb6c0b1eae2f201a6d756b679d46355`. It does not add Stagehand as a
dependency and does not adopt Stagehand's observation model, XPath conversion,
selector cache, action self-healing, or post-capture full-tree filtering.

## Baseline

| Field | Value |
| --- | --- |
| Implementation branch | `feat/semantic-elements` |
| Branch point | `554a09c53dd4a9b64755da38d0260d4da37fa3d2` (`feat: add guarded deployment workflow`) |
| Fetched `origin/dev` at implementation start | `857e0e3ebb8312be3e260e7339968f602703afdf` |
| Node.js | 24.16.0; packages require 22 or newer |
| pnpm | 11.5.2 |
| Release train | Protocol 0.9.0, connector 0.6.0, extension 0.2.0, backend 0.2.0 |

The local `dev` branch was clean and three commits ahead of the fetched
`origin/dev` when this branch was created. Do not rebase this work onto the
older remote ref without reviewing those local commits.

`pnpm test` and the backend deployment integration suite require permission to
bind loopback ports. The extension release integration test creates temporary
Git repositories and ZIP fixtures and can also need a less restricted sandbox.
Known non-failing warnings are a missing test `EXTENSION_ID` and third-party
sourcemap source warnings.

## Implemented contract

Protocol 3 now advertises `semantic-elements-v1` and defines strict commands
for capture, find, inspect, and continuation. One strict `elements_result`
union carries bounded successes or fixed errors. Protocol 1 and 2 keep the
legacy `snapshot` and `snapshot_result` compatibility path; there is no
protocol 4.

The hosted MCP surface provides:

- `browser_snapshot` with viewport/document scope, interactive/content/all
  views, limits, and structured same-document deltas;
- `browser_find` with normalized deterministic search, exact AX-role filters,
  hidden-node control, and ranked context;
- `browser_inspect` with bounded ancestors, breadth-first descendants, safe
  live state, and optional bounds;
- `browser_snapshot_next` with opaque memory-only continuation cursors.

Every tool has an MCP output schema and object-shaped `structuredContent`.
Page-derived fields are nested below
`{ source: "untrusted_page", page: page_data_here }`. Compact text fallbacks use a random
128-bit boundary and JSON-quote page strings instead of duplicating the full
structured object.

## Implementation map

| Area | Files | Result |
| --- | --- | --- |
| Protocol | `packages/protocol/src/index.ts` | Capability, commands, bounded descriptors/results, fixed action failures, and correlation |
| Hybrid capture | `apps/extension/src/driver/semantic/capture.ts`, `dom.ts` | Parent-first topology, one DOM capture per debugger session, per-frame AX capture, iframe stitching, DOM fallback, and partial-frame placeholders |
| Normalization | `apps/extension/src/driver/semantic/normalize.ts` | Iterative full-AX classification, structural pruning, Unicode normalization, safe states/form/range fields, and editable-value omission |
| Cache and projections | `apps/extension/src/driver/semantic/cache.ts` | Immutable priority-bounded cache, indexed ancestor selection, search ranking/context, inspect, and identity-aware deltas |
| CDP and refs | `apps/extension/src/driver/cdp.ts`, `cdp-events.ts` | Flat child sessions, OOPIF routing, cursor lifetime, delta baseline, generation fencing, and live action fingerprints |
| Runtime routing | `apps/extension/src/core/router.ts`, `session-runtime.ts`, `entrypoints/background.ts` | Semantic command dispatch, fixed failures, child-session identity, and mutation invalidation |
| MCP and account state | `apps/backend/src/mcp/tools.ts`, `mcp/outcomes.ts`, `account-agent.ts`, `session.ts` | Structured tools, untrusted rendering, capability negotiation, and exact snapshot binding |
| Attribution | `apps/extension/public/THIRD_PARTY_NOTICES.txt` | Pinned Stagehand source, copyright, and MIT text |
| Real Chrome | `apps/extension/scripts/e2e.mjs` | Large page, frames, shadow DOM, find/inspect/next, deltas, stale refs, and semantic payment refs |

## Capture and data boundary

`DOMSnapshot.captureSnapshot` is primary and is called with no computed styles,
paint order, DOM rects, blended backgrounds, or text opacity. Conversion reads
only backend node ID, node/tag name, `type`, `placeholder`, `autocomplete`,
clickability, frame/document relationships, layout bounds, and scroll offsets.
Raw attributes and live values are neither copied into the safe model nor
logged, persisted, serialized, or exposed.

Fallback order is DOMSnapshot, adaptive `DOM.getDocument` with truncated-node
hydration, AX-only partial capture, then `capture_failed` only if the main-frame
AX capture also fails. Visibility is `unknown` when a complete cross-frame
transform cannot be proved.

The normalized cache is memory-only and capped at 20,000 nodes and 8 MiB of
normalized page strings. A result is capped at 200 descriptors and 32 KiB;
default snapshot output is at most 80 descriptors. There are at most 16 random
128-bit cursors, each with a ten-minute TTL.

AX, DOM-fallback, depth, and inspect traversals are iterative. Capture scans the
complete accepted AX surface so a late focused, urgent, or actionable node can
reach semantic priority selection. A fixed 40,000-AX-node capture-work ceiling
fails with `page_too_large`; it does not silently discard a high-priority suffix.
The retained cache then selects at most 20,000 nodes with ancestor closure.

Text is converted to well-formed Unicode, normalized to NFC, stripped of C0,
C1, and bidi controls, whitespace-collapsed, and truncated at a code-point
boundary to 512 UTF-8 bytes. Search keys use NFKC and locale-independent
lowercasing. Editable and form-control AX values are omitted; typed range data
is exposed only for non-editable range/status roles.

## Ref and state-machine invariants

Each internal ref record contains backend node ID, frame ID, debugger session
ID, generation, allowed actions, semantic fingerprint, and stable capture
identity. Before a ref action, the extension verifies generation and frame
ownership, then fetches one partial AX node and one depth-zero DOM description.
Only allowlisted metadata participates in an action-specific comparison.
Generation and frame ownership are checked again after asynchronous live reads.
Typing and referenced key actions revalidate after focus; a focus failure stops
the action without a coordinate-click fallback. Click revalidates after pointer
movement and before press/release.

Click, type, key, scroll, and inspect have distinct fingerprint policies.
Typing deliberately ignores live value and validation state so repeated typing
against an otherwise unchanged target remains valid. Failed validation returns
a fixed reason and never redirects the write to another node.

DOM and AX mutation events invalidate the active cache and refs but retain one
immutable delta baseline. Navigation, frame-topology change, target detach,
attachment change, and worker eviction clear that baseline. A subsequent
`changesOnly` capture applies a delta only when loader, URL, and topology still
match; the capture itself always advances the generation and remints refs.

Payment submission validates every ref and action capability before sensitive
mode. After sensitive mode begins, semantic reads, screenshots, page-derived
errors, and automatic retries remain unavailable. Any failure after insertion
may have begun remains `outcome_unknown`.

## Decisions and rejected alternatives

- Keep semantic reasoning in the controlling MCP model. A server-side
  observation model would add latency, cost, and another page-data trust
  boundary.
- Keep opaque refs and deterministic extension-local search. XPath, CSS
  selectors, test IDs, generic extraction, and raw HTML are excluded.
- Keep caches and cursors in memory. Persistent page or action caches could
  revive stale capabilities after worker or navigation boundaries.
- Fail a changed write with a fixed enum. Selector self-healing or inferred
  retargeting could execute a write against a different semantic target.
- Preserve the legacy no-argument attended snapshot only for protocol-1/2
  compatibility. A protocol-3 extension without `semantic-elements-v1`
  receives a fixed upgrade-required result.
- Use DOMSnapshot for bounded capture metadata and `DOM.getDocument` only as a
  fallback. Per-node CDP reads during capture would violate the performance
  and race constraints.
- Follow Stagehand's frame-scoped AX model: one DOM capture per debugger
  session and one AX capture per frame. A session-level AX limit would omit
  same-process child-frame documents because CDP accepts only one `frameId` per
  `Accessibility.getFullAXTree` call.

## Accepted AX capture gate

The source plan contained one contradictory performance requirement. Its capture
architecture and pinned Stagehand implementation require one AX tree per frame,
including same-process child frames. The final performance gate instead says
"at most one AX capture per distinct debugger session." CDP
`Accessibility.getFullAXTree` accepts one `frameId` and returns that frame's
document; one root-session call cannot also return same-process child documents.

The accepted resolution follows Stagehand and preserves complete frame
semantics: one DOM snapshot per debugger session and one AX capture per frame.
The capture test
expects three AX calls for three frames across two debugger sessions. The
performance gate is therefore "at most one AX capture per frame," excluding a
documented fallback retry. The user approved this resolution after the
independent architecture review.

## Current-state anchors

All baseline snippets below are from `554a09c`; re-read symbols before applying
future edits because line numbers will move.

### Baseline role whitelist and value exposure

`apps/extension/src/driver/a11y.ts::MEANINGFUL_ROLES` retained only 15 roles:

```ts
export const MEANINGFUL_ROLES: Set<string> = new Set([
  "button",
  "link",
  "textbox",
  // Remaining roles omitted from this baseline excerpt.
  "cell",
]);
```

`buildA11ySnapshot` copied generic AX values:

```ts
const value = axString(node.value);
if (value !== undefined) {
  if (utf8ByteLength(value) > 4 * 1024) {
    throw new Error("a11y value exceeds 4096 bytes");
  }
  self.value = value;
}
```

The semantic normalizer now classifies all non-ignored AX nodes and omits
editable/form values.

### Baseline whole-tree output

`apps/extension/src/driver/cdp.ts::snapshotA11y` called:

```ts
this.send<Protocol.Accessibility.GetFullAXTreeResponse>(
  "Accessibility.getFullAXTree",
)
```

`apps/backend/src/mcp/outcomes.ts::mapTerminalEvent` rendered the entire tree
into text. The new path retains normalization inside the extension and emits
only a bounded projection. The legacy function remains isolated for attended
protocol-1/2 compatibility.

### Baseline refs and child sessions

`CdpSession` used `refMap: Map<string, number>` and the background event handler
accepted only `{ tabId?: number }`, discarding child `sessionId`. Ref records now
carry frame and debugger-session ownership, and event sources use
`Browser.debugger.DebuggerSession` so OOPIF capture and actions route through
`{ tabId, sessionId }`.

### Stagehand reuse anchor

The pinned Stagehand
`packages/core/lib/v3/understudy/a11y/snapshot/capture.ts::captureHybridSnapshot`
builds session indexes, collects per-frame maps, computes iframe prefixes, and
merges frame snapshots. Understudy adapts that session deduplication, topology,
merge, pruning, and deep-DOM fallback structure. It replaces encoded XPath maps
and full-tree strings with bounded normalized nodes and opaque `RefRecord`s.

## Verification record

Update this table after any implementation change. A result applies only to
the exact source tree on which it ran.

| Gate | Result |
| --- | --- |
| Protocol focused tests | Passed: 52 tests |
| Backend suite | Passed: 383 Vitest and 4 deployment integration tests |
| Extension focused semantic/event tests | Passed: 87 tests in the final focused run |
| Extension full suite | Passed: 307 Vitest and 3 release integration tests |
| Root typecheck/build/test | Passed; connector 29 tests also passed |
| Real-Chrome E2E | Passed: large bounded capture, late find, frames/shadow DOM, pointer replacement, eviction, payment, and non-egress |
| Store build and ZIP | Passed; store ZIP is 142,127 bytes |
| Wrangler types and dry run | Passed; dry run emitted only the known multi-environment warning |
| Independent clean-code review | Clean after all fixes |
| Independent architecture review | Clean; the AX call-count decision was resolved in favor of Stagehand's per-frame model |
| Independent QA review | Clean after all fixes |

Run the final gate from the repository root:

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm --filter @understudy/backend test
pnpm --filter @understudy/extension test
pnpm --filter @understudy/extension test:e2e
pnpm --filter @understudy/extension build:store
pnpm --filter @understudy/extension zip:store
cd apps/backend
pnpm exec wrangler types --check
pnpm exec wrangler deploy --dry-run
```

All commands above pass on the implementation tree. The implementation tranche is committed; publication still requires the Changesets version pull request and the `dev` to `master` promotion described in the release runbook.

## Out of scope

Do not add a Stagehand runtime dependency, observation LLM, selector or XPath
surface, persistent page/action cache, automatic write retry or self-healing,
protocol 4, alternate control origin, semantic payment-field interpretation,
amount verification, payment-status inference, or an unrelated vault or
deployment redesign.
