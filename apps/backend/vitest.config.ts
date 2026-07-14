import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import { CALLER_TOKENS, EXTENSION_TOKENS } from "./test/tokens";

export default defineConfig({
  plugins: [
    cloudflareTest({
      // Reuse the real wrangler config for the SESSION Durable Object
      // binding + migration and the VAULT KV namespace (DL-006, DL-004).
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        // String/JSON vars layered on top of wrangler.jsonc - never real
        // secrets, so these are safe to inline here rather than in
        // wrangler.jsonc or a committed .dev.vars.
        bindings: {
          AUTH_HMAC_SECRET: "test-hmac-secret-do-not-use-in-prod",
          CALLER_TOKENS: JSON.stringify(CALLER_TOKENS),
          EXTENSION_TOKENS: JSON.stringify(EXTENSION_TOKENS),
        },
      },
    }),
  ],
  test: {
    // session.test.ts and service.test.ts open real WebSocket connections
    // to the SessionAgent Durable Object. Per Cloudflare's
    // vitest-pool-workers known issues: "Using WebSockets with Durable
    // Objects is not supported with per-file storage isolation" - the
    // documented workaround is shared storage via `--max-workers=1
    // --no-isolate`, expressed here as config so `vitest run` needs no
    // extra flags.
    //
    // This also means storage (Durable Object state AND the VAULT KV
    // namespace) is shared across every test/file in the run, not reset
    // per file. That's safe here because every session is keyed by a fresh
    // crypto.randomUUID() sessionId, and every seeded vault secret uses a
    // distinct vault:// key - so no two tests can collide on the same
    // storage key even though nothing resets between them.
    isolate: false,
    maxWorkers: 1,
  },
});
