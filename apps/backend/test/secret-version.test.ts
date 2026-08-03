import { describe, expect, it } from "vitest";
import { newSecretVersion } from "../scripts/secret-version.mjs";

const OLD_SECRET = {
  id: "old-secret",
  annotations: { "workers/triggered_by": "secret" },
};
const OLD_CODE = {
  id: "old-code",
  annotations: { "workers/triggered_by": "upload" },
};
const NEW_SECRET = {
  id: "new-secret",
  annotations: { "workers/triggered_by": "secret" },
};

describe("secret-derived Worker version attribution", () => {
  it("diffs IDs correctly when Wrangler returns newest-first inventories", () => {
    expect(
      newSecretVersion(
        [OLD_SECRET, OLD_CODE],
        [NEW_SECRET, OLD_SECRET, OLD_CODE],
      ),
    ).toEqual(NEW_SECRET);
  });

  it("rejects missing and ambiguous secret versions", () => {
    expect(() => newSecretVersion([OLD_SECRET], [OLD_SECRET])).toThrow(/exactly one/);
    expect(() =>
      newSecretVersion([OLD_SECRET], [
        { ...NEW_SECRET, id: "new-a" },
        { ...NEW_SECRET, id: "new-b" },
        OLD_SECRET,
      ]),
    ).toThrow(/exactly one/);
  });
});
