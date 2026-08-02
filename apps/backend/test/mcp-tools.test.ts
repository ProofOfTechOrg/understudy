/**
 * MCP tool surface (PR 3): the outcome grammar every tool shares, the
 * server-side ref-staleness guard, and the live tool catalog over a real
 * streamable-HTTP handshake inside the workers pool.
 */

import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Event } from "@understudy/protocol";
import type {
  AccountAgent,
  McpActorRef,
  RunCommandInput,
  RunCommandResult,
} from "../src/account-agent";
import {
  mapCloseResult,
  mapGetResult,
  mapOpenResult,
  mapRunResult,
} from "../src/mcp/outcomes";
import { directory, mintUser, pairDevice } from "./helpers";

const MCP_URL = "https://understudy.proofof.tech/mcp";

async function mintUserToken(): Promise<{ token: string; tenantId: string; userId: string }> {
  const user = await mintUser();
  const device = await pairDevice(user.userId);
  const created = await directory().createMcpToken(user.userId, device.deviceId, null);
  if (created === null) throw new Error("token mint failed");
  return { token: created.token, tenantId: user.tenantId, userId: user.userId };
}

interface JsonRpcResponse {
  id?: number;
  result?: Record<string, unknown>;
  error?: { message: string };
}

async function parseMcp(res: Response): Promise<JsonRpcResponse> {
  const type = res.headers.get("content-type") ?? "";
  const text = await res.text();
  if (type.includes("text/event-stream")) {
    const events = text
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice("data: ".length)) as JsonRpcResponse);
    const last = events.at(-1);
    if (last === undefined) throw new Error(`no SSE data in response: ${text.slice(0, 200)}`);
    return last;
  }
  return JSON.parse(text) as JsonRpcResponse;
}

async function mcpPost(
  token: string,
  body: unknown,
  sessionId?: string,
): Promise<Response> {
  return exports.default.fetch(
    new Request(MCP_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(sessionId === undefined ? {} : { "mcp-session-id": sessionId }),
      },
      body: JSON.stringify(body),
    }),
  );
}

async function mcpHandshake(token: string): Promise<string> {
  const init = await mcpPost(token, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "pool-test", version: "0.0.0" },
    },
  });
  expect(init.status).toBe(200);
  const sessionId = init.headers.get("mcp-session-id");
  if (sessionId === null) throw new Error("no mcp-session-id header");
  const parsed = await parseMcp(init);
  expect((parsed.result as { instructions?: string }).instructions).toContain(
    "current attachment and snapshot generation",
  );
  await mcpPost(
    token,
    { jsonrpc: "2.0", method: "notifications/initialized" },
    sessionId,
  );
  return sessionId;
}

interface ToolCallResult {
  isError?: boolean;
  content: { type: string; text?: string }[];
}

async function callTool(
  token: string,
  sessionId: string,
  id: number,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const res = await mcpPost(
    token,
    { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } },
    sessionId,
  );
  expect(res.status).toBe(200);
  const parsed = await parseMcp(res);
  expect(parsed.error).toBeUndefined();
  return parsed.result as unknown as ToolCallResult;
}

