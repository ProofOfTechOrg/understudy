import { describe, expect, it } from "vitest";
import { externalPairingOffer } from "./external-pairing";

const OFFER = "A".repeat(43);

describe("externalPairingOffer", () => {
  it("accepts only the canonical pairing page and exact message schema", () => {
    expect(
      externalPairingOffer(
        { type: "understudy_pair_offer", offer: OFFER },
        { url: "https://understudy.proofof.tech/dashboard/pair" },
      ),
    ).toBe(OFFER);
  });

  it.each([
    undefined,
    "http://understudy.proofof.tech/dashboard/pair",
    "https://understudy.proofof.tech/dashboard/pair/",
    "https://understudy.proofof.tech/dashboard/pair?offer=secret",
    "https://understudy.proofof.tech/dashboard/pair#fragment",
    "https://evil.example/dashboard/pair",
  ])("rejects sender URL %s", (url) => {
    expect(
      externalPairingOffer(
        { type: "understudy_pair_offer", offer: OFFER },
        { url },
      ),
    ).toBeNull();
  });

  it.each([
    null,
    [],
    { type: "understudy_pair_offer", offer: "short" },
    { type: "other", offer: OFFER },
    { type: "understudy_pair_offer", offer: OFFER, extra: true },
  ])("rejects malformed messages", (message) => {
    expect(
      externalPairingOffer(message, {
        url: "https://understudy.proofof.tech/dashboard/pair",
      }),
    ).toBeNull();
  });
});
