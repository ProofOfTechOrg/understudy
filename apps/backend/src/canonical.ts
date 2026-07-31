/**
 * The single OAuth issuer / service identity. Five modules used to hardcode
 * this host or a URL derived from it (the index.ts redirect that decides
 * whether the others are even reachable, the OAuth resource metadata, the
 * dashboard connect card, the MCP outcome copy, the AccountAgent status-URL
 * base). Derive them all from one constant so a domain change is one edit.
 */

// Not exported: every consumer wants the origin, which pins the scheme too.
// A host-only comparison is what let a plain-http request reach the account
// plane without Fetch Metadata (see the index.ts guard).
const CANONICAL_HOST = "understudy.proofof.tech";
export const CANONICAL_ORIGIN = `https://${CANONICAL_HOST}`;
export const MCP_URL = `${CANONICAL_ORIGIN}/mcp`;
export const DASHBOARD_URL = `${CANONICAL_ORIGIN}/dashboard`;
/** Trailing-slash base for `new URL(path, base)` composition. */
export const CANONICAL_BASE_URL = `${CANONICAL_ORIGIN}/`;
