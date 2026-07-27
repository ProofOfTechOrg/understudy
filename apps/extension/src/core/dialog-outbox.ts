import { DialogRecordSchema, type DialogRecord } from "@understudy/protocol";
import type { SessionStorageArea } from "./dedupe";

const MAX_RECORDS = 256;
const MAX_BYTES = 256 * 1024;

export type DialogDelivery = "ok" | "overflow";

export async function handleDialogWithOutbox(
  outbox: DialogOutbox,
  record: DialogRecord,
  answer: () => Promise<unknown>,
  deliver: (delivery: DialogDelivery) => void,
): Promise<void> {
  const persistence = outbox.add(record);
  try {
    await answer();
  } finally {
    deliver(await persistence);
  }
}

export class DialogOutbox {
  private records: DialogRecord[] | null = null;
  private operationTail: Promise<void> | null = null;

  constructor(
    private readonly storage: SessionStorageArea,
    private readonly storageKey: string,
  ) {}

  add(record: DialogRecord): Promise<DialogDelivery> {
    return this.serialize(async () => {
      try {
        const parsed = DialogRecordSchema.safeParse(record);
        if (!parsed.success) return "overflow";
        await this.hydrate();
        const existing = this.records ?? [];
        if (existing.some((item) => item.dialogId === parsed.data.dialogId)) {
          return "ok";
        }
        const next = [...existing, parsed.data];
        if (
          next.length > MAX_RECORDS ||
          new TextEncoder().encode(JSON.stringify(next)).byteLength > MAX_BYTES
        ) {
          return "overflow";
        }
        await this.persist(next);
        return "ok";
      } catch {
        return "overflow";
      }
    });
  }

  acknowledge(dialogId: string): Promise<void> {
    return this.serialize(async () => {
      await this.hydrate();
      await this.persist(
        (this.records ?? []).filter((record) => record.dialogId !== dialogId),
      );
    });
  }

  pending(): Promise<DialogRecord[]> {
    return this.serialize(async () => {
      await this.hydrate();
      return [...(this.records ?? [])];
    });
  }

  clear(): Promise<void> {
    return this.serialize(() => this.persist([]));
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result =
      this.operationTail === null
        ? operation()
        : this.operationTail.then(operation, operation);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.operationTail = settled;
    void settled.then(() => {
      if (this.operationTail === settled) this.operationTail = null;
    });
    return result;
  }

  private async hydrate(): Promise<void> {
    if (this.records !== null) return;
    const stored = await this.storage.get(this.storageKey);
    const value = stored[this.storageKey];
    this.records = Array.isArray(value) ? (value as DialogRecord[]) : [];
  }

  private async persist(records: DialogRecord[]): Promise<void> {
    await this.storage.set({ [this.storageKey]: records });
    this.records = records;
  }
}
