#!/usr/bin/env node
/**
 * Seed one vault secret as an AES-256-GCM envelope (never plaintext):
 *
 *   VAULT_MASTER_KEY=<base64url 32B> node scripts/vault-put.mjs <secretRef> [--local]
 *
 * Reads the plaintext from stdin (so it never lands in shell history or
 * `ps`), encrypts it with the same v1.<iv>.<ct> envelope format as
 * src/vault.ts (the two must change together; vault.test.ts pins the
 * format), and writes it via `wrangler kv key put --binding VAULT`.
 * `--local` targets the miniflare dev KV that `wrangler dev` reads;
 * otherwise the write goes to the real remote namespace in wrangler.jsonc.
 * Falls back to VAULT_MASTER_KEY from .dev.vars when --local and the env
 * var is unset.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { webcrypto } from "node:crypto";

const ENVELOPE_VERSION = "v1";
const IV_BYTES = 12;
const MASTER_KEY_BYTES = 32;

function fail(message) {
  console.error(`vault-put: ${message}`);
  process.exit(1);
}

const args = process.argv.slice(2);
const local = args.includes("--local");
const secretRef = args.find((a) => !a.startsWith("--"));
if (!secretRef) fail("usage: node scripts/vault-put.mjs <secretRef> [--local]");

const backendDir = join(dirname(fileURLToPath(import.meta.url)), "..");

function masterKeyFromDevVars() {
  try {
    const devVars = readFileSync(join(backendDir, ".dev.vars"), "utf8");
    const line = devVars.split("\n").find((l) => l.startsWith("VAULT_MASTER_KEY="));
    return line?.slice("VAULT_MASTER_KEY=".length).trim();
  } catch {
    return undefined;
  }
}

const masterKeyB64 = process.env.VAULT_MASTER_KEY ?? (local ? masterKeyFromDevVars() : undefined);
if (!masterKeyB64) {
  fail(
    local
      ? "set VAULT_MASTER_KEY (or put it in .dev.vars)"
      : "set VAULT_MASTER_KEY to the deployed worker's key",
  );
}
const rawKey = Buffer.from(masterKeyB64, "base64url");
if (rawKey.length !== MASTER_KEY_BYTES) fail(`VAULT_MASTER_KEY must decode to ${MASTER_KEY_BYTES} bytes`);

const plaintext = readFileSync(0, "utf8").replace(/\n$/, "");
if (!plaintext) fail("no plaintext on stdin (pipe or type the secret, then EOF)");

const key = await webcrypto.subtle.importKey("raw", rawKey, { name: "AES-GCM" }, false, ["encrypt"]);
const iv = webcrypto.getRandomValues(new Uint8Array(IV_BYTES));
const ciphertext = await webcrypto.subtle.encrypt(
  { name: "AES-GCM", iv },
  key,
  new TextEncoder().encode(plaintext),
);
const envelope = `${ENVELOPE_VERSION}.${Buffer.from(iv).toString("base64url")}.${Buffer.from(
  new Uint8Array(ciphertext),
).toString("base64url")}`;

const wranglerArgs = [
  "exec",
  "wrangler",
  "kv",
  "key",
  "put",
  secretRef,
  envelope,
  "--binding",
  "VAULT",
  local ? "--local" : "--remote",
];
const result = spawnSync("pnpm", wranglerArgs, { cwd: backendDir, stdio: "inherit" });
if (result.status !== 0) fail(`wrangler kv key put exited ${result.status ?? "on a signal"}`);
console.log(`vault-put: sealed ${secretRef} (${local ? "local" : "remote"})`);
