import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import type { Connection, ConnectionContext } from "agents";
import { PROTOCOL_CAPABILITIES, PROTOCOL_VERSION } from "@understudy/protocol";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { mintWsTicket, sha256Hex, type DeviceIdentity } from "../src/auth";
import type { DeviceAgent } from "../src/device";
import {
  claimRequest,
  directory,
  fetchApp,
  mintUser,
  pairDevice,
  setUserOrigins,
} from "./helpers";

const TENANT_ID = "tenantA";

function identity(
  deviceId: string,
  version: number,
  digestByte: string,
): DeviceIdentity {
  return {
    tenantId: TENANT_ID,
    deviceId,
    credentialVersion: version,
    credentialDigest: digestByte.repeat(64),
    allowedOrigins: ["https://example.com"],
    policyVersion: 1,
  };
}

async function ticket(
  deviceId: string,
  version: number,
  browserEpoch: string,
): Promise<string> {
  return mintWsTicket(
    {
      aud: "device-control",
      tenantId: TENANT_ID,
      deviceId,
      credentialVersion: version,
      leaseEpoch: 0,
      browserEpoch,
      agentName: deviceId,
      allowedOrigins: ["https://example.com"],
      policyVersion: 1,
    },
    env,
  );
}

function fakeConnection(id: string): {
  connection: Connection;
  close: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
} {
  const holder: { id: string; state: unknown } = { id, state: null };
  const close = vi.fn();
  const send = vi.fn();
  return {
    connection: Object.assign(holder, {
      close,
      send,
      setState(next: unknown) {
        holder.state = next;
      },
    }) as unknown as Connection,
    close,
    send,
  };
}

function context(deviceId: string, ticketValue: string): ConnectionContext {
  return {
    request: new Request(
      `https://understudy.example/agents/device/${deviceId}?ticket=${ticketValue}`,
    ),
  } as ConnectionContext;
}

