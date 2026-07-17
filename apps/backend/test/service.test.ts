import { describe, it, expect, vi } from "vitest";
import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { safeParseCommand, safeParseEvent } from "@understudy/protocol";
import type { Command } from "@understudy/protocol";
import type { SessionAgent } from "../src/session";
import type { SessionStatus } from "../src/types";
import { encryptSecret } from "../src/vault";
import {
  CALLER_TOKEN_A,
  CALLER_TOKEN_B,
  EXTENSION_TOKEN_A,
  EXTENSION_TOKEN_B,
  TEST_VAULT_MASTER_KEY,
} from "./tokens";
import { BASE, getSessionStub, getWebSocket } from "./helpers";

/**
 * Env.VAULT is deliberately typed read-only (VaultBinding, src/types.ts) so
 * production code can never write through it. The real binding is a KV
 * namespace (wrangler.jsonc), which does support `put` - tests need that to
 * seed fixtures, so this narrow, test-only widening stays local to this file
 * rather than loosening the production-facing type. Values are sealed with
 * the same envelope the production seeder writes (scripts/vault-put.mjs):
 * KV never holds plaintext, in tests either.
 */
async function seedVault(secretRef: string, plaintext: string): Promise<void> {
  return (env.VAULT as unknown as { put(key: string, value: string): Promise<void> }).put(
    secretRef,
    await encryptSecret(TEST_VAULT_MASTER_KEY, plaintext),
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
    await seedVault("vault://tenantA/pw", "hunter2");
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
        secretRef: "vault://tenantA/pw",
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
        secretRef: "vault://tenantA/does-not-exist",
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

  it("fails closed with a scrubbed ok:false when a stored vault value is not a valid envelope", async () => {
    // #given a RAW (non-envelope) value written straight to KV, as a legacy
    // plaintext row or a value sealed under a rotated key would look at rest
    await (env.VAULT as unknown as { put(key: string, value: string): Promise<void> }).put(
      "vault://tenantA/legacy-raw",
      "legacy-plaintext-not-an-envelope",
    );
    const sessionId = await openSession(CALLER_TOKEN_A);
    const socket = await connectFakeExtension(sessionId);
    const received = collectCommands(socket);

    try {
      // #when a consumer fill_secrets that ref
      const res = await postCommand(sessionId, CALLER_TOKEN_A, {
        type: "fill_secret",
        commandId: "c-legacy",
        ref: "s1e1",
        secretRef: "vault://tenantA/legacy-raw",
      });

      // #then EncryptedKvVault refuses to decrypt it -> the DO's catch returns
      // the same scrubbed ok:false as any resolution failure (no envelope
      // material, no key material, no 500), and nothing is typed
      const event = await res.json();
      expect(event).toEqual({
        type: "action_result",
        commandId: "c-legacy",
        ok: false,
        error: "fill_secret: secret could not be resolved",
      });
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
    await seedVault("vault://tenantA/dry-pw", "should-not-be-read");
    const sessionId = await openSession(CALLER_TOKEN_A);
    const socket = await connectFakeExtension(sessionId);
    const messages = answerResolveRefsWith(socket, []);
    const vaultGetSpy = vi.spyOn(env.VAULT, "get");

    try {
      // #when a consumer posts a dryRun fill_secret
      const res = await postCommand(
        sessionId,
        CALLER_TOKEN_A,
        { type: "fill_secret", commandId: "c5", ref: "s1e1", secretRef: "vault://tenantA/dry-pw" },
        true,
      );

      // #then it returns exactly a simulated ok:false result carrying the
      // extension's OWN failure reason, not a collapsed generic string
      const event = await res.json();
      expect(event).toEqual({
        type: "action_result",
        commandId: "c5",
        ok: false,
        error: "dry-run: stale or unknown ref: s1e1",
        simulated: true,
      });

      // #then the vault was never read for that secretRef, and nothing was ever typed
      expect(vaultGetSpy).not.toHaveBeenCalledWith("vault://tenantA/dry-pw");
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

  it("dryRun switch_tab simulates ok:true and never switches the tab (a write, not a read)", async () => {
    // #given a connected fake extension
    const sessionId = await openSession(CALLER_TOKEN_A);
    const socket = await connectFakeExtension(sessionId);
    const received = collectCommands(socket);

    try {
      // #when a consumer dry-runs switch_tab (reclassified as a write in protocol v0.4.0)
      const res = await postCommand(
        sessionId,
        CALLER_TOKEN_A,
        { type: "switch_tab", commandId: "c-swt-dry", tabId: 3 },
        true,
      );

      // #then it simulates ok:true (no ref to probe, zero wire) rather than
      // actually switching the user's tab - the dry-run-safety fix
      const event = await res.json();
      expect(event).toEqual({
        type: "action_result",
        commandId: "c-swt-dry",
        ok: true,
        simulated: true,
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(received).toEqual([]);
    } finally {
      socket.close(1000, "done");
    }
  });

  it("dryRun scroll probes its ref and simulates, never scrolling", async () => {
    // #given a connected fake extension whose ref map resolves the target
    const sessionId = await openSession(CALLER_TOKEN_A);
    const socket = await connectFakeExtension(sessionId);
    const messages = answerResolveRefsWith(socket, ["s1e4"]);

    try {
      // #when a consumer dry-runs a ref-bearing scroll
      const res = await postCommand(
        sessionId,
        CALLER_TOKEN_A,
        { type: "scroll", commandId: "c-scr-dry", ref: "s1e4", dy: 100 },
        true,
      );

      // #then only the read-only probe hits the wire - never the scroll itself
      const event = await res.json();
      expect(event).toEqual({
        type: "action_result",
        commandId: "c-scr-dry",
        ok: true,
        simulated: true,
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(messages).toEqual([
        { type: "resolve_ref", commandId: expect.any(String), ref: "s1e4" },
      ]);
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

  it("surfaces the extension's probe-failure reason on a dryRun write", async () => {
    // #given a connected fake extension whose ref map resolves nothing
    const sessionId = await openSession(CALLER_TOKEN_A);
    const socket = await connectFakeExtension(sessionId);
    answerResolveRefsWith(socket, []);

    try {
      // #when a consumer posts a dryRun click on a stale ref
      const res = await postCommand(
        sessionId,
        CALLER_TOKEN_A,
        { type: "click", commandId: "c-probe-reason", ref: "s1e9" },
        true,
      );

      // #then the simulated failure carries the extension's own reason
      const event = await res.json();
      expect(event).toEqual({
        type: "action_result",
        commandId: "c-probe-reason",
        ok: false,
        error: "dry-run: stale or unknown ref: s1e9",
        simulated: true,
      });
    } finally {
      socket.close(1000, "done");
    }
  });
});

describe("extension liveness fail-fast", () => {
  /** Bounded poll for an async status transition (onClose runs after the socket close). */
  async function waitForStatus(sessionId: string, want: SessionStatus): Promise<void> {
    const stub = await getSessionStub(sessionId);
    for (let i = 0; i < 100; i++) {
      const status = await stub.getStatus();
      if (status.status === want) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`session never reached status '${want}'`);
  }

  it("answers 503 immediately when no extension has ever connected - no timeout burn", async () => {
    // #given a session with no extension attached (status stays "pending")
    const sessionId = await openSession(CALLER_TOKEN_A);

    // #when a consumer posts a command
    const startedAt = Date.now();
    const res = await postCommand(sessionId, CALLER_TOKEN_A, {
      type: "get_tabs",
      commandId: "c-no-ext",
    });

    // #then it fails fast as a retryable 503 (never the old 30s-timeout 500)
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "extension not connected" });
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it("answers 503 after the extension detaches", async () => {
    // #given a session whose extension connected and then dropped
    const sessionId = await openSession(CALLER_TOKEN_A);
    const socket = await connectFakeExtension(sessionId);
    socket.close(1000, "gone");
    await waitForStatus(sessionId, "detached");

    // #when a consumer posts a command
    const res = await postCommand(sessionId, CALLER_TOKEN_A, {
      type: "get_tabs",
      commandId: "c-detached",
    });

    // #then it is refused as a retryable 503, not parked until the timeout
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "extension not connected" });
  });

  it("still simulates a ref-less dryRun write with no extension connected", async () => {
    // #given a session with no extension attached
    const sessionId = await openSession(CALLER_TOKEN_A);

    // #when a consumer posts a dryRun navigate (no ref, so no probe hits the wire)
    const res = await postCommand(
      sessionId,
      CALLER_TOKEN_A,
      { type: "navigate", commandId: "c-dry-no-ext", url: "https://example.com/" },
      true,
    );

    // #then the documented zero-wire semantic is preserved: simulated ok:true,
    // NOT a 503 - a ref-less dry-run was never a liveness signal
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      type: "action_result",
      commandId: "c-dry-no-ext",
      ok: true,
      simulated: true,
    });
  });

  it("fails a ref-bearing dryRun fast when no extension is connected (the probe needs the wire)", async () => {
    // #given a session with no extension attached
    const sessionId = await openSession(CALLER_TOKEN_A);

    // #when a consumer posts a dryRun click (its resolve_ref probe must round-trip)
    const res = await postCommand(
      sessionId,
      CALLER_TOKEN_A,
      { type: "click", commandId: "c-dry-probe-no-ext", ref: "s1e1" },
      true,
    );

    // #then the probe fails fast as 503 rather than burning the timeout
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "extension not connected" });
  });

  it("refuses a real fill_secret on a disconnected session WITHOUT touching the vault", async () => {
    // #given a seeded secret and a session with no extension attached
    await seedVault("vault://tenantA/gated-pw", "must-stay-unread");
    const sessionId = await openSession(CALLER_TOKEN_A);
    const vaultGetSpy = vi.spyOn(env.VAULT, "get");

    try {
      // #when a consumer posts a real (non-dry) fill_secret
      const res = await postCommand(sessionId, CALLER_TOKEN_A, {
        type: "fill_secret",
        commandId: "c-fill-no-ext",
        ref: "s1e1",
        secretRef: "vault://tenantA/gated-pw",
      });

      // #then it is refused as 503 and the secret was NEVER resolved - no
      // plaintext materialized, no vault access emitted, for a command that
      // could not dispatch (DL-004)
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "extension not connected" });
      expect(vaultGetSpy).not.toHaveBeenCalled();
    } finally {
      vaultGetSpy.mockRestore();
    }
  });

  /** One full command round-trip over `socket` (get_tabs in, tabs_result out). */
  async function roundTrip(socket: WebSocket, sessionId: string, commandId: string): Promise<Response> {
    const incoming = waitForCommand(socket);
    const resPromise = postCommand(sessionId, CALLER_TOKEN_A, { type: "get_tabs", commandId });
    const received = await incoming;
    socket.send(JSON.stringify({ type: "tabs_result", commandId: received.commandId, tabs: [] }));
    return resPromise;
  }

  it("recovers through the full lifecycle: pending 503 -> connected ok -> detached 503 -> reconnected ok", async () => {
    // #given a fresh session (pending)
    const sessionId = await openSession(CALLER_TOKEN_A);
    expect((await postCommand(sessionId, CALLER_TOKEN_A, { type: "get_tabs", commandId: "l1" })).status).toBe(503);

    // #when an extension connects
    const first = await connectFakeExtension(sessionId);
    expect((await roundTrip(first, sessionId, "l2")).status).toBe(200);

    // #when it drops
    first.close(1000, "gone");
    await waitForStatus(sessionId, "detached");
    expect((await postCommand(sessionId, CALLER_TOKEN_A, { type: "get_tabs", commandId: "l3" })).status).toBe(503);

    // #when it reconnects
    const second = await connectFakeExtension(sessionId);
    try {
      // #then commands flow again - no wedged 503 after a reconnect
      expect((await roundTrip(second, sessionId, "l4")).status).toBe(200);
    } finally {
      second.close(1000, "done");
    }
  });

  it("stays connected while any authorized socket survives - a replaced socket's close is not a detach", async () => {
    // #given two authorized sockets on one session
    const sessionId = await openSession(CALLER_TOKEN_A);
    const old = await connectFakeExtension(sessionId);
    const replacement = await connectFakeExtension(sessionId);

    try {
      // #when the old socket closes late (after its replacement is live)
      old.close(1000, "replaced");
      await new Promise((resolve) => setTimeout(resolve, 250));

      // #then the session is NOT stamped detached and commands still flow
      const stub = await getSessionStub(sessionId);
      expect((await stub.getStatus()).status).toBe("connected");
      expect((await roundTrip(replacement, sessionId, "l5")).status).toBe(200);
    } finally {
      replacement.close(1000, "done");
    }
  });

  it("detaches once the LAST authorized socket closes, after a replacement briefly coexisted", async () => {
    // #given two authorized sockets, the old one replaced by a newer one
    const sessionId = await openSession(CALLER_TOKEN_A);
    const old = await connectFakeExtension(sessionId);
    const replacement = await connectFakeExtension(sessionId);

    // #when the old one closes first - the replacement keeps the session live
    old.close(1000, "replaced");
    await new Promise((resolve) => setTimeout(resolve, 150));
    const stub = await getSessionStub(sessionId);
    expect((await stub.getStatus()).status).toBe("connected");

    // #when the replacement then also closes - now nothing authorized remains
    replacement.close(1000, "gone");
    await waitForStatus(sessionId, "detached");

    // #then the session finally detaches (the full replaced-then-both-closed order)
    expect((await stub.getStatus()).status).toBe("detached");
  });
});

describe("error taxonomy (route mapping)", () => {
  it("rejects an unparseable JSON body as 400, not a masked 500", async () => {
    // #given an open session
    const sessionId = await openSession(CALLER_TOKEN_A);

    // #when the body is not JSON at all
    const res = await exports.default.fetch(
      authedRequest(`/v1/sessions/${sessionId}/commands`, CALLER_TOKEN_A, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json {",
      }),
    );

    // #then it is the client's fault: 400
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid body" });
  });

  it("maps an in-flight command abandoned by a hello resync to a retryable 503", async () => {
    // #given a connected extension holding a command in flight
    const sessionId = await openSession(CALLER_TOKEN_A);
    const socket = await connectFakeExtension(sessionId);

    try {
      const incoming = waitForCommand(socket);
      const resPromise = postCommand(sessionId, CALLER_TOKEN_A, {
        type: "get_tabs",
        commandId: "c-abandoned",
      });
      await incoming; // the command is now parked in the coordinator

      // #when the extension resyncs (hello) instead of answering
      socket.send(
        JSON.stringify({ type: "hello", browser: "chrome", extVersion: "1.0.0", tabs: [] }),
      );

      // #then the abandoned dispatch surfaces as a retryable 503 with its
      // own honest reason - the extension is alive (it just resynced), so
      // this is infrastructure weather, not the masked 500 it once was
      const res = await resPromise;
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "session resynced mid-command" });
    } finally {
      socket.close(1000, "done");
    }
  });

  it(
    "maps a timed-out command to 504 - the DO-integration proof of the real per-command timeout",
    async () => {
      // #given a connected extension that never answers (real ~30s timeout:
      // fake timers cannot reach into the DO's I/O context - see the note in
      // session.test.ts's dispatch suite)
      const sessionId = await openSession(CALLER_TOKEN_A);
      const socket = await connectFakeExtension(sessionId);

      try {
        // #when a consumer posts a command that will never be answered
        const res = await postCommand(sessionId, CALLER_TOKEN_A, {
          type: "get_tabs",
          commandId: "c-silent",
        });

        // #then the per-command timeout surfaces as 504, not an opaque 500
        expect(res.status).toBe(504);
        expect(await res.json()).toEqual({ error: "command timed out" });

        // #then the awaiting marker was cleared by the REAL DO-level timeout
        // (the fake-timer coordinator test covers this deterministically;
        // this re-asserts it through the integrated path, post-settlement)
        const stub = await getSessionStub(sessionId);
        await runInDurableObject(stub, (instance: SessionAgent) => {
          expect(instance.state.awaitingCommandIds).toEqual([]);
        });
      } finally {
        socket.close(1000, "done");
      }
    },
    40_000,
  );
});

describe("WS upgrade gate (pre-accept, index.ts onBeforeConnect/onBeforeRequest)", () => {
  it("refuses a bad-token upgrade with 401 before the DO ever accepts a socket", async () => {
    // #given a session and an upgrade carrying an unknown extension token
    const sessionId = await openSession(CALLER_TOKEN_A);

    // #when the upgrade hits the worker router
    const res = await exports.default.fetch(
      new Request(`${BASE}/agents/session/${sessionId}?token=not-a-real-token`, {
        headers: { Upgrade: "websocket" },
      }),
    );

    // #then it is rejected at the edge - a plain 401, no accepted-then-closed
    // socket, so an attacker never enters the DO's connection set at all
    expect(res.status).toBe(401);
    expect(res.webSocket ?? null).toBeNull();
  });

  it("refuses a cross-tenant upgrade with 404, not 403 - no existence oracle (DL-008)", async () => {
    // #given a session owned by tenantA and tenantB's valid extension token
    const sessionId = await openSession(CALLER_TOKEN_A);

    // #when tenantB's token attempts the upgrade
    const res = await exports.default.fetch(
      new Request(`${BASE}/agents/session/${sessionId}?token=${EXTENSION_TOKEN_B}`, {
        headers: { Upgrade: "websocket" },
      }),
    );

    // #then it collapses to the same 404 a malformed sessionId gets
    expect(res.status).toBe(404);
    expect(res.webSocket ?? null).toBeNull();
  });

  it("gates non-WebSocket requests on the agent path too (onBeforeRequest)", async () => {
    // #given a plain HTTP request (no Upgrade) to the agent route with no token
    const sessionId = await openSession(CALLER_TOKEN_A);

    // #when it hits the worker router
    const res = await exports.default.fetch(
      new Request(`${BASE}/agents/session/${sessionId}`),
    );

    // #then the SDK's HTTP surface on the DO is unreachable without a token
    expect(res.status).toBe(401);
  });

  it("a rejected upgrade never disturbs the session's status", async () => {
    // #given a fresh (pending) session
    const sessionId = await openSession(CALLER_TOKEN_A);

    // #when a bad-token upgrade is refused
    await exports.default.fetch(
      new Request(`${BASE}/agents/session/${sessionId}?token=nope`, {
        headers: { Upgrade: "websocket" },
      }),
    );

    // #then the session still reads pending - nothing was accepted, nothing
    // closed, nothing stamped
    const stub = await getSessionStub(sessionId);
    expect((await stub.getStatus()).status).toBe("pending");
  });
});

describe("idempotent write replay (stable commandId contract)", () => {
  it("replays a completed write's Event for a retry under the same commandId without re-executing", async () => {
    // #given a connected extension that answered a click once
    const sessionId = await openSession(CALLER_TOKEN_A);
    const socket = await connectFakeExtension(sessionId);
    const received = collectCommands(socket);

    try {
      const incoming = waitForCommand(socket);
      const firstRes = postCommand(sessionId, CALLER_TOKEN_A, {
        type: "click",
        commandId: "ik_case1:step1:click",
        ref: "s1e1",
      });
      await incoming;
      socket.send(
        JSON.stringify({
          type: "action_result",
          commandId: "ik_case1:step1:click",
          ok: true,
          url: "https://portal.example/done",
        }),
      );
      const first = await (await firstRes).json();

      // #when the consumer retries the SAME commandId (its previous response
      // was lost or unparseable - the connector derives the id from the
      // breakwater idempotency key, so a retry reuses it)
      const retryRes = await postCommand(sessionId, CALLER_TOKEN_A, {
        type: "click",
        commandId: "ik_case1:step1:click",
        ref: "s1e1",
      });

      // #then the recorded Event is replayed byte-for-byte and the extension
      // never saw a second click - the write executed exactly once
      expect(retryRes.status).toBe(200);
      expect(await retryRes.json()).toEqual(first);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(received.filter((cmd) => cmd.type === "click")).toHaveLength(1);
    } finally {
      socket.close(1000, "done");
    }
  });

  it("replays a completed write even with no extension connected - a replay needs no liveness", async () => {
    // #given a write completed while an extension was attached, which then dropped
    const sessionId = await openSession(CALLER_TOKEN_A);
    const socket = await connectFakeExtension(sessionId);
    const incoming = waitForCommand(socket);
    const firstRes = postCommand(sessionId, CALLER_TOKEN_A, {
      type: "navigate",
      commandId: "ik_case1:step2:navigate",
      url: "https://example.com/",
    });
    await incoming;
    socket.send(
      JSON.stringify({ type: "action_result", commandId: "ik_case1:step2:navigate", ok: true }),
    );
    const first = await (await firstRes).json();
    socket.close(1000, "gone");

    // #when the consumer retries after the extension detached
    const retryRes = await postCommand(sessionId, CALLER_TOKEN_A, {
      type: "navigate",
      commandId: "ik_case1:step2:navigate",
      url: "https://example.com/",
    });

    // #then the recorded outcome is served instead of a 503 - the work
    // already happened; only NEW work needs the wire
    expect(retryRes.status).toBe(200);
    expect(await retryRes.json()).toEqual(first);
  });

  it("refuses a concurrent duplicate write commandId as 409 while the first is still in flight", async () => {
    // #given a write parked in the coordinator, not yet answered
    const sessionId = await openSession(CALLER_TOKEN_A);
    const socket = await connectFakeExtension(sessionId);

    try {
      const incoming = waitForCommand(socket);
      const firstRes = postCommand(sessionId, CALLER_TOKEN_A, {
        type: "click",
        commandId: "ik_case1:step3:click",
        ref: "s1e1",
      });
      await incoming;

      // #when the same commandId is posted again mid-flight
      const dupRes = await postCommand(sessionId, CALLER_TOKEN_A, {
        type: "click",
        commandId: "ik_case1:step3:click",
        ref: "s1e1",
      });

      // #then the duplicate is refused without disturbing the original...
      expect(dupRes.status).toBe(409);
      expect(await dupRes.json()).toEqual({ error: "command already in flight" });

      // ...which still resolves normally when the extension answers
      socket.send(
        JSON.stringify({ type: "action_result", commandId: "ik_case1:step3:click", ok: true }),
      );
      expect((await firstRes).status).toBe(200);
    } finally {
      socket.close(1000, "done");
    }
  });

  it("a retried fill_secret replays the recorded result without touching the vault again", async () => {
    // #given a fill_secret that completed once
    await seedVault("vault://tenantA/replay-pw", "hunter2-replay");
    const sessionId = await openSession(CALLER_TOKEN_A);
    const socket = await connectFakeExtension(sessionId);

    try {
      const incoming = waitForCommand(socket);
      const firstRes = postCommand(sessionId, CALLER_TOKEN_A, {
        type: "fill_secret",
        commandId: "ik_case1:login:fill",
        ref: "s1e1",
        secretRef: "vault://tenantA/replay-pw",
      });
      await incoming;
      socket.send(
        JSON.stringify({ type: "action_result", commandId: "ik_case1:login:fill", ok: true }),
      );
      const first = await (await firstRes).json();

      // #when the consumer retries the same commandId
      const vaultGetSpy = vi.spyOn(env.VAULT, "get");
      try {
        const retryRes = await postCommand(sessionId, CALLER_TOKEN_A, {
          type: "fill_secret",
          commandId: "ik_case1:login:fill",
          ref: "s1e1",
          secretRef: "vault://tenantA/replay-pw",
        });

        // #then the recorded result is replayed with zero vault access and
        // zero re-typing - no second plaintext materialization (DL-004)
        expect(retryRes.status).toBe(200);
        expect(await retryRes.json()).toEqual(first);
        expect(vaultGetSpy).not.toHaveBeenCalled();
      } finally {
        vaultGetSpy.mockRestore();
      }
    } finally {
      socket.close(1000, "done");
    }
  });

  it("replays a completed write across a hello resync (completedWrites survives the resync)", async () => {
    // #given a write that completed on a connected extension
    const sessionId = await openSession(CALLER_TOKEN_A);
    const socket = await connectFakeExtension(sessionId);

    try {
      const incoming = waitForCommand(socket);
      const firstRes = postCommand(sessionId, CALLER_TOKEN_A, {
        type: "click",
        commandId: "ik_resync:click",
        ref: "s1e1",
      });
      await incoming;
      socket.send(
        JSON.stringify({
          type: "action_result",
          commandId: "ik_resync:click",
          ok: true,
          url: "https://portal.example/after",
        }),
      );
      const first = await (await firstRes).json();

      // #when the extension resyncs (hello bumps generation, abandons in-flight)
      socket.send(
        JSON.stringify({ type: "hello", browser: "chrome", extVersion: "1.0.0", tabs: [] }),
      );
      await new Promise((resolve) => setTimeout(resolve, 50));

      // #then a retry of the same commandId still replays the recorded Event
      // unchanged - completedWrites is untouched by the resync, and replay is
      // keyed by commandId alone (no generation dependence)
      const retryRes = await postCommand(sessionId, CALLER_TOKEN_A, {
        type: "click",
        commandId: "ik_resync:click",
        ref: "s1e1",
      });
      expect(retryRes.status).toBe(200);
      expect(await retryRes.json()).toEqual(first);
    } finally {
      socket.close(1000, "done");
    }
  });

  it("does NOT replay reads - the same get_tabs commandId re-executes freely", async () => {
    // #given a read that completed once
    const sessionId = await openSession(CALLER_TOKEN_A);
    const socket = await connectFakeExtension(sessionId);
    const received = collectCommands(socket);

    try {
      expect((await roundTripGetTabs(socket, sessionId, "read-1")).status).toBe(200);

      // #when the same read commandId is posted again
      // #then it round-trips to the extension again - reads are free to
      // re-execute; only writes carry the exactly-once contract
      expect((await roundTripGetTabs(socket, sessionId, "read-1")).status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(received.filter((cmd) => cmd.type === "get_tabs")).toHaveLength(2);
    } finally {
      socket.close(1000, "done");
    }
  });

  /** One full get_tabs round-trip (duplicated from the liveness suite's roundTrip, which is scoped there). */
  async function roundTripGetTabs(
    socket: WebSocket,
    sessionId: string,
    commandId: string,
  ): Promise<Response> {
    const incoming = waitForCommand(socket);
    const resPromise = postCommand(sessionId, CALLER_TOKEN_A, { type: "get_tabs", commandId });
    const received = await incoming;
    socket.send(JSON.stringify({ type: "tabs_result", commandId: received.commandId, tabs: [] }));
    return resPromise;
  }
});

describe("two-tenant vault isolation (cross-tenant secretRef scoping, server-side)", () => {
  // The command, status, and WS-upgrade isolation axes are already proven
  // above ("refuses a cross-tenant sessionId as 404", the cross-tenant status
  // 404, and the WS-gate "cross-tenant upgrade with 404"). This block covers
  // the remaining axis: understudy owns ONE shared vault across tenants, so it -
  // not a consumer's breakwater - must refuse tenantB resolving tenantA's
  // secretRef, even from a session and extension that are legitimately tenantB's.

  it("refuses a cross-tenant secretRef: no vault read, no plaintext on the wire", async () => {
    // #given tenantA's secret seeded, and tenantB driving its OWN session with
    // its OWN connected extension - every step legitimate except the ref
    await seedVault("vault://tenantA/okta-pw", "tenantA-super-secret");
    const sessionId = await openSession(CALLER_TOKEN_B);
    const socket = await connectFakeExtension(sessionId, EXTENSION_TOKEN_B);
    const received = collectCommands(socket);
    const rawFrames: string[] = [];
    socket.addEventListener("message", (event: MessageEvent) => rawFrames.push(event.data as string));
    const vaultGetSpy = vi.spyOn(env.VAULT, "get");

    try {
      // #when tenantB fill_secrets tenantA's ref into a field on its own tab
      const res = await postCommand(sessionId, CALLER_TOKEN_B, {
        type: "fill_secret",
        commandId: "x-tenant",
        ref: "s1e1",
        secretRef: "vault://tenantA/okta-pw",
      });

      // #then it collapses to the SAME scrubbed ok:false an absent secret gets -
      // tenantB cannot tell "not yours" from "does not exist" (DL-008)
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        type: "action_result",
        commandId: "x-tenant",
        ok: false,
        error: "fill_secret: secret could not be resolved",
      });

      // #then the vault was NEVER read - the tenant guard fires before
      // resolution, so tenantA's plaintext never materializes (DL-004)
      expect(vaultGetSpy).not.toHaveBeenCalled();

      // #then nothing was ever dispatched to tenantB's extension: no `type`
      // command carrying tenantA's secret reached the wire
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(received).toEqual([]);
      expect(rawFrames.some((frame) => frame.includes("tenantA-super-secret"))).toBe(false);
    } finally {
      vaultGetSpy.mockRestore();
      socket.close(1000, "done");
    }
  });

  it("still resolves a session's OWN-tenant secretRef - the guard scopes, it does not block", async () => {
    // #given tenantB's own secret seeded and tenantB's session + extension
    await seedVault("vault://tenantB/okta-pw", "tenantB-own-secret");
    const sessionId = await openSession(CALLER_TOKEN_B);
    const socket = await connectFakeExtension(sessionId, EXTENSION_TOKEN_B);

    try {
      const incoming = waitForCommand(socket);

      // #when tenantB fill_secrets its OWN ref
      const commandRes = postCommand(sessionId, CALLER_TOKEN_B, {
        type: "fill_secret",
        commandId: "own-tenant",
        ref: "s1e1",
        secretRef: "vault://tenantB/okta-pw",
        submit: true,
      });

      // #then the resolved secret is typed via tenantB's extension under the
      // same commandId - own-tenant resolution is unaffected by the guard
      expect(await incoming).toEqual({
        type: "type",
        commandId: "own-tenant",
        ref: "s1e1",
        text: "tenantB-own-secret",
        submit: true,
      });
      socket.send(JSON.stringify({ type: "action_result", commandId: "own-tenant", ok: true }));

      const res = await commandRes;
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ type: "action_result", commandId: "own-tenant", ok: true });
    } finally {
      socket.close(1000, "done");
    }
  });

  it("refuses an unscoped (tenant-less) secretRef even for the owning tenant - scoping is mandatory", async () => {
    // #given a bare, tenant-less ref seeded (the sloppy vault://<name> shape
    // the fix outlaws), referenced by its own tenant
    await seedVault("vault://legacy-unscoped", "would-have-leaked");
    const sessionId = await openSession(CALLER_TOKEN_A);
    const socket = await connectFakeExtension(sessionId, EXTENSION_TOKEN_A);
    const received = collectCommands(socket);
    const vaultGetSpy = vi.spyOn(env.VAULT, "get");

    try {
      // #when the owning tenant references it WITHOUT the vault://<tenant>/ prefix
      const res = await postCommand(sessionId, CALLER_TOKEN_A, {
        type: "fill_secret",
        commandId: "unscoped",
        ref: "s1e1",
        secretRef: "vault://legacy-unscoped",
      });

      // #then it is refused (scrubbed) with no vault read and nothing typed:
      // tenant scoping is enforced, not merely conventional
      expect(await res.json()).toEqual({
        type: "action_result",
        commandId: "unscoped",
        ok: false,
        error: "fill_secret: secret could not be resolved",
      });
      expect(vaultGetSpy).not.toHaveBeenCalled();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(received).toEqual([]);
    } finally {
      vaultGetSpy.mockRestore();
      socket.close(1000, "done");
    }
  });

  it("refuses a cross-tenant secretRef before replay - a reused commandId cannot serve a cached own-tenant result", async () => {
    // #given tenantB completed a legitimate OWN-tenant fill under a commandId
    // (caching an ok:true write result), and tenantA's secret is also seeded
    await seedVault("vault://tenantB/own-pw", "tenantB-own");
    await seedVault("vault://tenantA/okta-pw", "tenantA-super-secret");
    const sessionId = await openSession(CALLER_TOKEN_B);
    const socket = await connectFakeExtension(sessionId, EXTENSION_TOKEN_B);

    try {
      const incoming = waitForCommand(socket);
      const firstRes = postCommand(sessionId, CALLER_TOKEN_B, {
        type: "fill_secret",
        commandId: "ik_shared:fill",
        ref: "s1e1",
        secretRef: "vault://tenantB/own-pw",
      });
      await incoming;
      socket.send(JSON.stringify({ type: "action_result", commandId: "ik_shared:fill", ok: true }));
      expect(await (await firstRes).json()).toEqual({
        type: "action_result",
        commandId: "ik_shared:fill",
        ok: true,
      });

      // #when the SAME commandId is retried with tenantA's cross-tenant ref
      const vaultGetSpy = vi.spyOn(env.VAULT, "get");
      try {
        const res = await postCommand(sessionId, CALLER_TOKEN_B, {
          type: "fill_secret",
          commandId: "ik_shared:fill",
          ref: "s1e1",
          secretRef: "vault://tenantA/okta-pw",
        });

        // #then the guard (which runs BEFORE replay) refuses it: the cached
        // ok:true is NOT served, and tenantA's vault is never read
        expect(await res.json()).toEqual({
          type: "action_result",
          commandId: "ik_shared:fill",
          ok: false,
          error: "fill_secret: secret could not be resolved",
        });
        expect(vaultGetSpy).not.toHaveBeenCalled();
      } finally {
        vaultGetSpy.mockRestore();
      }
    } finally {
      socket.close(1000, "done");
    }
  });

  it("refuses confusable/edge-shape refs before any vault read - the trailing slash makes the prefix exact", async () => {
    // #given a tenantA session + extension (own tenant is "tenantA")
    const sessionId = await openSession(CALLER_TOKEN_A);
    const socket = await connectFakeExtension(sessionId, EXTENSION_TOKEN_A);
    const received = collectCommands(socket);
    const vaultGetSpy = vi.spyOn(env.VAULT, "get");

    try {
      // #when refs that look tenant-adjacent but escape the `vault://tenantA/`
      // prefix are posted: no trailing slash, and a longer confusable tenant
      for (const secretRef of ["vault://tenantA", "vault://tenantAB/pw"]) {
        const res = await postCommand(sessionId, CALLER_TOKEN_A, {
          type: "fill_secret",
          commandId: `edge-${secretRef}`,
          ref: "s1e1",
          secretRef,
        });

        // #then each is refused (scrubbed) and never reaches the vault
        expect(await res.json()).toEqual({
          type: "action_result",
          commandId: `edge-${secretRef}`,
          ok: false,
          error: "fill_secret: secret could not be resolved",
        });
      }

      expect(vaultGetSpy).not.toHaveBeenCalled();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(received).toEqual([]);
    } finally {
      vaultGetSpy.mockRestore();
      socket.close(1000, "done");
    }
  });

  it("refuses a cross-tenant secretRef even with NO extension connected - the guard precedes the liveness gate", async () => {
    // #given tenantB's session with NO extension attached (would 503 at the gate)
    await seedVault("vault://tenantA/okta-pw", "tenantA-super-secret");
    const sessionId = await openSession(CALLER_TOKEN_B);
    const vaultGetSpy = vi.spyOn(env.VAULT, "get");

    try {
      // #when tenantB posts a cross-tenant fill on the disconnected session
      const res = await postCommand(sessionId, CALLER_TOKEN_B, {
        type: "fill_secret",
        commandId: "x-tenant-no-ext",
        ref: "s1e1",
        secretRef: "vault://tenantA/okta-pw",
      });

      // #then the tenant guard answers first: a scrubbed 200 ok:false, NOT the
      // 503 the connection gate would give - and no vault read. The refusal is
      // a pure function of (own tenant, ref), independent of liveness, so the
      // 200-vs-503 status leaks no cross-tenant existence signal.
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        type: "action_result",
        commandId: "x-tenant-no-ext",
        ok: false,
        error: "fill_secret: secret could not be resolved",
      });
      expect(vaultGetSpy).not.toHaveBeenCalled();
    } finally {
      vaultGetSpy.mockRestore();
    }
  });

  it("dryRun previews the cross-tenant refusal - simulated ok:false, no probe, no vault read", async () => {
    // #given tenantB's session + extension, with tenantA's secret seeded
    await seedVault("vault://tenantA/okta-pw", "tenantA-super-secret");
    const sessionId = await openSession(CALLER_TOKEN_B);
    const socket = await connectFakeExtension(sessionId, EXTENSION_TOKEN_B);
    const received = collectCommands(socket);
    const vaultGetSpy = vi.spyOn(env.VAULT, "get");

    try {
      // #when tenantB DRY-RUNs a cross-tenant fill_secret (governance preview)
      const res = await postCommand(
        sessionId,
        CALLER_TOKEN_B,
        { type: "fill_secret", commandId: "x-dry", ref: "s1e1", secretRef: "vault://tenantA/okta-pw" },
        true,
      );

      // #then the simulation honestly previews the refusal the real call would
      // give (simulated ok:false), sends NO resolve_ref probe to the extension,
      // and never reads the vault - dryRun and real agree on the tenant axis
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        type: "action_result",
        commandId: "x-dry",
        ok: false,
        error: "dry-run: secret could not be resolved",
        simulated: true,
      });
      expect(vaultGetSpy).not.toHaveBeenCalled();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(received).toEqual([]);
    } finally {
      vaultGetSpy.mockRestore();
      socket.close(1000, "done");
    }
  });
});
