import { describe, expect, it } from "vitest";
import {
  validateCompatibilityMarker,
  validateHealthProvenance,
} from "../scripts/verify-production-compatibility.mjs";

describe("production compatibility deployment gate", () => {
  it("accepts the exact protocol-3 compatibility contract", () => {
    expect(
      validateCompatibilityMarker({
        schemaVersion: 1,
        contractVersion: 3,
        requiredSecrets: [
          "AUTH_HMAC_SECRET",
          "CALLER_TOKENS",
          "DEVICE_TOKENS",
          "EXTENSION_ID",
          "EXTENSION_TOKENS",
          "WS_TICKET_SECRET",
        ],
        files: {
          "apps/backend/scripts/production-config.mjs": "a".repeat(64),
          "apps/backend/scripts/validate-production-config.mjs": "b".repeat(64),
          "apps/backend/src/static-device-config.mjs": "c".repeat(64),
        },
      }),
    ).toMatchObject({ contractVersion: 3 });
  });

  it("requires protocol-3 health provenance", () => {
    expect(() => validateHealthProvenance({ ok: true })).toThrow(/no protocol-3/);
    expect(
      validateHealthProvenance({ ok: true, commit: "a".repeat(40) }),
    ).toBe("a".repeat(40));
  });

  it("rejects required-secret drift", () => {
    expect(() =>
      validateCompatibilityMarker({
        schemaVersion: 1,
        contractVersion: 3,
        requiredSecrets: [],
        files: {
          "apps/backend/scripts/production-config.mjs": "a".repeat(64),
          "apps/backend/scripts/validate-production-config.mjs": "b".repeat(64),
          "apps/backend/src/static-device-config.mjs": "c".repeat(64),
        },
      }),
    ).toThrow(/required-secret/);
  });
});
