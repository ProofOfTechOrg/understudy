/**
 * AccountDirectory + tenant-class + composite-device-auth tests (PR 2 of the
 * MCP surface). Storage is shared across the whole run (isolate:false), and
 * the directory is a singleton — every test mints fresh random emails and
 * credentials so nothing collides.
 */

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  AccountDirectory,
  AUTH_CONTRACT_VERSION,
  PROTOCOL_3_AUTH_CUTOVER,
  TENANT_ID_PATTERN,
} from "../src/account-directory";
import {
  authenticateDeviceComposite,
  sha256Hex,
  taggedHmacHex,
} from "../src/auth";
import { enabledForTenant } from "../src/api/sessions";
import type { Env } from "../src/types";
import { directory, mintUser, setUserOrigins } from "./helpers";

function freshEmail(): string {
  return `${crypto.randomUUID()}@example.com`;
}

function bearerRequest(credential: string): Request {
  return new Request("https://understudy.example/v1/device/connect-ticket", {
    method: "POST",
    headers: { Authorization: `Bearer ${credential}` },
  });
}

async function claimOffer(offer: string, previousCredentialDigest?: string) {
  return directory().claimPairingOffer(
    await taggedHmacHex(env, "pair-v2", offer),
    await sha256Hex("account-directory-test-claim"),
    previousCredentialDigest,
  );
}

/** Env whose directory binding throws if touched — proves a path does no RPC. */
function noDirectoryEnv(overrides: Partial<Env> = {}): Env {
  return {
    ...env,
    ...overrides,
    ACCOUNT_DIRECTORY: {
      getByName() {
        throw new Error("directory RPC on a path that must not touch it");
      },
    } as unknown as Env["ACCOUNT_DIRECTORY"],
  };
}

async function mutateChallenge(
  challengeId: string,
  set: string,
  value: number,
): Promise<void> {
  await runInDurableObject(directory(), (instance: AccountDirectory) => {
    (instance as unknown as { ctx: DurableObjectState }).ctx.storage.sql.exec(
      `UPDATE otp_challenges SET ${set} = ? WHERE challenge_id = ?`,
      value,
      challengeId,
    );
  });
}

describe("enabledForTenant", () => {
  it("matches prefix entries against the class, not lookalikes", () => {
    const raw = JSON.stringify(["metamind", "prefix:acct-"]);
    expect(enabledForTenant(raw, "acct-abcdefghij")).toBe(true);
    expect(enabledForTenant(raw, "metamind")).toBe(true);
    expect(enabledForTenant(raw, "acctx")).toBe(false);
    expect(enabledForTenant(raw, "acct")).toBe(false);
    expect(enabledForTenant(raw, "proofoftech")).toBe(false);
  });

  it("no longer honours a bare wildcard", () => {
    expect(enabledForTenant(JSON.stringify(["*"]), "metamind")).toBe(false);
    expect(enabledForTenant(JSON.stringify(["*"]), "acct-abcdefghij")).toBe(false);
  });

  it("ignores an empty prefix entry and malformed input", () => {
    expect(enabledForTenant(JSON.stringify(["prefix:"]), "anything")).toBe(false);
    expect(enabledForTenant("not json", "metamind")).toBe(false);
    expect(enabledForTenant(JSON.stringify({ metamind: true }), "metamind")).toBe(false);
    expect(enabledForTenant("", "metamind")).toBe(false);
  });
});

