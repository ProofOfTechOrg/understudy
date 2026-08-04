/**
 * Dashboard auth, CSRF, pairing, and the full OAuth consent flow
 * (PR 4 of the MCP surface). All requests go through the module fetch
 * directly (the pool's exports wrapper rewrites hosts, and the dashboard's
 * origin checks are host-sensitive). Fresh users per test — storage is
 * shared across the run.
 */

import { env } from "cloudflare:workers";
import { PROTOCOL_CAPABILITIES } from "@understudy/protocol";
import { describe, expect, it, vi } from "vitest";
import { revokeDeviceForOwner, updateOriginPolicyForOwner } from "../src/api/sessions";
import { sha256Hex, taggedHmacHex } from "../src/auth";
import type { RevokeCredentialOutcome } from "../src/device";
import { safeNext, sameOriginRequest } from "../src/dashboard/auth";
import { base64urlEncode } from "../src/base64url";
import { sendOtpEmail } from "../src/dashboard/email";
import type { Env } from "../src/types";
import {
  CANONICAL,
  connectTicketRequest,
  directory,
  fetchApp,
  mintUser,
  pairDevice,
} from "./helpers";

interface FormRequestOptions {
  cookie?: string;
  form?: Record<string, string>;
  origin?: string | null;
  secFetchSite?: string;
}

