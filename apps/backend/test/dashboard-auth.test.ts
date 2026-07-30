/**
 * Dashboard auth, CSRF, vault upload, and the full OAuth consent flow
 * (PR 4 of the MCP surface). All requests go through the module fetch
 * directly (the pool's exports wrapper rewrites hosts, and the dashboard's
 * origin checks are host-sensitive). Fresh users per test — storage is
 * shared across the run.
 */

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import mainModule from "../src/index";
import { sha256Hex, taggedHmacHex } from "../src/auth";
import { base64urlEncode } from "../src/base64url";
import { createVault, listVaultSecretNames } from "../src/vault";

const CANONICAL = "https://understudy.proofof.tech";
const directory = () => env.ACCOUNT_DIRECTORY.getByName("directory");

function fetchApp(request: Request): Promise<Response> {
  return mainModule.fetch(
    request,
    env as never,
    { waitUntil() {}, passThroughOnException() {} } as never,
  );
}

interface FormRequestOptions {
  cookie?: string;
  form?: Record<string, string>;
  origin?: string | null;
}

function formPost(path: string, options: FormRequestOptions): Request {
  const headers = new Headers();
  if (options.origin !== null) headers.set("Origin", options.origin ?? CANONICAL);
  if (options.cookie !== undefined) {
    headers.set("Cookie", `__Host-understudy_dash=${options.cookie}`);
  }
  return new Request(`${CANONICAL}${path}`, {
    method: "POST",
    headers,
    body: new URLSearchParams(options.form ?? {}),
  });
}

function pageGet(path: string, cookie?: string): Request {
  const headers = new Headers();
  if (cookie !== undefined) headers.set("Cookie", `__Host-understudy_dash=${cookie}`);
  return new Request(`${CANONICAL}${path}`, { headers });
}

async function mintUser(): Promise<{ userId: string; tenantId: string; email: string }> {
  const email = `${crypto.randomUUID()}@example.com`;
  const requested = await directory().requestOtp(email);
  if (requested.kind !== "ok") throw new Error("otp request failed");
  const verified = await directory().verifyOtp(requested.challengeId, requested.code);
  if (verified.kind !== "ok") throw new Error("otp verify failed");
  return { userId: verified.userId, tenantId: verified.tenantId, email };
}

async function signedInUser(): Promise<{
  userId: string;
  tenantId: string;
  email: string;
  cookie: string;
  csrf: string;
}> {
  const user = await mintUser();
  const session = await directory().createDashboardSession(user.userId);
  return {
    ...user,
    cookie: session.token,
    csrf: await taggedHmacHex(env, "csrf-v1", session.token),
  };
}

