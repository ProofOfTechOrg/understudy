import { describe, it, expect } from "vitest";
import { base64urlEncode } from "../src/base64url";
import { decryptSecret, encryptSecret, EncryptedKvVault } from "../src/vault";
import type { VaultBinding } from "../src/types";
import { TEST_VAULT_MASTER_KEY } from "./tokens";

const ENVELOPE_RE = /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

function randomKey(): string {
  return base64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
}

describe("vault envelope encryption", () => {
  it("round-trips a secret through the v1 envelope format", async () => {
    // #given a plaintext sealed with the master key
    const envelope = await encryptSecret(TEST_VAULT_MASTER_KEY, "hunter2");

    // #then the envelope is the pinned wire format (scripts/vault-put.mjs
    // mirrors it in Node; this test is what keeps the two in lockstep)
    // and carries no plaintext
    expect(envelope).toMatch(ENVELOPE_RE);
    expect(envelope).not.toContain("hunter2");

    // #when it is decrypted with the same key
    // #then the original plaintext comes back
    await expect(decryptSecret(TEST_VAULT_MASTER_KEY, envelope)).resolves.toBe("hunter2");
  });

  it("seals the same plaintext to different envelopes (fresh IV per value)", async () => {
    const first = await encryptSecret(TEST_VAULT_MASTER_KEY, "hunter2");
    const second = await encryptSecret(TEST_VAULT_MASTER_KEY, "hunter2");
    expect(first).not.toBe(second);
  });

  it("fails closed on the wrong key, with a scrubbed message", async () => {
    // #given an envelope sealed under one key and read under another
    const envelope = await encryptSecret(TEST_VAULT_MASTER_KEY, "hunter2");
    const failure = decryptSecret(randomKey(), envelope);

    // #then GCM authentication refuses it and the message names only the
    // failure class - no plaintext, no envelope material
    await expect(failure).rejects.toThrow("vault envelope failed to decrypt");
    await expect(failure).rejects.not.toThrow(/hunter2/);
  });

  it("fails closed on a tampered ciphertext", async () => {
    const envelope = await encryptSecret(TEST_VAULT_MASTER_KEY, "hunter2");
    const [version, iv, ct] = envelope.split(".") as [string, string, string];
    const flipped = ct.startsWith("A") ? `B${ct.slice(1)}` : `A${ct.slice(1)}`;

    await expect(
      decryptSecret(TEST_VAULT_MASTER_KEY, `${version}.${iv}.${flipped}`),
    ).rejects.toThrow("vault envelope failed to decrypt");
  });

  it("rejects values that are not v1 envelopes - a legacy plaintext KV value can never be served", async () => {
    for (const notAnEnvelope of ["hunter2", "v2.a.b", "v1.onlyone", "v1..", ""]) {
      await expect(decryptSecret(TEST_VAULT_MASTER_KEY, notAnEnvelope)).rejects.toThrow(
        "vault value is not a recognized envelope",
      );
    }
  });

  it("rejects a master key of the wrong length before touching the value", async () => {
    const short = base64urlEncode(crypto.getRandomValues(new Uint8Array(16)));
    await expect(encryptSecret(short, "x")).rejects.toThrow("vault master key must be 32 bytes");
  });
});

describe("EncryptedKvVault", () => {
  function storeWith(entries: Record<string, string>): VaultBinding {
    return { get: async (ref) => entries[ref] ?? null };
  }

  it("returns the decrypted plaintext for a present envelope", async () => {
    const envelope = await encryptSecret(TEST_VAULT_MASTER_KEY, "hunter2");
    const vault = new EncryptedKvVault(storeWith({ "vault://pw": envelope }), TEST_VAULT_MASTER_KEY);

    await expect(vault.get("vault://pw")).resolves.toBe("hunter2");
  });

  it("passes through null for an absent secretRef", async () => {
    const vault = new EncryptedKvVault(storeWith({}), TEST_VAULT_MASTER_KEY);
    await expect(vault.get("vault://missing")).resolves.toBeNull();
  });

  it("fails closed (throws) rather than serving a value it cannot authenticate", async () => {
    const vault = new EncryptedKvVault(
      storeWith({ "vault://legacy": "raw-plaintext-from-before-envelopes" }),
      TEST_VAULT_MASTER_KEY,
    );
    await expect(vault.get("vault://legacy")).rejects.toThrow(
      "vault value is not a recognized envelope",
    );
  });
});
