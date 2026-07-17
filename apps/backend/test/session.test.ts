import { describe, it, expect, vi } from "vitest";
import { env, exports } from "cloudflare:workers";
import { runInDurableObject, evictDurableObject } from "cloudflare:test";
import type { Connection, ConnectionContext } from "agents";
import type { Command } from "@understudy/protocol";
import { mintSessionId } from "../src/auth";
import type { SessionAgent } from "../src/session";
import { EXTENSION_TOKEN_A, EXTENSION_TOKEN_B } from "./tokens";
import { BASE, getSessionStub, getWebSocket } from "./helpers";

/** onMessage only reads `connection.state.authorized` (the onConnect auth gate) - see src/session.ts. */
const FAKE_CONNECTION = { state: { authorized: true } } as unknown as Connection;

/**
 * A mutable stand-in for a Connection at the onConnect/onClose surface.
 * The spies are returned alongside the connection (not only as its
 * properties) so assertions hold direct references; setState mirrors onto
 * .state the way the SDK does, so isAuthorizedConnection() reads what
 * onConnect wrote.
 */
function fakeConnection(initialState: { authorized?: boolean } | null = null): {
  connection: Connection;
  close: ReturnType<typeof vi.fn>;
  setState: ReturnType<typeof vi.fn>;
} {
  const close = vi.fn();
  const holder: { state: { authorized?: boolean } | null } = { state: initialState };
  const setState = vi.fn((next: unknown) => {
    holder.state = next as { authorized?: boolean } | null;
  });
  const connection = Object.assign(holder, { close, setState }) as unknown as Connection;
  return { connection, close, setState };
}

function upgradeContextFor(sessionId: string, token: string): ConnectionContext {
  return {
    request: new Request(`${BASE}/agents/session/${sessionId}?token=${token}`),
  } as ConnectionContext;
}

/**
 * The worker-level gate (index.ts onBeforeConnect) now refuses bad upgrades
 * before the DO accepts anything - service.test.ts covers that layer. These
 * tests drive onConnect DIRECTLY, proving the in-DO gate stands on its own
 * (defense in depth): any path that reached the DO without the router would
 * still be refused.
 */
describe("onConnect token verification (in-DO defense in depth)", () => {
  it("closes the connection with 1008 for a bad extension token", async () => {
    // #given a DO instance and a connection whose upgrade carried an unknown token
    const sessionId = crypto.randomUUID();
    const stub = await getSessionStub(sessionId);
    const { connection, close, setState } = fakeConnection();

    // #when onConnect runs its auth check
    await runInDurableObject(stub, (instance: SessionAgent) =>
      instance.onConnect(connection, upgradeContextFor(sessionId, "not-a-real-token")),
    );

    // #then the socket is closed 1008 and never marked authorized
    expect(close).toHaveBeenCalledWith(1008, "invalid extension token");
    expect(setState).not.toHaveBeenCalled();
  });

  it("binds the session to its tenant and stays connected for a good extension token", async () => {
    // #given a WS upgrade request carrying a valid extension token for the
    // session's own tenant, through the REAL worker route (both gates pass)
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
    const stub = await getSessionStub(sessionId);
    const { connection, close, setState } = fakeConnection();

    // #when a tenantB extension token reaches onConnect directly
    await runInDurableObject(stub, (instance: SessionAgent) =>
      instance.onConnect(connection, upgradeContextFor(sessionId, EXTENSION_TOKEN_B)),
    );

    // #then it is closed 1008 instead of binding a foreign tenant
    expect(close).toHaveBeenCalledWith(1008, "tenant mismatch");
    expect(setState).not.toHaveBeenCalled();
  });
});

