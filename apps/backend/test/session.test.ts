import { describe, it, expect } from "vitest";
import { env, exports } from "cloudflare:workers";
import { runInDurableObject, evictDurableObject } from "cloudflare:test";
import type { Connection } from "agents";
import type { Command } from "@understudy/protocol";
import { mintSessionId } from "../src/auth";
import type { SessionAgent } from "../src/session";
import { EXTENSION_TOKEN_A, EXTENSION_TOKEN_B } from "./tokens";
import { BASE, getSessionStub, getWebSocket } from "./helpers";

function waitForClose(socket: WebSocket): Promise<{ code: number }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("timed out waiting for a WebSocket close")),
      10_000,
    );
    socket.addEventListener("close", (event) => {
      clearTimeout(timeout);
      resolve(event as unknown as { code: number });
    });
  });
}

/** onMessage only reads `connection.state.authorized` (the onConnect auth gate) - see src/session.ts. */
const FAKE_CONNECTION = { state: { authorized: true } } as unknown as Connection;

describe("onConnect token verification", () => {
  it("closes the connection with 1008 for a bad extension token", async () => {
    // #given a WS upgrade request carrying an unknown token
    const sessionId = crypto.randomUUID();
    const res = await exports.default.fetch(
      new Request(`${BASE}/agents/session/${sessionId}?token=not-a-real-token`, {
        headers: { Upgrade: "websocket" },
      }),
    );
    const socket = getWebSocket(res);
    const closed = waitForClose(socket);

    // #when the client accepts the upgrade
    socket.accept();

    // #then the server closes it with 1008
    const event = await closed;
    expect(event.code).toBe(1008);
  });

  it("binds the session to its tenant and stays connected for a good extension token", async () => {
    // #given a WS upgrade request carrying a valid extension token for the session's own tenant
    const sessionId = await mintSessionId("tenantA", env);
    const res = await exports.default.fetch(
      new Request(`${BASE}/agents/session/${sessionId}?token=${EXTENSION_TOKEN_A}`, {
        headers: { Upgrade: "websocket" },
      }),
    );
    const socket = getWebSocket(res);

    try {
      // #when the client accepts the upgrade
      socket.accept();

      // #then the session reports connected
      const stub = await getSessionStub(sessionId);
      const status = await stub.getStatus();
      expect(status.status).toBe("connected");
    } finally {
      socket.close(1000, "done");
    }
  });

  it("closes the connection with 1008 for a cross-tenant extension token", async () => {
    // #given a session owned by tenantA (its sessionId HMAC-embeds tenantA)
    const sessionId = await mintSessionId("tenantA", env);
    const res = await exports.default.fetch(
      new Request(`${BASE}/agents/session/${sessionId}?token=${EXTENSION_TOKEN_B}`, {
        headers: { Upgrade: "websocket" },
      }),
    );
    const socket = getWebSocket(res);
    const closed = waitForClose(socket);

    // #when a tenantB extension token attempts to attach to tenantA's session
    socket.accept();

    // #then the server closes it with 1008 instead of binding a foreign tenant
    const event = await closed;
    expect(event.code).toBe(1008);
  });
});

describe("dispatch / resolvePending", () => {
  it("resolves a dispatched command's promise with the matching result event", async () => {
    // #given a command sent via dispatch, and its matching result delivered
    // via onMessage - both driven from a SINGLE runInDurableObject callback
    // against the SAME live `instance`, rather than a stub.dispatch() RPC
    // call paired with a separate runInDurableObject call: mixing those two
    // access paths to the same Durable Object was found to race (the RPC
    // call's in-memory pending-map entry and a later runInDurableObject
    // call are not guaranteed to observe the same live instance), and
    // reproduced as an intermittent 30s timeout - verified empirically.
    const sessionId = crypto.randomUUID();
    const stub = await getSessionStub(sessionId);
    const cmd: Command = { type: "get_tabs", commandId: "s1" };

    const result = await runInDurableObject(stub, async (instance: SessionAgent) => {
      // Stand in for a live authorized extension socket: the coordinator's
      // fail-fast gate consults the DO's connection set, which
      // runInDurableObject cannot populate; the service-level suite covers
      // the real predicate. This test is about correlation.
      Object.assign(instance, { hasAuthorizedConnection: () => true });
      const dispatchPromise = instance.dispatch(cmd);
      // The marker is parked synchronously before dispatch() suspends.
      expect(instance.state.awaitingCommandIds).toContain("s1");

      // #when the matching result event arrives from the extension
      await instance.onMessage(
        FAKE_CONNECTION,
        JSON.stringify({ type: "tabs_result", commandId: "s1", tabs: [] }),
      );
      return dispatchPromise;
    });

    // #then dispatch resolves with that event and the marker is cleared
    expect(result).toEqual({ type: "tabs_result", commandId: "s1", tabs: [] });
    await runInDurableObject(stub, (instance: SessionAgent) => {
      expect(instance.state.awaitingCommandIds).toEqual([]);
    });
  });

  // The real ~30s timeout's DO-integration proof lives in service.test.ts
  // ("maps a timed-out command to 504"), which drives it through the full
  // route -> RPC -> DO -> coordinator path against a connected-but-silent
  // extension; coordinator.test.ts covers the timeout/marker-clearing
  // machinery deterministically with fake timers.
});

