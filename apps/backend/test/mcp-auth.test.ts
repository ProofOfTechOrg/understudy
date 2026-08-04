/**
 * MCP auth branches (PR 3): the static usk_ fast path, per-request credential
 * revalidation, and the discovery-grade 401 contract that keeps OAuth clients
 * able to bootstrap. Every test mints fresh users and tokens.
 */

import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/auth";
import { tryStaticMcpAuth } from "../src/mcp/static-auth";
import type { Env } from "../src/types";
import { directory, mintUser, pairDevice } from "./helpers";

const MCP_URL = "https://understudy.proofof.tech/mcp";

async function mintUserToken(): Promise<{
  userId: string;
  tenantId: string;
  deviceId: string;
  token: string;
  tokenId: string;
}> {
  const user = await mintUser();
  const device = await pairDevice(user.userId);
  const created = await directory().createMcpToken(user.userId, device.deviceId, "test");
  if (created === null) throw new Error("token mint failed");
  return {
    userId: user.userId,
    tenantId: user.tenantId,
    deviceId: device.deviceId,
    token: created.token,
    tokenId: created.tokenId,
  };
}

function mcpFetch(headers: Record<string, string>): Promise<Response> {
  return exports.default.fetch(
    new Request(MCP_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...headers,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test-client", version: "0.0.0" },
        },
      }),
    }),
  );
}

function stubCtx(): ExecutionContext {
  return {
    waitUntil() {},
    passThroughOnException() {},
  } as unknown as ExecutionContext;
}

/** Env whose directory binding throws if touched. */
function noDirectoryEnv(): Env {
  return {
    ...env,
    ACCOUNT_DIRECTORY: {
      getByName() {
        throw new Error("directory RPC on a path that must not touch it");
      },
    } as unknown as Env["ACCOUNT_DIRECTORY"],
  };
}

describe("static MCP auth", () => {
  it("admits a valid usk_ token to the MCP endpoint", async () => {
    const minted = await mintUserToken();
    const res = await mcpFetch({ authorization: `Bearer ${minted.token}` });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('"serverInfo"');
    expect(body).toContain("understudy");
  });

  it("refuses a revoked token on the next request", async () => {
    const minted = await mintUserToken();
    // Establish that the token was valid before revocation.
    expect((await mcpFetch({ authorization: `Bearer ${minted.token}` })).status).toBe(200);
    await directory().revokeMcpToken(minted.userId, minted.tokenId);
    const res = await mcpFetch({ authorization: `Bearer ${minted.token}` });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("resource_metadata");
  });

  it("refuses a token immediately after its bound browser is revoked", async () => {
    const minted = await mintUserToken();
    expect((await mcpFetch({ authorization: `Bearer ${minted.token}` })).status).toBe(200);
    expect(await directory().revokeDevice(minted.userId, minted.deviceId)).toBe("revoked");
    expect((await mcpFetch({ authorization: `Bearer ${minted.token}` })).status).toBe(401);
  });

  it("refuses a well-formed token whose secret is wrong", async () => {
    const minted = await mintUserToken();
    const forged = `${minted.token.slice(0, -1)}${minted.token.endsWith("A") ? "B" : "A"}`;
    const res = await mcpFetch({ authorization: `Bearer ${forged}` });
    expect(res.status).toBe(401);
  });

  it("refuses a malformed usk_ token without paying a directory RPC", async () => {
    const res = await tryStaticMcpAuth(
      new Request(MCP_URL, { headers: { authorization: "Bearer usk_bogus" } }),
      noDirectoryEnv(),
      stubCtx(),
    );
    expect(res).not.toBeNull();
    expect(res?.status).toBe(401);
    expect(res?.headers.get("www-authenticate")).toContain("resource_metadata");
  });

  it("returns null (falls through to the provider) for non-usk_ bearers and missing auth", async () => {
    expect(
      await tryStaticMcpAuth(
        new Request(MCP_URL, { headers: { authorization: "Bearer something-else" } }),
        noDirectoryEnv(),
        stubCtx(),
      ),
    ).toBeNull();
    expect(await tryStaticMcpAuth(new Request(MCP_URL), noDirectoryEnv(), stubCtx())).toBeNull();
  });

  it("emits the provider's discovery-grade 401 when no token is presented", async () => {
    const res = await mcpFetch({});
    expect(res.status).toBe(401);
    const challenge = res.headers.get("www-authenticate") ?? "";
    expect(challenge).toContain("Bearer");
    expect(challenge).toContain("resource_metadata");
  });

  it("never stores a verifiable token at rest (digest only)", async () => {
    const minted = await mintUserToken();
    const digest = await sha256Hex(minted.token);
    const identity = await directory().verifyMcpToken(digest);
    expect(identity).toMatchObject({ tenantId: minted.tenantId });
    const listed = await directory().listMcpTokens(minted.userId);
    // The 43-char secret tail must never appear in a listing; a fixed slice
    // avoids the split("_") flakiness (base64url secrets can contain "_").
    expect(JSON.stringify(listed)).not.toContain(minted.token.slice(-24));
  });
});
