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
