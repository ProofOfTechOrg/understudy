import { describe, expect, it, vi } from "vitest";
import { RetryableStartupGate } from "./startup-gate";

describe("RetryableStartupGate", () => {
  it("coalesces callers and blocks downstream work until startup completes", async () => {
    let release!: () => void;
    const start = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const gate = new RetryableStartupGate(start);
    const downstream = vi.fn();

    const first = gate.wait().then(downstream);
    const second = gate.wait();

    expect(start).toHaveBeenCalledOnce();
    expect(downstream).not.toHaveBeenCalled();
    release();
    await Promise.all([first, second]);
    await gate.wait();
    expect(start).toHaveBeenCalledOnce();
    expect(downstream).toHaveBeenCalledOnce();
  });

  it("does not admit downstream work after failure and retries startup", async () => {
    const start = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("cleanup failed"))
      .mockResolvedValue(undefined);
    const gate = new RetryableStartupGate(start);
    const downstream = vi.fn();

    await expect(gate.wait().then(downstream)).rejects.toThrow(
      "cleanup failed",
    );
    expect(downstream).not.toHaveBeenCalled();

    await gate.wait();
    expect(start).toHaveBeenCalledTimes(2);
  });
});
