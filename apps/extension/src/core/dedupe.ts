import { isWriteCommand } from "@understudy/protocol";
import type { Command, Event } from "@understudy/protocol";

// browser.storage.session's surface, narrowed to what WriteDedupe uses so
// tests can inject a plain in-memory fake.
export interface SessionStorageArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

const STORAGE_KEY = "understudy:completedWrites";
// Matches the service's SessionState.completedWrites cap so the two replay
// windows are symmetric (a retry protected on one layer is protected on both).
const CAP = 100;

interface CompletedWrite {
  commandId: string;
  event: Event;
}

/** What claim() decided for a command: run it, replay a recorded result, or drop a duplicate. */
export type ClaimDecision =
  | { kind: "execute" }
  | { kind: "replay"; event: Event }
  | { kind: "drop" };

/**
 * Extension half of the idempotent-retry contract (the service DO keeps the
 * other half). Two retry hazards, both closed here for WRITE commands:
 *
 * 1. The write already COMPLETED and the service asks for it again (the
 *    service timed out after this extension responded, so its own
 *    completedWrites is empty): claim() returns the recorded Event to replay -
 *    no second execution.
 * 2. The write is STILL EXECUTING when the service times out (deleting its
 *    pending entry) and the consumer retries the same commandId, so the same
 *    command arrives twice: claim() marks the first in-flight and DROPS the
 *    second. The one running execution's response resolves the service's
 *    (retry's) parked promise, so the consumer still gets a real result - once.
 *
 * Reads are never tracked: re-executing them is free and their results go
 * stale by design.
 *
 * The completed record is memory-resident and mirrored to storage.session
 * (survives SW eviction, not a browser restart - matching the session's own
 * lifetime); the in-flight set is memory-only (an execution that dies with the
 * SW SHOULD re-execute on wake). Persistence is best-effort: a lost mirror
 * write degrades a future replay into a re-execution, the pre-dedupe behavior.
 */
export class WriteDedupe {
  private entries: CompletedWrite[] | null = null;
  // Cached so concurrent claims share ONE storage read; a null entries with a
  // live hydration means "a read is in flight, await it".
  private hydration: Promise<void> | null = null;
  private readonly inFlight = new Set<string>();

  constructor(private readonly storage: SessionStorageArea) {}

  /**
   * Atomically classify a command. Reads always execute (untracked). For a
   * write: replay a completed one, drop a still-in-flight duplicate, or mark a
   * fresh one in-flight and tell the caller to execute it. The post-hydration
   * body runs with no `await`, so two concurrent claims for one commandId
   * cannot both pass the in-flight check - exactly one gets `execute`.
   */
  async claim(cmd: Command): Promise<ClaimDecision> {
    if (!isWriteCommand(cmd)) return { kind: "execute" };
    await this.hydrate();
    const entries = this.entries ?? [];
    const recorded = entries.find((entry) => entry.commandId === cmd.commandId);
    if (recorded) return { kind: "replay", event: recorded.event };
    if (this.inFlight.has(cmd.commandId)) return { kind: "drop" };
    this.inFlight.add(cmd.commandId);
    return { kind: "execute" };
  }

  /** Records a claimed write's Event and clears its in-flight mark; capped FIFO. */
  async remember(cmd: Command, event: Event): Promise<void> {
    if (!isWriteCommand(cmd)) return;
    // Only record a write still marked in-flight from its own claim(). A
    // clear() (WS session change) or release() since the claim means this
    // execution spans a session boundary - its result belongs to the OLD
    // session and must not enter the new session's record, or a reused
    // commandId could replay a foreign session's Event.
    if (!this.inFlight.has(cmd.commandId)) return;
    await this.hydrate();
    const entries = this.entries ?? [];
    const next = [
      ...entries.filter((entry) => entry.commandId !== cmd.commandId),
      { commandId: cmd.commandId, event },
    ];
    while (next.length > CAP) next.shift();
    this.entries = next;
    this.inFlight.delete(cmd.commandId);
    try {
      await this.storage.set({ [STORAGE_KEY]: next });
    } catch {
      // Memory copy still serves this SW life; see the class doc.
    }
  }

  /**
   * Releases an in-flight mark without recording - for an execution that ended
   * without a stored result (an unexpected throw before remember). No-op once
   * remember() has already cleared it, so a finally-block release is safe.
   */
  release(cmd: Command): void {
    this.inFlight.delete(cmd.commandId);
  }

  /**
   * Drops the whole record - memory, in-flight, and the storage mirror. Called
   * when the WS target session changes (the sessionId lives in the WS URL): a
   * new session must not inherit the previous one's replay entries, or a reused
   * idempotency key could replay the wrong session's Event.
   */
  async clear(): Promise<void> {
    this.entries = [];
    this.inFlight.clear();
    try {
      await this.storage.remove(STORAGE_KEY);
    } catch {
      // Best-effort; the in-memory reset above is authoritative for this SW life.
    }
  }

  // Storage is read at most once per SW life; the cached promise coalesces
  // concurrent first-callers onto that single read.
  private hydrate(): Promise<void> {
    if (this.entries !== null) return Promise.resolve();
    if (this.hydration === null) {
      this.hydration = (async () => {
        try {
          const stored = await this.storage.get(STORAGE_KEY);
          const value = stored[STORAGE_KEY];
          this.entries = Array.isArray(value) ? (value as CompletedWrite[]) : [];
        } catch {
          this.entries = [];
        }
      })();
    }
    return this.hydration;
  }
}
