import { describe, it, expect, vi } from "vitest";
import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { safeParseCommand, safeParseEvent } from "@understudy/protocol";
import type { Command } from "@understudy/protocol";
import type { SessionAgent } from "../src/session";
import { CALLER_TOKEN_A, CALLER_TOKEN_B, EXTENSION_TOKEN_A } from "./tokens";
import { BASE, getSessionStub, getWebSocket } from "./helpers";

/**
 * Env.VAULT is deliberately typed read-only (VaultBinding, src/types.ts) so
 * production code can never write through it. The real binding is a KV
 * namespace (wrangler.jsonc), which does support `put` - tests need that to
 * seed fixtures, so this narrow, test-only widening stays local to this file
 * rather than loosening the production-facing type.
 */
function seedVault(secretRef: string, plaintext: string): Promise<void> {
  return (env.VAULT as unknown as { put(key: string, value: string): Promise<void> }).put(
    secretRef,
    plaintext,
  );
}

function authedRequest(path: string, token: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return new Request(`${BASE}${path}`, { ...init, headers });
}

function postCommand(
  sessionId: string,
  token: string,
  command: unknown,
  dryRun?: boolean,
): Promise<Response> {
  return exports.default.fetch(
    authedRequest(`/v1/sessions/${sessionId}/commands`, token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // JSON.stringify drops an undefined dryRun, so this is well-formed
      // whether or not the caller passed one.
      body: JSON.stringify({ command, dryRun }),
    }),
  );
}

async function openSession(callerToken: string): Promise<string> {
  const res = await exports.default.fetch(
    authedRequest("/v1/sessions", callerToken, { method: "POST" }),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { sessionId: string };
  return body.sessionId;
}

/** Opens the fake-extension WS at the real onConnect-authed route (DL-006 critical fact). */
async function connectFakeExtension(sessionId: string, token = EXTENSION_TOKEN_A): Promise<WebSocket> {
  const res = await exports.default.fetch(
    new Request(`${BASE}/agents/session/${sessionId}?token=${token}`, {
      headers: { Upgrade: "websocket" },
    }),
  );
  const socket = getWebSocket(res);
  socket.accept();
  return socket;
}

/**
 * The Agents SDK broadcasts its own framework messages (cf_agent_identity,
 * cf_agent_state, cf_agent_mcp_servers - state sync, sent on connect and on
 * every setState) to every connected WebSocket, interleaved with the
 * commands SessionAgent forwards. Command messages are exactly those that
 * parse as a protocol Command; this is the filter every helper below uses to
 * tell the two apart.
 */
function asCommand(raw: string): Command | undefined {
  const parsed = safeParseCommand(JSON.parse(raw));
  return parsed.success ? parsed.data : undefined;
}

/** Resolves with the next message that is a real dispatched Command, ignoring framework messages. */
function waitForCommand(socket: WebSocket): Promise<Command> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("timed out waiting for a Command message")),
      10_000,
    );
    socket.addEventListener("message", (event: MessageEvent) => {
      const command = asCommand(event.data as string);
      if (!command) return; // an Agents SDK framework message - not ours
      clearTimeout(timeout);
      resolve(command);
    });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("WebSocket error while waiting for a Command message"));
    });
  });
}

/** Collects every real dispatched Command received on `socket` (framework messages excluded). */
function collectCommands(socket: WebSocket): Command[] {
  const commands: Command[] = [];
  socket.addEventListener("message", (event: MessageEvent) => {
    const command = asCommand(event.data as string);
    if (command) commands.push(command);
  });
  return commands;
}

/**
 * Collects every real dispatched Command, and auto-answers each `resolve_ref`
 * the way the real extension does: a pure ref-map lookup - ok:true only for
 * refs in `resolving` - never a snapshot. (A snapshot-answering fake is what
 * masked the original dry-run bug: a real extension re-mints every ref per
 * snapshot, so a probe snapshot can never contain the consumer's ref.)
 */
function answerResolveRefsWith(socket: WebSocket, resolving: string[]): Command[] {
  const commands: Command[] = [];
  socket.addEventListener("message", (event: MessageEvent) => {
    const command = asCommand(event.data as string);
    if (!command) return; // an Agents SDK framework message - not ours
    commands.push(command);
    if (command.type === "resolve_ref") {
      const ok = resolving.includes(command.ref);
      socket.send(
        JSON.stringify({
          type: "action_result",
          commandId: command.commandId,
          ok,
          ...(ok ? {} : { error: `stale or unknown ref: ${command.ref}` }),
        }),
      );
    }
  });
  return commands;
}

