/**
 * AccountDirectory — the singleton Durable Object behind self-serve accounts.
 * One instance (getByName("directory")) owns users, email-OTP challenges,
 * dashboard cookie sessions, paired devices, pairing offers, and static MCP
 * tokens, so the three consume-once invariants — OTP, pairing offer, token
 * revoke — run as serialized SQLite writes in one object instead of
 * eventually-consistent KV reads.
 *
 * Hot-path invariant: the per-command path never calls this object. Directory
 * RPCs happen only at OTP request/verify, dashboard page loads, pairing
 * claim, connect-ticket auth + heartbeat liveness for directory devices,
 * usk_v2 verification and per-request device/epoch revalidation,
 * and browser_open/browser_status device listing in AccountAgent.
 *
 * Display-once: only digests exist at rest — sha256 for device credentials,
 * MCP tokens, and cookie tokens (the Worker recomputes those digests without
 * this DO), keyed HMAC over AUTH_HMAC_SECRET for OTP codes and pairing offers
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
export const AUTH_CONTRACT_VERSION = 2 as const;

/** RFC 4648 base32, lowercased — tenant ids must satisfy isValidTenantId. */
const TENANT_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const TOKEN_ID_ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const OTP_ALPHABET = "0123456789";

export const TENANT_ID_PATTERN = /^acct-[a-z2-7]{10}$/;

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

async function pairingDeviceCredential(env: Env, offerHash: string): Promise<string> {
  const credentialHex = await taggedHmacHex(env, "pair-device-v2", offerHash);
  const bytes = new Uint8Array(credentialHex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(credentialHex.slice(index * 2, index * 2 + 2), 16);
  }
  return `udt_v2_${base64urlEncode(bytes)}`;
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
  authEpoch: number;
}

export type ClaimPairingOfferResult =
  | {
      kind: "ok";
      userId: string;
      tenantId: string;
      deviceId: string;
      deviceCredential: string;
      originPolicy: string[];
      policyVersion: number;
      rotatedFrom?: {
        credentialDigest: string;
        credentialVersion: number;
      };
    }
  | { kind: "invalid" };

export type DirectoryDeviceCredentialStatus = "live" | "superseded" | "revoked";

export type DirectoryDeviceAuthority =
  | { kind: "not_directory" }
  | { kind: "invalid" }
  | { kind: "live"; identity: DeviceIdentity };

export interface DirectoryDeviceRecord {
  deviceId: string;
  label: string | null;
  allowedOrigins: string[];
  createdAt: number;
  lastSeenAt: number | null;
  policyVersion: number;
}

export interface McpTokenRecord {
  tokenId: string;
  label: string | null;
  createdAt: number;
  lastUsedAt: number | null;
  deviceId: string;
  deviceLabel: string | null;
}

export interface McpTokenIdentity {
  userId: string;
  tenantId: string;
  tokenId: string;
  deviceId: string;
  authEpoch: number;
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
  authEpoch: number;
  createdAt: number;
}

export type SetOriginsResult =
  | {
      kind: "ok";
      origins: string[];
      devices: Array<{ deviceId: string; policyVersion: number }>;
    }
  | { kind: "invalid"; message: string };

export interface OriginPolicyDevicePlan {
  deviceId: string;
  allowedOrigins: string[];
  policyVersion: number;
  narrowing: boolean;
}

export type BeginOriginsResult =
  | {
      kind: "ok";
      operationId: string;
      origins: string[];
      devices: OriginPolicyDevicePlan[];
    }
  | { kind: "invalid"; message: string };

export type RevokeDeviceResult = "revoked" | "already_revoked" | "not_found";

