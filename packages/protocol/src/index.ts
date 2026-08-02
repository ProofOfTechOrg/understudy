import { z } from "zod";

export const PROTOCOL_VERSION = 3 as const;
export const COMMAND_HTTP_BODY_MAX_BYTES = 128 * 1024;
export const DEVICE_CONTROL_FRAME_MAX_BYTES = 64 * 1024;
export const SESSION_RESULT_FRAME_MAX_BYTES = 16 * 1024 * 1024;
export const MAX_A11Y_NODES = 5_000;
export const MAX_A11Y_DEPTH = 64;
export const WS_CLOSE_REPLACED = 4001;
export const WS_CLOSE_SESSION_TERMINAL = 4003;

const strictObject = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();
const utf8String = (maxBytes: number) =>
  z.string().superRefine((value, ctx) => {
    if (utf8ByteLength(value) > maxBytes) {
      ctx.addIssue({ code: "custom", message: `string exceeds ${maxBytes} bytes` });
    }
  });
const IdSchema = z.string().min(1).max(128);
const RefSchema = z.string().min(1).max(256);
export const CardAliasSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9._-]+$/);
const UrlStringSchema = z.string().min(1).superRefine((value, ctx) => {
  if (utf8ByteLength(value) > 8 * 1024) {
    ctx.addIssue({ code: "custom", message: "URL exceeds 8192 bytes" });
  }
});
const AbsoluteUrlSchema = UrlStringSchema.pipe(z.url());
export const AllowedOriginSchema = UrlStringSchema;
const TimestampSchema = z.iso.datetime({ offset: true });
const NonnegativeIntSchema = z.number().int().nonnegative();

export interface A11yNode {
  ref: string;
  role: string;
  name?: string;
  value?: string;
  children?: A11yNode[];
}

export const A11yNodeSchema: z.ZodType<A11yNode> = z.lazy(() =>
  strictObject({
    ref: RefSchema,
    role: z.string().min(1).max(256),
    name: utf8String(4 * 1024).optional(),
    value: utf8String(4 * 1024).optional(),
    children: z.array(A11yNodeSchema).optional(),
  }),
);

function validateA11yTree(
  tree: A11yNode[],
  ctx: z.RefinementCtx,
): void {
  let count = 0;
  const pending = tree.map((node) => ({ node, depth: 1 }));
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    count += 1;
    if (count > MAX_A11Y_NODES) {
      ctx.addIssue({ code: "custom", message: `a11y tree exceeds ${MAX_A11Y_NODES} nodes` });
      return;
    }
    if (current.depth > MAX_A11Y_DEPTH) {
      ctx.addIssue({ code: "custom", message: `a11y tree exceeds depth ${MAX_A11Y_DEPTH}` });
      return;
    }
    for (const child of current.node.children ?? []) {
      pending.push({ node: child, depth: current.depth + 1 });
    }
  }
}

export const A11yTreeSchema = z.array(A11yNodeSchema).superRefine(validateA11yTree);

export const TabInfoSchema = strictObject({
  tabId: NonnegativeIntSchema,
  url: UrlStringSchema,
  title: utf8String(4 * 1024),
  active: z.boolean(),
});
export type TabInfo = z.infer<typeof TabInfoSchema>;

export const SnapshotModeSchema = z.enum(["a11y", "dom", "screenshot"]);
export type SnapshotMode = z.infer<typeof SnapshotModeSchema>;

export const SnapshotTargetSchema = strictObject({
  tabId: NonnegativeIntSchema,
  url: UrlStringSchema,
});
export type SnapshotTarget = z.infer<typeof SnapshotTargetSchema>;

export const DialogTypeSchema = z.enum(["alert", "confirm", "prompt", "beforeunload"]);
export type DialogType = z.infer<typeof DialogTypeSchema>;

export const DialogDispositionSchema = z.enum(["accept", "dismiss"]);
export type DialogDisposition = z.infer<typeof DialogDispositionSchema>;