describe("GET /health", () => {
  it("returns ok", async () => {
    const res = await exports.default.fetch(new Request(`${BASE}/health`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("auth and tenant scoping", () => {
  it("rejects a commands POST with no Authorization header as 401", async () => {
    // #given an open session
    const sessionId = await openSession(CALLER_TOKEN_A);

    // #when a commands POST carries no Authorization header
    const res = await exports.default.fetch(
      new Request(`${BASE}/v1/sessions/${sessionId}/commands`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: { type: "get_tabs", commandId: "c1" } }),
      }),
    );

    // #then it is refused as unauthenticated
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("refuses a cross-tenant sessionId as 404, not 403, revealing nothing", async () => {
    // #given a session opened by tenantA
    const sessionId = await openSession(CALLER_TOKEN_A);

    // #when tenantB's caller token requests it
    const res = await postCommand(sessionId, CALLER_TOKEN_B, {
      type: "get_tabs",
      commandId: "c1",
    });

    // #then it is a 404 (never 403 - no existence oracle, DL-008) with a generic body
    expect(res.status).toBe(404);
    expect(res.status).not.toBe(403);
    expect(await res.json()).toEqual({ error: "not found" });
  });
});

describe("GET /v1/sessions/:sessionId", () => {
  it("returns the session's status for its own tenant", async () => {
    // #given a session opened by tenantA
    const sessionId = await openSession(CALLER_TOKEN_A);

    // #when tenantA requests its own status
    const res = await exports.default.fetch(
      authedRequest(`/v1/sessions/${sessionId}`, CALLER_TOKEN_A),
    );

    // #then it returns the (not-yet-connected) status
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "pending",
      browser: null,
      tabs: [],
      currentUrl: null,
    });
  });

  it("refuses a cross-tenant status lookup as 404, not 403", async () => {
    // #given a session opened by tenantA
    const sessionId = await openSession(CALLER_TOKEN_A);

    // #when tenantB requests its status
    const res = await exports.default.fetch(
      authedRequest(`/v1/sessions/${sessionId}`, CALLER_TOKEN_B),
    );

    // #then it is a 404 (never 403 - no existence oracle, DL-008)
    expect(res.status).toBe(404);
    expect(res.status).not.toBe(403);
    expect(await res.json()).toEqual({ error: "not found" });
  });
});

describe("command parsing", () => {
  it("rejects a malformed command as 400 without dispatching it", async () => {
    // #given an open session with a connected fake extension
    const sessionId = await openSession(CALLER_TOKEN_A);
    const socket = await connectFakeExtension(sessionId);
    const received = collectCommands(socket);

    try {
      // #when a structurally invalid command is posted
      const res = await postCommand(sessionId, CALLER_TOKEN_A, { type: "nonsense" });

      // #then it is rejected as 400
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid command" });

      // #then nothing was ever dispatched to the extension
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(received).toEqual([]);
    } finally {
      socket.close(1000, "done");
    }
  });
});

describe("command round-trip via a live extension WebSocket", () => {
  it("forwards a snapshot command to the extension and returns its result", async () => {
    // #given an open session with a connected fake extension
    const sessionId = await openSession(CALLER_TOKEN_A);
    const socket = await connectFakeExtension(sessionId);

    try {
      const incoming = waitForCommand(socket);

      // #when a consumer posts a snapshot command
      const commandRes = postCommand(sessionId, CALLER_TOKEN_A, {
        type: "snapshot",
        commandId: "c1",
        mode: "a11y",
      });

      // #then the extension receives the forwarded command
      expect(await incoming).toEqual({ type: "snapshot", commandId: "c1", mode: "a11y" });
      socket.send(JSON.stringify({ type: "snapshot_result", commandId: "c1", tree: [] }));

      // #then the POST resolves with that one schema-valid Event
      const res = await commandRes;
      expect(res.status).toBe(200);
      const event = await res.json();
      expect(safeParseEvent(event).success).toBe(true);
      expect(event).toEqual({ type: "snapshot_result", commandId: "c1", tree: [] });
    } finally {
      socket.close(1000, "done");
    }
  });
});

describe("fill_secret", () => {
  it("resolves the vault secret and types it via the extension without leaking the plaintext", async () => {
    // #given a seeded vault secret and a connected fake extension
    await seedVault("vault://pw", "hunter2");
    const sessionId = await openSession(CALLER_TOKEN_A);
    const socket = await connectFakeExtension(sessionId);

    // Captures every raw WS frame (Command AND Agents-SDK framework
    // messages alike) so the no-leak check below can assert the plaintext
    // appears on the wire exactly once - the one hop where it must travel.
    const rawFrames: string[] = [];
    socket.addEventListener("message", (event: MessageEvent) => rawFrames.push(event.data as string));

    const logSpies = [
      vi.spyOn(console, "log").mockImplementation(() => {}),
      vi.spyOn(console, "error").mockImplementation(() => {}),
      vi.spyOn(console, "warn").mockImplementation(() => {}),
      vi.spyOn(console, "info").mockImplementation(() => {}),
      vi.spyOn(console, "debug").mockImplementation(() => {}),
    ];

    try {
      const incoming = waitForCommand(socket);

      // #when a consumer posts a fill_secret command
      const commandRes = postCommand(sessionId, CALLER_TOKEN_A, {
        type: "fill_secret",
        commandId: "c2",
        ref: "s1e1",
        secretRef: "vault://pw",
        submit: true,
      });

      // #then the extension receives the resolved keystrokes as a `type` command
      // (the one hop where the plaintext must travel) under the SAME commandId
      const received = await incoming;
      expect(received).toEqual({
        type: "type",
        commandId: "c2",
        ref: "s1e1",
        text: "hunter2",
        submit: true,
      });
      socket.send(JSON.stringify({ type: "action_result", commandId: "c2", ok: true }));

      // #then the route resolves ok
      const res = await commandRes;
      const event = await res.json();
      expect(event).toEqual({ type: "action_result", commandId: "c2", ok: true });

      // #then the plaintext appears in none of: the HTTP response, the DO
      // state, any console output, or any WS frame other than the one
      // `type` command above (DL-004)
      expect(JSON.stringify(event)).not.toContain("hunter2");

      const stub = await getSessionStub(sessionId);
      const status = await stub.getStatus();
      expect(JSON.stringify(status)).not.toContain("hunter2");
      await runInDurableObject(stub, (instance: SessionAgent) => {
        expect(JSON.stringify(instance.state)).not.toContain("hunter2");
      });

      for (const spy of logSpies) {
        for (const call of spy.mock.calls) {
          expect(JSON.stringify(call)).not.toContain("hunter2");
        }
      }

      const framesWithPlaintext = rawFrames.filter((frame) => frame.includes("hunter2"));
      expect(framesWithPlaintext).toHaveLength(1);
      // Length just asserted above, so the index access below is safe.
      expect(JSON.parse(framesWithPlaintext[0]!)).toEqual({
        type: "type",
        commandId: "c2",
        ref: "s1e1",
        text: "hunter2",
        submit: true,
      });
    } finally {
      for (const spy of logSpies) spy.mockRestore();
      socket.close(1000, "done");
    }
  });

  it("returns a scrubbed ok:false for a secretRef the vault cannot resolve, dispatching nothing", async () => {
    // #given an open session with a connected fake extension and NO seeded secret
    const sessionId = await openSession(CALLER_TOKEN_A);
    const socket = await connectFakeExtension(sessionId);
    const received = collectCommands(socket);

    try {
      // #when a fill_secret names a secretRef the vault does not have
      const res = await postCommand(sessionId, CALLER_TOKEN_A, {
        type: "fill_secret",
        commandId: "c3",
        ref: "s1e1",
        secretRef: "vault://does-not-exist",
      });

      // #then it resolves ok:false with a scrubbed error (no secret material)
      const event = await res.json();
      expect(event).toEqual({
        type: "action_result",
        commandId: "c3",
        ok: false,
        error: "fill_secret: secret could not be resolved",
      });

      // #then nothing was ever dispatched (no `type` command reached the extension)
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(received).toEqual([]);
    } finally {
      socket.close(1000, "done");
    }
  });
});

describe("dryRun (DL-011: fail-safe, never dispatches a mutation or resolves a secret)", () => {
  it("performs only a read-only ref check for a write command and never dispatches the mutation", async () => {
    // #given a connected fake extension whose live ref map resolves the target ref
    const sessionId = await openSession(CALLER_TOKEN_A);
    const socket = await connectFakeExtension(sessionId);
    const messages = answerResolveRefsWith(socket, ["s1e1"]);

    try {
      // #when a consumer posts a dryRun click
      const res = await postCommand(
        sessionId,
        CALLER_TOKEN_A,
        { type: "click", commandId: "c4", ref: "s1e1" },
        true,
      );

      // #then it returns exactly a schema-valid, simulated ok:true result - no more, no less
      const event = await res.json();
      expect(safeParseEvent(event).success).toBe(true);
      expect(event).toEqual({ type: "action_result", commandId: "c4", ok: true, simulated: true });

      // #then the extension only ever saw the read-only resolve_ref probe (never a
      // snapshot, which would bump the generation and invalidate the consumer's refs),
      // and never the click itself
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(messages).toEqual([
        { type: "resolve_ref", commandId: expect.any(String), ref: "s1e1" },
      ]);
    } finally {
      socket.close(1000, "done");
    }
  });

  it("dryRun fill_secret performs only a ref check, resolving no secret and typing nothing", async () => {
    // #given a seeded vault secret that must remain untouched, and a connected
    // fake extension whose ref map resolves nothing
    await seedVault("vault://dry-pw", "should-not-be-read");
    const sessionId = await openSession(CALLER_TOKEN_A);
    const socket = await connectFakeExtension(sessionId);
    const messages = answerResolveRefsWith(socket, []);
    const vaultGetSpy = vi.spyOn(env.VAULT, "get");

    try {
      // #when a consumer posts a dryRun fill_secret
      const res = await postCommand(
        sessionId,
        CALLER_TOKEN_A,
        { type: "fill_secret", commandId: "c5", ref: "s1e1", secretRef: "vault://dry-pw" },
        true,
      );

      // #then it returns exactly a simulated ok:false result (the ref does not resolve)
      const event = await res.json();
      expect(event).toEqual({
        type: "action_result",
        commandId: "c5",
        ok: false,
        error: "dry-run: ref did not resolve",
        simulated: true,
      });

      // #then the vault was never read for that secretRef, and nothing was ever typed
      expect(vaultGetSpy).not.toHaveBeenCalledWith("vault://dry-pw");
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(messages).toEqual([
        { type: "resolve_ref", commandId: expect.any(String), ref: "s1e1" },
      ]);
    } finally {
      vaultGetSpy.mockRestore();
      socket.close(1000, "done");
    }
  });

  it("dryRun navigate (a write without a ref) simulates ok:true with zero wire traffic", async () => {
    // #given a connected fake extension
    const sessionId = await openSession(CALLER_TOKEN_A);
    const socket = await connectFakeExtension(sessionId);
    const received = collectCommands(socket);

    try {
      // #when a consumer posts a dryRun navigate (commandRef has no ref to probe)
      const res = await postCommand(
        sessionId,
        CALLER_TOKEN_A,
        { type: "navigate", commandId: "c-nav-dry", url: "https://example.com/" },
        true,
      );

      // #then it returns simulated ok:true (nothing to probe; the URL is already
      // schema-checked) - note this does NOT attest session liveness, unlike a
      // ref-bearing dry-run which round-trips to the extension
      const event = await res.json();
      expect(event).toEqual({
        type: "action_result",
        commandId: "c-nav-dry",
        ok: true,
        simulated: true,
      });

      // #then the extension received nothing - no probe, no navigate
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(received).toEqual([]);
    } finally {
      socket.close(1000, "done");
    }
  });

  it("dispatches a READ command for real - only WRITE commands are simulated", async () => {
    // #given a connected fake extension
    const sessionId = await openSession(CALLER_TOKEN_A);
    const socket = await connectFakeExtension(sessionId);

    try {
      const incoming = waitForCommand(socket);

      // #when a consumer posts a dryRun get_tabs (a read - not in isWriteCommand)
      const commandRes = postCommand(
        sessionId,
        CALLER_TOKEN_A,
        { type: "get_tabs", commandId: "c6" },
        true,
      );

      // #then the extension receives the REAL get_tabs command, not a snapshot ref-check
      expect(await incoming).toEqual({ type: "get_tabs", commandId: "c6" });
      socket.send(JSON.stringify({ type: "tabs_result", commandId: "c6", tabs: [] }));

      // #then the route returns the genuine (non-simulated) result
      const res = await commandRes;
      const event = await res.json();
      expect(event).toEqual({ type: "tabs_result", commandId: "c6", tabs: [] });
    } finally {
      socket.close(1000, "done");
    }
  });
});
