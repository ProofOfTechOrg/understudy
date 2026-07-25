import { describe, expect, it } from "vitest";
import type { Command } from "@understudy/protocol";
import { WriteDedupe, type SessionStorageArea } from "./dedupe";
import { CommandIngress } from "./command-ingress";

const WRITE: Command = {
  type: "navigate",
  commandId: "write-first",
  url: "https://example.com/next",
};
const READ: Command = { type: "snapshot", commandId: "read-second", mode: "a11y" };

describe("CommandIngress", () => {
  it("preserves wire order when an earlier write waits for dedupe hydration", async () => {
    let releaseHydration!: (value: Record<string, unknown>) => void;
    const storage: SessionStorageArea = {
      get: () =>
        new Promise((resolve) => {
          releaseHydration = resolve;
        }),
      set: async () => {},
      remove: async () => {},
    };
    const dedupe = new WriteDedupe(storage);
    const ingress = new CommandIngress();
    const started: string[] = [];

    const write = ingress.enqueue(async () => {
      await dedupe.claim(WRITE);
      started.push(WRITE.commandId);
      return { completion: Promise.resolve() };
    });
    const read = ingress.enqueue(async () => {
      await dedupe.claim(READ);
      started.push(READ.commandId);
      return { completion: Promise.resolve() };
    });

    await Promise.resolve();
    expect(started).toEqual([]);

    releaseHydration({});
    await Promise.all([write, read]);

    expect(started).toEqual(["write-first", "read-second"]);
  });

  it("runs an invalidation barrier after every already-started execution settles", async () => {
    let finishSnapshot!: () => void;
    const ingress = new CommandIngress();
    const calls: string[] = [];

    await ingress.enqueue(async () => {
      calls.push("snapshot:start");
      return {
        completion: new Promise<void>((resolve) => {
          finishSnapshot = () => {
            calls.push("snapshot:finish");
            resolve();
          };
        }),
      };
    });
    const barrier = ingress.barrier(async () => {
      calls.push("invalidate");
    });

    await Promise.resolve();
    expect(calls).toEqual(["snapshot:start"]);

    finishSnapshot();
    await barrier;

    expect(calls).toEqual(["snapshot:start", "snapshot:finish", "invalidate"]);
  });

  it("keeps an accepted command's response bound to its old peer across a switch barrier", async () => {
    let finish!: () => void;
    const ingress = new CommandIngress();
    const oldPeer: string[] = [];
    const newPeer: string[] = [];
    let activePeer = oldPeer;

    await ingress.enqueue(async () => {
      const acceptedPeer = activePeer;
      return {
        completion: new Promise<void>((resolve) => {
          finish = () => {
            acceptedPeer.push("snapshot_result");
            resolve();
          };
        }),
      };
    });
    const switching = ingress.barrier(async () => {
      activePeer = newPeer;
    });

    finish();
    await switching;

    expect(oldPeer).toEqual(["snapshot_result"]);
    expect(newPeer).toEqual([]);
  });
});
