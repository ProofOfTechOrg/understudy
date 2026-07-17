/**
 * Caller (consumer) auth, session-tenant scoping, and extension auth (M-006).
 *
 * Three independent verification paths: authenticate() maps a caller's
 * bearer token to an {actor, tenantId} (who is calling the command API);
 * mintSessionId/scopeSession bind a sessionId to its owning tenant so a
 * cross-tenant request is refused with 404, never 403 - a 403 would confirm
 * the session exists for someone who does not own it, an existence oracle
 * (DL-008); verifyExtensionToken authenticates the extension's own WebSocket
 * connection independently of caller auth, so no caller credential is ever
 * sent to (or trusted from) the browser extension.
 */
import { base64urlDecode, base64urlEncode } from "./base64url";
import type { Env } from "./types";

export interface Actor {
  actor: string;
  tenantId: string;
}

export interface TokenVerifier {
  verify(token: string): Promise<Actor | null>;
}

export class StaticTokenVerifier implements TokenVerifier {
  private readonly tokens: Record<string, Actor>;

  constructor(tokens: Record<string, Actor>) {
    this.tokens = tokens;
  }

  async verify(token: string): Promise<Actor | null> {
    return Object.hasOwn(this.tokens, token) ? (this.tokens[token] ?? null) : null;
  }
}

const BEARER_PREFIX = "Bearer ";

export async function authenticate(req: Request, env: Env): Promise<Actor | null> {
  const header = req.headers.get("Authorization");
  if (!header || !header.startsWith(BEARER_PREFIX)) return null;

  const token = header.slice(BEARER_PREFIX.length).trim();
  if (!token || !env.CALLER_TOKENS) return null;

  let tokens: Record<string, Actor>;
  try {
    tokens = JSON.parse(env.CALLER_TOKENS) as Record<string, Actor>;
  } catch {
    return null;
  }

  return new StaticTokenVerifier(tokens).verify(token);
}

/**
 * A tenantId must be a flat, non-empty slug. The credential vault namespaces
 * keys as `vault://<tenantId>/<name>` and SessionAgent.fillSecret isolates
 * tenants with a `vault://<tenantId>/` prefix check, so a tenantId that is
 * empty or contains `/` would let one tenant's prefix straddle another's
 * namespace (tenant "acme" reaching "acme/eu"'s keys). Enforced at mint
 * (fail-closed at session creation) and re-checked in tenantOf, so no signed
 * id can carry an unsafe tenant into that prefix check.
 */
export function isValidTenantId(tenantId: string): boolean {
  return tenantId.length > 0 && !tenantId.includes("/");
}

/**
 * Mints a sessionId with the owning tenant embedded and HMAC-signed, so
 * scopeSession can verify ownership statelessly - no lookup table maps
 * sessionId -> tenant; the id carries its own proof (DL-008).
 */
export async function mintSessionId(tenantId: string, env: Env): Promise<string> {
  if (!isValidTenantId(tenantId)) {
    throw new Error("invalid tenantId: must be non-empty and contain no '/'");
  }
  const nonce = toHex(crypto.getRandomValues(new Uint8Array(16)));
  const payloadBytes = new TextEncoder().encode(JSON.stringify({ t: tenantId, n: nonce }));

  const key = await importHmacKey(env.AUTH_HMAC_SECRET);
  const sig = await crypto.subtle.sign("HMAC", key, payloadBytes);

  return `${base64urlEncode(payloadBytes)}.${base64urlEncode(new Uint8Array(sig))}`;
}

/**
 * Verifies sessionId's HMAC signature and returns the tenant embedded in it,
 * or null for any malformed / forged / undecodable id. This is a session's
 * AUTHORITATIVE tenant - it comes from the signed id itself, never a
 * caller-supplied claim - so a Durable Object can trust `tenantOf(this.name)`
 * to scope a resource it owns (e.g. the credential vault) to that session's
 * owner. scopeSession is the boolean "does this id belong to tenantId?"
 * wrapper over it.
 */
export async function tenantOf(sessionId: string, env: Env): Promise<string | null> {
  try {
    const parts = sessionId.split(".");
    if (parts.length !== 2) return null;
    const [payloadB64, sigB64] = parts;
    if (!payloadB64 || !sigB64) return null;

    const payloadBytes = base64urlDecode(payloadB64);
    const sigBytes = base64urlDecode(sigB64);

    const key = await importHmacKey(env.AUTH_HMAC_SECRET);
    const verified = await crypto.subtle.verify("HMAC", key, sigBytes, payloadBytes);
    if (!verified) return null;

    const payload = JSON.parse(new TextDecoder().decode(payloadBytes)) as { t?: unknown };
    // Re-check the shape a valid mint enforces: a signed id must never carry an
    // empty or slash-bearing tenant into fillSecret's vault-namespace prefix
    // check (defense in depth against a token minted before this rule existed).
    return typeof payload.t === "string" && isValidTenantId(payload.t) ? payload.t : null;
  } catch {
    return null;
  }
}

/**
 * Whether sessionId is a valid id minted for tenantId. Every failure path -
 * bad shape, bad signature, wrong tenant, decode error - collapses to the
 * same "not-found" the caller surfaces as 404, so no response shape
 * distinguishes "malformed id" from "someone else's session" (DL-008: no
 * existence oracle).
 */
export async function scopeSession(
  sessionId: string,
  tenantId: string,
  env: Env,
): Promise<"ok" | "not-found"> {
  return (await tenantOf(sessionId, env)) === tenantId ? "ok" : "not-found";
}

/**
 * Verifies the extension's own per-user token (SessionAgent.onConnect),
 * independent of the caller-auth path above - the browser extension and the
 * consumer's backend are different trust boundaries with separate tokens.
 */
export async function verifyExtensionToken(
  token: string,
  env: Env,
): Promise<{ tenantId: string } | null> {
  if (!token || !env.EXTENSION_TOKENS) return null;

  let tokens: Record<string, string>;
  try {
    tokens = JSON.parse(env.EXTENSION_TOKENS) as Record<string, string>;
  } catch {
    return null;
  }

  if (!Object.hasOwn(tokens, token)) return null;

  const tenantId = tokens[token];
  return tenantId ? { tenantId } : null;
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
