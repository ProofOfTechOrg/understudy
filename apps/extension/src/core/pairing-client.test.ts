import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SERVICE_ORIGIN,
  PAIRING_CLAIM_KEY,
  PairingError,
  PairingClaimCoordinator,
  createPairingClaimId,
  redeemPairingOffer,
} from "./pairing-client";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const OFFER = "a".repeat(43);
const PREVIOUS_CREDENTIAL = `udt_v2_${"b".repeat(43)}`;
const RECOVERED_CREDENTIAL = `udt_v2_${"e".repeat(43)}`;
const CLAIM_ID = "d".repeat(43);
const VALID_BODY = {
  serviceOrigin: "https://understudy.proofof.tech",
  deviceId: "00000000-0000-4000-8000-000000000001",
  deviceCredential: `udt_v2_${"c".repeat(43)}`,
  originPolicy: ["https://example.com"],
  policyVersion: 1,
  unattendedEnabled: true,
};

function stubFetch(status: number, body: unknown): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), { status }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function storageFixture(initial: Record<string, unknown> = {}) {
  const values = { ...initial };
  return {
    values,
    storage: {
      get: vi.fn(async (key: string) => ({ [key]: values[key] })),
      set: vi.fn(async (next: Record<string, unknown>) => {
        Object.assign(values, next);
      }),
      remove: vi.fn(async (key: string) => {
        delete values[key];
      }),
    },
  };
}

describe("redeemPairingOffer", () => {
  it("posts the opaque offer and current credential to the claim endpoint", async () => {
    const fetchMock = stubFetch(200, VALID_BODY);

    const result = await redeemPairingOffer(
      OFFER,
      PREVIOUS_CREDENTIAL,
      DEFAULT_SERVICE_ORIGIN,
      CLAIM_ID,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      `${DEFAULT_SERVICE_ORIGIN}/v1/pairing/claim`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          offer: OFFER,
          claimId: CLAIM_ID,
          previousCredential: PREVIOUS_CREDENTIAL,
        }),
      }),
    );
    expect(result).toEqual(VALID_BODY);
  });

  it("rejects malformed offers and credentials before any network call", async () => {
    const fetchMock = stubFetch(200, VALID_BODY);
    await expect(redeemPairingOffer("short")).rejects.toThrow(PairingError);
    await expect(redeemPairingOffer(OFFER, "udt_v1_short")).rejects.toThrow(PairingError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("generates a 256-bit base64url claim identity", () => {
    expect(createPairingClaimId()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("maps service failure statuses to panel copy", async () => {
    stubFetch(404, { error: "invalid_or_expired_offer" });
    await expect(redeemPairingOffer(OFFER)).rejects.toThrow(/invalid or has expired/);

    stubFetch(429, { error: "rate_limited" });
    await expect(redeemPairingOffer(OFFER)).rejects.toThrow(/Too many attempts/);

    stubFetch(503, {});
    await expect(redeemPairingOffer(OFFER)).rejects.toThrow(/HTTP 503/);
  });

  it("rejects malformed success bodies", async () => {
    stubFetch(200, { serviceOrigin: "https://x", deviceId: 42 });
    await expect(redeemPairingOffer(OFFER)).rejects.toThrow(/unreadable reply/);
  });

  it("wraps network failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("boom")));
    await expect(redeemPairingOffer(OFFER)).rejects.toThrow(/Could not reach/);
  });

  it("bounds a blackholed pairing exchange", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));

    const redemption = redeemPairingOffer(OFFER);
    const rejected = expect(redemption).rejects.toThrow(/Could not reach/);
    await vi.advanceTimersByTimeAsync(15_000);

    await rejected;
  });
});

