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

import { getDirectory } from "../account-directory";
import { sha256Hex } from "../auth";
import { createPositiveCache } from "../cache";
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
const tokenCache = createPositiveCache<McpTokenIdentity>(60_000, 1024);

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
  let identity = tokenCache.get(digest);
  if (identity === undefined) {
    const verified = await getDirectory(env).verifyMcpToken(digest);
    if (verified === null) return mcpUnauthorized(origin);
    tokenCache.put(digest, verified);
    identity = verified;
  }

  const props: UnderstudyMcpProps = {
    userId: identity.userId,
    tenantId: identity.tenantId,
    actorId: `usk:${identity.tokenId}`,
    authMethod: "static",
    scopes: ["mcp"],
  };
  // The provider sets props by MUTATING the live ExecutionContext
  // (oauth-provider.js does `ctx.props = …`); mirror that exactly rather than
  // forging a literal, so every other ctx member the runtime added survives
  // and both auth branches are truly indistinguishable to the handler.
  (ctx as ExecutionContext & { props?: unknown }).props = props;
  return guardedMcpHandler.fetch(request, env, ctx);
}
