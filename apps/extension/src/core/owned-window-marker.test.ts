import { describe, expect, it } from "vitest";
import {
  ownedWindowBootstrapUrl,
  ownedWindowFromBootstrapUrl,
} from "./owned-window-marker";

const ROOT = "chrome-extension://abcdefghijklmnop/";
const FENCE = {
  sessionId: "session-1",
  leaseId: "lease-1",
  leaseEpoch: 3,
  browserEpoch: "browser-1",
};

describe("owned window bootstrap markers", () => {
  it("round-trips an exact lease fence without putting it in a query", () => {
    const url = ownedWindowBootstrapUrl(ROOT, FENCE);

    expect(new URL(url).search).toBe("");
    expect(ownedWindowFromBootstrapUrl(ROOT, url, 9, 7)).toEqual({
      ...FENCE,
      tabId: 7,
      windowId: 9,
    });
  });

  it("rejects other extension pages, origins, and malformed markers", () => {
    const valid = new URL(ownedWindowBootstrapUrl(ROOT, FENCE));
    expect(ownedWindowFromBootstrapUrl(ROOT, `${ROOT}sidepanel.html${valid.hash}`, 9, 7)).toBeNull();
    expect(
      ownedWindowFromBootstrapUrl(
        ROOT,
        `chrome-extension://other/unattended-bootstrap.html${valid.hash}`,
        9,
        7,
      ),
    ).toBeNull();
    expect(
      ownedWindowFromBootstrapUrl(ROOT, `${ROOT}unattended-bootstrap.html#owned=bad!`, 9, 7),
    ).toBeNull();
  });
});