describe("onClose status stamping", () => {
  it("a never-authorized socket's close does not stamp a pending session detached", async () => {
    // #given a fresh (pending) session and a connection that never passed auth
    const sessionId = crypto.randomUUID();
    const stub = await getSessionStub(sessionId);
    const { connection: unauthorized } = fakeConnection(null);

    // #when that connection closes (e.g. right after onConnect's 1008)
    await runInDurableObject(stub, async (instance: SessionAgent) => {
      expect(instance.state.status).toBe("pending");
      await instance.onClose(unauthorized, 1008, "invalid extension token", true);
    });

    // #then the session still reads pending - a socket that never
    // contributed to the status cannot change it
    expect((await stub.getStatus()).status).toBe("pending");
  });

  it("an authorized socket's close still detaches when it was the last one", async () => {
    // #given a session an authorized socket connected to (status: connected)
    const sessionId = crypto.randomUUID();
    const stub = await getSessionStub(sessionId);
    const { connection: authorized } = fakeConnection({ authorized: true });

    await runInDurableObject(stub, async (instance: SessionAgent) => {
      instance.setState({ ...instance.state, status: "connected" });

      // #when it closes with no surviving authorized socket
      await instance.onClose(authorized, 1000, "gone", true);
    });

    // #then the session reads detached, as before
    expect((await stub.getStatus()).status).toBe("detached");
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

    // #then dispatch resolves with that event (as an ok outcome) and the marker is cleared
    expect(result).toEqual({ ok: true, event: { type: "tabs_result", commandId: "s1", tabs: [] } });
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
    // #given a dispatched command still awaiting its result, later abandoned
    // by the separate onMessage call below. dispatch() converts the
    // coordinator's abandon-rejection into a resolved outcome in-isolate
    // (types.ts::DispatchOutcome), so nothing here can surface as an
    // unhandled rejection.
    const sessionId = crypto.randomUUID();
    const stub = await getSessionStub(sessionId);
    const cmd: Command = { type: "get_tabs", commandId: "resync-1" };
    let outcome!: ReturnType<SessionAgent["dispatch"]>;

    await runInDurableObject(stub, (instance: SessionAgent) => {
      // Stand in for a live authorized socket (see "resolves a dispatched
      // command's promise" above), or the fail-fast gate refuses before the
      // marker is ever parked and there is nothing for the resync to abandon.
      Object.assign(instance, { hasAuthorizedConnection: () => true });
      outcome = instance.dispatch(cmd);
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

    // #then the in-flight dispatch resolves to the typed abandoned outcome
    await expect(outcome).resolves.toEqual({
      ok: false,
      reason: "resynced",
      message: "session resynced: hello",
    });

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

describe("dialog recording (onMessage → SessionState.dialogs)", () => {
  function dialogEvent(message: string): string {
    return JSON.stringify({
      type: "dialog",
      tabId: 1,
      dialogType: "alert",
      message,
      url: "https://x/",
      disposition: "accept",
    });
  }

  it("caps recent dialogs at 50, evicting oldest-first", async () => {
    // #given a session that handled 51 dialogs
    const sessionId = crypto.randomUUID();
    const stub = await getSessionStub(sessionId);
    await runInDurableObject(stub, async (instance: SessionAgent) => {
      for (let i = 0; i < 51; i++) {
        await instance.onMessage(FAKE_CONNECTION, dialogEvent(`d${i}`));
      }
    });

    // #then only the most recent 50 remain, oldest (d0) evicted, order preserved
    const status = await stub.getStatus();
    expect(status.dialogs).toHaveLength(50);
    expect(status.dialogs[0]?.message).toBe("d1");
    expect(status.dialogs[49]?.message).toBe("d50");
  });

  it("ignores a dialog event from an unauthorized connection", async () => {
    // #given a fresh session and a connection that never passed onConnect's auth
    const sessionId = crypto.randomUUID();
    const stub = await getSessionStub(sessionId);
    const { connection: unauthorized } = fakeConnection(null);

    // #when that connection sends a dialog event
    await runInDurableObject(stub, async (instance: SessionAgent) => {
      await instance.onMessage(unauthorized, dialogEvent("spoofed"));
    });

    // #then nothing is recorded - onMessage's auth gate drops it before the switch
    expect((await stub.getStatus()).dialogs).toEqual([]);
  });
});
