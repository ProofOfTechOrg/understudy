import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RequestDeadlineError,
  readBoundedJson,
  withRequestDeadline,
} from "./request-deadline";

afterEach(() => {
  vi.useRealTimers();
});

describe("bounded response reads", () => {
  it("cancels a stalled response body at the deadline", async () => {
    vi.useFakeTimers();
    let cancelled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"partial":'));
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
    const reading = withRequestDeadline(100, (signal) =>
      readBoundedJson(response, signal, 1024),
    );
    const rejected = expect(reading).rejects.toBeInstanceOf(RequestDeadlineError);

    await vi.advanceTimersByTimeAsync(100);

    await rejected;
    expect(cancelled).toBe(true);
  });

  it("rejects and cancels a streamed body once it crosses the byte cap", async () => {
    let cancelled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(9));
        },
        cancel() {
          cancelled = true;
        },
      }),
    );

    await expect(
      readBoundedJson(response, new AbortController().signal, 8),
    ).rejects.toThrow("response body exceeds limit");
    expect(cancelled).toBe(true);
  });
});
