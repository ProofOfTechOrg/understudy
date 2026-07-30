/**
 * Single source of truth for the test-only caller/extension tokens, shared
 * by vitest.config.ts (which injects CALLER_TOKENS/EXTENSION_TOKENS as
 * miniflare bindings) and the test suites (which use the token constants in
 * request headers / WS query params). No Workers-runtime imports here - this
 * file must also load in vitest.config.ts's plain Node/Vite context. Not
 * real credentials.
 */

export const CALLER_TOKEN_A = "test-caller-a";
export const CALLER_TOKEN_B = "test-caller-b";
/** A caller in the self-serve account class (an AccountDirectory-shaped tenant id). */
export const CALLER_TOKEN_ACCT = "test-caller-acct";
export const ACCT_TEST_TENANT = "acct-testtenant";
export const EXTENSION_TOKEN_A = "test-ext-a";
export const EXTENSION_TOKEN_B = "test-ext-b";

export const CALLER_TOKENS = {
  [CALLER_TOKEN_A]: { actor: "caller-a", tenantId: "tenantA" },
  [CALLER_TOKEN_B]: { actor: "caller-b", tenantId: "tenantB" },
  [CALLER_TOKEN_ACCT]: { actor: "caller-acct", tenantId: ACCT_TEST_TENANT },
};

export const EXTENSION_TOKENS = {
  [EXTENSION_TOKEN_A]: "tenantA",
  [EXTENSION_TOKEN_B]: "tenantB",
};

// base64url of the 32-byte literal "test-vault-master-key-abcdefghij" -
// the AES-256-GCM key vault.ts envelopes test secrets with (src/vault.ts).
export const TEST_VAULT_MASTER_KEY = "dGVzdC12YXVsdC1tYXN0ZXIta2V5LWFiY2RlZmdoaWo";

// Throwaway P-256 keypair for the dashboard vault-upload path
// (src/dashboard/vault-upload.ts): private half as base64url PKCS#8 for the
// VAULT_UPLOAD_PRIVATE_KEY binding, public half as the JWK the server would
// serve. Generated once for tests; NOT a real key. Intentionally the SAME
// value as .dev.vars.example — both are non-prod placeholders and sharing
// one keeps the dev/test envelope interchangeable; production sets a distinct
// key via `wrangler secret put`.
export const TEST_VAULT_UPLOAD_PRIVATE_KEY =
  "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgcmO5-On_WESihHpUNBdOBh90clMvrEOD7r5JU7Y792OhRANCAASl_9tbnm5mtv0a-UdQhfejPVDESCp5EzESV_2KVpEPOwOqqjswS8OJuVr40MZtRO9C-RnFH-C5vkohb2ppPaif";
export const TEST_VAULT_UPLOAD_PUBLIC_JWK = {
  kty: "EC",
  crv: "P-256",
  x: "pf_bW55uZrb9GvlHUIX3oz1QxEgqeRMxElf9ilaRDzs",
  y: "A6qqOzBLw4m5WvjQxm1E70L5GcUf4Lm-SiFvamk9qJ8",
};