describe("dashboard sign-in", () => {
  it("serves the login page with no-store and a nonce-locked CSP", async () => {
    const res = await fetchApp(pageGet("/dashboard"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Content-Security-Policy")).toContain("script-src 'nonce-");
    expect(await res.text()).toContain("Email me a sign-in code");
  });

  it("refuses a cross-origin (or origin-less) code request", async () => {
    const missing = await fetchApp(
      formPost("/dashboard/auth/request-code", {
        form: { email: "a@example.com" },
        origin: null,
      }),
    );
    expect(missing.status).toBe(403);
    const wrong = await fetchApp(
      formPost("/dashboard/auth/request-code", {
        form: { email: "a@example.com" },
        origin: "https://evil.example",
      }),
    );
    expect(wrong.status).toBe(403);
  });

  it("answers identically for any submitted address", async () => {
    const known = await mintUser();
    const unknown = `${crypto.randomUUID()}@example.com`;
    for (const email of [known.email, unknown, "not-an-email"]) {
      const res = await fetchApp(
        formPost("/dashboard/auth/request-code", { form: { email } }),
      );
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("a 6-digit code is on its way");
    }
  });

  it("signs in with a fresh code and sets a hardened cookie", async () => {
    // #given a real challenge (minted via RPC — email sending is not
    // emulated in the pool, so the test reads the code from the directory)
    const email = `${crypto.randomUUID()}@example.com`;
    const requested = await directory().requestOtp(email);
    if (requested.kind !== "ok") throw new Error("otp request failed");

    // #when the verify form is posted
    const res = await fetchApp(
      formPost("/dashboard/auth/verify", {
        form: { challengeId: requested.challengeId, code: requested.code, next: "/dashboard" },
      }),
    );

    // #then a Lax, HttpOnly, host-locked session cookie comes back
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/dashboard");
    const cookie = res.headers.get("Set-Cookie") ?? "";
    expect(cookie).toContain("__Host-understudy_dash=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Secure");

    const token = /__Host-understudy_dash=([^;]+)/.exec(cookie)?.[1] ?? "";
    const home = await fetchApp(pageGet("/dashboard", token));
    expect(home.status).toBe(200);
    const homeHtml = await home.text();
    expect(homeHtml).toContain(email);
    expect(homeHtml).toContain("Paired browsers");
  });

  it("re-renders the verify page for a wrong code, without a cookie", async () => {
    const email = `${crypto.randomUUID()}@example.com`;
    const requested = await directory().requestOtp(email);
    if (requested.kind !== "ok") throw new Error("otp request failed");
    const wrong = requested.code === "000000" ? "000001" : "000000";
    const res = await fetchApp(
      formPost("/dashboard/auth/verify", {
        form: { challengeId: requested.challengeId, code: wrong, next: "/dashboard" },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Set-Cookie")).toBeNull();
    expect(await res.text()).toContain("did not work");
  });

  it("collapses hostile next targets to the dashboard", async () => {
    for (const next of ["https://evil.example", "//evil.example", "/other", "/oauth\\x"]) {
      const requested = await directory().requestOtp(`${crypto.randomUUID()}@example.com`);
      if (requested.kind !== "ok") throw new Error("otp request failed");
      const res = await fetchApp(
        formPost("/dashboard/auth/verify", {
          form: { challengeId: requested.challengeId, code: requested.code, next },
        }),
      );
      expect(res.status).toBe(303);
      expect(res.headers.get("Location")).toBe("/dashboard");
    }
    const requested = await directory().requestOtp(`${crypto.randomUUID()}@example.com`);
    if (requested.kind !== "ok") throw new Error("otp request failed");
    const res = await fetchApp(
      formPost("/dashboard/auth/verify", {
        form: {
          challengeId: requested.challengeId,
          code: requested.code,
          next: "/oauth/authorize?client_id=abc",
        },
      }),
    );
    expect(res.headers.get("Location")).toBe("/oauth/authorize?client_id=abc");
  });

  it("signs out immediately", async () => {
    const user = await signedInUser();
    const res = await fetchApp(
      formPost("/dashboard/auth/logout", {
        cookie: user.cookie,
        form: { csrf: user.csrf },
      }),
    );
    expect(res.status).toBe(303);
    const after = await fetchApp(pageGet("/dashboard", user.cookie));
    expect(await after.text()).toContain("Email me a sign-in code");
  });
});

describe("dashboard CSRF + account cards", () => {
  it("refuses authed POSTs without the HMAC csrf field", async () => {
    const user = await signedInUser();
    const missing = await fetchApp(
      formPost("/dashboard/origins", {
        cookie: user.cookie,
        form: { origins: "https://example.com" },
      }),
    );
    expect(missing.status).toBe(403);
    const wrong = await fetchApp(
      formPost("/dashboard/origins", {
        cookie: user.cookie,
        form: { origins: "https://example.com", csrf: "0".repeat(64) },
      }),
    );
    expect(wrong.status).toBe(403);
  });

  it("round-trips allowed origins and gates pairing on them", async () => {
    const user = await signedInUser();
    // Pairing before any origin exists is refused with the inline reason.
    const early = await fetchApp(
      formPost("/dashboard/pair", { cookie: user.cookie, form: { csrf: user.csrf } }),
    );
    expect(await early.text()).toContain("No allowed origins yet");

    const saved = await fetchApp(
      formPost("/dashboard/origins", {
        cookie: user.cookie,
        form: { csrf: user.csrf, origins: "https://example.com\nhttps://example.com/" },
      }),
    );
    expect(saved.status).toBe(303);
    const home = await fetchApp(pageGet("/dashboard", user.cookie));
    expect(await home.text()).toContain("https://example.com");

    const pair = await fetchApp(
      formPost("/dashboard/pair", { cookie: user.cookie, form: { csrf: user.csrf } }),
    );
    expect(pair.status).toBe(200);
    const pairHtml = await pair.text();
    expect(pairHtml).toMatch(/[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}/);
    expect(pairHtml).toContain("data-expires");
  });

  it("creates a show-once token that verifies by digest, and revokes it", async () => {
    const user = await signedInUser();
    const created = await fetchApp(
      formPost("/dashboard/tokens/create", {
        cookie: user.cookie,
        form: { csrf: user.csrf, label: "laptop" },
      }),
    );
    expect(created.status).toBe(200);
    const createdHtml = await created.text();
    const token = /usk_v1_[0-9A-Za-z]{16}_[A-Za-z0-9_-]{43}/.exec(createdHtml)?.[0];
    expect(token).toBeDefined();
    if (token === undefined) return;
    expect(await directory().verifyMcpToken(await sha256Hex(token))).toMatchObject({
      tenantId: user.tenantId,
    });

    const listed = await directory().listMcpTokens(user.userId);
    const tokenId = listed[0]?.tokenId ?? "";
    const revoked = await fetchApp(
      formPost("/dashboard/tokens/revoke", {
        cookie: user.cookie,
        form: { csrf: user.csrf, tokenId },
      }),
    );
    expect(revoked.status).toBe(303);
    expect(await directory().verifyMcpToken(await sha256Hex(token))).toBeNull();
  });
});

describe("dashboard vault upload", () => {
  /** The client-side sealer, mirroring pages.ts's VAULT_UPLOAD_JS exactly. */
  async function seal(
    jwk: JsonWebKey,
    plaintext: string,
  ): Promise<{ epk: string; iv: string; ct: string }> {
    const serverKey = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "ECDH", namedCurve: "P-256" },
      false,
      [],
    );
    const ephemeral = (await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveBits"],
    )) as CryptoKeyPair;
    const shared = await crypto.subtle.deriveBits(
      { name: "ECDH", public: serverKey } as unknown as SubtleCryptoDeriveKeyAlgorithm,
      ephemeral.privateKey,
      256,
    );
    const hkdf = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
    const aes = await crypto.subtle.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: new Uint8Array(0),
        info: new TextEncoder().encode("understudy-vault-upload-v1"),
      },
      hkdf,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt"],
    );
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      aes,
      new TextEncoder().encode(plaintext),
    );
    const epk = (await crypto.subtle.exportKey("raw", ephemeral.publicKey)) as ArrayBuffer;
    return {
      epk: base64urlEncode(new Uint8Array(epk)),
      iv: base64urlEncode(iv),
      ct: base64urlEncode(new Uint8Array(ciphertext)),
    };
  }

  it("stores a browser-sealed secret as a decryptable vault envelope", async () => {
    // #given the served upload key
    const user = await signedInUser();
    const keyRes = await fetchApp(pageGet("/dashboard/vault/pubkey", user.cookie));
    expect(keyRes.status).toBe(200);
    const jwk = (await keyRes.json()) as JsonWebKey;

    // #when a client-sealed value is posted
    const name = `secret-${crypto.randomUUID()}`;
    const sealed = await seal(jwk, "hunter2");
    const res = await fetchApp(
      formPost("/dashboard/vault/put", {
        cookie: user.cookie,
        form: { csrf: user.csrf, name, ...sealed },
      }),
    );

    // #then the standard envelope round-trips through the decrypting vault
    expect(res.status).toBe(303);
    expect(await createVault(env).get(`vault://${user.tenantId}/${name}`)).toBe("hunter2");
    expect(await listVaultSecretNames(env.VAULT, user.tenantId)).toContain(name);
  });

  it("rejects garbage payloads and hostile names without writing", async () => {
    const user = await signedInUser();
    const bad = await fetchApp(
      formPost("/dashboard/vault/put", {
        cookie: user.cookie,
        form: { csrf: user.csrf, name: "ok-name", epk: "AAAA", iv: "AAAA", ct: "AAAA" },
      }),
    );
    expect(await bad.text()).toContain("could not be read");
    const traversal = await fetchApp(
      formPost("/dashboard/vault/put", {
        cookie: user.cookie,
        form: { csrf: user.csrf, name: "../other/key", epk: "A", iv: "A", ct: "A" },
      }),
    );
    expect(await traversal.text()).toContain("Secret not saved");
  });
});