describe("DeviceAgent authority fencing", () => {
  it("rejects a connect ticket minted before the directory policy changed", async () => {
    const user = await mintUser();
    const paired = await pairDevice(user.userId);
    const browserEpoch = "stale-policy-ticket";
    const digest = await sha256Hex(paired.deviceCredential);
    const staleTicket = await mintWsTicket(
      {
        aud: "device-control",
        tenantId: user.tenantId,
        deviceId: paired.deviceId,
        credentialVersion: 1,
        leaseEpoch: 0,
        browserEpoch,
        agentName: paired.deviceId,
        allowedOrigins: paired.originPolicy,
        policyVersion: paired.policyVersion,
      },
      env,
    );
    const stub = await getAgentByName(env.DEVICE, paired.deviceId);
    const candidate = fakeConnection("stale-policy-ticket");
    await runInDurableObject(stub, async (instance: DeviceAgent) => {
      await instance.authorizeCredential({
        tenantId: user.tenantId,
        deviceId: paired.deviceId,
        credentialVersion: 1,
        credentialDigest: digest,
        allowedOrigins: paired.originPolicy,
        policyVersion: paired.policyVersion,
      });
    });
    await setUserOrigins(user.userId, ["https://new.example"]);

    await runInDurableObject(stub, (instance: DeviceAgent) =>
      instance.onConnect(candidate.connection, context(paired.deviceId, staleTicket)),
    );

    expect(candidate.close).toHaveBeenCalledWith(
      1008,
      "invalid or replayed device ticket",
    );
  });

  it("retries a committed policy push on the next heartbeat", async () => {
    const user = await mintUser();
    const paired = await pairDevice(user.userId);
    const browserEpoch = "policy-retry-browser";
    const digest = await sha256Hex(paired.deviceCredential);
    const deviceTicket = await mintWsTicket(
      {
        aud: "device-control",
        tenantId: user.tenantId,
        deviceId: paired.deviceId,
        credentialVersion: 1,
        leaseEpoch: 0,
        browserEpoch,
        agentName: paired.deviceId,
        allowedOrigins: paired.originPolicy,
        policyVersion: paired.policyVersion,
      },
      env,
    );
    const stub = await getAgentByName(env.DEVICE, paired.deviceId);
    const candidate = fakeConnection("policy-retry");
    await runInDurableObject(stub, async (instance: DeviceAgent) => {
      Object.assign(instance, { getConnections: () => [candidate.connection] });
      await instance.authorizeCredential({
        tenantId: user.tenantId,
        deviceId: paired.deviceId,
        credentialVersion: 1,
        credentialDigest: digest,
        allowedOrigins: paired.originPolicy,
        policyVersion: paired.policyVersion,
      });
      await instance.onConnect(
        candidate.connection,
        context(paired.deviceId, deviceTicket),
      );
      await instance.onMessage(
        candidate.connection,
        JSON.stringify({
          type: "device_hello",
          protocolVersion: PROTOCOL_VERSION,
          capabilities: [...PROTOCOL_CAPABILITIES],
          deviceId: paired.deviceId,
          browserEpoch,
          browser: "Chrome/125",
          extVersion: "0.2.0",
          allowedOrigins: paired.originPolicy,
          policyVersion: paired.policyVersion,
          assignments: [],
          ownedWindows: [],
        }),
      );
    });
    candidate.send.mockClear();

    const targetOrigins = ["https://new.example"];
    const pending = await directory().beginAllowedOriginsUpdate(
      user.userId,
      targetOrigins,
    );
    if (pending.kind !== "ok") throw new Error("policy update did not begin");
    const coordinator = env.TENANT_CONTROL.getByName(user.tenantId);
    for (const device of pending.devices) {
      await coordinator.updateDevicePolicy({
        deviceId: device.deviceId,
        policyVersion: device.policyVersion,
        allowedOrigins: targetOrigins,
        narrowing: device.narrowing,
      });
    }
    const committed = await directory().commitAllowedOriginsUpdate(
      user.userId,
      pending.operationId,
    );
    if (committed.kind !== "ok") throw new Error("policy update did not commit");

    await runInDurableObject(stub, (instance: DeviceAgent) =>
      instance.onMessage(
        candidate.connection,
        JSON.stringify({
          type: "heartbeat",
          deviceId: paired.deviceId,
          browserEpoch,
          assignments: [],
          ownedWindows: [],
        }),
      ),
    );

    expect(candidate.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: "policy_update",
        policyVersion: 2,
        allowedOrigins: targetOrigins,
      }),
    );
  });

  it("advances coordinator policy before pushing a changed static policy", async () => {
    const credential = `static-${crypto.randomUUID()}`;
    const credentialDigest = await sha256Hex(credential);
    const deviceId = crypto.randomUUID();
    const tenantId = `static-${crypto.randomUUID()}`;
    const browserEpoch = crypto.randomUUID();
    const initialOrigins = ["https://one.example", "https://two.example"];
    const targetOrigins = ["https://two.example"];
    const staticTokens = (allowedOrigins: string[], policyVersion: number) =>
      JSON.stringify({
        [credentialDigest]: {
          tenantId,
          deviceId,
          credentialVersion: 1,
          allowedOrigins,
          policyVersion,
        },
      });
    const previousTokens = env.DEVICE_TOKENS;
    Reflect.set(env, "DEVICE_TOKENS", staticTokens(initialOrigins, 1));
    try {
      const deviceTicket = await mintWsTicket(
        {
          aud: "device-control",
          tenantId,
          deviceId,
          credentialVersion: 1,
          leaseEpoch: 0,
          browserEpoch,
          agentName: deviceId,
          allowedOrigins: initialOrigins,
          policyVersion: 1,
        },
        env,
      );
      const stub = await getAgentByName(env.DEVICE, deviceId);
      const candidate = fakeConnection("static-policy-update");
      await runInDurableObject(stub, async (instance: DeviceAgent) => {
        Object.assign(instance, { getConnections: () => [candidate.connection] });
        await instance.authorizeCredential({
          tenantId,
          deviceId,
          credentialVersion: 1,
          credentialDigest,
          allowedOrigins: initialOrigins,
          policyVersion: 1,
        });
        await instance.onConnect(
          candidate.connection,
          context(deviceId, deviceTicket),
        );
        await instance.onMessage(
          candidate.connection,
          JSON.stringify({
            type: "device_hello",
            protocolVersion: PROTOCOL_VERSION,
            capabilities: [...PROTOCOL_CAPABILITIES],
            deviceId,
            browserEpoch,
            browser: "Chrome/125",
            extVersion: "0.2.0",
            allowedOrigins: initialOrigins,
            policyVersion: 1,
            assignments: [],
            ownedWindows: [],
          }),
        );
      });
      candidate.send.mockClear();

      Reflect.set(env, "DEVICE_TOKENS", staticTokens(targetOrigins, 3));
      await runInDurableObject(stub, (instance: DeviceAgent) =>
        instance.onMessage(
          candidate.connection,
          JSON.stringify({
            type: "heartbeat",
            deviceId,
            browserEpoch,
            assignments: [],
            ownedWindows: [],
          }),
        ),
      );

      expect(candidate.send).toHaveBeenCalledWith(
        JSON.stringify({
          type: "policy_update",
          policyVersion: 3,
          allowedOrigins: targetOrigins,
        }),
      );
      await expect(env.TENANT_CONTROL.getByName(tenantId).listDevices()).resolves.toEqual([
        expect.objectContaining({
          deviceId,
          policyVersion: 3,
          acknowledgedPolicyVersion: null,
        }),
      ]);
    } finally {
      Reflect.set(env, "DEVICE_TOKENS", previousTokens);
    }
  });

  it("rejects an unconsumed ticket after its credential version rotates", async () => {
    const deviceId = crypto.randomUUID();
    const stub = await getAgentByName(env.DEVICE, deviceId);
    const oldTicket = await ticket(deviceId, 1, "browser-1");
    const candidate = fakeConnection("old-ticket");

    await runInDurableObject(stub, async (instance: DeviceAgent) => {
      await expect(
        instance.authorizeCredential(identity(deviceId, 1, "a")),
      ).resolves.toBe(true);
      await expect(
        instance.authorizeCredential(identity(deviceId, 2, "b")),
      ).resolves.toBe(true);
      await instance.onConnect(
        candidate.connection,
        context(deviceId, oldTicket),
      );
    });

    expect(candidate.close).toHaveBeenCalledWith(
      1008,
      "invalid or replayed device ticket",
    );
    expect(candidate.send).not.toHaveBeenCalled();
  });

  it("promotes and replaces synchronously before later asynchronous work", async () => {
    const deviceId = crypto.randomUUID();
    const stub = await getAgentByName(env.DEVICE, deviceId);
    const first = fakeConnection("first");
    const second = fakeConnection("second");
    const firstTicket = await ticket(deviceId, 1, "browser-1");
    const secondTicket = await ticket(deviceId, 1, "browser-1");

    await runInDurableObject(stub, async (instance: DeviceAgent) => {
      Object.assign(instance, {
        getConnections: () => [first.connection, second.connection],
      });
      await instance.authorizeCredential(identity(deviceId, 1, "a"));
      await instance.onConnect(
        first.connection,
        context(deviceId, firstTicket),
      );
      await instance.onConnect(
        second.connection,
        context(deviceId, secondTicket),
      );

      expect(instance.state.activeConnectionId).toBe(second.connection.id);
    });

    expect(first.close).toHaveBeenCalledWith(
      4001,
      "replaced by newer authorized device connection",
    );
    expect(second.close).not.toHaveBeenCalled();
  });

  it("acknowledges first, replayed, and lost closures while emitting release telemetry only once", async () => {
    const deviceId = crypto.randomUUID();
    const browserEpoch = "browser-closure";
    const stub = await getAgentByName(env.DEVICE, deviceId);
    const candidate = fakeConnection("closure");
    const deviceTicket = await ticket(deviceId, 1, browserEpoch);

    await runInDurableObject(stub, async (instance: DeviceAgent) => {
      Object.assign(instance, {
        getConnections: () => [candidate.connection],
      });
      await instance.authorizeCredential(identity(deviceId, 1, "a"));
      await instance.onConnect(
        candidate.connection,
        context(deviceId, deviceTicket),
      );
      await instance.onMessage(
        candidate.connection,
        JSON.stringify({
          type: "device_hello",
          protocolVersion: PROTOCOL_VERSION,
          capabilities: [...PROTOCOL_CAPABILITIES],
          deviceId,
          browserEpoch,
          browser: "Chrome/125",
          extVersion: "0.1.0",
          allowedOrigins: ["https://example.com"],
          policyVersion: 1,
          assignments: [],
          ownedWindows: [],
        }),
      );
    });

    const coordinator = env.TENANT_CONTROL.getByName(TENANT_ID);
    const allocation = await coordinator.createLease({
      idempotencyKey: crypto.randomUUID(),
      fingerprint: "f".repeat(64),
      sessionId: `session-${crypto.randomUUID()}`,
      deviceId,
      allowedOrigins: ["https://example.com"],
      profileStateHash: crypto.randomUUID(),
      actorPseudonym: "actor",
    });
    if (allocation.kind !== "created") {
      throw new Error("expected created lease");
    }
    const session = await getAgentByName(
      env.SESSION,
      allocation.lease.sessionId,
    );
    await session.initializeUnattended(TENANT_ID, allocation.lease);
    const frame = {
      type: "closed",
      sessionId: allocation.lease.sessionId,
      leaseId: allocation.lease.leaseId,
      leaseEpoch: allocation.lease.leaseEpoch,
      browserEpoch: allocation.lease.browserEpoch,
    } as const;
    const acknowledgement = {
      ...frame,
      type: "closed_ack",
    } as const;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runInDurableObject(stub, async (instance: DeviceAgent) => {
        await instance.onMessage(candidate.connection, JSON.stringify(frame));
      });
      expect(await session.getStatus()).toMatchObject({
        mode: "unattended",
        status: "closed",
      });
      expect(candidate.send).toHaveBeenLastCalledWith(
        JSON.stringify(acknowledgement),
      );

      await runInDurableObject(stub, async (instance: DeviceAgent) => {
        await instance.onMessage(candidate.connection, JSON.stringify(frame));
      });
      expect(
        candidate.send.mock.calls.map(([raw]) => JSON.parse(raw as string)),
      ).toEqual([
        acknowledgement,
        acknowledgement,
      ]);

      const lostAllocation = await coordinator.createLease({
        idempotencyKey: crypto.randomUUID(),
        fingerprint: "e".repeat(64),
        sessionId: `session-${crypto.randomUUID()}`,
        deviceId,
        allowedOrigins: ["https://example.com"],
        profileStateHash: crypto.randomUUID(),
        actorPseudonym: "actor",
      });
      if (lostAllocation.kind !== "created") {
        throw new Error("expected created lease");
      }
      const lostSession = await getAgentByName(
        env.SESSION,
        lostAllocation.lease.sessionId,
      );
      await lostSession.initializeUnattended(TENANT_ID, lostAllocation.lease);
      await coordinator.revokeDevice(deviceId);
      const lostFrame = {
        type: "closed",
        sessionId: lostAllocation.lease.sessionId,
        leaseId: lostAllocation.lease.leaseId,
        leaseEpoch: lostAllocation.lease.leaseEpoch,
        browserEpoch: lostAllocation.lease.browserEpoch,
      } as const;
      await runInDurableObject(stub, async (instance: DeviceAgent) => {
        await instance.onMessage(
          candidate.connection,
          JSON.stringify(lostFrame),
        );
      });
      expect(await lostSession.getStatus()).toMatchObject({
        mode: "unattended",
        status: "lost",
      });
      expect(candidate.send).toHaveBeenLastCalledWith(
        JSON.stringify({ ...lostFrame, type: "closed_ack" }),
      );

      const releaseTelemetry = log.mock.calls
        .map(([raw]) => JSON.parse(raw as string) as {
          telemetry?: { event?: string };
        })
        .filter((entry) => entry.telemetry?.event === "release");
      expect(releaseTelemetry).toHaveLength(1);
    } finally {
      log.mockRestore();
    }
  });
});