describe("MCP tool catalog over streamable HTTP", () => {
  it("lists exactly the 14 designed tools with the load-bearing instructions", async () => {
    const minted = await mintUserToken();
    const sessionId = await mcpHandshake(minted.token);
    const res = await mcpPost(
      minted.token,
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      sessionId,
    );
    expect(res.status).toBe(200);
    const parsed = await parseMcp(res);
    const tools = (parsed.result as { tools: { name: string }[] }).tools;
    expect(tools).toHaveLength(14);
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "browser_click",
      "browser_close",
      "browser_get_result",
      "browser_list_cards",
      "browser_navigate",
      "browser_open",
      "browser_press_key",
      "browser_screenshot",
      "browser_scroll",
      "browser_snapshot",
      "browser_status",
      "browser_submit_card",
      "browser_type",
      "browser_wait",
    ]);
  });

  it("guides a command tool called before browser_open", async () => {
    const minted = await mintUserToken();
    const sessionId = await mcpHandshake(minted.token);
    const result = await callTool(minted.token, sessionId, 3, "browser_click", {
      ref: "a1:s0e0",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("browser_open");
  });

  it("guides browser_open when its bound browser is offline", async () => {
    const minted = await mintUserToken();
    const sessionId = await mcpHandshake(minted.token);
    const result = await callTool(minted.token, sessionId, 4, "browser_open", {});
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("offline");
    expect(result.content[0]?.text).toContain("open Chrome");
  });

  it("keeps browser_status usable with no session", async () => {
    const minted = await mintUserToken();
    const sessionId = await mcpHandshake(minted.token);
    const status = await callTool(minted.token, sessionId, 5, "browser_status", {});
    expect(status.isError).not.toBe(true);
    expect(status.content[0]?.text).toContain("Session: none");
  });

  it("enforces browser_wait's exactly-iff ms rule in the handler", async () => {
    const minted = await mintUserToken();
    const sessionId = await mcpHandshake(minted.token);
    const missing = await callTool(minted.token, sessionId, 7, "browser_wait", {
      until: "ms",
    });
    expect(missing.isError).toBe(true);
    const extra = await callTool(minted.token, sessionId, 8, "browser_wait", {
      until: "load",
      ms: 100,
    });
    expect(extra.isError).toBe(true);
  });

  it("does not expose retired secret tools", async () => {
    const minted = await mintUserToken();
    const sessionId = await mcpHandshake(minted.token);
    const result = await callTool(minted.token, sessionId, 9, "browser_fill_secret", {});
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).not.toContain("secret names");
  });
});

describe("MCP cross-tenant isolation", () => {
  async function pairedTenant(): Promise<{ tenantId: string; token: string; deviceId: string }> {
    const user = await mintUser();
    const claimed = await pairDevice(user.userId);
    const created = await directory().createMcpToken(user.userId, claimed.deviceId, null);
    if (created === null) throw new Error("token failed");
    return { tenantId: user.tenantId, token: created.token, deviceId: claimed.deviceId };
  }

  it("scopes browser_status to the caller's own tenant — B's device never shows for A", async () => {
    // #given two paired accounts, each with one device and one MCP token
    const a = await pairedTenant();
    const b = await pairedTenant();

    // #when A calls browser_status with A's token
    const sessionId = await mcpHandshake(a.token);
    const status = await callTool(a.token, sessionId, 20, "browser_status", {});

    // #then only A's device id appears; B's is absent
    const text = status.content[0]?.text ?? "";
    expect(text).not.toContain(b.deviceId.slice(0, 8));
    // And A's AccountAgent lists exactly one device (its own), by tenant.
    const devices = await runInDurableObject(
      env.ACCOUNT.getByName(a.tenantId),
      (instance: AccountAgent) => instance.status({ actorId: "usk:a", deviceId: a.deviceId }),
    );
    expect(devices.devices).toHaveLength(1);
    expect(devices.devices[0]?.deviceId).toBe(a.deviceId);
  });
});

describe("AccountAgent device serialization", () => {
  it("serializes one device without blocking another device", async () => {
    const stub = env.ACCOUNT.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: AccountAgent) => {
      const internals = instance as unknown as {
        serialize<T>(actor: McpActorRef, task: () => Promise<T>): Promise<T>;
        deviceTails: Map<string, Promise<void>>;
      };
      const firstActor = {
        actorId: "usk:first",
        deviceId: "00000000-0000-4000-8000-000000000001",
      };
      const secondActor = {
        actorId: "usk:second",
        deviceId: "00000000-0000-4000-8000-000000000002",
      };
      let releaseFirst!: () => void;
      let markFirstStarted!: () => void;
      const firstStarted = new Promise<void>((resolve) => {
        markFirstStarted = resolve;
      });
      const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let queuedOnFirstStarted = false;
      const first = internals.serialize(firstActor, async () => {
        markFirstStarted();
        await firstGate;
        return "first";
      });
      await firstStarted;
      const queuedOnFirst = internals.serialize(firstActor, async () => {
        queuedOnFirstStarted = true;
        return "queued";
      });
      const independent = internals.serialize(secondActor, async () => "independent");

      await expect(independent).resolves.toBe("independent");
      expect(queuedOnFirstStarted).toBe(false);
      releaseFirst();
      await expect(Promise.all([first, queuedOnFirst])).resolves.toEqual([
        "first",
        "queued",
      ]);
      await Promise.resolve();
      expect(internals.deviceTails.size).toBe(0);
    });
  });
});

