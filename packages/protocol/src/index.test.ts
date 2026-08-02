import { describe, it, expect } from "vitest";
import {
  A11yNodeSchema,
  ATTENDED_PROTOCOL_CAPABILITIES,
  CommandSchema,
  CommandRequestSchema,
  DeviceControlClientFrameSchema,
  DeviceControlServerFrameSchema,
  DialogRecordSchema,
  EventSchema,
  PROTOCOL_CAPABILITIES,
  PROTOCOL_VERSION,
  SessionClientFrameSchema,
  SessionServerFrameSchema,
  WS_CLOSE_REPLACED,
  WS_CLOSE_SESSION_TERMINAL,
  isCommandResultEvent,
  isCommandType,
  isWriteCommand,
  parseCommand,
  safeParseCommand,
  safeParseEvent,
  WRITE_COMMAND_TYPES,
  type Command,
} from "./index";

describe("WebSocket close codes", () => {
  it("exports the stable replacement and terminal-session codes", () => {
    expect(WS_CLOSE_REPLACED).toBe(4001);
    expect(WS_CLOSE_SESSION_TERMINAL).toBe(4003);
  });
});

describe("command result correlation", () => {
  it("accepts only result types produced by the corresponding command", () => {
    expect(isCommandResultEvent("snapshot", "snapshot_result")).toBe(true);
    expect(isCommandResultEvent("snapshot", "screenshot_result")).toBe(true);
    expect(isCommandResultEvent("get_tabs", "tabs_result")).toBe(true);
    expect(isCommandResultEvent("list_cards", "cards_result")).toBe(true);
    expect(isCommandResultEvent("submit_card", "card_submission_result")).toBe(true);
    expect(isCommandResultEvent("submit_card", "action_result")).toBe(false);
    expect(isCommandResultEvent("click", "cards_result")).toBe(false);
    expect(isCommandResultEvent("fill_secret", "action_result")).toBe(false);
    expect(isCommandType("fill_secret")).toBe(false);
  });
});

