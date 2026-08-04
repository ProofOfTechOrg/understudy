/**
 * The OAuthProvider's defaultHandler: the account dashboard and the
 * /oauth/authorize consent screen. Server-rendered forms over the
 * AccountDirectory; every response is no-store with a nonce-locked CSP, and
 * every state-changing request passes the same-origin gate in the middleware
 * below — authed forms additionally carry the HMAC csrf field (see ./auth).
 */

import { Hono, type Context } from "hono";
import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import { AUTH_CONTRACT_VERSION, getDirectory } from "../account-directory";
import {
  sha256Hex,
  taggedHmacHex,
  timingSafeHexEqual,
  unauthenticatedRateAllowed,
} from "../auth";
import {
  listDevices as listLiveDevices,
  mergeDeviceViews,
  revokeDeviceForOwner,
  updateOriginPolicyForOwner,
} from "../api/sessions";
import { base64urlDecode, base64urlEncode } from "../base64url";
import { emitTelemetry } from "../telemetry";
import type { Env } from "../types";
import { canonicalizeOrigins, RequestBodyError } from "../validation";
import {
  clearedSessionCookie,
  csrfValid,
  csrfTokenFor,
  safeNext,
  sameOriginRequest,
  sessionCookie,
  sessionFromRequest,
  type DashboardUser,
} from "./auth";
import { sendOtpEmail } from "./email";
import {
  consentPage,
  homePage,
  layout,
  loginPage,
  messagePage,
  pairingOfferPage,
  privacyPage,
  tokenRevealPage,
  verifyPage,
  type HomeDevice,
} from "./pages";

type Variables = { cspNonce: string };
type DashboardContext = { Bindings: Env; Variables: Variables };

export const dashboardApp = new Hono<DashboardContext>();

const NOTICES: Record<string, string> = {
  "origins-saved": "Allowed origins saved.",
  "token-revoked": "API token revoked.",
  "token-missing": "That API token was already gone.",
  "device-revoked": "Browser revoked. Generate a fresh pairing offer to reconnect it.",
  "device-missing": "That browser was already gone.",
  "grant-revoked": "OAuth connection revoked.",
};

