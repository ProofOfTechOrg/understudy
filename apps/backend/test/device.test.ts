import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import type { Connection, ConnectionContext } from "agents";
import { PROTOCOL_CAPABILITIES, PROTOCOL_VERSION } from "@understudy/protocol";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { mintWsTicket, type DeviceIdentity } from "../src/auth";
import type { DeviceAgent } from "../src/device";

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

  it("acknowledges closure only after durable lifecycle processing and emits release telemetry once", async () => {
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
          allowedOrigins: ["https://app.example"],
        }),
      );
    });

    const coordinator = env.TENANT_CONTROL.getByName(TENANT_ID);
    const allocation = await coordinator.createLease({
      idempotencyKey: crypto.randomUUID(),
      fingerprint: "f".repeat(64),
      sessionId: `session-${crypto.randomUUID()}`,
      deviceId,
      allowedOrigins: ["https://app.example"],
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
