/**
 * The single OAuth issuer / service identity. Five modules used to hardcode
 * this host or a URL derived from it (the index.ts redirect that decides
 * whether the others are even reachable, the OAuth resource metadata, the
 * dashboard connect card, the MCP outcome copy, the AccountAgent status-URL
 * base). Derive them all from one constant so a domain change is one edit.
 */

declare const __UNDERSTUDY_SERVICE_ORIGIN__: string;

const PRODUCTION_ORIGIN = "https://understudy.proofof.tech";

export const CANONICAL_ORIGIN =
  typeof __UNDERSTUDY_SERVICE_ORIGIN__ === "string"
    ? __UNDERSTUDY_SERVICE_ORIGIN__
    : PRODUCTION_ORIGIN;
export const CANONICAL_HOST = new URL(CANONICAL_ORIGIN).hostname;
export const MCP_URL = `${CANONICAL_ORIGIN}/mcp`;
export const DASHBOARD_URL = `${CANONICAL_ORIGIN}/dashboard`;
/** Trailing-slash base for `new URL(path, base)` composition. */
export const CANONICAL_BASE_URL = `${CANONICAL_ORIGIN}/`;