export const DialogRecordSchema = strictObject({
  dialogId: IdSchema,
  occurredAt: TimestampSchema,
  tabId: NonnegativeIntSchema,
  dialogType: DialogTypeSchema,
  message: utf8String(4 * 1024),
  url: UrlStringSchema,
  defaultPrompt: utf8String(1024).optional(),
  disposition: DialogDispositionSchema,
});
export type DialogRecord = z.infer<typeof DialogRecordSchema>;

const CommandBase = {
  commandId: IdSchema,
};

const WaitCommandSchema = strictObject({
  type: z.literal("wait"),
  ...CommandBase,
  for: z.enum(["load", "idle", "ms"]),
  value: z.number().int().min(0).max(20_000).optional(),
}).superRefine((value, ctx) => {
  if (value.for === "ms" && value.value === undefined) {
    ctx.addIssue({ code: "custom", path: ["value"], message: "value is required for wait.ms" });
  }
  if (value.for !== "ms" && value.value !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["value"],
      message: "value is forbidden unless wait.for is 'ms'",
    });
  }
});

export const CommandSchema = z.discriminatedUnion("type", [
  strictObject({
    type: z.literal("snapshot"),
    ...CommandBase,
    mode: SnapshotModeSchema,
    tabId: NonnegativeIntSchema.optional(),
  }),
  strictObject({
    type: z.literal("navigate"),
    ...CommandBase,
    url: AbsoluteUrlSchema,
    tabId: NonnegativeIntSchema.optional(),
  }),
  strictObject({ type: z.literal("click"), ...CommandBase, ref: RefSchema }),
  strictObject({
    type: z.literal("type"),
    ...CommandBase,
    ref: RefSchema,
    text: utf8String(64 * 1024),
    submit: z.boolean().optional(),
  }),
  strictObject({ type: z.literal("list_cards"), ...CommandBase }),
  strictObject({
    type: z.literal("submit_card"),
    ...CommandBase,
    cardAlias: CardAliasSchema,
    numberRef: RefSchema,
    expiry: z.discriminatedUnion("kind", [
      strictObject({ kind: z.literal("combined"), ref: RefSchema }),
      strictObject({
        kind: z.literal("split"),
        monthRef: RefSchema,
        yearRef: RefSchema,
      }),
    ]),
    cvvRef: RefSchema,
    cardholderNameRef: RefSchema.optional(),
    submitRef: RefSchema,
  }),
  strictObject({
    type: z.literal("key"),
    ...CommandBase,
    keys: z.string().min(1).max(256),
    ref: RefSchema.optional(),
  }),
  strictObject({
    type: z.literal("scroll"),
    ...CommandBase,
    ref: RefSchema.optional(),
    dy: z.number().finite(),
  }),
  WaitCommandSchema,
  strictObject({ type: z.literal("resolve_ref"), ...CommandBase, ref: RefSchema }),
  strictObject({ type: z.literal("get_tabs"), ...CommandBase }),
  strictObject({ type: z.literal("switch_tab"), ...CommandBase, tabId: NonnegativeIntSchema }),
]);
export type Command = z.infer<typeof CommandSchema>;
export type CommandType = Command["type"];

export const WRITE_COMMAND_TYPES = [
  "click",
  "type",
  "key",
  "navigate",
  "submit_card",
  "scroll",
  "switch_tab",
] as const satisfies readonly CommandType[];
export type WriteCommandType = (typeof WRITE_COMMAND_TYPES)[number];
const WRITE_COMMANDS = new Set<CommandType>(WRITE_COMMAND_TYPES);
export const isWriteCommand = (
  command: Command,
): command is Extract<Command, { type: WriteCommandType }> => WRITE_COMMANDS.has(command.type);

