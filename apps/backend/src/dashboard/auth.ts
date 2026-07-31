/**
 * Dashboard session + CSRF plumbing. The cookie is an opaque 32-byte token
 * whose sha256 alone is stored (logout revokes instantly); CSRF rides a strict
 * same-origin check plus, for authed forms, an HMAC over the cookie token
 * recomputed server-side, so no extra storage.
 *
 * The layer count differs by route, and the thin case is the one that matters:
 * `/dashboard/auth/request-code` and `/dashboard/auth/verify` run before any
 * session exists, so there is no cookie to key an HMAC on and `sameOriginRequest`
 * is their ONLY CSRF control. It defends a real attack, not a theoretical one:
 * an attacker completes the OTP flow against their own address, then cross-site
 * posts that challengeId+code from the victim's browser. `Set-Cookie` is
 * honoured on a cross-site response (SameSite governs sending, not setting), so
 * the victim ends up authenticated as the attacker and pairs their browser and
 * vault secrets into the attacker's tenant. Do not reduce this to
 * defence-in-depth on the strength of the authed routes' extra layers.
 */

import type { DashboardSessionIdentity } from "../account-directory";
import { getDirectory } from "../account-directory";
import { sha256Hex, taggedHmacHex, timingSafeHexEqual } from "../auth";
import type { Env } from "../types";

export const DASH_COOKIE = "__Host-understudy_dash";
const COOKIE_MAX_AGE_S = 7 * 24 * 60 * 60;

export interface DashboardUser extends DashboardSessionIdentity {
  cookieToken: string;
}

function cookieValue(header: string | null, name: string): string | null {
  if (header === null) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

export async function sessionFromRequest(
  request: Request,
  env: Env,
): Promise<DashboardUser | null> {
  const token = cookieValue(request.headers.get("Cookie"), DASH_COOKIE);
  if (token === null || token.length < 16 || token.length > 128) return null;
  const identity = await getDirectory(env).getDashboardSession(await sha256Hex(token));
  if (identity === null) return null;
  return { ...identity, cookieToken: token };
}

/**
 * Lax (not Strict) is load-bearing: the top-level navigation into
 * /oauth/authorize from an OAuth client must carry the cookie or every
 * consent starts with a redundant login. Absolute Max-Age, no sliding.
 */
export function sessionCookie(token: string): string {
  return (
    `${DASH_COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; ` +
    `Max-Age=${COOKIE_MAX_AGE_S}`
  );
}

export function clearedSessionCookie(): string {
  return `${DASH_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function csrfTokenFor(env: Env, cookieToken: string): Promise<string> {
  return taggedHmacHex(env, "csrf-v1", cookieToken);
}

export async function csrfValid(
  env: Env,
  cookieToken: string,
  submitted: unknown,
): Promise<boolean> {
  if (typeof submitted !== "string" || submitted.length === 0) return false;
  return timingSafeHexEqual(await csrfTokenFor(env, cookieToken), submitted);
}

/**
 * Strict same-origin check for every non-safe dashboard/consent request: both
 * signals absent ⇒ refuse. A pure header predicate — the caller decides which
 * methods it guards and what a refusal returns (see the middleware in `app.ts`).
 *
 * `Sec-Fetch-Site` is the primary signal, NOT `Origin`. Fetch's "append a
 * request Origin header" serializes a non-CORS non-GET request's origin as the
 * literal `null` under referrer policy `no-referrer`, so `Origin` is only ever
 * as trustworthy as the response headers this app itself sets — a privacy
 * header can silently turn the check into a deny-all. `Sec-Fetch-Site` is
 * computed from the initiator and its URL list, with no referrer-policy input,
 * so nothing this app serves can suppress it.
 *
 * Only `same-origin` admits. `same-site` is refused deliberately: the canonical
 * host sits under a registrable domain, so a compromised sibling subdomain
 * would present `same-site`, and this app has no legitimate second origin.
 * `none` (address-bar, bookmark, restored POST) is refused too — stricter than
 * the usual Fetch Metadata policy, which is safe here because every guarded
 * request originates from a form this app rendered.
 *
 * `Origin` is the fallback when `Sec-Fetch-Site` is absent. It is not a weaker
 * trust signal — both are forbidden header names, so a cross-site page can
 * forge neither; the fallback exists because deleting it converts any UA that
 * omits fetch metadata into an unrecoverable 403 on sign-in itself, with no
 * user-visible diagnosis. It stays reachable in a useful state only while the
 * referrer policy is not `no-referrer` — see the header block in `app.ts`.
 */
export function sameOriginRequest(request: Request): boolean {
  const site = request.headers.get("Sec-Fetch-Site");
  if (site !== null) return site === "same-origin";
  const origin = request.headers.get("Origin");
  if (origin === null) return false;
  return origin === new URL(request.url).origin;
}

// Rejects control characters (U+0000–U+001F, incl. CR/LF) and backslash.
// `next` is later handed to c.redirect(), and a CR/LF in a Location value
// throws inside the Headers implementation — an ungraceful 500 from a
// phishable link. Normal query characters (?, =, &, letters, digits) are all
// above U+001F and pass.
// eslint-disable-next-line no-control-regex
const NEXT_FORBIDDEN = /[\u0000-\u001f\\]/;

/**
 * Open-redirect guard for the post-login `next` target. Its only legitimate
 * producer is the consent flow, so anything that is not a local
 * /oauth/authorize path collapses to the dashboard home.
 */
export function safeNext(raw: unknown): string {
  if (
    typeof raw === "string" &&
    raw.startsWith("/oauth/authorize") &&
    !raw.startsWith("//") &&
    !NEXT_FORBIDDEN.test(raw)
  ) {
    return raw;
  }
  return "/dashboard";
}