describe("AccountAgent protocol-2 state migration", () => {
  it("moves the account-wide binding only to its recorded device namespace", async () => {
    const stub = env.ACCOUNT.getByName(`acct-${crypto.randomUUID()}`);
    const actor: McpActorRef = {
      actorId: "usk_v2:actor",
      deviceId: crypto.randomUUID(),
    };
    await runInDurableObject(stub, async (instance: AccountAgent) => {
      const ctx = (instance as unknown as { ctx: DurableObjectState }).ctx;
      const binding = {
        sessionId: "legacy-session",
        profile: "default",
        createKey: crypto.randomUUID(),
        deviceId: actor.deviceId,
        allowedOrigins: ["https://example.com"],
        createdAt: new Date().toISOString(),
      };
      await ctx.storage.put("binding", binding);
      await ctx.storage.put("refsValid", true);
      const internals = instance as unknown as {
        getBinding(subject: McpActorRef): Promise<typeof binding | undefined>;
      };

      await expect(
        internals.getBinding({ ...actor, deviceId: crypto.randomUUID() }),
      ).resolves.toBeUndefined();
      await expect(internals.getBinding(actor)).resolves.toEqual(binding);

      await expect(ctx.storage.get("binding")).resolves.toBeUndefined();
      await expect(ctx.storage.get(`binding:${actor.deviceId}`)).resolves.toEqual(binding);
      await expect(ctx.storage.get(`refsValid:${actor.deviceId}`)).resolves.toBe(true);
    });
  });
});

