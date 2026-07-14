// The command/event protocol shared by the backend and the extension.
// This is the stable contract (D-protocol in docs/technical-plan.md): it is
// browser-agnostic and identical across backend targets. Validate at both ends.

import { z } from "zod";

// ── Shared value types ──────────────────────────────────────────────────────

// The LLM only ever addresses elements by an opaque `ref`; the extension resolves
// it to a live node. A11y trees are recursive, hence the z.lazy + explicit type.
export interface A11yNode {
  ref: string;
  role: string;
  name?: string;
  value?: string;
  children?: A11yNode[];
}

export const A11yNodeSchema: z.ZodType<A11yNode> = z.lazy(() =>
  z.object({
    ref: z.string(),
    role: z.string(),
    name: z.string().optional(),
    value: z.string().optional(),
    children: z.array(A11yNodeSchema).optional(),
  }),
);

export const TabInfoSchema = z.object({
  tabId: z.number(),
  url: z.string(),
  title: z.string(),
  active: z.boolean(),
});
export type TabInfo = z.infer<typeof TabInfoSchema>;

export const SnapshotModeSchema = z.enum(["a11y", "dom", "screenshot"]);
export type SnapshotMode = z.infer<typeof SnapshotModeSchema>;

// ── Commands: backend → extension ────────────────────────────────────────────
// Every command carries a `commandId` used to correlate the async round-trip
// (the coordinator parks a promise keyed by it; the matching event resolves it).

export const CommandSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("snapshot"),
    commandId: z.string(),
    mode: SnapshotModeSchema,
    tabId: z.number().optional(),
  }),
  z.object({
    type: z.literal("navigate"),
    commandId: z.string(),
    url: z.url(),
    tabId: z.number().optional(),
  }),
  z.object({ type: z.literal("click"), commandId: z.string(), ref: z.string() }),
  z.object({
    type: z.literal("type"),
    commandId: z.string(),
    ref: z.string(),
    text: z.string(),
    submit: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("key"),
    commandId: z.string(),
    keys: z.string(),
    ref: z.string().optional(),
  }),
  z.object({
    type: z.literal("scroll"),
    commandId: z.string(),
    ref: z.string().optional(),
    dy: z.number(),
  }),
  z.object({
    type: z.literal("wait"),
    commandId: z.string(),
    for: z.enum(["load", "idle", "ms"]),
    value: z.number().optional(),
  }),
  z.object({ type: z.literal("get_tabs"), commandId: z.string() }),
  z.object({ type: z.literal("switch_tab"), commandId: z.string(), tabId: z.number() }),
]);
export type Command = z.infer<typeof CommandSchema>;
export type CommandType = Command["type"];

// State-changing commands gate on human approval (D8). Reads run freely.
const WRITE_COMMANDS = new Set<CommandType>(["click", "type", "key", "navigate"]);
export const isWriteCommand = (c: Command): boolean => WRITE_COMMANDS.has(c.type);

// ── Events: extension → backend ──────────────────────────────────────────────

export const EventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    browser: z.string(),
    extVersion: z.string(),
    tabs: z.array(TabInfoSchema),
  }),
  z.object({
    type: z.literal("snapshot_result"),
    commandId: z.string(),
    tree: z.array(A11yNodeSchema),
  }),
  z.object({
    type: z.literal("screenshot_result"),
    commandId: z.string(),
    mime: z.string(),
    b64: z.string(),
  }),
  z.object({
    type: z.literal("tabs_result"),
    commandId: z.string(),
    tabs: z.array(TabInfoSchema),
  }),
  z.object({
    type: z.literal("action_result"),
    commandId: z.string(),
    ok: z.boolean(),
    error: z.string().optional(),
    url: z.string().optional(),
  }),
  z.object({
    type: z.literal("page_event"),
    kind: z.enum(["navigated", "load"]),
    tabId: z.number(),
    url: z.string(),
  }),
  z.object({ type: z.literal("pong") }),
]);
export type Event = z.infer<typeof EventSchema>;
export type EventType = Event["type"];

// ── Parse helpers (throwing + safe variants) ─────────────────────────────────

export const parseCommand = (u: unknown): Command => CommandSchema.parse(u);
export const parseEvent = (u: unknown): Event => EventSchema.parse(u);
export const safeParseCommand = (u: unknown) => CommandSchema.safeParse(u);
export const safeParseEvent = (u: unknown) => EventSchema.safeParse(u);
