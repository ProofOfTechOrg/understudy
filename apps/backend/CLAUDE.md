# Backend contributor map

The backend is a Hono Cloudflare Worker with Durable Objects for accounts, devices, tenants, sessions, and Model Context Protocol (MCP) connections.

## Primary files

| Path | What | When to read |
| --- | --- | --- |
| `README.md` | Backend topology, contracts, security invariants, configuration, and deployment procedures | Understanding backend behavior, configuring environments, or deploying the Worker |
| `src/index.ts` | Hono routes, OAuth delegation, agent gate, HSTS, and `/health` provenance | Adding routes, changing middleware, or debugging Worker entrypoint behavior |
| `src/api/sessions.ts` | Shared session admission, status, command, and close service layer | Changing `/v1/sessions` behavior or command polling |
| `src/account-directory.ts` | Users, auth epochs, dashboard sessions, devices, origin policy, direct pairing, `usk_v2` tokens, and OAuth metadata | Changing account identity, pairing, policy, tokens, or OAuth records |
| `src/account-agent.ts` | Per-account MCP binding, device fence, generation-scoped refs, and command serialization | Changing MCP session authority, semantic bindings, or command ordering |
| `src/tenant-coordinator.ts` | Device inventory, capacity, leases, suspension/adoption, policy acknowledgements, and orphan cleanup | Changing allocation, recovery, policy convergence, or cleanup |
| `src/device.ts` | Authenticated device-control socket and provision/close/policy/inventory frames | Changing device frames, connection authority, or inventory handling |
| `src/session.ts` | Session connection, browser events, command results, write replay, and attended detach incarnation | Changing command execution, result durability, or attended lifecycle |
| `src/auth.ts` | Caller authentication, HMAC session ownership, `udt_v2` device credentials, and connect tickets | Changing credentials, session ownership, or WebSocket tickets |
| `src/dashboard/app.ts` | Sign-in, CSRF, direct pairing, policy, browser-bound tokens, OAuth grants, and revocation | Changing dashboard actions, authentication, policy, or consent |
| `src/dashboard/pages.ts` | Nonce-bearing dashboard, consent, privacy, and onboarding HTML | Changing dashboard rendering, content security policy, or onboarding copy |
| `src/mcp/tools.ts` | Protocol-3 browser tools and fixed local-card contracts | Adding or changing MCP tools, schemas, or tool guidance |
| `src/mcp/props.ts` | Current OAuth/token props: device, auth epoch, and contract version | Changing MCP credential claims or connection state |
| `src/mcp/static-auth.ts` | `usk_v2` request authentication with current device/epoch validation | Changing static MCP authentication or revocation behavior |
| `src/validation.ts` | Bounded strict input and exact-origin canonicalization | Adding request validation or changing origin handling |
| `src/types.ts` | Worker bindings and cross-module state/outcome types | Changing bindings or shared backend contracts |
| `wrangler.jsonc` | Durable Object/KV bindings, migrations, secrets, and version metadata | Changing Cloudflare resources, migrations, environments, or deployment metadata |
| `worker-configuration.d.ts` | Generated runtime and binding types | Reviewing generated bindings after `wrangler types` |
| `scripts/deploy-target.sh` | Branch-gated staging/routine-production deployment, active-version verification, and evidence | Changing automated deployment or debugging deployment evidence |
| `scripts/deploy-production.sh` | Manual compatibility cutover from current `origin/master`, guarded secret uploads, and recovery evidence | Running or changing a compatibility cutover |
| `production-compatibility.json` | Hash-locked contract that routine production deployment must preserve | Changing the production compatibility boundary or deployment gate |

## Verification

```bash
pnpm --filter @understudy/backend typecheck
pnpm --filter @understudy/backend test
cd apps/backend
pnpm exec wrangler types --check
pnpm exec wrangler deploy --dry-run --env ""
pnpm exec wrangler deploy --dry-run --env staging
```

Tests are grouped by source name. `dashboard-auth.test.ts` owns the complete Dynamic Client Registration (DCR) to strict Proof Key for Code Exchange (PKCE) to consent to MCP flow and grant revocation. `coordinator.test.ts` owns provisioning, policy acknowledgement, suspension, adoption, physical divergence, and orphan behavior. `mcp-tools.test.ts` owns the tool catalog, untrusted page output, ref generation, and retired-tool rejection.
