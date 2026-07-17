#!/usr/bin/env node
/**
 * M3 runbook harness (M-008).
 *
 * A throwaway Node script, NOT a workspace member (no package.json, no
 * dependency install - Node >=22's built-in global `fetch` is the only
 * requirement). It stands in for a real breakwater-governed consumer
 * (metamind / smart-compliance) WITHOUT importing Mastra/breakwater/flowsafe
 * (DL-001): it drives understudy's command API directly over plain
 * HTTP/JSON, the same way any governed consumer's connector would.
 *
 * USER-RUN ATTENDED STEPS:
 *   1. Start the service:  pnpm --filter @understudy/backend dev
 *      (wrangler dev - configure .dev.vars first; see .dev.vars.example)
 *   2. Run this script:    node apps/backend/scripts/stub-consumer.mjs
 *      It opens a session and prints the WebSocket URL below.
 *   3. Load the M2 extension (apps/extension) in a real, logged-in
 *      Chromium and connect it to that printed WS URL.
 *   4. Press Enter in this terminal once the extension shows connected.
 *   5. Watch snapshot -> type -> click -> fill_secret drive the page; each
 *      returned Event is printed as it comes back.
 *
 * Without the extension connected, every command below will time out (the
 * service's per-command timeout - 30s by default) because nothing ever
 * answers the forwarded command. The `POST /v1/sessions` step (through
 * printing the WS URL) is verifiable standalone, with no extension attached.
 *
 * `type` and `click` target the first ref found in the snapshot's a11y tree
 * (a naive "first element" heuristic - fine for a demo/runbook, not real
 * ref-targeting logic). `fill_secret` deliberately uses a fake, tenant-scoped
 * secretRef (`vault://dev-tenant/…`) the vault has no value for, so it is
 * expected to return ok:false - demonstrating the scrubbed-error path, not a
 * broken script. (fillSecret enforces `vault://<tenantId>/…` scoping: a ref
 * outside the caller's own tenant is refused with the same scrubbed ok:false.)
 * A stale/unresolvable ref for any command is likewise expected to return
 * ok:false, not to fail the run.
 *
 * Env vars / flags (all optional; flags win, then env vars, then defaults):
 *   BASE_URL / --base-url             HTTP origin of the service.
 *                                      Default: http://localhost:8787
 *   CALLER_TOKEN / --caller-token     Bearer token for a CALLER_TOKENS entry.
 *                                      Default: dev-caller-token
 *   EXTENSION_TOKEN / --extension-token  The extension's per-user token,
 *                                      embedded in the printed WS URL.
 *                                      Default: dev-ext-token
 *
 * The defaults above match apps/backend/.dev.vars.example.
 */

import { createInterface } from "node:readline/promises";

function argValue(flag) {
  const prefix = `--${flag}=`;
  const found = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

const BASE_URL = argValue("base-url") ?? process.env.BASE_URL ?? "http://localhost:8787";
const CALLER_TOKEN = argValue("caller-token") ?? process.env.CALLER_TOKEN ?? "dev-caller-token";
const EXTENSION_TOKEN =
  argValue("extension-token") ?? process.env.EXTENSION_TOKEN ?? "dev-ext-token";

function wsBase(httpBase) {
  return httpBase.replace(/^http/, "ws");
}

async function postJson(path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${CALLER_TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${path} -> HTTP ${res.status} (non-JSON body): ${text}`);
  }
  if (!res.ok) {
    throw new Error(`${path} -> HTTP ${res.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

async function sendCommand(sessionId, command) {
  const event = await postJson(`/v1/sessions/${sessionId}/commands`, { command });
  console.log(`<- ${command.type} (${command.commandId}):`, JSON.stringify(event));
  return event;
}

/** Naive "first ref in the tree" pick - see the header comment. */
function findFirstRef(nodes) {
  for (const node of nodes ?? []) {
    if (node.ref) return node.ref;
    const fromChildren = findFirstRef(node.children);
    if (fromChildren) return fromChildren;
  }
  return undefined;
}

async function main() {
  console.log("understudy stub consumer - M3 runbook harness");
  console.log(`BASE_URL=${BASE_URL}`);

  const { sessionId } = await postJson("/v1/sessions", {});
  console.log(`\nsession opened: ${sessionId}`);

  const wsUrl = `${wsBase(BASE_URL)}/agents/session/${sessionId}?token=${EXTENSION_TOKEN}`;
  console.log("\nLoad the M2 extension in a real, logged-in Chromium and connect it to:");
  console.log(`  ${wsUrl}\n`);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await rl.question("Press Enter once the extension shows connected... ");
  rl.close();

  console.log("\ndriving the session: snapshot -> type -> click -> fill_secret\n");

  const snapshotEvent = await sendCommand(sessionId, {
    type: "snapshot",
    commandId: "stub-1",
    mode: "a11y",
  });
  const ref = snapshotEvent.type === "snapshot_result" ? findFirstRef(snapshotEvent.tree) : undefined;
  if (!ref) {
    console.log("(no ref found in the snapshot - type/click below will return ok:false)");
  }
  const targetRef = ref ?? "no-such-ref";

  await sendCommand(sessionId, {
    type: "type",
    commandId: "stub-2",
    ref: targetRef,
    text: "hello from the stub consumer",
  });
  await sendCommand(sessionId, { type: "click", commandId: "stub-3", ref: targetRef });
  await sendCommand(sessionId, {
    type: "fill_secret",
    commandId: "stub-4",
    ref: targetRef,
    // Deliberately fake and unresolvable - see the header comment. Scoped to
    // the default dev tenant so it exercises the vault-miss path; a ref outside
    // the caller's tenant is refused with the same scrubbed ok:false.
    secretRef: "vault://dev-tenant/stub-consumer-fake-secret",
  });

  console.log("\ndone.");
}

main().catch((err) => {
  console.error("stub-consumer failed:", err);
  process.exitCode = 1;
});
