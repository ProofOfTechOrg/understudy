import { afterEach, describe, expect, it, vi } from "vitest";
import type { Command, Event, SessionServerFrame } from "@understudy/protocol";
import type { SessionStorageArea } from "./dedupe";
import { SessionRuntime, type RuntimeAssignment, type RuntimeHost } from "./session-runtime";
import type { CdpSession } from "../driver/cdp";
import { CardVaultExpiredError } from "../payment/card-vault";
import type { ValidatedPaymentCard } from "../payment/card-validation";

const ASSIGNMENT: RuntimeAssignment = {
  sessionId: "session-1",
  leaseId: "lease-1",
  leaseEpoch: 1,
  browserEpoch: "epoch-1",
  allowedOrigins: ["https://example.com"],
  policyVersion: 1,
  tabId: 7,
  windowId: 3,
};

function host(): RuntimeHost & { onFenced: ReturnType<typeof vi.fn> } {
  return {
    serviceOrigin: () => "https://understudy.example",
    browserEpoch: () => "epoch-1",
    isCurrent: () => true,
    onFenced: vi.fn(async () => {}),
    onTabChanged: vi.fn(async () => {}),
    paymentVault: () => ({}) as ReturnType<RuntimeHost["paymentVault"]>,
    enterSensitive: vi.fn(async () => {}),
    prepareSensitiveComplete: vi.fn(async () => true),
    finalizeSensitiveComplete: vi.fn(async () => {}),
    abortSensitive: vi.fn(async () => {}),
  };
}

