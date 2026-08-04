import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import {
  CALLER_TOKENS,
  EXTENSION_TOKENS,
} from "./test/tokens";

export default defineConfig({
  plugins: [
    cloudflareTest({
      // Reuse the real wrangler config for Durable Object bindings and migrations.
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        // String/JSON vars layered on top of wrangler.jsonc - never real
        // secrets, so these are safe to inline here rather than in
        // wrangler.jsonc or a committed .dev.vars.
        bindings: {
          AUTH_HMAC_SECRET: "test-hmac-secret-do-not-use-in-prod",
          CALLER_TOKENS: JSON.stringify(CALLER_TOKENS),
          EXTENSION_TOKENS: JSON.stringify(EXTENSION_TOKENS),
          DEVICE_TOKENS: "{}",
          EXTENSION_ID: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          // Pinned so the suite's baseline is a TEST value, not whatever the
          // rollout has left in wrangler.jsonc. Without these the allowlists are
          // inherited from a production knob, and editing that knob silently
          // moves every test that does not set them explicitly.
          UNATTENDED_ENABLED_TENANTS: "[]",
          SAFE_WRITE_REQUIRED_TENANTS: "[]",
          WS_TICKET_SECRET: "test-ticket-secret-do-not-use-in-prod",
          QUOTA_POLICY: JSON.stringify({
            sessionCreatesPerActorMinute: 10_000,
            commandsPerSessionMinute: 10_000,
            commandsPerTenantMinute: 100_000,
            deviceTicketsPerDeviceMinute: 10_000,
            sessionCommandCap: 10_000,
          }),
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
    // Durable Object storage is shared across every test/file in the run.
    // Fresh UUID-backed identities keep test resources isolated.
    isolate: false,
    maxWorkers: 1,
  },
});
