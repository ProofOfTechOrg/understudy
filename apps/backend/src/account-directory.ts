/**
 * AccountDirectory — the singleton Durable Object behind self-serve accounts.
 * One instance (getByName("directory")) owns users, email-OTP challenges,
 * dashboard cookie sessions, paired devices, pairing codes, and static MCP
 * tokens, so the three consume-once invariants — OTP, pairing code, token
 * revoke — run as serialized SQLite writes in one object instead of
 * eventually-consistent KV reads.
 *
 * Hot-path invariant: the per-command path never calls this object. Directory
 * RPCs happen only at OTP request/verify, dashboard page loads, pairing
 * claim, connect-ticket auth + heartbeat liveness for directory devices,
 * usk_ verification (behind the Worker-side 60-second positive-only cache),
 * and browser_open/browser_status device listing in AccountAgent.
 *
 * Display-once: only digests exist at rest — sha256 for device credentials,
 * MCP tokens, and cookie tokens (the Worker recomputes those digests without
 * this DO), keyed HMAC over AUTH_HMAC_SECRET for OTP codes and pairing codes
 * (short secrets, so an offline dump of this store must not be
 * brute-forceable). A full dump therefore yields nothing replayable.
 */

import { DurableObject } from "cloudflare:workers";
import type { DeviceIdentity } from "./auth";
import { isValidTenantId, sha256Hex, taggedHmacHex, timingSafeHexEqual } from "./auth";
import { base64urlEncode } from "./base64url";
import type { Env } from "./types";
import { canonicalizeOrigins, RequestBodyError } from "./validation";

/**
 * The account store is a singleton addressed by one fixed name; routing every
 * caller through this accessor keeps that load-bearing invariant in one place
 * instead of a `getByName("directory")` string literal at seven call sites.
 */
export function getDirectory(env: Env): DurableObjectStub<AccountDirectory> {
  return env.ACCOUNT_DIRECTORY.getByName("directory");
}

const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const OTP_MAX_ACTIVE_PER_EMAIL = 3;
const OTP_MAX_PER_EMAIL_PER_DAY = 8;
const PAIRING_TTL_MS = 10 * 60 * 1000;
const DASHBOARD_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_ACCOUNT_ORIGINS = 32;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** RFC 4648 base32, lowercased — tenant ids must satisfy isValidTenantId. */
const TENANT_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
/** Crockford base32 (no I/L/O/U) — pairing codes survive human transcription. */
const PAIRING_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TOKEN_ID_ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const OTP_ALPHABET = "0123456789";

export const TENANT_ID_PATTERN = /^acct-[a-z2-7]{10}$/;
const PAIRING_CODE_LENGTH = 8;

/**
 * Uppercases and strips separators, then maps the Crockford confusables
 * (O→0, I/L→1) so a transcribed code still matches. The extension applies the
 * same normalization before submitting (src/core/pairing-client.ts); the two
 * must stay in sync.
 */
export function normalizePairingCode(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
}

/** Uniform random characters via rejection sampling — no modulo bias. */
function randomChars(alphabet: string, length: number): string {
  const out: string[] = [];
  const limit = 256 - (256 % alphabet.length);
  while (out.length < length) {
    const bytes = crypto.getRandomValues(new Uint8Array(length * 2));
    for (const byte of bytes) {
      if (byte >= limit) continue;
      out.push(alphabet[byte % alphabet.length] ?? "");
      if (out.length === length) break;
    }
  }
  return out.join("");
}

function randomBase64urlSecret(): string {
  return base64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
}

export type RequestOtpResult =
  | { kind: "ok"; challengeId: string; code: string; email: string }
  | { kind: "rate_limited" }
  | { kind: "invalid_email" };

export type VerifyOtpResult =
  | { kind: "ok"; userId: string; email: string; tenantId: string }
  | { kind: "invalid" };

export interface DashboardSessionIdentity {
  userId: string;
  email: string;
  tenantId: string;
  allowedOrigins: string[];
}

export type CreatePairingCodeResult =
  | { kind: "ok"; code: string; expiresAt: number }
  | { kind: "no_origins" };

export type ClaimPairingCodeResult =
  | {
      kind: "ok";
      userId: string;
      tenantId: string;
      deviceId: string;
      deviceCredential: string;
      originPolicy: string[];
    }
  | { kind: "invalid" };

