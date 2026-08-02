import { afterEach, describe, expect, it, vi } from "vitest";
import { closeWindowAndConfirm } from "./window-lifecycle";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("closeWindowAndConfirm", () => {
  it("confirms a window disappeared when removal reports an ambiguous failure", async () => {
    vi.stubGlobal("browser", {
      windows: {
        remove: vi.fn(async () => {
          throw new Error("window disappeared during removal");
        }),
        getAll: vi.fn(async () => [{ id: 8 }]),
      },
    });

    await expect(closeWindowAndConfirm(7)).resolves.toBe(true);
  });

  it("retains cleanup intent while the physical window still exists", async () => {
    vi.stubGlobal("browser", {
      windows: {
        remove: vi.fn(async () => {
          throw new Error("remove failed");
        }),
        getAll: vi.fn(async () => [{ id: 7 }]),
      },
    });

    await expect(closeWindowAndConfirm(7)).resolves.toBe(false);
  });
});
