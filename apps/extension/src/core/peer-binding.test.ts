import { describe, expect, it, vi } from "vitest";
import { sendIfPeerCurrent } from "./peer-binding";

describe("sendIfPeerCurrent", () => {
  it("sends through the peer that still owns the session", () => {
    const peer = {};
    const send = vi.fn();

    sendIfPeerCurrent(peer, peer, send);

    expect(send).toHaveBeenCalledWith(peer);
  });

  it("drops a delayed event after its admitted peer has been retired", () => {
    const oldPeer = {};
    const newPeer = {};
    const send = vi.fn();

    sendIfPeerCurrent(oldPeer, newPeer, send);
    sendIfPeerCurrent(null, newPeer, send);

    expect(send).not.toHaveBeenCalled();
  });
});
