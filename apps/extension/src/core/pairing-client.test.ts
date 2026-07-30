import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SERVICE_ORIGIN,
  normalizePairingCode,
  PairingError,
  redeemPairingCode,
} from "./pairing-client";

afterEach(() => {
  vi.unstubAllGlobals();
});

const VALID_BODY = {
  serviceOrigin: "https://understudy.proofof.tech",
  deviceId: "00000000-0000-4000-8000-000000000001",
  deviceCredential: "udt_v1_x",
  originPolicy: ["https://example.com"],
  unattendedEnabled: true,
};

function stubFetch(status: number, body: unknown): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), { status }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("normalizePairingCode", () => {
  it("uppercases, strips separators, and maps Crockford confusables", () => {
    // #given human transcriptions of the same code
    // #when normalized
    // #then they collapse to one canonical form
    expect(normalizePairingCode("k7q2-m9xr")).toBe("K7Q2M9XR");
    expect(normalizePairingCode(" o1il 0ab2 ")).toBe("01110AB2");
  });
});

describe("redeemPairingCode", () => {
  it("posts the normalized code to the claim endpoint and returns the config", async () => {
    // #given a healthy claim endpoint
    const fetchMock = stubFetch(200, VALID_BODY);

    // #when a display-formatted code is redeemed
    const result = await redeemPairingCode("k7q2-m9xr");

    // #then the request carried the canonical code and the config round-trips
    expect(fetchMock).toHaveBeenCalledWith(
      `${DEFAULT_SERVICE_ORIGIN}/v1/pairing/claim`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ code: "K7Q2M9XR" }),
      }),
    );
    expect(result).toEqual(VALID_BODY);
  });

  it("refuses an incomplete code before any network call", async () => {
    const fetchMock = stubFetch(200, VALID_BODY);
    await expect(redeemPairingCode("K7Q2")).rejects.toThrow(PairingError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps the service's failure statuses to side-panel copy", async () => {
    stubFetch(404, { error: "invalid_or_expired_code" });
    await expect(redeemPairingCode("K7Q2M9XR")).rejects.toThrow(/invalid or has expired/);

    stubFetch(429, { error: "rate_limited" });
    await expect(redeemPairingCode("K7Q2M9XR")).rejects.toThrow(/Too many attempts/);

    stubFetch(503, {});
    await expect(redeemPairingCode("K7Q2M9XR")).rejects.toThrow(/HTTP 503/);
  });

  it("treats a malformed success body as a retryable service fault", async () => {
    stubFetch(200, { serviceOrigin: "https://x", deviceId: 42 });
    await expect(redeemPairingCode("K7Q2M9XR")).rejects.toThrow(/unreadable reply/);
  });

  it("wraps network failures in panel-facing copy", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("boom")));
    await expect(redeemPairingCode("K7Q2M9XR")).rejects.toThrow(/Could not reach/);
  });
});
