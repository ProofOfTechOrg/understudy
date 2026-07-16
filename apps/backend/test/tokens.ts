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
export const EXTENSION_TOKEN_A = "test-ext-a";
export const EXTENSION_TOKEN_B = "test-ext-b";

export const CALLER_TOKENS = {
  [CALLER_TOKEN_A]: { actor: "caller-a", tenantId: "tenantA" },
  [CALLER_TOKEN_B]: { actor: "caller-b", tenantId: "tenantB" },
};

export const EXTENSION_TOKENS = {
  [EXTENSION_TOKEN_A]: "tenantA",
  [EXTENSION_TOKEN_B]: "tenantB",
};

// base64url of the 32-byte literal "test-vault-master-key-abcdefghij" -
// the AES-256-GCM key vault.ts envelopes test secrets with (src/vault.ts).
export const TEST_VAULT_MASTER_KEY = "dGVzdC12YXVsdC1tYXN0ZXIta2V5LWFiY2RlZmdoaWo";