export const PROTOCOL_CAPABILITIES = [
  "safe-write-v3",
  "command-status-v3",
  "dialog-ack-v3",
  "single-owned-tab-v3",
  "local-card-vault-v1",
  "device-policy-v1",
  "owned-window-inventory-v1",
] as const;
export const ProtocolCapabilitySchema = z.enum(PROTOCOL_CAPABILITIES);
export type ProtocolCapability = z.infer<typeof ProtocolCapabilitySchema>;

export const ATTENDED_PROTOCOL_CAPABILITIES = [
  "safe-write-v3",
  "command-status-v3",
  "dialog-ack-v3",
  "single-owned-tab-v3",
] as const satisfies readonly ProtocolCapability[];

const HelloEventSchema = strictObject({
  type: z.literal("hello"),
  protocolVersion: z.literal(PROTOCOL_VERSION).optional(),
  capabilities: z.array(ProtocolCapabilitySchema).max(PROTOCOL_CAPABILITIES.length).optional(),
  browser: z.string().min(1).max(512),
  extVersion: z.string().min(1).max(64),
  browserEpoch: IdSchema.optional(),
  leaseId: IdSchema.optional(),
  leaseEpoch: NonnegativeIntSchema.optional(),
  attachmentId: IdSchema.nullable().optional(),
  tabs: z.array(TabInfoSchema).max(128),
}).superRefine((event, ctx) => {
  if (event.protocolVersion !== PROTOCOL_VERSION) return;
  const unattended = event.leaseId !== undefined;
  const expectedTabs = unattended || event.attachmentId !== null ? 1 : 0;
  if (event.tabs.length !== expectedTabs) {
    ctx.addIssue({
      code: "custom",
      path: ["tabs"],
      message: `protocol-v3 hello requires exactly ${expectedTabs} owned tabs`,
    });
  }
  if (!unattended && event.attachmentId === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["attachmentId"],
      message: "attended protocol-v3 hello requires an attachment state",
    });
  }
  if (unattended && event.attachmentId !== undefined && event.attachmentId !== null) {
    ctx.addIssue({
      code: "custom",
      path: ["attachmentId"],
      message: "unattended protocol-v3 hello cannot carry an attachmentId",
    });
  }
});

export const EventSchema = z.discriminatedUnion("type", [
  HelloEventSchema,
  strictObject({
    type: z.literal("snapshot_result"),
    ...CommandBase,
    tree: A11yTreeSchema,
    ...SnapshotTargetSchema.shape,
  }),
  strictObject({
    type: z.literal("screenshot_result"),
    ...CommandBase,
    mime: z.string().min(1).max(128),
    b64: z.string().max(SESSION_RESULT_FRAME_MAX_BYTES),
    ...SnapshotTargetSchema.shape,
  }),
  strictObject({
    type: z.literal("tabs_result"),
    ...CommandBase,
    tabs: z.array(TabInfoSchema).max(1),
  }),
  strictObject({
    type: z.literal("action_result"),
    ...CommandBase,
    ok: z.boolean(),
    error: utf8String(4 * 1024).optional(),
    url: UrlStringSchema.optional(),
    simulated: z.boolean().optional(),
  }),
  strictObject({
    type: z.literal("cards_result"),
    ...CommandBase,
    aliases: z.array(CardAliasSchema).max(100),
    approvedOrigins: z.array(AllowedOriginSchema).max(32),
  }),
  strictObject({
    type: z.literal("card_submission_result"),
    ...CommandBase,
    status: z.enum(["not_started", "outcome_unknown"]),
    reason: z.enum([
      "card_not_found",
      "origin_not_approved",
      "stale_ref",
      "invalid_mapping",
      "input_failed",
      "submission_attempted",
    ]),
  }).superRefine((result, ctx) => {
    const prefillReasons = new Set([
      "card_not_found",
      "origin_not_approved",
      "stale_ref",
      "invalid_mapping",
    ]);
    if (
      (prefillReasons.has(result.reason) && result.status !== "not_started") ||
      (result.reason === "submission_attempted" && result.status !== "outcome_unknown")
    ) {
      ctx.addIssue({ code: "custom", message: "card result status/reason mismatch" });
    }
  }),
  strictObject({
    type: z.literal("page_event"),
    kind: z.enum(["navigated", "load"]),
    tabId: NonnegativeIntSchema,
    url: UrlStringSchema,
  }),
  strictObject({ type: z.literal("dialog"), ...DialogRecordSchema.shape }),
  strictObject({ type: z.literal("pong") }),
]);
export type Event = z.infer<typeof EventSchema>;
export type EventType = Event["type"];

