import { describe, it, expect, vi } from "vitest";
import { env, exports } from "cloudflare:workers";
import { runInDurableObject, evictDurableObject } from "cloudflare:test";
import type { Connection, ConnectionContext } from "agents";
import type { Command } from "@understudy/protocol";
import { mintSessionId } from "../src/auth";
import type { SessionAgent } from "../src/session";
import type { SessionState } from "../src/types";
import { EXTENSION_TOKEN_A, EXTENSION_TOKEN_B } from "./tokens";
import { BASE, getSessionStub, getWebSocket } from "./helpers";

const FAKE_CONNECTION = {
  id: "fake-authoritative",
  state: { authorized: true },
  send: () => {},
} as unknown as Connection;

/**
 * A mutable stand-in for a Connection at the onConnect/onClose surface.
 * The spies are returned alongside the connection (not only as its
 * properties) so assertions hold direct references; setState mirrors onto
 * .state the way the SDK does, so isAuthorizedConnection() reads what
 * onConnect wrote.
 */
function fakeConnection(
  initialState: { authorized?: boolean } | null = null,
  id = crypto.randomUUID(),
): {
  connection: Connection;
  close: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  setState: ReturnType<typeof vi.fn>;
} {
  const close = vi.fn();
  const send = vi.fn();
  const holder: { id: string; state: { authorized?: boolean } | null } = {
    id,
    state: initialState,
  };
  const setState = vi.fn((next: unknown) => {
    holder.state = next as { authorized?: boolean } | null;
  });
  const connection = Object.assign(holder, { close, send, setState }) as unknown as Connection;
  return { connection, close, send, setState };
}

function upgradeContextFor(sessionId: string, token: string): ConnectionContext {
  return {
    request: new Request(`${BASE}/agents/session/${sessionId}?token=${token}`),
  } as ConnectionContext;
}

function setAuthoritative(
  instance: SessionAgent,
  connection: Connection = FAKE_CONNECTION,
): void {
  instance.setState({
    ...instance.state,
    activeConnectionId: connection.id,
    status: "connected",
  });
}