describe("AccountAgent ref-staleness guard", () => {
  const actor: McpActorRef = {
    actorId: "usk:test",
    deviceId: "00000000-0000-4000-8000-000000000001",
  };

  async function seedBinding(
    stub: DurableObjectStub<AccountAgent>,
    refsValid: boolean,
  ): Promise<void> {
    await runInDurableObject(stub, async (instance: AccountAgent) => {
      const ctx = (instance as unknown as { ctx: DurableObjectState }).ctx;
      await ctx.storage.put(`binding:${actor.deviceId}`, {
        sessionId: "not-a-real-session",
        profile: "default",
        createKey: crypto.randomUUID(),
        deviceId: crypto.randomUUID(),
        allowedOrigins: ["https://example.com"],
        createdAt: new Date().toISOString(),
      });
      await ctx.storage.put(`refsValid:${actor.deviceId}`, refsValid);
    });
  }

  it("short-circuits a ref-based tool while refs are stale — nothing reaches the device", async () => {
    // #given a bound session whose refs are stale, with a sessionId no real
    // session owns (any dispatch attempt would surface terminal_session, so
    // a stale_refs outcome proves the request never left this DO)
    const stub = env.ACCOUNT.getByName(`acct-${crypto.randomUUID()}`);
    await seedBinding(stub, false);

    // #when a click arrives
    const envelope = await stub.runCommand(
      actor,
      {
        tool: "browser_click",
        draft: { type: "click", ref: "a1:s0e0" },
        write: true,
        usesRef: true,
      },
    );

    // #then the guard answers instantly with the recovery instruction
    expect(envelope.outcome).toEqual({ kind: "stale_refs" });
  });

  it("lets non-ref tools through the guard (they fail later, on the fake session)", async () => {
    const stub = env.ACCOUNT.getByName(`acct-${crypto.randomUUID()}`);
    await seedBinding(stub, false);
    const envelope = await stub.runCommand(
      actor,
      {
        tool: "browser_navigate",
        draft: { type: "navigate", url: "https://example.com/" },
        write: true,
        usesRef: false,
      },
    );
    // The fake sessionId cannot pass scopeSession → the session is treated
    // as gone, which also proves the guard did not block the attempt.
    expect(envelope.outcome).toEqual({ kind: "terminal_session" });
  });

  it("flips refsValid on the outcomes that demand observation", async () => {
    const stub = env.ACCOUNT.getByName(`acct-${crypto.randomUUID()}`);
    await seedBinding(stub, true);
    await runInDurableObject(stub, async (instance: AccountAgent) => {
      const internals = instance as unknown as {
        ctx: DurableObjectState;
        applyRefBookkeeping(
          actor: McpActorRef,
          input: RunCommandInput,
          result: RunCommandResult,
        ): Promise<void>;
        applyPolledEventBookkeeping(
          actor: McpActorRef,
          event: Extract<Event, { type: "card_submission_result" }>,
        ): Promise<void>;
      };
      const clickInput: RunCommandInput = {
        tool: "browser_click",
        draft: { type: "click", ref: "a1:s0e0" },
        write: true,
        usesRef: true,
      };

      // OUTCOME UNKNOWN forces refs stale, so the snapshot instruction is
      // enforced rather than requested.
      await internals.applyRefBookkeeping(actor, clickInput, {
        kind: "unknown_outcome",
        commandId: "c1",
      });
      expect(await internals.ctx.storage.get(`refsValid:${actor.deviceId}`)).toBe(false);

      // A successful a11y snapshot restores validity and bumps the epoch.
      await internals.applyRefBookkeeping(
        actor,
        {
          tool: "browser_snapshot",
          draft: { type: "snapshot", mode: "a11y" },
          write: false,
          usesRef: false,
        },
        {
          kind: "terminal",
          event: {
            type: "snapshot_result",
            commandId: "c2",
            tree: [],
            tabId: 1,
            url: "https://example.com/",
          },
        },
      );
      expect(await internals.ctx.storage.get(`refsValid:${actor.deviceId}`)).toBe(true);
      expect(await internals.ctx.storage.get(`refsEpoch:${actor.deviceId}`)).toBe(1);

      // A successful navigation invalidates every ref.
      await internals.applyRefBookkeeping(
        actor,
        {
          tool: "browser_navigate",
          draft: { type: "navigate", url: "https://example.com/next" },
          write: true,
          usesRef: false,
        },
        {
          kind: "terminal",
          event: { type: "action_result", commandId: "c3", ok: true },
        },
      );
      expect(await internals.ctx.storage.get(`refsValid:${actor.deviceId}`)).toBe(false);

      const cardInput: RunCommandInput = {
        tool: "browser_submit_card",
        draft: {
          type: "submit_card",
          cardAlias: "work",
          numberRef: "a1:s0e1",
          expiry: { kind: "combined", ref: "a1:s0e2" },
          cvvRef: "a1:s0e3",
          submitRef: "a1:s0e4",
        },
        write: true,
        usesRef: true,
      };
      const preflightResult = {
        type: "card_submission_result",
        commandId: "c4",
        status: "not_started",
        reason: "stale_ref",
      } as const;
      await internals.applyRefBookkeeping(actor, cardInput, {
        kind: "terminal",
        event: preflightResult,
      });
      expect(await internals.ctx.storage.get(`binding:${actor.deviceId}`)).toBeDefined();
      expect(await internals.ctx.storage.get(`refsValid:${actor.deviceId}`)).toBe(false);

      await internals.applyPolledEventBookkeeping(actor, preflightResult);
      expect(await internals.ctx.storage.get(`binding:${actor.deviceId}`)).toBeDefined();

      // A card result collected after the synchronous poll budget closes the
      // binding just like a result returned by the original tool call.
      await internals.applyPolledEventBookkeeping(actor, {
        type: "card_submission_result",
        commandId: "c5",
        status: "outcome_unknown",
        reason: "submission_attempted",
      });
      expect(await internals.ctx.storage.get(`binding:${actor.deviceId}`)).toBeUndefined();
    });
  });
});