dashboardApp.use("*", async (c, next) => {
  const nonce = base64urlEncode(crypto.getRandomValues(new Uint8Array(16)));
  c.set("cspNonce", nonce);
  // The same-origin gate lives here, not in each handler: it is the ONLY CSRF
  // control on the two pre-session sign-in routes (see ./auth), so a new route
  // silently inheriting no protection is the wrong default. It covers every
  // non-safe method, not only POST.
  //
  // Scope: the provider owns /oauth/token, /oauth/register, /mcp* and the two
  // well-knowns, which never reach this app. Everything else under /oauth/ does
  // and is therefore gated — including /oauth/register/<clientId> (RFC 7592),
  // because the provider matches its registration endpoint exactly, not by
  // prefix. That path is unimplemented here and 403s where it used to 404.
  if (c.req.method !== "GET" && c.req.method !== "HEAD" && !sameOriginRequest(c.req.raw)) {
    c.res = c.text("cross-origin request refused", 403);
  } else {
    await next();
  }
  c.header("Cache-Control", "no-store");
  c.header("Strict-Transport-Security", "max-age=300");
  // `same-origin`, not `no-referrer`. The privacy goal — never leak a dashboard
  // URL to a third party — is met identically by both: neither sends anything
  // cross-origin, including on the consent redirect that carries the
  // authorization code. `no-referrer` additionally forces Fetch to serialize a
  // same-origin form POST's `Origin` as `null`, which would strand the fallback
  // branch of `sameOriginRequest` in a permanent 403. `same-origin` is the
  // strictest policy that preserves that header; `strict-origin*` would leak
  // the bare origin cross-origin for no gain here.
  c.header("Referrer-Policy", "same-origin");
  c.header(
    "Content-Security-Policy",
    `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; ` +
      `form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
  );
});

const directory = getDirectory;

// A dashboard form value, bounded BEFORE it crosses into the singleton
// directory DO — an oversized field from one account must not be buffered and
// processed inside the object every other account's auth depends on. 16 KB
// clears the largest legitimate fields (the origins textarea and serialized
// authorization requests are far smaller).
const MAX_FIELD_BYTES = 16384;

const S256_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

function requireS256Pkce(request: AuthRequest): void {
  if (
    request.codeChallengeMethod !== "S256" ||
    request.codeChallenge === undefined ||
    !S256_CHALLENGE.test(request.codeChallenge)
  ) {
    throw new Error("S256 PKCE is required");
  }
}

function field(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  return typeof value === "string" ? value.slice(0, MAX_FIELD_BYTES) : "";
}

/** HMAC binding a rendered consent form to this exact request AND session. */
function consentSig(env: Env, authreq: string, cookieToken: string): Promise<string> {
  return taggedHmacHex(env, "consent-v1", `${authreq}|${cookieToken}`);
}

type Ctx = Context<DashboardContext>;

function render(c: Ctx, title: string, body: Parameters<typeof layout>[2]) {
  return c.html(layout(title, c.get("cspNonce"), body));
}

/** Session + CSRF for every authed POST; a Response means refusal. The
 * same-origin gate already ran in the middleware. */
async function authedPost(
  c: Ctx,
  body: Record<string, unknown>,
): Promise<DashboardUser | Response> {
  const user = await sessionFromRequest(c.req.raw, c.env);
  if (user === null) return c.text("signed out — reload the dashboard", 403);
  if (!(await csrfValid(c.env, user.cookieToken, body.csrf))) {
    return c.text("stale form — reload the dashboard", 403);
  }
  return user;
}

dashboardApp.get("/privacy", (c) => {
  return render(c, "Privacy — Understudy", privacyPage());
});

dashboardApp.get("/dashboard", async (c) => {
  const user = await sessionFromRequest(c.req.raw, c.env);
  const next = safeNext(c.req.query("next"));
  if (user === null) {
    return render(c, "Sign in — Understudy", loginPage(next));
  }
  const [directoryDevices, tokens, liveDevices, grantPage] = await Promise.all([
    directory(c.env).listDevices(user.userId),
    directory(c.env).listMcpTokens(user.userId),
    listLiveDevices(c.env, { actor: `dashboard:${user.userId}`, tenantId: user.tenantId }),
    c.env.OAUTH_PROVIDER?.listUserGrants(user.userId, { limit: 100 }) ??
      Promise.resolve({ items: [] }),
  ]);
  const devices: HomeDevice[] = mergeDeviceViews(directoryDevices, liveDevices).map((view) => ({
    deviceId: view.deviceId,
    label: view.label,
    status: view.status,
    used: view.used,
    capacity: view.capacity,
    lastSeenAt: view.lastSeenAt,
  }));
  const noticeKey = c.req.query("notice");
  return render(
    c,
    "Understudy dashboard",
    homePage({
      email: user.email,
      csrf: await csrfTokenFor(c.env, user.cookieToken),
      origins: user.allowedOrigins,
      devices,
      tokens,
      grants: grantPage.items.map((grant) => ({
        grantId: grant.id,
        clientId: grant.clientId,
        label:
          typeof grant.metadata?.label === "string"
            ? grant.metadata.label
            : grant.clientId,
        deviceId:
          typeof grant.metadata?.deviceId === "string"
            ? grant.metadata.deviceId
            : null,
      })),
      ...(noticeKey !== undefined && NOTICES[noticeKey] !== undefined
        ? { notice: NOTICES[noticeKey] }
        : {}),
    }),
  );
});

dashboardApp.post("/dashboard/auth/request-code", async (c) => {
  if (!(await unauthenticatedRateAllowed(c.req.raw, c.env, "otp-request"))) {
    return c.text("rate limited — try again shortly", 429);
  }
  const body = await c.req.parseBody();
  const email = field(body, "email").trim().toLowerCase();
  const next = safeNext(field(body, "next"));
  const requested = await directory(c.env).requestOtp(email);
  if (requested.kind === "ok") {
    // Failure is deliberately silent: the response below never reveals
    // whether an email exists, is rate-limited, or failed to send.
    await sendOtpEmail(c.env, requested.email, requested.code);
  }
  // Same page for every outcome — a fake challengeId fails verification with
  // the same "invalid" as a wrong code, so nothing is enumerable.
  const challengeId = requested.kind === "ok" ? requested.challengeId : crypto.randomUUID();
  return render(
    c,
    "Enter your code — Understudy",
    verifyPage({ challengeId, email, next }),
  );
});

dashboardApp.post("/dashboard/auth/verify", async (c) => {
  if (!(await unauthenticatedRateAllowed(c.req.raw, c.env, "otp-verify"))) {
    return c.text("rate limited — try again shortly", 429);
  }
  const body = await c.req.parseBody();
  const challengeId = field(body, "challengeId");
  const code = field(body, "code").trim();
  const next = safeNext(field(body, "next"));
  const verified = await directory(c.env).verifyOtp(challengeId, code);
  if (verified.kind !== "ok") {
    await emitTelemetry(c.env, { event: "authentication", outcome: "dashboard_otp_failed" });
    return render(
      c,
      "Enter your code — Understudy",
      verifyPage({
        challengeId,
        email: field(body, "email"),
        next,
        error: "That code did not work. Codes expire after 10 minutes and 5 attempts.",
      }),
    );
  }
  await emitTelemetry(c.env, {
    event: "authentication",
    outcome: "dashboard_login",
    tenantId: verified.tenantId,
    actor: verified.userId,
  });
  const session = await directory(c.env).createDashboardSession(verified.userId);
  c.header("Set-Cookie", sessionCookie(session.token));
  return c.redirect(next, 303);
});

dashboardApp.post("/dashboard/auth/logout", async (c) => {
  const body = await c.req.parseBody();
  const user = await authedPost(c, body);
  if (user instanceof Response) return user;
  await directory(c.env).revokeDashboardSession(await sha256Hex(user.cookieToken));
  c.header("Set-Cookie", clearedSessionCookie());
  return c.redirect("/dashboard", 303);
});

dashboardApp.post("/dashboard/origins", async (c) => {
  const body = await c.req.parseBody();
  const user = await authedPost(c, body);
  if (user instanceof Response) return user;
  const origins = field(body, "origins")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  let canonical: string[];
  try {
    canonical = canonicalizeOrigins(origins);
  } catch (error) {
    return render(
      c,
      "Origins — Understudy",
      messagePage(
        "Origins not saved",
        `Invalid origin list: ${
          error instanceof RequestBodyError ? error.message : "invalid origin"
        }.`,
      ),
    );
  }
  const result = await updateOriginPolicyForOwner(
    c.env,
    { userId: user.userId, tenantId: user.tenantId },
    canonical,
  );
  if (result.kind === "invalid") {
    return render(
      c,
      "Origins — Understudy",
      messagePage("Origins not saved", `Invalid origin list: ${result.message}.`),
    );
  }
  return c.redirect("/dashboard?notice=origins-saved", 303);
});

dashboardApp.post("/dashboard/pair", async (c) => {
  const body = await c.req.parseBody();
  const user = await authedPost(c, body);
  if (user instanceof Response) return user;
  const created = await directory(c.env).createPairingOffer(user.userId);
  if (!/^[a-p]{32}$/.test(c.env.EXTENSION_ID)) {
    return render(
      c,
      "Pair browser — Understudy",
      messagePage("Pairing unavailable", "The production extension ID is not configured."),
    );
  }
  return render(
    c,
    "Pair browser — Understudy",
    pairingOfferPage(
      await csrfTokenFor(c.env, user.cookieToken),
      created.offer,
      created.expiresAt,
      c.env.EXTENSION_ID,
    ),
  );
});

dashboardApp.post("/dashboard/tokens/create", async (c) => {
  const body = await c.req.parseBody();
  const user = await authedPost(c, body);
  if (user instanceof Response) return user;
  const label = field(body, "label").trim();
  const created = await directory(c.env).createMcpToken(
    user.userId,
    field(body, "deviceId"),
    label.length === 0 ? null : label,
  );
  if (created === null) return c.text("account unavailable", 403);
  return render(
    c,
    "API token — Understudy",
    tokenRevealPage(created.token, label.length === 0 ? null : label),
  );
});

dashboardApp.post("/dashboard/tokens/revoke", async (c) => {
  const body = await c.req.parseBody();
  const user = await authedPost(c, body);
  if (user instanceof Response) return user;
  const revoked = await directory(c.env).revokeMcpToken(user.userId, field(body, "tokenId"));
  return c.redirect(`/dashboard?notice=${revoked ? "token-revoked" : "token-missing"}`, 303);
});

dashboardApp.post("/dashboard/oauth/revoke", async (c) => {
  const body = await c.req.parseBody();
  const user = await authedPost(c, body);
  if (user instanceof Response) return user;
  const helpers = c.env.OAUTH_PROVIDER;
  if (helpers === undefined) return c.text("oauth unavailable", 500);
  await helpers.revokeGrant(field(body, "grantId"), user.userId);
  return c.redirect("/dashboard?notice=grant-revoked", 303);
});

dashboardApp.post("/dashboard/devices/revoke", async (c) => {
  const body = await c.req.parseBody();
  const user = await authedPost(c, body);
  if (user instanceof Response) return user;
  // Ownership check and kill-switch push both live in the service layer, which
  // also collapses "already revoked" and "never yours" into one outcome so this
  // route cannot become an existence oracle for another account's device ids.
  const outcome = await revokeDeviceForOwner(c.env, user, field(body, "deviceId"));
  return c.redirect(
    `/dashboard?notice=${outcome === "revoked" ? "device-revoked" : "device-missing"}`,
    303,
  );
});

// ── OAuth consent (the provider routes /oauth/authorize to this app) ────────

dashboardApp.get("/oauth/authorize", async (c) => {
  const helpers = c.env.OAUTH_PROVIDER;
  if (helpers === undefined) return c.text("oauth unavailable", 500);
  let oauthReq: AuthRequest;
  try {
    oauthReq = await helpers.parseAuthRequest(c.req.raw);
    requireS256Pkce(oauthReq);
  } catch {
    return c.text("invalid authorization request", 400);
  }
  const user = await sessionFromRequest(c.req.raw, c.env);
  if (user === null) {
    const url = new URL(c.req.url);
    return c.redirect(
      `/dashboard?next=${encodeURIComponent(url.pathname + url.search)}`,
      303,
    );
  }
  const client = await helpers.lookupClient(oauthReq.clientId);
  if (client === null) return c.text("unknown client", 400);
  const devices = await directory(c.env).listDevices(user.userId);
  if (devices.length === 0) {
    return render(
      c,
      "Pair a browser — Understudy",
      messagePage(
        "Pair a browser first",
        "OAuth access must be bound to one active browser. Pair a browser, then restart authorization.",
      ),
    );
  }
  // DCR metadata is untrusted display data: the name is escaped by the
  // template, and no client-supplied images or links are ever rendered.
  const clientName = client.clientName ?? oauthReq.clientId;
  let redirectOrigin: string;
  try {
    redirectOrigin = new URL(oauthReq.redirectUri).origin;
  } catch {
    return c.text("invalid authorization request", 400);
  }
  const authreq = base64urlEncode(new TextEncoder().encode(JSON.stringify(oauthReq)));
  return render(
    c,
    "Authorize — Understudy",
    consentPage({
      clientName,
      redirectOrigin,
      email: user.email,
      csrf: await csrfTokenFor(c.env, user.cookieToken),
      authreq,
      // Binds the rendered request to the submitted one AND to this session,
      // so it cannot be swapped between render and submit or replayed under a
      // different login.
      sig: await consentSig(c.env, authreq, user.cookieToken),
      devices: devices.map((device) => ({
        deviceId: device.deviceId,
        label: device.label,
      })),
    }),
  );
});

dashboardApp.post("/oauth/authorize", async (c) => {
  const helpers = c.env.OAUTH_PROVIDER;
  if (helpers === undefined) return c.text("oauth unavailable", 500);
  const body = await c.req.parseBody();
  const user = await authedPost(c, body);
  if (user instanceof Response) return user;
  const authreq = field(body, "authreq");
  const sig = field(body, "sig");
  if (
    authreq.length === 0 ||
    !timingSafeHexEqual(await consentSig(c.env, authreq, user.cookieToken), sig)
  ) {
    return c.text("stale consent form", 403);
  }
  let oauthReq: AuthRequest;
  try {
    oauthReq = JSON.parse(new TextDecoder().decode(base64urlDecode(authreq))) as AuthRequest;
    requireS256Pkce(oauthReq);
  } catch {
    return c.text("stale consent form", 403);
  }

  if (field(body, "decision") !== "approve") {
    const client = await helpers.lookupClient(oauthReq.clientId);
    if (client === null || !client.redirectUris.includes(oauthReq.redirectUri)) {
      return c.text("unknown client", 400);
    }
    const denied = new URL(oauthReq.redirectUri);
    denied.searchParams.set("error", "access_denied");
    if (oauthReq.state.length > 0) denied.searchParams.set("state", oauthReq.state);
    return c.redirect(denied.toString(), 302);
  }

  const client = await helpers.lookupClient(oauthReq.clientId);
  const deviceId = field(body, "deviceId");
  const userDevices = await directory(c.env).listDevices(user.userId);
  if (!userDevices.some((device) => device.deviceId === deviceId)) {
    return c.text("select an active browser", 400);
  }
  const { redirectTo } = await helpers.completeAuthorization({
    request: oauthReq,
    userId: user.userId,
    metadata: {
      label: client?.clientName ?? oauthReq.clientId,
      deviceId,
      authEpoch: user.authEpoch,
      contractVersion: AUTH_CONTRACT_VERSION,
    },
    scope: ["mcp"],
    props: {
      userId: user.userId,
      tenantId: user.tenantId,
      actorId: `oauth:${oauthReq.clientId}`,
      authMethod: "oauth",
      scopes: ["mcp"],
      deviceId,
      authEpoch: user.authEpoch,
      contractVersion: AUTH_CONTRACT_VERSION,
    },
  });
  await emitTelemetry(c.env, {
    event: "authentication",
    outcome: "oauth_grant",
    tenantId: user.tenantId,
    actor: user.userId,
  });
  return c.redirect(redirectTo, 302);
});

dashboardApp.all("*", (c) => {
  return c.text("not found", 404);
});

// Scrubbed error boundary for the whole dashboard/consent plane, mirroring
// the /v1 app's onError. Without it a throw (a directory RPC fault, a
// template failure) would surface as an unscrubbed 500 for sign-in, pairing,
// and revocation alike.
dashboardApp.onError((_error, c) => {
  console.error("unhandled dashboard error");
  c.header("Cache-Control", "no-store");
  return c.text("internal error", 500);
});