const COMMAND_RESULT_EVENT_TYPES = {
  snapshot: ["snapshot_result", "screenshot_result", "action_result"],
  navigate: ["action_result"],
  click: ["action_result"],
  type: ["action_result"],
  list_cards: ["cards_result"],
  submit_card: ["card_submission_result"],
  key: ["action_result"],
  scroll: ["action_result"],
  wait: ["action_result"],
  resolve_ref: ["action_result"],
  get_tabs: ["tabs_result", "action_result"],
  switch_tab: ["action_result"],
} as const satisfies Record<CommandType, readonly EventType[]>;

export function isCommandResultEvent(
  commandType: string,
  eventType: EventType,
): boolean {
  const accepted = (
    COMMAND_RESULT_EVENT_TYPES as Partial<Record<string, readonly EventType[]>>
  )[commandType];
  return accepted?.includes(eventType) ?? false;
}

export function isCommandType(commandType: string): commandType is CommandType {
  return Object.hasOwn(COMMAND_RESULT_EVENT_TYPES, commandType);
}

export const CommandRequestSchema = strictObject({
  command: CommandSchema,
  dryRun: z.boolean().optional(),
});
export type CommandRequest = z.infer<typeof CommandRequestSchema>;

export const CommandFenceSchema = strictObject({
  attemptId: IdSchema,
  deadlineAt: TimestampSchema,
  attachmentId: IdSchema.optional(),
  leaseId: IdSchema.optional(),
  leaseEpoch: NonnegativeIntSchema.optional(),
  browserEpoch: IdSchema.optional(),
});
export type CommandFence = z.infer<typeof CommandFenceSchema>;

const CommandFenceShape = CommandFenceSchema.shape;
export const SessionServerFrameSchema = z.discriminatedUnion("type", [
  strictObject({
    type: z.literal("command"),
    ...CommandFenceShape,
    command: CommandSchema,
  }),
  strictObject({
    type: z.literal("write_prepare"),
    ...CommandFenceShape,
    commandId: IdSchema,
    commandType: z.enum(WRITE_COMMAND_TYPES),
    requestFingerprint: z.string().length(64),
  }),
  strictObject({
    type: z.literal("write_grant"),
    ...CommandFenceShape,
    command: CommandSchema,
  }).superRefine((frame, ctx) => {
    if (!isWriteCommand(frame.command)) {
      ctx.addIssue({ code: "custom", path: ["command"], message: "write_grant requires a write" });
    }
  }),
  strictObject({
    type: z.literal("attempt_cancel"),
    attemptId: IdSchema,
    commandId: IdSchema,
  }),
  strictObject({
    type: z.literal("result_ack"),
    attemptId: IdSchema,
    commandId: IdSchema,
  }),
  strictObject({ type: z.literal("dialog_ack"), dialogId: IdSchema }),
  strictObject({ type: z.literal("writes_blocked"), reason: z.string().min(1).max(256) }),
  strictObject({ type: z.literal("close_session"), closeTab: z.boolean() }),
]);
export type SessionServerFrame = z.infer<typeof SessionServerFrameSchema>;