describe("DeviceAgent credential rotation recovery", () => {
  it("does not terminalize leases while the extension replays a lost rotation response", async () => {
    const user = await mintUser();
    const paired = await pairDevice(user.userId);
    const browserEpoch = "rotation-browser";
    const candidate = fakeConnection("rotation-old-credential");
    const stub = await getAgentByName(env.DEVICE, paired.deviceId);
    const deviceIdentity: DeviceIdentity = {
      tenantId: user.tenantId,
      deviceId: paired.deviceId,
      credentialVersion: 1,
      credentialDigest: await sha256Hex(paired.deviceCredential),
      allowedOrigins: ["https://example.com"],
      policyVersion: 1,
    };
    const deviceTicket = await mintWsTicket(
      {
        aud: "device-control",
        tenantId: user.tenantId,
        deviceId: paired.deviceId,
        credentialVersion: 1,
        leaseEpoch: 0,
        browserEpoch,
        agentName: paired.deviceId,
        allowedOrigins: deviceIdentity.allowedOrigins,
        policyVersion: 1,
      },
      env,
    );
    await runInDurableObject(stub, async (instance: DeviceAgent) => {
      Object.assign(instance, { getConnections: () => [candidate.connection] });
      await instance.authorizeCredential(deviceIdentity);
      await instance.onConnect(
        candidate.connection,
        context(paired.deviceId, deviceTicket),
      );
      await instance.onMessage(
        candidate.connection,
        JSON.stringify({
          type: "device_hello",
          protocolVersion: PROTOCOL_VERSION,
          capabilities: [...PROTOCOL_CAPABILITIES],
          deviceId: paired.deviceId,
          browserEpoch,
          browser: "Chrome/125",
          extVersion: "0.2.0",
          allowedOrigins: deviceIdentity.allowedOrigins,
          policyVersion: 1,
          assignments: [],
          ownedWindows: [],
        }),
      );
    });
    const coordinator = env.TENANT_CONTROL.getByName(user.tenantId);
    const allocation = await coordinator.createLease({
      idempotencyKey: crypto.randomUUID(),
      fingerprint: "a".repeat(64),
      sessionId: `session-${crypto.randomUUID()}`,
      deviceId: paired.deviceId,
      allowedOrigins: ["https://example.com"],
      profileStateHash: "rotation-profile",
      actorPseudonym: "rotation-actor",
    });
    if (allocation.kind !== "created") throw new Error("expected created lease");
    const offer = await directory().createPairingOffer(user.userId);
    expect(
      (await fetchApp(claimRequest(offer.offer, paired.deviceCredential))).status,
    ).toBe(200);

    await runInDurableObject(stub, async (instance: DeviceAgent) => {
      await instance.onMessage(
        candidate.connection,
        JSON.stringify({
          type: "heartbeat",
          deviceId: paired.deviceId,
          browserEpoch,
          assignments: [],
          ownedWindows: [],
        }),
      );
    });

    expect(candidate.send).not.toHaveBeenCalledWith(
      JSON.stringify({ type: "credential_revoked" }),
    );
    expect(candidate.close).not.toHaveBeenCalledWith(
      1008,
      "device credential revoked",
    );
    await expect(coordinator.getLease(allocation.lease.sessionId)).resolves.toMatchObject({
      status: "provisioning",
      adoptionExpiresAt: null,
    });
  });
});

