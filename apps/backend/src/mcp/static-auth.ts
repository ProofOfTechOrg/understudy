/**
 * The static-token fast path (D2): a `usk_` bearer on /mcp is verified
 * against AccountDirectory and converges on the same props shape the OAuth
 * grants carry — one downstream identity model, two front doors.
 *
 * Returns null ONLY when the request does not present a usk_ bearer, so a
 * missing token always falls through to the OAuthProvider and gets its
 * discovery-grade 401 (that 401 is what bootstraps OAuth-capable clients).
 * A present-but-invalid usk_ token gets the mirrored 401 from props.ts.
 */

import { sha256Hex } from "../auth";
import type { Env } from "../types";
import type { McpTokenIdentity } from "../account-directory";
import { guardedMcpHandler } from "./handler";
import { mcpUnauthorized, type UnderstudyMcpProps } from "./props";

const BEARER_PREFIX = "Bearer ";
const USK_PATTERN = /^usk_v1_[0-9A-Za-z]{16}_[A-Za-z0-9_-]{43}$/;

/**
 * Positive-only 60s cache, keyed by token digest. Never caches misses — a
 * token created in the dashboard must work on the very next request.
 * Revocation therefore takes up to 60s beyond the directory row flip.
 */
const TOKEN_CACHE_TTL_MS = 60_000;
const TOKEN_CACHE_MAX_ENTRIES = 1024;
const tokenCache = new Map<string, { identity: McpTokenIdentity; expiresAt: number }>();

function tokenCacheGet(digest: string): McpTokenIdentity | undefined {
  const entry = tokenCache.get(digest);
  if (entry === undefined) return undefined;
  if (entry.expiresAt <= Date.now()) {
    tokenCache.delete(digest);
    return undefined;
  }
  return entry.identity;
}

function tokenCachePut(digest: string, identity: McpTokenIdentity): void {
  if (tokenCache.size >= TOKEN_CACHE_MAX_ENTRIES) {
    const oldest = tokenCache.keys().next().value;
    if (oldest !== undefined) tokenCache.delete(oldest);
  }
  tokenCache.set(digest, { identity, expiresAt: Date.now() + TOKEN_CACHE_TTL_MS });
}

/** Test seam: the cache is module state, shared across a pool-worker run. */
export function clearMcpTokenCache(): void {
  tokenCache.clear();
}

export async function tryStaticMcpAuth(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response | null> {
  const header = request.headers.get("Authorization");
  if (!header?.startsWith(BEARER_PREFIX)) return null;
  const token = header.slice(BEARER_PREFIX.length).trim();
  if (!token.startsWith("usk_")) return null;

  const origin = new URL(request.url).origin;
  // Malformed usk_ tokens are refused before any I/O.
  if (!USK_PATTERN.test(token)) return mcpUnauthorized(origin);

  const digest = await sha256Hex(token);
  let identity = tokenCacheGet(digest);
  if (identity === undefined) {
    const verified = await env.ACCOUNT_DIRECTORY.getByName("directory").verifyMcpToken(digest);
    if (verified === null) return mcpUnauthorized(origin);
    tokenCachePut(digest, verified);
    identity = verified;
  }

  const props: UnderstudyMcpProps = {
    userId: identity.userId,
    tenantId: identity.tenantId,
    actorId: `usk:${identity.tokenId}`,
    authMethod: "static",
    scopes: ["mcp"],
  };
  // The provider sets ctx.props for OAuth requests; mirror that contract so
  // both branches are indistinguishable to the handler.
  const propsCtx = {
    waitUntil: ctx.waitUntil.bind(ctx),
    passThroughOnException: ctx.passThroughOnException.bind(ctx),
    props,
  } as ExecutionContext;
  return guardedMcpHandler.fetch(request, env, propsCtx);
}