export const SessionClientFrameSchema = z.discriminatedUnion("type", [
  strictObject({
    type: z.literal("write_ready"),
    ...CommandFenceShape,
    commandId: IdSchema,
    requestFingerprint: z.string().length(64),
  }),
  strictObject({
    type: z.literal("command_result"),
    attemptId: IdSchema,
    commandId: IdSchema,
    attachmentId: IdSchema.optional(),
    leaseId: IdSchema.optional(),
    leaseEpoch: NonnegativeIntSchema.optional(),
    browserEpoch: IdSchema.optional(),
    event: EventSchema,
  }).superRefine((frame, ctx) => {
    if (!("commandId" in frame.event)) {
      ctx.addIssue({
        code: "custom",
        path: ["event"],
        message: "command_result requires a correlated result event",
      });
    } else if (frame.event.commandId !== frame.commandId) {
      ctx.addIssue({ code: "custom", path: ["event", "commandId"], message: "commandId mismatch" });
    }
  }),
  strictObject({ type: z.literal("dialog"), ...DialogRecordSchema.shape }),
  strictObject({ type: z.literal("pong") }),
  strictObject({
    type: z.literal("attended_detached"),
    attachmentId: IdSchema,
    tabId: NonnegativeIntSchema,
  }),
  strictObject({
    type: z.literal("health"),
    dialogDelivery: z.enum(["ok", "interrupted", "overflow"]),
  }),
]);
export type SessionClientFrame = z.infer<typeof SessionClientFrameSchema>;

export const UnattendedSessionRequestSchema = strictObject({
  mode: z.literal("unattended"),
  deviceId: z.uuid().optional(),
  allowedOrigins: z.array(AllowedOriginSchema).min(1).max(32),
  profileStateKey: z.string().min(1).max(256),
});
export type UnattendedSessionRequest = z.infer<typeof UnattendedSessionRequestSchema>;

export const DeviceBrowserSchema = strictObject({
  browser: z.string().min(1).max(512),
  extVersion: z.string().min(1).max(64),
});
export type DeviceBrowser = z.infer<typeof DeviceBrowserSchema>;

export const UnattendedSessionLifecycleSchema = z.enum([
  "allocating",
  "provisioning",
  "connected",
  "recovering",
  "suspended",
  "closing",
  "closed",
  "expired",
  "lost",
]);
export type UnattendedSessionLifecycle = z.infer<typeof UnattendedSessionLifecycleSchema>;

export const DialogDeliverySchema = z.enum(["ok", "interrupted", "overflow"]);
export type DialogDelivery = z.infer<typeof DialogDeliverySchema>;

export const AttendedSessionStatusSchema = strictObject({
  mode: z.literal("attended").optional(),
  status: z.enum(["pending", "idle", "connected", "detached"]),
  attachmentId: IdSchema.nullable(),
  browser: DeviceBrowserSchema.nullable(),
  tabs: z.array(TabInfoSchema),
  currentUrl: UrlStringSchema.nullable(),
  dialogs: z.array(DialogRecordSchema).max(50),
});

export const UnattendedSessionStatusSchema = strictObject({
  mode: z.literal("unattended"),
  status: UnattendedSessionLifecycleSchema,
  deviceId: z.uuid(),
  createdAt: TimestampSchema,
  lastActivityAt: TimestampSchema,
  idleExpiresAt: TimestampSchema,
  hardExpiresAt: TimestampSchema,
  needsReconciliation: z.boolean(),
  dialogDelivery: DialogDeliverySchema,
  browser: DeviceBrowserSchema.nullable(),
  tabs: z.array(TabInfoSchema).max(1),
  currentUrl: UrlStringSchema.nullable(),
  dialogs: z.array(DialogRecordSchema).max(50),
});
export type UnattendedSessionStatus = z.infer<typeof UnattendedSessionStatusSchema>;
export const SessionStatusResponseSchema = z.union([
  AttendedSessionStatusSchema,
  UnattendedSessionStatusSchema,
]);
export type SessionStatusResponse = z.infer<typeof SessionStatusResponseSchema>;

