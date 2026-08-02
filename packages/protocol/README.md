<!-- Content type: Reference -->

# Use the Understudy protocol

`@understudy/protocol` is the strict Zod 4 contract shared by the Understudy Worker, Manifest V3 extension, MCP server, and consumer connectors. The next minor release is 0.9.0 and carries wire protocol 3.

## Install

```bash
pnpm add @understudy/protocol zod
```

The package uses no platform APIs and runs anywhere Zod 4 runs.

## Negotiate protocol 3

A current extension sends `protocolVersion: PROTOCOL_VERSION` and all `PROTOCOL_CAPABILITIES` in its session and device hello frames. Protocol 3 is required for self-serve MCP and unattended sessions after the coordinated cutover.

Protocol 1 and 2 may retain non-secret attended reads during transition. The retired `fill_secret` command is rejected on every protocol version.

## Classify commands

| Command | Class |
|---|---|
| `snapshot`, `get_tabs`, `list_cards`, `wait`, `resolve_ref` | Read |
| `click`, `type`, `submit_card`, `key`, `navigate`, `scroll`, `switch_tab` | Write |

Use `isWriteCommand` or `WRITE_COMMAND_TYPES`; do not maintain a second classification. `resolve_ref` is internal.

The HTTP layer must enforce `COMMAND_HTTP_BODY_MAX_BYTES` before parsing. WebSocket layers must enforce `DEVICE_CONTROL_FRAME_MAX_BYTES` and `SESSION_RESULT_FRAME_MAX_BYTES` before parsing.

## Use accessibility refs

Refs are opaque capabilities valid for the current browser attachment and snapshot generation. Navigation, a newer snapshot, attachment replacement, or browser restart invalidates them. A ref is not consumed by a successful action and must not be parsed as a selector.

## Submit a local card

The extension-local vault exposes only these protocol-3 commands:

```typescript
type ListCards = {
  type: "list_cards";
  commandId: string;
};

type SubmitCard = {
  type: "submit_card";
  commandId: string;
  cardAlias: string;
  numberRef: string;
  expiry:
    | { kind: "combined"; ref: string }
    | { kind: "split"; monthRef: string; yearRef: string };
  cvvRef: string;
  cardholderNameRef?: string;
  submitRef: string;
};
```

Aliases match `[A-Za-z0-9._-]` and are 1–64 characters. Local enrollment also refuses aliases containing card-number digit runs.

`cards_result` returns aliases and locally approved exact origins. It never returns a PAN, masked PAN, expiration, CVV, cardholder name, ciphertext, or key material.

`card_submission_result` is fixed:

```typescript
{
  status: "not_started" | "outcome_unknown";
  reason:
    | "card_not_found"
    | "origin_not_approved"
    | "stale_ref"
    | "invalid_mapping"
    | "input_failed"
    | "submission_attempted";
}
```

`not_started` means no card byte may have been inserted. Once insertion may have begun, the result is `outcome_unknown`; callers must not retry automatically or infer payment approval.

## Handle write frames

Protocol 3 retains the durable write handshake:

```text
write_prepare -> write_ready -> write_grant -> command_result -> result_ack
```

The backend persists the grant before sending it. The extension persists `started` before its first browser-visible operation. Every unattended frame binds attempt, deadline, lease ID, lease epoch, and browser epoch.

The guarantee is at-most-once browser execution with explicit pending and unknown outcomes. It is not exactly-once external outcome delivery.

## Reconcile device state

Device hello and heartbeat frames carry complete assignment and owned-window inventories. Policy updates carry a monotonic version; a device is unavailable for new allocation until it acknowledges the exact current version. Provision frames must match that version and must not widen the extension policy.

An offline unattended lease becomes `recovering` after 75 seconds, `suspended` after 90 seconds, and `lost` after its 15-minute adoption window. Suspended leases do not consume capacity but continue to reserve their profile and origins.

Closure uses reciprocal acknowledgement:

```text
persist closure -> send closed -> confirm exact fence -> closed_ack
```

The device resends unacknowledged records after reconnect. Exact server-reported orphan windows can be closed; ordinary restored tabs cannot.

## Handle attended detach

Attended hello frames carry an attachment incarnation UUID. `attended_detached` repeats that UUID and tab ID. The backend ignores stale detach frames, clears browser-derived state for the current attachment, and moves the session to `idle`. Socket loss remains `detached`.

## Enforce limits

| Field | Limit |
|---|---:|
| IDs | 128 characters |
| Card aliases | 64 characters |
| Refs and key specifications | 256 characters |
| URLs | 8 KiB |
| `type.text` | 64 KiB |
| Dialog message | 4 KiB |
| Dialog default prompt | 1 KiB |
| Browser user agent | 512 characters |
| Extension version | 64 characters |
| Accessibility tree | 5,000 nodes, depth 64 |
| Accessibility name or value | 4 KiB |
| Owned-window inventory | 100 records |

Schemas reject oversized or unknown fields. Transport code rejects oversized frames before durable mutation and closes oversized WebSockets with code `1009`.

## Version history

- **0.9.0 / protocol 3**: cloud-secret hard cut, local-card commands, device policy acknowledgement, physical-window inventory, suspended adoption, and attended idle
- **0.8.0**: durable device-control closure acknowledgements
- **0.7.0**: protocol 2 write safety, unattended control, strict bounds, and command polling
- **0.6.0**: target-bound snapshots and refs
- **0.5.0**: dialog events
- **0.4.0**: shared write classification

See [`src/index.ts`](src/index.ts) for the exhaustive export surface.
