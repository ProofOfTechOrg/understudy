<!-- Content type: Reference -->

# Use the Understudy protocol

`@understudy/protocol` is the strict Zod 4 contract shared by the Understudy Worker, Manifest V3 extension, and consumer connectors. Version 0.7.0 adds protocol 2 command safety, unattended devices and sessions, durable status polling, dialog acknowledgements, and bounded inputs.

## Install the package

```bash
pnpm add @understudy/protocol zod
```

The package uses no platform APIs and runs anywhere Zod 4 runs.

## Negotiate protocol 2

A protocol-2 extension sends:

```typescript
import {
  PROTOCOL_CAPABILITIES,
  PROTOCOL_VERSION,
  type Event,
} from "@understudy/protocol";

const hello: Event = {
  type: "hello",
  protocolVersion: PROTOCOL_VERSION,
  capabilities: [...PROTOCOL_CAPABILITIES],
  browser: navigator.userAgent,
  extVersion: "0.1.0",
  tabs: [ownedTab],
};
```

A legacy `hello` without `protocolVersion` is protocol 1. Safe writes require the `safe-write-v2` capability.

## Parse command requests

The HTTP request body is strict. Unknown fields and values such as `{ "dryRun": "true" }` fail validation.

```typescript
import { CommandRequestSchema } from "@understudy/protocol";

const request = CommandRequestSchema.parse(await response.json());
const dryRun = request.dryRun ?? false;
```

The HTTP layer must enforce `COMMAND_HTTP_BODY_MAX_BYTES` before JSON parsing. WebSocket layers must enforce `DEVICE_CONTROL_FRAME_MAX_BYTES` and `SESSION_RESULT_FRAME_MAX_BYTES` before parsing.

## Classify commands

Commands use a discriminated union:

| Command | Class |
|---|---|
| `snapshot`, `get_tabs`, `wait`, `resolve_ref` | Read |
| `click`, `type`, `fill_secret`, `key`, `navigate`, `scroll`, `switch_tab` | Write |

Use `isWriteCommand` or `WRITE_COMMAND_TYPES` instead of maintaining another classification.

`resolve_ref` is internal. Consumers express simulation with `{ command, dryRun: true }`.

Accessibility refs are opaque capabilities. They bind to one extension session, tab attachment, and snapshot generation. Do not parse or reuse them after navigation, attachment replacement, or browser restart.

## Handle write frames

Protocol 2 uses a prepare and grant handshake:

```text
write_prepare -> write_ready -> write_grant -> command_result -> result_ack
```

`write_prepare` contains metadata only. The backend persists the grant before sending `write_grant`. The extension persists `started` before its first browser-visible operation.

Every frame is fenced by attempt and deadline. Unattended frames also bind lease ID, lease epoch, and browser epoch.

The guarantee is at-most-once execution with explicit pending and unknown outcomes. It is not exactly-once external outcome delivery.

## Poll command outcomes

`PendingCommandResponseSchema` validates HTTP `202`:

```json
{
  "commandId": "command_123",
  "status": "pending",
  "statusUrl": "https://service.example/v1/sessions/session_123/commands/command_123",
  "retryPolicy": "poll_same_command"
}
```

`CommandStatusResponseSchema` validates polling responses. `safeToRetry` is false for granted work without a proven terminal result.

## Use device-control frames

`DeviceControlClientFrameSchema` validates device hello, heartbeat, provision acknowledgement, closure confirmation, and provisioning failure frames. `DeviceControlServerFrameSchema` validates provision, close, reconnect ticket, closure acknowledgement, and credential-revocation frames.

Device control never carries consumer commands or vaulted plaintext.

## Confirm session closure

Session closure uses a reciprocal acknowledgement:

```text
persist closed -> send closed -> confirm backend lifecycle -> closed_ack
```

The device retains each `closed` record until it receives a `closed_ack` with the exact session, lease, lease epoch, and browser epoch. It resends unacknowledged records after reconnects. The backend accepts an exact replay after a successful closure, but it never acknowledges a missing, stale, mismatched, or lost lease.

Deploy the backend before the extension. An older extension ignores the additive `closed_ack` frame. A newer extension connected to an older backend retains the closure record and does not promote a staged profile.

## Handle terminal WebSocket closes

The package exports two application close codes:

| Export | Code | Meaning |
|---|---:|---|
| `WS_CLOSE_REPLACED` | `4001` | A newer extension connection replaced this connection |
| `WS_CLOSE_SESSION_TERMINAL` | `4003` | The backend retired the session permanently |

Clients must cancel reconnect state before invoking their close handler for either code. Code `4001` is terminal for that extension instance. Code `4003` also stops command admission and detaches local browser control.

## Deliver dialogs

Every `dialog` record includes `dialogId` and `occurredAt`. The server answers with `dialog_ack`. The extension can replay unacknowledged records within the same browser epoch while the server deduplicates them.

## Enforce limits

The schemas enforce:

| Field | Limit |
|---|---|
| IDs | 128 characters |
| Refs and key specifications | 256 characters |
| URLs | 8 KiB |
| `type.text` | 64 KiB |
| `secretRef` | 512 characters |
| `wait.value` | Integer from 0 through 20,000 for `for: "ms"` only |
| Dialog message | 4 KiB |
| Dialog default prompt | 1 KiB |
| Browser user agent | 512 characters |
| Extension version | 64 characters |
| Accessibility tree | 5,000 nodes, depth 64 |
| Accessibility name or value | 4 KiB |
| Session-owned tabs | One |

Schemas reject oversized values. Transport code rejects oversized frames before durable mutation and closes oversized WebSockets with code `1009`.

## Main exports

The package exports:

- Command, event, HTTP request, status, device, session, and frame schemas
- `parseCommand`, `parseEvent`, and safe parser variants
- Protocol version and capabilities
- Terminal WebSocket close codes
- Command classification helpers
- Byte and tree limits
- TypeScript types inferred from every public schema

See [`src/index.ts`](src/index.ts) for the exhaustive export surface.

## Version history

- **0.7.0**: protocol 2, unattended status and control frames, strict bounds, durable command polling, and dialog acknowledgement
- **0.6.0**: target-bound snapshots and accessibility refs
- **0.5.0**: dialog events
- **0.4.0**: shared write classification
- **0.3.0**: internal `resolve_ref`
- **0.2.0**: `fill_secret` and simulated action results
