# Technical Plan — understudy: a governed browser-execution service (Chromium extension + Cloudflare session service)

## Topology (2026-07-13 — the load-bearing decision)

understudy is a **browser-execution SERVICE (substrate)**, not an agent app. It holds the
user's live, logged-in browser sessions and exposes an HTTP **command API**; the LLM agent,
the tool loop, and all governance (approval / RBAC / policy / audit) live in **consumer
applications** that drive understudy over HTTP.

- **understudy (this repo)** = the Chromium extension + a Cloudflare service that terminates
  the extension WebSocket, holds a CDP session per browser session, and serves
  `POST /v1/sessions/:sessionId/commands`. It runs **no LLM** and embeds **no** agent
  framework.
- **Consumers** = `proofoftech/metamind`, `smart-compliance`, … — each its own repo. They own
  the Mastra agent + Claude, and wrap browser actions as **`@proofoftech/breakwater`**
  connectors gated by **`@proofoftech/flowsafe`** approvals. Reference:
  `smart-compliance/docs/examples/understudy-browser-connector.ts` (mirrors metamind's shipped
  `packages/worker/src/intake/connectors.ts`).

Everything below describes the substrate. Where an earlier revision had understudy running the
agent loop / LLM / HITL internally, that work now lives in the consumer; this document reflects
the substrate role.

## Baseline

- **Repo**: `proofoftech/understudy` (its OWN repo — not merged into `proofoftech/anchorage`,
  which is the libs-only monorepo shipping breakwater/flowsafe; every product is a separate repo
  consuming anchorage via published `@proofoftech/*` deps). Branch `master`; HEAD `11565d6`.
  **M1 protocol package done + tested. M0 CDP spike RUN in a real logged-in Chromium 2026-07-13 —
  10/11 CDP commands OK; only `Target.getTargets` is restricted (`"Not allowed"`), which does not
  affect the design (see "M0 findings"). The CDP targeting approach (D2/D7) is validated; the
  plan's one gating technical risk is retired.** M2 (extension driver) is planned as an
  executor-ready planner IR at `~/.claude/plans/enchanted-karp-state/`.
- **Main branch for PRs**: `main` (does not exist yet; create on first push).
- **Runtime targets decided**: Cloudflare-first service; Chromium-only extension; multi-tenant;
  CDP (`chrome.debugger`) as the automation driver. Self-host (Node) of the service is a *future*
  target, kept open behind an interface — not built in v1.
- **Env quirks to know before building**:
  - Cloudflare Workers CPU limit is 5 min (paid), but **I/O wait does not count**. HTTP duration
    is unlimited while the client stays connected; a Durable Object stays alive while a WebSocket
    or pending I/O is in flight.
  - MV3 service workers idle-die after ~30 s. An **active WebSocket resets the idle timer**; a
    ~20–25 s keepalive ping keeps the worker warm. `chrome.offscreen` is the escape hatch for a
    truly durable connection.
  - `chrome.debugger` renders a **non-suppressible yellow "being debugged" banner** on every tab
    while attached. Accepted; Chromium-only.
  - Cloudflare **Browser Rendering / Managed Agents sandboxes are NOT usable** for the *attended*
    path — they spin fresh cloud browsers with no access to the user's logged-in sessions. The
    architecture exists because attended automation must run in the *user's real browser*. (An
    *unattended* per-case managed browser is a deliberate future seam behind the same command API.)

## Implementation prerequisites (read before writing code)

- **Terminology — "Agents SDK" = Cloudflare's `agents` package** (on Durable Objects). In the
  substrate it is used for exactly one thing: the **per-session WebSocket DO** (WS-hibernation
  handling + per-session state). It is **NOT** Anthropic's *Managed Agents* and **NOT** the
  *Claude Agent SDK*. Consumers, not understudy, run the LLM agent (they use Mastra).
- **Verify fast-moving facts at build time.** Written 2026-07-13. Before the relevant milestone,
  re-confirm against current docs: (a) the `chrome.debugger` allowed-CDP surface [M0, retired];
  (b) the Agents SDK API (`Agent`, `routeAgentRequest`, `onConnect/onMessage`, `setState`) +
  Workers/DO limits [M3]; (c) breakwater/flowsafe APIs at the consumer boundary (the
  `POST /commands` contract + `fill_secret`).
- **understudy runs no LLM** — there is no `claude-api` prerequisite here. Model choice
  (Claude `claude-opus-4-8` is the consumers' default; `deepseek-v4-pro` was considered and
  **rejected** — not referenced by breakwater/flowsafe, not verifiably a real model) is the
  consumer's concern. If a thin first-party demo agent is ever built, it uses Claude via Mastra.
- **Cloudflare build**: lean on the `cloudflare:agents-sdk` / `cloudflare:workers-best-practices` /
  `cloudflare:wrangler` skills.
- **Index into codebase-memory once code exists** (nothing to index while greenfield).

## Core decisions (with rationale + rejected options)

