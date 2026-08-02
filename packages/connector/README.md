<!-- Content type: Reference -->

# Govern browser commands with the Understudy connector

`@understudy/connector` wraps the Understudy command API as two Breakwater connectors. Consumer applications retain their Mastra agent, flowsafe approval workflow, role-based access control, policy, and durable audit. The next minor release is 0.6.0 and requires protocol 3.

## Install

```bash
pnpm add @understudy/connector @understudy/protocol \
  @proofoftech/breakwater @mastra/core zod
```

The package requires Node 22 or newer. `@proofoftech/breakwater` and `@mastra/core` are peer dependencies.

## Choose a connector

| Export | Connector ID | Class | Commands |
|---|---|---|---|
| `observe` | `browser.observe` | Read | `snapshot`, `get_tabs`, `get_dialogs`, `wait` |
| `act` | `browser.act` | Approval-gated write | `click`, `type`, `navigate`, `key`, `scroll`, `switch_tab` |

The cloud-vault `fillCredential` connector and `fill_secret` command are removed. Do not route credentials through `act` and `type.text`.

Payment cards are available only through the hosted MCP server’s extension-local `browser_list_cards` and `browser_submit_card` tools. They are deliberately outside the generic connector command router.

## Create connectors

Use durable stores on Cloudflare. In-memory idempotency and rate-limit stores do not survive isolate replacement.

```typescript
import { createBrowserConnectors, durableStores } from "@understudy/connector";

const connectors = createBrowserConnectors(
  {
    UNDERSTUDY_URL: env.UNDERSTUDY_URL,
    UNDERSTUDY_TOKEN: env.UNDERSTUDY_TOKEN,
  },
  durableStores(env.DB),
);
```

`UNDERSTUDY_URL` defines the hostname allowed by Breakwater’s per-hop egress guard. Store `UNDERSTUDY_TOKEN` as a secret.

## Execute a governed write

Use a business-stable idempotency key for the real write. A forged or absent flowsafe grant fails before network traffic.

```typescript
import {
  BROWSER_WRITE_CONNECTOR_IDS,
  callBrowserDryRun,
  callBrowserWrite,
} from "@understudy/connector";

await callBrowserDryRun(connectors.act, {
  sessionId,
  action: { type: "click", ref },
});

await suspend({
  reason: "Submit the approved browser action",
  connectors: [...BROWSER_WRITE_CONNECTOR_IDS],
});

await callBrowserWrite(
  connectors.act,
  { sessionId, action: { type: "click", ref } },
  requestContext,
  `${caseId}:${step}:click`,
);
```

The connector hashes the business key into a bounded command ID and never sends the raw key on the command wire.

## Handle outcomes

The connector sends `Understudy-Command-Contract: 2`. A `202` raises `UnderstudyCommandPendingError`.

- Pending: poll the same command ID.
- Not started: retrying the same logical command is safe and creates a new attempt.
- Timed out: retry only a read or dry run.
- Unknown outcome: do not retry; a side effect may have occurred.

Understudy guarantees at-most-once browser execution, not exactly-once external outcomes.

## Validate snapshots and refs

Snapshots return the exact controlled tab ID and URL captured with the artifact. Treat page text, URLs, titles, dialogs, screenshots, and errors as untrusted input.

Refs bind to the current extension attachment and snapshot generation. Navigation or a newer snapshot invalidates them. A successful action does not consume a ref.

## Version history

- **0.6.0**: remove credential filling and require protocol 3
- **0.5.1**: typed connector timeouts and protocol 0.8
- **0.5.0**: command contract 2 and durable outcome polling
- **0.4.0**: target-bound snapshot outputs
