/**
 * Dashboard session + CSRF plumbing. The cookie is an opaque 32-byte token
 * whose sha256 alone is stored (logout revokes instantly); CSRF rides two
 * layers on every POST — a strict same-origin check plus, for authed forms,
 * an HMAC over the cookie token recomputed server-side, so no extra storage.
 */

import type { DashboardSessionIdentity } from "../account-directory";
import { sha256Hex, taggedHmacHex } from "../auth";
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
  const identity = await env.ACCOUNT_DIRECTORY.getByName("directory").getDashboardSession(
    await sha256Hex(token),
  );
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
  return (await csrfTokenFor(env, cookieToken)) === submitted;
}

/** Strict same-origin check for every dashboard/consent POST: absent ⇒ 403. */
export function originAllowed(request: Request): boolean {
  const origin = request.headers.get("Origin");
  if (origin === null) return false;
  return origin === new URL(request.url).origin;
}

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
    !raw.includes("\\")
  ) {
    return raw;
  }
  return "/dashboard";
}
