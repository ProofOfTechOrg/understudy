import { describe, expect, it, vi } from "vitest";
import type { DialogRecord } from "@understudy/protocol";
import type { SessionStorageArea } from "./dedupe";
import { DialogOutbox } from "./dialog-outbox";

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

function dialog(index: number, message = "Confirm?"): DialogRecord {
  return {
    dialogId: `dialog-${index}`,
    occurredAt: "2026-07-26T00:00:00.000Z",
    tabId: 7,
    dialogType: "confirm",
    message,
    url: "https://example.com/",
    disposition: "dismiss",
  };
}

describe("DialogOutbox", () => {
  it("persists before delivery and removes a record only after ACK", async () => {
    const storage = new MemoryStorage();
    const outbox = new DialogOutbox(storage, "dialogs");

    await expect(outbox.add(dialog(1))).resolves.toBe("ok");
    expect(await outbox.pending()).toEqual([dialog(1)]);
    await outbox.acknowledge("dialog-1");
    expect(await outbox.pending()).toEqual([]);
  });

  it("deduplicates dialog IDs and reports persistence failures as overflow", async () => {
    const storage = new MemoryStorage();
    const outbox = new DialogOutbox(storage, "dialogs");
    await outbox.add(dialog(1));
    await outbox.add(dialog(1));
    expect(await outbox.pending()).toHaveLength(1);

    storage.set.mockRejectedValueOnce(new Error("storage unavailable"));
    await expect(outbox.add(dialog(2))).resolves.toBe("overflow");
    expect(await outbox.pending()).toEqual([dialog(1)]);
  });

  it("rejects the 257th pending record without evicting the first 256", async () => {
    const storage = new MemoryStorage();
    const outbox = new DialogOutbox(storage, "dialogs");
    for (let index = 0; index < 256; index += 1) {
      await expect(outbox.add(dialog(index, ""))).resolves.toBe("ok");
    }

    await expect(outbox.add(dialog(256, ""))).resolves.toBe("overflow");
    const pending = await outbox.pending();
    expect(pending).toHaveLength(256);
    expect(pending[0]?.dialogId).toBe("dialog-0");
  });

  it("rejects an oversized dialog before persistence", async () => {
    const storage = new MemoryStorage();
    const outbox = new DialogOutbox(storage, "dialogs");

    await expect(outbox.add(dialog(1, "x".repeat(4 * 1024 + 1)))).resolves.toBe(
      "overflow",
    );
    expect(storage.set).not.toHaveBeenCalled();
    expect(await outbox.pending()).toEqual([]);
  });
});
