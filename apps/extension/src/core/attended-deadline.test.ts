import { afterEach, describe, expect, it, vi } from "vitest";
import { settleBeforeDeadline } from "./attended-deadline";

afterEach(() => {
  vi.useRealTimers();
});

describe("settleBeforeDeadline", () => {
  it("runs attachment cleanup when command execution misses its deadline", async () => {
    vi.useFakeTimers();
    const onDeadline = vi.fn(async () => {});
    const pending = settleBeforeDeadline(
      () => new Promise<string>(() => {}),
      1_000,
      onDeadline,
    );

    await vi.advanceTimersByTimeAsync(1_000);

    await expect(pending).resolves.toBeNull();
    expect(onDeadline).toHaveBeenCalledOnce();
  });

  it("does not run cleanup after a command settles", async () => {
    const onDeadline = vi.fn(async () => {});

    await expect(
      settleBeforeDeadline(() => Promise.resolve("done"), 1_000, onDeadline),
    ).resolves.toBe("done");
    expect(onDeadline).not.toHaveBeenCalled();
  });

  it("does not start an already-expired command and still runs cleanup", async () => {
    const task = vi.fn(async () => "too late");
    const onDeadline = vi.fn(async () => {});

    await expect(settleBeforeDeadline(task, 0, onDeadline)).resolves.toBeNull();

    expect(task).not.toHaveBeenCalled();
    expect(onDeadline).toHaveBeenCalledOnce();
  });
});
