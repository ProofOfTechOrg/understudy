# understudy

An LLM-driven system that puppets a user's *already-logged-in* browser via a Chromium
extension, coordinated by a Cloudflare-hosted backend brain. The backend never touches a
browser — it sends *intents* over a WebSocket; the extension executes them in the user's
real tab via CDP and reports back.

**Full design + build plan: [`docs/technical-plan.md`](docs/technical-plan.md).** Read it first.

## Layout (current scaffold — milestones M0 + M1 + M2 + M3)

- **`packages/protocol`** — the shared command/event protocol (TypeScript + zod 4, published
  `@understudy/protocol`). The stable contract between backend and extension; the core IP.
- **`apps/cdp-spike`** — **M0** throwaway harness: a buildless MV3 extension that verifies the
  `chrome.debugger` CDP command surface (the plan's one gating technical risk). See its README.
- **`apps/extension`** — **M2** the real extension: a WXT + React MV3 extension that puppets a
  logged-in Chromium tab over a WebSocket. See its README.
- **`apps/backend`** — **M3** the browser-execution service: a Cloudflare Worker (Hono) plus one
  Agents-SDK Durable Object per session, terminating the extension's WebSocket and exposing
  `POST /v1/sessions/:id/commands` for consumer apps (metamind, smart-compliance) to drive. Runs
  no LLM and embeds no agent framework — the brain and governance (breakwater/flowsafe) live in
  the consumers. See its README.

Coming next per the plan: **M4** — consumer integration + published contract
(`@understudy/protocol` plus a reference `@understudy/connector`); the agent loop and
governance (breakwater/flowsafe) stay consumer-side, per Topology 1.

## Develop

```sh
pnpm install
pnpm test        # protocol round-trip / validation tests
pnpm typecheck
pnpm build
```

Requires Node ≥22 and pnpm ≥10.16 (see `package.json`). Dependencies are quarantined for
7 days via `minimumReleaseAge` in `pnpm-workspace.yaml` (supply-chain guard against
freshly-published malicious versions).

The M0 harness needs no build — load `apps/cdp-spike` unpacked in a Chromium browser
(`apps/cdp-spike/README.md`).
