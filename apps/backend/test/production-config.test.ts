import { describe, expect, it } from "vitest";
import {
  validateProductionDeviceTokens,
  validateProductionExtensionId,
} from "../scripts/production-config.mjs";
import { verifiedSecretBytes } from "../scripts/put-validated-secret.mjs";

const CANARY_DIGEST = "a".repeat(64);
const DEVICE_ID = "00000000-0000-4000-8000-000000000001";

function tokens(allowedOrigins: unknown, overrides: Record<string, unknown> = {}) {
  return {
    [CANARY_DIGEST]: {
      tenantId: "metamind",
      deviceId: DEVICE_ID,
      credentialVersion: 1,
      allowedOrigins,
      policyVersion: 1,
      ...overrides,
    },
  };
}

describe("production deployment configuration", () => {
  it("accepts the exact runtime static-device contract", () => {
    expect(
      validateProductionDeviceTokens(
        tokens(["https://app.example", "https://checkout.example"]),
        CANARY_DIGEST,
      ),
    ).toEqual({ deviceCount: 1 });
    expect(validateProductionExtensionId("a".repeat(32))).toBe("a".repeat(32));
  });

  it("accepts canonical HTTP loopback origins used by local devices", () => {
    expect(
      validateProductionDeviceTokens(
        tokens(["http://127.0.0.1:8787", "http://localhost:8787"]),
        CANARY_DIGEST,
      ),
    ).toEqual({ deviceCount: 1 });
  });

  it("uploads only the exact bytes whose validation digest was retained", async () => {
    const source = new TextEncoder().encode(JSON.stringify(tokens([])));
    const digest = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", source)),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    expect([...verifiedSecretBytes(source, digest)]).toEqual([...source]);
    expect([
      ...verifiedSecretBytes(new Uint8Array([...source, 10]), digest),
    ]).toEqual([...source]);
    expect(() =>
      verifiedSecretBytes(new Uint8Array([...source, 32, 10, 9, 88]), digest),
    ).toThrow(/changed after validation/);
  });

  it.each([
    ["malformed", ["not an origin"]],
    ["non-HTTPS", ["http://example.com"]],
    ["noncanonical", ["https://example.com/"]],
    ["duplicate", ["https://example.com", "https://example.com"]],
    ["unsorted", ["https://z.example", "https://a.example"]],
  ])("rejects %s allowed origins", (_label, origins) => {
    expect(() =>
      validateProductionDeviceTokens(tokens(origins), CANARY_DIGEST),
    ).toThrow();
  });

  it("rejects a source that omits the supplied canary credential", () => {
    expect(() =>
      validateProductionDeviceTokens(tokens([]), "b".repeat(64)),
    ).toThrow(/canary credential/);
  });

  it("rejects duplicate device authorities", () => {
    const duplicate = {
      ...tokens([]),
      ["b".repeat(64)]: {
        ...tokens([])[CANARY_DIGEST],
      },
    };
    expect(() =>
      validateProductionDeviceTokens(duplicate, CANARY_DIGEST),
    ).toThrow(/more than one credential/);
  });

  it("rejects entry-field contract drift", () => {
    expect(() =>
      validateProductionDeviceTokens(
        tokens([], { extra: true }),
        CANARY_DIGEST,
      ),
    ).toThrow(/fields/);
  });
});