describe("DeviceAgent credential revocation kill switch", () => {
  it("closes every authorized connection, frame before close", async () => {
    // #given an authoritative connection plus a superseded one still idling open
    const deviceId = crypto.randomUUID();
    const stub = await getAgentByName(env.DEVICE, deviceId);
    const stale = fakeConnection("stale");
    const active = fakeConnection("active");
    const staleTicket = await ticket(deviceId, 1, "browser-1");
    const activeTicket = await ticket(deviceId, 1, "browser-1");
    let open: Connection[] = [stale.connection];

    await runInDurableObject(stub, async (instance: DeviceAgent) => {
      Object.assign(instance, { getConnections: () => open });
      await instance.authorizeCredential(identity(deviceId, 1, "a"));
      await instance.onConnect(stale.connection, context(deviceId, staleTicket));
      // Only `active` is visible during its own connect, so the replace-loop
      // never reaches `stale` — it stays authorized but not authoritative,
      // exactly the socket onMessage's isAuthoritative check would ignore.
      open = [active.connection];
      await instance.onConnect(active.connection, context(deviceId, activeTicket));
      open = [stale.connection, active.connection];

      // #when the dashboard kill switch fires
      await expect(instance.revokeCredential(TENANT_ID)).resolves.toBe("closed");

      // #then the DO no longer considers any connection authoritative
      expect(instance.state.activeConnectionId).toBeNull();
    });

    // #then both sockets got the frame, then the close — in that order
    for (const target of [stale, active]) {
      expect(target.send).toHaveBeenLastCalledWith(
        JSON.stringify({ type: "credential_revoked" }),
      );
      expect(target.close).toHaveBeenLastCalledWith(
        1008,
        "device credential revoked",
      );
      expect(target.send.mock.invocationCallOrder.at(-1)).toBeLessThan(
        target.close.mock.invocationCallOrder.at(-1) as number,
      );
    }
  });

  it("persists the marker so a warm credential can no longer be authorized", async () => {
    // #given a paired device with no live socket
    const deviceId = crypto.randomUUID();
    const stub = await getAgentByName(env.DEVICE, deviceId);

    await runInDurableObject(stub, async (instance: DeviceAgent) => {
      Object.assign(instance, { getConnections: () => [] });
      await expect(
        instance.authorizeCredential(identity(deviceId, 1, "a")),
      ).resolves.toBe(true);

      // #when revoked while offline
      await expect(instance.revokeCredential(TENANT_ID)).resolves.toBe("no_socket");
    });

    // #then the persisted marker also refuses an already-minted ticket
    await runInDurableObject(stub, async (instance: DeviceAgent) => {
      expect(instance.state.credentialRevoked).toBe(true);
      await expect(
        instance.authorizeCredential(identity(deviceId, 1, "a")),
      ).resolves.toBe(false);
    });
  });

  it("refuses to revoke a device belonging to another tenant", async () => {
    // #given a device whose authority row belongs to TENANT_ID. The DEVICE
    // namespace is global — getByName(deviceId) reaches any tenant's agent —
    // so this fence, not the caller, is what stops a foreign id bricking it.
    const deviceId = crypto.randomUUID();
    const stub = await getAgentByName(env.DEVICE, deviceId);
    const live = fakeConnection("cross-tenant");
    const deviceTicket = await ticket(deviceId, 1, "browser-1");

    await runInDurableObject(stub, async (instance: DeviceAgent) => {
      Object.assign(instance, { getConnections: () => [live.connection] });
      await instance.authorizeCredential(identity(deviceId, 1, "a"));
      await instance.onConnect(live.connection, context(deviceId, deviceTicket));

      // #when another tenant tries to kill it
      await expect(instance.revokeCredential("tenantB")).resolves.toBe("wrong_tenant");

      // #then nothing is marked, nothing is torn down
      expect(instance.state.credentialRevoked).toBe(false);
      expect(instance.state.activeConnectionId).toBe(live.connection.id);
      await expect(
        instance.authorizeCredential(identity(deviceId, 1, "a")),
      ).resolves.toBe(true);
    });

    expect(live.close).not.toHaveBeenCalled();
  });

  it("pre-arms the marker on a device that has never connected", async () => {
    // #given a paired device with no authority row yet — revoking before its
    // first connect must still stick, so the fence allows an absent row
    const deviceId = crypto.randomUUID();
    const stub = await getAgentByName(env.DEVICE, deviceId);

    await runInDurableObject(stub, async (instance: DeviceAgent) => {
      Object.assign(instance, { getConnections: () => [] });
      // #when
      await expect(instance.revokeCredential(TENANT_ID)).resolves.toBe("no_socket");
      // #then its first credential authorization is already refused
      await expect(
        instance.authorizeCredential(identity(deviceId, 1, "a")),
      ).resolves.toBe(false);
    });
  });

  it("refuses a pre-minted ticket instead of accepting the connection", async () => {
    // #given a ticket minted before the revoke landed
    const deviceId = crypto.randomUUID();
    const stub = await getAgentByName(env.DEVICE, deviceId);
    const candidate = fakeConnection("post-revoke");
    const preMinted = await ticket(deviceId, 1, "browser-1");

    await runInDurableObject(stub, async (instance: DeviceAgent) => {
      Object.assign(instance, { getConnections: () => [] });
      await instance.authorizeCredential(identity(deviceId, 1, "a"));
      await instance.revokeCredential(TENANT_ID);

      // #when the extension reconnects with it
      await instance.onConnect(candidate.connection, context(deviceId, preMinted));

      // #then it is never promoted
      expect(instance.state.activeConnectionId).toBeNull();
    });

    expect(candidate.send).toHaveBeenCalledWith(
      JSON.stringify({ type: "credential_revoked" }),
    );
    expect(candidate.close).toHaveBeenCalledWith(
      1008,
      "device credential revoked",
    );
  });

  it("does not re-promote a connection when a revoke lands mid-ticket-verify", async () => {
    // #given a connect that passes the entry guard and then has the revoke land
    // during its ticket-verify awaits. Racing two real calls cannot produce this
    // ordering: the Agents SDK awaits its own prologue before onConnect's body,
    // while revokeCredential has no awaits at all — so a concurrent revoke
    // always wins and trips the ENTRY guard, leaving this one unexercised (a
    // deleted guard stayed green that way). Driving the flag per call is what
    // actually reaches it: false on entry, true by the post-verify re-read.
    const deviceId = crypto.randomUUID();
    const stub = await getAgentByName(env.DEVICE, deviceId);
    const racer = fakeConnection("mid-verify");
    const inFlight = await ticket(deviceId, 1, "browser-1");

    await runInDurableObject(stub, async (instance: DeviceAgent) => {
      Object.assign(instance, { getConnections: () => [racer.connection] });
      await instance.authorizeCredential(identity(deviceId, 1, "a"));
      let reads = 0;
      Object.assign(instance, {
        isCredentialRevoked: () => {
          reads += 1;
          return reads > 1;
        },
      });

      // #when
      await instance.onConnect(racer.connection, context(deviceId, inFlight));

      // #then the entry guard was passed and the second one caught it, so the
      // promotion never happens — the invariant that lets onMessage's guard
      // skip resetting activeConnectionId
      expect(reads).toBeGreaterThan(1);
      expect(instance.state.activeConnectionId).toBeNull();
    });

    expect(racer.close).toHaveBeenLastCalledWith(1008, "device credential revoked");
  });

  it("kills a hibernation-residue socket on its next frame", async () => {
    // #given a socket the close-all loop never saw (it outlived the DO instance)
    const deviceId = crypto.randomUUID();
    const browserEpoch = "browser-residue";
    const stub = await getAgentByName(env.DEVICE, deviceId);
    const residue = fakeConnection("residue");
    const deviceTicket = await ticket(deviceId, 1, browserEpoch);

    await runInDurableObject(stub, async (instance: DeviceAgent) => {
      Object.assign(instance, { getConnections: () => [residue.connection] });
      await instance.authorizeCredential(identity(deviceId, 1, "a"));
      await instance.onConnect(residue.connection, context(deviceId, deviceTicket));
      Object.assign(instance, { getConnections: () => [] });
      await expect(instance.revokeCredential(TENANT_ID)).resolves.toBe("no_socket");

      // #when it wakes and heartbeats (≤22 s later)
      await instance.onMessage(
        residue.connection,
        JSON.stringify({ type: "heartbeat", deviceId, browserEpoch, leaseIds: [] }),
      );
    });

    // #then it dies on that frame rather than remaining connected until timeout
    expect(residue.send).toHaveBeenLastCalledWith(
      JSON.stringify({ type: "credential_revoked" }),
    );
    expect(residue.close).toHaveBeenLastCalledWith(
      1008,
      "device credential revoked",
    );
  });
});