export const DeviceStatusSchema = strictObject({
  deviceId: z.uuid(),
  status: z.enum(["online", "offline", "recovering", "disabled", "incompatible"]),
  capacity: z.literal(2),
  used: z.number().int().min(0).max(2),
  browser: DeviceBrowserSchema.nullable(),
  lastSeenAt: TimestampSchema.nullable(),
  serverUsed: z.number().int().min(0).max(2),
  managedAssignments: z.number().int().min(0).max(2).nullable(),
  ownedWindows: z.number().int().min(0).max(100).nullable(),
  missingOnServer: z.array(IdSchema).max(100),
  missingOnDevice: z.array(IdSchema).max(100),
  diverged: z.boolean(),
  comparedAt: TimestampSchema.nullable(),
  policyVersion: NonnegativeIntSchema,
  acknowledgedPolicyVersion: NonnegativeIntSchema.nullable(),
});
export type DeviceStatus = z.infer<typeof DeviceStatusSchema>;

export const CommandStateSchema = z.enum([
  "preparing",
  "ready",
  "granted",
  "completed",
  "not_started",
  "timed_out",
  "unknown",
]);
export type CommandState = z.infer<typeof CommandStateSchema>;

export const PendingCommandResponseSchema = strictObject({
  commandId: IdSchema,
  status: z.literal("pending"),
  statusUrl: UrlStringSchema,
  retryPolicy: z.literal("poll_same_command"),
});
export type PendingCommandResponse = z.infer<typeof PendingCommandResponseSchema>;

export const CommandStatusResponseSchema = strictObject({
  commandId: IdSchema,
  status: CommandStateSchema,
  event: EventSchema.optional(),
  safeToRetry: z.boolean(),
});
export type CommandStatusResponse = z.infer<typeof CommandStatusResponseSchema>;

const OwnedLeaseFenceShape = {
  sessionId: IdSchema,
  leaseId: IdSchema,
  leaseEpoch: NonnegativeIntSchema,
  browserEpoch: IdSchema,
};
export const AssignmentInventorySchema = strictObject({
  ...OwnedLeaseFenceShape,
  tabId: NonnegativeIntSchema,
  windowId: NonnegativeIntSchema,
});
export type AssignmentInventory = z.infer<typeof AssignmentInventorySchema>;
export const OwnedWindowSchema = strictObject({
  ...OwnedLeaseFenceShape,
  tabId: NonnegativeIntSchema.nullable(),
  windowId: NonnegativeIntSchema,
});
export type OwnedWindow = z.infer<typeof OwnedWindowSchema>;

export const DeviceControlClientFrameSchema = z.discriminatedUnion("type", [
  strictObject({
    type: z.literal("device_hello"),
    protocolVersion: z.literal(PROTOCOL_VERSION),
    capabilities: z.array(ProtocolCapabilitySchema).max(PROTOCOL_CAPABILITIES.length),
    deviceId: z.uuid(),
    browserEpoch: IdSchema,
    browser: z.string().min(1).max(512),
    extVersion: z.string().min(1).max(64),
    allowedOrigins: z.array(AllowedOriginSchema).max(32),
    policyVersion: NonnegativeIntSchema,
    assignments: z.array(AssignmentInventorySchema).max(2),
    ownedWindows: z.array(OwnedWindowSchema).max(100),
  }),
  strictObject({
    type: z.literal("heartbeat"),
    deviceId: z.uuid(),
    browserEpoch: IdSchema,
    assignments: z.array(AssignmentInventorySchema).max(2),
    ownedWindows: z.array(OwnedWindowSchema).max(100),
  }),
  strictObject({
    type: z.literal("policy_ack"),
    deviceId: z.uuid(),
    browserEpoch: IdSchema,
    policyVersion: NonnegativeIntSchema,
  }),
  strictObject({
    type: z.literal("provisioned"),
    sessionId: IdSchema,
    leaseId: IdSchema,
    leaseEpoch: NonnegativeIntSchema,
    browserEpoch: IdSchema,
    tab: TabInfoSchema,
  }),
  strictObject({
    type: z.literal("closed"),
    sessionId: IdSchema,
    leaseId: IdSchema,
    leaseEpoch: NonnegativeIntSchema,
    browserEpoch: IdSchema,
  }),
  strictObject({
    type: z.literal("provision_failed"),
    sessionId: IdSchema,
    leaseId: IdSchema,
    leaseEpoch: NonnegativeIntSchema,
    browserEpoch: IdSchema,
    reason: z.string().min(1).max(256),
  }),
]);
export type DeviceControlClientFrame = z.infer<typeof DeviceControlClientFrameSchema>;

