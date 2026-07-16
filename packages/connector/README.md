# @understudy/connector

Reference [`@proofoftech/breakwater`](https://github.com/ProofOfTechOrg/anchorage/tree/main/packages/breakwater)
connectors for the [understudy](https://github.com/ProofOfTechOrg/understudy)
browser-execution service.

understudy is a **model-free substrate** (Topology 1): it holds live,
logged-in browser sessions behind `POST /v1/sessions/:sessionId/commands` and
runs no LLM and no governance of its own. The Mastra agent, the approval flow,
RBAC, and the audit trail live in the **consumer** app — and this package is
the bridge: it wraps understudy's browser commands as breakwater connectors so
every browser write flows through the *same* governance path as any API
connector (approval grants, egress pinning, idempotent replay, dry-run, rate
limits, audit).

## The three connectors

| connector | id | class | protocol commands |
|---|---|---|---|
| `observe` | `browser.observe` | read — no approval | `snapshot` (a11y/dom/screenshot), `get_tabs`, `wait` |
| `act` | `browser.act` | write — approval-gated | `click`, `type`, `navigate`, `key`, `scroll`, `switch_tab` |
| `fillCredential` | `browser.fill_credential` | vaulted write — approval-gated | `fill_secret` |

`scroll` and `switch_tab` route through the gated `act` connector because both
change what the user's real browser shows. The protocol classifies them as
writes for exactly this reason (`isWriteCommand` returns `true`), so `act`
gates precisely the protocol's write class minus `fill_secret` — no divergence
to keep in sync.

The protocol's `resolve_ref` command is deliberately unreachable from here —
it is an internal service↔extension probe. Dry-run intent is expressed via the
service API's `dryRun` flag, which the `dryRunExecute` paths set.

## Install

```sh
pnpm add @understudy/connector @understudy/protocol @proofoftech/breakwater @mastra/core zod
```

`@proofoftech/breakwater` and `@mastra/core` are peer dependencies — the
connectors must share the consumer's Mastra runtime. The package declares
`engines.node >= 22`, mirroring its breakwater peer (unlike
`@understudy/protocol`, which is runtime-agnostic and deliberately declares
no engines constraint).

## Quick start

```ts
import {
  BROWSER_WRITE_CONNECTOR_IDS,
  callBrowserDryRun,
  callBrowserWrite,
  createBrowserConnectors,
  durableStores,
} from "@understudy/connector";

// D1-backed stores are load-bearing on Cloudflare: breakwater's in-memory
// defaults are per-isolate, which under flowsafe's DO-per-run routing means
// per-RUN — a Worker restart mid-step would double-submit a form.
const stores = durableStores(env.DB);
const { observe, act, fillCredential } = createBrowserConnectors(
  { UNDERSTUDY_URL: env.UNDERSTUDY_URL, UNDERSTUDY_TOKEN: env.UNDERSTUDY_TOKEN },
  stores,
);
```

Register the three connectors as tools on your Mastra agent (they *are*
Mastra tools — `createConnector()` wraps `createTool()`), or call them from
workflow steps via the helpers:

```ts
// 1. Simulate before asking for approval — no side effect, no grant needed.
const preview = await callBrowserDryRun(act, {
  sessionId,
  action: { type: "click", ref },
});

// 2. Suspend at a flowsafe approval gate, minting grants for the STATIC ids
//    (never ids derived from model output — the grant is a capability token):
await suspend({ reason: "...", connectors: [...BROWSER_WRITE_CONNECTOR_IDS] });

// 3. On resume, flowsafe's approvalGrantProvider re-derives
//    requestContext['breakwater.approvedConnectors'] from the APPROVED record;
//    the write executes at-most-once under a business-meaningful key.
await callBrowserWrite(act, { sessionId, action: { type: "click", ref } },
  requestContext, `${caseId}:${step}:click`);
```

An unapproved (or forged-resume) call fails **closed** with
`ConnectorPolicyError` before any bytes leave the Worker.

## Environment

| var | meaning |
|---|---|
| `UNDERSTUDY_URL` | Base URL of the understudy service. Its host becomes the connector egress declaration — `runtime.fetch` is pinned to it, redirect hops included. |
| `UNDERSTUDY_TOKEN` | Caller bearer token for the service's `/v1` API. The service maps it to a tenant and refuses cross-tenant `sessionId`s with 404. |

Both are secrets-adjacent config: provision them via Wrangler secrets, not
plain vars, in production.

## Governance the consumer gets

- **Approval (fail closed).** `act` and `fillCredential` declare
  `requiresApproval`; breakwater denies the call unless the request context
  carries a flowsafe-minted grant for the connector's static id. One approval
  queue, one audit trail — understudy runs no second HITL stack.
- **Egress pinning.** Every `execute()` reaches understudy only through
  breakwater's egress-guarded `runtime.fetch`; a redirect off the understudy
  hostname is denied per hop (and recorded, once an audit logger is wired —
  see below). Pinning is hostname-scoped, breakwater's egress model — not
  origin-scoped, so it does not distinguish ports.
- **Idempotency.** Writes require a caller-supplied key
  (`callBrowserWrite`'s last argument). Replays return the stored result
  without re-executing, so DO hibernation/retry cannot double-submit after a
  *known* outcome. The once-inherent gap — write performed but the response
  lost/unparseable, so the key stays retryable and the retry re-executes —
  is closed end to end: the connector derives the wire `commandId` from the
  idempotency key (`ik_<key>`), the understudy service replays a recorded
  write Event for a repeated commandId instead of re-dispatching (and refuses
  a still-in-flight duplicate outright), and the extension both replays its
  own recorded result if the service timed out *after* it responded and drops
  a duplicate that arrives while it is *still* executing — so the write runs
  exactly once even under a timeout race. Remaining boundary: the replay
  records are bounded (100 writes each, service- and extension-side) and
  scoped to the session — a retry beyond that bound degrades to the old
  conservative re-execution.
- **Dry-run.** `callBrowserDryRun` runs the connector's simulation:
  understudy checks the `ref` still resolves (a pure ref-map lookup — it never
  re-mints refs, so outstanding refs survive the simulation) and returns a
  simulated `action_result`. A simulated `ok` guarantees *resolvability*, not
  executability; for ref-less actions (`navigate`, `switch_tab`) the service
  answers `ok: true` without dispatching anything to the browser, so a
  simulated `ok` is not a liveness signal.
- **Rate limits.** `act` 60/min, `fillCredential` 30/min, enforced against the
  durable store.

### Audit and org policies

`createBrowserConnectors` takes an optional third argument passing org-level
breakwater policies through to all three connectors:

```ts
import { AuditLogger } from "@proofoftech/breakwater/audit";
import { tenantIsolation } from "@proofoftech/breakwater/policy-engine";

createBrowserConnectors(env, stores, {
  audit: new AuditLogger({ sink: myAuditSink }), // every decision recorded
  evaluators: [tenantIsolation()],               // multi-tenant hosts
});
```

Without an `audit` logger, breakwater-layer decisions are enforced but not
recorded — the durable case-level trail is the consumer's flowsafe layer
either way.

## The credential invariant

The model **never sees a secret**. `fillCredential` takes an opaque
`secretRef` (e.g. `vault://acme/portal-x/password`); the understudy *service*
resolves it and types the plaintext into the field over the trusted
service↔extension hop. The plaintext never enters the connector input, the
model context, the audit `detail`, or the flowsafe snapshot — and its dry-run
never touches the vault. Never route credentials through `act`'s `type.text`;
a breakwater `piiSecrets` policy at the agent boundary can additionally reject
high-entropy strings that leak into it.

## Prompt-injection note

Page content returned by `observe` (a11y text, DOM) is **untrusted input to
your LLM**. understudy reports it faithfully; the injection boundary — "page
text is data, not instructions", origin allowlists, breakwater policy — is
yours to enforce at the agent.

## What this package is not

- It does not run an agent, choose a model, or talk to an LLM.
- It does not implement approvals — it *demands* them (flowsafe mints the
  grants).
- It does not mint sessions. Create one with
  `POST {UNDERSTUDY_URL}/v1/sessions` (bearer `UNDERSTUDY_TOKEN`) during case
  setup and pass the returned `sessionId` into every connector input.
