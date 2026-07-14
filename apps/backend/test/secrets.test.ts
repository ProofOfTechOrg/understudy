import { describe, it, expect, vi } from "vitest";
import type { VaultBinding } from "../src/types";
import { resolveSecret, SecretResolutionError } from "../src/secrets";

function makeVault(): VaultBinding {
  return {
    get: async (ref) => (ref === "vault://good" ? "hunter2" : null),
  };
}

describe("resolveSecret", () => {
  it("resolves the plaintext for a valid handle", async () => {
    const vault = makeVault();
    await expect(resolveSecret(vault, "vault://good")).resolves.toBe("hunter2");
  });

  it("rejects with SecretResolutionError for a missing handle, with no plaintext in the message", async () => {
    const vault = makeVault();

    await expect(resolveSecret(vault, "vault://missing")).rejects.toThrow(
      SecretResolutionError,
    );

    try {
      await resolveSecret(vault, "vault://missing");
      expect.unreachable("resolveSecret should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SecretResolutionError);
      expect((err as Error).message).not.toContain("hunter2");
    }
  });

  it("never logs the plaintext on a successful resolve", async () => {
    const vault = makeVault();
    const spies = [
      vi.spyOn(console, "log").mockImplementation(() => {}),
      vi.spyOn(console, "error").mockImplementation(() => {}),
      vi.spyOn(console, "warn").mockImplementation(() => {}),
      vi.spyOn(console, "info").mockImplementation(() => {}),
      vi.spyOn(console, "debug").mockImplementation(() => {}),
    ];

    try {
      const result = await resolveSecret(vault, "vault://good");
      expect(result).toBe("hunter2");

      for (const spy of spies) {
        for (const call of spy.mock.calls) {
          for (const arg of call) {
            expect(String(arg)).not.toContain("hunter2");
          }
        }
      }
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
