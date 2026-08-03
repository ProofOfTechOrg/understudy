<!-- Content type: Landing -->

# Run governed browser commands in user-controlled Chromium

Understudy is a model-free browser-execution service. A Cloudflare Worker coordinates attended and unattended sessions while an installed Manifest V3 extension executes commands through the Chrome DevTools Protocol (CDP). Consumer applications own model execution, approvals, role-based access control, policies, and durable audit through breakwater and flowsafe.

Read [`docs/technical-plan.md`](docs/technical-plan.md) for the architecture, safety contract, limits, and rollout gates.

## Explore the repository

| Path | Purpose |
|---|---|
| `packages/protocol` | Published Zod 4 command, event, control-frame, and status contracts |
| `packages/connector` | Published Breakwater connectors for browser observation and governed non-secret actions |
| `apps/backend` | Hono Worker, session and device Agents, tenant coordinator, quotas, and telemetry |
| `apps/extension` | WXT and React extension with attended control, two-session unattended hosting, and a local payment-card vault |
| `apps/cdp-spike` | Historical Manifest V3 CDP capability harness |

`@understudy/protocol@0.8.0` and `@understudy/connector@0.5.1` are the current published versions. The pending coordinated changeset releases protocol 0.9.0 and connector 0.6.0; a local build does not publish them.

## Understand the isolation boundary

An unattended device is one tenant-dedicated Chrome profile with capacity for two extension-owned tabs. Those tabs have separate command, CDP, ref, and lifecycle state, but share cookies and browser storage.

Understudy never:

- Uses a Cloudflare-managed browser
- Automatically attaches an existing tab for unattended work
- Restores old URLs or tasks after restart
- Replays a granted write with an unproven result
- Records video, GIF, Document Object Model history, or session content
- Replaces consumer approval or durable audit

Protocol 3 provides at-most-once write execution with explicit pending and unknown outcomes. It removes the cloud secret oracle. Payment cards remain encrypted inside the extension and are submitted through a dedicated sensitive boundary that returns no page-derived result.

## Develop the repository

Requirements:

- Node 22 or newer
- pnpm 11.5.2
- Chrome 125 or newer for production extension verification

Run:

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test
```

Dependencies use a 7-day minimum release age through `pnpm-workspace.yaml`. First-party `@proofoftech/*` packages are exempt.

For the production extension:

```bash
pnpm --filter @understudy/extension build
pnpm --filter @understudy/extension test:e2e
```

Load `apps/extension/.output/chrome-mv3/` through `chrome://extensions`. Follow the [real-Chromium acceptance runbook](apps/extension/RUNBOOK.md).

## Release published packages

Use `dev` as the integration branch and `master` as the default release branch. Target feature and fix pull requests at `dev`. Add a changeset when a pull request changes a published package:

```bash
pnpm changeset
```

The Version workflow opens or updates the `Version Packages` pull request against `dev`. Release an approved version in this order:

1. Merge `Version Packages` into `dev`.
2. Verify the versioned `dev` commit.
3. Open and merge a promotion pull request from `dev` to `master`.

The Release workflow publishes the promoted versions with npm provenance. It rejects `master` commits that contain pending changesets. If another changeset reaches `dev` before promotion, merge the regenerated `Version Packages` pull request and update the promotion.

Do not merge `master` back into `dev`. `NPM_TOKEN` needs publish access to the `@understudy` scope.

The Deploy workflow updates staging after every `dev` push. After the one-time protocol-3 cutover, it updates production after every `master` push. Production deployment first rebuilds the store extension and requires its normalized contents to match `apps/extension/store-release.json` in the `published` state.

Use the guarded production wrapper for the first protocol-3 cutover and any later compatibility-contract change. It validates the protocol-3 device map, published extension, canary credential, immutable source snapshot, Worker provenance, and deployment evidence. Follow the [production rollout runbook](docs/unattended-production-rollout.md).

## Preserve attended proof history

The completed attended design and production proof remain in Git at Understudy `master@797d0e489df2772d0f5d597141982547861881bb` and Metamind `master@0814deb`. Attended mode remains compatible in the current extension and API.
