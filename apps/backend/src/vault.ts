/**
 * Envelope encryption for the credential vault (the pre-production gate the
 * M3 README called out): KV stores only AES-256-GCM ciphertext envelopes,
 * so a KV read-back at rest yields nothing usable without VAULT_MASTER_KEY
 * (a Worker secret that never lives in KV or wrangler.jsonc).
 *
 * Envelope wire format: `v1.<base64url(iv)>.<base64url(ciphertext)>` with a
 * random 96-bit IV per value. GCM authenticates, so tampering (or the wrong
 * key) fails decryption outright - fail closed, never garbage plaintext.
 *
 * scripts/vault-put.mjs mirrors this format in plain Node for seeding; the
 * two must change together (the format test in vault.test.ts pins it).
 */

import { base64urlDecode, base64urlEncode } from "./base64url";
import type { Env, VaultBinding } from "./types";

const ENVELOPE_VERSION = "v1";
const IV_BYTES = 12;
const MASTER_KEY_BYTES = 32;

async function importMasterKey(masterKey: string, usage: "encrypt" | "decrypt"): Promise<CryptoKey> {
  let raw: Uint8Array;
  try {
    raw = base64urlDecode(masterKey);
  } catch {
    throw new Error("vault master key is not valid base64url");
  }
  if (raw.length !== MASTER_KEY_BYTES) {
    throw new Error(`vault master key must be ${MASTER_KEY_BYTES} bytes`);
  }
  return crypto.subtle.importKey("raw", raw as BufferSource, { name: "AES-GCM" }, false, [usage]);
}

/** Encrypts one secret value into the versioned envelope format. */
export async function encryptSecret(masterKey: string, plaintext: string): Promise<string> {
  const key = await importMasterKey(masterKey, "encrypt");
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    new TextEncoder().encode(plaintext),
  );
  return `${ENVELOPE_VERSION}.${base64urlEncode(iv)}.${base64urlEncode(new Uint8Array(ciphertext))}`;
}

/**
 * Decrypts one envelope. Throws on any malformed envelope, wrong key, or
 * tampered ciphertext - with a message that names the failure class only,
 * never envelope or plaintext material (DL-004).
 */
export async function decryptSecret(masterKey: string, envelope: string): Promise<string> {
  const parts = envelope.split(".");
  if (parts.length !== 3 || parts[0] !== ENVELOPE_VERSION || !parts[1] || !parts[2]) {
    throw new Error("vault value is not a recognized envelope");
  }
  const key = await importMasterKey(masterKey, "decrypt");
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64urlDecode(parts[1]) as BufferSource },
      key,
      base64urlDecode(parts[2]) as BufferSource,
    );
  } catch {
    // GCM auth failure and base64 garbage collapse to one scrubbed message:
    // distinguishing them would leak nothing useful and costs a code path.
    throw new Error("vault envelope failed to decrypt");
  }
  return new TextDecoder().decode(plaintext);
}

/**
 * The decrypting VaultBinding layer over the raw ciphertext store. get()
 * returns plaintext for a present envelope, null for an absent key, and
 * throws (fail closed) for an envelope it cannot decrypt - the caller
 * (SessionAgent.fillSecret via resolveSecret) already maps every throw to a
 * scrubbed ok:false result.
 */
export class EncryptedKvVault implements VaultBinding {
  constructor(
    private readonly store: VaultBinding,
    private readonly masterKey: string,
  ) {}

  async get(secretRef: string): Promise<string | null> {
    const envelope = await this.store.get(secretRef);
    if (envelope === null) return null;
    return decryptSecret(this.masterKey, envelope);
  }
}

/** The one production wiring: Env.VAULT ciphertext + VAULT_MASTER_KEY. */
export function createVault(env: Env): VaultBinding {
  return new EncryptedKvVault(env.VAULT, env.VAULT_MASTER_KEY);
}