describe("AccountDirectory OTP", () => {
  it("verifies a fresh code once and mints an acct- tenant exactly once per email", async () => {
    const email = freshEmail();
    const first = await directory().requestOtp(email);
    expect(first.kind).toBe("ok");
    if (first.kind !== "ok") return;
    expect(first.code).toMatch(/^\d{6}$/);

    const verified = await directory().verifyOtp(first.challengeId, first.code);
    expect(verified.kind).toBe("ok");
    if (verified.kind !== "ok") return;
    expect(verified.tenantId).toMatch(TENANT_ID_PATTERN);
    expect(verified.email).toBe(email.toLowerCase());

    // Single-use: the same challenge cannot verify twice.
    expect((await directory().verifyOtp(first.challengeId, first.code)).kind).toBe(
      "invalid",
    );

    // A second login for the same email lands on the same user + tenant.
    const second = await directory().requestOtp(email);
    if (second.kind !== "ok") throw new Error("second otp request failed");
    const again = await directory().verifyOtp(second.challengeId, second.code);
    expect(again).toMatchObject({
      kind: "ok",
      userId: verified.userId,
      tenantId: verified.tenantId,
    });
  });

  it("rejects a correct code past the attempt cap (increment-before-compare)", async () => {
    const email = freshEmail();
    const requested = await directory().requestOtp(email);
    if (requested.kind !== "ok") throw new Error("otp request failed");
    const wrong = requested.code === "000000" ? "000001" : "000000";
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await directory().verifyOtp(requested.challengeId, wrong)).kind).toBe(
        "invalid",
      );
    }
    expect(
      (await directory().verifyOtp(requested.challengeId, requested.code)).kind,
    ).toBe("invalid");
  });

  it("rejects an expired challenge", async () => {
    const requested = await directory().requestOtp(freshEmail());
    if (requested.kind !== "ok") throw new Error("otp request failed");
    await mutateChallenge(requested.challengeId, "expires_at", Date.now() - 1_000);
    expect(
      (await directory().verifyOtp(requested.challengeId, requested.code)).kind,
    ).toBe("invalid");
  });

  it("caps active and daily issuance per email", async () => {
    const email = freshEmail();
    for (let index = 0; index < 3; index += 1) {
      expect((await directory().requestOtp(email)).kind).toBe("ok");
    }
    expect((await directory().requestOtp(email)).kind).toBe("rate_limited");

    // Consuming challenges frees the active cap but not the daily cap.
    const daily = freshEmail();
    for (let index = 0; index < 8; index += 1) {
      const requested = await directory().requestOtp(daily);
      expect(requested.kind).toBe("ok");
      if (requested.kind !== "ok") return;
      expect((await directory().verifyOtp(requested.challengeId, requested.code)).kind).toBe(
        "ok",
      );
    }
    expect((await directory().requestOtp(daily)).kind).toBe("rate_limited");
  });

  it("refuses malformed emails and treats unknown emails identically to known ones", async () => {
    expect((await directory().requestOtp("not-an-email")).kind).toBe("invalid_email");
    expect((await directory().requestOtp("a".repeat(250) + "@example.com")).kind).toBe(
      "invalid_email",
    );
    // No enumeration: a never-seen address and a registered address get the
    // same result shape — users are created at verify time, not request time.
    const known = await mintUser();
    const knownResult = await directory().requestOtp(known.email);
    const unknownResult = await directory().requestOtp(freshEmail());
    expect(knownResult.kind).toBe("ok");
    expect(unknownResult.kind).toBe("ok");
  });
});

describe("AccountDirectory dashboard sessions", () => {
  it("round-trips a cookie token, and revocation is immediate", async () => {
    const user = await mintUser();
    const created = await directory().createDashboardSession(user.userId);
    const tokenHash = await sha256Hex(created.token);
    const identity = await directory().getDashboardSession(tokenHash);
    expect(identity).toMatchObject({
      userId: user.userId,
      tenantId: user.tenantId,
      email: user.email.toLowerCase(),
    });
    await directory().revokeDashboardSession(tokenHash);
    expect(await directory().getDashboardSession(tokenHash)).toBeNull();
  });

  it("expires absolutely", async () => {
    const user = await mintUser();
    const created = await directory().createDashboardSession(user.userId);
    const tokenHash = await sha256Hex(created.token);
    await runInDurableObject(directory(), (instance: AccountDirectory) => {
      (instance as unknown as { ctx: DurableObjectState }).ctx.storage.sql.exec(
        `UPDATE dashboard_sessions SET expires_at = ? WHERE session_hash = ?`,
        Date.now() - 1_000,
        tokenHash,
      );
    });
    expect(await directory().getDashboardSession(tokenHash)).toBeNull();
  });
});

describe("AccountDirectory origins", () => {
  it("canonicalizes, deduplicates, and bounds the account origin list", async () => {
    const user = await mintUser();
    const set = await setUserOrigins(user.userId, [
      "https://example.com",
      "https://example.com/",
      "https://another.example",
    ]);
    expect(set).toEqual({
      kind: "ok",
      origins: ["https://another.example", "https://example.com"],
      devices: [],
    });
    const fetched = await directory().getUser(user.userId);
    expect(fetched?.allowedOrigins).toEqual([
      "https://another.example",
      "https://example.com",
    ]);

    expect(
      (await setUserOrigins(user.userId, ["http://example.com"])).kind,
    ).toBe("invalid");
    expect(
      (
        await setUserOrigins(
          user.userId,
          Array.from({ length: 33 }, (_, index) => `https://site${index}.example`),
        )
      ).kind,
    ).toBe("invalid");
  });
});

