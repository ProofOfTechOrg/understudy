import { describe, expect, it, vi } from "vitest";
import type { SessionStorageArea } from "./dedupe";
import { WriteJournal } from "./write-journal";

class MemoryStorage implements SessionStorageArea {
  readonly values: Record<string, unknown> = {};
  readonly set = vi.fn(async (items: Record<string, unknown>) => {
    Object.assign(this.values, items);
  });

  async get(key: string): Promise<Record<string, unknown>> {
    return { [key]: this.values[key] };
  }

  async remove(key: string): Promise<void> {
    delete this.values[key];
  }
}

const PREPARED = {
  attemptId: "attempt-1",
  commandId: "command-1",
  requestFingerprint: "a".repeat(64),
};

describe("WriteJournal", () => {
  it("awaits every pre-effect transition and fails closed on storage failure", async () => {
    const storage = new MemoryStorage();
    storage.set.mockRejectedValueOnce(new Error("quota exceeded"));
    const journal = new WriteJournal(storage, "journal");

    await expect(journal.prepare(PREPARED)).rejects.toThrow("quota exceeded");
    expect(storage.values.journal).toBeUndefined();
    await expect(journal.markStarted(PREPARED.attemptId)).rejects.toThrow(
      "write journal transition prepared -> started rejected",
    );
  });

  it("persists prepared, started, and completed-unacknowledged before ACK removal", async () => {
    const storage = new MemoryStorage();
    const journal = new WriteJournal(storage, "journal");

    await journal.prepare(PREPARED);
    await journal.markStarted(PREPARED.attemptId);
    await journal.markCompleted(PREPARED.attemptId, {
      type: "action_result",
      commandId: PREPARED.commandId,
      ok: true,
      url: "https://prior-url.example/",
    });

    expect(await journal.recover()).toEqual([
      {
        ...PREPARED,
        state: "completed_unacked",
        event: {
          type: "action_result",
          commandId: PREPARED.commandId,
          ok: true,
        },
      },
    ]);
    expect(JSON.stringify(storage.values)).not.toContain("prior-url.example");

    await journal.acknowledge(PREPARED.attemptId);
    expect(await journal.recover()).toEqual([]);
  });

  it("never discards unknown tombstones and rejects attempt fingerprint conflicts", async () => {
    const storage = new MemoryStorage();
    const journal = new WriteJournal(storage, "journal");
    await journal.prepare(PREPARED);

    await expect(
      journal.prepare({
        ...PREPARED,
        requestFingerprint: "b".repeat(64),
      }),
    ).rejects.toThrow("attempt journal conflict");

    await journal.markStarted(PREPARED.attemptId);
    await journal.markUnknown(PREPARED.attemptId);
    expect(await journal.recover()).toEqual([{ ...PREPARED, state: "unknown" }]);
    await journal.acknowledge(PREPARED.attemptId);
    expect(await journal.recover()).toEqual([{ ...PREPARED, state: "unknown" }]);
  });

  it("does not persist action errors that may contain refs or URLs", async () => {
    const storage = new MemoryStorage();
    const journal = new WriteJournal(storage, "journal");
    await journal.prepare(PREPARED);
    await journal.markStarted(PREPARED.attemptId);
    await journal.markCompleted(PREPARED.attemptId, {
      type: "action_result",
      commandId: PREPARED.commandId,
      ok: false,
      error: "stale ref secret-ref at https://prior-url.example/",
    });

    expect(await journal.recover()).toMatchObject([
      {
        event: {
          error: "browser action failed",
        },
      },
    ]);
    expect(JSON.stringify(storage.values)).not.toContain("secret-ref");
    expect(JSON.stringify(storage.values)).not.toContain("prior-url.example");
  });
});