function stubBrowser(
  remove: () => Promise<void>,
  getAll = vi.fn(async () => []),
  storage: SessionStorageArea = {
    get: vi.fn(async () => ({})),
    set: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
  },
): void {
  vi.stubGlobal("browser", {
    storage: { session: storage },
    windows: { remove: vi.fn(remove), getAll },
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

type SubmitCardCommand = Extract<Command, { type: "submit_card" }>;

function executeCard(
  runtime: SessionRuntime,
  command: Extract<Command, { type: "list_cards" | "submit_card" }>,
  cdp: CdpSession,
  deadlineAt = Date.now() + 10_000,
): Promise<Event> {
  return (
    runtime as unknown as {
      executeCardCommand(
        command: Extract<Command, { type: "list_cards" | "submit_card" }>,
        cdp: CdpSession,
        deadlineAt: number,
      ): Promise<Event>;
    }
  ).executeCardCommand(command, cdp, deadlineAt);
}

const SUBMIT_CARD: SubmitCardCommand = {
  type: "submit_card",
  commandId: "card-command",
  cardAlias: "work",
  numberRef: "number",
  expiry: { kind: "split", monthRef: "month", yearRef: "year" },
  cvvRef: "cvv",
  cardholderNameRef: "name",
  submitRef: "submit",
};

const STORED_CARD = {
  alias: "work",
  cardholderName: "Ada Lovelace",
  pan: "4111111111111111",
  expiryMonth: "12",
  expiryYear: "2099",
  cvv: "123",
} as ValidatedPaymentCard;

function paymentHost(options: {
  aliases?: string[];
  origins?: string[];
  read?: () => Promise<typeof STORED_CARD | null>;
} = {}): RuntimeHost & { enterSensitive: ReturnType<typeof vi.fn> } {
  const runtimeHost = host();
  const enterSensitive = vi.fn(async (runtime: SessionRuntime) => {
    runtime.assignment.sensitive = true;
  });
  const read = options.read ?? vi.fn(async () => STORED_CARD);
  return {
    ...runtimeHost,
    paymentVault: () => ({
      summary: vi.fn(async () => ({
        aliases: options.aliases ?? ["work"],
        approvedOrigins: options.origins ?? ["https://example.com"],
      })),
      authorizePayment: vi.fn(async (alias: string, origin: string) => {
        const card = await read();
        return card === null || alias !== "work" || origin !== "https://example.com"
          ? null
          : { alias, origin, revision: 0, card };
      }),
      paymentAuthorizationStillValid: vi.fn(async () => true),
    }),
    enterSensitive,
  };
}

describe("SessionRuntime close fencing", () => {
  it("never downgrades release or discard cleanup ownership", () => {
    stubBrowser(async () => {});
    const release = new SessionRuntime(
      { ...ASSIGNMENT, cleanupIntent: "release" },
      host(),
    );
    release.beginCleanup("recover");
    expect(release.assignment.cleanupIntent).toBe("release");

    const discard = new SessionRuntime(
      { ...ASSIGNMENT, cleanupIntent: "discard" },
      host(),
    );
    discard.beginCleanup("release");
    expect(discard.assignment.cleanupIntent).toBe("discard");
  });

  it("does not let an intentional debugger detach revoke ownership before tab removal", async () => {
    let confirmRemoval!: () => void;
    stubBrowser(
      () =>
        new Promise<void>((resolve) => {
          confirmRemoval = resolve;
        }),
    );
    const runtimeHost = host();
    const runtime = new SessionRuntime(ASSIGNMENT, runtimeHost);

    const closing = runtime.close(true);
    await runtime.onDebuggerDetach();
    expect(runtimeHost.onFenced).not.toHaveBeenCalled();
    confirmRemoval();
    await expect(closing).resolves.toBe(true);
  });

  it("uses one physical-window closure for concurrent sensitive teardown", async () => {
    let confirmRemoval!: () => void;
    let markRemovalStarted!: () => void;
    const removalStarted = new Promise<void>((resolve) => {
      markRemovalStarted = resolve;
    });
    const remove = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          markRemovalStarted();
          confirmRemoval = resolve;
        }),
    );
    stubBrowser(remove);
    const runtime = new SessionRuntime(ASSIGNMENT, host());

    const first = runtime.closeSensitiveTab();
    await removalStarted;
    const second = runtime.closeSensitiveTab();
    expect(remove).toHaveBeenCalledOnce();
    confirmRemoval();

    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(remove).toHaveBeenCalledOnce();
  });

  it("refuses to confirm cleanup when Chrome reports the owned window still exists", async () => {
    stubBrowser(
      async () => {
        throw new Error("remove failed");
      },
      vi.fn(async () => [{ id: ASSIGNMENT.windowId }]),
    );
    const runtime = new SessionRuntime(ASSIGNMENT, host());

    await expect(runtime.close(true)).resolves.toBe(false);
  });

  it("fails closed when Chrome cannot enumerate windows after removal fails", async () => {
    stubBrowser(
      async () => {
        throw new Error("remove failed");
      },
      vi.fn(async () => {
        throw new Error("window inventory unavailable");
      }),
    );
    const runtime = new SessionRuntime(ASSIGNMENT, host());

    await expect(runtime.close(true)).resolves.toBe(false);
  });
});

describe("SessionRuntime dialog handling", () => {
  it("answers Page.handleJavaScriptDialog without waiting for a stalled outbox write", async () => {
    let markSetStarted!: () => void;
    const setStarted = new Promise<void>((resolve) => {
      markSetStarted = resolve;
    });
    let releaseSet!: () => void;
    const setBlocked = new Promise<void>((resolve) => {
      releaseSet = resolve;
    });
    const values: Record<string, unknown> = {};
    const storage: SessionStorageArea = {
      get: vi.fn(async (key: string) => ({ [key]: values[key] })),
      set: vi.fn(async (items: Record<string, unknown>) => {
        markSetStarted();
        await setBlocked;
        Object.assign(values, items);
      }),
      remove: vi.fn(async (key: string) => {
        delete values[key];
      }),
    };
    stubBrowser(async () => {}, vi.fn(), storage);
    const runtime = new SessionRuntime(ASSIGNMENT, host());
    const cdpSend = vi.fn(async () => {});
    const send = vi.fn();
    Object.assign(runtime, {
      cdp: {
        currentUrl: "https://example.com/",
        mainFrameId: "main",
        send: cdpSend,
      },
      send,
    });

    const handling = runtime.onCdpEvent("Page.javascriptDialogOpening", {
      type: "confirm",
      message: "Continue?",
      url: "https://example.com/",
    });
    await setStarted;

    expect(cdpSend).toHaveBeenCalledWith("Page.handleJavaScriptDialog", {
      accept: false,
    });
    expect(send).not.toHaveBeenCalled();

    releaseSet();
    await handling;
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "dialog",
        dialogType: "confirm",
        disposition: "dismiss",
      }),
    );
  });
});

