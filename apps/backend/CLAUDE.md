# Backend contributor map

The backend is a Hono Cloudflare Worker with Durable Objects for accounts,
devices, tenants, sessions, and MCP connections. Protocol 3 has no server-side
secret vault or generic credential-fill path.

## Primary files

| Path | Responsibility |
| --- | --- |
| `src/index.ts` | Hono routes, OAuth delegation, agent gate, HSTS, and `/health` provenance |
| `src/api/sessions.ts` | Shared session admission, status, command, and close service layer |
| `src/account-directory.ts` | Users, auth epochs, dashboard sessions, devices, versioned origin policy, direct pairing offers, `usk_v2` tokens, OAuth connection metadata |
| `src/account-agent.ts` | Per-account MCP binding, device fence, generation-scoped refs, command serialization |
| `src/tenant-coordinator.ts` | Device inventory, capacity, leases, suspension/adoption, policy acknowledgements, orphan cleanup |
| `src/device.ts` | Authenticated device-control socket and provision/close/policy/inventory frames |
| `src/session.ts` | Session connection, browser events, command results, write replay, attended detach incarnation |
| `src/auth.ts` | Caller auth, HMAC session ownership, `udt_v2` device credentials, connect tickets |
| `src/dashboard/app.ts` | Sign-in, CSRF, direct pairing, policy, browser-bound tokens, OAuth grants and revocation |
| `src/dashboard/pages.ts` | Nonce-bearing dashboard, consent, privacy, and onboarding HTML |
| `src/mcp/tools.ts` | Protocol-3 browser tools and fixed local-card contracts |
| `src/mcp/props.ts` | Current OAuth/token props: device, auth epoch, contract version |
| `src/mcp/static-auth.ts` | `usk_v2` request authentication with current device/epoch validation |
| `src/validation.ts` | Bounded strict input and exact-origin canonicalization |
| `src/types.ts` | Worker bindings and cross-module state/outcome types |
| `wrangler.jsonc` | Durable Object/KV bindings, migrations, required secrets, version metadata |
| `worker-configuration.d.ts` | Generated runtime and binding types; refresh with `wrangler types` after config changes |

Pairing offers use the internal `pairing_codes` table name for migration
compatibility; the public interface is direct one-time external messaging, not
code transcription.

## Security invariants

- Every authenticated MCP request revalidates device revocation and current
  `auth_epoch`.
- A normal deploy never advances `auth_epoch`. Only the exact optional
  `AUTH_EPOCH_CUTOVER=protocol-3-auth-hard-cut` maintenance latch applies the
  one-time migration.
- OAuth consent requires a strict 43-character base64url S256 challenge before
  rendering and again before grant completion.
- General origin policy is authoritative per device and versioned. Narrowing
  fences first; additions require extension acknowledgement.
- Page-derived strings are returned only inside untrusted-content delimiters.
- Refs belong to one attachment and snapshot generation; navigation or a newer
  snapshot invalidates them.
- Cloud-vault bindings, upload routes, scripts, keys, and tools do not exist.
- Card plaintext, ciphertext, key material, and masked values never enter this
  application. Only aliases and fixed submission enums cross the extension
  boundary.
- Registration leaves a device allocation-ineligible until its hello inventory
  completes heartbeat-equivalent reconciliation.
- The HSTS middleware covers success, redirects, errors, well-known metadata,
  OAuth, MCP, dashboard, and `/v1` routes.

## Operations

Use `scripts/deploy-production.sh` with four absolute out-of-repository paths:
new evidence, protocol-3 `DEVICE_TOKENS` JSON, the published extension ID, and
the canary device credential. The three inputs must be mode 0600. The script
validates the static-device schema and canary digest, rejects a dirty tree,
performs Wrangler dry-run, asks for explicit secret-upload and deployment
confirmation, hash-locks the uploaded bytes to the validated source, tags the
version with the full commit SHA, and requires three
matching `/health` reads before recording provenance.

Never delete legacy vault values, rotate auth epochs, remove Cloudflare secrets,
or alter HSTS/DNS configuration without a fresh maintenance-window confirmation.

## Verification

```bash
pnpm --filter @understudy/backend typecheck
pnpm --filter @understudy/backend test
cd apps/backend
pnpm exec wrangler types --check
pnpm exec wrangler deploy --dry-run
```

Tests are grouped by the source names above. `dashboard-auth.test.ts` owns the
full DCR → strict PKCE → consent → MCP flow and grant revocation.
`coordinator.test.ts` owns provisioning, policy acknowledgement, suspension,
adoption, physical divergence, and orphan behavior. `mcp-tools.test.ts` owns the
tool catalog, untrusted page output, ref generation, and retired-tool rejection.
