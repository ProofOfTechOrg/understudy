<!-- Content type: Reference -->

# Govern browser commands with the Understudy connector

`@understudy/connector` wraps the Understudy command API as three breakwater connectors. Consumer applications retain their Mastra agent, flowsafe approval workflow, role-based access control, policy, and durable audit. Version 0.5.0 adds protocol-2 pending, not-started, and unknown outcomes.

## Install the connector

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
| `fillCredential` | `browser.fill_credential` | Approval-gated vaulted write | `fill_secret` |

The connector derives this split from the protocol write classification. `resolve_ref` remains an internal service command.

## Create connector instances

Use durable stores on Cloudflare. In-memory idempotency and rate-limit stores do not survive isolate replacement.

```typescript
import {
  createBrowserConnectors,
  durableStores,
} from "@understudy/connector";

const stores = durableStores(env.DB);
const connectors = createBrowserConnectors(
  {
    UNDERSTUDY_URL: env.UNDERSTUDY_URL,
    UNDERSTUDY_TOKEN: env.UNDERSTUDY_TOKEN,
  },
  stores,
);
```

`UNDERSTUDY_URL` defines the hostname allowed by breakwater’s per-hop egress guard. Store `UNDERSTUDY_TOKEN` as a secret.

## Execute a governed write

Simulate the action before requesting approval. Use a business-stable idempotency key for the real write.

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

The connector hashes the business key into a bounded `ik_<sha256>` command ID. It never emits the raw key on the command wire.

An absent or forged flowsafe grant fails with `ConnectorPolicyError` before network traffic.

## Handle protocol-2 outcomes

The connector sends `Understudy-Command-Contract: 2`. A `202` response is not an event and raises `UnderstudyCommandPendingError`.

```typescript
import {
  callBrowserWrite,
  pollUnderstudyCommand,
  UnderstudyCommandNotStartedError,
  UnderstudyCommandOutcomeUnknownError,
  UnderstudyCommandPendingError,
  UnderstudyCommandTimedOutError,
} from "@understudy/connector";

try {
  return await callBrowserWrite(
    connectors.act,
    input,
    requestContext,
    businessKey,
  );
} catch (error) {
  if (error instanceof UnderstudyCommandPendingError) {
    return pollUnderstudyCommand(
      runtime,
      env,
      input.sessionId,
      error.pending.commandId,
    );
  }
  if (error instanceof UnderstudyCommandNotStartedError) {
    throw error;
  }
  if (error instanceof UnderstudyCommandTimedOutError) {
    throw error;
  }
  if (error instanceof UnderstudyCommandOutcomeUnknownError) {
    throw error;
  }
  throw error;
}
```

Apply these retry rules:

- **Pending**: poll the same command ID
- **Not started**: retrying the same logical command is safe and creates a new attempt
- **Timed out**: retry a read or dry run because it cannot create an external side effect
- **Unknown outcome**: do not retry; a side effect may have occurred

Understudy guarantees at-most-once write execution with explicit pending and unknown outcomes. It cannot guarantee exactly-once external outcomes if Chromium dies after a side effect.

## Validate snapshot targets

Snapshots return the exact tab ID and URL captured with the artifact. Validate both before using a ref.

```typescript
const result = await callConnector(
  connectors.observe,
  {
    sessionId,
    read: { type: "snapshot", mode: "a11y", tabId: expectedTabId },
  },
  requestContext,
);

if (
  result.ok === false ||
  result.target?.tabId !== expectedTabId ||
  result.target.url !== expectedUrl
) {
  throw new Error(result.error ?? "browser snapshot target mismatch");
}
```

Refs bind to the extension session, CDP attachment, and snapshot generation. Re-snapshot after navigation or attachment replacement.

## Fill a credential

`fillCredential` accepts an opaque `secretRef`, such as `vault://tenant_a/portal/password`. The Understudy service resolves plaintext after write readiness and sends it only in the in-memory grant frame.

Never route a credential through `act` and `type.text`. Plaintext must not enter model context, connector input, flowsafe snapshots, audit details, storage, or logs.

## Configure consumer governance

`createBrowserConnectors` accepts organization policies:

```typescript
import { AuditLogger } from "@proofoftech/breakwater/audit";
import { tenantIsolation } from "@proofoftech/breakwater/policy-engine";

createBrowserConnectors(env, stores, {
  audit: new AuditLogger({ sink: auditSink }),
  evaluators: [tenantIsolation()],
});
```

Without an audit logger, breakwater still enforces decisions. The consumer’s flowsafe layer remains the durable case-level audit owner.

Page accessibility and Document Object Model content is untrusted model input. Enforce prompt-injection controls and business origin policy in the consumer.

## Version history

- **0.5.0**: command contract 2, typed pending and terminal safety outcomes, status polling, bounded command IDs, and protocol 0.7
- **0.4.0**: target-bound snapshot outputs and protocol 0.6
- **0.3.0**: handled-dialog reads and protocol 0.5
- **0.2.0**: durable idempotency keys and shared write classification