describe("outcome mapping", () => {
  const run = (result: RunCommandResult, tool = "browser_click") =>
    mapRunResult(tool, result, ["https://example.com"]);

  function textOf(result: { content: { type: string; text?: string }[] }, index = 0): string {
    const item = result.content[index];
    if (item === undefined || item.type !== "text" || item.text === undefined) {
      throw new Error(`expected text content at index ${index}`);
    }
    return item.text;
  }

  it("maps every failure kind to its designed guidance", () => {
    expect(run({ kind: "no_session" })).toMatchObject({ isError: true });
    expect(textOf(run({ kind: "no_session" }))).toContain("browser_open");

    expect(textOf(run({ kind: "stale_refs" }))).toContain("browser_snapshot");

    const unknown = run({ kind: "unknown_outcome", commandId: "c" });
    expect(unknown.isError).toBe(true);
    expect(textOf(unknown)).toContain("OUTCOME UNKNOWN");
    expect(textOf(unknown)).toContain("Do NOT retry");

    const pending = run({ kind: "pending_exhausted", commandId: "cmd-123" });
    expect(pending.isError).toBeUndefined();
    expect(textOf(pending)).toContain("cmd-123");
    expect(textOf(pending)).toContain("browser_get_result");
    expect(textOf(pending)).toContain("Do NOT resubmit");

    expect(textOf(run({ kind: "busy_exhausted" }))).toContain("one command runs at a time");
    expect(textOf(run({ kind: "not_connected" }))).toContain("offline");
    expect(textOf(run({ kind: "unsupported" }))).toContain("protocol-3");
    expect(textOf(run({ kind: "terminal_session" }))).toContain("logins are preserved");
    expect(textOf(run({ kind: "id_conflict", commandId: "c" }))).toContain(
      "was not performed",
    );
    expect(textOf(run({ kind: "retries_exhausted", commandId: "c" }))).toContain(
      "did NOT run",
    );
  });

  it("maps device action results — success, stale ref, origin refusal", () => {
    const navigated = run(
      {
        kind: "terminal",
        event: { type: "action_result", commandId: "c", ok: true, url: "https://example.com/a" },
      },
      "browser_navigate",
    );
    expect(navigated.isError).toBeUndefined();
    expect(textOf(navigated)).toContain("refs are now stale");

    const stale = run({
      kind: "terminal",
      event: {
        type: "action_result",
        commandId: "c",
        ok: false,
        error: "stale or unknown ref: a1:s0e0",
      },
    });
    expect(stale.isError).toBe(true);
    expect(textOf(stale)).toContain("browser_snapshot");

    const refused = run(
      {
        kind: "terminal",
        event: {
          type: "action_result",
          commandId: "c",
          ok: false,
          error: "navigation origin is not allowed for this session",
        },
      },
      "browser_navigate",
    );
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain("https://example.com");
    expect(textOf(refused)).toContain("dashboard");
  });

  it("renders snapshots inside untrusted-content delimiters and screenshots as images", () => {
    const snapshot = run(
      {
        kind: "terminal",
        event: {
          type: "snapshot_result",
          commandId: "c",
          tabId: 1,
          url: "https://example.com/",
          tree: [
            {
              ref: "a1:s0e0",
              role: "button",
              name: "Sign in",
              children: [{ ref: "a1:s0e1", role: "text", name: "Sign in" }],
            },
          ],
        },
      },
      "browser_snapshot",
    );
    const text = textOf(snapshot);
    expect(text).toContain("UNTRUSTED PAGE CONTENT");
    expect(text).toContain('button "Sign in" [ref=a1:s0e0]');
    expect(text).toContain("snapshot generation");

    const shot = run(
      {
        kind: "terminal",
        event: {
          type: "screenshot_result",
          commandId: "c",
          mime: "image/png",
          b64: "QUFBQQ==",
          tabId: 1,
          url: "https://example.com/",
        },
      },
      "browser_screenshot",
    );
    expect(shot.content[0]).toMatchObject({ type: "image", mimeType: "image/png" });
    expect(textOf(shot, 1)).toContain("image/png");
  });

  it("maps open/close/get_result helper outcomes", () => {
    expect(textOf(mapOpenResult({ kind: "no_paired_devices" }))).toContain("pairing offer");
    expect(
      textOf(
        mapOpenResult({
          kind: "ready",
          adopted: true,
          profile: "default",
          url: "https://example.com/",
          allowedOrigins: ["https://example.com"],
          recovering: false,
        }),
      ),
    ).toContain("browser_snapshot");
    expect(textOf(mapCloseResult({ kind: "closed" }))).toContain("closed");
    expect(
      textOf(mapGetResult("browser_get_result", { kind: "in_progress", status: "granted" })),
    ).toContain("Do NOT resubmit");
  });
});
