/**
 * Deny-by-default /agents/* gate + OAuth path delegation (PR 3 of the MCP
 * surface). The gate's contract: 3-segment session/device paths behave
 * byte-for-byte as before; everything else under /agents/ is a designed 404
 * BEFORE Durable Object resolution — including the paths routeAgentRequest
 * would otherwise auto-expose for every new DO binding.
 */

import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import mainModule from "../src/index";

const CANONICAL = "https://understudy.proofof.tech";

function get(url: string): Promise<Response> {
  return exports.default.fetch(new Request(url));
}

/**
 * The pool's exports wrapper rewrites the request URL onto a loopback host,
 * which the canonical-host redirect deliberately exempts — so host-dependent
 * assertions must call the module fetch directly with the URL intact.
 */
function directGet(url: string): Promise<Response> {
  return mainModule.fetch(
    new Request(url),
    env as never,
    { waitUntil() {}, passThroughOnException() {} } as never,
  );
}

describe("agent path gate", () => {
  it.each([
    ["/agents/mcp-agent/anything"],
    ["/agents/account-directory/directory"],
    ["/agents/account/some-tenant"],
    ["/agents/tenant-control/tenantA"],
    ["/agents/session/some-session/extra"],
    ["/agents/device/some-device/extra"],
    ["/agents/unknown-type/name"],
    ["/agents/session"],
  ])("404s %s before DO resolution", async (path) => {
    const res = await get(`${CANONICAL}${path}`);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("not found");
  });

  it("still 401s a session path without a valid credential (branch unchanged)", async () => {
    const res = await get(`${CANONICAL}/agents/session/${crypto.randomUUID()}?token=nope`);
    expect(res.status).toBe(401);
    expect(await res.text()).toBe("invalid extension token");
  });

  it("still 401s a device path without a ticket (branch unchanged)", async () => {
    // The ticketed accept path itself is pinned end-to-end by the existing
    // WS suites (service.test.ts / device.test.ts), which run unmodified.
    const res = await get(`${CANONICAL}/agents/device/${crypto.randomUUID()}`);
    expect(res.status).toBe(401);
    expect(await res.text()).toBe("invalid device ticket");
  });
});

describe("OAuth path delegation", () => {
  it("redirects delegated paths on a non-canonical host to the canonical one", async () => {
    const res = await directGet("https://understudy.example/mcp");
    expect(res.status).toBe(308);
    expect(res.headers.get("Location")).toBe(`${CANONICAL}/mcp`);
  });

  it("preserves query strings across the canonical redirect", async () => {
    const res = await directGet("https://understudy.example/oauth/authorize?client_id=abc");
    expect(res.status).toBe(308);
    expect(res.headers.get("Location")).toBe(`${CANONICAL}/oauth/authorize?client_id=abc`);
  });

  it("does not redirect loopback hosts (wrangler dev + inspector)", async () => {
    const res = await directGet("http://localhost:8787/mcp");
    expect(res.status).not.toBe(308);
  });

  it("serves the RFC 8414 authorization-server metadata", async () => {
    const res = await get(`${CANONICAL}/.well-known/oauth-authorization-server`);
    expect(res.status).toBe(200);
    const metadata = (await res.json()) as {
      token_endpoint?: string;
      registration_endpoint?: string;
      code_challenge_methods_supported?: string[];
    };
    expect(metadata.token_endpoint).toContain("/oauth/token");
    expect(metadata.registration_endpoint).toContain("/oauth/register");
    // OAuth 2.1 posture: S256 only, no plain PKCE.
    expect(metadata.code_challenge_methods_supported).toEqual(["S256"]);
  });

  it("serves the RFC 9728 protected-resource metadata for /mcp", async () => {
    const res = await get(`${CANONICAL}/.well-known/oauth-protected-resource/mcp`);
    expect(res.status).toBe(200);
    const metadata = (await res.json()) as { resource?: string };
    expect(metadata.resource).toBe(`${CANONICAL}/mcp`);
  });

  it("keeps non-delegated routes on the existing pipeline", async () => {
    const health = await get(`${CANONICAL}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });
    // A dashboard path resolves to the placeholder app, not the /v1 pipeline.
    const dash = await get(`${CANONICAL}/dashboard`);
    expect(dash.status).toBe(404);
  });
});
