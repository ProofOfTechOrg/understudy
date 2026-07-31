/**
 * POST /v1/pairing/claim (PR 4): the code-for-credential exchange the
 * extension's side panel drives, and the composite device auth path the
 * minted credential then traverses. Direct module fetch — the response's
 * serviceOrigin comes from the request URL.
 */

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  clearDeviceCredentialCache,
  deviceCredentialLive,
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

/**
 * A user plus an unclaimed code, for the tests that drive the claim endpoint
 * itself. Tests that only need a paired device use pairDevice.
 */
async function pairableUser(): Promise<{ userId: string; tenantId: string; code: string }> {
  const user = await mintUser();
  await directory().setAllowedOrigins(user.userId, ["https://example.com"]);
  const created = await directory().createPairingCode(user.userId);
  if (created.kind !== "ok") throw new Error("pairing code failed");
  return { userId: user.userId, tenantId: user.tenantId, code: created.code };
}

describe("POST /v1/pairing/claim", () => {
  it("exchanges a mangled-but-normalizable code for a config the extension accepts", async () => {
    const user = await pairableUser();
    // Lowercase + display dashes, exactly as a human might paste it.
    const pasted = `${user.code.slice(0, 4).toLowerCase()}-${user.code.slice(4).toLowerCase()}`;
    const res = await fetchApp(claimRequest(pasted));
    expect(res.status).toBe(200);
    const body = (await res.json()) as PairedDevice;

    // The contract: this body must satisfy the extension's strict
    // normalizeProfileConfig by construction.
    const origin = new URL(body.serviceOrigin);
    expect(origin.origin).toBe(CANONICAL);
    expect(origin.protocol).toBe("https:");
    expect(body.deviceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(body.deviceCredential).toMatch(/^udt_v1_[A-Za-z0-9_-]{43}$/);
    expect(body.deviceCredential.length).toBeLessThanOrEqual(4096);
    expect(body.originPolicy).toEqual(["https://example.com"]);
    expect(body.originPolicy.length).toBeGreaterThanOrEqual(1);
    expect(body.originPolicy.length).toBeLessThanOrEqual(32);
    expect(body.unattendedEnabled).toBe(true);
  });

  it("collapses reuse, expiry, and unknown codes to one indistinguishable 404", async () => {
    const user = await pairableUser();
    expect((await fetchApp(claimRequest(user.code))).status).toBe(200);

    const reused = await fetchApp(claimRequest(user.code));
    const unknown = await fetchApp(claimRequest("ZZZZ-ZZZZ"));
    const malformed = await fetchApp(claimRequest("AB"));
    expect(reused.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(malformed.status).toBe(404);
    expect(await reused.json()).toEqual({ error: "invalid_or_expired_code" });
    expect(await unknown.json()).toEqual({ error: "invalid_or_expired_code" });
    expect(await malformed.json()).toEqual({ error: "invalid_or_expired_code" });
  });

  it("mints a credential that traverses the existing connect-ticket pipeline", async () => {
    clearDeviceCredentialCache();
    const user = await mintUser();
    const claim = await pairDevice(user.userId);

    // #when the freshly minted udt_ credential asks for a connect ticket
    const ticketRes = await fetchApp(connectTicketRequest(claim.deviceCredential));

    // #then the composite verifier + DeviceAgent bootstrap admit it with
    // zero edits to device.ts / tenant-coordinator.ts
    expect(ticketRes.status).toBe(200);
    const ticket = (await ticketRes.json()) as { ticket: string; websocketPath: string };
    expect(ticket.ticket.length).toBeGreaterThan(0);
    expect(ticket.websocketPath).toBe(
      `/agents/device/${encodeURIComponent(claim.deviceId)}`,
    );
  });

  it("stops honoring a revoked device at the next uncached ticket request", async () => {
    clearDeviceCredentialCache();
    const user = await mintUser();
    const claim = await pairDevice(user.userId);
    await directory().revokeDevice(user.userId, claim.deviceId);
    clearDeviceCredentialCache();
    const ticketRes = await fetchApp(connectTicketRequest(claim.deviceCredential));
    expect(ticketRes.status).toBe(401);
  });
});

describe("directory device heartbeat liveness", () => {
  // Regression for the showstopper: the heartbeat revocation check read only
  // DEVICE_TOKENS, so a udt_ credential (never in the blob) was treated as
  // revoked and every paired browser was dropped on its first heartbeat.
  it("keeps a paired udt_ device live, and drops it once revoked", async () => {
    clearDeviceCredentialCache();
    const user = await mintUser();
    const claim = await pairDevice(user.userId);
    const digest = await sha256Hex(claim.deviceCredential);
    const identity = { tenantId: user.tenantId, deviceId: claim.deviceId, credentialVersion: 1 };

    // Live before revocation (this is the check the heartbeat runs).
    expect(await deviceCredentialLive(digest, identity, env)).toBe(true);

    await directory().revokeDevice(user.userId, claim.deviceId);
    clearDeviceCredentialCache();
    expect(await deviceCredentialLive(digest, identity, env)).toBe(false);
  });

  it("does not confuse a udt_ device from another tenant", async () => {
    clearDeviceCredentialCache();
    const user = await mintUser();
    const claim = await pairDevice(user.userId);
    const digest = await sha256Hex(claim.deviceCredential);
    // The digest is real, but the claimed identity names a different tenant.
    expect(
      await deviceCredentialLive(
        digest,
        { tenantId: "acct-otheracct", deviceId: claim.deviceId, credentialVersion: 1 },
        env,
      ),
    ).toBe(false);
  });
});
