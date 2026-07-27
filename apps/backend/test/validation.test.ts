import { describe, expect, it } from "vitest";
import { CommandRequestSchema } from "@understudy/protocol";
import { canonicalizeOrigins, parseBoundedStrictJson, RequestBodyError } from "../src/validation";

describe("parseBoundedStrictJson", () => {
  it("rejects oversized declared and streamed bodies before schema use", async () => {
    const declared = new Request("https://understudy.example/commands", {
      method: "POST",
      headers: { "content-length": "1025" },
      body: "{}",
    });
    await expect(
      parseBoundedStrictJson(declared, CommandRequestSchema, 1024),
    ).rejects.toMatchObject({ status: 413, category: "size" });

    const streamed = new Request("https://understudy.example/commands", {
      method: "POST",
      body: JSON.stringify({ value: "x".repeat(2048) }),
    });
    await expect(
      parseBoundedStrictJson(streamed, CommandRequestSchema, 1024),
    ).rejects.toMatchObject({ status: 413, category: "size" });
  });

  it("distinguishes syntax from strict schema failures", async () => {
    const syntax = new Request("https://understudy.example/commands", {
      method: "POST",
      body: "{",
    });
    await expect(
      parseBoundedStrictJson(syntax, CommandRequestSchema),
    ).rejects.toMatchObject({ category: "syntax" });

    const schema = new Request("https://understudy.example/commands", {
      method: "POST",
      body: JSON.stringify({
        command: { type: "get_tabs", commandId: "c" },
        dryRun: false,
        extra: true,
      }),
    });
    await expect(
      parseBoundedStrictJson(schema, CommandRequestSchema),
    ).rejects.toMatchObject({ category: "schema" });
  });
});

describe("canonicalizeOrigins", () => {
  it("canonicalizes, deduplicates, and sorts exact origins", () => {
    expect(
      canonicalizeOrigins([
        "https://B.example:443/",
        "http://localhost:8787",
        "https://b.example",
        "https://a.example",
      ]),
    ).toEqual([
      "http://localhost:8787",
      "https://a.example",
      "https://b.example",
    ]);
  });

  it.each([
    "http://example.com",
    "https://*.example.com",
    "https://user@example.com",
    "https://example.com/path",
    "https://example.com?",
    "https://example.com#",
    " https://example.com",
  ])("rejects unsafe or non-origin input %s", (origin) => {
    expect(() => canonicalizeOrigins([origin])).toThrow(RequestBodyError);
  });
});
