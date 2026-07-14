// Throwaway M2 verification stub — NOT a workspace member; run via `node`.
//
// Proves the extension emits schema-valid Events over the REAL WebSocket wire
// (the very thing M3's Hono backend replaces) and lets a human drive protocol
// Commands from stdin. Every inbound socket message is validated with the real
// @understudy/protocol schemas, so a violation is impossible to miss — that is
// the M2 acceptance signal. Also doubles as a reference for M3's onMessage.
//
// Requires the protocol dist/ to be built (`pnpm --filter @understudy/protocol
// build`), which the workspace symlink resolves to. See RUNBOOK.md for the full
// verification steps and copy-pasteable command lines.

import { WebSocket, WebSocketServer } from "ws";
import { safeParseCommand, safeParseEvent } from "@understudy/protocol";
import { createInterface } from "node:readline";

const PORT = 8787;
const wss = new WebSocketServer({ port: PORT });

/** The single connected extension socket (last connection wins). */
let socket = null;
/** Auto-increment id used when a typed command omits its commandId. */
let commandSeq = 1;

console.log(`listening ws://localhost:${PORT}`);
console.log(
  "type JSON command lines below — blank lines and #comments are skipped; commandId is auto-filled\n",
);

// ── a11y tree helpers (snapshot_result carries a nested A11yNode[]) ───────────

function countNodes(nodes) {
  let total = 0;
  for (const node of nodes) {
    total += 1;
    if (node.children) total += countNodes(node.children);
  }
  return total;
}

// DFS-print up to budget.left nodes, indented by depth so a ref copies by eye.
function printNodes(nodes, depth, budget) {
  for (const node of nodes) {
    if (budget.left <= 0) return;
    budget.left -= 1;
    const name = node.name ? `  "${node.name}"` : "";
    const value = node.value ? `  =${JSON.stringify(node.value)}` : "";
    console.log(`  ${"  ".repeat(depth)}${node.ref}  ${node.role}${name}${value}`);
    if (node.children) printNodes(node.children, depth + 1, budget);
  }
}

// ── pretty-printers, one per Event.type (all 7 union members) ────────────────

function printEvent(ev) {
  switch (ev.type) {
    case "hello":
      console.log(
        `< hello             browser=${ev.browser}  ext=v${ev.extVersion}  tabs=${ev.tabs.length}`,
      );
      break;
    case "snapshot_result":
      console.log(
        `< snapshot_result   [${ev.commandId}]  ${countNodes(ev.tree)} nodes (first 15 shown — copy a ref):`,
      );
      printNodes(ev.tree, 0, { left: 15 });
      break;
    case "screenshot_result":
      console.log(
        `< screenshot_result [${ev.commandId}]  ${ev.mime}  ${ev.b64.length} b64 chars`,
      );
      break;
    case "tabs_result":
      console.log(`< tabs_result       [${ev.commandId}]  ${ev.tabs.length} tabs:`);
      for (const t of ev.tabs) {
        console.log(
          `    tabId=${t.tabId}${t.active ? " (active)" : ""}  ${JSON.stringify(t.title)}  ${t.url}`,
        );
      }
      break;
    case "action_result": {
      const parts = [`ok=${ev.ok}`];
      if (ev.error !== undefined) parts.push(`error=${JSON.stringify(ev.error)}`);
      if (ev.url !== undefined) parts.push(`url=${ev.url}`);
      console.log(`< action_result    [${ev.commandId}]  ${parts.join("  ")}`);
      break;
    }
    case "page_event":
      console.log(`< page_event        ${ev.kind}  tabId=${ev.tabId}  ${ev.url}`);
      break;
    case "pong":
      console.log(`< pong              · ${new Date().toLocaleTimeString()}`);
      break;
  }
}

// ── inbound: validate EVERY message against the real Event schema ────────────

wss.on("connection", (ws) => {
  socket = ws;
  console.log("\n* extension connected\n");

  ws.on("message", (data) => {
    let parsed;
    try {
      parsed = JSON.parse(data.toString());
    } catch (err) {
      console.error(`! ignoring non-JSON message from socket: ${err.message}`);
      return;
    }

    const result = safeParseEvent(parsed);
    if (!result.success) {
      // THE M2 acceptance signal: an emitted event failed the real schema.
      console.error("\n!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
      console.error("!!!!!  EVENT SCHEMA VIOLATION  !!!!!");
      console.error("raw event:", JSON.stringify(parsed));
      console.error("issues:", JSON.stringify(result.error.issues, null, 2));
      console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n");
      return;
    }
    printEvent(result.data);
  });

  ws.on("close", () => {
    if (socket === ws) socket = null;
    console.log("\n* extension disconnected\n");
  });
  ws.on("error", (err) => console.error(`! socket error: ${err.message}`));
});

wss.on("error", (err) => console.error(`! server error: ${err.message}`));

// ── outbound: read stdin lines, validate as Commands, send ───────────────────

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const text = line.trim();
  if (!text || text.startsWith("#")) return;

  let cmd;
  try {
    cmd = JSON.parse(text);
  } catch (err) {
    console.error(`! not valid JSON, ignored: ${err.message}`);
    return;
  }

  if (cmd && typeof cmd === "object" && !Array.isArray(cmd) && cmd.commandId == null) {
    cmd.commandId = `c${commandSeq++}`;
  }

  const result = safeParseCommand(cmd);
  if (!result.success) {
    console.error("! invalid command — NOT sent. issues:");
    console.error(JSON.stringify(result.error.issues, null, 2));
    return;
  }
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    console.error(
      "! no extension connected — open the side panel and click Attach, then resend this line.",
    );
    return;
  }

  socket.send(JSON.stringify(result.data));
  console.log(`> sent ${JSON.stringify(result.data)}`);
});