function formPost(path: string, options: FormRequestOptions): Request {
  const headers = new Headers();
  if (options.origin !== null) headers.set("Origin", options.origin ?? CANONICAL);
  if (options.secFetchSite !== undefined) {
    headers.set("Sec-Fetch-Site", options.secFetchSite);
  }
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

describe("safeNext guard", () => {
  it("rejects a /oauth/authorize target carrying CR/LF, NUL, or backslash", () => {
    // These start with the required prefix, so ONLY NEXT_FORBIDDEN can reject
    // them — deleting the control-char guard would let a CR/LF Location value
    // through and throw a 500 (or worse) inside c.redirect().
    expect(safeNext("/oauth/authorize?x=1\r\nSet-Cookie: evil=1")).toBe("/dashboard");
    expect(safeNext("/oauth/authorize?x=1\nfoo")).toBe("/dashboard");
    expect(safeNext("/oauth/authorize?x=1\tfoo")).toBe("/dashboard");
    expect(safeNext("/oauth/authorize?x=a\\b")).toBe("/dashboard");
  });

  it("preserves a clean /oauth/authorize target and collapses everything else", () => {
    expect(safeNext("/oauth/authorize?client_id=abc&scope=mcp")).toBe(
      "/oauth/authorize?client_id=abc&scope=mcp",
    );
    expect(safeNext("/evil")).toBe("/dashboard");
    expect(safeNext("//evil.example")).toBe("/dashboard");
    expect(safeNext(undefined)).toBe("/dashboard");
  });
});

describe("sameOriginRequest guard", () => {
  const probe = (headers: Record<string, string>): Request =>
    new Request(`${CANONICAL}/dashboard/origins`, { method: "POST", headers });

  it("admits only same-origin of the four Sec-Fetch-Site values", () => {
    // `same-site` is the load-bearing rejection: the canonical host sits under
    // a registrable domain, so a compromised sibling subdomain presents exactly
    // this. `none` is an address-bar/bookmark/restored POST — no form this app
    // rendered can produce it.
    expect(sameOriginRequest(probe({ "Sec-Fetch-Site": "same-origin" }))).toBe(true);
    expect(sameOriginRequest(probe({ "Sec-Fetch-Site": "same-site" }))).toBe(false);
    expect(sameOriginRequest(probe({ "Sec-Fetch-Site": "cross-site" }))).toBe(false);
    expect(sameOriginRequest(probe({ "Sec-Fetch-Site": "none" }))).toBe(false);
  });

  it("ignores Origin entirely whenever Sec-Fetch-Site is present", () => {
    // Neither header is forgeable cross-site, but only Sec-Fetch-Site is immune
    // to this app's own Referrer-Policy — so it must win in BOTH directions,
    // including admitting a request whose Origin was serialized as "null".
    expect(
      sameOriginRequest(probe({ "Sec-Fetch-Site": "same-origin", Origin: "null" })),
    ).toBe(true);
    expect(
      sameOriginRequest(probe({ "Sec-Fetch-Site": "cross-site", Origin: CANONICAL })),
    ).toBe(false);
  });

  it("falls back to Origin only when Sec-Fetch-Site is absent", () => {
    // Pre-Fetch-Metadata browsers. Reachable in a useful state only while the
    // referrer policy is not `no-referrer` — see the header pin below.
    expect(sameOriginRequest(probe({ Origin: CANONICAL }))).toBe(true);
    expect(sameOriginRequest(probe({ Origin: "https://evil.example" }))).toBe(false);
    expect(sameOriginRequest(probe({ Origin: "null" }))).toBe(false);
    expect(sameOriginRequest(probe({}))).toBe(false);
  });
});

describe("OTP email seam", () => {
  it("sends through the emulated binding on the happy path", async () => {
    // The vitest pool emulates send_email, so the real send path runs.
    expect(await sendOtpEmail(env, "someone@example.com", "123456")).toBe(true);
  });

  it("signals (does not throw) when the EMAIL binding is unbound", async () => {
    // A global misconfiguration (de-onboarded domain, dropped binding) must
    // not silently break sign-in with no server-side signal.
    const noEmail = { ...env, EMAIL: undefined } as unknown as Env;
    expect(await sendOtpEmail(noEmail, "someone@example.com", "123456")).toBe(false);
  });
});

describe("dashboard sign-in", () => {
  it("serves the login page with no-store, a nonce-locked CSP, and Referrer-Policy: same-origin", async () => {
    const res = await fetchApp(pageGet("/dashboard"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Content-Security-Policy")).toContain("script-src 'nonce-");
    // Pinned, not merely non-empty: `no-referrer` here nulls the Origin on this
    // app's own form posts, stranding sameOriginRequest's fallback in a permanent
    // 403 that no modern-browser test would catch.
    expect(res.headers.get("Referrer-Policy")).toBe("same-origin");
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

  it("admits a sign-in POST whose Origin was serialized as null", async () => {
    // #given a referrer policy of `no-referrer` makes a browser send this exact
    // pair — Origin "null" alongside a truthful Sec-Fetch-Site. The unit block
    // pins the predicate; this pins the whole route, on the one path where the
    // same-origin gate is the ONLY CSRF control.
    // #when
    const res = await fetchApp(
      formPost("/dashboard/auth/request-code", {
        form: { email: "a@example.com" },
        origin: "null",
        secFetchSite: "same-origin",
      }),
    );
    // #then it reaches the handler and renders the code-entry page.
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("6-digit code");
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

describe("public privacy page", () => {
  it("serves the policy through the canonical no-store account plane", async () => {
    const res = await fetchApp(pageGet("/privacy"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Content-Security-Policy")).toContain(
      "script-src 'nonce-",
    );
    expect(res.headers.get("Referrer-Policy")).toBe("same-origin");

    const body = await res.text();
    expect(body).toContain("Understudy privacy policy");
    expect(body).toContain("Command payloads and results may remain");
    expect(body).toContain("does not load or execute remotely hosted code");
    expect(body).toContain('href="/privacy"');
    expect(body).toContain(
      "https://github.com/ProofOfTechOrg/understudy/issues",
    );
  });
});

describe("dashboard CSRF + account cards", () => {
  it("refuses a cross-site authed write before session or csrf is consulted", async () => {
    // #given a valid cookie AND a valid csrf token — so only the middleware
    // gate can reject this. Proves the hoist did not create a route that
    // relies on the inner layers alone.
    const user = await signedInUser();
    // #when
    const res = await fetchApp(
      formPost("/dashboard/origins", {
        cookie: user.cookie,
        form: { csrf: user.csrf, origins: "https://evil.example" },
        secFetchSite: "cross-site",
      }),
    );
    // #then
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("cross-origin request refused");
  });

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

  it("allows an empty default policy and applies saved origins to later browsers", async () => {
    const user = await signedInUser();
    const early = await fetchApp(
      formPost("/dashboard/pair", { cookie: user.cookie, form: { csrf: user.csrf } }),
    );
    expect(early.status).toBe(200);
    expect(await early.text()).toMatch(/data-offer="[A-Za-z0-9_-]{43}"/);

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
    expect(pairHtml).toMatch(/data-offer="[A-Za-z0-9_-]{43}"/);
    expect(pairHtml).toContain("data-expires");
  });

  it("keeps the directory authoritative update pending until every coordinator accepts it", async () => {
    const user = await signedInUser();
    await pairDevice(user.userId);
    const before = await directory().getUser(user.userId);
    const unavailable = {
      ...env,
      TENANT_CONTROL: {
        getByName: () => ({ updateDevicePolicy: async () => false }),
      },
    } as unknown as Env;

    await expect(
      updateOriginPolicyForOwner(
        unavailable,
        { userId: user.userId, tenantId: user.tenantId },
        ["https://shop.example"],
      ),
    ).resolves.toEqual({
      kind: "invalid",
      message: "browser policies are still reconciling; retry",
    });
    expect((await directory().getUser(user.userId))?.allowedOrigins).toEqual(
      before?.allowedOrigins,
    );

    await expect(
      updateOriginPolicyForOwner(
        env,
        { userId: user.userId, tenantId: user.tenantId },
        ["https://shop.example"],
      ),
    ).resolves.toMatchObject({ kind: "ok", origins: ["https://shop.example"] });
    expect((await directory().getUser(user.userId))?.allowedOrigins).toEqual([
      "https://shop.example",
    ]);
  });

  it("commits canonical duplicate origins without retrying policy versions", async () => {
    const user = await signedInUser();
    const device = await pairDevice(user.userId);

    await expect(
      updateOriginPolicyForOwner(
        env,
        { userId: user.userId, tenantId: user.tenantId },
        ["https://shop.example/", "https://shop.example"],
      ),
    ).resolves.toMatchObject({
      kind: "ok",
      origins: ["https://shop.example"],
      devices: [{ deviceId: device.deviceId, policyVersion: 2 }],
    });
  });

  it("resolves both card anchors, so card order carries no correctness weight", async () => {
    // #given the two cross-references between cards are anchors, not the words
    // "above"/"below" — which is what lets the cards be reordered. Deleting
    // either id would dead-link a hint with nothing else failing.
    const user = await signedInUser();
    // #when
    const html = await (await fetchApp(pageGet("/dashboard", user.cookie))).text();
    // #then each anchor has exactly one target, and no id is duplicated.
    for (const id of ["origins", "browsers"]) {
      expect(html.split(`id="${id}"`).length - 1).toBe(1);
    }
  });

  it("creates a show-once token that verifies by digest, and revokes it", async () => {
    const user = await signedInUser();
    const device = await pairDevice(user.userId);
    const created = await fetchApp(
      formPost("/dashboard/tokens/create", {
        cookie: user.cookie,
        form: { csrf: user.csrf, label: "laptop", deviceId: device.deviceId },
      }),
    );
    expect(created.status).toBe(200);
    const createdHtml = await created.text();
    const token = /usk_v2_[0-9A-Za-z]{16}_[A-Za-z0-9_-]{43}/.exec(createdHtml)?.[0];
    expect(token).toBeDefined();
    if (token === undefined) return;
    expect(await directory().verifyMcpToken(await sha256Hex(token))).toMatchObject({
      tenantId: user.tenantId,
      deviceId: device.deviceId,
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

describe("dashboard device revoke kill switch", () => {
  function revokePost(
    user: { cookie: string; csrf: string },
    deviceId: string,
  ): Request {
    return formPost("/dashboard/devices/revoke", {
      cookie: user.cookie,
      form: { csrf: user.csrf, deviceId },
    });
  }

  /**
   * The revoke-related telemetry emitted while `run` executes, as
   * "event/outcome" in emission order. Both dimensions matter: the event
   * decides whether a revoke pollutes device_offline rates.
   */
  async function captureRevokeEvents(run: () => Promise<void>): Promise<string[]> {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await run();
      return log.mock.calls
        .map(([raw]) => JSON.parse(raw as string) as {
          telemetry?: { event?: string; outcome?: string };
        })
        .filter(
          (entry) =>
            entry.telemetry?.event === "device_revoke" ||
            entry.telemetry?.event === "device_offline",
        )
        .map((entry) => `${entry.telemetry?.event}/${entry.telemetry?.outcome}`);
    } finally {
      log.mockRestore();
    }
  }

  /**
   * An Env whose DeviceAgent leg yields a chosen outcome. Spreading the real
   * env keeps every other binding live, so the directory ownership check and
   * the coordinator leg still run for real.
   */
  function deviceEnv(outcome: RevokeCredentialOutcome | "throw"): Env {
    return {
      ...env,
      DEVICE: {
        getByName: () => ({
          revokeCredential: () =>
            outcome === "throw"
              ? Promise.reject(new Error("agent unreachable"))
              : Promise.resolve(outcome),
        }),
      },
    } as unknown as Env;
  }

  it("invalidates the credential immediately after revocation", async () => {
    // #given a paired device with an established DeviceAgent authority
    const user = await signedInUser();
    const device = await pairDevice(user.userId);
    expect((await fetchApp(connectTicketRequest(device.deviceCredential))).status).toBe(200);

    // #when the owner clicks Revoke
    const revoked = await fetchApp(revokePost(user, device.deviceId));
    expect(revoked.status).toBe(303);
    expect(revoked.headers.get("location")).toBe("/dashboard?notice=device-revoked");

    // #then directory revalidation rejects the very next ticket request.
    const retry = await fetchApp(connectTicketRequest(device.deviceCredential));
    expect(retry.status).toBe(401);
  });

  it("re-pushes on a second click without changing the notice", async () => {
    // #given a device already revoked once
    const user = await signedInUser();
    const device = await pairDevice(user.userId);
    expect((await fetchApp(connectTicketRequest(device.deviceCredential))).status).toBe(200);
    expect((await fetchApp(revokePost(user, device.deviceId))).status).toBe(303);

    // #when the owner clicks Revoke again — the only retry available if the
    // first push failed to reach the DeviceAgent
    const second = await fetchApp(revokePost(user, device.deviceId));

    // #then already_revoked reports device-missing but still pushes, and the
    // idempotent teardown leaves the device refused
    expect(second.status).toBe(303);
    expect(second.headers.get("location")).toBe("/dashboard?notice=device-missing");
    expect((await fetchApp(connectTicketRequest(device.deviceCredential))).status).toBe(401);
  });

  it("distinguishes an instant kill from an offline revoke in telemetry", async () => {
    // #given a paired device that has never opened a control socket
    const user = await signedInUser();
    const device = await pairDevice(user.userId);

    // #when it is revoked through the real route
    const events = await captureRevokeEvents(async () => {
      expect((await fetchApp(revokePost(user, device.deviceId))).status).toBe(303);
    });

    // #then it is a device_revoke, not a device_offline — nothing went offline.
    // Reusing the heartbeat path's device_offline/credential_revoked would make
    // "did the kill switch fire instantly" unanswerable from production data.
    expect(events).toEqual(["device_revoke/revoked_by_owner_offline"]);
  });

  it("reports revoked_by_owner when a live socket was torn down", async () => {
    // #given an agent leg reporting a closed socket — the one outcome that is a
    // genuine device_offline, and the signal that the instant kill fired
    const user = await signedInUser();
    const device = await pairDevice(user.userId);

    // #when
    const events = await captureRevokeEvents(async () => {
      await expect(
        revokeDeviceForOwner(deviceEnv("closed"), user, device.deviceId),
      ).resolves.toBe("revoked");
    });

    // #then
    expect(events).toEqual(["device_offline/revoked_by_owner"]);
  });

  it("reports a tenant-fence rejection rather than passing it off as a no-op", async () => {
    // #given an agent that refuses because the device belongs to someone else.
    // Unreachable through this path, so if it ever fires the ownership check
    // regressed — it must not be indistinguishable from "nothing to close".
    const user = await signedInUser();
    const device = await pairDevice(user.userId);

    // #when
    const events = await captureRevokeEvents(async () => {
      await revokeDeviceForOwner(deviceEnv("wrong_tenant"), user, device.deviceId);
    });

    // #then
    expect(events).toEqual(["device_revoke/tenant_mismatch"]);
  });

  it("reports a failed push leg instead of swallowing it", async () => {
    // #given a push whose DeviceAgent leg throws. The dashboard still reports
    // success (the row flip did happen), so telemetry is the only signal that
    // the instant kill degraded to the lazy backstop.
    const user = await signedInUser();
    const device = await pairDevice(user.userId);

    // #when
    const events = await captureRevokeEvents(async () => {
      await revokeDeviceForOwner(deviceEnv("throw"), user, device.deviceId);
    });

    // #then exactly one event: the failure, with no cleanup_failed alongside it
    expect(events).toEqual(["device_revoke/push_failed"]);
  });

  it("reports a failed coordinator leg without losing the agent teardown", async () => {
    // #given a push whose coordinator leg throws after the agent leg succeeded
    const user = await signedInUser();
    const device = await pairDevice(user.userId);
    expect((await fetchApp(connectTicketRequest(device.deviceCredential))).status).toBe(200);
    const brokenCoordinator = {
      ...env,
      TENANT_CONTROL: {
        getByName: () => ({
          revokeDevice: () => Promise.reject(new Error("coordinator unreachable")),
        }),
      },
    } as unknown as Env;

    // #when
    const events = await captureRevokeEvents(async () => {
      await revokeDeviceForOwner(brokenCoordinator, user, device.deviceId);
    });

    // #then the cleanup failure is reported alongside the agent outcome, and
    // the durable leg still landed — that is the one that must survive
    expect(events).toEqual([
      "device_revoke/cleanup_failed",
      "device_revoke/revoked_by_owner_offline",
    ]);
    expect((await fetchApp(connectTicketRequest(device.deviceCredential))).status).toBe(401);
  });

  it("disables the device in its own tenant's coordinator", async () => {
    // #given a device registered with its tenant coordinator, so the revoke has
    // real lease/capacity bookkeeping to clean up
    const user = await signedInUser();
    const device = await pairDevice(user.userId);
    const coordinator = env.TENANT_CONTROL.getByName(user.tenantId);
    await coordinator.registerDevice({
      deviceId: device.deviceId,
      browser: "Chrome/150",
      extVersion: "0.1.0",
      browserEpoch: crypto.randomUUID(),
      credentialDigest: await sha256Hex(device.deviceCredential),
      credentialVersion: 1,
      allowedOrigins: ["https://example.com"],
      policyVersion: device.policyVersion,
      authoritySource: "directory",
      acknowledgedPolicyVersion: device.policyVersion,
      capabilities: [...PROTOCOL_CAPABILITIES],
      assignments: [],
      ownedWindows: [],
    });
    expect(await coordinator.listDevices()).toContainEqual(
      expect.objectContaining({ deviceId: device.deviceId, status: "online" }),
    );

    // #when
    expect((await fetchApp(revokePost(user, device.deviceId))).status).toBe(303);

    // #then the coordinator leg reached THIS tenant's coordinator. Asserting on
    // real state, not just the absence of a throw: revokeDevice no-ops silently
    // against a wrong-keyed coordinator, so a swapped tenantId/deviceId would
    // otherwise leave capacity bookkeeping stale and every test still green.
    expect(await coordinator.listDevices()).toContainEqual(
      expect.objectContaining({ deviceId: device.deviceId, status: "disabled" }),
    );
  });

  it("never pushes for a device the caller does not own", async () => {
    // #given user A's device and a signed-in stranger
    const owner = await signedInUser();
    const device = await pairDevice(owner.userId);
    expect((await fetchApp(connectTicketRequest(device.deviceCredential))).status).toBe(200);
    const stranger = await signedInUser();

    // #when the stranger POSTs A's deviceId — attacker-controlled form input
    const res = await fetchApp(revokePost(stranger, device.deviceId));

    // #then no marker is set and A's device keeps working
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/dashboard?notice=device-missing");
    expect((await fetchApp(connectTicketRequest(device.deviceCredential))).status).toBe(200);
  });

  it("blocks a foreign revoke of a device that has never connected", async () => {
    // #given a paired device with no authority row yet. This is the case the
    // DeviceAgent tenant fence deliberately lets through (an owner must be able
    // to pre-arm), so the ownership check in revokeDeviceForOwner is the ONLY
    // thing standing between an attacker-supplied id and a permanent marker.
    // With a connected device the fence masks a regression here; this does not.
    const owner = await signedInUser();
    const device = await pairDevice(owner.userId);
    const stranger = await signedInUser();

    // #when
    const res = await fetchApp(revokePost(stranger, device.deviceId));

    // #then the device is never marked and its FIRST connect still succeeds
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/dashboard?notice=device-missing");
    expect((await fetchApp(connectTicketRequest(device.deviceCredential))).status).toBe(200);
  });
});

describe("retired dashboard vault routes", () => {
  it("fails closed instead of exposing cloud-vault endpoints", async () => {
    const user = await signedInUser();
    expect((await fetchApp(pageGet("/dashboard/vault/pubkey", user.cookie))).status).toBe(404);
    expect((await fetchApp(formPost("/dashboard/vault/put", {
      cookie: user.cookie,
      form: { csrf: user.csrf },
    }))).status).toBe(404);
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

  it("rejects every authorization request that does not carry exact S256 PKCE", async () => {
    const user = await signedInUser();
    const clientId = await registerClient();
    const base = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: "https://client.example/cb",
      scope: "mcp",
      state: "pkce-negative",
    });
    const cases = [
      { code_challenge_method: "S256" },
      { code_challenge: "A".repeat(43) },
      { code_challenge: "A".repeat(43), code_challenge_method: "plain" },
      { code_challenge: "too-short", code_challenge_method: "S256" },
      { code_challenge: `${"A".repeat(42)}+`, code_challenge_method: "S256" },
    ];
    for (const values of cases) {
      const params = new URLSearchParams(base);
      for (const [name, value] of Object.entries(values)) params.set(name, value);
      const response = await fetchApp(
        pageGet(`/oauth/authorize?${params.toString()}`, user.cookie),
      );
      expect(response.status).toBe(400);
      expect(await response.text()).toBe("invalid authorization request");
    }
  });

  it("runs register → consent → code → token → authenticated MCP call", async () => {
    const user = await signedInUser();
    const device = await pairDevice(user.userId);
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
        form: {
          csrf: user.csrf,
          authreq,
          sig,
          decision: "approve",
          deviceId: device.deviceId,
        },
      }),
    );
    expect(approved.status).toBe(302);
    const redirect = new URL(approved.headers.get("Location") ?? "");
    expect(redirect.origin).toBe("https://client.example");
    expect(redirect.searchParams.get("state")).toBe("xyz");
    const code = redirect.searchParams.get("code") ?? "";
    expect(code.length).toBeGreaterThan(0);

    // A wrong verifier fails without consuming the authorization code.
    const wrongVerifier = await fetchApp(
      new Request(`${CANONICAL}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: "https://client.example/cb",
          client_id: clientId,
          code_verifier: `${verifier.slice(0, -1)}${verifier.endsWith("A") ? "B" : "A"}`,
        }),
      }),
    );
    expect(wrongVerifier.status).toBe(400);

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

    const dashboard = await fetchApp(pageGet("/dashboard", user.cookie));
    const dashboardHtml = await dashboard.text();
    expect(dashboardHtml).toContain("Test MCP Client");
    const grantId = /name="grantId" value="([^"]+)"/.exec(dashboardHtml)?.[1] ?? "";
    expect(grantId.length).toBeGreaterThan(0);
    const revoked = await fetchApp(
      formPost("/dashboard/oauth/revoke", {
        cookie: user.cookie,
        form: { csrf: user.csrf, grantId },
      }),
    );
    expect(revoked.status).toBe(303);

    const replay = await fetchApp(
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
    expect(replay.status).toBe(400);

    const afterRevoke = await fetchApp(
      new Request(`${CANONICAL}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${tokens.access_token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "oauth-test", version: "0.0.0" },
          },
        }),
      }),
    );
    expect(afterRevoke.status).toBe(401);
  });

  it("redirects a denial with access_denied and no grant", async () => {
    const user = await signedInUser();
    const device = await pairDevice(user.userId);
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
        form: {
          csrf: user.csrf,
          authreq,
          sig,
          decision: "deny",
          deviceId: device.deviceId,
        },
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
