import { env } from "cloudflare:workers";
import { PROTOCOL_CAPABILITIES } from "@understudy/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  deviceCredentialStatus,
  sha256Hex,
} from "../src/auth";
import {
  CANONICAL,
  claimRequest,
  connectTicketRequest,
  directory,
  fetchApp,
  mintUser,
  pairDevice,
  type PairedDevice,
} from "./helpers";

async function pairableUser(): Promise<{
  userId: string;
  tenantId: string;
  offer: string;
}> {
  const user = await mintUser();
  const created = await directory().createPairingOffer(user.userId);
  return { userId: user.userId, tenantId: user.tenantId, offer: created.offer };
}

describe("POST /v1/pairing/claim", () => {
  it("exchanges an exact opaque offer for an extension config", async () => {
    const user = await pairableUser();
    const res = await fetchApp(claimRequest(user.offer));
    expect(res.status).toBe(200);
    const body = (await res.json()) as PairedDevice;

    const origin = new URL(body.serviceOrigin);
    expect(origin.origin).toBe(CANONICAL);
    expect(origin.protocol).toBe("https:");
    expect(body.deviceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(body.deviceCredential).toMatch(/^udt_v2_[A-Za-z0-9_-]{43}$/);
    expect(body.originPolicy).toEqual([]);
    expect(body.policyVersion).toBe(1);
    expect(body.unattendedEnabled).toBe(true);
  });

  it("replays a completed claim while rejecting unknown and malformed offers", async () => {
    const user = await pairableUser();
    const first = await fetchApp(claimRequest(user.offer));
    expect(first.status).toBe(200);
    const firstBody = await first.json();

    const responses = await Promise.all([
      fetchApp(claimRequest(user.offer)),
      fetchApp(claimRequest(user.offer, undefined, "d".repeat(43))),
      fetchApp(claimRequest("z".repeat(43))),
      fetchApp(claimRequest("short")),
    ]);
    expect(responses[0]?.status).toBe(200);
    expect(await responses[0]!.json()).toEqual(firstBody);
    expect(responses[1]?.status).toBe(404);
    expect(await responses[1]!.json()).toEqual({ error: "invalid_or_expired_offer" });
    expect(responses[2]?.status).toBe(404);
    expect(await responses[2]!.json()).toEqual({ error: "invalid_or_expired_offer" });
    expect(responses[3]?.status).toBe(400);
  });

  it("replays an already-consumed claim after the offer redemption deadline", async () => {
    const user = await pairableUser();
    const first = await fetchApp(claimRequest(user.offer));
    expect(first.status).toBe(200);
    const body = await first.json();
    const afterOfferExpiry = Date.now() + 11 * 60 * 1000;

    vi.useFakeTimers();
    vi.setSystemTime(afterOfferExpiry);
    try {
      const replay = await fetchApp(claimRequest(user.offer));
      expect(replay.status).toBe(200);
      expect(await replay.json()).toEqual(body);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rotates an existing installation instead of leaving its predecessor live", async () => {
    const user = await mintUser();
    const first = await pairDevice(user.userId);
    const offer = await directory().createPairingOffer(user.userId);

    const response = await fetchApp(claimRequest(offer.offer, first.deviceCredential));
    expect(response.status).toBe(200);
    const rotated = (await response.json()) as PairedDevice;
    expect(rotated.deviceId).toBe(first.deviceId);
    expect(rotated.deviceCredential).not.toBe(first.deviceCredential);
    expect(rotated.originPolicy).toEqual(first.originPolicy);
    expect(rotated.policyVersion).toBe(first.policyVersion);
    expect((await fetchApp(connectTicketRequest(first.deviceCredential))).status).toBe(401);
    expect((await fetchApp(connectTicketRequest(rotated.deviceCredential))).status).toBe(200);
    expect(await directory().listDevices(user.userId)).toHaveLength(1);
    await expect(
      deviceCredentialStatus(
        await sha256Hex(first.deviceCredential),
        {
          tenantId: user.tenantId,
          deviceId: first.deviceId,
          credentialVersion: 1,
        },
        env,
      ),
    ).resolves.toBe("superseded");

    const replay = await fetchApp(claimRequest(offer.offer, first.deviceCredential));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(rotated);
  });

  it("preserves active leases when a credential-rotation response must be replayed", async () => {
    const user = await mintUser();
    const first = await pairDevice(user.userId);
    const coordinator = env.TENANT_CONTROL.getByName(user.tenantId);
    const now = Date.now();
    const browserEpoch = "rotation-browser";
    const credentialDigest = await sha256Hex(first.deviceCredential);
    await coordinator.registerDevice({
      deviceId: first.deviceId,
      browser: "Chrome/125",
      extVersion: "0.2.0",
      browserEpoch,
      credentialDigest,
      credentialVersion: 1,
      allowedOrigins: ["https://example.com"],
      policyVersion: 1,
      authoritySource: "directory",
      acknowledgedPolicyVersion: 1,
      assignments: [],
      ownedWindows: [],
      capabilities: [...PROTOCOL_CAPABILITIES],
      now,
    });
    await coordinator.heartbeat(first.deviceId, browserEpoch, [], [], now);
    const lease = await coordinator.createLease({
      idempotencyKey: crypto.randomUUID(),
      fingerprint: "f".repeat(64),
      sessionId: `session-${crypto.randomUUID()}`,
      deviceId: first.deviceId,
      allowedOrigins: ["https://example.com"],
      profileStateHash: "rotation-profile",
      actorPseudonym: "rotation-actor",
      now: now + 1,
    });
    if (lease.kind !== "created") throw new Error("expected created lease");
    const offer = await directory().createPairingOffer(user.userId);

    const firstResponse = await fetchApp(
      claimRequest(offer.offer, first.deviceCredential),
    );
    expect(firstResponse.status).toBe(200);
    const firstBody = await firstResponse.json();

    await expect(coordinator.getLease(lease.lease.sessionId, now + 2)).resolves.toMatchObject({
      status: "provisioning",
      adoptionExpiresAt: null,
    });
    await expect(
      coordinator.createLease({
        idempotencyKey: crypto.randomUUID(),
        fingerprint: "e".repeat(64),
        sessionId: `session-${crypto.randomUUID()}`,
        deviceId: first.deviceId,
        allowedOrigins: ["https://example.com"],
        profileStateHash: "second-profile",
        actorPseudonym: "rotation-actor",
        now: now + 2,
      }),
    ).resolves.toEqual({ kind: "no_device" });

    const replay = await fetchApp(claimRequest(offer.offer, first.deviceCredential));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(firstBody);
    await expect(coordinator.getLease(lease.lease.sessionId, now + 3)).resolves.toMatchObject({
      status: "provisioning",
    });
  });

  it("gives an offline revoked installation a fresh identity despite its stale credential", async () => {
    const user = await mintUser();
    const first = await pairDevice(user.userId);
    expect(await directory().revokeDevice(user.userId, first.deviceId)).toBe("revoked");
    const offer = await directory().createPairingOffer(user.userId);

    const response = await fetchApp(claimRequest(offer.offer, first.deviceCredential));

    expect(response.status).toBe(200);
    const replacement = (await response.json()) as PairedDevice;
    expect(replacement.deviceId).not.toBe(first.deviceId);
    expect((await fetchApp(connectTicketRequest(first.deviceCredential))).status).toBe(401);
    expect((await fetchApp(connectTicketRequest(replacement.deviceCredential))).status).toBe(200);
    expect(await directory().listDevices(user.userId)).toEqual([
      expect.objectContaining({ deviceId: replacement.deviceId }),
    ]);
  });

  it("never revokes a foreign device presented as rotation proof", async () => {
    const owner = await mintUser();
    const foreign = await mintUser();
    const foreignDevice = await pairDevice(foreign.userId);
    const offer = await directory().createPairingOffer(owner.userId);

    expect(
      (await fetchApp(claimRequest(offer.offer, foreignDevice.deviceCredential))).status,
    ).toBe(404);
    expect((await fetchApp(connectTicketRequest(foreignDevice.deviceCredential))).status).toBe(
      200,
    );
  });

  it("mints a credential that traverses the connect-ticket pipeline", async () => {
    const user = await mintUser();
    const claim = await pairDevice(user.userId);
    const ticketRes = await fetchApp(connectTicketRequest(claim.deviceCredential));

    expect(ticketRes.status).toBe(200);
    const ticket = (await ticketRes.json()) as { ticket: string; websocketPath: string };
    expect(ticket.ticket.length).toBeGreaterThan(0);
    expect(ticket.websocketPath).toBe(`/agents/device/${encodeURIComponent(claim.deviceId)}`);
  });

  it("rejects a revoked device on the next ticket request", async () => {
    const user = await mintUser();
    const claim = await pairDevice(user.userId);
    await directory().revokeDevice(user.userId, claim.deviceId);
    const ticketRes = await fetchApp(connectTicketRequest(claim.deviceCredential));
    expect(ticketRes.status).toBe(401);
  });
});

describe("directory device heartbeat liveness", () => {
  it("keeps a paired device live and drops it once revoked", async () => {
    const user = await mintUser();
    const claim = await pairDevice(user.userId);
    const digest = await sha256Hex(claim.deviceCredential);
    const identity = {
      tenantId: user.tenantId,
      deviceId: claim.deviceId,
      credentialVersion: 1,
    };

    expect(await deviceCredentialStatus(digest, identity, env)).toBe("live");
    await directory().revokeDevice(user.userId, claim.deviceId);
    expect(await deviceCredentialStatus(digest, identity, env)).toBe("revoked");
  });

  it("does not confuse a device from another tenant", async () => {
    const user = await mintUser();
    const claim = await pairDevice(user.userId);
    const digest = await sha256Hex(claim.deviceCredential);
    expect(
      await deviceCredentialStatus(
        digest,
        {
          tenantId: "acct-otheracct",
          deviceId: claim.deviceId,
          credentialVersion: 1,
        },
        env,
      ),
    ).toBe("revoked");
  });
});
