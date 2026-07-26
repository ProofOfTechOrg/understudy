import { DialogRecordSchema, type DialogRecord } from "@understudy/protocol";
import type { SessionStorageArea } from "./dedupe";

const MAX_RECORDS = 256;
const MAX_BYTES = 256 * 1024;

export class DialogOutbox {
  private records: DialogRecord[] | null = null;

  constructor(
    private readonly storage: SessionStorageArea,
    private readonly storageKey: string,
  ) {}

  async add(record: DialogRecord): Promise<"ok" | "overflow"> {
    try {
      const parsed = DialogRecordSchema.safeParse(record);
      if (!parsed.success) return "overflow";
      await this.hydrate();
      const existing = this.records ?? [];
      if (existing.some((item) => item.dialogId === parsed.data.dialogId)) return "ok";
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
  }

  async acknowledge(dialogId: string): Promise<void> {
    await this.hydrate();
    await this.persist((this.records ?? []).filter((record) => record.dialogId !== dialogId));
  }

  async pending(): Promise<DialogRecord[]> {
    await this.hydrate();
    return [...(this.records ?? [])];
  }

  async clear(): Promise<void> {
    await this.persist([]);
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
