import type { Event } from "@understudy/protocol";
import type { SessionStorageArea } from "./dedupe";

export type WriteJournalState =
  | "prepared"
  | "started"
  | "completed_unacked"
  | "unknown";

export interface WriteJournalRecord {
  attemptId: string;
  commandId: string;
  requestFingerprint: string;
  state: WriteJournalState;
  leaseId?: string;
  leaseEpoch?: number;
  browserEpoch?: string;
  attachmentId?: string;
  event?: Event;
}

export class WriteJournal {
  private records: WriteJournalRecord[] | null = null;

  constructor(
    private readonly storage: SessionStorageArea,
    private readonly storageKey: string,
  ) {}

  async prepare(record: Omit<WriteJournalRecord, "state" | "event">): Promise<void> {
    await this.hydrate();
    const existing = this.find(record.attemptId);
    if (existing !== undefined) {
      if (
        existing.commandId !== record.commandId ||
        existing.requestFingerprint !== record.requestFingerprint
      ) {
        throw new Error("attempt journal conflict");
      }
      return;
    }
    await this.persist([...(this.records ?? []), { ...record, state: "prepared" }]);
  }

  async markStarted(attemptId: string): Promise<void> {
    await this.transition(attemptId, "prepared", "started");
  }

  async markCompleted(attemptId: string, event: Event): Promise<void> {
    await this.hydrate();
    const records = this.records ?? [];
    const current = records.find((record) => record.attemptId === attemptId);
    if (current === undefined || current.state !== "started") {
      throw new Error("write was not durably started");
    }
    await this.persist(
      records.map((record) =>
        record.attemptId === attemptId
          ? {
              ...record,
              state: "completed_unacked" as const,
              event: journalSafeEvent(event),
            }
          : record,
      ),
    );
  }

  async markUnknown(attemptId: string): Promise<void> {
    await this.hydrate();
    const records = this.records ?? [];
    const current = records.find((record) => record.attemptId === attemptId);
    if (current === undefined || current.state === "completed_unacked") return;
    await this.persist(
      records.map((record) =>
        record.attemptId === attemptId
          ? { ...record, state: "unknown" as const, event: undefined }
          : record,
      ),
    );
  }

  async cancelPrepared(attemptId: string): Promise<void> {
    await this.hydrate();
    const records = this.records ?? [];
    const current = records.find((record) => record.attemptId === attemptId);
    if (current?.state !== "prepared") return;
    await this.persist(records.filter((record) => record.attemptId !== attemptId));
  }

  async acknowledge(attemptId: string): Promise<void> {
    await this.hydrate();
    const records = this.records ?? [];
    const current = records.find((record) => record.attemptId === attemptId);
    if (current?.state !== "completed_unacked") return;
    await this.persist(records.filter((record) => record.attemptId !== attemptId));
  }

  async get(attemptId: string): Promise<WriteJournalRecord | undefined> {
    await this.hydrate();
    return this.find(attemptId);
  }

  async recover(): Promise<WriteJournalRecord[]> {
    await this.hydrate();
    return [...(this.records ?? [])];
  }

  async clear(): Promise<void> {
    await this.persist([]);
  }

  private async transition(
    attemptId: string,
    expected: WriteJournalState,
    next: WriteJournalState,
  ): Promise<void> {
    await this.hydrate();
    const records = this.records ?? [];
    const current = records.find((record) => record.attemptId === attemptId);
    if (current === undefined || current.state !== expected) {
      throw new Error(`write journal transition ${expected} -> ${next} rejected`);
    }
    await this.persist(
      records.map((record) =>
        record.attemptId === attemptId ? { ...record, state: next } : record,
      ),
    );
  }

  private find(attemptId: string): WriteJournalRecord | undefined {
    return (this.records ?? []).find((record) => record.attemptId === attemptId);
  }

  private async hydrate(): Promise<void> {
    if (this.records !== null) return;
    const stored = await this.storage.get(this.storageKey);
    const value = stored[this.storageKey];
    this.records = Array.isArray(value) ? (value as WriteJournalRecord[]) : [];
  }

  private async persist(records: WriteJournalRecord[]): Promise<void> {
    await this.storage.set({ [this.storageKey]: records });
    this.records = records;
  }
}

function journalSafeEvent(event: Event): Event {
  if (event.type === "card_submission_result") {
    return {
      type: "card_submission_result",
      commandId: event.commandId,
      status: event.status,
      reason: event.reason,
    };
  }
  if (event.type !== "action_result") throw new Error("unsupported write result");
  return {
    type: "action_result",
    commandId: event.commandId,
    ok: event.ok,
    ...(event.error === undefined ? {} : { error: "browser action failed" }),
    ...(event.simulated === undefined ? {} : { simulated: event.simulated }),
  };
}
