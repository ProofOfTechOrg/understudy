# understudy

A governed **browser-execution service** that puppets a user's *already-logged-in* browser
via a Chromium extension. The Cloudflare-hosted service holds the live sessions and exposes
`POST /v1/sessions/:sessionId/commands`; the extension executes each command in the user's
real tab via CDP and reports back. understudy runs **no LLM** — the agent brain and all
governance (approvals, RBAC, audit via breakwater/flowsafe) live in the consumer apps that
drive it over HTTP (Topology 1).

**Full design + build plan: [`docs/technical-plan.md`](docs/technical-plan.md).** Read it first.

## Layout (current scaffold — milestones M0–M4)

- **`packages/protocol`** — the shared command/event protocol (TypeScript + zod 4, published
  `@understudy/protocol`). The stable contract between the service, the extension, and
  consumer connectors; the core IP.
- **`packages/connector`** — **M4** the reference `@proofoftech/breakwater` connectors
  (`@understudy/connector`): `observe` / `act` / `fill_credential`, approval-gated via
  flowsafe grants, egress-pinned to the service host. What consumer apps import to turn
  browser actions into governed Mastra tools. See its README.
- **`apps/cdp-spike`** — **M0** throwaway harness: a buildless MV3 extension that verifies the
  `chrome.debugger` CDP command surface (the plan's one gating technical risk). See its README.
- **`apps/extension`** — **M2** the real extension: a WXT + React MV3 extension that puppets a
  logged-in Chromium tab over a WebSocket. See its README.
- **`apps/backend`** — **M3** the browser-execution service: a Cloudflare Worker (Hono) plus one
  Agents-SDK Durable Object per session, terminating the extension's WebSocket and exposing
  `POST /v1/sessions/:id/commands` for consumer apps (metamind, smart-compliance) to drive. Runs
  no LLM and embeds no agent framework — the brain and governance (breakwater/flowsafe) live in
  the consumers. See its README.

M4 status: `@understudy/protocol@0.5.0` and `@understudy/connector@0.3.0` are
published on npm. Metamind contains the cross-repository Mastra workflow,
flowsafe approval gate, breakwater browser connectors, and attended runbook.
The remaining M4 step is running that proof with a connected Chromium
extension. The agent loop and governance stay in the consumer, per Topology 1.

## Develop

```sh
pnpm install
pnpm build       # first on a fresh clone: @understudy/* resolve via gitignored dist/
pnpm typecheck
pnpm test
```

Requires Node ≥22 and pnpm ≥10.16 (see `package.json`). Dependencies are quarantined for
7 days via `minimumReleaseAge` in `pnpm-workspace.yaml` (supply-chain guard against
freshly-published malicious versions; first-party `@proofoftech/*` packages are exempt).

## Release (npm)

Changesets and GitHub Actions manage releases from `master`; see
`.changeset/README.md`. A pull request that changes a published package adds a
changeset with `pnpm changeset`. The release workflow opens or updates the
“Version Packages” pull request, then publishes the approved versions with npm
provenance. The repository secret `NPM_TOKEN` needs publish access to the
`@understudy` scope.

The M0 harness needs no build — load `apps/cdp-spike` unpacked in a Chromium browser
(`apps/cdp-spike/README.md`).