describe("OAuth consent flow end to end", () => {
  function b64uOfBytes(bytes: ArrayBuffer): string {
    return base64urlEncode(new Uint8Array(bytes));
  }

  async function registerClient(): Promise<string> {
    const res = await fetchApp(
      new Request(`${CANONICAL}/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          redirect_uris: ["https://client.example/cb"],
          client_name: "Test MCP Client",
          token_endpoint_auth_method: "none",
        }),
      }),
    );
    expect([200, 201]).toContain(res.status);
    const registered = (await res.json()) as { client_id: string };
    return registered.client_id;
  }

  it("runs register → consent → code → token → authenticated MCP call", async () => {
    const user = await signedInUser();
    const clientId = await registerClient();
    const verifier = base64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
    const challenge = b64uOfBytes(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
    );
    const authorizePath =
      `/oauth/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}` +
      `&redirect_uri=${encodeURIComponent("https://client.example/cb")}` +
      `&scope=mcp&state=xyz&code_challenge=${challenge}&code_challenge_method=S256`;

    // Signed out ⇒ bounced to login with the consent URL as next.
    const anonymous = await fetchApp(pageGet(authorizePath));
    expect(anonymous.status).toBe(303);
    expect(anonymous.headers.get("Location")).toContain("/dashboard?next=%2Foauth%2Fauthorize");

    // Signed in ⇒ consent page shows the escaped DCR client name.
    const consent = await fetchApp(pageGet(authorizePath, user.cookie));
    expect(consent.status).toBe(200);
    const consentHtml = await consent.text();
    expect(consentHtml).toContain("Test MCP Client");
    const authreq = /name="authreq" value="([^"]+)"/.exec(consentHtml)?.[1] ?? "";
    const sig = /name="sig" value="([^"]+)"/.exec(consentHtml)?.[1] ?? "";
    expect(authreq.length).toBeGreaterThan(0);
    expect(sig.length).toBeGreaterThan(0);

    // Approve ⇒ redirect back to the client with a code.
    const approved = await fetchApp(
      formPost("/oauth/authorize", {
        cookie: user.cookie,
        form: { csrf: user.csrf, authreq, sig, decision: "approve" },
      }),
    );
    expect(approved.status).toBe(302);
    const redirect = new URL(approved.headers.get("Location") ?? "");
    expect(redirect.origin).toBe("https://client.example");
    expect(redirect.searchParams.get("state")).toBe("xyz");
    const code = redirect.searchParams.get("code") ?? "";
    expect(code.length).toBeGreaterThan(0);

    // Exchange the code (PKCE, public client).
    const tokenRes = await fetchApp(
      new Request(`${CANONICAL}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: "https://client.example/cb",
          client_id: clientId,
          code_verifier: verifier,
        }),
      }),
    );
    expect(tokenRes.status).toBe(200);
    const tokens = (await tokenRes.json()) as { access_token: string };
    expect(tokens.access_token.length).toBeGreaterThan(0);

    // The grant's props drive the MCP endpoint exactly like a usk_ token.
    const mcp = await fetchApp(
      new Request(`${CANONICAL}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${tokens.access_token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "oauth-test", version: "0.0.0" },
          },
        }),
      }),
    );
    expect(mcp.status).toBe(200);
    expect(await mcp.text()).toContain("understudy");
  });

  it("redirects a denial with access_denied and no grant", async () => {
    const user = await signedInUser();
    const clientId = await registerClient();
    const verifier = base64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
    const challenge = b64uOfBytes(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
    );
    const consent = await fetchApp(
      pageGet(
        `/oauth/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}` +
          `&redirect_uri=${encodeURIComponent("https://client.example/cb")}` +
          `&scope=mcp&state=deny-state&code_challenge=${challenge}&code_challenge_method=S256`,
        user.cookie,
      ),
    );
    const consentHtml = await consent.text();
    const authreq = /name="authreq" value="([^"]+)"/.exec(consentHtml)?.[1] ?? "";
    const sig = /name="sig" value="([^"]+)"/.exec(consentHtml)?.[1] ?? "";
    const denied = await fetchApp(
      formPost("/oauth/authorize", {
        cookie: user.cookie,
        form: { csrf: user.csrf, authreq, sig, decision: "deny" },
      }),
    );
    expect(denied.status).toBe(302);
    const redirect = new URL(denied.headers.get("Location") ?? "");
    expect(redirect.searchParams.get("error")).toBe("access_denied");
    expect(redirect.searchParams.get("state")).toBe("deny-state");
  });

  it("refuses a consent submission whose request was swapped after render", async () => {
    const user = await signedInUser();
    const forged = base64urlEncode(
      new TextEncoder().encode(JSON.stringify({ clientId: "evil", redirectUri: "https://evil" })),
    );
    const res = await fetchApp(
      formPost("/oauth/authorize", {
        cookie: user.cookie,
        form: { csrf: user.csrf, authreq: forged, sig: "0".repeat(64), decision: "approve" },
      }),
    );
    expect(res.status).toBe(403);
  });
});