describe("AccountDirectory pairing", () => {
  it("mints a device and replays the same claim after a lost response", async () => {
    const user = await mintUser();
    const created = await directory().createPairingOffer(user.userId);
    expect(created.offer).toMatch(/^[A-Za-z0-9_-]{43}$/);

    expect(await directory().listDevices(user.userId)).toEqual([]);

    const claimed = await claimOffer(created.offer);
    expect(claimed.kind).toBe("ok");
    if (claimed.kind !== "ok") return;
    expect(claimed.tenantId).toBe(user.tenantId);
    expect(claimed.deviceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(claimed.deviceCredential).toMatch(/^udt_v2_[A-Za-z0-9_-]{43}$/);
    expect(claimed.originPolicy).toEqual([]);
    expect(claimed.policyVersion).toBe(1);

    const devices = await directory().listDevices(user.userId);
    expect(devices).toHaveLength(1);
    expect(devices[0]?.deviceId).toBe(claimed.deviceId);

    await expect(claimOffer(created.offer)).resolves.toEqual(claimed);
  });

  it("collapses expired and unknown offers to the same invalid result", async () => {
    const user = await mintUser();
    const created = await directory().createPairingOffer(user.userId);
    const codeHash = await taggedHmacHex(env, "pair-v2", created.offer);
    await runInDurableObject(directory(), (instance: AccountDirectory) => {
      (instance as unknown as { ctx: DurableObjectState }).ctx.storage.sql.exec(
        `UPDATE pairing_codes SET expires_at = ? WHERE code_hash = ?`,
        Date.now() - 1_000,
        codeHash,
      );
    });
    const expired = await claimOffer(created.offer);
    const unknown = await claimOffer("z".repeat(43));
    expect(expired).toEqual({ kind: "invalid" });
    expect(unknown).toEqual({ kind: "invalid" });
  });

  it("serializes pairing against a pending origin-policy operation", async () => {
    const user = await mintUser();
    const first = await directory().createPairingOffer(user.userId);
    const device = await claimOffer(first.offer);
    if (device.kind !== "ok") throw new Error("pairing claim failed");
    const second = await directory().createPairingOffer(user.userId);

    const pending = await directory().beginAllowedOriginsUpdate(user.userId, [
      "https://shop.example",
    ]);
    if (pending.kind !== "ok") throw new Error("origin update failed");
    expect(pending.devices).toEqual([
      {
        deviceId: device.deviceId,
        allowedOrigins: [],
        policyVersion: 2,
        narrowing: false,
      },
    ]);
    await expect(claimOffer(second.offer)).resolves.toEqual({ kind: "invalid" });

    await expect(
      directory().commitAllowedOriginsUpdate(user.userId, pending.operationId),
    ).resolves.toMatchObject({
      kind: "ok",
      origins: ["https://shop.example"],
    });
    await expect(claimOffer(second.offer)).resolves.toMatchObject({ kind: "ok" });
  });

  it("preserves authoritative device policy when rotating its credential", async () => {
    const user = await mintUser();
    await setUserOrigins(user.userId, ["https://device.example"]);
    const firstOffer = await directory().createPairingOffer(user.userId);
    const first = await claimOffer(firstOffer.offer);
    if (first.kind !== "ok") throw new Error("pairing claim failed");

    await runInDurableObject(directory(), (instance: AccountDirectory) => {
      (instance as unknown as { ctx: DurableObjectState }).ctx.storage.sql.exec(
        "UPDATE users SET allowed_origins = ? WHERE user_id = ?",
        JSON.stringify(["https://new-default.example"]),
        user.userId,
      );
    });
    const rotationOffer = await directory().createPairingOffer(user.userId);
    const rotated = await claimOffer(
      rotationOffer.offer,
      await sha256Hex(first.deviceCredential),
    );

    expect(rotated).toMatchObject({
      kind: "ok",
      deviceId: first.deviceId,
      originPolicy: ["https://device.example"],
      policyVersion: first.policyVersion,
    });
  });
});

describe("authenticateDeviceComposite", () => {
  it("resolves a protocol-3 static blob without touching the directory", async () => {
    const credential = `legacy-${crypto.randomUUID()}`;
    const deviceId = crypto.randomUUID();
    const blobEnv = noDirectoryEnv({
      DEVICE_TOKENS: JSON.stringify({
        [await sha256Hex(credential)]: {
          tenantId: "metamind",
          deviceId,
          credentialVersion: 3,
          allowedOrigins: ["https://example.com"],
          policyVersion: 1,
        },
      }),
    });
    const identity = await authenticateDeviceComposite(bearerRequest(credential), blobEnv);
    expect(identity).toMatchObject({
      tenantId: "metamind",
      deviceId: deviceId.toLowerCase(),
      credentialVersion: 3,
    });
  });

  it("rejects a pre-protocol-3 static blob until policy fields are migrated", async () => {
    const credential = `legacy-${crypto.randomUUID()}`;
    const identity = await authenticateDeviceComposite(
      bearerRequest(credential),
      noDirectoryEnv({
        DEVICE_TOKENS: JSON.stringify({
          [await sha256Hex(credential)]: {
            tenantId: "metamind",
            deviceId: crypto.randomUUID(),
            credentialVersion: 3,
          },
        }),
      }),
    );

    expect(identity).toBeNull();
  });

  it("never pays a directory RPC for a non-udt_ unknown credential", async () => {
    const identity = await authenticateDeviceComposite(
      bearerRequest(`unknown-${crypto.randomUUID()}`),
      noDirectoryEnv({ DEVICE_TOKENS: "{}" }),
    );
    expect(identity).toBeNull();
  });

  it("revalidates a directory credential on every request", async () => {
    const user = await mintUser();
    await setUserOrigins(user.userId, ["https://example.com"]);
    const created = await directory().createPairingOffer(user.userId);
    const claimed = await claimOffer(created.offer);
    if (claimed.kind !== "ok") throw new Error("claim failed");

    const identity = await authenticateDeviceComposite(
      bearerRequest(claimed.deviceCredential),
      env,
    );
    expect(identity).toMatchObject({
      tenantId: user.tenantId,
      deviceId: claimed.deviceId,
      credentialVersion: 1,
    });

    expect(await directory().revokeDevice(user.userId, claimed.deviceId)).toBe("revoked");
    expect(
      await authenticateDeviceComposite(bearerRequest(claimed.deviceCredential), env),
    ).toBeNull();
  });

  it("scopes device revocation to the owning user", async () => {
    const owner = await mintUser();
    await setUserOrigins(owner.userId, ["https://example.com"]);
    const created = await directory().createPairingOffer(owner.userId);
    const claimed = await claimOffer(created.offer);
    if (claimed.kind !== "ok") throw new Error("claim failed");

    const stranger = await mintUser();
    // "not_found", not "already_revoked": a foreign id must be indistinguishable
    // from an unknown one, and it is the value the dashboard gates the push on.
    expect(await directory().revokeDevice(stranger.userId, claimed.deviceId)).toBe("not_found");
    expect(await directory().listDevices(stranger.userId)).toEqual([]);
    // The owner's own second click reports already_revoked, which still pushes.
    expect(await directory().revokeDevice(owner.userId, claimed.deviceId)).toBe("revoked");
    expect(await directory().revokeDevice(owner.userId, claimed.deviceId)).toBe(
      "already_revoked",
    );
  });
});

describe("AccountDirectory MCP tokens", () => {
  it("mints device-bound usk_v2 tokens verifiable by digest and revocable by owner", async () => {
    const user = await mintUser();
    const offer = await directory().createPairingOffer(user.userId);
    const device = await directory().claimPairingOffer(
      await taggedHmacHex(env, "pair-v2", offer.offer),
      await sha256Hex("account-directory-test-claim"),
    );
    if (device.kind !== "ok") throw new Error("pairing claim failed");
    const created = await directory().createMcpToken(user.userId, device.deviceId, "laptop");
    expect(created).not.toBeNull();
    if (created === null) return;
    expect(created.token).toMatch(/^usk_v2_[0-9A-Za-z]{16}_[A-Za-z0-9_-]{43}$/);
    expect(created.token).toContain(created.tokenId);

    const identity = await directory().verifyMcpToken(await sha256Hex(created.token));
    expect(identity).toEqual({
      userId: user.userId,
      tenantId: user.tenantId,
      tokenId: created.tokenId,
      deviceId: device.deviceId,
      authEpoch: 1,
    });
    expect(
      await directory().authorizeMcpIdentity({
        userId: user.userId,
        tenantId: user.tenantId,
        deviceId: device.deviceId,
        authEpoch: 1,
        contractVersion: AUTH_CONTRACT_VERSION,
      }),
    ).toBe(true);
    expect(
      await directory().authorizeMcpIdentity({
        userId: user.userId,
        tenantId: user.tenantId,
        deviceId: device.deviceId,
        authEpoch: 0,
        contractVersion: AUTH_CONTRACT_VERSION,
      }),
    ).toBe(false);
    expect(
      await directory().authorizeMcpIdentity({
        userId: user.userId,
        tenantId: user.tenantId,
        deviceId: device.deviceId,
        authEpoch: 1,
        contractVersion: 1,
      }),
    ).toBe(false);

    const listed = await directory().listMcpTokens(user.userId);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ tokenId: created.tokenId, label: "laptop" });
    expect(JSON.stringify(listed)).not.toContain(created.token.slice(-20));

    const stranger = await mintUser();
    expect(await directory().revokeMcpToken(stranger.userId, created.tokenId)).toBe(false);
    expect(await directory().revokeMcpToken(user.userId, created.tokenId)).toBe(true);
    expect(await directory().verifyMcpToken(await sha256Hex(created.token))).toBeNull();
    expect(await directory().listMcpTokens(user.userId)).toEqual([]);
  });

  it("applies the authentication hard cut only behind the explicit maintenance latch", async () => {
    const user = await mintUser();
    const offer = await directory().createPairingOffer(user.userId);
    const device = await directory().claimPairingOffer(
      await taggedHmacHex(env, "pair-v2", offer.offer),
      await sha256Hex("hard-cut-test-claim"),
    );
    if (device.kind !== "ok") throw new Error("pairing claim failed");
    const token = await directory().createMcpToken(user.userId, device.deviceId, "cutover");
    if (token === null) throw new Error("token creation failed");
    const digest = await sha256Hex(token.token);

    await expect(directory().applyProtocol3AuthenticationCutover("wrong-marker")).resolves.toBe(0);
    await expect(directory().verifyMcpToken(digest)).resolves.not.toBeNull();

    await expect(
      directory().applyProtocol3AuthenticationCutover(PROTOCOL_3_AUTH_CUTOVER),
    ).resolves.toBeGreaterThan(0);
    await expect(directory().verifyMcpToken(digest)).resolves.toBeNull();
    await expect(directory().getUser(user.userId)).resolves.toMatchObject({ authEpoch: 2 });
    await expect(
      directory().applyProtocol3AuthenticationCutover(PROTOCOL_3_AUTH_CUTOVER),
    ).resolves.toBe(0);
  });
});

