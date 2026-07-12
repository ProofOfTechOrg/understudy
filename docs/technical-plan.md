# Technical Plan — LLM-Driven Browser Puppeteering (extension + Hono backend)

## Baseline

- **Repo**: `proofoftech/understudy` (local dir may still be named `control-browser-from-server` until renamed). Branch `master`. Initial scaffold committed at `9fb7c28`: **M1 protocol package done + tested; M0 CDP-spike harness built** (`apps/cdp-spike`) — the M0 probe still needs to be run in a real Chromium to capture the finding.
- **Main branch for PRs**: `main` (does not exist yet; create on first push).
- **Runtime targets decided**: Cloudflare-first backend; Chromium-only extension; multi-user product; CDP (`chrome.debugger`) as the automation driver. Self-host (Node) backend is a *future* target, kept open behind an interface — not built in v1.
- **Env quirks to know before building**:
  - Cloudflare Workers CPU limit is 5 min (paid), but **I/O wait (LLM `fetch`) does not count** — long agent loops are fine. HTTP duration is unlimited while the client stays connected; a Durable Object stays alive while a WebSocket or pending I/O is in flight.
  - MV3 service workers idle-die after ~30 s. An **active WebSocket resets the idle timer**; a ~20–25 s keepalive ping keeps the worker warm. `chrome.offscreen` document is the escape hatch for a truly durable connection.
  - `chrome.debugger` renders a **non-suppressible yellow "being debugged" banner** on every tab while attached. This is accepted (Q1 answer). It is Chromium-only.
  - Cloudflare **Browser Rendering / Managed Agents sandboxes are NOT usable** here — they spin fresh cloud browsers with no access to the user's logged-in sessions. The whole architecture exists because the automation must run in the *user's real browser*.

## Implementation prerequisites (read before writing code)

- **Terminology — "Agents SDK" = Cloudflare's `agents` package** (on Durable Objects), the coordination runtime in D4. It is **NOT** Anthropic's *Managed Agents* (a hosted agent loop + cloud sandbox — can't reach the user's browser; ruled out) and **NOT** the *Claude Agent SDK* (`@anthropic-ai/claude-agent-sdk`, a coding-agent harness). The name is overloaded three ways — don't import the wrong one. Why it was chosen over raw Durable Objects: it pre-builds the four things this system needs (WS-hibernation handling, per-user state→SQLite+broadcast, scheduling, HITL approval) and `Agent:userId` *is* the multi-user isolation; raw DO (D4-alt) is a legitimate lower-dependency swap.
- **Verify fast-moving facts at build time — do not trust this plan's specifics as gospel.** Written 2026-07-13. Before the relevant milestone, re-confirm against current docs: (a) the `chrome.debugger` allowed-CDP-command surface [M0 — the gating risk]; (b) the Agents SDK API (`Agent`, `routeAgentRequest`, `onConnect/onMessage`, `setState`) and Workers/DO limits [M3]; (c) Claude model IDs + Messages API shape [M4].
- **Before writing any LLM code (`packages/agent-core`), load the `claude-api` skill.** Model IDs and parameters drift (e.g. `budget_tokens`/`temperature` now 400 on Opus 4.8; adaptive thinking; `strict` tools; prompt-cache layout). The agent-core section reflects the API as of the base date; the skill is the live source of truth.
- **Cloudflare build**: lean on the `cloudflare:agents-sdk` / `cloudflare:workers-best-practices` / `cloudflare:wrangler` skills — they retrieve current CF docs.
- **Index into codebase-memory once code exists** (nothing to index while greenfield): run the indexing recipe from the global CLAUDE.md after scaffolding so structural code queries work.

## Core decisions (with rationale + rejected options)