export interface DirectoryDeviceRecord {
  deviceId: string;
  label: string | null;
  allowedOrigins: string[];
  createdAt: number;
  lastSeenAt: number | null;
}

export interface McpTokenRecord {
  tokenId: string;
  label: string | null;
  createdAt: number;
  lastUsedAt: number | null;
}

export interface McpTokenIdentity {
  userId: string;
  tenantId: string;
  tokenId: string;
}

export interface CreateMcpTokenResult {
  token: string;
  tokenId: string;
}

export interface DirectoryUser {
  userId: string;
  email: string;
  tenantId: string;
  allowedOrigins: string[];
  createdAt: number;
}

export type SetOriginsResult =
  | { kind: "ok"; origins: string[] }
  | { kind: "invalid"; message: string };

export type RevokeDeviceResult = "revoked" | "already_revoked" | "not_found";

export class AccountDirectory extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.initializeSchema();
      if ((await ctx.storage.getAlarm()) === null) {
        await ctx.storage.setAlarm(Date.now() + SWEEP_INTERVAL_MS);
      }
    });
  }

  private initializeSchema(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS users (
        user_id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        tenant_id TEXT NOT NULL UNIQUE,
        allowed_origins TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        last_login_at INTEGER,
        disabled INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS otp_challenges (
        challenge_id TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        code_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        consumed_at INTEGER);
      CREATE INDEX IF NOT EXISTS otp_by_email ON otp_challenges(email, created_at);
      CREATE TABLE IF NOT EXISTS dashboard_sessions (
        session_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        revoked_at INTEGER);
      CREATE TABLE IF NOT EXISTS devices (
        device_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        credential_hash TEXT NOT NULL UNIQUE,
        credential_version INTEGER NOT NULL DEFAULT 1,
        label TEXT,
        allowed_origins TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        revoked_at INTEGER,
        last_seen_at INTEGER);
      CREATE TABLE IF NOT EXISTS pairing_codes (
        code_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        consumed_at INTEGER,
        device_id TEXT);
      CREATE TABLE IF NOT EXISTS mcp_tokens (
        token_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        label TEXT,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER,
        revoked_at INTEGER);
    `);
  }

  private rows<T extends Record<string, string | number | null>>(
    query: string,
    ...bindings: (string | number | null)[]
  ): T[] {
    return this.ctx.storage.sql.exec(query, ...bindings).toArray() as T[];
  }

  private row<T extends Record<string, string | number | null>>(
    query: string,
    ...bindings: (string | number | null)[]
  ): T | undefined {
    return this.rows<T>(query, ...bindings)[0];
  }

  async requestOtp(rawEmail: string): Promise<RequestOtpResult> {
    const email = rawEmail.trim().toLowerCase();
    if (email.length > 254 || !EMAIL_PATTERN.test(email)) {
      return { kind: "invalid_email" };
    }
    const now = Date.now();
    const active = this.row<{ n: number }>(
      `SELECT COUNT(*) AS n FROM otp_challenges
       WHERE email = ? AND consumed_at IS NULL AND expires_at > ?`,
      email,
      now,
    );
    const daily = this.row<{ n: number }>(
      `SELECT COUNT(*) AS n FROM otp_challenges WHERE email = ? AND created_at > ?`,
      email,
      now - DAY_MS,
    );
    if (
      (active?.n ?? 0) >= OTP_MAX_ACTIVE_PER_EMAIL ||
      (daily?.n ?? 0) >= OTP_MAX_PER_EMAIL_PER_DAY
    ) {
      return { kind: "rate_limited" };
    }
    const challengeId = crypto.randomUUID();
    const code = randomChars(OTP_ALPHABET, 6);
    const codeHash = await taggedHmacHex(
      this.env,
      "otp-v1",
      `${challengeId}|${email}|${code}`,
    );
    this.ctx.storage.sql.exec(
      `INSERT INTO otp_challenges (challenge_id, email, code_hash, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
      challengeId,
      email,
      codeHash,
      now,
      now + OTP_TTL_MS,
    );
    return { kind: "ok", challengeId, code, email };
  }

  async verifyOtp(challengeId: string, code: string): Promise<VerifyOtpResult> {
    const now = Date.now();
    const challenge = this.row<{
      email: string;
      code_hash: string;
      expires_at: number;
      attempts: number;
      consumed_at: number | null;
    }>(
      `SELECT email, code_hash, expires_at, attempts, consumed_at
       FROM otp_challenges WHERE challenge_id = ?`,
      challengeId,
    );
    if (
      challenge === undefined ||
      challenge.consumed_at !== null ||
      challenge.expires_at <= now
    ) {
      return { kind: "invalid" };
    }
    // Increment BEFORE comparing so a correct guess past the cap still fails
    // and concurrent guesses cannot share one attempt slot.
    const attempts = challenge.attempts + 1;
    this.ctx.storage.sql.exec(
      `UPDATE otp_challenges SET attempts = ? WHERE challenge_id = ?`,
      attempts,
      challengeId,
    );
    if (attempts > OTP_MAX_ATTEMPTS) return { kind: "invalid" };
    const expected = await taggedHmacHex(
      this.env,
      "otp-v1",
      `${challengeId}|${challenge.email}|${code}`,
    );
    if (!timingSafeHexEqual(expected, challenge.code_hash)) {
      return { kind: "invalid" };
    }
    // Re-read post-await: another concurrent verify may have consumed it.
    const fresh = this.row<{ consumed_at: number | null }>(
      `SELECT consumed_at FROM otp_challenges WHERE challenge_id = ?`,
      challengeId,
    );
    if (fresh === undefined || fresh.consumed_at !== null) return { kind: "invalid" };
    this.ctx.storage.sql.exec(
      `UPDATE otp_challenges SET consumed_at = ? WHERE challenge_id = ?`,
      now,
      challengeId,
    );
    const user = this.ensureUser(challenge.email, now);
    if (user === null) return { kind: "invalid" };
    this.ctx.storage.sql.exec(
      `UPDATE users SET last_login_at = ? WHERE user_id = ?`,
      now,
      user.userId,
    );
    return { kind: "ok", userId: user.userId, email: challenge.email, tenantId: user.tenantId };
  }

  private ensureUser(
    email: string,
    now: number,
  ): { userId: string; tenantId: string } | null {
    const existing = this.row<{ user_id: string; tenant_id: string; disabled: number }>(
      `SELECT user_id, tenant_id, disabled FROM users WHERE email = ?`,
      email,
    );
    if (existing !== undefined) {
      if (existing.disabled !== 0) return null;
      return { userId: existing.user_id, tenantId: existing.tenant_id };
    }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const tenantId = `acct-${randomChars(TENANT_ALPHABET, 10)}`;
      if (!isValidTenantId(tenantId) || !TENANT_ID_PATTERN.test(tenantId)) continue;
      const taken = this.row<{ n: number }>(
        `SELECT COUNT(*) AS n FROM users WHERE tenant_id = ?`,
        tenantId,
      );
      if ((taken?.n ?? 0) > 0) continue;
      const userId = crypto.randomUUID();
      this.ctx.storage.sql.exec(
        `INSERT INTO users (user_id, email, tenant_id, created_at) VALUES (?, ?, ?, ?)`,
        userId,
        email,
        tenantId,
        now,
      );
      return { userId, tenantId };
    }
    throw new Error("failed to mint a unique tenant id");
  }

  async createDashboardSession(userId: string): Promise<{ token: string; expiresAt: number }> {
    const token = randomBase64urlSecret();
    const now = Date.now();
    const expiresAt = now + DASHBOARD_SESSION_TTL_MS;
    this.ctx.storage.sql.exec(
      `INSERT INTO dashboard_sessions (session_hash, user_id, created_at, expires_at)
       VALUES (?, ?, ?, ?)`,
      await sha256Hex(token),
      userId,
      now,
      expiresAt,
    );
    return { token, expiresAt };
  }

  async getDashboardSession(tokenHash: string): Promise<DashboardSessionIdentity | null> {
    const record = this.row<{
      user_id: string;
      email: string;
      tenant_id: string;
      allowed_origins: string;
    }>(
      `SELECT u.user_id, u.email, u.tenant_id, u.allowed_origins
       FROM dashboard_sessions s JOIN users u ON u.user_id = s.user_id
       WHERE s.session_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?
         AND u.disabled = 0`,
      tokenHash,
      Date.now(),
    );
    if (record === undefined) return null;
    return {
      userId: record.user_id,
      email: record.email,
      tenantId: record.tenant_id,
      allowedOrigins: parseOrigins(record.allowed_origins),
    };
  }

  async revokeDashboardSession(tokenHash: string): Promise<void> {
    this.ctx.storage.sql.exec(
      `UPDATE dashboard_sessions SET revoked_at = ? WHERE session_hash = ?`,
      Date.now(),
      tokenHash,
    );
  }

  async getUser(userId: string): Promise<DirectoryUser | null> {
    const record = this.row<{
      user_id: string;
      email: string;
      tenant_id: string;
      allowed_origins: string;
      created_at: number;
    }>(
      `SELECT user_id, email, tenant_id, allowed_origins, created_at
       FROM users WHERE user_id = ? AND disabled = 0`,
      userId,
    );
    if (record === undefined) return null;
    return {
      userId: record.user_id,
      email: record.email,
      tenantId: record.tenant_id,
      allowedOrigins: parseOrigins(record.allowed_origins),
      createdAt: record.created_at,
    };
  }

  async setAllowedOrigins(userId: string, origins: string[]): Promise<SetOriginsResult> {
    if (origins.length > MAX_ACCOUNT_ORIGINS) {
      return { kind: "invalid", message: `at most ${MAX_ACCOUNT_ORIGINS} origins` };
    }
    let canonical: string[];
    try {
      canonical = canonicalizeOrigins(origins);
    } catch (error) {
      return {
        kind: "invalid",
        message: error instanceof RequestBodyError ? error.message : "invalid origin",
      };
    }
    this.ctx.storage.sql.exec(
      `UPDATE users SET allowed_origins = ? WHERE user_id = ?`,
      JSON.stringify(canonical),
      userId,
    );
    return { kind: "ok", origins: canonical };
  }

  async createPairingCode(userId: string): Promise<CreatePairingCodeResult> {
    const user = await this.getUser(userId);
    // The authoritative empty-origins refusal — the dashboard's disabled button
    // only mirrors it, and curl or a stale tab reaches here directly. Keep it
    // even if that button state is ever removed, because it is the ONLY layer
    // that can explain itself: claimPairingCode repeats the check for origins
    // emptied after minting but collapses to an anti-enumeration 404, and the
    // extension's normalizeProfileConfig — which pairDevice reaches by feeding
    // the claim response into configure(), so it is on this path, not just the
    // manual form — throws a generic pairing failure after the single-use code
    // has already been consumed.
    if (user === null || user.allowedOrigins.length === 0) {
      return { kind: "no_origins" };
    }
    const now = Date.now();
    const code = randomChars(PAIRING_ALPHABET, PAIRING_CODE_LENGTH);
    const codeHash = await taggedHmacHex(this.env, "pair-v1", normalizePairingCode(code));
    const expiresAt = now + PAIRING_TTL_MS;
    this.ctx.storage.sql.exec(
      `INSERT INTO pairing_codes (code_hash, user_id, created_at, expires_at)
       VALUES (?, ?, ?, ?)`,
      codeHash,
      userId,
      now,
      expiresAt,
    );
    return { kind: "ok", code, expiresAt };
  }

  /**
   * Consumes a pairing code and mints the device identity + credential —
   * credentials exist only from redeem time, so an unredeemed code leaves
   * nothing behind. Every failure mode (unknown, expired, already consumed,
   * disabled user, no origins) collapses to the same "invalid" so the
   * endpoint cannot be used to enumerate code state.
   */
  async claimPairingCode(codeHash: string): Promise<ClaimPairingCodeResult> {
    const now = Date.now();
    const record = this.row<{
      user_id: string;
      expires_at: number;
      consumed_at: number | null;
    }>(
      `SELECT user_id, expires_at, consumed_at FROM pairing_codes WHERE code_hash = ?`,
      codeHash,
    );
    if (record === undefined || record.consumed_at !== null || record.expires_at <= now) {
      return { kind: "invalid" };
    }
    const user = await this.getUser(record.user_id);
    if (user === null || user.allowedOrigins.length === 0) return { kind: "invalid" };

    const deviceId = crypto.randomUUID().toLowerCase();
    const deviceCredential = `udt_v1_${randomBase64urlSecret()}`;
    const credentialHash = await sha256Hex(deviceCredential);

    // Synchronous re-check + writes (no awaits in between), wrapped in a
    // storage transaction: the consume and the device insert land together
    // or not at all, and a concurrent claim that raced past the first read
    // sees consumed_at set.
    const claimed = this.ctx.storage.transactionSync(() => {
      const fresh = this.row<{ consumed_at: number | null; expires_at: number }>(
        `SELECT consumed_at, expires_at FROM pairing_codes WHERE code_hash = ?`,
        codeHash,
      );
      if (fresh === undefined || fresh.consumed_at !== null || fresh.expires_at <= now) {
        return false;
      }
      this.ctx.storage.sql.exec(
        `UPDATE pairing_codes SET consumed_at = ?, device_id = ? WHERE code_hash = ?`,
        now,
        deviceId,
        codeHash,
      );
      this.ctx.storage.sql.exec(
        `INSERT INTO devices
           (device_id, user_id, tenant_id, credential_hash, credential_version,
            allowed_origins, created_at)
         VALUES (?, ?, ?, ?, 1, ?, ?)`,
        deviceId,
        user.userId,
        user.tenantId,
        credentialHash,
        JSON.stringify(user.allowedOrigins),
        now,
      );
      return true;
    });
    if (!claimed) return { kind: "invalid" };
    return {
      kind: "ok",
      userId: user.userId,
      tenantId: user.tenantId,
      deviceId,
      deviceCredential,
      originPolicy: user.allowedOrigins,
    };
  }

  async verifyDeviceCredential(credentialDigest: string): Promise<DeviceIdentity | null> {
    const record = this.row<{
      device_id: string;
      tenant_id: string;
      credential_version: number;
    }>(
      `SELECT d.device_id, d.tenant_id, d.credential_version
       FROM devices d JOIN users u ON u.user_id = d.user_id
       WHERE d.credential_hash = ? AND d.revoked_at IS NULL AND u.disabled = 0`,
      credentialDigest,
    );
    if (record === undefined) return null;
    this.ctx.storage.sql.exec(
      `UPDATE devices SET last_seen_at = ? WHERE device_id = ?`,
      Date.now(),
      record.device_id,
    );
    return {
      tenantId: record.tenant_id,
      deviceId: record.device_id,
      credentialVersion: record.credential_version,
      credentialDigest,
    };
  }

  async listDevices(userId: string): Promise<DirectoryDeviceRecord[]> {
    return this.deviceRows(`user_id = ?`, userId);
  }

  /**
   * Devices by TENANT rather than user. AccountAgent's authority is the
   * tenant (its DO name / the session-scoping key), never a userId it was
   * handed, so it lists by tenant — a caller cannot enumerate another
   * account's devices by passing a foreign userId.
   */
  async listDevicesForTenant(tenantId: string): Promise<DirectoryDeviceRecord[]> {
    return this.deviceRows(`tenant_id = ?`, tenantId);
  }

  private deviceRows(where: string, binding: string): DirectoryDeviceRecord[] {
    return this.rows<{
      device_id: string;
      label: string | null;
      allowed_origins: string;
      created_at: number;
      last_seen_at: number | null;
    }>(
      `SELECT device_id, label, allowed_origins, created_at, last_seen_at
       FROM devices WHERE ${where} AND revoked_at IS NULL
       ORDER BY created_at DESC`,
      binding,
    ).map((record) => ({
      deviceId: record.device_id,
      label: record.label,
      allowedOrigins: parseOrigins(record.allowed_origins),
      createdAt: record.created_at,
      lastSeenAt: record.last_seen_at,
    }));
  }

  /**
   * Marks the credential dead. The row flip is authoritative; the dashboard
   * additionally pushes an immediate DeviceAgent teardown (kill switch), with
   * connect-ticket auth and heartbeat liveness (≤60 s positive cache) as the
   * lazy backstop.
   *
   * Three-way rather than boolean because the caller must distinguish "the
   * row is already flipped, so re-push the teardown" from "this id is not
   * yours, so touch nothing". Both are falsy; conflating them either skips a
   * needed push or hands an attacker-supplied deviceId to a DO — see
   * revokeDeviceForOwner, which is what acts on the distinction. Both still
   * collapse to one notice — "already_revoked" is ownership-checked, so
   * "not_found" remains a single indistinguishable answer for foreign and
   * unknown ids alike (DL-008, no existence oracle).
   */
  async revokeDevice(userId: string, deviceId: string): Promise<RevokeDeviceResult> {
    const cursor = this.ctx.storage.sql.exec(
      `UPDATE devices SET revoked_at = ? WHERE user_id = ? AND device_id = ? AND revoked_at IS NULL`,
      Date.now(),
      userId,
      deviceId,
    );
    if (cursor.rowsWritten > 0) return "revoked";
    const owned = this.row<{ device_id: string }>(
      `SELECT device_id FROM devices WHERE user_id = ? AND device_id = ?`,
      userId,
      deviceId,
    );
    return owned === undefined ? "not_found" : "already_revoked";
  }

  async createMcpToken(userId: string, label: string | null): Promise<CreateMcpTokenResult | null> {
    const user = await this.getUser(userId);
    if (user === null) return null;
    const tokenId = randomChars(TOKEN_ID_ALPHABET, 16);
    const token = `usk_v1_${tokenId}_${randomBase64urlSecret()}`;
    this.ctx.storage.sql.exec(
      `INSERT INTO mcp_tokens (token_id, user_id, tenant_id, token_hash, label, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      tokenId,
      userId,
      user.tenantId,
      await sha256Hex(token),
      label === null ? null : label.slice(0, 128),
      Date.now(),
    );
    return { token, tokenId };
  }

  async verifyMcpToken(tokenHash: string): Promise<McpTokenIdentity | null> {
    const record = this.row<{ token_id: string; user_id: string; tenant_id: string }>(
      `SELECT t.token_id, t.user_id, t.tenant_id
       FROM mcp_tokens t JOIN users u ON u.user_id = t.user_id
       WHERE t.token_hash = ? AND t.revoked_at IS NULL AND u.disabled = 0`,
      tokenHash,
    );
    if (record === undefined) return null;
    this.ctx.storage.sql.exec(
      `UPDATE mcp_tokens SET last_used_at = ? WHERE token_id = ?`,
      Date.now(),
      record.token_id,
    );
    return { userId: record.user_id, tenantId: record.tenant_id, tokenId: record.token_id };
  }

  async listMcpTokens(userId: string): Promise<McpTokenRecord[]> {
    return this.rows<{
      token_id: string;
      label: string | null;
      created_at: number;
      last_used_at: number | null;
    }>(
      `SELECT token_id, label, created_at, last_used_at
       FROM mcp_tokens WHERE user_id = ? AND revoked_at IS NULL
       ORDER BY created_at DESC`,
      userId,
    ).map((record) => ({
      tokenId: record.token_id,
      label: record.label,
      createdAt: record.created_at,
      lastUsedAt: record.last_used_at,
    }));
  }

  async revokeMcpToken(userId: string, tokenId: string): Promise<boolean> {
    const cursor = this.ctx.storage.sql.exec(
      `UPDATE mcp_tokens SET revoked_at = ? WHERE user_id = ? AND token_id = ? AND revoked_at IS NULL`,
      Date.now(),
      userId,
      tokenId,
    );
    return cursor.rowsWritten > 0;
  }

  /** Daily sweep of rows that can no longer be consumed or verified. */
  async alarm(): Promise<void> {
    const now = Date.now();
    // OTP rows must outlive consumption by a day: the per-email daily cap
    // counts created_at within 24h, so deleting them sooner would reopen it.
    this.ctx.storage.sql.exec(
      `DELETE FROM otp_challenges WHERE created_at < ?`,
      now - DAY_MS,
    );
    this.ctx.storage.sql.exec(
      `DELETE FROM dashboard_sessions WHERE expires_at < ? OR revoked_at IS NOT NULL`,
      now,
    );
    this.ctx.storage.sql.exec(
      `DELETE FROM pairing_codes WHERE created_at < ?`,
      now - DAY_MS,
    );
    // Revoked tokens/devices are dead weight once nothing can present them;
    // a day's grace keeps them briefly visible for support before removal.
    this.ctx.storage.sql.exec(
      `DELETE FROM mcp_tokens WHERE revoked_at IS NOT NULL AND revoked_at < ?`,
      now - DAY_MS,
    );
    this.ctx.storage.sql.exec(
      `DELETE FROM devices WHERE revoked_at IS NOT NULL AND revoked_at < ?`,
      now - DAY_MS,
    );
    await this.ctx.storage.setAlarm(now + SWEEP_INTERVAL_MS);
  }
}

function parseOrigins(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((value) => typeof value === "string") : [];
  } catch {
    return [];
  }
}