describe("CommandSchema", () => {
  it("parses a valid snapshot command", () => {
    const cmd = { type: "snapshot", commandId: "c1", mode: "a11y" };
    expect(parseCommand(cmd)).toEqual(cmd);
  });

  it("rejects a command missing commandId", () => {
    expect(safeParseCommand({ type: "click", ref: "r1" }).success).toBe(false);
  });

  it("rejects an unknown command type", () => {
    expect(safeParseCommand({ type: "explode", commandId: "c1" }).success).toBe(false);
  });

  it("rejects navigate with a non-URL", () => {
    expect(
      safeParseCommand({ type: "navigate", commandId: "c1", url: "not a url" }).success,
    ).toBe(false);
  });

  it("accepts navigate with a real URL", () => {
    const cmd = { type: "navigate", commandId: "c1", url: "https://example.com/" };
    expect(CommandSchema.parse(cmd)).toEqual(cmd);
  });

  it("parses a valid card submission command", () => {
    const cmd = {
      type: "submit_card",
      commandId: "c1",
      cardAlias: "travel-card",
      numberRef: "number-ref",
      expiry: { kind: "split", monthRef: "month-ref", yearRef: "year-ref" },
      cvvRef: "cvv-ref",
      cardholderNameRef: "name-ref",
      submitRef: "submit-ref",
    };
    expect(parseCommand(cmd)).toEqual(cmd);
  });

  it("leaves duplicate card refs to the fixed-result executor and rejects fill_secret", () => {
    expect(
      safeParseCommand({
        type: "submit_card",
        commandId: "c1",
        cardAlias: "travel-card",
        numberRef: "same-ref",
        expiry: { kind: "combined", ref: "expiry-ref" },
        cvvRef: "cvv-ref",
        submitRef: "same-ref",
      }).success,
    ).toBe(true);
    expect(
      safeParseCommand({
        type: "fill_secret",
        commandId: "c1",
        ref: "opaque-ref",
        secretRef: "vault://x",
      }).success,
    ).toBe(false);
  });

  it("parses a valid resolve_ref command", () => {
    const cmd = { type: "resolve_ref", commandId: "c1", ref: "opaque-ref" };
    expect(parseCommand(cmd)).toEqual(cmd);
  });

  it("rejects resolve_ref missing ref", () => {
    expect(safeParseCommand({ type: "resolve_ref", commandId: "c1" }).success).toBe(false);
  });

  it("rejects unknown fields instead of silently stripping them", () => {
    expect(
      safeParseCommand({ type: "get_tabs", commandId: "c1", unexpected: true }).success,
    ).toBe(false);
  });

  it("enforces bounded IDs, refs, text, keys, URLs, and card aliases", () => {
    expect(safeParseCommand({ type: "get_tabs", commandId: "x".repeat(129) }).success).toBe(false);
    expect(
      safeParseCommand({ type: "click", commandId: "c", ref: "r".repeat(257) }).success,
    ).toBe(false);
    expect(
      safeParseCommand({
        type: "type",
        commandId: "c",
        ref: "r",
        text: "t".repeat(64 * 1024 + 1),
      }).success,
    ).toBe(false);
    expect(
      safeParseCommand({ type: "key", commandId: "c", keys: "k".repeat(257) }).success,
    ).toBe(false);
    expect(
      safeParseCommand({
        type: "navigate",
        commandId: "c",
        url: `https://example.com/${"x".repeat(8 * 1024)}`,
      }).success,
    ).toBe(false);
    expect(
      safeParseCommand({
        type: "submit_card",
        commandId: "c",
        cardAlias: "s".repeat(65),
        numberRef: "number",
        expiry: { kind: "combined", ref: "expiry" },
        cvvRef: "cvv",
        submitRef: "submit",
      }).success,
    ).toBe(false);
  });

  it("applies KiB limits to UTF-8 bytes rather than JavaScript code units", () => {
    expect(
      safeParseCommand({
        type: "type",
        commandId: "c",
        ref: "r",
        text: "😀".repeat(16 * 1024 + 1),
      }).success,
    ).toBe(false);
    expect(
      DialogRecordSchema.safeParse({
        dialogId: "dialog-1",
        occurredAt: "2026-07-26T00:00:00.000Z",
        tabId: 1,
        dialogType: "alert",
        message: "😀".repeat(1024 + 1),
        url: "https://example.com/",
        disposition: "accept",
      }).success,
    ).toBe(false);
  });

  it("requires wait.ms and forbids wait values for the other modes", () => {
    expect(safeParseCommand({ type: "wait", commandId: "c", for: "ms" }).success).toBe(false);
    expect(
      safeParseCommand({ type: "wait", commandId: "c", for: "ms", value: 20_001 }).success,
    ).toBe(false);
    expect(
      safeParseCommand({ type: "wait", commandId: "c", for: "load", value: 1 }).success,
    ).toBe(false);
    expect(
      safeParseCommand({ type: "wait", commandId: "c", for: "ms", value: 20_000 }).success,
    ).toBe(true);
  });
});

describe("CommandRequestSchema", () => {
  it("rejects truthy-looking dryRun values and unknown request fields", () => {
    const command = { type: "click", commandId: "c", ref: "r" };
    expect(CommandRequestSchema.safeParse({ command, dryRun: "true" }).success).toBe(false);
    expect(
      CommandRequestSchema.safeParse({ command, dryRun: false, unexpected: 1 }).success,
    ).toBe(false);
  });
});