| # | Decision | Rationale | Rejected |
|---|---|---|---|
| D1 | **Extension is the automation driver; backend is a brain.** | Only the user's real browser has their logged-in sessions. Backend sends *intents*, extension executes them in-tab and reports back. | Headless Playwright/Puppeteer on server; CF Browser Rendering — no user login state. |
| D2 | **CDP via `chrome.debugger`** for read + act. | Playwright-grade fidelity (a11y tree, precise input, cross-frame) in the *live* logged-in tab. | Content-script-only (no banner, but can't reach cross-origin iframes / native dialogs / some events; more per-site breakage). Hybrid is the mature end-state — evolve into it later. |
| D3 | **Chromium-only** (Chrome, Edge, Brave, Arc). | `chrome.debugger`/CDP exists only in Chromium. Forced by D2. | Firefox (no CDP) / Safari (separate build + review). |
| D4 | **Backend = Hono (HTTP front door) + Cloudflare Agents SDK (coordination).** | Hono handles stateless HTTP (auth, config, health). Agents SDK (on Durable Objects) gives WS + per-user state + scheduling + hibernation + HITL — the coordination layer, pre-built. | Hono alone (doesn't do stateful WS coordination); raw DO (viable, ~100 lines more, one fewer dep — see D4-alt). |
| D4-alt | If minimizing deps: **raw Durable Object** in place of the Agents SDK. | The `Agent` class *is* a `DurableObject`; swap is localized to `apps/backend/src/agent.ts`. | — |
| D5 | **Portable core** (`packages/protocol`, `packages/agent-core`) is runtime-agnostic plain TS; per-target adapters are thin. | Lets the Node self-host target be *added* later (a second `SessionCoordinator` impl) instead of a rewrite. The extension is already backend-agnostic (configurable WS URL). | Coupling the agent loop to the Agents SDK class (would block self-host). |
| D6 | **LLM = Anthropic Claude, `claude-opus-4-8`, manual agentic loop, tool-use.** | Manual loop (not the SDK Tool Runner) because our "tools" execute *remotely & asynchronously* in the extension, gate on human approval, and must survive DO hibernation mid-loop — we need to own every step and persist between them. | Tool Runner (drives its own loop over *local* functions; awkward with remote async tools + hibernation-resumable state). Fine for the Node target later. |
| D7 | **Element targeting = accessibility-tree snapshot with stable `ref` IDs.** | Robust vs. brittle CSS/XPath. Same model Playwright / chrome-devtools-mcp / Claude-in-Chrome use. LLM picks a `ref`; extension resolves it to a live node. | Raw selectors (brittle, the model guesses wrong constantly). |
| D8 | **Human-in-the-loop approval on state-changing actions**, opt-in autonomous/allowlist mode. | The agent acts as the logged-in user (can send money, delete data). Safety default. | Fully autonomous by default (unsafe for a puppeteering tool). |
| D9 | **TypeScript everywhere**; pnpm workspaces monorepo. | Workers, MV3, and the Anthropic SDK are all JS-native; one language across protocol/backend/extension. | Rust/Python — no benefit here, extra FFI/serialization friction. |
| D10 | **Extension build with WXT**; **backend deploy with Wrangler**. | WXT is a modern MV3 framework (HMR, cross-context messaging, manifest gen). Wrangler is the CF standard. | Plain Vite + CRXJS (viable alternative if WXT friction appears — moderate-confidence recommendation). |

## Reference architecture

```
┌───────────────────── User's real Chrome (Chromium) ──────────────────────┐
│  Side Panel (React)        Background SW               (target tab)        │
│  • task input            • holds WS to backend         [ chrome.debugger ] │
│  • approval prompts  ⇄   • holds CDP session      ⇄    CDP: Accessibility, │
│  • live status           • command router               DOM, Input, Page, │
│  (chrome.runtime msg)    • 20-25s WS keepalive          Runtime, Target    │
└───────────────────────────────┬───────────────────────────────────────────┘
                                 │ wss://<backend>/agent/<userId>   (auth token)
                                 ▼
┌────────────────────────── Cloudflare Worker ──────────────────────────────┐
│  Hono: /health /config /auth ... + routeAgentRequest → Agent               │
│  BrowserSessionAgent extends Agent  (one Durable Object instance per user) │
│    onMessage(event)  ── feeds ──▶  agent-core loop (portable, SDK-free)    │
│    coordinator.send(cmd) ─ WS ▶ extension ─ result ▶ resolves pending map  │
│    setState({task,step,lastAction})  → SQLite + broadcast to Side Panel     │
└─────────────────────────────────┬─────────────────────────────────────────┘
                                   ▼  fetch (I/O, doesn't count vs CPU limit)
                          Anthropic Messages API (Claude tool-use loop)

Loop:  a11y snapshot ─▶ Claude returns tool_use(s) ─▶ [approval gate on writes]
       ─▶ coordinator.send(command) ─▶ extension executes in tab ─▶ result
       ─▶ tool_result ─▶ Claude ─▶ … ─▶ end_turn
```

## Repo layout

```
understudy/
  package.json                 # pnpm workspaces root
  pnpm-workspace.yaml
  packages/
    protocol/                  # SHARED, portable: command/event discriminated unions + zod schemas
      src/index.ts
    agent-core/                # SHARED, portable, SDK-FREE: agent loop, Claude client, a11y→text, planner
      src/loop.ts              # runAgentStep(): the manual tool-use loop, one step at a time
      src/tools.ts             # BROWSER_TOOLS: Claude tool definitions (strict) mirroring protocol
      src/coordinator.ts       # SessionCoordinator interface (send/awaitResult/requestApproval)
      src/llm.ts               # Anthropic client + prompt-cache layout + model config
  apps/
    backend/                   # Cloudflare Worker (v1 target)
      src/index.ts             # Hono app + routeAgentRequest
      src/agent.ts             # BrowserSessionAgent extends Agent  (D4)  | raw-DO swap point (D4-alt)
      src/coordinator-cf.ts    # SessionCoordinator impl over the Agent's WS + pending-promise map
      src/auth.ts              # token verification (multi-user)
      wrangler.jsonc
    extension/                 # MV3, Chromium (WXT)
      src/entrypoints/
        background.ts          # SW: WS client, keepalive, command router, CDP session manager
        sidepanel/             # React: task input, approval UI, live status (agents/react useAgent optional)
        content.ts             # minimal: fallbacks + page-event hints (most work is via CDP)
      src/driver/cdp.ts        # CDP executors: snapshot(), click(ref), type(ref,text), navigate(), ...
      wxt.config.ts
    # apps/backend-node/       # FUTURE self-host target: reuses protocol + agent-core; ws + in-mem/Redis
```

## The command protocol (`packages/protocol`) — the core contract

This is the stable IP: it's shared across both backend targets and is browser-agnostic. Freeze its shape before building either side. Every message is a discriminated union tagged by `type`, carries a `commandId` for request/response correlation, and is validated with zod at both ends.

```ts
// Backend → Extension
export type Command =
  | { type: "snapshot"; commandId: string; mode: "a11y" | "dom" | "screenshot"; tabId?: number }
  | { type: "navigate"; commandId: string; url: string; tabId?: number }
  | { type: "click"; commandId: string; ref: string }
  | { type: "type"; commandId: string; ref: string; text: string; submit?: boolean }
  | { type: "key"; commandId: string; keys: string; ref?: string }        // e.g. "Enter", "Control+A"
  | { type: "scroll"; commandId: string; ref?: string; dy: number }
  | { type: "wait"; commandId: string; for: "load" | "idle" | "ms"; value?: number }
  | { type: "get_tabs"; commandId: string }
  | { type: "switch_tab"; commandId: string; tabId: number };

// Extension → Backend
export type Event =
  | { type: "hello"; browser: string; extVersion: string; tabs: TabInfo[] }
  | { type: "snapshot_result"; commandId: string; tree: A11yNode[] }       // ref-tagged (see targeting)
  | { type: "screenshot_result"; commandId: string; mime: string; b64: string }
  | { type: "action_result"; commandId: string; ok: boolean; error?: string; url?: string }
  | { type: "page_event"; kind: "navigated" | "load"; tabId: number; url: string }
  | { type: "pong" };                                                       // keepalive

export interface A11yNode { ref: string; role: string; name?: string; value?: string; children?: A11yNode[] }
export interface TabInfo { tabId: number; url: string; title: string; active: boolean }
```

Design notes:
- `ref` is the *only* thing the LLM ever uses to address an element. It is opaque to the model and resolved by the extension (see targeting).
- `commandId` correlates the async round-trip: `coordinator.send(cmd)` returns a promise stored in a `Map<commandId, resolver>`; the matching `*_result` event resolves it. This map is what must be re-established after DO hibernation (only *in-flight* commands are lost; persisted task state is not — see coordination).
- Keep the union small in v1 (above). `extract`/structured-scrape is done LLM-side from the a11y snapshot, not as a separate command, until proven necessary.

## Element targeting (a11y `ref` model) — `apps/extension/src/driver/cdp.ts`

The hard problem. Approach (matches Playwright / chrome-devtools-mcp):

1. **Build snapshot**: `Accessibility.getFullAXTree` (+ `DOM.getDocument` for backendNodeId linkage). Prune to actionable/meaningful nodes (buttons, links, inputs, headings, text). Assign each a stable `ref` (string) mapped to its CDP `backendNodeId`. Keep the `ref → backendNodeId` map in the SW for the current snapshot generation.
2. **LLM sees** the pruned tree as compact indented text (role + name + ref), not raw HTML — far fewer tokens, far more reliable targeting.
3. **Resolve on action**: `click{ref}` → look up backendNodeId → `DOM.getBoxModel` for coordinates → `Input.dispatchMouseEvent` (press+release at center), OR `Runtime.callFunctionOn` on the resolved node for `.click()` when geometry is unreliable (off-screen, overlays). `type{ref}` → focus node then `Input.insertText` / `Input.dispatchKeyEvent`.
4. **Staleness**: a `ref` is valid only for the snapshot generation that produced it. Every mutating action is followed by an implicit re-snapshot before the next `tool_use` needs one. If a `ref` no longer resolves, return `action_result{ok:false, error:"stale ref"}`; the loop re-snapshots and retries.
5. **Screenshots** (`mode:"screenshot"` → `Page.captureScreenshot`) are a *fallback* the model can request when the a11y tree is insufficient (canvas, visual layout). Sent to Claude as a base64 image block (Opus 4.8 high-res vision, ≤2576px long edge). DOM/a11y-first keeps cost down.

> `chrome.debugger` exposes the CDP domains needed here (Accessibility, DOM, Input, Page, Runtime, Target). **Spike this first** (Milestone 0) — confirming the exact allowed-command surface under `chrome.debugger` (a few CDP commands are restricted vs. raw CDP) is the one real technical risk of the CDP approach.

## Agent loop + LLM (`packages/agent-core`)

Grounded against the current Anthropic API (verified via the `claude-api` skill):

- **Model**: `claude-opus-4-8` (default). Configurable per deployment; `claude-sonnet-5` is the cheaper high-volume option; `claude-haiku-4-5` for trivial steps. Model IDs are exact — never append date suffixes.
- **Thinking**: `thinking: { type: "adaptive" }` + `output_config: { effort: "high" }` (raise to `xhigh` for hard multi-step tasks). Do **not** send `budget_tokens` (400 on Opus 4.8) or `temperature`/`top_p`/`top_k` (400).
- **Tools**: `BROWSER_TOOLS` = one Claude tool per protocol `Command`, each with `strict: true` + `additionalProperties: false` so the extension always receives well-formed args. Tool `description`s are prescriptive about *when* to call (Opus 4.8 reaches for tools conservatively — state trigger conditions).
- **Loop shape** (manual, one step per `onMessage`/turn so it survives hibernation):
  ```ts
  // agent-core/src/loop.ts (sketch)
  // 1. ensure a fresh a11y snapshot in `messages` (as a compact text block)
  // 2. resp = await claude.messages.create({ model, tools: BROWSER_TOOLS, messages, thinking, output_config, stream:true })
  // 3. if resp.stop_reason === "end_turn": task step done → setState(done) → return
  // 4. for each tool_use block:
  //      if isWriteAction(block) && requireApproval:
  //          await coordinator.requestApproval(block)   // pauses; resumes on user.approve event
  //      const result = await coordinator.send(toCommand(block))   // WS round-trip to extension
  //      push tool_result(block.id, result)
  // 5. append assistant turn + tool_results; loop
  ```
- **Prompt caching** (real cost lever — every step resends growing history): frozen system prompt + deterministic `BROWSER_TOOLS` order, with `cache_control: {type:"ephemeral", ttl:"1h"}` on the last system/tool block. Volatile content (a11y snapshots, task text) goes *after* the breakpoint. Verify `usage.cache_read_input_tokens > 0`. 1h TTL matches long sessions. Never interpolate timestamps/IDs into the system prefix.
- **Streaming**: use `messages.stream()` (large `max_tokens`); stream assistant text to the Side Panel via `setState`/broadcast for live "what the agent is doing" UX.
- **Write-action classification** (`isWriteAction`): `navigate` to a new origin, `click`/`type`/`key` are write-ish; `snapshot`/`get_tabs`/`wait` are read-only. v1: gate `click`/`type`/`key`/`submit`; allow reads freely. Autonomous mode + per-origin allowlist relax this (D8).

## Coordination layer — `apps/backend/src/agent.ts` + `coordinator-cf.ts`

- `BrowserSessionAgent extends Agent` (from `agents`). One instance per user: route `wss://.../agent/:userId` via `routeAgentRequest`. This *is* your multi-user isolation (Q3) — `Agent:alice` and `Agent:bob` are separate Durable Objects with separate state and separate extension connections.
- `onConnect` — verify auth token (D-auth) before accepting; on failure close with 1008.
- `onMessage(event)` — parse+validate protocol `Event`; if it's an `*_result`/`pong`, resolve the pending map; if it's `hello`, record tabs; if it drives the loop forward, invoke `agent-core`.
- `SessionCoordinator` (interface in `agent-core`, impl in `coordinator-cf.ts`):
  ```ts
  interface SessionCoordinator {
    send(cmd: Command): Promise<Event>;          // WS send + await matching commandId
    requestApproval(action: ToolUse): Promise<"allow" | "deny">;   // HITL pause/resume
    setStatus(s: SessionStatus): void;            // → this.setState (SQLite + broadcast to UI)
  }
  ```
  CF impl: `send` writes to the WS and parks a resolver in an in-memory `Map`; **also persist the "awaiting commandId" marker via `this.setState`** so that if the DO hibernates mid-command, on wake it knows a command was outstanding and can re-request a snapshot rather than deadlock. HITL uses the same park/resume, with the pending approval mirrored to state so the Side Panel can render the prompt and the user's `approve`/`deny` event resumes the loop.
- **Scheduling** (`this.schedule`): optional in v1; enables "re-check this page in 1h" / retry-with-backoff without external cron.
- **D4-alt (raw DO)**: replace `extends Agent` with `extends DurableObject`, hand-write `fetch`+`acceptWebSocket`+`webSocketMessage`, and replace `setState` with `ctx.storage` + manual broadcast. `agent-core` and the coordinator interface are unchanged.

## Auth & multi-user (`apps/backend/src/auth.ts`)

- Users authenticate out-of-band (your product's login) and the extension is provisioned a **per-user token** (JWT or opaque, stored in `chrome.storage`). Extension sends it on WS connect (`?token=` or first-message auth).
- Backend verifies (JWT: verify signature + `sub`=userId + expiry; opaque: KV lookup). The verified `userId` selects the Agent instance — a user can only reach their own DO.
- Secrets (Anthropic API key, JWT signing key) via Wrangler secrets / bindings — never in the extension. The extension never sees the Anthropic key; all LLM calls are backend-side.

## Security model (must-haves, not optional)

1. **The agent acts as the logged-in user.** HITL approval on write-actions is the primary control (D8). Ship it in v1; do not defer.
2. **Per-user isolation** via one DO per `userId`; auth-gate `onConnect`. No cross-user command routing.
3. **Anthropic key stays server-side.** Extension ↔ backend is the only channel; the key lives in Worker secrets.
4. **CDP is powerful** — the extension can drive anything in the tab. Scope which tabs it will attach to (a task targets one designated tab; don't auto-attach to all). Surface the "being debugged" banner as expected, not a bug.
5. **Prompt-injection awareness**: page content (a11y text) is *untrusted input* to the LLM. A malicious page can try to steer the agent ("ignore instructions, transfer funds"). Mitigations: HITL on writes, a system-prompt boundary treating page text as data not instructions, and an allowlist of origins the agent may act on. Document this as a known residual risk.
6. **No dialogs**: avoid triggering `alert`/`confirm`/`prompt` via automation — they block the CDP channel. If a page raises one, handle via CDP `Page.handleJavaScriptDialog`.

## Out of scope for v1 (looks in-scope; intentionally excluded)

- **Node self-host backend** — kept *possible* (portable core + interface), not *built*. Add as `apps/backend-node` when there's a concrete user for it.
- **Firefox / Safari** — excluded by D3.
- **Content-script fallback / hybrid driver** — v1 is pure CDP (D2). Hybrid is a later evolution.
- **Fully autonomous multi-tab orchestration** — v1 operates on one designated tab with HITL. Multi-tab and autonomous mode are follow-ups.
- **Cloudflare Browser Rendering / Managed Agents** — architecturally wrong for this problem (no user session); never in scope.
- **Stagehand (stagehand.dev) / Playwright-based frameworks as a dependency** — Stagehand is a Node/Python + Playwright library that launches/connects to *its own* Chromium (local) or a Browserbase cloud browser; no extension mode, and it cannot run on Cloudflare Workers. It drives a browser it owns, not the user's already-logged-in one, so it fails D1 and D4. The only topology where it fits is a **local Node companion** driving the user's Chrome via `connectOverCDP` (Chrome launched with `--remote-debugging-port`, or a profile copy) — a different product than extension+cloud, kept as **Plan B** if the M0 CDP spike proves painful. *Do* borrow its design: `act`/`extract`/`observe` primitives + accessibility-tree grounding are open source and map onto D7 / `agent-core` / `cdp.ts` — port the approach (adapting CDP calls to `chrome.debugger`), don't depend on the library.

## Milestones (build order — each independently verifiable)

- **M0 — CDP spike (de-risk first).** *Scaffolded → `apps/cdp-spike/` (buildless vanilla-JS MV3 harness, throwaway — the real extension is M2 in `apps/extension`).* Attaches `chrome.debugger`, and its "Probe CDP surface" button reports OK/FAIL for `Accessibility.getFullAXTree`, `DOM.getDocument`/`getBoxModel`, `Runtime.evaluate`, `Input.dispatchMouseEvent`, `Page.captureScreenshot`, `Target.getTargets`. **Goal: confirm the allowed CDP command surface** and that ref→backendNodeId→click works. This is the single biggest technical risk. Load unpacked in Chromium to run it (`apps/cdp-spike/README.md`).
- **M1 — Protocol package.** `packages/protocol` with zod schemas + types. No runtime yet; unit-test round-trip validation.
- **M2 — Extension driver.** SW holds a WS to a stub server; `cdp.ts` implements `snapshot`/`click`/`type`/`navigate`; command router maps protocol → CDP. Verify by driving a real logged-in page from `wscat`-style scripted commands. Add 20–25 s keepalive + `chrome.alarms` backstop. Manifest (`manifest_version: 3`) permissions: **`debugger`** (the one that gates CDP attach — easy to miss), `tabs`, `activeTab`, `storage`, `sidePanel`, `alarms`, `offscreen` (backstop connection), plus `host_permissions` for the origins the agent may act on.
- **M3 — Backend skeleton.** Hono + Agents SDK `BrowserSessionAgent`; `routeAgentRequest`; echo/loopback the protocol; `setState` reflected in a trivial Side Panel. Auth stub.
- **M4 — Agent loop.** `agent-core` manual tool-use loop against Claude; `BROWSER_TOOLS` (strict); prompt caching; wire `coordinator-cf`. End-to-end: type a task in the Side Panel → agent reads page → proposes action → executes → loops.
- **M5 — HITL + auth + multi-user.** Approval gate on writes; real per-user token; one-DO-per-user verified with two users. Hibernation-resume correctness (kill DO mid-loop, confirm no deadlock).
- **M6 — Hardening.** Prompt-injection boundary, origin allowlist, dialog handling, error/timeout paths on every command, GIF/session logging for audit.

## Verification

- **Unit**: protocol zod round-trips (`packages/protocol`); `isWriteAction`; a11y-tree pruning/ref-assignment (`cdp.ts` with recorded CDP fixtures).
- **Backend**: `vitest` with `@cloudflare/vitest-pool-workers` for the DO/Agent (WS connect, state persistence across simulated hibernation, pending-map resume).
- **Extension**: `wrangler dev` backend + load unpacked extension in Chromium; scripted end-to-end against a controlled logged-in test page.
- **"Done" for v1** = M5 green: from the Side Panel, drive a real logged-in site through a multi-step task (read → decide via Claude → act) with approval gating on writes, surviving a mid-task DO hibernation, isolated per user.
- **Quality gate before merging any non-trivial change** (per project policy): parallel `quality-reviewer` + `architect` + independent QA subagents; fix and re-run any lane that flags.

## Reuse map (don't re-create)

- **Coordination primitives**: Cloudflare Agents SDK (`agents`) — WS/state/schedule/HITL. Do not hand-roll unless taking D4-alt.
- **Element targeting pattern**: mirror Playwright / `chrome-devtools-mcp` ARIA-snapshot+ref approach; the `mcp__claude-in-chrome__*` tools in this environment are a live reference implementation of the whole concept.
- **LLM loop**: Anthropic TS SDK manual tool-use loop (see `claude-api` skill patterns); do not reinvent streaming/caching.
- **Extension framework**: WXT (manifest gen, cross-context messaging, HMR) — don't hand-assemble MV3 plumbing.

## Appendix: reference patterns to build from (known-good shapes)

**Agents SDK WS + state (backend):**
```ts
import { Agent, routeAgentRequest } from "agents";
export class BrowserSessionAgent extends Agent<Env, SessionState> {
  onConnect(conn, ctx) { /* verify token from ctx.request; else conn.close(1008) */ }
  async onMessage(conn, raw) {
    const ev = Event.parse(JSON.parse(raw));        // zod
    if (ev.type.endsWith("_result") || ev.type === "pong") return this.resolvePending(ev);
    /* else drive agent-core */
  }
  // this.setState(...) auto-persists to SQLite + broadcasts to Side Panel
}
export default { fetch: (req, env) => routeAgentRequest(req, env) /* + Hono for non-agent routes */ };
```

**CDP click via ref (extension):**
```ts
// resolve ref → backendNodeId (from current snapshot map)
const { model } = await cdp("DOM.getBoxModel", { backendNodeId });
const [x, y] = centerOf(model.content);
await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
```

**Claude tool-use step (agent-core):**
```ts
const resp = await client.messages.create({
  model: "claude-opus-4-8",
  max_tokens: 8000,
  thinking: { type: "adaptive" },
  output_config: { effort: "high" },
  system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral", ttl: "1h" } }],
  tools: BROWSER_TOOLS,                 // strict:true each; cache_control on last tool
  messages,                            // growing history; a11y snapshot as latest user block
});
// stop_reason "tool_use" → dispatch via coordinator; "end_turn" → step complete
```

**Notes for a fresh session executing this plan:** line numbers do not exist yet (greenfield). Locate all edits by file + symbol from the repo layout above. Re-confirm the `chrome.debugger` allowed-CDP-command surface at M0 before committing to any CDP command not listed in the targeting section — it is the only assumption here that could force a design change.
