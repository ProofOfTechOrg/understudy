import { describe, expect, it, vi } from "vitest";
import type { DialogRecord } from "@understudy/protocol";
import type { SessionStorageArea } from "./dedupe";
import { DialogOutbox, handleDialogWithOutbox } from "./dialog-outbox";

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

  it("retains two concurrently added records in arrival order", async () => {
    const storage = new MemoryStorage();
    const outbox = new DialogOutbox(storage, "dialogs");
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    storage.set.mockImplementationOnce(async (items) => {
      markStarted();
      await blocked;
      Object.assign(storage.values, items);
    });

    const first = outbox.add(dialog(1));
    await started;
    const second = outbox.add(dialog(2));
    release();

    await expect(Promise.all([first, second])).resolves.toEqual(["ok", "ok"]);
    expect(await outbox.pending()).toEqual([dialog(1), dialog(2)]);
  });

  it("serializes concurrent add, ACK, clear, and later add operations", async () => {
    const storage = new MemoryStorage();
    const outbox = new DialogOutbox(storage, "dialogs");
    await outbox.add(dialog(0));
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    storage.set.mockImplementationOnce(async (items) => {
      markStarted();
      await blocked;
      Object.assign(storage.values, items);
    });

    const firstAdd = outbox.add(dialog(1));
    await started;
    const acknowledge = outbox.acknowledge("dialog-0");
    const clear = outbox.clear();
    const finalAdd = outbox.add(dialog(2));
    release();

    await Promise.all([firstAdd, acknowledge, clear, finalAdd]);
    expect(await outbox.pending()).toEqual([dialog(2)]);
  });

  it("continues queued operations after one rejects", async () => {
    const storage = new MemoryStorage();
    const outbox = new DialogOutbox(storage, "dialogs");
    await outbox.add(dialog(1));
    storage.set.mockRejectedValueOnce(new Error("storage unavailable"));

    const acknowledge = outbox.acknowledge("dialog-1");
    const add = outbox.add(dialog(2));

    await expect(acknowledge).rejects.toThrow("storage unavailable");
    await expect(add).resolves.toBe("ok");
    expect(await outbox.pending()).toEqual([dialog(1), dialog(2)]);
  });
});

describe("handleDialogWithOutbox", () => {
  it("delivers overflow only after the browser answer settles", async () => {
    const storage = new MemoryStorage();
    storage.set.mockRejectedValueOnce(new Error("storage unavailable"));
    const outbox = new DialogOutbox(storage, "dialogs");
    let finishAnswer!: () => void;
    const answer = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishAnswer = resolve;
        }),
    );
    const deliver = vi.fn();

    const handled = handleDialogWithOutbox(
      outbox,
      dialog(1),
      answer,
      deliver,
    );
    await vi.waitFor(() => expect(storage.set).toHaveBeenCalled());
    expect(answer).toHaveBeenCalledOnce();
    expect(deliver).not.toHaveBeenCalled();

    finishAnswer();
    await handled;
    expect(deliver).toHaveBeenCalledWith("overflow");
  });

  it("delivers the persisted record even when the browser answer fails", async () => {
    const storage = new MemoryStorage();
    const deliver = vi.fn();

    await expect(
      handleDialogWithOutbox(
        new DialogOutbox(storage, "dialogs"),
        dialog(1),
        async () => {
          throw new Error("CDP failed");
        },
        deliver,
      ),
    ).rejects.toThrow("CDP failed");
    expect(deliver).toHaveBeenCalledWith("ok");
  });
});