describe("isWriteCommand", () => {
  it("classifies writes vs reads", () => {
    const click: Command = { type: "click", commandId: "c1", ref: "r1" };
    const snap: Command = { type: "snapshot", commandId: "c2", mode: "a11y" };
    expect(isWriteCommand(click)).toBe(true);
    expect(isWriteCommand(snap)).toBe(false);
  });

  it("classifies submit_card as a write and list_cards as a read", () => {
    const submitCard: Command = {
      type: "submit_card",
      commandId: "c1",
      cardAlias: "travel-card",
      numberRef: "number",
      expiry: { kind: "combined", ref: "expiry" },
      cvvRef: "cvv",
      submitRef: "submit",
    };
    expect(isWriteCommand(submitCard)).toBe(true);
    expect(isWriteCommand({ type: "list_cards", commandId: "c2" })).toBe(false);
  });

  it("classifies resolve_ref as a read - the dry-run probe must run freely", () => {
    const probe: Command = { type: "resolve_ref", commandId: "c1", ref: "opaque-ref" };
    expect(isWriteCommand(probe)).toBe(false);
  });

  it("classifies scroll and switch_tab as writes - user-visible side effects, not DOM reads", () => {
    // Both change what the user's real browser shows, so a dry-run must
    // simulate (not perform) them and a retry must replay (not repeat) them -
    // scroll's relative dy would otherwise double-scroll on a lost-response retry.
    const scroll: Command = { type: "scroll", commandId: "c1", dy: 100 };
    const switchTab: Command = { type: "switch_tab", commandId: "c2", tabId: 3 };
    expect(isWriteCommand(scroll)).toBe(true);
    expect(isWriteCommand(switchTab)).toBe(true);
  });

  it("agrees with the exported WRITE_COMMAND_TYPES tuple for every command type", () => {
    // #given every command type in the union, as a representative command
    const representatives: Command[] = [
      { type: "snapshot", commandId: "c", mode: "a11y" },
      { type: "navigate", commandId: "c", url: "https://example.com/" },
      { type: "click", commandId: "c", ref: "r" },
      { type: "type", commandId: "c", ref: "r", text: "t" },
      { type: "list_cards", commandId: "c" },
      {
        type: "submit_card",
        commandId: "c",
        cardAlias: "travel-card",
        numberRef: "number",
        expiry: { kind: "combined", ref: "expiry" },
        cvvRef: "cvv",
        submitRef: "submit",
      },
      { type: "key", commandId: "c", keys: "Enter" },
      { type: "scroll", commandId: "c", dy: 10 },
      { type: "wait", commandId: "c", for: "load" },
      { type: "resolve_ref", commandId: "c", ref: "r" },
      { type: "get_tabs", commandId: "c" },
      { type: "switch_tab", commandId: "c", tabId: 1 },
    ];

    // #then the predicate and the tuple classify identically - the tuple is
    // the published source of truth downstream layers build on
    for (const cmd of representatives) {
      expect(isWriteCommand(cmd)).toBe(
        (WRITE_COMMAND_TYPES as readonly string[]).includes(cmd.type),
      );
    }
    expect(new Set(WRITE_COMMAND_TYPES).size).toBe(WRITE_COMMAND_TYPES.length);
  });
});