describe("PairingClaimCoordinator", () => {
  it("removes an invalid durable claim instead of retrying it", async () => {
    const { values, storage } = storageFixture({
      [PAIRING_CLAIM_KEY]: { version: 1 },
    });
    const coordinator = new PairingClaimCoordinator(storage);

    await expect(coordinator.next(null, async () => undefined)).resolves.toBeNull();
    expect(storage.remove).toHaveBeenCalledWith(PAIRING_CLAIM_KEY);
    expect(values[PAIRING_CLAIM_KEY]).toBeUndefined();
  });

  it("persists an offer before resolving its credential proof", async () => {
    const { values, storage } = storageFixture();
    const coordinator = new PairingClaimCoordinator(storage);

    await coordinator.request(OFFER);

    expect(values[PAIRING_CLAIM_KEY]).toEqual({
      version: 3,
      active: expect.objectContaining({
        offer: OFFER,
        phase: "preparing",
        previousCredential: null,
      }),
      queued: null,
      stopRequested: false,
    });

    await expect(
      coordinator.next(OFFER, () => Promise.resolve(PREVIOUS_CREDENTIAL)),
    ).resolves.toEqual(
      expect.objectContaining({
        offer: OFFER,
        previousCredential: PREVIOUS_CREDENTIAL,
      }),
    );
    expect(values[PAIRING_CLAIM_KEY]).toEqual(
      expect.objectContaining({
        active: expect.objectContaining({ phase: "ready" }),
      }),
    );
  });

  it("serializes cancellation after an in-flight undispatched claim write", async () => {
    const values: Record<string, unknown> = {};
    let releaseSet!: () => void;
    const setGate = new Promise<void>((resolve) => {
      releaseSet = resolve;
    });
    const storage = {
      get: vi.fn(async (key: string) => ({ [key]: values[key] })),
      set: vi.fn(async (next: Record<string, unknown>) => {
        await setGate;
        Object.assign(values, next);
      }),
      remove: vi.fn(async (key: string) => {
        delete values[key];
      }),
    };
    const coordinator = new PairingClaimCoordinator(storage);

    const claiming = coordinator.request(OFFER);
    await vi.waitFor(() => expect(storage.set).toHaveBeenCalledOnce());
    const clearing = coordinator.cancel();
    releaseSet();
    await Promise.all([claiming, clearing]);

    expect(values[PAIRING_CLAIM_KEY]).toBeUndefined();
  });

  it("clears a claim that has not crossed the network boundary", async () => {
    const { values, storage } = storageFixture();
    const coordinator = new PairingClaimCoordinator(storage);

    await coordinator.request(OFFER);
    await coordinator.next(OFFER, () => Promise.resolve(PREVIOUS_CREDENTIAL));
    await coordinator.cancel();

    expect(values[PAIRING_CLAIM_KEY]).toBeUndefined();
  });

  it("migrates and finishes an unresolved version-2 intent after restart", async () => {
    const { values, storage } = storageFixture({
      [PAIRING_CLAIM_KEY]: {
        version: 2,
        offer: OFFER,
        claimId: CLAIM_ID,
        credentialResolved: false,
        previousCredential: null,
      },
    });
    const restarted = new PairingClaimCoordinator(storage);

    await expect(
      restarted.next(OFFER, () => Promise.resolve(PREVIOUS_CREDENTIAL)),
    ).resolves.toEqual({
      offer: OFFER,
      claimId: CLAIM_ID,
      previousCredential: PREVIOUS_CREDENTIAL,
    });
    expect(values[PAIRING_CLAIM_KEY]).toEqual(
      expect.objectContaining({
        version: 3,
        active: expect.objectContaining({
          claimId: CLAIM_ID,
          phase: "ready",
          previousCredential: PREVIOUS_CREDENTIAL,
        }),
      }),
    );
  });

  it("preserves a dispatched claim through Stop All and replays its exact proof", async () => {
    const { values, storage } = storageFixture();
    const coordinator = new PairingClaimCoordinator(storage);
    await coordinator.request(OFFER);
    const original = await coordinator.next(OFFER, () =>
      Promise.resolve(PREVIOUS_CREDENTIAL),
    );
    if (original === null) throw new Error("claim not prepared");
    await expect(coordinator.markDispatched(original)).resolves.toBe(true);

    await coordinator.cancel();

    const restarted = new PairingClaimCoordinator(storage);
    await expect(
      restarted.next(null, () => Promise.resolve(RECOVERED_CREDENTIAL)),
    ).resolves.toEqual(original);
    await expect(restarted.disposition(original)).resolves.toEqual({
      allowHosting: false,
      queued: false,
      stopRequested: true,
    });
    await expect(restarted.complete(original)).resolves.toBe(true);
    expect(values[PAIRING_CLAIM_KEY]).toBeUndefined();
  });

  it("does not let a duplicate dispatched offer undo Stop All", async () => {
    const { storage } = storageFixture();
    const coordinator = new PairingClaimCoordinator(storage);
    await coordinator.request(OFFER);
    const original = await coordinator.next(OFFER, () =>
      Promise.resolve(PREVIOUS_CREDENTIAL),
    );
    if (original === null) throw new Error("claim not prepared");
    await coordinator.markDispatched(original);
    await coordinator.cancel();

    await coordinator.request(OFFER);

    await expect(coordinator.disposition(original)).resolves.toEqual({
      allowHosting: false,
      queued: false,
      stopRequested: true,
    });
  });

  it("recovers a dispatched rotation before proving a queued offer", async () => {
    const { values, storage } = storageFixture();
    const coordinator = new PairingClaimCoordinator(storage);
    await coordinator.request(OFFER);
    const original = await coordinator.next(OFFER, () =>
      Promise.resolve(PREVIOUS_CREDENTIAL),
    );
    if (original === null) throw new Error("claim not prepared");
    await coordinator.markDispatched(original);

    const nextOffer = "f".repeat(43);
    await coordinator.request(nextOffer);

    await expect(coordinator.disposition(original)).resolves.toEqual({
      allowHosting: false,
      queued: true,
      stopRequested: false,
    });
    expect(values[PAIRING_CLAIM_KEY]).toEqual(
      expect.objectContaining({
        active: expect.objectContaining({
          offer: OFFER,
          claimId: original.claimId,
          phase: "dispatched",
          previousCredential: PREVIOUS_CREDENTIAL,
        }),
        queued: expect.objectContaining({ offer: nextOffer }),
      }),
    );

    await coordinator.complete(original);
    const promoted = await coordinator.next(nextOffer, () =>
      Promise.resolve(RECOVERED_CREDENTIAL),
    );
    expect(promoted).toEqual(
      expect.objectContaining({
        offer: nextOffer,
        previousCredential: RECOVERED_CREDENTIAL,
      }),
    );
  });

  it("does not let an obsolete completion remove a replacement", async () => {
    const { storage } = storageFixture();
    const coordinator = new PairingClaimCoordinator(storage);
    await coordinator.request(OFFER);
    const obsolete = await coordinator.next(OFFER, () =>
      Promise.resolve(PREVIOUS_CREDENTIAL),
    );
    if (obsolete === null) throw new Error("claim not prepared");
    await coordinator.request("f".repeat(43));

    await expect(coordinator.complete(obsolete)).resolves.toBe(false);
    await expect(
      coordinator.next("f".repeat(43), () => Promise.resolve(RECOVERED_CREDENTIAL)),
    ).resolves.toEqual(
      expect.objectContaining({
        offer: "f".repeat(43),
        previousCredential: RECOVERED_CREDENTIAL,
      }),
    );
  });

  it("does not let a stale scheduler consume the newest queued offer", async () => {
    const { storage } = storageFixture();
    const coordinator = new PairingClaimCoordinator(storage);
    const staleOffer = "f".repeat(43);
    const latestOffer = "e".repeat(43);
    await coordinator.request(OFFER);
    const dispatched = await coordinator.next(OFFER, () =>
      Promise.resolve(PREVIOUS_CREDENTIAL),
    );
    if (dispatched === null) throw new Error("claim not prepared");
    await coordinator.markDispatched(dispatched);
    await coordinator.request(staleOffer);
    await coordinator.request(latestOffer);

    await expect(
      coordinator.next(staleOffer, () => Promise.resolve(RECOVERED_CREDENTIAL)),
    ).resolves.toEqual(dispatched);
    await coordinator.complete(dispatched);
    await expect(
      coordinator.next(staleOffer, () => Promise.resolve(RECOVERED_CREDENTIAL)),
    ).resolves.toBeNull();
    await expect(
      coordinator.next(latestOffer, () => Promise.resolve(RECOVERED_CREDENTIAL)),
    ).resolves.toEqual(
      expect.objectContaining({
        offer: latestOffer,
        previousCredential: RECOVERED_CREDENTIAL,
      }),
    );
  });
});
