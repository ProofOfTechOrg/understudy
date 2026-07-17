import { describe, it, expect } from "vitest";
import type { Env } from "../src/types";
import { base64urlEncode } from "../src/base64url";
import {
  authenticate,
  isValidTenantId,
  mintSessionId,
  scopeSession,
  tenantOf,
  verifyExtensionToken,
  type Actor,
} from "../src/auth";

const CALLER_TOKENS: Record<string, Actor> = {
  "tok-a": { actor: "caller-a", tenantId: "tenantA" },
  "tok-b": { actor: "caller-b", tenantId: "tenantB" },
};

const EXTENSION_TOKENS: Record<string, string> = {
  "ext-tok-1": "tenantA",
  "ext-tok-2": "tenantB",
};

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    SESSION: {} as unknown as Env["SESSION"],
    VAULT: {} as unknown as Env["VAULT"],
    AUTH_HMAC_SECRET: "test-hmac-secret-do-not-use-in-prod",
    CALLER_TOKENS: JSON.stringify(CALLER_TOKENS),
    EXTENSION_TOKENS: JSON.stringify(EXTENSION_TOKENS),
    VAULT_MASTER_KEY: "unused-by-auth-tests",
    ...overrides,
  };
}

function flipChar(value: string): string {
  const first = value.charAt(0);
  return (first === "A" ? "B" : "A") + value.slice(1);
}

function tamperSessionId(sessionId: string, part: "payload" | "sig"): string {
  const dot = sessionId.indexOf(".");
  const payload = sessionId.slice(0, dot);
  const sig = sessionId.slice(dot + 1);
  return part === "payload" ? `${flipChar(payload)}.${sig}` : `${payload}.${flipChar(sig)}`;
}

/**
 * Mirrors mintSessionId's signing but WITHOUT its isValidTenantId guard, to
 * forge a genuinely valid-signature sessionId carrying a tenant mint would now
 * refuse. This is the only way to reach tenantOf's shape re-check with a real
 * signature (a legacy id from before the rule, or a hypothetical second signer)
 * - a tampered id would fail the HMAC check first and never prove the re-check.
 */
async function forgeSessionId(tenantId: string, env: Env): Promise<string> {
  const payloadBytes = new TextEncoder().encode(JSON.stringify({ t: tenantId, n: "0".repeat(32) }));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.AUTH_HMAC_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, payloadBytes);
  return `${base64urlEncode(payloadBytes)}.${base64urlEncode(new Uint8Array(sig))}`;
}

describe("mintSessionId / scopeSession", () => {
  it("scopes a minted sessionId to its own tenant as ok", async () => {
    const env = makeEnv();
    const sessionId = await mintSessionId("tenantA", env);
    expect(await scopeSession(sessionId, "tenantA", env)).toBe("ok");
  });

  it("returns not-found for a cross-tenant sessionId (no existence oracle)", async () => {
    const env = makeEnv();
    const sessionId = await mintSessionId("tenantA", env);
    expect(await scopeSession(sessionId, "tenantB", env)).toBe("not-found");
  });

  it("returns not-found when the signature is tampered", async () => {
    const env = makeEnv();
    const sessionId = await mintSessionId("tenantA", env);
    const tampered = tamperSessionId(sessionId, "sig");
    expect(await scopeSession(tampered, "tenantA", env)).toBe("not-found");
  });

  it("returns not-found when the payload is tampered", async () => {
    const env = makeEnv();
    const sessionId = await mintSessionId("tenantA", env);
    const tampered = tamperSessionId(sessionId, "payload");
    expect(await scopeSession(tampered, "tenantA", env)).toBe("not-found");
  });

  it.each(["", "garbage", "a.b.c"])(
    "returns not-found for a malformed sessionId %j without throwing",
    async (malformed) => {
      const env = makeEnv();
      await expect(scopeSession(malformed, "tenantA", env)).resolves.toBe("not-found");
    },
  );

  it("mints a different sessionId each time for the same tenant, both scoping ok", async () => {
    const env = makeEnv();
    const first = await mintSessionId("tenantA", env);
    const second = await mintSessionId("tenantA", env);

    expect(first).not.toBe(second);
    expect(await scopeSession(first, "tenantA", env)).toBe("ok");
    expect(await scopeSession(second, "tenantA", env)).toBe("ok");
  });

  it.each(["acme/eu", "", "/", "a/b"])(
    "refuses to mint a sessionId for an unsafe tenantId %j (empty or slash-bearing would straddle the vault namespace)",
    async (badTenant) => {
      const env = makeEnv();
      await expect(mintSessionId(badTenant, env)).rejects.toThrow(/invalid tenantId/);
    },
  );
});