function withoutActiveConnectionId(state: SessionState): SessionState {
  const legacy = { ...state } as Partial<SessionState>;
  delete legacy.activeConnectionId;
  return legacy as SessionState;
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

  it("makes the newest authenticated socket authoritative even when closing its predecessor throws", async () => {
    // #given an existing authorized socket and a newer socket that has
    // completed the token/tenant checks
    const sessionId = crypto.randomUUID();
    const stub = await getSessionStub(sessionId);
    const previous = fakeConnection({ authorized: true }, "previous");
    const replacement = fakeConnection(null, "replacement");
    previous.close.mockImplementationOnce(() => {
      throw new Error("already closed");
    });

    await runInDurableObject(stub, async (instance: SessionAgent) => {
      Object.assign(instance, {
        getConnections: () => [previous.connection, replacement.connection],
      });

      // #when onConnect's post-auth step promotes the replacement
      (
        instance as unknown as {
          makeConnectionAuthoritative(connection: Connection): void;
        }
      ).makeConnectionAuthoritative(replacement.connection);

      // #then one persisted state write makes it authoritative before the
      // prior socket is demoted and closed
      expect(instance.state.activeConnectionId).toBe("replacement");
      expect(instance.state.status).toBe("connected");
      expect(replacement.setState).toHaveBeenCalledWith({ authorized: true });
      expect(previous.connection.state).toEqual({ authorized: false });
      expect(previous.close).toHaveBeenCalledWith(
        4001,
        "replaced by newer extension connection",
      );

      // #then a late close callback from the replaced socket cannot detach
      // or clear the replacement
      await instance.onClose(previous.connection, 4001, "replaced", true);
      expect(instance.state.activeConnectionId).toBe("replacement");
      expect(instance.state.status).toBe("connected");
    });
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

  it("migrates a legacy single authorized socket to activeConnectionId on first use", async () => {
    // #given persisted pre-migration state with exactly one authorized socket
    const sessionId = crypto.randomUUID();
    const stub = await getSessionStub(sessionId);
    const legacy = fakeConnection({ authorized: true }, "legacy-only");

    await runInDurableObject(stub, async (instance: SessionAgent) => {
      instance.setState(withoutActiveConnectionId(instance.state));
      Object.assign(instance, { getConnections: () => [legacy.connection] });

      // #when its inbound hello is processed
      await instance.onMessage(
        legacy.connection,
        JSON.stringify({ type: "hello", browser: "chrome", extVersion: "1.0.0", tabs: [] }),
      );

      // #then the sole authorized socket is persisted as the authority and
      // its event is accepted
      expect(instance.state.activeConnectionId).toBe("legacy-only");
      expect(instance.state.generation).toBe(1);
      expect(instance.state.status).toBe("connected");
    });
  });

  it("fails closed instead of choosing among multiple authorized sockets in legacy state", async () => {
    // #given persisted pre-migration state with an ambiguous pair of
    // authorized sockets
    const sessionId = crypto.randomUUID();
    const stub = await getSessionStub(sessionId);
    const first = fakeConnection({ authorized: true }, "legacy-a");
    const second = fakeConnection({ authorized: true }, "legacy-b");

    await runInDurableObject(stub, async (instance: SessionAgent) => {
      instance.setState(withoutActiveConnectionId(instance.state));
      Object.assign(instance, {
        getConnections: () => [first.connection, second.connection],
      });

      // #when either socket submits an otherwise valid event
      await instance.onMessage(
        first.connection,
        JSON.stringify({ type: "hello", browser: "chrome", extVersion: "1.0.0", tabs: [] }),
      );

      // #then neither is silently promoted and the event is ignored
      expect(instance.state.activeConnectionId).toBeUndefined();
      expect(instance.state.generation).toBe(0);
      expect(instance.state.status).toBe("pending");
    });
  });

  it("detaches when a legacy session's sole authorized socket closes after leaving getConnections", async () => {
    // #given persisted pre-migration state whose sole authorized socket is
    // already absent from getConnections by the time onClose runs
    const sessionId = crypto.randomUUID();
    const stub = await getSessionStub(sessionId);
    const legacy = fakeConnection({ authorized: true }, "legacy-closing");

    await runInDurableObject(stub, async (instance: SessionAgent) => {
      instance.setState({
        ...withoutActiveConnectionId(instance.state),
        status: "connected",
      });
      Object.assign(instance, { getConnections: () => [] });

      // #when that sole legacy socket closes
      await instance.onClose(legacy.connection, 1000, "gone", true);

      // #then migration identifies it as authoritative before clearing the
      // authority and stamping detached
      expect(instance.state.activeConnectionId).toBeNull();
      expect(instance.state.status).toBe("detached");
    });
  });

  it("an authorized socket's close still detaches when it was the last one", async () => {
    // #given a session an authorized socket connected to (status: connected)
    const sessionId = crypto.randomUUID();
    const stub = await getSessionStub(sessionId);
    const { connection: authorized } = fakeConnection({ authorized: true });

    await runInDurableObject(stub, async (instance: SessionAgent) => {
      instance.setState({
        ...instance.state,
        activeConnectionId: authorized.id,
        status: "connected",
      });

      // #when it closes with no surviving authorized socket
      await instance.onClose(authorized, 1000, "gone", true);
    });

    // #then the session reads detached, as before
    expect((await stub.getStatus()).status).toBe("detached");
  });
});

describe("dispatch / resolvePending", () => {
  it("maps an authoritative socket's synchronous send failure to not_connected", async () => {
    // #given a persisted authoritative socket that closes in the
    // checked-to-send window
    const sessionId = crypto.randomUUID();
    const stub = await getSessionStub(sessionId);
    const active = fakeConnection({ authorized: true }, "send-race");
    active.send.mockImplementationOnce(() => {
      throw new Error("WebSocket is not open");
    });
    const cmd: Command = { type: "get_tabs", commandId: "send-race-1" };

    const outcome = await runInDurableObject(stub, async (instance: SessionAgent) => {
      instance.setState({
        ...instance.state,
        activeConnectionId: active.connection.id,
        status: "connected",
      });
      Object.assign(instance, { getConnections: () => [active.connection] });
      return instance.dispatch(cmd);
    });

    // #then SessionAgent maps the coordinator's delivery-race prefix to the
    // typed not_connected outcome and no awaiting marker survives
    expect(outcome).toEqual({
      ok: false,
      reason: "not_connected",
      message:
        "session not connected: authoritative extension connection unavailable during send",
    });
    await runInDurableObject(stub, (instance: SessionAgent) => {
      expect(instance.state.awaitingCommandIds).toEqual([]);
    });
  });

  it("sends to and accepts a result from only the authoritative socket while two authorized sockets overlap", async () => {
    // #given two still-authorized sockets in the connection set, with the
    // replacement persisted as the sole authority
    const sessionId = crypto.randomUUID();
    const stub = await getSessionStub(sessionId);
    const previous = fakeConnection({ authorized: true }, "overlap-old");
    const replacement = fakeConnection({ authorized: true }, "overlap-new");
    const cmd: Command = { type: "get_tabs", commandId: "overlap-1" };

    const result = await runInDurableObject(stub, async (instance: SessionAgent) => {
      instance.setState({
        ...instance.state,
        activeConnectionId: replacement.connection.id,
        status: "connected",
      });
      Object.assign(instance, {
        getConnections: () => [previous.connection, replacement.connection],
      });

      // #when a command dispatches during the overlap
      const dispatchPromise = instance.dispatch(cmd);

      // #then only the replacement receives it; there is no broadcast
      expect(previous.send).not.toHaveBeenCalled();
      expect(replacement.send).toHaveBeenCalledWith(JSON.stringify(cmd));

      // #when the old socket forges the matching result, it is ignored even
      // though its authorized bit is still true
      await instance.onMessage(
        previous.connection,
        JSON.stringify({ type: "tabs_result", commandId: cmd.commandId, tabs: [] }),
      );
      expect(instance.state.awaitingCommandIds).toEqual([cmd.commandId]);

      // #when the authoritative replacement answers, it alone resolves the command
      await instance.onMessage(
        replacement.connection,
        JSON.stringify({ type: "tabs_result", commandId: cmd.commandId, tabs: [] }),
      );
      return dispatchPromise;
    });

    expect(result).toEqual({
      ok: true,
      event: { type: "tabs_result", commandId: cmd.commandId, tabs: [] },
    });
  });

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
      Object.assign(instance, { getConnections: () => [FAKE_CONNECTION] });
      setAuthoritative(instance);
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
      instance.setState({
        ...instance.state,
        activeConnectionId: FAKE_CONNECTION.id,
        awaitingCommandIds: ["hib-1"],
      });
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
      Object.assign(instance, { getConnections: () => [FAKE_CONNECTION] });
      setAuthoritative(instance);
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
      setAuthoritative(instance);
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