export const DeviceControlServerFrameSchema = z.discriminatedUnion("type", [
  strictObject({
    type: z.literal("provision"),
    sessionId: IdSchema,
    leaseId: IdSchema,
    leaseEpoch: NonnegativeIntSchema,
    browserEpoch: IdSchema,
    allowedOrigins: z.array(AllowedOriginSchema).min(1).max(32),
    policyVersion: NonnegativeIntSchema,
    sessionTicket: z.string().min(1).max(4 * 1024),
  }),
  strictObject({
    type: z.literal("policy_update"),
    policyVersion: NonnegativeIntSchema,
    allowedOrigins: z.array(AllowedOriginSchema).max(32),
  }),
  strictObject({
    type: z.literal("close_orphan"),
    ...OwnedWindowSchema.shape,
  }),
  strictObject({
    type: z.literal("close_lease"),
    sessionId: IdSchema,
    leaseId: IdSchema,
    leaseEpoch: NonnegativeIntSchema,
    browserEpoch: IdSchema,
  }),
  strictObject({
    type: z.literal("session_ticket"),
    sessionId: IdSchema,
    leaseId: IdSchema,
    leaseEpoch: NonnegativeIntSchema,
    browserEpoch: IdSchema,
    sessionTicket: z.string().min(1).max(4 * 1024),
  }),
  strictObject({
    type: z.literal("closed_ack"),
    sessionId: IdSchema,
    leaseId: IdSchema,
    leaseEpoch: NonnegativeIntSchema,
    browserEpoch: IdSchema,
  }),
  strictObject({ type: z.literal("credential_revoked") }),
]);
export type DeviceControlServerFrame = z.infer<typeof DeviceControlServerFrameSchema>;

export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.codePointAt(index);
    if (codePoint === undefined) break;
    if (codePoint <= 0x7f) bytes += 1;
    else if (codePoint <= 0x7ff) bytes += 2;
    else if (codePoint <= 0xffff) bytes += 3;
    else {
      bytes += 4;
      index += 1;
    }
  }
  return bytes;
}

export function parseBoundedJson(
  text: string,
  maxBytes: number,
): unknown {
  if (utf8ByteLength(text) > maxBytes) {
    throw new Error(`payload exceeds ${maxBytes} bytes`);
  }
  return JSON.parse(text) as unknown;
}

export const parseCommand = (value: unknown): Command => CommandSchema.parse(value);
export const parseEvent = (value: unknown): Event => EventSchema.parse(value);
export const safeParseCommand = (value: unknown) => CommandSchema.safeParse(value);
export const safeParseEvent = (value: unknown) => EventSchema.safeParse(value);
export const safeParseSessionServerFrame = (value: unknown) =>
  SessionServerFrameSchema.safeParse(value);
export const safeParseSessionClientFrame = (value: unknown) =>
  SessionClientFrameSchema.safeParse(value);
export const safeParseDeviceControlClientFrame = (value: unknown) =>
  DeviceControlClientFrameSchema.safeParse(value);
export const safeParseDeviceControlServerFrame = (value: unknown) =>
  DeviceControlServerFrameSchema.safeParse(value);
