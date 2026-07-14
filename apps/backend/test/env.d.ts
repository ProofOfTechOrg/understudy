// Ambient typing for the pool-provided `env` (both the deprecated
// `cloudflare:test` export and `cloudflare:workers`'s `env`/`exports` share
// the same `Cloudflare.Env` / `Cloudflare.GlobalProps` merge point) so
// `env.SESSION`, `env.VAULT`, etc. and `exports.default.fetch(...)` resolve
// against this package's own Env instead of `{}`. No wrangler-generated
// worker-configuration.d.ts exists in this package (Env is hand-authored in
// src/types.ts), so this file is hand-authored too, mirroring the shape
// `wrangler types` would otherwise generate.
//
// The `extends` clause below must reference a named type alias, not an
// inline `import("...")` type: `interface Env extends import("...").Env {}`
// silently fails to merge (verified empirically against the installed
// @cloudflare/vitest-pool-workers@0.18.0 + @cloudflare/workers-types -
// `keyof typeof env` resolved to `never`), which is also why Wrangler's own
// generated env.d.ts routes through a named `__BaseEnv_Env` indirection
// instead of inlining the import.
type BackendEnv = import("../src/types").Env;

declare namespace Cloudflare {
  interface Env extends BackendEnv {}
  interface GlobalProps {
    mainModule: typeof import("../src/index");
    durableNamespaces: "SessionAgent";
  }
}

interface Env extends BackendEnv {}