describe("SessionRuntime payment boundary", () => {
  it("returns preflight not-started results without entering sensitive teardown", async () => {
    const values: Record<string, unknown> = {};
    const storage: SessionStorageArea = {
      get: vi.fn(async (key: string) => ({ [key]: values[key] })),
      set: vi.fn(async (items: Record<string, unknown>) => {
        Object.assign(values, items);
      }),
      remove: vi.fn(async (key: string) => {
        delete values[key];
      }),
    };
    stubBrowser(async () => {}, vi.fn(), storage);
    const runtimeHost = paymentHost();
    const runtime = new SessionRuntime(ASSIGNMENT, runtimeHost);
    const peerSend = vi.fn(() => true);
    Object.assign(runtime, {
      cdp: {
        currentUrl: "https://example.com/checkout",
      },
      peer: { send: peerSend },
    });
    const command = { ...SUBMIT_CARD, cvvRef: SUBMIT_CARD.numberRef };
    await runtime.journal.prepare({
      attemptId: "preflight-attempt",
      commandId: command.commandId,
      requestFingerprint: "c".repeat(64),
      leaseId: ASSIGNMENT.leaseId,
      leaseEpoch: ASSIGNMENT.leaseEpoch,
      browserEpoch: ASSIGNMENT.browserEpoch,
    });

    await (
      runtime as unknown as {
        executeWrite(frame: Extract<SessionServerFrame, { type: "write_grant" }>): Promise<void>;
      }
    ).executeWrite({
      type: "write_grant",
      attemptId: "preflight-attempt",
      deadlineAt: new Date(Date.now() + 10_000).toISOString(),
      leaseId: ASSIGNMENT.leaseId,
      leaseEpoch: ASSIGNMENT.leaseEpoch,
      browserEpoch: ASSIGNMENT.browserEpoch,
      command,
    });

    expect(runtimeHost.enterSensitive).not.toHaveBeenCalled();
    expect(runtimeHost.prepareSensitiveComplete).not.toHaveBeenCalled();
    expect(peerSend).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          type: "card_submission_result",
          status: "not_started",
          reason: "invalid_mapping",
        }),
      }),
    );
    await expect(runtime.journal.get("preflight-attempt")).resolves.toMatchObject({
      state: "completed_unacked",
    });
  });

  it("updates internal navigation fences without emitting page data in sensitive mode", async () => {
    stubBrowser(async () => {});
    const runtimeHost = paymentHost();
    const runtime = new SessionRuntime(ASSIGNMENT, runtimeHost);
    const bumpGeneration = vi.fn(async () => 2);
    const peerSend = vi.fn();
    const cdp = {
      currentUrl: "https://example.com/checkout",
      mainFrameId: "main",
      markLoadStarted: vi.fn(),
      bumpGeneration,
      notifyLoadEventFired: vi.fn(),
    };
    Object.assign(runtime, {
      sensitive: true,
      cdp,
      peer: { send: peerSend },
    });

    await runtime.onCdpEvent("Page.frameNavigated", {
      frame: { id: "main", url: "https://example.com/changed" },
    });

    expect(cdp.currentUrl).toBe("https://example.com/changed");
    expect(bumpGeneration).toHaveBeenCalledOnce();
    expect(peerSend).not.toHaveBeenCalled();
    expect(runtimeHost.onTabChanged).not.toHaveBeenCalled();
  });

  it("rejects duplicate mappings, unapproved origins, and stale refs before sensitive mode", async () => {
    stubBrowser(async () => {});
    const runtimeHost = paymentHost();
    const runtime = new SessionRuntime(ASSIGNMENT, runtimeHost);
    const cdp = {
      currentUrl: "https://example.com/checkout",
      hasCurrentRefs: vi.fn(() => true),
    } as unknown as CdpSession;

    await expect(
      executeCard(runtime, { ...SUBMIT_CARD, cvvRef: SUBMIT_CARD.numberRef }, cdp),
    ).resolves.toMatchObject({ status: "not_started", reason: "invalid_mapping" });
    await expect(
      executeCard(
        new SessionRuntime(ASSIGNMENT, paymentHost({ origins: ["https://other.example"] })),
        SUBMIT_CARD,
        cdp,
      ),
    ).resolves.toMatchObject({ status: "not_started", reason: "origin_not_approved" });
    await expect(
      executeCard(
        new SessionRuntime(ASSIGNMENT, paymentHost()),
        SUBMIT_CARD,
        { ...cdp, hasCurrentRefs: vi.fn(() => false) } as unknown as CdpSession,
      ),
    ).resolves.toMatchObject({ status: "not_started", reason: "stale_ref" });
    expect(runtimeHost.enterSensitive).not.toHaveBeenCalled();
  });

  it("enters sensitive mode before decrypting, fills split expiry, and stops observation", async () => {
    const removed = vi.fn(async () => {});
    stubBrowser(removed);
    const order: string[] = [];
    const runtimeHost = paymentHost({
      read: vi.fn(async () => {
        order.push("decrypt");
        return STORED_CARD;
      }),
    });
    runtimeHost.enterSensitive.mockImplementation(async () => {
      order.push("sensitive");
    });
    const submitSensitiveFields = vi.fn(
      async (
        fields: Array<{ ref: string; text: string }>,
        submitRef: string,
        expectedOrigin: string,
        onBeforeInsert: () => void,
        onBeforeSubmit: () => void,
      ) => {
        order.push("fill");
        expect(fields).toEqual([
          { ref: "name", text: "Ada Lovelace" },
          { ref: "number", text: "4111111111111111" },
          { ref: "month", text: "12" },
          { ref: "year", text: "2099" },
          { ref: "cvv", text: "123" },
        ]);
        expect(submitRef).toBe("submit");
        expect(expectedOrigin).toBe("https://example.com");
        onBeforeInsert();
        onBeforeSubmit();
        return {
          stale: false,
          originMismatch: false,
          cardBytesMayHaveBeenInserted: true,
          submissionAttempted: true,
        };
      },
    );
    const detach = vi.fn(async () => {});
    const cdp = {
      currentUrl: "https://example.com/checkout",
      hasCurrentRefs: vi.fn(() => true),
      pinSensitiveOrigin: vi.fn(() => order.push("pin")),
      stopPendingSensitiveNavigation: vi.fn(async () => {
        order.push("stop-navigation");
        return true;
      }),
      submitSensitiveFields,
      detach,
    } as unknown as CdpSession;

    await expect(
      executeCard(new SessionRuntime(ASSIGNMENT, runtimeHost), SUBMIT_CARD, cdp),
    ).resolves.toEqual({
      type: "card_submission_result",
      commandId: "card-command",
      status: "outcome_unknown",
      reason: "submission_attempted",
    });
    expect(order).toEqual([
      "pin",
      "sensitive",
      "stop-navigation",
      "decrypt",
      "fill",
    ]);
    expect(detach).toHaveBeenCalledOnce();
    expect(removed).not.toHaveBeenCalled();
  });

  it("closes the tab and never starts filling when the grant expires during decryption", async () => {
    vi.useFakeTimers();
    const removed = vi.fn(async () => {});
    stubBrowser(removed);
    let markReadStarted!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve;
    });
    let releaseRead!: (card: typeof STORED_CARD) => void;
    const pendingRead = new Promise<typeof STORED_CARD>((resolve) => {
      releaseRead = resolve;
    });
    const runtimeHost = paymentHost({
      read: vi.fn(() => {
        markReadStarted();
        return pendingRead;
      }),
    });
    const submitSensitiveFields = vi.fn();
    const detach = vi.fn(async () => {});
    const cdp = {
      currentUrl: "https://example.com/checkout",
      hasCurrentRefs: vi.fn(() => true),
      pinSensitiveOrigin: vi.fn(),
      stopPendingSensitiveNavigation: vi.fn(async () => true),
      submitSensitiveFields,
      detach,
    } as unknown as CdpSession;
    const runtime = new SessionRuntime(ASSIGNMENT, runtimeHost);
    const result = executeCard(
      runtime,
      SUBMIT_CARD,
      cdp,
      Date.now() + 100,
    );
    await readStarted;

    await vi.advanceTimersByTimeAsync(100);
    await expect(result).resolves.toEqual({
      type: "card_submission_result",
      commandId: "card-command",
      status: "not_started",
      reason: "input_failed",
    });
    expect(removed).toHaveBeenCalledWith(ASSIGNMENT.windowId);
    await expect(runtime.closeSensitiveTab()).resolves.toBe(true);
    expect(removed).toHaveBeenCalledOnce();
    expect(submitSensitiveFields).not.toHaveBeenCalled();

    releaseRead(STORED_CARD);
    await Promise.resolve();
    await Promise.resolve();
    expect(submitSensitiveFields).not.toHaveBeenCalled();
    expect(detach).toHaveBeenCalledOnce();
    expect(removed).toHaveBeenCalledOnce();
  });

  it("rejects a card that expires while its sensitive submission waits in the CDP queue", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-31T23:59:59.999Z"));
    stubBrowser(async () => {});
    const expiringCard = {
      ...STORED_CARD,
      expiryMonth: "08",
      expiryYear: "2026",
    } as ValidatedPaymentCard;
    const cdp = {
      currentUrl: "https://example.com/checkout",
      hasCurrentRefs: vi.fn(() => true),
      pinSensitiveOrigin: vi.fn(),
      stopPendingSensitiveNavigation: vi.fn(async () => true),
      submitSensitiveFields: vi.fn(
        async (
          _fields: unknown,
          _submitRef: string,
          _expectedOrigin: string,
          _onBeforeInsert: () => void,
          _onBeforeSubmit: () => void,
          canBeginInsertion: () => boolean | Promise<boolean>,
        ) => {
          await vi.advanceTimersByTimeAsync(1);
          await expect(canBeginInsertion()).resolves.toBe(false);
          return {
            stale: false,
            originMismatch: false,
            cardBytesMayHaveBeenInserted: false,
            submissionAttempted: false,
            insertionRefused: true as const,
          };
        },
      ),
      detach: vi.fn(async () => {}),
    } as unknown as CdpSession;

    await expect(
      executeCard(
        new SessionRuntime(
          ASSIGNMENT,
          paymentHost({ read: vi.fn(async () => expiringCard) }),
        ),
        SUBMIT_CARD,
        cdp,
      ),
    ).resolves.toMatchObject({ status: "not_started", reason: "card_not_found" });
  });

  it("distinguishes failures before insertion from failures after insertion", async () => {
    stubBrowser(async () => {});
    const before = {
      currentUrl: "https://example.com/checkout",
      hasCurrentRefs: vi.fn(() => true),
      pinSensitiveOrigin: vi.fn(),
      stopPendingSensitiveNavigation: vi.fn(async () => true),
      submitSensitiveFields: vi.fn(async () => ({
        stale: false,
        originMismatch: false,
        cardBytesMayHaveBeenInserted: false,
        submissionAttempted: false,
      })),
      detach: vi.fn(async () => {}),
    } as unknown as CdpSession;
    await expect(
      executeCard(new SessionRuntime(ASSIGNMENT, paymentHost()), SUBMIT_CARD, before),
    ).resolves.toMatchObject({ status: "not_started", reason: "input_failed" });
    vi.mocked(before.submitSensitiveFields).mockClear();
    await expect(
      executeCard(
        new SessionRuntime(
          ASSIGNMENT,
          paymentHost({
            read: vi.fn(async () => {
              throw new CardVaultExpiredError("expired");
            }),
          }),
        ),
        SUBMIT_CARD,
        before,
      ),
    ).resolves.toMatchObject({ status: "not_started", reason: "card_not_found" });
    expect(before.submitSensitiveFields).not.toHaveBeenCalled();

    const changedOrigin = {
      ...before,
      submitSensitiveFields: vi.fn(async () => ({
        stale: false,
        originMismatch: true,
        cardBytesMayHaveBeenInserted: false,
        submissionAttempted: false,
      })),
    } as unknown as CdpSession;
    await expect(
      executeCard(
        new SessionRuntime(ASSIGNMENT, paymentHost()),
        SUBMIT_CARD,
        changedOrigin,
      ),
    ).resolves.toMatchObject({
      status: "not_started",
      reason: "origin_not_approved",
    });

    const after = {
      currentUrl: "https://example.com/checkout",
      hasCurrentRefs: vi.fn(() => true),
      submitSensitiveFields: vi.fn(
        async (
          _fields: unknown,
          _submitRef: string,
          _expectedOrigin: string,
          onBeforeInsert: () => void,
        ) => {
          onBeforeInsert();
          throw new Error("page-derived synthetic marker");
        },
      ),
      pinSensitiveOrigin: vi.fn(),
      stopPendingSensitiveNavigation: vi.fn(async () => true),
      detach: vi.fn(async () => {}),
    } as unknown as CdpSession;
    await expect(
      executeCard(new SessionRuntime(ASSIGNMENT, paymentHost()), SUBMIT_CARD, after),
    ).resolves.toEqual({
      type: "card_submission_result",
      commandId: "card-command",
      status: "outcome_unknown",
      reason: "input_failed",
    });
  });

  it("formats combined expiry without returning card data", async () => {
    stubBrowser(async () => {});
    let fields: Array<{ ref: string; text: string }> = [];
    const cdp = {
      currentUrl: "https://example.com/checkout",
      hasCurrentRefs: vi.fn(() => true),
      pinSensitiveOrigin: vi.fn(),
      stopPendingSensitiveNavigation: vi.fn(async () => true),
      submitSensitiveFields: vi.fn(async (mapped: Array<{ ref: string; text: string }>) => {
        fields = mapped;
        return {
          stale: false,
          originMismatch: false,
          cardBytesMayHaveBeenInserted: false,
          submissionAttempted: false,
        };
      }),
      detach: vi.fn(async () => {}),
    } as unknown as CdpSession;
    const result = await executeCard(
      new SessionRuntime(ASSIGNMENT, paymentHost()),
      {
        ...SUBMIT_CARD,
        expiry: { kind: "combined", ref: "expiry" },
        cardholderNameRef: undefined,
      },
      cdp,
    );
    expect(fields).toEqual([
      { ref: "number", text: "4111111111111111" },
      { ref: "expiry", text: "12/99" },
      { ref: "cvv", text: "123" },
    ]);
    expect(JSON.stringify(result)).not.toContain("4111111111111111");
    expect(JSON.stringify(result)).not.toContain("123");
  });

  it("persists the fixed result and closes the tab before replying", async () => {
    const values: Record<string, unknown> = {};
    const storage: SessionStorageArea = {
      get: vi.fn(async (key: string) => ({ [key]: values[key] })),
      set: vi.fn(async (items: Record<string, unknown>) => {
        Object.assign(values, items);
      }),
      remove: vi.fn(async (key: string) => {
        delete values[key];
      }),
    };
    const removed = vi.fn(async () => {});
    stubBrowser(removed, vi.fn(), storage);
    const order: string[] = [];
    const runtimeHost = paymentHost();
    runtimeHost.prepareSensitiveComplete = vi.fn(async (runtime: SessionRuntime) => {
      expect((await runtime.journal.get("attempt-1"))?.state).toBe("completed_unacked");
      order.push("durable-cleanup");
      return runtime.closeSensitiveTab();
    });
    runtimeHost.finalizeSensitiveComplete = vi.fn(async () => {
      order.push("finalize");
    });
    const runtime = new SessionRuntime(ASSIGNMENT, runtimeHost);
    const peerSend = vi.fn(() => {
      order.push("reply");
      return true;
    });
    Object.assign(runtime, {
      cdp: {
        currentUrl: "https://example.com/checkout",
        hasCurrentRefs: vi.fn(() => true),
        pinSensitiveOrigin: vi.fn(),
        stopPendingSensitiveNavigation: vi.fn(async () => true),
        submitSensitiveFields: vi.fn(
          async (
            _fields: unknown,
            _submitRef: string,
            _expectedOrigin: string,
            onBeforeInsert: () => void,
            onBeforeSubmit: () => void,
          ) => {
            onBeforeInsert();
            onBeforeSubmit();
            return {
              stale: false,
              originMismatch: false,
              cardBytesMayHaveBeenInserted: true,
              submissionAttempted: true,
            };
          },
        ),
        detach: vi.fn(async () => {}),
      },
      peer: { send: peerSend },
    });
    await runtime.journal.prepare({
      attemptId: "attempt-1",
      commandId: SUBMIT_CARD.commandId,
      requestFingerprint: "a".repeat(64),
      leaseId: ASSIGNMENT.leaseId,
      leaseEpoch: ASSIGNMENT.leaseEpoch,
      browserEpoch: ASSIGNMENT.browserEpoch,
    });

    await (
      runtime as unknown as {
        executeWrite(frame: Extract<SessionServerFrame, { type: "write_grant" }>): Promise<void>;
      }
    ).executeWrite({
      type: "write_grant",
      attemptId: "attempt-1",
      deadlineAt: new Date(Date.now() + 10_000).toISOString(),
      leaseId: ASSIGNMENT.leaseId,
      leaseEpoch: ASSIGNMENT.leaseEpoch,
      browserEpoch: ASSIGNMENT.browserEpoch,
      command: SUBMIT_CARD,
    });

    expect(order).toEqual(["durable-cleanup", "reply", "finalize"]);
    expect(removed).toHaveBeenCalledWith(ASSIGNMENT.windowId);
    expect(peerSend).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          type: "card_submission_result",
          status: "outcome_unknown",
        }),
      }),
    );
  });

  it("forces sensitive cleanup when fixed-result journaling fails", async () => {
    const values: Record<string, unknown> = {};
    const storage: SessionStorageArea = {
      get: vi.fn(async (key: string) => ({ [key]: values[key] })),
      set: vi.fn(async (items: Record<string, unknown>) => {
        const records = Object.values(items)[0];
        if (
          Array.isArray(records) &&
          records.some((record) =>
            typeof record === "object" &&
            record !== null &&
            (record as { state?: unknown }).state === "completed_unacked"
          )
        ) {
          throw new Error("journal persist failed");
        }
        Object.assign(values, items);
      }),
      remove: vi.fn(async () => {}),
    };
    stubBrowser(async () => {}, vi.fn(), storage);
    const runtimeHost = paymentHost();
    const runtime = new SessionRuntime(ASSIGNMENT, runtimeHost);
    const peerSend = vi.fn();
    Object.assign(runtime, {
      cdp: {
        currentUrl: "https://example.com/checkout",
        hasCurrentRefs: vi.fn(() => true),
        pinSensitiveOrigin: vi.fn(),
        stopPendingSensitiveNavigation: vi.fn(async () => true),
        submitSensitiveFields: vi.fn(async () => ({
          stale: false,
          originMismatch: false,
          cardBytesMayHaveBeenInserted: false,
          submissionAttempted: false,
        })),
        detach: vi.fn(async () => {}),
      },
      peer: { send: peerSend },
    });
    await runtime.journal.prepare({
      attemptId: "attempt-journal-failure",
      commandId: SUBMIT_CARD.commandId,
      requestFingerprint: "b".repeat(64),
      leaseId: ASSIGNMENT.leaseId,
      leaseEpoch: ASSIGNMENT.leaseEpoch,
      browserEpoch: ASSIGNMENT.browserEpoch,
    });

    await (
      runtime as unknown as {
        executeWrite(frame: Extract<SessionServerFrame, { type: "write_grant" }>): Promise<void>;
      }
    ).executeWrite({
      type: "write_grant",
      attemptId: "attempt-journal-failure",
      deadlineAt: new Date(Date.now() + 10_000).toISOString(),
      leaseId: ASSIGNMENT.leaseId,
      leaseEpoch: ASSIGNMENT.leaseEpoch,
      browserEpoch: ASSIGNMENT.browserEpoch,
      command: SUBMIT_CARD,
    });

    expect(runtimeHost.abortSensitive).toHaveBeenCalledWith(runtime);
    expect(peerSend).not.toHaveBeenCalled();
    await expect(runtime.journal.get("attempt-journal-failure")).resolves.toMatchObject({
      state: "unknown",
    });
  });
});
