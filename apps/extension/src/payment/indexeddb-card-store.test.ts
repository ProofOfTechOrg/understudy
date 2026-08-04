import { afterEach, describe, expect, it, vi } from "vitest";
import { IndexedDbCardVaultStore } from "./indexeddb-card-store";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("IndexedDbCardVaultStore database lifecycle", () => {
  it("closes a late blocked open and retries instead of caching the rejection", async () => {
    const close = vi.fn();
    const first = {} as IDBOpenDBRequest;
    const second = {} as IDBOpenDBRequest;
    Object.defineProperties(first, {
      result: { value: { close }, configurable: true },
      error: { value: null, configurable: true },
    });
    Object.defineProperty(second, "error", {
      value: new DOMException("unavailable", "UnknownError"),
      configurable: true,
    });
    const open = vi
      .fn()
      .mockImplementationOnce(() => first)
      .mockImplementationOnce(() => second);
    vi.stubGlobal("indexedDB", { open });
    const store = new IndexedDbCardVaultStore();

    const blocked = store.getKey();
    first.onblocked?.(new Event("blocked") as IDBVersionChangeEvent);
    await expect(blocked).rejects.toThrow(/upgrade blocked/);
    first.onsuccess?.(new Event("success"));
    expect(close).toHaveBeenCalledOnce();

    const retried = store.getKey();
    second.onerror?.(new Event("error"));
    await expect(retried).rejects.toThrow(/unavailable/);
    expect(open).toHaveBeenCalledTimes(2);
  });
});