| # | Decision | Rationale | Rejected |
|---|---|---|---|
| D1 | **Extension is the automation driver; the service is a substrate, not a brain.** | Only the user's real browser has their logged-in sessions. The service routes *commands* to the session's browser and returns *events*. | Headless Playwright/Puppeteer on server; CF Browser Rendering — no user login state. |
| D2 | **CDP via `chrome.debugger`** for read + act. | Playwright-grade fidelity (a11y tree, precise input, cross-frame) in the *live* logged-in tab. | Content-script-only (can't reach cross-origin iframes / native dialogs / some events). Hybrid is a later evolution. |
| D3 | **Chromium-only** (Chrome, Edge, Brave, Arc). | `chrome.debugger`/CDP is Chromium-only. Forced by D2. | Firefox (no CDP) / Safari (separate build + review). |
| **D-TOP** | **understudy = browser-execution SERVICE; consumers own the agent + governance.** | Matches the shipped metamind/smart-compliance pattern; keeps the substrate framework-light and reusable by many governance apps; decouples understudy from anchorage. | understudy internalizing Mastra/breakwater/flowsafe — duplicates consumer work, is heavier, and framework-couples the substrate. |
| D4 | **Service = Hono (HTTP front door) + Cloudflare Agents SDK per-session DO.** | Hono serves the command API + session/auth/health. The Agents SDK DO gives per-session WS + hibernation + state — the *live session* layer, pre-built. | Hono alone (no stateful WS session); flowsafe's DOs (per-**run** HTTP workflow objects, no live WS — verified: `do-runner/durable-object.js` is an `async fetch` router with zero WebSocket); raw DO (viable, ~100 lines more — D4-alt). |
| D4-alt | If minimizing deps: **raw Durable Object** in place of the Agents SDK session DO. | The `Agent` class *is* a `DurableObject`; the swap is localized to the session-DO file. | — |
| D5 | **Portable substrate core** (`packages/protocol` + the command/session service behind a `SessionCoordinator` interface) is runtime-agnostic plain TS. | Lets a Node self-host of the *service* be added later (a second `SessionCoordinator` impl) instead of a rewrite. The extension is already service-agnostic (configurable WS URL). | Coupling the session/command core to the Agents SDK class (would block self-host). |
| **D6** | **No LLM / agent loop inside understudy.** | The brain executes *remotely* against understudy's command API from the consumer; the model, the tool loop, and prompt handling are the consumer's. understudy stays a clean, model-free substrate. | Embedding a Claude loop (or Mastra agent) in the substrate — re-introduces the coupling D-TOP removes. |
| D7 | **Element targeting = accessibility-tree snapshot with stable `ref` IDs.** | Robust vs. brittle CSS/XPath. Same model Playwright / chrome-devtools-mcp use. Consumer picks a `ref`; extension resolves it to a live node. | Raw selectors (brittle). |
| **D8** | **Governance (HITL approval on writes, RBAC, policy, audit) lives in the CONSUMER** via breakwater + flowsafe (SoD, one approval queue + one audit trail). | A browser write is just another privileged side effect; wrapping it as a breakwater connector puts it through the *same* governance path as any API connector. understudy provides the *hooks* governance needs (an egress-guardable command API, `dryRun`, `fill_secret`), not the approval UX. | understudy's own HITL (a parallel approval stack; no SoD; a second audit trail). |
| **D-SEC** | **Secrets never reach the model: `fill_secret{secretRef}` resolved service-side against a vault.** | The agent passes an opaque `secretRef` (`vault://…`); understudy resolves it (CF Secrets / per-tenant KMS) and types the plaintext. Plaintext never enters the connector input, model context, audit `detail`, or the flowsafe snapshot. | Routing passwords through `type{text}` — leaks plaintext into all four. |
| **D-PUB** | **`@understudy/protocol` is published (zod 4)** as the shared contract consumers import. | Consumer connectors `import { A11yNodeSchema, parseCommand } from '@understudy/protocol'`; they nest its schemas in zod-4 objects, so the protocol must be zod 4 (zod-3-in-zod-4 fails). | Keep it internal/unpublished (consumers couldn't import it); rename to `@proofoftech/…` (churns shipped consumer imports for cosmetics). |
| D9 | **TypeScript everywhere**; pnpm workspaces monorepo (this repo). | Workers, MV3, and the protocol are all JS-native; one language across protocol/service/extension. | Rust/Python — no benefit, extra friction. |
| D10 | **Extension build with WXT**; **service deploy with Wrangler**. | WXT is a modern MV3 framework; Wrangler is the CF standard. | Plain Vite + CRXJS (viable if WXT friction appears). |

## Reference architecture

```
┌──────── CONSUMER app (metamind / smart-compliance — separate repo) ─────────┐
│  Mastra agent (Claude) + @proofoftech/breakwater connectors                  │
│    observe / act / fill_credential  ── createConnector → createTool          │
│    write-action → flowsafe approval gate (SoD) → grant on resume             │
└───────────────────────────────┬──────────────────────────────────────────────┘
        egress-guarded runtime.fetch │  POST /v1/sessions/:sessionId/commands
                                      ▼        { command, dryRun? }  → Event JSON
┌───────────────────── UNDERSTUDY SERVICE (Cloudflare Worker) ─────────────────┐
│  Hono: /v1/sessions/:id/commands  · session mgmt · /auth · /health           │
│  SessionAgent extends Agent  (one Durable Object per SESSION, per tenant/case)│
│    • terminates the extension WebSocket, holds the CDP session + refMap gen   │
│    • coordinator.send(cmd) ─ WS ▶ extension ─ Event ▶ resolves pending map    │
│    • fill_secret: resolve secretRef (vault) → type plaintext service-side     │
└───────────────────────────────┬──────────────────────────────────────────────┘
              wss://<service>/session/:sessionId  (auth token)
                                 ▼
┌───────────────────── User's real Chrome (Chromium) — the EXTENSION (M2) ─────┐
│  Background SW: WS client · keepalive · command router · CDP session manager  │
│  Side Panel (React): status / attach-detach          [ chrome.debugger ]     │
│  driver/cdp.ts: snapshot / click / type / navigate / key / scroll / wait     │
└───────────────────────────────────────────────────────────────────────────────┘
```

The LLM loop, model choice, approval UX, RBAC, policy, and audit are **all in the consumer**.
understudy's job is faithful, isolated, auditable command execution against the live session.

## Repo layout

```
understudy/
  package.json                 # pnpm workspaces root
  pnpm-workspace.yaml
  packages/
    protocol/                  # PUBLISHED @understudy/protocol (zod 4): Command/Event unions + schemas.
      src/index.ts             #   The shared contract consumers import. Add fill_secret here.
    connector/                 # PUBLISHED @understudy/connector (M4): reference breakwater connectors
      src/index.ts             #   (observe/act/fill_credential) consumers import as Mastra tools.
  apps/
    backend/                   # Cloudflare Worker — the browser-execution SERVICE (M3)
      src/index.ts             # Hono app: POST /v1/sessions/:id/commands, session mgmt, auth, health
      src/session.ts           # SessionAgent extends Agent (per-session DO) | raw-DO swap (D4-alt)
      src/coordinator-cf.ts    # SessionCoordinator over the session WS + pending-promise map
      src/secrets.ts           # fill_secret: secretRef → vault resolve → dispatch (plaintext never logged)
      src/auth.ts              # caller (consumer) auth + tenant/session scoping
      wrangler.jsonc
    extension/                 # MV3, Chromium (WXT) — M2 (see the M2 planner IR)
      src/entrypoints/background.ts   # SW: WS client, keepalive, command router, CDP session manager
      src/entrypoints/sidepanel/      # React: status, attach/detach (no task/approval UI — that's consumer-side)
      src/driver/cdp.ts               # CDP executors: snapshot/click/type/navigate/... (+ dry-run seam)
      wxt.config.ts
    # apps/backend-node/       # FUTURE self-host of the SERVICE: reuses protocol + SessionCoordinator
  # The agent loop, Claude client, and tool wiring are CONSUMER code (metamind /
  # smart-compliance), NOT here. understudy PUBLISHES the reference connector
  # (packages/connector -> @understudy/connector) for consumers to import, but does not
  # run it - no breakwater/flowsafe/Mastra code executes in this repo's apps.
```

## The command protocol (`packages/protocol`) — the core contract

The stable IP: shared across the service, the extension, AND consumer connectors; browser-agnostic;
**published as `@understudy/protocol` on zod 4**. Every message is a discriminated union tagged by
`type`, carries a `commandId` for request/response correlation, and is validated with zod at every
boundary.

> **Target contract.** The union below is the shape to converge on; `fill_secret`, `tabs_result`, the public publish, and the zod-4 bump land as milestone follow-ons (see Milestones — `tabs_result` + the zod-4 bump at M2, `fill_secret` + publish at M3).

```ts
// Consumer/Service → Extension
export type Command =
  | { type: "snapshot"; commandId: string; mode: "a11y" | "dom" | "screenshot"; tabId?: number }
  | { type: "navigate"; commandId: string; url: string; tabId?: number }
  | { type: "click"; commandId: string; ref: string }
  | { type: "type"; commandId: string; ref: string; text: string; submit?: boolean }
  | { type: "key"; commandId: string; keys: string; ref?: string }
  | { type: "scroll"; commandId: string; ref?: string; dy: number }
  | { type: "wait"; commandId: string; for: "load" | "idle" | "ms"; value?: number }
  | { type: "get_tabs"; commandId: string }
  | { type: "switch_tab"; commandId: string; tabId: number }
  | { type: "fill_secret"; commandId: string; ref: string; secretRef: string; submit?: boolean };

// Extension → Service
export type Event =
  | { type: "hello"; browser: string; extVersion: string; tabs: TabInfo[] }
  | { type: "snapshot_result"; commandId: string; tree: A11yNode[] }
  | { type: "screenshot_result"; commandId: string; mime: string; b64: string }
  | { type: "action_result"; commandId: string; ok: boolean; error?: string; url?: string }
  | { type: "tabs_result"; commandId: string; tabs: TabInfo[] }
  | { type: "page_event"; kind: "navigated" | "load"; tabId: number; url: string }
  | { type: "pong" };

export interface A11yNode { ref: string; role: string; name?: string; value?: string; children?: A11yNode[] }
export interface TabInfo { tabId: number; url: string; title: string; active: boolean }
```

Design notes:
- `ref` is the *only* thing the consumer's agent ever uses to address an element. Opaque to the
  model; resolved by the extension (see targeting).
- **`fill_secret` is an agent↔service command.** The consumer's `fill_credential` connector sends
  `fill_secret{secretRef}`; the **service** resolves `secretRef` against the vault and drives the
  keystrokes into the session (over the trusted service↔extension hop, reusing the extension's
  existing type path — the extension never reaches the vault, and never sees `fill_secret`). The
  plaintext lives only transiently in the service and on that last hop; it never enters the
  connector input, the model context, the audit `detail`, or the flowsafe snapshot (D-SEC).
- **`dryRun`** rides on the service API (`{command, dryRun?}`), not the union. The M3 service is
  **fail-safe**: on `dryRun` it does a read-only `ref`-resolution check via the `resolve_ref`
  command (a pure lookup against the extension's live ref map — NOT a snapshot: the extension
  re-mints every ref per snapshot, so a snapshot probe can never contain the consumer's ref and
  invalidates all outstanding refs, breaking the approved command after the simulation; this was
  the original M3 dry-run bug, caught by the attended e2e 2026-07-16) and returns a *simulated*
  `action_result` — it never dispatches a mutating command and never resolves a secret (a
  "simulation" must never execute an unapproved write, or it defeats the consumer's approval
  gate). `resolve_ref` IS the extension-native resolve-without-dispatch probe once deferred as
  a "later M2 amendment" — landed with the fix. A dry-run `ok` guarantees *resolvability* (the
  ref maps to a live node in the current generation), not *executability* (e.g. box-model
  availability at dispatch time). `resolve_ref` is an internal service↔extension probe;
  consumers express dry-run intent via the service API's `dryRun` flag, never by sending
  `resolve_ref` themselves.
- `commandId` correlates the async round-trip: the service's `send(cmd)` returns a promise parked
  in a `Map<commandId, resolver>`; the matching `*_result` event resolves it. Only *in-flight*
  commands are lost on DO hibernation; persisted session state is not (see the service section).
- `tabs_result` answers `get_tabs` with a `commandId`-bearing event (added at M2).
- **Published runtime exports** (what consumer connectors import): `parseCommand` / `parseEvent`
  (throwing) and `safeParseCommand` / `safeParseEvent`; `CommandSchema` / `EventSchema`,
  `A11yNodeSchema`, `TabInfoSchema`, `SnapshotModeSchema`; `isWriteCommand` +
  `WRITE_COMMAND_TYPES` (the single write-classification source of truth downstream layers
  derive from — the connector pins its gated union to it at compile time); and the types
  `Command` / `Event` / `WriteCommandType` / `A11yNode` / `TabInfo` / `SnapshotMode`.
- **Write retries are idempotent end to end** (M5): the connector derives a write's `commandId`
  from the breakwater idempotency key (`ik_<key>`); the service records completed write Events
  per session (`completedWrites`, cap 100) and replays a repeated commandId instead of
  re-dispatching (409 for a concurrent duplicate still in flight); the extension keeps its own
  replay + in-flight record (cap 100, storage.session) covering BOTH the service-timed-out-
  after-execution case (replay) and the service-timed-out-mid-execution case (drop the duplicate,
  never re-run). This closed the documented "write performed, response unparseable → retry
  re-executes" gap. The write class here is the protocol's `WRITE_COMMAND_TYPES` — which now
  includes `scroll`/`switch_tab` (user-visible side effects: a dry-run simulates them and a
  retry replays them, so a relative-`dy` scroll never double-scrolls).

## Element targeting (a11y `ref` model) — `apps/extension/src/driver/cdp.ts`

The hard problem. Approach (matches Playwright / chrome-devtools-mcp):

1. **Build snapshot**: `Accessibility.getFullAXTree` (+ `DOM` for `backendNodeId` linkage). Prune to
   actionable/meaningful nodes (buttons, links, inputs, headings, text). Assign each a stable `ref`
   (generation-namespaced `s{gen}e{seq}`) mapped to its CDP `backendNodeId`. Keep the
   `ref → backendNodeId` map in the SW for the current snapshot generation.
2. **The consumer's agent sees** the pruned tree as compact indented text (role + name + ref), not
   raw HTML — far fewer tokens, far more reliable targeting.
3. **Resolve on action**: `click{ref}` → `backendNodeId` → `DOM.getBoxModel` → `Input.dispatchMouseEvent`
   (press+release at center), OR `Runtime.callFunctionOn` `.click()` when geometry is unreliable.
   `type{ref}` → focus node then `Input.insertText` / `Input.dispatchKeyEvent`.
4. **Staleness**: a `ref` is valid only for the snapshot generation that produced it. Every mutating
   action is followed by an implicit re-snapshot before the next action needs one. A stale `ref`
   returns `action_result{ok:false, error:"stale ref"}`; the consumer re-snapshots and retries.
5. **Screenshots** (`mode:"screenshot"` → `Page.captureScreenshot`) are a *fallback* the agent can
   request when the a11y tree is insufficient (canvas, visual layout). DOM/a11y-first keeps cost down.

> `chrome.debugger` exposes the CDP domains needed here (Accessibility, DOM, Input, Page, Runtime).
> **Milestone 0 confirmed this surface on 2026-07-13 — see "M0 findings".** `Target.getTargets` is
> restricted under `chrome.debugger` (`"Not allowed"`); tab enumeration/switching is backed by the
> WebExtensions `chrome.tabs.*` API (not CDP), and per-tab attach uses `chrome.debugger.attach({ tabId })`.
> This was the one real technical risk of the CDP approach; it is now retired.

## M0 findings — CDP surface + a11y ref-model confirmed (2026-07-13)

Probe run via `apps/cdp-spike` on a **real logged-in Chromium tab** (a signed-in Google session — the
a11y tree exposed the account holder, confirming CDP reads the *actual* logged-in page, not a fresh
context — the entire premise of D1). **10/11 CDP commands OK; the a11y `ref` pruning produced usable
targets; and the full attach → snapshot → screenshot → detach cycle completed with a clean detach. The
CDP targeting approach (D2/D7) is validated; the plan's single biggest technical risk is retired.**

CDP command surface:

| CDP command | Result |
|---|---|
| `Accessibility.enable` / `getFullAXTree` | OK — ~2024–2060 nodes on a live page |
| `DOM.enable` / `getDocument` / `getBoxModel` | OK — `getBoxModel` via `backendNodeId` returned a box (1710×978); `ref → coordinates` works |
| `Runtime.enable` / `evaluate` | OK |
| `Input.dispatchMouseEvent` | OK (no-op move) |
| `Page.enable` / `captureScreenshot` | OK — ~235 KB PNG |
| `Target.getTargets` | **FAIL — `{ code: -32000, message: "Not allowed" }`** (restricted under `chrome.debugger`) |

a11y `ref` model (D7): pruning the full tree yielded **162 actionable nodes out of 2060 (~8%)**, each a
`{ ref, role, name }` with a human-meaningful `name` — the search combobox, real button labels (`Share`,
`Google apps`), and links (`Page 2…5`, `Go to Google Home`). This is exactly the compact shape a consumer
feeds its LLM. D7 confirmed end-to-end.

**Impact of the one failure: none on the design.** `Target` target-*discovery* methods are blocked under
`chrome.debugger` by design (a privilege-escalation guard):
- **Per-tab attach** uses `chrome.debugger.attach({ tabId })` with a WebExtensions tab id — never CDP
  `Target.attachToTarget`. `getTargets` was never on the attach path.
- **Multi-tab awareness** (`get_tabs` → `tabs_result`, `switch_tab`) is backed by `chrome.tabs.*`
  (`chrome.tabs.query`, `chrome.tabs.update(tabId, { active: true })`). Protocol commands are unchanged;
  only their extension-side *implementation* is pinned here.
- v1 scope is a single designated tab/session anyway (see "Out of scope").

**One sub-question deferred at M0, probe SHIPPED at M5 (2026-07-17):** cross-origin /
out-of-process iframe (OOPIF) traversal via `Target.setAutoAttach{ flatten: true }` (a *different*
`Target` method than the blocked `getTargets`, generally permitted under `chrome.debugger`).
`apps/cdp-spike` now carries a focused **OOPIF probe** (side-panel button + bundled
`oopif-test.html` cross-origin-iframe page + runbook in its README): it runs `setAutoAttach`,
collects `Target.attachedToTarget` events, and drives each attached target through session-scoped
`sendCommand({tabId, sessionId}, …)` (`Runtime.evaluate` + `Accessibility.getFullAXTree`). The
probe is attended (~5 min, real Chromium ≥125) and has not been run yet; record its verdict here
when it runs. Driver implementation in `apps/extension` stays gated on a green probe AND a
consumer actually needing cross-origin-iframe targeting — the single-frame path is proven.

## Consumer integration — the governed connector (breakwater + flowsafe)

This is CONSUMER code (in metamind / smart-compliance), documented here because it defines understudy's
outward contract. Canonical reference: **`packages/connector` (`@understudy/connector`, M4)** — tested
against the shipped M3 service contract (bearer caller auth, protocol v0.3.0). The historical sketch it
grew from, `smart-compliance/docs/examples/understudy-browser-connector.ts`, predates M3 (no caller
auth, local `fill_secret` shim) and carries stale pre-Topology-1 prose; prefer the package.

- A browser action is wrapped as a **breakwater `createConnector()`** (three connectors:
  `observe` = read/no-approval, `act` = write/discriminated-union, `fill_credential` = write/vaulted).
  Each connector's `execute()` calls understudy via the **egress-guarded `runtime.fetch`** at
  `POST {UNDERSTUDY_URL}/v1/sessions/:sessionId/commands`, then validates the returned `Event` with
  `@understudy/protocol`.
- **Governance the consumer gets for free** (understudy provides the hooks, not the mechanism):
  - `permissions.requiresApproval` → the write is DENIED unless the request carries a flowsafe-minted
    grant in `requestContext['breakwater.approvedConnectors']`; flowsafe suspends the run at an
    approval gate, an **independent** analyst approves (SoD), then the connector executes — one approval
    queue, one audit trail, not understudy's own HITL.
  - `permissions.egress` → `runtime.fetch` is pinned to the understudy host; anything else is denied + audited.
  - `permissions.idempotencyKey` → at-most-once across DO hibernation/retries via **D1** stores (in-memory
    defaults are per-isolate = per-run under flowsafe → would double-submit; use `D1IdempotencyStore` /
    `D1RateLimitStore`). A resumed step never double-submits a form.
  - `permissions.dryRun` → "propose the action, don't dispatch it" (plan→review→execute).
  - `permissions.rateLimit` → bounds runaway automation per connector/tenant.
- **Grants mint for STATIC connector ids** (`browser.act`, `browser.fill_credential`) at the flowsafe
  suspension — never derived from model output (a grant is a capability token).
- **Model choice is the consumer's** (Claude `claude-opus-4-8` default). understudy is model-free.

## The browser-execution service (`apps/backend`)

- **`SessionAgent extends Agent`** (Agents SDK). One DO **per session** (per tenant/case), addressed by
  `sessionId` — *not* one per user. It terminates the extension WebSocket
  (`wss://.../session/:sessionId`), holds the CDP session mirror (the `SessionCoordinator`), and tracks
  the refMap generation.
- **`POST /v1/sessions/:sessionId/commands`** (Hono): body `{ command, dryRun? }` → route to that
  session's DO → `coordinator.send(command)` → await the correlated `Event` → return it as JSON. The
  `sessionId` selects an **isolated per-tenant/per-case** browser context (attended extension WS now;
  unattended managed browser is a future seam behind the same route) — never a shared profile.
- **`SessionCoordinator`** (interface in the portable core, impl in `coordinator-cf.ts`):
  ```ts
  interface SessionCoordinator {
    send(cmd: Command): Promise<Event>;     // WS send + await matching commandId
    setStatus(s: SessionStatus): void;      // → this.setState (SQLite + broadcast)
  }
  ```
  CF impl: `send` writes to the WS and parks a resolver in an in-memory `Map`; **also persist the
  "awaiting commandId" marker via `this.setState`** so a mid-command hibernation wakes knowing a command
  was outstanding and re-requests a snapshot rather than deadlocking. There is **no** `requestApproval`
  here — approval is the consumer's (flowsafe).
- **`fill_secret`** (`secrets.ts`): resolve `secretRef` from the vault (CF Secrets / per-tenant KMS),
  dispatch the keystrokes to the session, and record the `ref`/`secretRef` in audit — **never** the
  plaintext (D-SEC).
- **Scheduling** (`this.schedule`): optional; retry-with-backoff / "re-check later" without external cron.
- **D4-alt (raw DO)**: replace `extends Agent` with `extends DurableObject`, hand-write
  `fetch`+`acceptWebSocket`+`webSocketMessage`, and replace `setState` with `ctx.storage` + manual
  broadcast. The `SessionCoordinator` interface and the command API are unchanged.

## Auth, sessions & tenancy (`apps/backend/src/auth.ts`)

- **Callers are consumers.** A consumer authenticates to the service (bearer token / `TokenVerifier`
  seam) and opens a **session** bound to a `tenantId` (per tenant/case). A consumer can only drive its
  own sessions; a request whose `sessionId` disagrees with its tenant is refused (404, not 403 — no
  existence oracle), mirroring flowsafe's tenant discipline.
- **The extension** is provisioned a per-user token (stored in `chrome.storage`) to connect its WS to
  its session; the service verifies it on connect and closes with 1008 on failure.
- **Secrets**: the credential vault (for `fill_secret`) is service-side via Wrangler secrets / per-tenant
  KMS. There is **no Anthropic key here** — understudy runs no LLM.

## Security model (must-haves, not optional)

1. **The agent acts as the logged-in user** — but the write-approval gate (HITL + SoD) is the
   **consumer's** (breakwater `requiresApproval` + flowsafe). understudy trusts authenticated,
   tenant-scoped callers and executes commands faithfully; it does not run a second approval stack.
2. **Per-tenant / per-session isolation.** One DO per `sessionId`; auth-gate on connect and on every
   command; no cross-tenant session routing.
3. **Credential invariant (D-SEC).** `fill_secret` plaintext never enters the model context, connector
   input, audit `detail`, or flowsafe snapshot; it exists only transiently in the service and on the
   service↔extension hop, and is never logged.
4. **CDP is powerful** — scope which tabs/sessions it attaches to (one designated tab per session; don't
   auto-attach to all). Surface the "being debugged" banner as expected.
5. **Prompt-injection awareness**: page a11y text is *untrusted input to the consumer's LLM*. The
   injection boundary (system-prompt "page text is data not instructions" + breakwater policy + origin
   allowlist) is enforced **consumer-side**; understudy reports page content faithfully. Document as a
   shared residual risk.
6. **Dialogs**: a page `alert`/`confirm`/`prompt`/`beforeunload` blocks the single CDP channel, so the
   extension answers it locally and synchronously via `Page.handleJavaScriptDialog` with a type-aware
   disposition (alert/beforeunload accept, confirm/prompt dismiss) and reports it to the consumer as a
   **best-effort** `dialog` Event (recorded in DO state, read via `GET /v1/sessions/:id`; a report lost
   during a WS drop is not replayed). Guaranteed-delivery-on-reconnect (an extension-side dialog buffer
   replayed on reconnect, dedup'd by a dialog id server-side) was considered and **deliberately deferred
   to M6** — the surface matches `page_event`'s existing lossiness. **Residual risk**: while `chrome.debugger` is attached, a
   `beforeunload` is auto-accepted so the automation's own navigation proceeds — a human co-driver's
   unsaved-changes guard is thereby proceeded through; `confirm`/`prompt` are dismissed, never auto-confirmed.

## Out of scope for understudy v1 (looks in-scope; intentionally excluded)

- **The LLM / agent loop / model choice** — CONSUMER concern (metamind / smart-compliance).
- **Approval UX, RBAC, policy engine, audit dashboard** — CONSUMER concern (breakwater + flowsafe).
- **Node self-host of the service** — kept *possible* (portable core + interface), not *built*.
- **Firefox / Safari** — excluded by D3.
- **Content-script fallback / hybrid driver** — v1 is pure CDP (D2).
- **Unattended managed-browser sessions** — a deliberate seam behind the command API; v1 is the attended
  extension path.
- **Cloudflare Browser Rendering / Managed Agents (attended path)** — architecturally wrong (no user session).
- **Stagehand / Playwright-based frameworks as a dependency** — they drive their own browser, not the
  user's logged-in one (fails D1), and can't run on Workers. Borrow the `act`/`extract`/`observe` +
  a11y-grounding *design* (already reflected in D7); don't depend on the library. A local Node companion
  via `connectOverCDP` is a different product, kept as **Plan B**.

## Milestones (build order — each independently verifiable)

- **M0 — CDP spike. ✅ DONE (2026-07-13)** — 10/11 CDP commands OK; only `Target.getTargets` restricted
  (non-blocking); a11y ref-model pruning validated (162/2060 actionable). See "M0 findings".
- **M1 — Protocol package. ✅ DONE** — `@understudy/protocol` zod schemas + types; round-trip tests.
  *Follow-ons: `tabs_result` + the zod 3→4 bump land at M2 (the extension bundles zod 4); `fill_secret` + the public **publish** land at M3.*
- **M2 — Extension driver.** SW holds a WS to a stub server; `cdp.ts` implements
  snapshot/click/type/navigate/key/scroll/wait; command router maps protocol → CDP; 20–25 s keepalive +
  `chrome.alarms` backstop. **Planned as an executor-ready planner IR** at
  `~/.claude/plans/enchanted-karp-state/` (9 milestones / 7 waves). Small amendments from Topology 1: the
  zod-4 bump (extension bundles protocol+zod), and a `dryRun` execution mode (resolve ref, don't dispatch)
  or an explicit "unsupported" deferral. `fill_secret` is service-side, so the executors are unchanged.
- **M3 — Browser-execution service.** Hono + Agents-SDK **per-session** DO; `routeAgentRequest`;
  `POST /v1/sessions/:sessionId/commands` (with `dryRun`); the pending-map + hibernation-resume marker;
  `fill_secret` vault resolution; caller auth + per-tenant/session scoping. Verify: a stub consumer (or
  `curl`) drives a real logged-in page over HTTP through the service and gets schema-valid `Event`s;
  session survives a mid-command DO hibernation without deadlock.
- **M4 — Consumer integration + published contract.** Publish `@understudy/protocol` (zod 4) and a
  reference breakwater connector (`@understudy/connector`, mirroring the smart-compliance example). A real
  consumer (metamind / smart-compliance) drives understudy end-to-end with a Mastra agent + flowsafe
  approvals. *Cross-repo; understudy's deliverable is the published contract + reference connector, not
  the agent.* **Status (2026-07-16): `packages/connector` BUILT** — observe (snapshot/get_tabs/wait) /
  act (click/type/navigate/key/scroll/switch_tab, grant-gated) / fill_credential (vaulted), egress-pinned
  `runtime.fetch`, caller bearer auth, 15 tests against the real breakwater wrapper (fail-closed grant,
  idempotent replay, per-hop egress denial, dry-run). Both packages are publish-ready (MIT,
  `files`-scoped tarballs, `publishConfig.access: public`) and the changesets + GitHub Actions release
  flow is wired (`.github/workflows/release.yml`, single-branch master — first push publishes 0.3.0 /
  0.1.0 with no changeset needed); publishing waits on the npm `understudy` org + `NPM_TOKEN` secret.
  The consumer-side Mastra+flowsafe e2e remains open.
- **M5 — Substrate hardening. LARGELY LANDED (2026-07-17, the deferred-items sweep):**
  pre-accept WS/HTTP auth at the Worker edge (`onBeforeConnect`/`onBeforeRequest` — unauthorized
  upgrades are 401/404 before the DO accepts, in-DO gate kept as defense in depth); credential
  vault hardened to AES-256-GCM envelopes over KV under a `VAULT_MASTER_KEY` Worker secret
  (`src/vault.ts` + `scripts/vault-put.mjs`; plaintext never at rest, legacy plaintext fails
  closed); typed `DispatchOutcome` error taxonomy across the DO RPC boundary (503 not-connected /
  503 resynced / 504 timeout / 409 duplicate; no more RPC-rejection noise); idempotent write
  replay (see above); onClose status stamping gated on authorization; **first real deploy** to
  `https://understudy-backend.gcharang.workers.dev` with real minted secrets (runbook in
  `apps/backend/README.md` "Deploy") — live smoke: health, 401, mint, fail-fast 503, WS-gate 401,
  encrypted vault seed all verified. **Two-tenant isolation e2e LANDED
  (2026-07-17):** closing it surfaced a real cross-tenant vault-read gap —
  `fillSecret` resolved any caller-supplied `secretRef` with no tenant scoping, so
  tenantB (driving its own session) could exfiltrate `vault://tenantA/…` plaintext.
  Fixed server-side (`auth.ts::tenantOf` + a `vault://<tenantId>/…` namespace guard
  in `fillSecret`, before any vault read; scrubbed `ok:false`, no existence oracle);
  proven by `test/service.test.ts` "two-tenant vault isolation" (session/status/WS
  axes were already covered). **Dialog handling breadth LANDED (2026-07-17):**
  type-aware local disposition (alert/beforeunload accept, confirm/prompt dismiss — a `beforeunload`
  dismiss was cancelling navigations) + a best-effort `dialog` Event surfaced via `GET /v1/sessions/:id`
  (protocol 0.5.0, connector 0.3.0; residual #6). Still open under M5: session/GIF audit logging.
  Deferred to M6: guaranteed dialog delivery (best-effort accepted for now).
- **M6 — Ops.** Rate/quotas at the service edge, observability, unattended-session seam scoping,
  guaranteed dialog delivery (extension-side dialog buffer + replay-on-reconnect + server-side dedup —
  deferred from M5's best-effort `dialog` surface; see residual #6).

## Verification

- **Unit**: protocol zod round-trips (`@understudy/protocol`); a11y-tree pruning/ref-assignment (`cdp.ts`
  with recorded CDP fixtures); the pure driver logic (a11y/keymap/cdp-events) per the M2 IR.
- **Service**: `vitest` with `@cloudflare/vitest-pool-workers` for the session DO (WS connect, state
  persistence across simulated hibernation, pending-map resume, tenant scoping, `fill_secret` never
  logging plaintext).
- **Extension**: `wxt build` + load unpacked in a real logged-in Chromium; scripted end-to-end via the M2
  stub server.
- **"Done" for v1** = M3 green: a consumer (or stub) drives a real logged-in site through a multi-step
  task over `POST /commands` (read → act) with schema-valid events, surviving a mid-task DO hibernation,
  isolated per tenant/session. M4 proves the governed end-to-end via a real consumer.
- **Quality gate before merging any non-trivial change** (per project policy): parallel
  `quality-reviewer` + `architect` + independent QA subagents; fix and re-run any lane that flags.

## Reuse map (don't re-create)

- **Session/WS primitives**: Cloudflare Agents SDK (`agents`) for the per-session DO — WS/hibernation/state.
  Do not hand-roll unless taking D4-alt.
- **Governance**: `@proofoftech/breakwater` (connectors, policy, RBAC, audit) + `@proofoftech/flowsafe`
  (approvals, durable runs) — in the CONSUMER, not here. Reference:
  `smart-compliance/docs/examples/understudy-browser-connector.ts`.
- **Element targeting pattern**: mirror Playwright / `chrome-devtools-mcp` ARIA-snapshot+ref; the
  `mcp__claude-in-chrome__*` tools are a live reference implementation.
- **Extension framework**: WXT — don't hand-assemble MV3 plumbing.

## Appendix: reference patterns to build from (known-good shapes)

**Per-session DO + WS (service):**
```ts
import { Agent, routeAgentRequest } from "agents";
export class SessionAgent extends Agent<Env, SessionState> {
  onConnect(conn, ctx) { /* verify the extension's per-user token from ctx.request; else conn.close(1008) */ }
  async onMessage(conn, raw) {
    const ev = parseEvent(JSON.parse(raw));                  // @understudy/protocol
    if (ev.type.endsWith("_result") || ev.type === "pong") return this.resolvePending(ev);
    /* hello → record tabs; page_event → broadcast status */
  }
  // POST /v1/sessions/:id/commands routes here (per-session DO); send(cmd) parks a resolver + persists the awaiting marker.
}
export default { fetch: (req, env) => routeAgentRequest(req, env) /* + Hono for /v1/... /auth /health */ };
```

**CDP click via ref (extension):**
```ts
const { model } = await cdp("DOM.getBoxModel", { backendNodeId });   // ref → backendNodeId from the current snapshot map
const [x, y] = centerOf(model.content);
await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
```

**Governed browser connector (CONSUMER — reference only):**
```ts
// smart-compliance / metamind: a breakwater connector whose execute() calls understudy over runtime.fetch.
const act = createConnector({
  id: "browser.act",
  permissions: { sideEffect: "write", egress: [understudyHost], idempotencyKey: true, requiresApproval: true, dryRun: true, rateLimit: "60/min" },
  execute: async (input, _ctx, runtime) => {
    const res = await runtime.fetch(`${UNDERSTUDY_URL}/v1/sessions/${input.sessionId}/commands`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command: toCommand(input.action) }) });
    return parseEvent(await res.json());   // action_result → { ok, url, error }
  },
});
```

**Notes for a fresh session executing this plan:** line numbers do not exist yet (greenfield). Locate all
edits by file + symbol from the repo layout. M2 is captured as a planner IR at
`~/.claude/plans/enchanted-karp-state/`; M3 (this service) is the next IR. The one assumption that could
force a design change (the `chrome.debugger` CDP surface) was retired at M0.
