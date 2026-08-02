/**
 * Caller (consumer) auth, session-tenant scoping, and extension auth (M-006).
 *
 * Three independent verification paths: authenticate() maps a caller's
 * bearer token to an {actor, tenantId} (who is calling the command API);
 * mintSessionId/scopeSession bind a fresh or idempotently replayed sessionId
 * to its owning tenant so a
 * cross-tenant request is refused with 404, never 403 - a 403 would confirm
 * the session exists for someone who does not own it, an existence oracle
 * (DL-008); verifyExtensionToken authenticates the extension's own WebSocket
 * connection independently of caller auth, so no caller credential is ever
 * sent to (or trusted from) the browser extension.
 */
import { base64urlDecode, base64urlEncode } from "./base64url";
import { getDirectory } from "./account-directory";
import { isCanonicalOrigin } from "./origin-policy";
import { parseStaticDeviceTokens } from "./static-device-config.mjs";
import type { Env } from "./types";

export interface Actor {
  actor: string;
  tenantId: string;
}

export interface DeviceIdentity {
  tenantId: string;
  deviceId: string;
  credentialVersion: number;
  credentialDigest: string;
  allowedOrigins: string[];
  policyVersion: number;
}

export interface WsTicketClaims {
  jti: string;
  aud: "device-control" | "session";
  tenantId: string;
  deviceId: string;
  credentialVersion?: number;
  allowedOrigins?: string[];
  policyVersion?: number;
  sessionId?: string;
  leaseId?: string;
  leaseEpoch: number;
  browserEpoch: string;
  agentName: string;
  exp: number;
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
 * A tenantId must be a flat, non-empty slug because it is embedded in signed
 * session identifiers and reused as the isolation key for Durable Objects,
 * device allocation, quota, and policy. Enforced at mint and re-checked in
 * tenantOf so legacy or forged identifiers cannot introduce a second path
 * segment with ambiguous ownership.
 */
export function isValidTenantId(tenantId: string): boolean {
  return tenantId.length > 0 && !tenantId.includes("/");
}

/**
 * Mints a sessionId with the owning tenant embedded and HMAC-signed, so
 * scopeSession can verify ownership statelessly - no lookup table maps
 * sessionId -> tenant; the id carries its own proof (DL-008). An idempotency
 * UUID is tenant-salted and hashed into the nonce so concurrent consumer
 * retries converge without exposing the caller's key in the returned id.
 */
export const SESSION_IDEMPOTENCY_KEY_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function mintSessionId(
  tenantId: string,
  env: Env,
  idempotencyKey?: string,
): Promise<string> {
  if (!isValidTenantId(tenantId)) {
    throw new Error("invalid tenantId: must be non-empty and contain no '/'");
  }
  if (
    idempotencyKey !== undefined &&
    !SESSION_IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)
  ) {
    throw new Error("invalid idempotency key: must be a UUID");
  }
  const nonce =
    idempotencyKey !== undefined
      ? toHex(
          new Uint8Array(
            await crypto.subtle.digest(
              "SHA-256",
              new TextEncoder().encode(`${tenantId}\0${idempotencyKey.toLowerCase()}`),
            ),
          ),
        ).slice(0, 32)
      : toHex(crypto.getRandomValues(new Uint8Array(16)));
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
 * to scope session state to its owner. scopeSession is the boolean "does this
 * id belong to tenantId?" wrapper over it.
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
    // Re-check the shape a valid mint enforces so a legacy signed id cannot
    // introduce an ambiguous tenant path segment.
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

/**
 * Resolves a `udt_v2` directory credential to its current identity. Shared by
 * connect-ticket auth and the heartbeat revocation check.
 */
async function resolveDirectoryDevice(
  digest: string,
  env: Env,
): Promise<DeviceIdentity | null> {
  return getDirectory(env).verifyDeviceCredential(digest);
}

function resolveStaticDevice(digest: string, env: Env): DeviceIdentity | null {
  if (!env.DEVICE_TOKENS) return null;
  let entries: ReturnType<typeof parseStaticDeviceTokens>;
  try {
    entries = parseStaticDeviceTokens(JSON.parse(env.DEVICE_TOKENS) as unknown);
  } catch {
    return null;
  }
  const entry = entries[digest];
  if (entry === undefined) return null;
  return {
    tenantId: entry.tenantId,
    deviceId: entry.deviceId.toLowerCase(),
    credentialVersion: entry.credentialVersion,
    credentialDigest: digest,
    allowedOrigins: entry.allowedOrigins,
    policyVersion: entry.policyVersion,
  };
}

/** Re-resolves the policy and credential fence used by an already-minted ticket. */
export type CurrentDeviceAuthority =
  | { kind: "live"; source: "static" | "directory"; identity: DeviceIdentity }
  | { kind: "not_directory" }
  | { kind: "invalid" };

export async function currentDeviceAuthority(
  digest: string,
  expected: Pick<DeviceIdentity, "tenantId" | "deviceId" | "credentialVersion">,
  env: Env,
): Promise<CurrentDeviceAuthority> {
  const current = resolveStaticDevice(digest, env);
  if (current !== null) {
    return current.tenantId === expected.tenantId &&
      current.deviceId === expected.deviceId &&
      current.credentialVersion === expected.credentialVersion
      ? { kind: "live", source: "static", identity: current }
      : { kind: "invalid" };
  }
  const directory = await getDirectory(env).inspectDeviceAuthority(digest, expected);
  return directory.kind === "live"
    ? { ...directory, source: "directory" }
    : directory;
}

/**
 * Device auth for both device classes: the static DEVICE_TOKENS blob first,
 * then AccountDirectory-minted `udt_v2` credentials. Only a matching bearer pays the
 * directory RPC, so an unknown non-directory credential costs no I/O.
 */
export async function authenticateDeviceComposite(
  req: Request,
  env: Env,
): Promise<DeviceIdentity | null> {
  const legacy = await authenticateDevice(req, env);
  if (legacy !== null) return legacy;
  const header = req.headers.get("Authorization");
  if (!header?.startsWith(BEARER_PREFIX)) return null;
  const credential = header.slice(BEARER_PREFIX.length).trim();
  if (!credential.startsWith("udt_v2_")) return null;
  return resolveDirectoryDevice(await sha256Hex(credential), env);
}

export type DeviceCredentialStatus = "live" | "superseded" | "revoked";

/** Resolves heartbeat liveness across static and directory-backed devices. */
export async function deviceCredentialStatus(
  digest: string,
  identity: Pick<DeviceIdentity, "tenantId" | "deviceId" | "credentialVersion">,
  env: Env,
): Promise<DeviceCredentialStatus> {
  if (await deviceCredentialExists(digest, identity, env)) return "live";
  return getDirectory(env).deviceCredentialStatus(digest, identity);
}

export async function authenticateDevice(
  req: Request,
  env: Env,
): Promise<DeviceIdentity | null> {
  const header = req.headers.get("Authorization");
  if (!header?.startsWith(BEARER_PREFIX)) return null;
  const credential = header.slice(BEARER_PREFIX.length).trim();
  if (!credential || !env.DEVICE_TOKENS) return null;
  const credentialDigest = await sha256Hex(credential);

  return resolveStaticDevice(credentialDigest, env);
}

export async function deviceCredentialExists(
  digest: string,
  identity: Pick<DeviceIdentity, "tenantId" | "deviceId" | "credentialVersion">,
  env: Env,
): Promise<boolean> {
  if (!env.DEVICE_TOKENS) return false;
  try {
    const entries = parseStaticDeviceTokens(JSON.parse(env.DEVICE_TOKENS) as unknown);
    const entry = entries[digest];
    return (
      entry?.tenantId === identity.tenantId &&
      entry.deviceId.toLowerCase() === identity.deviceId.toLowerCase() &&
      entry.credentialVersion === identity.credentialVersion
    );
  } catch {
    return false;
  }
}

export async function mintWsTicket(
  claims: Omit<WsTicketClaims, "jti" | "exp">,
  env: Env,
  now = Date.now(),
): Promise<string> {
  const complete: WsTicketClaims = {
    ...claims,
    jti: crypto.randomUUID(),
    exp: Math.floor(now / 1000) + 60,
  };
  const payload = new TextEncoder().encode(JSON.stringify(complete));
  const signature = await crypto.subtle.sign(
    "HMAC",
    await importNamedHmacKey(env.WS_TICKET_SECRET),
    payload,
  );
  return `${base64urlEncode(payload)}.${base64urlEncode(new Uint8Array(signature))}`;
}

export async function verifyWsTicket(
  ticket: string,
  expected: { aud: WsTicketClaims["aud"]; agentName: string },
  env: Env,
  now = Date.now(),
): Promise<WsTicketClaims | null> {
  try {
    if (!ticket || ticket.length > 4 * 1024) return null;
    const parts = ticket.split(".");
    if (parts.length !== 2) return null;
    const [payloadPart, signaturePart] = parts;
    if (!payloadPart || !signaturePart) return null;
    const payload = base64urlDecode(payloadPart);
    const signature = base64urlDecode(signaturePart);
    if (
      base64urlEncode(payload) !== payloadPart ||
      base64urlEncode(signature) !== signaturePart
    ) {
      return null;
    }
    const valid = await crypto.subtle.verify(
      "HMAC",
      await importNamedHmacKey(env.WS_TICKET_SECRET),
      signature,
      payload,
    );
    if (!valid) return null;
    const rawClaims = JSON.parse(new TextDecoder().decode(payload)) as unknown;
    if (
      typeof rawClaims !== "object" ||
      rawClaims === null ||
      Array.isArray(rawClaims)
    ) {
      return null;
    }
    const claims = rawClaims as Partial<WsTicketClaims>;
    const allowedClaims = new Set([
      "jti",
      "aud",
      "tenantId",
      "deviceId",
      "credentialVersion",
      "allowedOrigins",
      "policyVersion",
      "sessionId",
      "leaseId",
      "leaseEpoch",
      "browserEpoch",
      "agentName",
      "exp",
    ]);
    if (
      Object.keys(claims).some((key) => !allowedClaims.has(key)) ||
      typeof claims.jti !== "string" ||
      !isUuid(claims.jti) ||
      claims.aud !== expected.aud ||
      typeof claims.tenantId !== "string" ||
      !isValidTenantId(claims.tenantId) ||
      typeof claims.deviceId !== "string" ||
      !isUuid(claims.deviceId) ||
      typeof claims.leaseEpoch !== "number" ||
      !Number.isInteger(claims.leaseEpoch) ||
      claims.leaseEpoch < 0 ||
      typeof claims.browserEpoch !== "string" ||
      claims.browserEpoch.length < 1 ||
      claims.browserEpoch.length > 128 ||
      claims.agentName !== expected.agentName ||
      typeof claims.exp !== "number" ||
      !Number.isInteger(claims.exp) ||
      claims.exp <= Math.floor(now / 1000) ||
      claims.exp > Math.floor(now / 1000) + 60
    ) {
      return null;
    }
    if (
      (claims.sessionId !== undefined &&
        (typeof claims.sessionId !== "string" || claims.sessionId.length > 128)) ||
      (claims.leaseId !== undefined &&
        (typeof claims.leaseId !== "string" || claims.leaseId.length > 128))
    ) {
      return null;
    }
    if (
      claims.credentialVersion !== undefined &&
      (typeof claims.credentialVersion !== "number" ||
        !Number.isInteger(claims.credentialVersion) ||
        claims.credentialVersion < 1)
    ) {
      return null;
    }
    if (
      claims.allowedOrigins !== undefined &&
      (!Array.isArray(claims.allowedOrigins) ||
        claims.allowedOrigins.length > 32 ||
        !claims.allowedOrigins.every(isCanonicalOrigin) ||
        !sameStrings(claims.allowedOrigins, [...new Set(claims.allowedOrigins)].sort()))
    ) {
      return null;
    }
    if (
      claims.policyVersion !== undefined &&
      (!Number.isInteger(claims.policyVersion) || claims.policyVersion < 1)
    ) {
      return null;
    }
    if (
      (claims.aud === "device-control" &&
        (claims.credentialVersion === undefined ||
          claims.allowedOrigins === undefined ||
          claims.policyVersion === undefined ||
          claims.sessionId !== undefined ||
          claims.leaseId !== undefined ||
          claims.leaseEpoch !== 0)) ||
      (claims.aud === "session" &&
        (claims.credentialVersion !== undefined ||
          claims.allowedOrigins !== undefined ||
          claims.policyVersion !== undefined ||
          typeof claims.sessionId !== "string" ||
          claims.sessionId.length < 1 ||
          typeof claims.leaseId !== "string" ||
          claims.leaseId.length < 1 ||
          claims.leaseEpoch < 1))
    ) {
      return null;
    }
    return claims as WsTicketClaims;
  } catch {
    return null;
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export async function hashProfileStateKey(
  tenantId: string,
  profileStateKey: string,
  env: Env,
): Promise<string> {
  const bytes = new TextEncoder().encode(`profile-state\0${tenantId}\0${profileStateKey}`);
  const signature = await crypto.subtle.sign(
    "HMAC",
    await importHmacKey(env.AUTH_HMAC_SECRET),
    bytes,
  );
  return toHex(new Uint8Array(signature));
}

/**
 * Domain-separated HMAC over AUTH_HMAC_SECRET (D8): `<tag>|<value>`, hex.
 * Tags in use: otp-v1, pair-v2, pair-device-v2, csrf-v1, and consent-v1.
 * Reuses the one existing secret rather than adding rotation surface inside
 * the same trust boundary; the tag prefix keeps every use uncorrelatable with
 * the others and with telemetryPseudonym (which uses NUL-separated framing).
 */
export async function taggedHmacHex(env: Env, tag: string, value: string): Promise<string> {
  const signature = await crypto.subtle.sign(
    "HMAC",
    await importHmacKey(env.AUTH_HMAC_SECRET),
    new TextEncoder().encode(`${tag}|${value}`),
  );
  return toHex(new Uint8Array(signature));
}

export async function telemetryPseudonym(
  domain: string,
  value: string,
  env: Env,
): Promise<string> {
  const signature = await crypto.subtle.sign(
    "HMAC",
    await importHmacKey(env.AUTH_HMAC_SECRET),
    new TextEncoder().encode(`telemetry\0${domain}\0${value}`),
  );
  return toHex(new Uint8Array(signature)).slice(0, 32);
}

export type RateLimitIdentity =
  | { kind: "caller"; tenantId: string; actor: string }
  | { kind: "device"; tenantId: string; deviceId: string };

export async function authenticatedRateAllowed(
  identity: RateLimitIdentity,
  env: Env,
): Promise<boolean> {
  if (env.RATE_LIMITER === undefined) return true;
  const domain =
    identity.kind === "caller" ? "rate-limit-caller" : "rate-limit-device";
  const value =
    identity.kind === "caller"
      ? JSON.stringify([identity.tenantId, identity.actor])
      : JSON.stringify([identity.tenantId, identity.deviceId]);
  const key = await telemetryPseudonym(domain, value, env);
  return (await env.RATE_LIMITER.limit({ key })).success;
}

/**
 * Per-IP abuse backstop for endpoints that exist BEFORE authentication (OTP
 * request, pairing claim, DCR). Fail-open when the limiter binding is absent
 * (tests/dev) — the authoritative guards on those endpoints are their
 * single-use/attempt-capped semantics, not this limiter.
 */
export async function unauthenticatedRateAllowed(
  request: Request,
  env: Env,
  domain: string,
): Promise<boolean> {
  if (env.RATE_LIMITER === undefined) return true;
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const key = await telemetryPseudonym(`rate-limit-ip-${domain}`, ip, env);
  return (await env.RATE_LIMITER.limit({ key })).success;
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

async function importNamedHmacKey(secret: string): Promise<CryptoKey> {
  if (!secret) throw new Error("missing WebSocket ticket secret");
  return importHmacKey(secret);
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return toHex(new Uint8Array(digest));
}

/**
 * Constant-time equality for two hex digests of equal length. The one place
 * every HMAC/digest comparison in this service should route through, so
 * OTP verification, CSRF, and consent-signature checks share one primitive
 * instead of a mix of `===` and hand-rolled loops.
 */
export function timingSafeHexEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  if (left.byteLength !== right.byteLength) return false;
  return crypto.subtle.timingSafeEqual(left, right);
}

function isUuid(value: string): boolean {
  return SESSION_IDEMPOTENCY_KEY_PATTERN.test(value);
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
