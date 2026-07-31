import { describe, expect, it } from "vitest";
import { resolveAttendedTransition } from "./attended-switch";

describe("resolveAttendedTransition", () => {
  it("re-isolates a repeated target after its queued predecessor fails", () => {
    const oldPeer = {};

    const transition = resolveAttendedTransition(
      "wss://service.example/session-y",
      "wss://service.example/session-x",
      true,
      null,
      oldPeer,
    );

    expect(transition).toEqual({
      sessionChanged: true,
      peer: oldPeer,
    });
  });

  it("re-isolates when the failed predecessor already assigned the target URL", () => {
    const transition = resolveAttendedTransition(
      "wss://service.example/session-y",
      "wss://service.example/session-y",
      true,
      null,
      null,
    );

    expect(transition.sessionChanged).toBe(true);
  });

  it("does not clear replay state for an already-isolated target", () => {
    const currentPeer = {};

    const transition = resolveAttendedTransition(
      "wss://service.example/session-y",
      "wss://service.example/session-y",
      false,
      currentPeer,
      null,
    );

    expect(transition).toEqual({
      sessionChanged: false,
      peer: currentPeer,
    });
  });
});