export const PROTOCOL_3_AUTH_CUTOVER = "protocol-3-auth-hard-cut";

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
        disabled INTEGER NOT NULL DEFAULT 0,
        auth_epoch INTEGER NOT NULL DEFAULT 1);
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
        last_seen_at INTEGER,
        policy_version INTEGER NOT NULL DEFAULT 1,
        policy_updated_at INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS pairing_codes (
        code_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        consumed_at INTEGER,
        device_id TEXT,
        claim_previous_credential_hash TEXT,
        claim_id_hash TEXT);
      CREATE TABLE IF NOT EXISTS mcp_tokens (
        token_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        label TEXT,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER,
        revoked_at INTEGER,
        device_id TEXT,
        auth_epoch INTEGER);
      CREATE TABLE IF NOT EXISTS origin_policy_operations (
        user_id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL UNIQUE,
        origins TEXT NOT NULL,
        devices_json TEXT NOT NULL,
        created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at INTEGER NOT NULL);
    `);
    this.ensureColumn("users", "auth_epoch", "INTEGER NOT NULL DEFAULT 1");
    this.ensureColumn("devices", "policy_version", "INTEGER NOT NULL DEFAULT 1");
    this.ensureColumn("devices", "policy_updated_at", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("mcp_tokens", "device_id", "TEXT");
    this.ensureColumn("mcp_tokens", "auth_epoch", "INTEGER");
    this.ensureColumn("pairing_codes", "claim_previous_credential_hash", "TEXT");
    this.ensureColumn("pairing_codes", "claim_id_hash", "TEXT");
    this.applyAuthenticationCutover(this.env.AUTH_EPOCH_CUTOVER);
  }

  private ensureColumn(
    table: "users" | "devices" | "mcp_tokens" | "pairing_codes",
    column: string,
    sql: string,
  ): void {
    const columns = this.rows<{ name: string }>(`PRAGMA table_info(${table})`);
    if (columns.some((item) => item.name === column)) return;
    this.ctx.storage.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${sql}`);
  }

  async applyProtocol3AuthenticationCutover(marker: string): Promise<number> {
    return this.applyAuthenticationCutover(marker);
  }

  private applyAuthenticationCutover(marker: string | undefined): number {
    if (marker !== PROTOCOL_3_AUTH_CUTOVER) return 0;
    const name = PROTOCOL_3_AUTH_CUTOVER;
    if (this.row<{ name: string }>("SELECT name FROM schema_migrations WHERE name = ?", name)) {
      return 0;
    }
    const affected = this.row<{ count: number }>("SELECT COUNT(*) AS count FROM users")?.count ?? 0;
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("UPDATE users SET auth_epoch = auth_epoch + 1");
      this.ctx.storage.sql.exec(
        "INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)",
        name,
        Date.now(),
      );
    });
    return affected;
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
      auth_epoch: number;
    }>(
      `SELECT u.user_id, u.email, u.tenant_id, u.allowed_origins, u.auth_epoch
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
      authEpoch: record.auth_epoch,
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
      auth_epoch: number;
      created_at: number;
    }>(
      `SELECT user_id, email, tenant_id, allowed_origins, auth_epoch, created_at
       FROM users WHERE user_id = ? AND disabled = 0`,
      userId,
    );
    if (record === undefined) return null;
    return {
      userId: record.user_id,
      email: record.email,
      tenantId: record.tenant_id,
      allowedOrigins: parseOrigins(record.allowed_origins),
      authEpoch: record.auth_epoch,
      createdAt: record.created_at,
    };
  }

  async beginAllowedOriginsUpdate(
    userId: string,
    origins: string[],
  ): Promise<BeginOriginsResult> {
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
    const pending = this.row<{
      operation_id: string;
      origins: string;
      devices_json: string;
    }>(
      `SELECT operation_id, origins, devices_json FROM origin_policy_operations
       WHERE user_id = ?`,
      userId,
    );
    if (pending !== undefined) {
      return {
        kind: "ok",
        operationId: pending.operation_id,
        origins: parseOrigins(pending.origins),
        devices: parseOriginPolicyPlan(pending.devices_json),
      };
    }
    if ((await this.getUser(userId)) === null) {
      return { kind: "invalid", message: "account unavailable" };
    }
    const devices = this.rows<{
      device_id: string;
      allowed_origins: string;
      policy_version: number;
    }>(
      `SELECT device_id, allowed_origins, policy_version FROM devices
       WHERE user_id = ? AND revoked_at IS NULL ORDER BY device_id`,
      userId,
    ).map((device): OriginPolicyDevicePlan => {
      const allowedOrigins = parseOrigins(device.allowed_origins);
      const allowed = new Set(canonical);
      return {
        deviceId: device.device_id,
        allowedOrigins,
        policyVersion: device.policy_version + 1,
        narrowing: allowedOrigins.some((origin) => !allowed.has(origin)),
      };
    });
    const operationId = crypto.randomUUID();
    this.ctx.storage.sql.exec(
      `INSERT INTO origin_policy_operations
         (user_id, operation_id, origins, devices_json, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      userId,
      operationId,
      JSON.stringify(canonical),
      JSON.stringify(devices),
      Date.now(),
    );
    return { kind: "ok", operationId, origins: canonical, devices };
  }

  async commitAllowedOriginsUpdate(
    userId: string,
    operationId: string,
  ): Promise<SetOriginsResult> {
    const pending = this.row<{ origins: string; devices_json: string }>(
      `SELECT origins, devices_json FROM origin_policy_operations
       WHERE user_id = ? AND operation_id = ?`,
      userId,
      operationId,
    );
    if (pending === undefined) {
      return { kind: "invalid", message: "origin policy operation is unavailable" };
    }
    const origins = parseOrigins(pending.origins);
    const plans = parseOriginPolicyPlan(pending.devices_json);
    const current = new Map(
      this.rows<{ device_id: string; policy_version: number }>(
        `SELECT device_id, policy_version FROM devices
         WHERE user_id = ? AND revoked_at IS NULL`,
        userId,
      ).map((device) => [device.device_id, device.policy_version]),
    );
    if (
      plans.some(
        (plan) =>
          current.has(plan.deviceId) && current.get(plan.deviceId) !== plan.policyVersion - 1,
      )
    ) {
      return { kind: "invalid", message: "browser policy changed concurrently" };
    }
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "UPDATE users SET allowed_origins = ? WHERE user_id = ?",
        JSON.stringify(origins),
        userId,
      );
      for (const plan of plans) {
        this.ctx.storage.sql.exec(
          `UPDATE devices SET allowed_origins = ?, policy_version = ?, policy_updated_at = ?
           WHERE device_id = ? AND user_id = ? AND revoked_at IS NULL
             AND policy_version = ?`,
          JSON.stringify(origins),
          plan.policyVersion,
          now,
          plan.deviceId,
          userId,
          plan.policyVersion - 1,
        );
      }
      this.ctx.storage.sql.exec(
        "DELETE FROM origin_policy_operations WHERE user_id = ? AND operation_id = ?",
        userId,
        operationId,
      );
    });
    return {
      kind: "ok",
      origins,
      devices: plans
        .filter((plan) => current.has(plan.deviceId))
        .map((plan) => ({ deviceId: plan.deviceId, policyVersion: plan.policyVersion })),
    };
  }

  async createPairingOffer(userId: string): Promise<{ offer: string; expiresAt: number }> {
    const user = await this.getUser(userId);
    if (user === null) throw new Error("account unavailable");
    const now = Date.now();
    const offer = randomBase64urlSecret();
    const offerHash = await taggedHmacHex(this.env, "pair-v2", offer);
    const expiresAt = now + PAIRING_TTL_MS;
    this.ctx.storage.sql.exec(
      `INSERT INTO pairing_codes (code_hash, user_id, created_at, expires_at)
       VALUES (?, ?, ?, ?)`,
      offerHash,
      userId,
      now,
      expiresAt,
    );
    return { offer, expiresAt };
  }

  /**
   * Consumes a pairing offer and mints the device identity + credential —
   * credentials exist only from redeem time, so an unredeemed offer leaves
   * nothing behind. Every failure mode (unknown, expired, already consumed,
   * disabled user) collapses to the same "invalid" so the
   * endpoint cannot be used to enumerate offer state.
   */
  async claimPairingOffer(
    offerHash: string,
    claimIdDigest: string,
    previousCredentialDigest?: string,
  ): Promise<ClaimPairingOfferResult> {
    const now = Date.now();
    const record = this.row<{
      user_id: string;
      expires_at: number;
      consumed_at: number | null;
      device_id: string | null;
      claim_previous_credential_hash: string | null;
      claim_id_hash: string | null;
    }>(
      `SELECT user_id, expires_at, consumed_at, device_id,
              claim_previous_credential_hash, claim_id_hash
       FROM pairing_codes WHERE code_hash = ?`,
      offerHash,
    );
    if (record === undefined) {
      return { kind: "invalid" };
    }
    if (
      this.row<{ user_id: string }>(
        "SELECT user_id FROM origin_policy_operations WHERE user_id = ?",
        record.user_id,
      ) !== undefined
    ) {
      return { kind: "invalid" };
    }
    const previousProof = previousCredentialDigest ?? "";
    const deviceCredential = await pairingDeviceCredential(this.env, offerHash);
    const credentialHash = await sha256Hex(deviceCredential);
    if (record.consumed_at !== null) {
      if (
        record.device_id === null ||
        record.claim_id_hash !== claimIdDigest ||
        record.claim_previous_credential_hash !== previousProof
      ) {
        return { kind: "invalid" };
      }
      return this.replayPairingClaim(
        record.user_id,
        record.device_id,
        credentialHash,
        deviceCredential,
        previousProof,
      );
    }
    if (record.expires_at <= now) return { kind: "invalid" };
    const user = await this.getUser(record.user_id);
    if (user === null) return { kind: "invalid" };

    const presented =
      previousCredentialDigest === undefined
        ? undefined
        : this.row<{
            device_id: string;
            user_id: string;
            allowed_origins: string;
            policy_version: number;
            credential_version: number;
            revoked_at: number | null;
          }>(
            `SELECT device_id, user_id, allowed_origins, policy_version,
                    credential_version, revoked_at
             FROM devices WHERE credential_hash = ?`,
            previousCredentialDigest,
          );
    if (previousCredentialDigest !== undefined && presented?.user_id !== user.userId) {
      return { kind: "invalid" };
    }
    const previous = presented?.revoked_at === null ? presented : undefined;
    const rotateExisting = previous !== undefined;
    const deviceId = rotateExisting
      ? previous.device_id
      : crypto.randomUUID().toLowerCase();
    const originPolicy = rotateExisting
      ? parseOrigins(previous.allowed_origins)
      : user.allowedOrigins;
    const policyVersion = rotateExisting ? previous.policy_version : 1;

    // Synchronous re-check + writes (no awaits in between), wrapped in a
    // storage transaction: the consume and the device insert land together
    // or not at all, and a concurrent claim that raced past the first read
    // sees consumed_at set.
    const claimed = this.ctx.storage.transactionSync(() => {
      const fresh = this.row<{ consumed_at: number | null; expires_at: number }>(
        `SELECT consumed_at, expires_at FROM pairing_codes WHERE code_hash = ?`,
        offerHash,
      );
      if (fresh === undefined || fresh.consumed_at !== null || fresh.expires_at <= now) {
        return false;
      }
      if (
        this.row<{ user_id: string }>(
          "SELECT user_id FROM origin_policy_operations WHERE user_id = ?",
          user.userId,
        ) !== undefined
      ) {
        return false;
      }
      this.ctx.storage.sql.exec(
        `UPDATE pairing_codes
         SET consumed_at = ?, device_id = ?, claim_previous_credential_hash = ?,
             claim_id_hash = ?
         WHERE code_hash = ?`,
        now,
        deviceId,
        previousProof,
        claimIdDigest,
        offerHash,
      );
      if (presented !== undefined) {
        this.ctx.storage.sql.exec(
          `DELETE FROM pairing_codes
           WHERE device_id = ? AND code_hash <> ? AND consumed_at IS NOT NULL`,
          presented.device_id,
          offerHash,
        );
      }
      if (rotateExisting) {
        this.ctx.storage.sql.exec(
          `UPDATE devices
           SET credential_hash = ?, credential_version = credential_version + 1,
               last_seen_at = NULL
           WHERE device_id = ? AND user_id = ? AND revoked_at IS NULL`,
          credentialHash,
          deviceId,
          user.userId,
        );
      } else {
        this.ctx.storage.sql.exec(
          `INSERT INTO devices
             (device_id, user_id, tenant_id, credential_hash, credential_version,
              allowed_origins, created_at, policy_version, policy_updated_at)
           VALUES (?, ?, ?, ?, 1, ?, ?, 1, ?)`,
          deviceId,
          user.userId,
          user.tenantId,
          credentialHash,
          JSON.stringify(user.allowedOrigins),
          now,
          now,
        );
      }
      return true;
    });
    if (!claimed) return { kind: "invalid" };
    return {
      kind: "ok",
      userId: user.userId,
      tenantId: user.tenantId,
      deviceId,
      deviceCredential,
      originPolicy,
      policyVersion,
      ...(rotateExisting
        ? {
            rotatedFrom: {
              credentialDigest: previousProof,
              credentialVersion: previous.credential_version,
            },
          }
        : {}),
    };
  }

  private replayPairingClaim(
    userId: string,
    deviceId: string,
    credentialHash: string,
    deviceCredential: string,
    previousCredentialDigest: string,
  ): ClaimPairingOfferResult {
    if (
      this.row<{ user_id: string }>(
        "SELECT user_id FROM origin_policy_operations WHERE user_id = ?",
        userId,
      ) !== undefined
    ) {
      return { kind: "invalid" };
    }
    const device = this.row<{
      tenant_id: string;
      allowed_origins: string;
      policy_version: number;
      credential_version: number;
    }>(
      `SELECT tenant_id, allowed_origins, policy_version, credential_version FROM devices
       WHERE device_id = ? AND user_id = ? AND credential_hash = ? AND revoked_at IS NULL`,
      deviceId,
      userId,
      credentialHash,
    );
    if (device === undefined) return { kind: "invalid" };
    return {
      kind: "ok",
      userId,
      tenantId: device.tenant_id,
      deviceId,
      deviceCredential,
      originPolicy: parseOrigins(device.allowed_origins),
      policyVersion: device.policy_version,
      ...(previousCredentialDigest.length > 0 && device.credential_version > 1
        ? {
            rotatedFrom: {
              credentialDigest: previousCredentialDigest,
              credentialVersion: device.credential_version - 1,
            },
          }
        : {}),
    };
  }

  async deviceCredentialStatus(
    credentialDigest: string,
    identity: { tenantId: string; deviceId: string; credentialVersion: number },
  ): Promise<DirectoryDeviceCredentialStatus> {
    const device = this.row<{
      tenant_id: string;
      credential_hash: string;
      credential_version: number;
      revoked_at: number | null;
      disabled: number;
    }>(
      `SELECT d.tenant_id, d.credential_hash, d.credential_version,
              d.revoked_at, u.disabled
       FROM devices d JOIN users u ON u.user_id = d.user_id
       WHERE d.device_id = ?`,
      identity.deviceId,
    );
    if (
      device === undefined ||
      device.tenant_id !== identity.tenantId ||
      device.revoked_at !== null ||
      device.disabled !== 0
    ) {
      return "revoked";
    }
    if (
      device.credential_hash === credentialDigest &&
      device.credential_version === identity.credentialVersion
    ) {
      return "live";
    }
    if (device.credential_version !== identity.credentialVersion + 1) {
      return "revoked";
    }
    const recoverable = this.row<{ code_hash: string }>(
      `SELECT code_hash FROM pairing_codes
       WHERE device_id = ? AND consumed_at IS NOT NULL
         AND claim_previous_credential_hash = ?
       LIMIT 1`,
      identity.deviceId,
      credentialDigest,
    );
    return recoverable === undefined ? "revoked" : "superseded";
  }

  async inspectDeviceAuthority(
    credentialDigest: string,
    identity: { tenantId: string; deviceId: string; credentialVersion: number },
  ): Promise<DirectoryDeviceAuthority> {
    const record = this.row<{
      tenant_id: string;
      credential_hash: string;
      credential_version: number;
      allowed_origins: string;
      policy_version: number;
      revoked_at: number | null;
      disabled: number;
    }>(
      `SELECT d.tenant_id, d.credential_hash, d.credential_version,
              d.allowed_origins, d.policy_version, d.revoked_at, u.disabled
       FROM devices d JOIN users u ON u.user_id = d.user_id
       WHERE d.device_id = ?`,
      identity.deviceId,
    );
    if (record === undefined) return { kind: "not_directory" };
    if (
      record.tenant_id !== identity.tenantId ||
      record.credential_hash !== credentialDigest ||
      record.credential_version !== identity.credentialVersion ||
      record.revoked_at !== null ||
      record.disabled !== 0
    ) {
      return { kind: "invalid" };
    }
    return {
      kind: "live",
      identity: {
        tenantId: record.tenant_id,
        deviceId: identity.deviceId,
        credentialVersion: record.credential_version,
        credentialDigest,
        allowedOrigins: parseOrigins(record.allowed_origins),
        policyVersion: record.policy_version,
      },
    };
  }

  async verifyDeviceCredential(credentialDigest: string): Promise<DeviceIdentity | null> {
    const record = this.row<{
      device_id: string;
      tenant_id: string;
      credential_version: number;
      allowed_origins: string;
      policy_version: number;
    }>(
      `SELECT d.device_id, d.tenant_id, d.credential_version,
              d.allowed_origins, d.policy_version
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
      allowedOrigins: parseOrigins(record.allowed_origins),
      policyVersion: record.policy_version,
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
      policy_version: number;
    }>(
      `SELECT device_id, label, allowed_origins, created_at, last_seen_at,
              policy_version
       FROM devices WHERE ${where} AND revoked_at IS NULL
       ORDER BY created_at DESC`,
      binding,
    ).map((record) => ({
      deviceId: record.device_id,
      label: record.label,
      allowedOrigins: parseOrigins(record.allowed_origins),
      createdAt: record.created_at,
      lastSeenAt: record.last_seen_at,
      policyVersion: record.policy_version,
    }));
  }

  /**
   * Marks the credential dead. The row flip is authoritative; the dashboard
   * additionally pushes an immediate DeviceAgent teardown (kill switch), with
   * connect-ticket auth and heartbeat liveness as the lazy backstop.
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

  async createMcpToken(
    userId: string,
    deviceId: string,
    label: string | null,
  ): Promise<CreateMcpTokenResult | null> {
    const user = await this.getUser(userId);
    if (user === null) return null;
    const device = this.row<{ device_id: string }>(
      `SELECT device_id FROM devices
       WHERE device_id = ? AND user_id = ? AND revoked_at IS NULL`,
      deviceId,
      userId,
    );
    if (device === undefined) return null;
    const tokenId = randomChars(TOKEN_ID_ALPHABET, 16);
    const token = `usk_v2_${tokenId}_${randomBase64urlSecret()}`;
    this.ctx.storage.sql.exec(
      `INSERT INTO mcp_tokens
         (token_id, user_id, tenant_id, token_hash, label, created_at,
          device_id, auth_epoch)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      tokenId,
      userId,
      user.tenantId,
      await sha256Hex(token),
      label === null ? null : label.slice(0, 128),
      Date.now(),
      deviceId,
      user.authEpoch,
    );
    return { token, tokenId };
  }

  async verifyMcpToken(tokenHash: string): Promise<McpTokenIdentity | null> {
    const record = this.row<{
      token_id: string;
      user_id: string;
      tenant_id: string;
      device_id: string;
      auth_epoch: number;
    }>(
      `SELECT t.token_id, t.user_id, t.tenant_id, t.device_id, t.auth_epoch
       FROM mcp_tokens t
       JOIN users u ON u.user_id = t.user_id
       JOIN devices d ON d.device_id = t.device_id AND d.user_id = t.user_id
       WHERE t.token_hash = ? AND t.revoked_at IS NULL AND d.revoked_at IS NULL
         AND u.disabled = 0 AND t.auth_epoch = u.auth_epoch
         AND t.device_id IS NOT NULL AND t.auth_epoch IS NOT NULL`,
      tokenHash,
    );
    if (record === undefined) return null;
    this.ctx.storage.sql.exec(
      `UPDATE mcp_tokens SET last_used_at = ? WHERE token_id = ?`,
      Date.now(),
      record.token_id,
    );
    return {
      userId: record.user_id,
      tenantId: record.tenant_id,
      tokenId: record.token_id,
      deviceId: record.device_id,
      authEpoch: record.auth_epoch,
    };
  }

  async authorizeMcpIdentity(input: {
    userId: string;
    tenantId: string;
    deviceId: string;
    authEpoch: number;
    contractVersion: number;
  }): Promise<boolean> {
    if (input.contractVersion !== AUTH_CONTRACT_VERSION) return false;
    return this.row<{ user_id: string }>(
      `SELECT u.user_id FROM users u
       JOIN devices d ON d.user_id = u.user_id AND d.tenant_id = u.tenant_id
       WHERE u.user_id = ? AND u.tenant_id = ? AND u.auth_epoch = ?
         AND u.disabled = 0 AND d.device_id = ? AND d.revoked_at IS NULL`,
      input.userId,
      input.tenantId,
      input.authEpoch,
      input.deviceId,
    ) !== undefined;
  }

  async listMcpTokens(userId: string): Promise<McpTokenRecord[]> {
    return this.rows<{
      token_id: string;
      label: string | null;
      created_at: number;
      last_used_at: number | null;
      device_id: string;
      device_label: string | null;
    }>(
      `SELECT t.token_id, t.label, t.created_at, t.last_used_at,
              t.device_id, d.label AS device_label
       FROM mcp_tokens t
       JOIN devices d ON d.device_id = t.device_id
       WHERE t.user_id = ? AND t.revoked_at IS NULL
       ORDER BY t.created_at DESC`,
      userId,
    ).map((record) => ({
      tokenId: record.token_id,
      label: record.label,
      createdAt: record.created_at,
      lastUsedAt: record.last_used_at,
      deviceId: record.device_id,
      deviceLabel: record.device_label,
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
    // A consumed claim is the crash-recovery record for an extension that did
    // not receive or durably commit the response. It is retained until that
    // same device is paired again; only never-consumed offers can age out here.
    this.ctx.storage.sql.exec(
      `DELETE FROM pairing_codes WHERE consumed_at IS NULL AND created_at < ?`,
      now - DAY_MS,
    );
    // Revoked token rows are dead after clients lose their display-once value.
    // Device tombstones are retained: an extension may remain stopped past the
    // sweep window and later present its locally stored revoked credential as
    // the proof that pairing must mint a fresh identity.
    this.ctx.storage.sql.exec(
      `DELETE FROM mcp_tokens WHERE revoked_at IS NOT NULL AND revoked_at < ?`,
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

function parseOriginPolicyPlan(raw: string): OriginPolicyDevicePlan[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error("origin policy operation is corrupt");
  return parsed.map((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("origin policy operation is corrupt");
    }
    const plan = value as Partial<OriginPolicyDevicePlan>;
    if (
      typeof plan.deviceId !== "string" ||
      !Array.isArray(plan.allowedOrigins) ||
      !plan.allowedOrigins.every((origin) => typeof origin === "string") ||
      typeof plan.policyVersion !== "number" ||
      !Number.isInteger(plan.policyVersion) ||
      plan.policyVersion < 2 ||
      typeof plan.narrowing !== "boolean"
    ) {
      throw new Error("origin policy operation is corrupt");
    }
    return {
      deviceId: plan.deviceId,
      allowedOrigins: canonicalizeOrigins(plan.allowedOrigins),
      policyVersion: plan.policyVersion,
      narrowing: plan.narrowing,
    };
  });
}
