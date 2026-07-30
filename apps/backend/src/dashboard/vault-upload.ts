/**
 * Client-side-encrypted vault uploads (§6). The browser encrypts the secret
 * to the server's P-256 upload key (ephemeral ECDH → HKDF-SHA256 → AES-GCM)
 * so plaintext never rides a request body — it cannot land in ingress logs,
 * error reports, or replay captures, extending DL-004 to the upload path.
 *
 * Honest scope: the server holds the private key and decrypts to type the
 * secret into pages (that IS the feature), and it serves the JavaScript that
 * encrypts. This defends against accidental exposure, not a malicious
 * server; the UI says so rather than implying end-to-end encryption.
 *
 * The client mirror of this derivation lives in pages.ts (VAULT_UPLOAD_JS);
 * the two must change together.
 */

import { base64urlDecode } from "../base64url";
import type { Env } from "../types";

const HKDF_INFO = "understudy-vault-upload-v1";
const MAX_SECRET_CIPHERTEXT_BYTES = 8 * 1024;

export interface SealedUpload {
  /** base64url raw (uncompressed) ephemeral P-256 public key. */
  epk: string;
  /** base64url 12-byte AES-GCM IV. */
  iv: string;
  /** base64url ciphertext. */
  ct: string;
}

async function importPrivateKey(env: Env): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "pkcs8",
    base64urlDecode(env.VAULT_UPLOAD_PRIVATE_KEY) as BufferSource,
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
}

/** The public half (JWK) served to the browser and to offline CLI sealing. */
export async function uploadPublicJwk(
  env: Env,
): Promise<{ kty: string; crv: string; x: string; y: string }> {
  const exported = await crypto.subtle.exportKey("jwk", await importPrivateKey(env));
  if (exported instanceof ArrayBuffer) {
    throw new Error("vault upload key export was not a JWK");
  }
  const jwk = exported;
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || jwk.x === undefined || jwk.y === undefined) {
    throw new Error("vault upload key is not a P-256 key");
  }
  // An EC private JWK carries its public coordinates; only x/y leave here.
  return { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y };
}

/** Decrypts one sealed upload; null for anything malformed or unauthentic. */
export async function unsealUpload(env: Env, sealed: SealedUpload): Promise<string | null> {
  try {
    const ciphertext = base64urlDecode(sealed.ct);
    if (ciphertext.length > MAX_SECRET_CIPHERTEXT_BYTES) return null;
    const ephemeralKey = await crypto.subtle.importKey(
      "raw",
      base64urlDecode(sealed.epk) as BufferSource,
      { name: "ECDH", namedCurve: "P-256" },
      false,
      [],
    );
    // workers-types spells the field `$public` (JSG's reserved-word escape)
    // but the runtime property is `public`; the cast bridges the wart. The
    // dashboard vault e2e test pins the runtime behavior.
    const ecdhParams = {
      name: "ECDH",
      public: ephemeralKey,
    } as unknown as SubtleCryptoDeriveKeyAlgorithm;
    const sharedBits = await crypto.subtle.deriveBits(
      ecdhParams,
      await importPrivateKey(env),
      256,
    );
    const hkdfKey = await crypto.subtle.importKey("raw", sharedBits, "HKDF", false, [
      "deriveKey",
    ]);
    const aesKey = await crypto.subtle.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: new Uint8Array(0),
        info: new TextEncoder().encode(HKDF_INFO),
      },
      hkdfKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["decrypt"],
    );
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64urlDecode(sealed.iv) as BufferSource },
      aesKey,
      ciphertext as BufferSource,
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    return null;
  }
}