describe("EventSchema", () => {
  it("round-trips an accessibility snapshot with its attached target identity", () => {
    const ev = {
      type: "snapshot_result",
      commandId: "c1",
      tree: [],
      tabId: 7,
      url: "https://example.com/",
    };
    expect(EventSchema.parse(ev)).toEqual(ev);
  });

  it("rejects a snapshot result without its attached target identity", () => {
    expect(
      safeParseEvent({ type: "snapshot_result", commandId: "c1", tree: [] }).success,
    ).toBe(false);
  });

  it("rejects a snapshot result with an invalid attached tab id", () => {
    expect(
      safeParseEvent({
        type: "snapshot_result",
        commandId: "c1",
        tree: [],
        tabId: -1,
        url: "https://example.com/",
      }).success,
    ).toBe(false);
  });

  it("round-trips an action_result", () => {
    const ev = { type: "action_result", commandId: "c1", ok: true, url: "https://example.com/" };
    expect(EventSchema.parse(ev)).toEqual(ev);
  });

  it("round-trips an action_result with simulated:true", () => {
    const ev = { type: "action_result", commandId: "c1", ok: true, simulated: true };
    expect(EventSchema.parse(ev)).toEqual(ev);
  });

  it("parses an action_result without simulated (optional)", () => {
    const ev = { type: "action_result", commandId: "c1", ok: true };
    expect(EventSchema.parse(ev)).toEqual(ev);
  });

  it("rejects a malformed event", () => {
    expect(safeParseEvent({ type: "action_result" }).success).toBe(false);
  });

  it("round-trips a tabs_result", () => {
    const ev = {
      type: "tabs_result",
      commandId: "c1",
      tabs: [{ tabId: 1, url: "https://x/", title: "X", active: true }],
    };
    expect(EventSchema.parse(ev)).toEqual(ev);
  });

  it("rejects a tabs_result missing tabs", () => {
    expect(safeParseEvent({ type: "tabs_result", commandId: "c1" }).success).toBe(false);
  });

  it("requires a protocol-v3 hello to expose exactly one owned tab", () => {
    const hello = {
      type: "hello",
      protocolVersion: PROTOCOL_VERSION,
      capabilities: [...PROTOCOL_CAPABILITIES],
      browser: "Chrome/125",
      extVersion: "0.1.0",
      attachmentId: "attachment-1",
      tabs: [
        { tabId: 1, url: "about:blank", title: "", active: false },
        { tabId: 2, url: "about:blank", title: "", active: false },
      ],
    };
    expect(EventSchema.safeParse(hello).success).toBe(false);
  });

  it("represents an idle attended protocol-v3 connection without a tab", () => {
    const hello = {
      type: "hello",
      protocolVersion: PROTOCOL_VERSION,
      capabilities: [...ATTENDED_PROTOCOL_CAPABILITIES],
      browser: "Chrome/125",
      extVersion: "0.2.0",
      attachmentId: null,
      tabs: [],
    };
    expect(EventSchema.parse(hello)).toEqual(hello);
  });

  it("allows a provisional owned-window record without tab metadata", () => {
    const frame = {
      type: "heartbeat",
      deviceId: "00000000-0000-4000-8000-000000000001",
      browserEpoch: "browser-epoch-1",
      assignments: [],
      ownedWindows: [{
        sessionId: "session-1",
        leaseId: "lease-1",
        leaseEpoch: 1,
        browserEpoch: "browser-epoch-1",
        tabId: null,
        windowId: 3,
      }],
    };
    expect(DeviceControlClientFrameSchema.parse(frame)).toEqual(frame);
  });

  it("keeps a bounded multi-tab protocol-1 hello parseable during rollout", () => {
    const hello = {
      type: "hello",
      browser: "Chrome/124",
      extVersion: "0.0.3",
      tabs: [
        { tabId: 1, url: "https://one.example/", title: "One", active: true },
        { tabId: 2, url: "https://two.example/", title: "Two", active: false },
      ],
    };
    expect(EventSchema.parse(hello)).toEqual(hello);
  });

  it("round-trips a dialog event with a defaultPrompt", () => {
    const ev = {
      type: "dialog",
      dialogId: "dialog-1",
      occurredAt: "2026-07-26T00:00:00.000Z",
      tabId: 7,
      dialogType: "prompt",
      message: "Enter your name",
      url: "https://example.com/",
      defaultPrompt: "guest",
      disposition: "dismiss",
    };
    expect(EventSchema.parse(ev)).toEqual(ev);
  });

  it("round-trips a dialog event without a defaultPrompt (optional)", () => {
    const ev = {
      type: "dialog",
      dialogId: "dialog-2",
      occurredAt: "2026-07-26T00:00:00.000Z",
      tabId: 7,
      dialogType: "beforeunload",
      message: "",
      url: "https://example.com/",
      disposition: "accept",
    };
    expect(EventSchema.parse(ev)).toEqual(ev);
  });

  it("accepts only fixed card submission result combinations", () => {
    expect(EventSchema.parse({
      type: "card_submission_result",
      commandId: "c1",
      status: "not_started",
      reason: "stale_ref",
    })).toEqual({
      type: "card_submission_result",
      commandId: "c1",
      status: "not_started",
      reason: "stale_ref",
    });
    expect(EventSchema.safeParse({
      type: "card_submission_result",
      commandId: "c1",
      status: "not_started",
      reason: "submission_attempted",
    }).success).toBe(false);
  });

  it("rejects a dialog with an unknown dialogType", () => {
    expect(
      safeParseEvent({
        type: "dialog",
        tabId: 1,
        dialogType: "notification",
        message: "hi",
        url: "https://x/",
        disposition: "accept",
      }).success,
    ).toBe(false);
  });

  it("rejects a dialog with an invalid disposition", () => {
    expect(
      safeParseEvent({
        type: "dialog",
        tabId: 1,
        dialogType: "alert",
        message: "hi",
        url: "https://x/",
        disposition: "ignore",
      }).success,
    ).toBe(false);
  });
});

