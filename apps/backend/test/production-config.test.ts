import { describe, expect, it } from "vitest";
import {
  validateProductionDeviceTokens,
  validateProductionExtensionId,
} from "../scripts/production-config.mjs";
import { verifiedSecretBytes } from "../scripts/put-validated-secret.mjs";
import {
  STAGING_EXTENSION_ID,
  validateStagingConfiguration,
} from "../scripts/staging-config.mjs";

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
    expect(validateProductionExtensionId("lbmbdjjaodgipnleaggclnobbijpadee")).toBe(
      "lbmbdjjaodgipnleaggclnobbijpadee",
    );
  });

  it("rejects a validly shaped ID that is not the published extension", () => {
    expect(() => validateProductionExtensionId("a".repeat(32))).toThrow(
      /published Chrome extension/,
    );
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

describe("staging deployment configuration", () => {
  const valid = {
    AUTH_HMAC_SECRET: "a".repeat(32),
    CALLER_TOKENS: "{}",
    EXTENSION_TOKENS: "{}",
    DEVICE_TOKENS: "{}",
    EXTENSION_ID: STAGING_EXTENSION_ID,
    WS_TICKET_SECRET: "b".repeat(32),
  };

  it("accepts isolated empty token maps and the pinned staging ID", () => {
    expect(validateStagingConfiguration(valid)).toEqual(
      expect.objectContaining({ EXTENSION_ID: expect.stringMatching(/^[0-9a-f]{64}$/) }),
    );
  });

  it("rejects production authority and a mismatched extension ID", () => {
    expect(() =>
      validateStagingConfiguration({ ...valid, CALLER_TOKENS: '{"token":{}}' }),
    ).toThrow(/empty JSON object/);
    expect(() =>
      validateStagingConfiguration({ ...valid, EXTENSION_ID: "a".repeat(32) }),
    ).toThrow(/pinned manifest key/);
  });
});