describe("isValidTenantId", () => {
  it.each(["tenantA", "acme-corp", "a", "t_123"])("accepts a flat, non-empty slug %j", (t) => {
    expect(isValidTenantId(t)).toBe(true);
  });

  it.each(["", "acme/eu", "/", "a/b/c"])(
    "rejects an empty or slash-bearing tenantId %j - it must not straddle a vault://<tenant>/ prefix",
    (t) => {
      expect(isValidTenantId(t)).toBe(false);
    },
  );
});

describe("tenantOf", () => {
  it("returns the tenant a sessionId was minted for (the authoritative source a DO scopes on)", async () => {
    const env = makeEnv();
    const sessionId = await mintSessionId("tenantA", env);
    expect(await tenantOf(sessionId, env)).toBe("tenantA");
  });

  it("returns null for a tampered signature - a forged id yields no tenant", async () => {
    const env = makeEnv();
    const sessionId = await mintSessionId("tenantA", env);
    expect(await tenantOf(tamperSessionId(sessionId, "sig"), env)).toBeNull();
  });

  it("returns null for a tampered payload", async () => {
    const env = makeEnv();
    const sessionId = await mintSessionId("tenantA", env);
    expect(await tenantOf(tamperSessionId(sessionId, "payload"), env)).toBeNull();
  });

  it.each(["", "garbage", "a.b.c"])(
    "returns null for a malformed sessionId %j without throwing",
    async (malformed) => {
      const env = makeEnv();
      await expect(tenantOf(malformed, env)).resolves.toBeNull();
    },
  );

  it("returns null for a VALIDLY-signed id carrying a slash-bearing tenant (the re-check mint cannot cover)", async () => {
    // #given a genuinely HMAC-valid id whose tenant `mintSessionId` would refuse
    // (forged around mint - stands in for a legacy id or an alternate signer)
    const env = makeEnv();
    const forged = await forgeSessionId("acme/eu", env);

    // #then tenantOf rejects it via the isValidTenantId re-check, NOT an HMAC
    // failure - proven by the control below, where the SAME forging path with a
    // valid tenant is accepted (so the signature is genuinely good)
    expect(await tenantOf(forged, env)).toBeNull();
    expect(await scopeSession(forged, "acme/eu", env)).toBe("not-found");
    expect(await tenantOf(await forgeSessionId("acme", env), env)).toBe("acme");
  });
});

describe("authenticate", () => {
  it("returns the Actor for a valid bearer token", async () => {
    const env = makeEnv();
    const req = new Request("https://understudy.example/v1/sessions/x/commands", {
      headers: { Authorization: "Bearer tok-a" },
    });
    expect(await authenticate(req, env)).toEqual({ actor: "caller-a", tenantId: "tenantA" });
  });

  it("returns null when the Authorization header is missing", async () => {
    const env = makeEnv();
    const req = new Request("https://understudy.example/v1/sessions/x/commands");
    expect(await authenticate(req, env)).toBeNull();
  });

  it("returns null for an unknown token", async () => {
    const env = makeEnv();
    const req = new Request("https://understudy.example/v1/sessions/x/commands", {
      headers: { Authorization: "Bearer not-a-real-token" },
    });
    expect(await authenticate(req, env)).toBeNull();
  });

  it("returns null when CALLER_TOKENS is absent", async () => {
    const env = makeEnv({ CALLER_TOKENS: undefined });
    const req = new Request("https://understudy.example/v1/sessions/x/commands", {
      headers: { Authorization: "Bearer tok-a" },
    });
    expect(await authenticate(req, env)).toBeNull();
  });

  it.each(["__proto__", "constructor", "hasOwnProperty", "toString", "valueOf"])(
    "returns null for a prototype-chain bearer token %j instead of authenticating an inherited member",
    async (token) => {
      const env = makeEnv();
      const req = new Request("https://understudy.example/v1/sessions/x/commands", {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(await authenticate(req, env)).toBeNull();
    },
  );
});

describe("verifyExtensionToken", () => {
  it("returns the tenantId for a valid extension token", async () => {
    const env = makeEnv();
    expect(await verifyExtensionToken("ext-tok-1", env)).toEqual({ tenantId: "tenantA" });
  });

  it("returns null for an invalid extension token", async () => {
    const env = makeEnv();
    expect(await verifyExtensionToken("not-a-real-token", env)).toBeNull();
  });

  it.each(["__proto__", "constructor", "hasOwnProperty", "toString", "valueOf"])(
    "returns null for a prototype-chain extension token %j instead of verifying an inherited member",
    async (token) => {
      const env = makeEnv();
      expect(await verifyExtensionToken(token, env)).toBeNull();
    },
  );
});