describe("DialogRecordSchema", () => {
  it("is the dialog Event payload minus its `type`, pinned to the event member", () => {
    const record = {
      dialogId: "dialog-3",
      occurredAt: "2026-07-26T00:00:00.000Z",
      tabId: 2,
      dialogType: "confirm",
      message: "Sure?",
      url: "https://x/",
      disposition: "dismiss",
    };
    // Parses standalone (the DO-state record / connector validator shape)...
    expect(DialogRecordSchema.parse(record)).toEqual(record);
    // ...and adding the discriminator yields a valid dialog Event, so the record
    // and the wire event cannot drift apart (they share one definition).
    expect(EventSchema.parse({ type: "dialog", ...record })).toEqual({
      type: "dialog",
      ...record,
    });
  });
});

describe("A11yNodeSchema", () => {
  it("parses a nested (recursive) tree", () => {
    const tree = {
      ref: "1",
      role: "main",
      children: [{ ref: "2", role: "button", name: "Go" }],
    };
    expect(A11yNodeSchema.parse(tree)).toEqual(tree);
  });
});

describe("safe command frames", () => {
  const deadlineAt = "2026-07-26T00:00:25.000Z";

  it("parses prepare/ready/grant/result with explicit attempts and fences", () => {
    const prepare = {
      type: "write_prepare",
      attemptId: "attempt-1",
      deadlineAt,
      leaseId: "lease-1",
      leaseEpoch: 1,
      browserEpoch: "browser-1",
      commandId: "command-1",
      commandType: "click",
      requestFingerprint: "a".repeat(64),
    };
    expect(SessionServerFrameSchema.parse(prepare)).toEqual(prepare);

    const ready = {
      type: "write_ready",
      attemptId: "attempt-1",
      deadlineAt,
      leaseId: "lease-1",
      leaseEpoch: 1,
      browserEpoch: "browser-1",
      commandId: "command-1",
      requestFingerprint: "a".repeat(64),
    };
    expect(SessionClientFrameSchema.parse(ready)).toEqual(ready);

    const result = {
      type: "command_result",
      attemptId: "attempt-1",
      commandId: "command-1",
      leaseId: "lease-1",
      leaseEpoch: 1,
      browserEpoch: "browser-1",
      event: { type: "action_result", commandId: "command-1", ok: true },
    };
    expect(SessionClientFrameSchema.parse(result)).toEqual(result);
  });

  it("rejects a grant carrying a read and a result with a mismatched command ID", () => {
    expect(
      SessionServerFrameSchema.safeParse({
        type: "write_grant",
        attemptId: "attempt-1",
        deadlineAt,
        command: { type: "get_tabs", commandId: "command-1" },
      }).success,
    ).toBe(false);
    expect(
      SessionClientFrameSchema.safeParse({
        type: "command_result",
        attemptId: "attempt-1",
        commandId: "command-1",
        event: { type: "action_result", commandId: "different", ok: true },
      }).success,
    ).toBe(false);
    expect(
      SessionClientFrameSchema.safeParse({
        type: "command_result",
        attemptId: "attempt-1",
        commandId: "command-1",
        event: { type: "pong" },
      }).success,
    ).toBe(false);
  });
});

describe("device control frames", () => {
  const acknowledgement = {
    type: "closed_ack",
    sessionId: "session-1",
    leaseId: "lease-1",
    leaseEpoch: 2,
    browserEpoch: "browser-1",
  } as const;

  it("parses an exact closure acknowledgement", () => {
    expect(DeviceControlServerFrameSchema.parse(acknowledgement)).toEqual(
      acknowledgement,
    );
  });

  it.each([
    { ...acknowledgement, sessionId: undefined },
    { ...acknowledgement, leaseEpoch: -1 },
    { ...acknowledgement, extra: true },
  ])("rejects a malformed closure acknowledgement", (frame) => {
    expect(DeviceControlServerFrameSchema.safeParse(frame).success).toBe(false);
  });
});
