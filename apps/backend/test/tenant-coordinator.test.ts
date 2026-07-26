import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import type { TenantDeviceCoordinator } from "../src/tenant-coordinator";

const DEVICE_A = "00000000-0000-4000-8000-000000000001";
const DEVICE_B = "00000000-0000-4000-8000-000000000002";
const BROWSER_EPOCH = "browser-epoch-1";

function coordinator(): DurableObjectStub<TenantDeviceCoordinator> {
  return env.TENANT_CONTROL.getByName(`tenant-${crypto.randomUUID()}`);
}

async function register(
  stub: DurableObjectStub<TenantDeviceCoordinator>,
  deviceId: string,
  now = 1_000_000,
): Promise<void> {
  await stub.registerDevice({
    deviceId,
    browser: "Chrome/125",
    extVersion: "0.1.0",
    browserEpoch: BROWSER_EPOCH,
    credentialDigest: "a".repeat(64),
    credentialVersion: 1,
    allowedOrigins: [
      "https://one.example",
      "https://two.example",
      "https://three.example",
      "https://four.example",
    ],
    capabilities: ["safe-write-v2"],
    now,
  });
}

function leaseInput(
  index: number,
  origin: string,
  overrides: Partial<{
    deviceId: string;
    idempotencyKey: string;
    fingerprint: string;
    profileStateHash: string;
  }> = {},
) {
  return {
    idempotencyKey: overrides.idempotencyKey ?? crypto.randomUUID(),
    fingerprint: overrides.fingerprint ?? `${index}`.repeat(64).slice(0, 64),
    sessionId: `session-${index}`,
    ...(overrides.deviceId === undefined ? {} : { deviceId: overrides.deviceId }),
    allowedOrigins: [origin],
    profileStateHash: overrides.profileStateHash ?? `profile-${index}`,
    actorPseudonym: "actor",
    now: 1_000_001 + index,
  };
}

describe("TenantDeviceCoordinator allocation", () => {
  it("atomically admits two disjoint leases on one device and rejects a third", async () => {
    const stub = coordinator();
    await register(stub, DEVICE_A);

    const first = await stub.createLease(leaseInput(1, "https://one.example"));
    const second = await stub.createLease(leaseInput(2, "https://two.example"));
    const third = await stub.createLease(leaseInput(3, "https://three.example"));

    expect(first.kind).toBe("created");
    expect(second.kind).toBe("created");
    expect(third).toEqual({ kind: "capacity" });
    expect((await stub.listDevices(1_000_010))[0]).toMatchObject({
      deviceId: DEVICE_A,
      capacity: 2,
      used: 2,
    });
  });

  it("rejects overlapping origins and equal profile-state hashes", async () => {
    const originStub = coordinator();
    await register(originStub, DEVICE_A);
    await originStub.createLease(leaseInput(1, "https://one.example"));
    expect(
      await originStub.createLease(leaseInput(2, "https://one.example")),
    ).toEqual({ kind: "collision" });

    const profileStub = coordinator();
    await register(profileStub, DEVICE_A);
    await profileStub.createLease(
      leaseInput(1, "https://one.example", { profileStateHash: "same" }),
    );
    expect(
      await profileStub.createLease(
        leaseInput(2, "https://two.example", { profileStateHash: "same" }),
      ),
    ).toEqual({ kind: "collision" });
  });

  it("converges identical create keys, conflicts changed requests, and tombstones terminal keys", async () => {
    const stub = coordinator();
    await register(stub, DEVICE_A);
    const key = crypto.randomUUID();
    const input = leaseInput(1, "https://one.example", {
      idempotencyKey: key,
      fingerprint: "a".repeat(64),
    });
    const first = await stub.createLease(input);
    const replay = await stub.createLease(input);
    const conflict = await stub.createLease({
      ...input,
      fingerprint: "b".repeat(64),
    });
    expect(first.kind).toBe("created");
    expect(replay.kind).toBe("replay");
    expect(conflict).toEqual({ kind: "conflict" });
    if (first.kind !== "created") throw new Error("expected created lease");

    await stub.closeLease(input.sessionId);
    await stub.confirmClosed({
      sessionId: first.lease.sessionId,
      leaseId: first.lease.leaseId,
      leaseEpoch: first.lease.leaseEpoch,
      browserEpoch: first.lease.browserEpoch,
      now: 1_000_100,
    });
    expect(await stub.createLease(input)).toEqual({ kind: "terminal", status: "closed" });
  });

  it("never falls back from an explicit full device and auto-selects by used capacity", async () => {
    const stub = coordinator();
    await register(stub, DEVICE_A);
    await register(stub, DEVICE_B);

    const first = await stub.createLease(
      leaseInput(1, "https://one.example", { deviceId: DEVICE_A }),
    );
    const second = await stub.createLease(
      leaseInput(2, "https://two.example", { deviceId: DEVICE_A }),
    );
    expect(first.kind).toBe("created");
    expect(second.kind).toBe("created");
    expect(
      await stub.createLease(
        leaseInput(3, "https://three.example", { deviceId: DEVICE_A }),
      ),
    ).toEqual({ kind: "capacity" });

    const auto = await stub.createLease(leaseInput(4, "https://four.example"));
    expect(auto.kind).toBe("created");
    if (auto.kind === "created") expect(auto.lease.deviceId).toBe(DEVICE_B);
  });

  it("marks an unreported connected assignment recovering and reports it for blank-tab reconciliation", async () => {
    const stub = coordinator();
    await register(stub, DEVICE_A);
    const created = await stub.createLease(leaseInput(1, "https://one.example"));
    if (created.kind !== "created") throw new Error("expected created lease");
    await stub.markProvisioned({
      sessionId: created.lease.sessionId,
      leaseId: created.lease.leaseId,
      leaseEpoch: created.lease.leaseEpoch,
      browserEpoch: created.lease.browserEpoch,
      now: 1_000_010,
    });

    const heartbeat = await stub.heartbeat(
      DEVICE_A,
      BROWSER_EPOCH,
      [],
      1_000_020,
    );
    expect(heartbeat.ok).toBe(true);
    expect(heartbeat.assignments).toEqual([]);
    expect(heartbeat.recoveries).toHaveLength(1);
    expect(heartbeat.recoveries[0]).toMatchObject({
      sessionId: created.lease.sessionId,
      status: "recovering",
      needsReconciliation: true,
    });
  });

  it("does not count provisioning as activity and materializes expiry on status reads", async () => {
    const stub = coordinator();
    await register(stub, DEVICE_A);
    const created = await stub.createLease(leaseInput(1, "https://one.example"));
    if (created.kind !== "created") throw new Error("expected created lease");

    await stub.markProvisioned({
      sessionId: created.lease.sessionId,
      leaseId: created.lease.leaseId,
      leaseEpoch: created.lease.leaseEpoch,
      browserEpoch: created.lease.browserEpoch,
      now: created.lease.createdAt + 30_000,
    });
    expect(await stub.getLease(created.lease.sessionId, created.lease.createdAt + 30_001))
      .toMatchObject({
        status: "connected",
        lastActivityAt: created.lease.createdAt,
        idleExpiresAt: created.lease.idleExpiresAt,
      });

    expect(await stub.getLease(created.lease.sessionId, created.lease.idleExpiresAt))
      .toMatchObject({
        status: "expired",
      });
  });
});