describe("DO eviction resilience (DL-007)", () => {
  it("persists the awaiting marker through a real eviction and reconciles a late result without deadlock", async () => {
    // #given a session with an outstanding command's marker persisted.
    // dispatch() parking this SAME marker via the real coordinator is
    // already covered by "resolves a dispatched command's promise" above;
    // this test isolates the eviction-survival + reconciliation claim,
    // seeding the marker directly via setState rather than also carrying a
    // live dispatch()'s real ~30s pending timer through evictDurableObject
    // (which then appears to block on it - verified empirically).
    const sessionId = crypto.randomUUID();
    const stub = await getSessionStub(sessionId);
    await runInDurableObject(stub, (instance: SessionAgent) => {
      instance.setState({ ...instance.state, awaitingCommandIds: ["hib-1"] });
    });
    await runInDurableObject(stub, (instance: SessionAgent) => {
      expect(instance.state.awaitingCommandIds).toEqual(["hib-1"]);
    });

    // #when the Durable Object is evicted (discarding in-memory state; only
    // persisted state - the awaiting marker - survives)
    await evictDurableObject(stub);

    // #then the marker survived the eviction
    await runInDurableObject(stub, (instance: SessionAgent) => {
      expect(instance.state.awaitingCommandIds).toEqual(["hib-1"]);
    });

    // #when a late/orphaned result for that commandId reaches the woken instance
    await runInDurableObject(stub, async (instance: SessionAgent) => {
      await expect(
        instance.onMessage(
          FAKE_CONNECTION,
          JSON.stringify({ type: "action_result", commandId: "hib-1", ok: true }),
        ),
      ).resolves.toBeUndefined();
    });

    // #then it is reconciled (marker cleared) rather than mis-resolving or throwing
    await runInDurableObject(stub, (instance: SessionAgent) => {
      expect(instance.state.awaitingCommandIds).toEqual([]);
    });
  });
});

describe("hello resync", () => {
  it("bumps generation, records browser/tabs, sets connected, and abandons in-flight commands", async () => {
    // #given a dispatched command still awaiting its result, later
    // abandoned (rejected asynchronously, from the separate onMessage call
    // below). A rejection handler is attached in the SAME synchronous tick
    // as the dispatch() call (converting it into an always-resolving
    // outcome captured in this closure) rather than awaited later:
    // attaching `.rejects` only once the promise is retrieved later leaves
    // a window where nothing has claimed the rejection yet, which surfaces
    // as an unhandled rejection - and fails the process exit code - even
    // though this test's own assertion on it passes (verified empirically).
    const sessionId = crypto.randomUUID();
    const stub = await getSessionStub(sessionId);
    const cmd: Command = { type: "get_tabs", commandId: "resync-1" };
    let outcome!: Promise<{ settled: "resolved" | "rejected"; value: unknown }>;

    await runInDurableObject(stub, (instance: SessionAgent) => {
      // Stand in for a live authorized socket (see "resolves a dispatched
      // command's promise" above), or the fail-fast gate rejects before the
      // marker is ever parked and there is nothing for the resync to abandon.
      Object.assign(instance, { hasAuthorizedConnection: () => true });
      outcome = instance.dispatch(cmd).then(
        (value) => ({ settled: "resolved", value }) as const,
        (error: unknown) => ({ settled: "rejected", value: error }) as const,
      );
      expect(instance.state.awaitingCommandIds).toContain("resync-1");
    });

    // #when a fresh `hello` arrives (the extension resynced)
    await runInDurableObject(stub, (instance: SessionAgent) =>
      instance.onMessage(
        FAKE_CONNECTION,
        JSON.stringify({
          type: "hello",
          browser: "chrome",
          extVersion: "1.0.0",
          tabs: [{ tabId: 1, url: "https://example.com", title: "Example", active: true }],
        }),
      ),
    );

    // #then the in-flight dispatch is abandoned (rejected)
    const result = await outcome;
    expect(result.settled).toBe("rejected");
    expect(result.value).toBeInstanceOf(Error);

    // #then the session state reflects the resync
    await runInDurableObject(stub, (instance: SessionAgent) => {
      expect(instance.state.status).toBe("connected");
      expect(instance.state.generation).toBe(1);
      expect(instance.state.browser).toEqual({ browser: "chrome", extVersion: "1.0.0" });
      expect(instance.state.tabs).toEqual([
        { tabId: 1, url: "https://example.com", title: "Example", active: true },
      ]);
      expect(instance.state.awaitingCommandIds).toEqual([]);
    });
  });
});