describe("AccountDirectory sweep", () => {
  it("drops day-old challenges but keeps fresh consumed ones for the daily cap", async () => {
    const email = freshEmail();
    const old = await directory().requestOtp(email);
    const fresh = await directory().requestOtp(email);
    if (old.kind !== "ok" || fresh.kind !== "ok") throw new Error("otp request failed");
    await directory().verifyOtp(fresh.challengeId, fresh.code);
    await mutateChallenge(old.challengeId, "created_at", Date.now() - 25 * 60 * 60 * 1000);

    await runInDurableObject(directory(), (instance: AccountDirectory) => instance.alarm());

    await runInDurableObject(directory(), (instance: AccountDirectory) => {
      const rows = (instance as unknown as { ctx: DurableObjectState }).ctx.storage.sql
        .exec(`SELECT challenge_id FROM otp_challenges WHERE email = ?`, email)
        .toArray() as { challenge_id: string }[];
      expect(rows.map((row) => row.challenge_id)).toEqual([fresh.challengeId]);
    });
  });

  it("retains revoked device tombstones for offline re-pairing", async () => {
    const user = await mintUser();
    const offer = await directory().createPairingOffer(user.userId);
    const device = await claimOffer(offer.offer);
    if (device.kind !== "ok") throw new Error("pairing claim failed");
    expect(await directory().revokeDevice(user.userId, device.deviceId)).toBe("revoked");
    await runInDurableObject(directory(), (instance: AccountDirectory) => {
      (instance as unknown as { ctx: DurableObjectState }).ctx.storage.sql.exec(
        "UPDATE devices SET revoked_at = ? WHERE device_id = ?",
        Date.now() - 25 * 60 * 60 * 1000,
        device.deviceId,
      );
    });

    await runInDurableObject(directory(), (instance: AccountDirectory) => instance.alarm());
    const replacementOffer = await directory().createPairingOffer(user.userId);
    const replacement = await claimOffer(
      replacementOffer.offer,
      await sha256Hex(device.deviceCredential),
    );

    expect(replacement).toMatchObject({ kind: "ok" });
    if (replacement.kind !== "ok") return;
    expect(replacement.deviceId).not.toBe(device.deviceId);
  });
});
