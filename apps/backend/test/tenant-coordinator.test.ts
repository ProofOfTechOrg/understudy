import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type {
  RegisterDeviceInput,
  TenantDeviceCoordinator,
} from "../src/tenant-coordinator";

const DEVICE_A = "00000000-0000-4000-8000-000000000001";
const DEVICE_B = "00000000-0000-4000-8000-000000000002";
const BROWSER_EPOCH = "browser-epoch-1";

afterEach(() => {
  vi.useRealTimers();
});

function coordinator(): DurableObjectStub<TenantDeviceCoordinator> {
  return env.TENANT_CONTROL.getByName(`tenant-${crypto.randomUUID()}`);
}

function runAlarm(stub: DurableObjectStub<TenantDeviceCoordinator>): Promise<void> {
  return runInDurableObject(stub, (instance: TenantDeviceCoordinator) => instance.alarm());
}

async function register(
  stub: DurableObjectStub<TenantDeviceCoordinator>,
  deviceId: string,
  now = 1_000_000,
): Promise<void> {
  const input = {
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
    capabilities: ["safe-write-v3"],
    policyVersion: 1,
    authoritySource: "directory",
    acknowledgedPolicyVersion: 1,
    assignments: [],
    ownedWindows: [],
    now,
  } satisfies RegisterDeviceInput;
  await stub.registerDevice(input);
  await stub.heartbeat(deviceId, BROWSER_EPOCH, input.assignments, input.ownedWindows, now);
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
  it("keeps a registered device unavailable until its inventory is reconciled", async () => {
    const stub = coordinator();
    const input = {
      deviceId: DEVICE_A,
      browser: "Chrome/125",
      extVersion: "0.2.0",
      browserEpoch: BROWSER_EPOCH,
      credentialDigest: "a".repeat(64),
      credentialVersion: 1,
      allowedOrigins: ["https://one.example"],
      capabilities: ["safe-write-v3"],
      policyVersion: 1,
      authoritySource: "directory",
      acknowledgedPolicyVersion: 1,
      assignments: [],
      ownedWindows: [],
      now: 1_000_000,
    } satisfies RegisterDeviceInput;

    await expect(stub.registerDevice(input)).resolves.toEqual({
      accepted: true,
      epochChanged: false,
    });
    await expect(stub.createLease(leaseInput(1, "https://one.example"))).resolves.toEqual({
      kind: "no_device",
    });
    await expect(
      stub.heartbeat(DEVICE_A, BROWSER_EPOCH, [], [], 1_000_001),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      stub.createLease({ ...leaseInput(2, "https://one.example"), now: 1_000_002 }),
    ).resolves.toMatchObject({ kind: "created" });
  });

  it("rejects stale or conflicting credential registrations monotonically", async () => {
    const stub = coordinator();
    const base = {
      deviceId: DEVICE_A,
      browser: "Chrome/125",
      extVersion: "0.1.0",
      browserEpoch: BROWSER_EPOCH,
      credentialDigest: "b".repeat(64),
      credentialVersion: 2,
      allowedOrigins: ["https://one.example"],
      capabilities: ["safe-write-v3"],
      policyVersion: 1,
      authoritySource: "directory",
      acknowledgedPolicyVersion: 1,
      assignments: [],
      ownedWindows: [],
      now: 1_000_000,
    } satisfies RegisterDeviceInput;

    await expect(stub.registerDevice(base)).resolves.toEqual({
      accepted: true,
      epochChanged: false,
    });
    await expect(
      stub.registerDevice({
        ...base,
        browserEpoch: "stale-epoch",
        credentialDigest: "a".repeat(64),
        credentialVersion: 1,
      }),
    ).resolves.toEqual({ accepted: false, epochChanged: false });
    await expect(
      stub.registerDevice({
        ...base,
        browserEpoch: "conflicting-epoch",
        credentialDigest: "c".repeat(64),
      }),
    ).resolves.toEqual({ accepted: false, epochChanged: false });
    await expect(
      stub.updateDevicePolicy({
        deviceId: DEVICE_A,
        policyVersion: 2,
        allowedOrigins: ["https://one.example", "https://two.example"],
        narrowing: false,
        now: 1_000_001,
      }),
    ).resolves.toBe(true);
    await expect(
      stub.registerDevice({
        ...base,
        browserEpoch: "stale-policy-epoch",
        credentialDigest: "d".repeat(64),
        credentialVersion: 3,
      }),
    ).resolves.toEqual({ accepted: false, epochChanged: false });
    await expect(
      stub.registerDevice({
        ...base,
        browserEpoch: "browser-epoch-2",
        credentialDigest: "d".repeat(64),
        credentialVersion: 3,
        allowedOrigins: ["https://one.example", "https://two.example"],
        policyVersion: 2,
        acknowledgedPolicyVersion: 2,
      }),
    ).resolves.toEqual({ accepted: true, epochChanged: true });

    await expect(
      stub.heartbeat(DEVICE_A, "conflicting-epoch", [], [], 1_000_001),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      stub.heartbeat(DEVICE_A, "browser-epoch-2", [], [], 1_000_001),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      stub.revokeDevice(
        DEVICE_A,
        {
          credentialDigest: base.credentialDigest,
          credentialVersion: base.credentialVersion,
        },
        1_000_002,
      ),
    ).resolves.toBe(false);
    await expect(
      stub.heartbeat(DEVICE_A, "browser-epoch-2", [], [], 1_000_003),
    ).resolves.toMatchObject({ ok: true });
  });

  it("adopts a higher static policy and fences leases narrowed by that authority", async () => {
    const stub = coordinator();
    const initial = {
      deviceId: DEVICE_A,
      browser: "Chrome/125",
      extVersion: "0.1.0",
      browserEpoch: BROWSER_EPOCH,
      credentialDigest: "a".repeat(64),
      credentialVersion: 1,
      allowedOrigins: ["https://one.example", "https://two.example"],
      capabilities: ["safe-write-v3"],
      policyVersion: 1,
      authoritySource: "static",
      acknowledgedPolicyVersion: 1,
      assignments: [],
      ownedWindows: [],
      now: 1_000_000,
    } satisfies RegisterDeviceInput;
    await expect(stub.registerDevice(initial)).resolves.toMatchObject({ accepted: true });
    await stub.heartbeat(DEVICE_A, BROWSER_EPOCH, [], [], 1_000_000);
    const created = await stub.createLease(
      leaseInput(1, "https://one.example", { deviceId: DEVICE_A }),
    );
    if (created.kind !== "created") throw new Error("expected created lease");

    await expect(
      stub.registerDevice({
        ...initial,
        allowedOrigins: ["https://three.example", "https://two.example"],
        policyVersion: 3,
        acknowledgedPolicyVersion: null,
        now: 1_000_010,
      }),
    ).resolves.toEqual({ accepted: true, epochChanged: false });

    await expect(stub.getLease(created.lease.sessionId, 1_000_011)).resolves.toMatchObject({
      status: "closed",
    });
    await expect(stub.listDevices(1_000_011)).resolves.toEqual([
      expect.objectContaining({
        deviceId: DEVICE_A,
        policyVersion: 3,
        acknowledgedPolicyVersion: null,
      }),
    ]);
  });

  it("freezes allocation during credential rotation without terminalizing active leases", async () => {
    const stub = coordinator();
    await register(stub, DEVICE_A);
    const existing = await stub.createLease(leaseInput(1, "https://one.example"));
    if (existing.kind !== "created") throw new Error("expected created lease");

    await expect(
      stub.suspendForCredentialRotation(DEVICE_A, {
        credentialDigest: "a".repeat(64),
        credentialVersion: 1,
      }),
    ).resolves.toBe(true);

    await expect(stub.getLease(existing.lease.sessionId, 1_000_003)).resolves.toMatchObject({
      status: "provisioning",
      adoptionExpiresAt: null,
    });
    await expect(
      stub.createLease({
        ...leaseInput(2, "https://two.example", { deviceId: DEVICE_A }),
        now: 1_000_003,
      }),
    ).resolves.toEqual({ kind: "no_device" });

    const rotated = {
      deviceId: DEVICE_A,
      browser: "Chrome/125",
      extVersion: "0.2.0",
      browserEpoch: BROWSER_EPOCH,
      credentialDigest: "b".repeat(64),
      credentialVersion: 2,
      allowedOrigins: [
        "https://one.example",
        "https://two.example",
        "https://three.example",
        "https://four.example",
      ],
      capabilities: ["safe-write-v3"],
      policyVersion: 1,
      authoritySource: "directory",
      acknowledgedPolicyVersion: 1,
      assignments: [],
      ownedWindows: [],
      now: 1_000_004,
    } satisfies RegisterDeviceInput;
    await expect(stub.registerDevice(rotated)).resolves.toMatchObject({ accepted: true });
    await stub.heartbeat(DEVICE_A, BROWSER_EPOCH, [], [], 1_000_005);

    await expect(
      stub.createLease({
        ...leaseInput(3, "https://two.example", { deviceId: DEVICE_A }),
        now: 1_000_006,
      }),
    ).resolves.toMatchObject({ kind: "created" });
    await expect(stub.getLease(existing.lease.sessionId, 1_000_006)).resolves.toMatchObject({
      status: "provisioning",
    });
  });

  it("returns a lease only when provision failure wins the exact fence", async () => {
    const stub = coordinator();
    await register(stub, DEVICE_A);
    const created = await stub.createLease(leaseInput(1, "https://one.example"));
    if (created.kind !== "created") throw new Error("expected created lease");
    const fence = {
      sessionId: created.lease.sessionId,
      leaseId: created.lease.leaseId,
      deviceId: created.lease.deviceId,
      leaseEpoch: created.lease.leaseEpoch,
      browserEpoch: created.lease.browserEpoch,
    };

    await expect(
      stub.markProvisionFailed({ ...fence, leaseEpoch: fence.leaseEpoch + 1 }),
    ).resolves.toBeNull();
    await expect(stub.getLease(created.lease.sessionId, 1_000_003)).resolves.toMatchObject({
      status: "provisioning",
    });
    await expect(stub.markProvisionFailed(fence)).resolves.toMatchObject({
      status: "closing",
    });
    await expect(stub.markProvisionFailed(fence)).resolves.toBeNull();
  });

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
      deviceId: first.lease.deviceId,
      leaseEpoch: first.lease.leaseEpoch,
      browserEpoch: first.lease.browserEpoch,
      now: 1_000_100,
    });
    expect(await stub.createLease(input)).toEqual({ kind: "terminal", status: "closed" });
  });

  it("accepts an authenticated active host closure and rejects stale fences", async () => {
    const stub = coordinator();
    const now = Date.now();
    await register(stub, DEVICE_A, now);
    const created = await stub.createLease(
      { ...leaseInput(1, "https://one.example"), now: now + 1 },
    );
    if (created.kind !== "created") throw new Error("expected created lease");
    expect(await stub.getLease(created.lease.sessionId, now + 2)).toMatchObject({
      status: "provisioning",
      leaseEpoch: created.lease.leaseEpoch,
      browserEpoch: created.lease.browserEpoch,
    });

    expect(
      await stub.confirmClosed({
        sessionId: created.lease.sessionId,
        leaseId: "stale-lease",
        deviceId: created.lease.deviceId,
        leaseEpoch: created.lease.leaseEpoch,
        browserEpoch: created.lease.browserEpoch,
        now: now + 2,
      }),
    ).toBeNull();
    expect(
      await stub.confirmClosed({
        sessionId: created.lease.sessionId,
        leaseId: created.lease.leaseId,
        deviceId: DEVICE_B,
        leaseEpoch: created.lease.leaseEpoch,
        browserEpoch: created.lease.browserEpoch,
        now: now + 2,
      }),
    ).toBeNull();
    expect(
      await stub.confirmClosed({
        sessionId: created.lease.sessionId,
        leaseId: created.lease.leaseId,
        deviceId: created.lease.deviceId,
        leaseEpoch: created.lease.leaseEpoch + 1,
        browserEpoch: created.lease.browserEpoch,
        now: now + 2,
      }),
    ).toBeNull();
    expect(
      await stub.confirmClosed({
        sessionId: created.lease.sessionId,
        leaseId: created.lease.leaseId,
        deviceId: created.lease.deviceId,
        leaseEpoch: created.lease.leaseEpoch,
        browserEpoch: "stale-browser",
        now: now + 2,
      }),
    ).toBeNull();
    expect(await stub.getLease(created.lease.sessionId, now + 3)).toMatchObject({
      status: "provisioning",
    });
    expect(
      await stub.confirmClosed({
        sessionId: created.lease.sessionId,
        leaseId: created.lease.leaseId,
        deviceId: created.lease.deviceId,
        leaseEpoch: created.lease.leaseEpoch,
        browserEpoch: created.lease.browserEpoch,
        now: now + 3,
      }),
    ).toEqual({ status: "closed", newlyClosed: true });
    expect(
      await stub.confirmClosed({
        sessionId: created.lease.sessionId,
        leaseId: created.lease.leaseId,
        deviceId: created.lease.deviceId,
        leaseEpoch: created.lease.leaseEpoch,
        browserEpoch: created.lease.browserEpoch,
        now: now + 4,
      }),
    ).toEqual({ status: "closed", newlyClosed: false });
    expect((await stub.listDevices(now + 4))[0]).toMatchObject({
      used: 0,
    });

    const lost = await stub.createLease({
      ...leaseInput(2, "https://two.example"),
      now: now + 5,
    });
    if (lost.kind !== "created") throw new Error("expected created lease");
    await stub.revokeDevice(DEVICE_A, undefined, now + 6);
    expect(
      await stub.confirmClosed({
        sessionId: lost.lease.sessionId,
        leaseId: lost.lease.leaseId,
        deviceId: lost.lease.deviceId,
        leaseEpoch: lost.lease.leaseEpoch,
        browserEpoch: lost.lease.browserEpoch,
        now: now + 7,
      }),
    ).toEqual({ status: "lost", newlyClosed: false });
    expect(await stub.getLease(lost.lease.sessionId, now + 8)).toMatchObject({
      status: "lost",
    });
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
      deviceId: created.lease.deviceId,
      leaseEpoch: created.lease.leaseEpoch,
      browserEpoch: created.lease.browserEpoch,
      now: 1_000_010,
    });

    const heartbeat = await stub.heartbeat(
      DEVICE_A,
      BROWSER_EPOCH,
      [],
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

  it("returns the durable CAS result for provisioning and recovery transitions", async () => {
    const stub = coordinator();
    await register(stub, DEVICE_A);
    const created = await stub.createLease(leaseInput(1, "https://one.example"));
    if (created.kind !== "created") throw new Error("expected created lease");
    const fence = {
      sessionId: created.lease.sessionId,
      leaseId: created.lease.leaseId,
      deviceId: created.lease.deviceId,
      leaseEpoch: created.lease.leaseEpoch,
      browserEpoch: created.lease.browserEpoch,
    };

    expect(
      await stub.markProvisioned({
        ...fence,
        deviceId: DEVICE_B,
        now: 1_000_009,
      }),
    ).toEqual({
      accepted: false,
      close: true,
    });
    expect(await stub.markProvisioned({ ...fence, now: 1_000_010 })).toEqual({
      accepted: true,
      close: false,
    });
    expect(await stub.markProvisioned({ ...fence, now: 1_000_011 })).toEqual({
      accepted: false,
      close: true,
    });
    expect(await stub.markRecovering({ ...fence, now: 1_000_012 })).toBe(true);
    expect(await stub.markRecovering({ ...fence, now: 1_000_013 })).toBe(false);
  });

  it("does not count provisioning as activity and materializes expiry on status reads", async () => {
    const stub = coordinator();
    await register(stub, DEVICE_A);
    const created = await stub.createLease(leaseInput(1, "https://one.example"));
    if (created.kind !== "created") throw new Error("expected created lease");

    await stub.markProvisioned({
      sessionId: created.lease.sessionId,
      leaseId: created.lease.leaseId,
      deviceId: created.lease.deviceId,
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

  it("moves offline leases through recovering and suspended before the 15-minute terminal loss", async () => {
    vi.useFakeTimers();
    const startedAt = 2_000_000_000_000;
    vi.setSystemTime(startedAt);
    const stub = coordinator();
    await register(stub, DEVICE_A, startedAt);
    const created = await stub.createLease({
      ...leaseInput(1, "https://one.example"),
      now: startedAt + 1,
    });
    if (created.kind !== "created") throw new Error("expected created lease");
    await stub.markProvisioned({
      sessionId: created.lease.sessionId,
      leaseId: created.lease.leaseId,
      deviceId: created.lease.deviceId,
      leaseEpoch: created.lease.leaseEpoch,
      browserEpoch: created.lease.browserEpoch,
    });

    vi.setSystemTime(startedAt + 75_000);
    await runAlarm(stub);
    expect(await stub.getLease(created.lease.sessionId, startedAt + 75_001)).toMatchObject({
      status: "recovering",
    });

    vi.setSystemTime(startedAt + 90_000);
    await runAlarm(stub);
    const suspended = await stub.getLease(created.lease.sessionId, startedAt + 90_001);
    expect(suspended).toMatchObject({
      status: "suspended",
      adoptionExpiresAt: startedAt + 990_000,
    });
    expect((await stub.listDevices(startedAt + 90_001))[0]).toMatchObject({ used: 0 });

    vi.setSystemTime(startedAt + 990_000);
    await runAlarm(stub);
    expect(await stub.getLease(created.lease.sessionId, startedAt + 990_001)).toMatchObject({
      status: "lost",
    });
  });

  it("accepts an exact physical closure after the lease becomes suspended", async () => {
    vi.useFakeTimers();
    const startedAt = 2_010_000_000_000;
    vi.setSystemTime(startedAt);
    const stub = coordinator();
    await register(stub, DEVICE_A, startedAt);
    const created = await stub.createLease({
      ...leaseInput(1, "https://one.example"),
      now: startedAt + 1,
    });
    if (created.kind !== "created") throw new Error("expected created lease");
    await stub.markProvisioned({
      sessionId: created.lease.sessionId,
      leaseId: created.lease.leaseId,
      deviceId: created.lease.deviceId,
      leaseEpoch: created.lease.leaseEpoch,
      browserEpoch: created.lease.browserEpoch,
      now: startedAt + 2,
    });
    vi.setSystemTime(startedAt + 90_000);
    await runAlarm(stub);
    await expect(
      stub.getLease(created.lease.sessionId, startedAt + 90_001),
    ).resolves.toMatchObject({ status: "suspended" });

    const closure = {
      sessionId: created.lease.sessionId,
      leaseId: created.lease.leaseId,
      deviceId: created.lease.deviceId,
      leaseEpoch: created.lease.leaseEpoch,
      browserEpoch: created.lease.browserEpoch,
    };
    await expect(
      stub.confirmClosed({ ...closure, now: startedAt + 90_002 }),
    ).resolves.toEqual({ status: "closed", newlyClosed: true });
    await expect(
      stub.confirmClosed({ ...closure, now: startedAt + 90_003 }),
    ).resolves.toEqual({ status: "closed", newlyClosed: false });
  });

  it("releases an offline closing lease at the device-loss boundary", async () => {
    vi.useFakeTimers();
    const startedAt = 2_025_000_000_000;
    vi.setSystemTime(startedAt);
    const stub = coordinator();
    await register(stub, DEVICE_A, startedAt);
    const created = await stub.createLease({
      ...leaseInput(1, "https://one.example"),
      now: startedAt + 1,
    });
    if (created.kind !== "created") throw new Error("expected created lease");
    await stub.markProvisionFailed({
      sessionId: created.lease.sessionId,
      leaseId: created.lease.leaseId,
      deviceId: created.lease.deviceId,
      leaseEpoch: created.lease.leaseEpoch,
      browserEpoch: created.lease.browserEpoch,
    });

    vi.setSystemTime(startedAt + 90_000);
    await runAlarm(stub);

    await expect(stub.getLease(created.lease.sessionId, startedAt + 90_001)).resolves.toMatchObject({
      status: "closed",
    });
    await expect(stub.closeLease(created.lease.sessionId)).resolves.toMatchObject({
      found: true,
      cleanupConfirmed: true,
    });
    expect((await stub.listDevices(startedAt + 90_001))[0]).toMatchObject({ used: 0 });
  });

  it("releases an expired lease when its device is already lost", async () => {
    vi.useFakeTimers();
    const startedAt = 2_035_000_000_000;
    vi.setSystemTime(startedAt);
    const stub = coordinator();
    await register(stub, DEVICE_A, startedAt);
    const created = await stub.createLease({
      ...leaseInput(1, "https://one.example"),
      now: startedAt + 1,
    });
    if (created.kind !== "created") throw new Error("expected created lease");
    await stub.getLease(created.lease.sessionId, created.lease.idleExpiresAt);
    vi.setSystemTime(created.lease.idleExpiresAt);

    await runAlarm(stub);

    await expect(
      stub.getLease(created.lease.sessionId, created.lease.idleExpiresAt + 1),
    ).resolves.toMatchObject({ status: "expired" });
    await expect(stub.closeLease(created.lease.sessionId)).resolves.toMatchObject({
      found: true,
      cleanupConfirmed: true,
    });
    expect((await stub.listDevices(created.lease.idleExpiresAt + 1))[0]).toMatchObject({
      used: 0,
    });
  });

  it("terminalizes a suspended lease immediately when its device is revoked", async () => {
    vi.useFakeTimers();
    const startedAt = 2_050_000_000_000;
    vi.setSystemTime(startedAt);
    const stub = coordinator();
    await register(stub, DEVICE_A, startedAt);
    const created = await stub.createLease({
      ...leaseInput(1, "https://one.example"),
      now: startedAt + 1,
    });
    if (created.kind !== "created") throw new Error("expected created lease");
    await stub.markProvisioned({
      sessionId: created.lease.sessionId,
      leaseId: created.lease.leaseId,
      deviceId: created.lease.deviceId,
      leaseEpoch: created.lease.leaseEpoch,
      browserEpoch: created.lease.browserEpoch,
      now: startedAt + 2,
    });
    vi.setSystemTime(startedAt + 90_000);
    await runAlarm(stub);
    expect(await stub.getLease(created.lease.sessionId, startedAt + 90_001)).toMatchObject({
      status: "suspended",
    });

    await expect(stub.revokeDevice(DEVICE_A, undefined, startedAt + 90_002)).resolves.toBe(
      true,
    );

    expect(await stub.getLease(created.lease.sessionId, startedAt + 90_003)).toMatchObject({
      status: "lost",
    });
    await expect(
      stub.confirmClosed({
        sessionId: created.lease.sessionId,
        leaseId: created.lease.leaseId,
        deviceId: created.lease.deviceId,
        leaseEpoch: created.lease.leaseEpoch,
        browserEpoch: created.lease.browserEpoch,
        now: startedAt + 90_004,
      }),
    ).resolves.toEqual({ status: "lost", newlyClosed: false });
  });

  it("recovers exact same-epoch inventory but preserves suspended collision ownership", async () => {
    vi.useFakeTimers();
    const startedAt = 2_100_000_000_000;
    vi.setSystemTime(startedAt);
    const recoveryStub = coordinator();
    await register(recoveryStub, DEVICE_A, startedAt);
    const created = await recoveryStub.createLease({
      ...leaseInput(1, "https://one.example"),
      now: startedAt + 1,
    });
    if (created.kind !== "created") throw new Error("expected created lease");
    await recoveryStub.markProvisioned({
      sessionId: created.lease.sessionId,
      leaseId: created.lease.leaseId,
      deviceId: created.lease.deviceId,
      leaseEpoch: created.lease.leaseEpoch,
      browserEpoch: created.lease.browserEpoch,
      now: startedAt + 2,
    });
    vi.setSystemTime(startedAt + 90_000);
    await runAlarm(recoveryStub);
    const inventory = [{
      sessionId: created.lease.sessionId,
      leaseId: created.lease.leaseId,
      leaseEpoch: created.lease.leaseEpoch,
      browserEpoch: created.lease.browserEpoch,
      tabId: 7,
      windowId: 8,
    }];
    const heartbeat = await recoveryStub.heartbeat(
      DEVICE_A,
      BROWSER_EPOCH,
      inventory,
      [],
      startedAt + 90_001,
    );
    expect(heartbeat.assignments).toContainEqual(
      expect.objectContaining({ leaseId: created.lease.leaseId, status: "connected" }),
    );

    const capacityStub = coordinator();
    await register(capacityStub, DEVICE_A, startedAt);
    const suspendedLease = await capacityStub.createLease({
      ...leaseInput(2, "https://one.example"),
      now: startedAt + 1,
    });
    if (suspendedLease.kind !== "created") throw new Error("expected created lease");
    await capacityStub.markProvisioned({
      sessionId: suspendedLease.lease.sessionId,
      leaseId: suspendedLease.lease.leaseId,
      deviceId: suspendedLease.lease.deviceId,
      leaseEpoch: suspendedLease.lease.leaseEpoch,
      browserEpoch: suspendedLease.lease.browserEpoch,
      now: startedAt + 2,
    });
    await runAlarm(capacityStub);
    await capacityStub.heartbeat(DEVICE_A, BROWSER_EPOCH, [], [], startedAt + 90_001);
    expect(
      await capacityStub.createLease({
        ...leaseInput(3, "https://one.example"),
        now: startedAt + 90_002,
      }),
    ).toEqual({ kind: "collision" });
    expect(
      await capacityStub.createLease({
        ...leaseInput(4, "https://two.example"),
        now: startedAt + 90_003,
      }),
    ).toMatchObject({ kind: "created" });
  });

  it("bumps the fence when a new browser epoch adopts a suspended lease", async () => {
    vi.useFakeTimers();
    const startedAt = 2_200_000_000_000;
    vi.setSystemTime(startedAt);
    const stub = coordinator();
    await register(stub, DEVICE_A, startedAt);
    const created = await stub.createLease({
      ...leaseInput(1, "https://one.example"),
      now: startedAt + 1,
    });
    if (created.kind !== "created") throw new Error("expected created lease");
    await stub.markProvisioned({
      sessionId: created.lease.sessionId,
      leaseId: created.lease.leaseId,
      deviceId: created.lease.deviceId,
      leaseEpoch: created.lease.leaseEpoch,
      browserEpoch: created.lease.browserEpoch,
      now: startedAt + 2,
    });
    vi.setSystemTime(startedAt + 90_000);
    await runAlarm(stub);

    const registered = await stub.registerDevice({
      deviceId: DEVICE_A,
      browser: "Chrome/126",
      extVersion: "0.2.0",
      browserEpoch: "browser-epoch-2",
      credentialDigest: "b".repeat(64),
      credentialVersion: 2,
      allowedOrigins: [
        "https://one.example",
        "https://two.example",
        "https://three.example",
        "https://four.example",
      ],
      capabilities: ["safe-write-v3"],
      policyVersion: 1,
      authoritySource: "directory",
      acknowledgedPolicyVersion: 1,
      assignments: [],
      ownedWindows: [],
      now: startedAt + 90_001,
    });
    expect(registered).toEqual({ accepted: true, epochChanged: true });
    expect(await stub.getLease(created.lease.sessionId, startedAt + 90_002)).toMatchObject({
      status: "recovering",
      leaseEpoch: created.lease.leaseEpoch + 1,
      browserEpoch: "browser-epoch-2",
      adoptionExpiresAt: null,
    });
  });

  it("requires policy acknowledgement and reports physical inventory divergence and exact orphans", async () => {
    const now = Date.now();
    const stub = coordinator();
    await register(stub, DEVICE_A, now);
    expect(
      await stub.updateDevicePolicy({
        deviceId: DEVICE_A,
        policyVersion: 2,
        allowedOrigins: ["https://one.example", "https://two.example"],
        narrowing: false,
        now: now + 1,
      }),
    ).toBe(true);
    expect(
      await stub.createLease({
        ...leaseInput(1, "https://one.example"),
        now: now + 2,
      }),
    ).toEqual({ kind: "no_device" });
    expect(await stub.acknowledgePolicy(DEVICE_A, BROWSER_EPOCH, 1)).toBe(false);
    expect(await stub.acknowledgePolicy(DEVICE_A, BROWSER_EPOCH, 2)).toBe(true);
    const created = await stub.createLease({
      ...leaseInput(2, "https://one.example"),
      now: now + 3,
    });
    if (created.kind !== "created") throw new Error("expected created lease");
    const orphan = {
      sessionId: "orphan-session",
      leaseId: "orphan-lease",
      leaseEpoch: 1,
      browserEpoch: BROWSER_EPOCH,
      tabId: 70,
      windowId: 80,
    };
    const heartbeat = await stub.heartbeat(DEVICE_A, BROWSER_EPOCH, [], [orphan], now + 4);
    expect(heartbeat.orphans).toEqual([orphan]);
    expect((await stub.listDevices(now + 5))[0]).toMatchObject({
      serverUsed: 1,
      managedAssignments: 0,
      ownedWindows: 1,
      missingOnServer: [],
      missingOnDevice: [created.lease.leaseId],
      diverged: true,
      comparedAt: new Date(now + 4).toISOString(),
      policyVersion: 2,
      acknowledgedPolicyVersion: 2,
    });
  });

  it("reports a same-lease assignment with a stale fence as divergence on both sides", async () => {
    const now = Date.now();
    const stub = coordinator();
    await register(stub, DEVICE_A, now);
    const created = await stub.createLease({
      ...leaseInput(3, "https://one.example"),
      now: now + 1,
    });
    if (created.kind !== "created") throw new Error("expected created lease");

    await stub.heartbeat(
      DEVICE_A,
      BROWSER_EPOCH,
      [{
        sessionId: created.lease.sessionId,
        leaseId: created.lease.leaseId,
        leaseEpoch: created.lease.leaseEpoch + 1,
        browserEpoch: BROWSER_EPOCH,
        tabId: 7,
        windowId: 8,
      }],
      [],
      now + 2,
    );

    expect((await stub.listDevices(now + 3))[0]).toMatchObject({
      missingOnServer: [created.lease.leaseId],
      missingOnDevice: [created.lease.leaseId],
      diverged: true,
    });
  });

  it("advances surviving leases to the new policy fence without widening their origins", async () => {
    const now = Date.now();
    const stub = coordinator();
    await register(stub, DEVICE_A, now);
    const created = await stub.createLease({
      ...leaseInput(1, "https://one.example"),
      now: now + 1,
    });
    if (created.kind !== "created") throw new Error("expected created lease");

    await expect(
      stub.updateDevicePolicy({
        deviceId: DEVICE_A,
        policyVersion: 2,
        allowedOrigins: [
          "https://one.example",
          "https://two.example",
          "https://three.example",
          "https://four.example",
          "https://five.example",
        ],
        narrowing: false,
        now: now + 2,
      }),
    ).resolves.toBe(true);
    await expect(stub.getLease(created.lease.sessionId, now + 3)).resolves.toMatchObject({
      status: "provisioning",
      policyVersion: 2,
      allowedOrigins: ["https://one.example"],
    });
  });
});
