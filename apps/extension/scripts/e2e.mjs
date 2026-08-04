import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import WebSocket, { WebSocketServer } from "ws";

class CdpClient {
  static connect(url) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      socket.once("open", () => resolve(new CdpClient(socket)));
      socket.once("error", reject);
    });
  }

  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result ?? {});
        return;
      }
      if (message.method) this.events.push(message);
    });
  }

  call(method, params = {}, sessionId) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  close() {
    this.socket.close();
  }
}

const storeExtensionDir = path.resolve(".output/chrome-mv3-store");
const extensionDir = path.resolve(".output/chrome-mv3-e2e");
const storeManifest = JSON.parse(
  await readFile(path.join(storeExtensionDir, "manifest.json"), "utf8"),
);
const manifest = JSON.parse(await readFile(path.join(extensionDir, "manifest.json"), "utf8"));
if (storeManifest.version !== "0.2.0" || manifest.version !== "0.2.0") {
  throw new Error("unexpected extension build version");
}

const chromePath = await findChrome();
const testDir = await mkdtemp(path.join(tmpdir(), "understudy-extension-e2e-"));
const profileDir = path.join(testDir, "chrome-profile");
await generateCertificate(testDir);
const localService = await startLocalService(testDir);
let chromeStderr = "";
let chrome = launchChrome();

function launchChrome() {
  const child = spawn(chromePath, [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--ignore-certificate-errors",
    "--allow-insecure-localhost",
    "--disable-extensions-except=" + extensionDir,
    "--load-extension=" + extensionDir,
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-port=0",
    "--user-data-dir=" + profileDir,
    "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"], detached: true });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    chromeStderr = (chromeStderr + chunk).slice(-8_000);
  });
  return child;
}

let client;
const observedEvents = [];
try {
  const debuggerUrl = await devtoolsUrl(profileDir, chrome);
  client = await CdpClient.connect(debuggerUrl);
  let worker = await attachWorker(client);
  let panel = await attachExtensionPage(client, worker.url);
  const rawPage = await attachExtensionPage(client, worker.url, "unattended-bootstrap.html");
  await client.call("Runtime.enable", {}, worker.sessionId);
  await client.call("Network.enable", {}, worker.sessionId).catch(() => {});
  await client.call("Network.enable", {}, panel.sessionId).catch(() => {});

  const loadedManifest = await evaluate(client, worker.sessionId, "chrome.runtime.getManifest()");
  assert(loadedManifest.version === "0.2.0", "loaded extension has wrong version");
  assert(
    JSON.stringify(loadedManifest.externally_connectable?.matches) ===
      JSON.stringify(["https://understudy.proofof.tech/*"]),
    "externally_connectable widened beyond the canonical dashboard origin",
  );

  ({ worker, panel } = await verifyVaultSchemaCompatibility(
    client,
    worker,
    panel,
    rawPage,
  ));

  const marker = `UNDERSTUDY_E2E_${Date.now()}`;
  const initial = await panelCommand(client, panel.sessionId, { type: "getState" },
    "state.cardVault.revision === 0");
  assert(initial.cardVault.aliases.length === 0, "vault was not empty in a fresh Chrome profile");

  const saved = await panelCardSave(
    client,
    panel.sessionId,
    {
      alias: "e2e-card",
      cardholderName: marker,
      pan: "4111111111111111",
      expiryMonth: "12",
      expiryYear: "2099",
      cvv: "123",
    },
  );
  assert(!JSON.stringify(saved).includes(marker), "card marker escaped through extension state");
  await panelCommand(
    client,
    panel.sessionId,
    { type: "setPaymentOrigins", origins: [localService.origin] },
    `state.cardVault.approvedOrigins.includes(${JSON.stringify(localService.origin)})`,
  );

  const beforeRestart = await inspectVault(client, panel.sessionId);
  assert(beforeRestart.cards === 1, "encrypted record was not persisted");
  assert(beforeRestart.keyExtractable === false, "persisted AES key is extractable");
  assert(beforeRestart.ivBytes === 12, "persisted AES-GCM IV is not 96 bits");
  assert(!JSON.stringify(beforeRestart).includes(marker), "card marker escaped through vault metadata");

  observedEvents.push(...client.events);
  client.close();
  await stopChrome(chrome);
  chromeStderr = "";
  chrome = launchChrome();
  client = await CdpClient.connect(await devtoolsUrl(profileDir, chrome));
  worker = await attachWorker(client);
  panel = await attachExtensionPage(client, worker.url);
  await client.call("Runtime.enable", {}, worker.sessionId);
  await client.call("Network.enable", {}, panel.sessionId).catch(() => {});
  const restored = await panelCommand(
    client,
    panel.sessionId,
    { type: "getState" },
    "state.cardVault.aliases.includes('e2e-card')",
  );
  assert(restored.cardVault.approvedOrigins.includes(localService.origin),
    "payment-origin policy did not survive extension restart");
  const afterRestart = await inspectVault(client, panel.sessionId);
  assert(afterRestart.cards === 1 && afterRestart.keyExtractable === false,
    "vault key or record did not survive extension restart");

  await panelCommand(
    client,
    panel.sessionId,
    {
      type: "configureProfile",
      serviceOrigin: localService.origin,
      enabled: true,
      deviceId: localService.deviceId,
      deviceCredential: "udt_v2_" + "a".repeat(43),
      originPolicy: [localService.origin],
      policyVersion: 1,
    },
    "state.profileStatus === 'connected'",
  );
  await localService.waitFor(
    (event) => event.kind === "control" && event.frame.type === "device_hello",
  );

  const browser = { client, worker, panel };
  await runSemanticElements(browser, localService);
  await runInterruptedPayment(browser, localService, marker, "before-insertion");
  await runInterruptedPayment(browser, localService, marker, "after-insertion");
  await runCheckpointedPayment(browser, localService, marker);
  worker = browser.worker;

  await panelCommand(
    client,
    panel.sessionId,
    { type: "deleteCardVault" },
    "state.cardVault.aliases.length === 0 && state.cardVault.approvedOrigins.length === 0",
  );
  const deleted = await inspectVault(client, panel.sessionId);
  assert(deleted.cards === 0 && deleted.hasKey === false,
    "explicit vault deletion left records or key material behind");

  const leaked = [...observedEvents, ...client.events].some((event) =>
    /^(Network\.|Runtime\.consoleAPICalled|Runtime\.exceptionThrown)/.test(event.method) &&
    JSON.stringify(event.params).includes(marker),
  );
  assert(!leaked, "card marker escaped through network, console, or exception events");
  process.stdout.write(
    "extension E2E passed: bounded semantic discovery, frame/shadow capture, deltas, vault restart, real CDP submission, worker-eviction recovery, deletion, and marker non-egress\n",
  );
} catch (error) {
  if (chromeStderr.length > 0) process.stderr.write(chromeStderr);
  throw error;
} finally {
  client?.close();
  await stopChrome(chrome);
  await localService.close();
  await removeProfile(testDir);
}

async function generateCertificate(directory) {
  await runProcess("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    path.join(directory, "localhost.key"),
    "-out",
    path.join(directory, "localhost.crt"),
    "-subj",
    "/CN=127.0.0.1",
    "-addext",
    "subjectAltName=IP:127.0.0.1",
    "-days",
    "1",
  ]);
}

function runProcess(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code}`));
    });
  });
}

async function startLocalService(directory) {
  const events = [];
  const waiters = new Set();
  const sessionSockets = new Map();
  let controlSocket = null;
  let browserEpoch = null;
  const deviceId = "00000000-0000-4000-8000-0000000000e2";
  const key = await readFile(path.join(directory, "localhost.key"));
  const cert = await readFile(path.join(directory, "localhost.crt"));
  const server = createServer({ key, cert }, (request, response) => {
    const url = new URL(request.url ?? "/", "https://127.0.0.1");
    if (url.pathname === "/v1/device/connect-ticket" && request.method === "POST") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        ticket: "e2e-control-ticket",
        expiresIn: 60,
        websocketPath: "/control",
        allowedOrigins: [service.origin],
        policyVersion: 1,
      }));
      return;
    }
    if (url.pathname === "/checkout") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(checkoutPage(url.searchParams.get("stage") ?? "checkpoint"));
      return;
    }
    if (url.pathname === "/semantic") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(semanticPage(service.origin));
      return;
    }
    if (url.pathname === "/semantic-frame") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(semanticFramePage(url.searchParams.get("kind") ?? "same"));
      return;
    }
    if (url.pathname === "/signal" && request.method === "POST") {
      emit({ kind: "signal", stage: url.searchParams.get("stage") });
      response.writeHead(204);
      response.end();
      return;
    }
    response.writeHead(404);
    response.end("not found");
  });
  const wss = new WebSocketServer({ noServer: true });
  const service = {
    origin: "",
    deviceId,
    cursor: () => events.length,
    waitFor,
    async waitForControl() {
      if (controlSocket?.readyState === WebSocket.OPEN) return;
      const after = events.length;
      await waitFor(
        (event) => event.kind === "control" && event.frame.type === "device_hello",
        after,
      );
    },
    sendControl(frame) {
      if (controlSocket?.readyState !== WebSocket.OPEN) {
        throw new Error("control socket is not open");
      }
      controlSocket.send(JSON.stringify(frame));
    },
    sendSession(sessionId, frame) {
      const socket = sessionSockets.get(sessionId);
      if (socket?.readyState !== WebSocket.OPEN) {
        throw new Error(`session socket ${sessionId} is not open`);
      }
      socket.send(JSON.stringify(frame));
    },
    browserEpoch: () => browserEpoch,
    events,
    async close() {
      for (const socket of wss.clients) socket.close();
      await new Promise((resolve) => wss.close(resolve));
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    },
  };
  server.on("upgrade", (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (websocket) => {
      const url = new URL(request.url ?? "/", service.origin);
      if (url.pathname === "/control") {
        controlSocket = websocket;
        emit({ kind: "control_open" });
        websocket.on("message", (raw) => {
          const text = raw.toString();
          assert(!text.includes("UNDERSTUDY_E2E_"), "card marker escaped over control WSS");
          const frame = JSON.parse(text);
          if (frame.type === "device_hello") browserEpoch = frame.browserEpoch;
          emit({ kind: "control", frame });
          if (frame.type === "closed") {
            websocket.send(JSON.stringify({ type: "closed_ack", ...closureFence(frame) }));
          }
        });
        websocket.on("close", () => {
          if (controlSocket === websocket) controlSocket = null;
          emit({ kind: "control_close" });
        });
        websocket.on("error", () => {});
        return;
      }
      const match = url.pathname.match(/^\/agents\/session\/([^/]+)$/);
      if (match === null) {
        websocket.close(1008, "unknown test socket");
        return;
      }
      const sessionId = decodeURIComponent(match[1]);
      sessionSockets.set(sessionId, websocket);
      emit({ kind: "session_open", sessionId });
      websocket.on("message", (raw) => {
        const text = raw.toString();
        assert(!text.includes("UNDERSTUDY_E2E_"), "card marker escaped over session WSS");
        emit({ kind: "session", sessionId, frame: JSON.parse(text) });
      });
      websocket.on("close", () => {
        if (sessionSockets.get(sessionId) === websocket) sessionSockets.delete(sessionId);
        emit({ kind: "session_close", sessionId });
      });
      websocket.on("error", () => {});
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test server has no port");
  service.origin = `https://127.0.0.1:${address.port}`;
  return service;

  function emit(event) {
    const indexed = { ...event, index: events.length };
    events.push(indexed);
    for (const wake of [...waiters]) wake();
  }

  function waitFor(predicate, after = 0, timeoutMs = 15_000) {
    const existing = events.slice(after).find(predicate);
    if (existing !== undefined) return Promise.resolve(existing);
    const requestedAt = new Error("wait requested here").stack;
    return new Promise((resolve, reject) => {
      let timer;
      const wake = () => {
        const found = events.slice(after).find(predicate);
        if (found === undefined) return;
        clearTimeout(timer);
        waiters.delete(wake);
        resolve(found);
      };
      timer = setTimeout(() => {
        waiters.delete(wake);
        reject(new Error(
          `local-service event timeout after index ${after}: ${events
            .slice(after)
            .map((event) => `${event.index}:${event.kind}:${JSON.stringify(event.frame ?? event.stage ?? "")}`)
            .join(" | ")}\n${requestedAt}`,
        ));
      }, timeoutMs);
      waiters.add(wake);
    });
  }
}

function checkoutPage(stage) {
  const signal = stage === "before-insertion"
    ? `for (const field of document.querySelectorAll("input")) {
         field.addEventListener("focus", signalAndBlock, { once: true });
       }`
    : stage === "after-insertion"
      ? `document.querySelector("#number").addEventListener("input", signalAndBlock, { once: true });`
      : "";
  return `<!doctype html>
    <html><body>
      <label>Name <input id="name" aria-label="Cardholder name"></label>
      <label>Number <input id="number" aria-label="Card number"></label>
      <label>Expiration <input id="expiry" aria-label="Expiration"></label>
      <label>CVV <input id="cvv" aria-label="CVV"></label>
      <button id="submit" type="button">Submit payment</button>
      <script>
        let signaled = false;
        function signalAndBlock() {
          if (signaled) return;
          signaled = true;
          fetch("/signal?stage=${stage}", { method: "POST", keepalive: true });
          const until = performance.now() + 8000;
          while (performance.now() < until) {}
        }
        ${signal}
      </script>
    </body></html>`;
}

function semanticPage(origin) {
  const port = new URL(origin).port;
  const elements = Array.from(
    { length: 10_000 },
    (_, index) =>
      (index + 1) % 20 === 0
        ? `<button type="button">Fixture button ${index + 1}</button>`
        : `<div aria-hidden="true"></div>`,
  ).join("");
  return `<!doctype html>
    <html><body>
      <main>
        <h1>Semantic element fixture</h1>
        <div id="status" role="status" aria-live="polite">Waiting for update</div>
        <button id="update" type="button">Update semantic status</button>
        <button id="replaceable" type="button">Replaceable target</button>
        <iframe title="Same-process fixture" src="/semantic-frame?kind=same"></iframe>
        <iframe title="Cross-origin fixture" src="https://localhost:${port}/semantic-frame?kind=oopif"></iframe>
        <div id="shadow-host"></div>
        ${elements}
        <button type="button">Late offscreen target</button>
      </main>
      <script>
        document.querySelector("#update").addEventListener("click", () => {
          document.querySelector("#status").textContent = "Semantic status updated";
        });
        document.querySelector("#replaceable").addEventListener("mouseenter", (event) => {
          const replacement = document.createElement("button");
          replacement.type = "button";
          replacement.textContent = "Replacement target";
          event.currentTarget.replaceWith(replacement);
        }, { once: true });
        const root = document.querySelector("#shadow-host").attachShadow({ mode: "open" });
        const shadowButton = document.createElement("button");
        shadowButton.textContent = "Shadow DOM target";
        root.append(shadowButton);
      </script>
    </body></html>`;
}

function semanticFramePage(kind) {
  const name = kind === "oopif" ? "OOPIF frame target" : "Same-process frame target";
  return `<!doctype html><html><body><button type="button">${name}</button></body></html>`;
}

function closureFence(frame) {
  return {
    sessionId: frame.sessionId,
    leaseId: frame.leaseId,
    leaseEpoch: frame.leaseEpoch,
    browserEpoch: frame.browserEpoch,
  };
}

async function provisionScenario(service, label, url) {
  await service.waitForControl();
  const sequence = service.events.filter((event) => event.kind === "session_open").length + 1;
  const scenario = {
    sequence,
    sessionId: `${label}-${sequence}`,
    leaseId: `lease-${label}-${sequence}`,
    leaseEpoch: 1,
    browserEpoch: service.browserEpoch(),
    url,
  };
  if (scenario.browserEpoch === null) {
    throw new Error("device hello did not provide a browser epoch");
  }
  let cursor = service.cursor();
  service.sendControl({
    type: "provision",
    ...closureFence(scenario),
    allowedOrigins: [service.origin],
    policyVersion: 1,
    sessionTicket: `session-ticket-${sequence}`,
  });
  const provisioned = await service.waitFor(
    (event) =>
      event.kind === "control" &&
      event.frame.type === "provisioned" &&
      event.frame.sessionId === scenario.sessionId,
    cursor,
  );
  const hello = await service.waitFor(
    (event) =>
      event.kind === "session" &&
      event.sessionId === scenario.sessionId &&
      event.frame.type === "hello",
    cursor,
  );
  cursor = Math.max(provisioned.index, hello.index) + 1;
  await writeCommand(service, scenario, {
    type: "navigate",
    commandId: `navigate-${sequence}`,
    tabId: hello.frame.tabs[0].tabId,
    url,
  }, cursor, true);
  await readCommand(service, scenario, {
    type: "wait",
    commandId: `wait-idle-${sequence}`,
    for: "idle",
  });
  return { scenario, tabId: hello.frame.tabs[0].tabId };
}

async function readCommand(service, scenario, command, after = service.cursor()) {
  service.sendSession(scenario.sessionId, {
    type: "command",
    ...commandFence(scenario, `${command.commandId}-attempt`),
    command,
  });
  return service.waitFor(
    (event) =>
      event.kind === "session" &&
      event.sessionId === scenario.sessionId &&
      event.frame.type === "command_result" &&
      event.frame.commandId === command.commandId,
    after,
  );
}

function requireElementsResult(result, operation) {
  const event = result.frame.event;
  assert(
    event.type === "elements_result" && event.operation === operation && event.status === "ok",
    `${operation} did not return a successful semantic result: ${JSON.stringify(event)}`,
  );
  return event;
}

async function runSemanticElements(browser, service) {
  const { scenario } = await provisionScenario(
    service,
    "semantic",
    `${service.origin}/semantic`,
  );
  const initial = requireElementsResult(
    await readCommand(service, scenario, {
      type: "capture_elements",
      commandId: `semantic-snapshot-${scenario.sequence}`,
      scope: "viewport",
      view: "interactive",
      limit: 80,
      changesOnly: false,
    }),
    "snapshot",
  );
  assert(initial.elements.length <= 80, "default semantic snapshot exceeded 80 descriptors");
  assert(
    Buffer.byteLength(JSON.stringify(initial), "utf8") <= 32 * 1024,
    "default semantic snapshot exceeded 32 KiB",
  );
  const paged = requireElementsResult(
    await readCommand(service, scenario, {
      type: "capture_elements",
      commandId: `semantic-document-${scenario.sequence}`,
      scope: "document",
      view: "interactive",
      limit: 80,
      changesOnly: false,
    }),
    "snapshot",
  );
  assert(
    Buffer.byteLength(JSON.stringify(paged), "utf8") <= 32 * 1024,
    "document semantic snapshot exceeded 32 KiB",
  );
  assert(paged.page.hasMore && paged.page.cursor, "large document fixture did not paginate");
  const initialCursor = paged.page.cursor;

  const late = requireElementsResult(
    await readCommand(service, scenario, {
      type: "find_elements",
      commandId: `semantic-find-late-${scenario.sequence}`,
      query: "Late offscreen target",
      roles: ["button"],
      match: "exact",
      includeHidden: false,
      limit: 20,
    }),
    "find",
  );
  assert(
    !JSON.stringify(late).includes("Fixture button 5000"),
    "offscreen find emitted intervening page content",
  );
  const lateRef = late.elements.find((element) => element.name === "Late offscreen target")?.ref;
  assert(typeof lateRef === "string", "find did not return the late offscreen ref");

  const inspected = requireElementsResult(
    await readCommand(service, scenario, {
      type: "inspect_elements",
      commandId: `semantic-inspect-${scenario.sequence}`,
      ref: lateRef,
      depth: 3,
      limit: 80,
      includeBounds: true,
    }),
    "inspect",
  );
  assert(
    inspected.elements.some((element) => element.ref === lateRef && element.relation === "match"),
    "inspect did not preserve the target ref",
  );
  const continued = requireElementsResult(
    await readCommand(service, scenario, {
      type: "continue_elements",
      commandId: `semantic-next-${scenario.sequence}`,
      cursor: initialCursor,
    }),
    "next",
  );
  assert(continued.snapshot.generation === paged.snapshot.generation, "next reminted refs");
  const clickLate = await writeCommand(service, scenario, {
    type: "click",
    commandId: `semantic-click-late-${scenario.sequence}`,
    ref: lateRef,
  }, service.cursor(), true);
  assert(clickLate.frame.event.ok === true, "find/inspect/next did not preserve a usable ref");

  for (const query of [
    "Same-process frame target",
    "OOPIF frame target",
    "Shadow DOM target",
  ]) {
    const found = requireElementsResult(
      await readCommand(service, scenario, {
        type: "find_elements",
        commandId: `semantic-find-${query.toLowerCase().replaceAll(" ", "-")}-${scenario.sequence}`,
        query,
        roles: ["button"],
        match: "exact",
        includeHidden: false,
        limit: 20,
      }),
      "find",
    );
    assert(found.elements.some((element) => element.name === query), `find missed ${query}`);
  }

  const updater = requireElementsResult(
    await readCommand(service, scenario, {
      type: "find_elements",
      commandId: `semantic-find-updater-${scenario.sequence}`,
      query: "Update semantic status",
      roles: ["button"],
      match: "exact",
      includeHidden: false,
      limit: 20,
    }),
    "find",
  ).elements.find((element) => element.name === "Update semantic status")?.ref;
  assert(typeof updater === "string", "find did not return the custom-handler ref");
  const updateResult = await writeCommand(service, scenario, {
    type: "click",
    commandId: `semantic-click-updater-${scenario.sequence}`,
    ref: updater,
  }, service.cursor(), true);
  assert(updateResult.frame.event.ok === true, "custom click handler did not execute");
  await new Promise((resolve) => setTimeout(resolve, 100));

  const delta = requireElementsResult(
    await readCommand(service, scenario, {
      type: "capture_elements",
      commandId: `semantic-delta-${scenario.sequence}`,
      scope: "document",
      view: "all",
      limit: 80,
      changesOnly: true,
    }),
    "snapshot",
  );
  assert(delta.delta?.applied === true, "same-document semantic delta was not applied");
  assert(
    (delta.delta.added + delta.delta.changed + delta.delta.removed) > 0,
    "same-document semantic delta did not report the status update",
  );
  const stale = await writeCommand(service, scenario, {
    type: "click",
    commandId: `semantic-click-stale-${scenario.sequence}`,
    ref: lateRef,
  }, service.cursor(), true);
  assert(
    stale.frame.event.ok === false && stale.frame.event.reason === "stale_ref",
    "fresh semantic capture did not stale the prior ref",
  );

  const replaceable = requireElementsResult(
    await readCommand(service, scenario, {
      type: "find_elements",
      commandId: `semantic-find-replaceable-${scenario.sequence}`,
      query: "Replaceable target",
      roles: ["button"],
      match: "exact",
      includeHidden: false,
      limit: 20,
    }),
    "find",
  ).elements.find((element) => element.name === "Replaceable target")?.ref;
  assert(typeof replaceable === "string", "find did not return the replaceable ref");
  const replaced = await writeCommand(service, scenario, {
    type: "click",
    commandId: `semantic-click-replaced-${scenario.sequence}`,
    ref: replaceable,
  }, service.cursor(), true);
  assert(
    replaced.frame.event.ok === false && replaced.frame.event.reason === "target_changed",
    "a target replaced after pointer movement was not rejected as target_changed",
  );

  const beforeEviction = requireElementsResult(
    await readCommand(service, scenario, {
      type: "capture_elements",
      commandId: `semantic-before-eviction-${scenario.sequence}`,
      scope: "document",
      view: "interactive",
      limit: 1,
      changesOnly: false,
    }),
    "snapshot",
  );
  const evictionCursor = beforeEviction.page.cursor;
  const evictionRef = beforeEviction.elements[0]?.ref;
  assert(evictionCursor && evictionRef, "worker-eviction fixture did not mint refs and a cursor");
  const restartCursor = service.cursor();
  await stopExtensionWorker(browser.client, browser.worker, browser.panel.sessionId);
  await panelCommand(browser.client, browser.panel.sessionId, { type: "getState" }, "true");
  browser.worker = await attachWorker(browser.client);
  await browser.client.call("Runtime.enable", {}, browser.worker.sessionId);
  await service.waitFor(
    (event) => event.kind === "control" && event.frame.type === "device_hello",
    restartCursor,
  );
  service.sendControl({
    type: "provision",
    ...closureFence(scenario),
    allowedOrigins: [service.origin],
    policyVersion: 1,
    sessionTicket: `semantic-recovery-ticket-${scenario.sequence}`,
  });
  await service.waitFor(
    (event) =>
      event.kind === "session" &&
      event.sessionId === scenario.sessionId &&
      event.frame.type === "hello",
    restartCursor,
  );

  const evictedCursor = await readCommand(service, scenario, {
    type: "continue_elements",
    commandId: `semantic-evicted-cursor-${scenario.sequence}`,
    cursor: evictionCursor,
  });
  assert(
    evictedCursor.frame.event.type === "elements_result" &&
      evictedCursor.frame.event.status === "error" &&
      evictedCursor.frame.event.reason === "snapshot_expired",
    "worker eviction did not expire the semantic snapshot behind the cursor",
  );
  const evictedRef = await readCommand(service, scenario, {
    type: "inspect_elements",
    commandId: `semantic-evicted-ref-${scenario.sequence}`,
    ref: evictionRef,
    depth: 3,
    limit: 80,
    includeBounds: false,
  });
  assert(
    evictedRef.frame.event.type === "elements_result" &&
      evictedRef.frame.event.status === "error" &&
      evictedRef.frame.event.reason === "snapshot_expired",
    "worker eviction did not expire the semantic snapshot behind the ref",
  );

  const refreshed = requireElementsResult(
    await readCommand(service, scenario, {
      type: "find_elements",
      commandId: `semantic-find-after-eviction-${scenario.sequence}`,
      query: "Late offscreen target",
      roles: ["button"],
      match: "exact",
      includeHidden: false,
      limit: 20,
    }),
    "find",
  );
  assert(
    refreshed.snapshot.generation > beforeEviction.snapshot.generation,
    "find after worker eviction did not mint a newer snapshot generation",
  );

  const legacy = await readCommand(service, scenario, {
    type: "snapshot",
    commandId: `semantic-legacy-baseline-${scenario.sequence}`,
    mode: "a11y",
  });
  assert(
    legacy.frame.event.type === "snapshot_result",
    "representative legacy snapshot did not complete",
  );
  const legacyBytes = Buffer.byteLength(JSON.stringify(legacy.frame.event), "utf8");
  const semanticBytes = [initial, paged, beforeEviction].map((event) =>
    Buffer.byteLength(JSON.stringify(event), "utf8"));
  assert(
    semanticBytes.every((bytes) => bytes <= legacyBytes),
    "a representative semantic result exceeded the legacy renderer",
  );
  const reductions = semanticBytes
    .map((bytes) => 1 - bytes / legacyBytes)
    .sort((left, right) => left - right);
  assert(
    reductions[1] >= 0.7,
    `semantic median output reduction was below 70%: ${JSON.stringify(reductions)}`,
  );

  const closeCursor = service.cursor();
  service.sendControl({ type: "close_lease", ...closureFence(scenario) });
  await service.waitFor(
    (event) =>
      event.kind === "control" &&
      event.frame.type === "closed" &&
      event.frame.sessionId === scenario.sessionId,
    closeCursor,
  );
  await waitForManagerIdle(browser.client, browser.panel.sessionId);
}

async function runInterruptedPayment(browser, service, marker, stage) {
  const scenario = await preparePaymentScenario(service, stage);
  const cursor = service.cursor();
  sendSubmitCard(service, scenario);
  await service.waitFor(
    (event) => event.kind === "signal" && event.stage === stage,
    cursor,
  );
  const restartCursor = service.cursor();
  await stopExtensionWorker(browser.client, browser.worker, browser.panel.sessionId);
  await panelCommand(browser.client, browser.panel.sessionId, { type: "getState" }, "true");
  browser.worker = await attachWorker(browser.client);
  await browser.client.call("Runtime.enable", {}, browser.worker.sessionId);
  await service.waitFor(
    (event) => event.kind === "control" && event.frame.type === "device_hello",
    restartCursor,
  );
  await triggerBackstop(browser.client, browser.panel.sessionId);
  await service.waitFor(
    (event) =>
      event.kind === "control" &&
      event.frame.type === "closed" &&
      event.frame.sessionId === scenario.sessionId,
    restartCursor,
  );
  await panelCommand(
    browser.client,
    browser.panel.sessionId,
    { type: "getState" },
    "state.controlledTabs === 0",
  );
  await waitForManagerIdle(browser.client, browser.panel.sessionId);
  await assertCheckoutClosed(browser.client, scenario.checkoutUrl);
  const results = service.events.filter(
    (event) =>
      event.kind === "session" &&
      event.sessionId === scenario.sessionId &&
      event.frame.type === "command_result" &&
      event.frame.commandId === scenario.submitCommand.commandId,
  );
  assert(results.length === 0, `${stage} interruption emitted a retryable payment result`);
  const journal = await readJournal(
    browser.client,
    browser.panel.sessionId,
    scenario.sessionId,
  );
  const record = journal.find((entry) => entry.attemptId === scenario.submitAttemptId);
  assert(
    record?.state === "started" || record?.state === "unknown",
    `${stage} interruption lost its no-retry journal fence`,
  );
  assert(!JSON.stringify(journal).includes(marker), `${stage} journal leaked the card marker`);
}

async function runCheckpointedPayment(browser, service, marker) {
  const scenario = await preparePaymentScenario(service, "checkpoint");
  const cursor = service.cursor();
  sendSubmitCard(service, scenario);
  const result = await service.waitFor(
    (event) =>
      event.kind === "session" &&
      event.sessionId === scenario.sessionId &&
      event.frame.type === "command_result" &&
      event.frame.commandId === scenario.submitCommand.commandId,
    cursor,
  );
  assert(
    result.frame.event.status === "outcome_unknown" &&
      result.frame.event.reason === "submission_attempted",
    "real CDP card submission did not return the fixed unknown-outcome result",
  );
  const restartCursor = service.cursor();
  await stopExtensionWorker(browser.client, browser.worker, browser.panel.sessionId);
  await panelCommand(browser.client, browser.panel.sessionId, { type: "getState" }, "true");
  browser.worker = await attachWorker(browser.client);
  await browser.client.call("Runtime.enable", {}, browser.worker.sessionId);
  await service.waitFor(
    (event) => event.kind === "control" && event.frame.type === "device_hello",
    restartCursor,
  );
  await triggerBackstop(browser.client, browser.panel.sessionId);
  await service.waitFor(
    (event) =>
      event.kind === "control" &&
      event.frame.type === "closed" &&
      event.frame.sessionId === scenario.sessionId,
    restartCursor,
  );
  await panelCommand(
    browser.client,
    browser.panel.sessionId,
    { type: "getState" },
    "state.controlledTabs === 0",
  );
  await waitForManagerIdle(browser.client, browser.panel.sessionId);
  await assertCheckoutClosed(browser.client, scenario.checkoutUrl);
  const journal = await readJournal(
    browser.client,
    browser.panel.sessionId,
    scenario.sessionId,
  );
  const record = journal.find((entry) => entry.attemptId === scenario.submitAttemptId);
  assert(record?.state === "completed_unacked", "checkpointed fixed result was not durable");
  assert(record.event?.status === "outcome_unknown", "durable result changed after worker eviction");
  assert(!JSON.stringify(journal).includes(marker), "checkpointed journal leaked the card marker");
  const results = service.events.filter(
    (event) =>
      event.kind === "session" &&
      event.sessionId === scenario.sessionId &&
      event.frame.type === "command_result" &&
      event.frame.commandId === scenario.submitCommand.commandId,
  );
  assert(results.length === 1, "checkpointed card submission was automatically retried or replayed");
}

async function preparePaymentScenario(service, stage) {
  const checkoutUrl = `${service.origin}/checkout?stage=${encodeURIComponent(stage)}`;
  const { scenario } = await provisionScenario(
    service,
    `payment-${stage}`,
    checkoutUrl,
  );
  scenario.checkoutUrl = checkoutUrl;
  const sequence = scenario.sequence;
  const cursor = service.cursor();
  const snapshotAttemptId = `snapshot-attempt-${sequence}`;
  const snapshotCommandId = `snapshot-${sequence}`;
  service.sendSession(scenario.sessionId, {
    type: "command",
    ...commandFence(scenario, snapshotAttemptId),
    command: {
      type: "capture_elements",
      commandId: snapshotCommandId,
      scope: "document",
      view: "all",
      limit: 80,
      changesOnly: false,
    },
  });
  const snapshot = await service.waitFor(
    (event) =>
      event.kind === "session" &&
      event.sessionId === scenario.sessionId &&
      event.frame.type === "command_result" &&
      event.frame.commandId === snapshotCommandId,
    cursor,
  );
  const semanticSnapshot = requireElementsResult(snapshot, "snapshot");
  const refs = {};
  for (const name of ["Expiration", "Cardholder name", "Card number", "CVV", "Submit payment"]) {
    const requiredAction = name === "Submit payment" ? "click" : "type";
    const element = semanticSnapshot.elements.find(
      (candidate) => candidate.name === name && candidate.actions.includes(requiredAction),
    );
    assert(
      typeof element?.ref === "string",
      `snapshot did not expose an actionable ${name}`,
    );
    refs[name] = element.ref;
  }
  scenario.submitAttemptId = `submit-attempt-${sequence}`;
  scenario.submitCommand = {
    type: "submit_card",
    commandId: `submit-${sequence}`,
    cardAlias: "e2e-card",
    numberRef: refs["Card number"],
    expiry: { kind: "combined", ref: refs.Expiration },
    cvvRef: refs.CVV,
    cardholderNameRef: refs["Cardholder name"],
    submitRef: refs["Submit payment"],
  };
  const prepareCursor = service.cursor();
  service.sendSession(scenario.sessionId, {
    type: "write_prepare",
    ...commandFence(scenario, scenario.submitAttemptId),
    commandId: scenario.submitCommand.commandId,
    commandType: "submit_card",
    requestFingerprint: "b".repeat(64),
  });
  await service.waitFor(
    (event) =>
      event.kind === "session" &&
      event.sessionId === scenario.sessionId &&
      event.frame.type === "write_ready" &&
      event.frame.attemptId === scenario.submitAttemptId,
    prepareCursor,
  );
  return scenario;
}

function sendSubmitCard(service, scenario) {
  service.sendSession(scenario.sessionId, {
    type: "write_grant",
    ...commandFence(scenario, scenario.submitAttemptId),
    command: scenario.submitCommand,
  });
}

async function writeCommand(service, scenario, command, after, acknowledge) {
  const attemptId = `${command.commandId}-attempt`;
  const fingerprint = "a".repeat(64);
  service.sendSession(scenario.sessionId, {
    type: "write_prepare",
    ...commandFence(scenario, attemptId),
    commandId: command.commandId,
    commandType: command.type,
    requestFingerprint: fingerprint,
  });
  const ready = await service.waitFor(
    (event) =>
      event.kind === "session" &&
      event.sessionId === scenario.sessionId &&
      event.frame.type === "write_ready" &&
      event.frame.attemptId === attemptId,
    after,
  );
  service.sendSession(scenario.sessionId, {
    type: "write_grant",
    ...commandFence(scenario, attemptId),
    command,
  });
  const result = await service.waitFor(
    (event) =>
      event.kind === "session" &&
      event.sessionId === scenario.sessionId &&
      event.frame.type === "command_result" &&
      event.frame.commandId === command.commandId,
    ready.index + 1,
  );
  if (acknowledge) {
    service.sendSession(scenario.sessionId, {
      type: "result_ack",
      attemptId,
      commandId: command.commandId,
    });
  }
  return result;
}

function commandFence(scenario, attemptId) {
  return {
    attemptId,
    deadlineAt: new Date(Date.now() + 20_000).toISOString(),
    leaseId: scenario.leaseId,
    leaseEpoch: scenario.leaseEpoch,
    browserEpoch: scenario.browserEpoch,
  };
}

async function stopExtensionWorker(client, worker, controllerSessionId) {
  await client.call("ServiceWorker.enable", {}, controllerSessionId);
  const version = await waitForCdpEvent(
    client,
    (event) =>
      event.sessionId === controllerSessionId &&
      event.method === "ServiceWorker.workerVersionUpdated" &&
      event.params.versions?.find((candidate) => candidate.scriptURL === worker.url),
  );
  const workerVersion = version.params.versions.find(
    (candidate) => candidate.scriptURL === worker.url,
  );
  await client.call("Target.detachFromTarget", { sessionId: worker.sessionId }).catch(() => {});
  await client.call(
    "ServiceWorker.stopWorker",
    { versionId: workerVersion.versionId },
    controllerSessionId,
  );
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const { targetInfos } = await client.call("Target.getTargets");
    if (!targetInfos.some((target) => target.targetId === worker.targetId)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("extension service worker did not stop");
}

async function waitForCdpEvent(client, predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const event = [...client.events].reverse().find((candidate) => predicate(candidate));
    if (event !== undefined) return event;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("expected CDP event did not arrive");
}

function readJournal(client, sessionId, controlledSessionId) {
  const key = `understudy:journal:${controlledSessionId}`;
  return evaluate(
    client,
    sessionId,
    `chrome.storage.session.get(${JSON.stringify(key)}).then((value) => value[${JSON.stringify(key)}] ?? [])`,
  );
}

async function waitForManagerIdle(client, sessionId) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const state = await evaluate(
      client,
      sessionId,
      `chrome.storage.session.get("understudy:assignments").then((value) => value["understudy:assignments"] ?? null)`,
    );
    if (
      state !== null &&
      state.assignments?.length === 0 &&
      state.ownedWindows?.length === 0 &&
      state.closedOutbox?.length === 0 &&
      state.vacatedLeases?.length === 0
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("extension session manager did not converge to an idle inventory");
}

async function triggerBackstop(client, sessionId) {
  await evaluate(
    client,
    sessionId,
    `chrome.alarms.create("ws-backstop", { when: Date.now() + 50 })`,
  );
}

async function assertCheckoutClosed(client, checkoutUrl) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const { targetInfos } = await client.call("Target.getTargets");
    if (!targetInfos.some((target) => target.url === checkoutUrl)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`owned checkout target remained open: ${checkoutUrl}`);
}

async function stopChrome(child) {
  signalChromeGroup(child, "SIGTERM");
  if (child.exitCode === null) {
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
  }
  signalChromeGroup(child, "SIGKILL");
}

function signalChromeGroup(child, signal) {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

async function removeProfile(directory) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      return;
    } catch (error) {
      if (!["EBUSY", "ENOTEMPTY", "EPERM"].includes(error?.code) || attempt === 19) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

async function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    "/snap/bin/chromium",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }
  throw new Error("local Chrome not found; set CHROME_PATH");
}

async function devtoolsUrl(directory, child) {
  const activePort = path.join(directory, "DevToolsActivePort");
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Chrome exited before CDP startup (${child.exitCode})`);
    const stderrMatch = chromeStderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
    if (stderrMatch?.[1]) return stderrMatch[1];
    try {
      const [port, socketPath] = (await readFile(activePort, "utf8")).trim().split("\n");
      if (port && socketPath) return `ws://127.0.0.1:${port}${socketPath}`;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Chrome did not publish DevToolsActivePort");
}

async function attachWorker(client) {
  const diagnostics = new Map();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const { targetInfos } = await client.call("Target.getTargets");
    const targets = targetInfos.filter((candidate) =>
      candidate.type === "service_worker" &&
      candidate.url.startsWith("chrome-extension://"),
    );
    for (const target of targets) {
      const { sessionId } = await client.call("Target.attachToTarget", {
        targetId: target.targetId,
        flatten: true,
      });
      try {
        await client.call("Runtime.enable", {}, sessionId);
        const candidateManifest = await evaluate(
          client,
          sessionId,
          "typeof chrome === 'object' && chrome.runtime?.getManifest?.()",
        );
        diagnostics.set(target.targetId, `${target.url} ${JSON.stringify(candidateManifest)}`);
        if (candidateManifest?.name === manifest.name && candidateManifest.version === manifest.version) {
          return { targetId: target.targetId, sessionId, url: target.url };
        }
      } catch (error) {
        diagnostics.set(target.targetId, `${target.url} ${error instanceof Error ? error.message : String(error)}`);
      }
      await client.call("Target.detachFromTarget", { sessionId }).catch(() => {});
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `extension service worker did not start; candidates: ${[...diagnostics.values()].join(" | ") || "none"}`,
  );
}

async function attachExtensionPage(client, workerUrl, document = "sidepanel.html") {
  const extensionUrl = new URL(workerUrl);
  const pageUrl = `${extensionUrl.protocol}//${extensionUrl.host}/${document}`;
  const { targetId } = await client.call("Target.createTarget", { url: pageUrl });
  const { sessionId } = await client.call("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  await client.call("Runtime.enable", {}, sessionId);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const ready = `location.href === ${JSON.stringify(pageUrl)} && document.readyState === 'complete' && typeof chrome === 'object' && typeof chrome.runtime?.connect === 'function'`;
    if (await evaluate(client, sessionId, ready).catch(() => false)) {
      return { targetId, sessionId };
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("extension side panel did not load");
}

async function verifyVaultSchemaCompatibility(client, worker, panel, rawPage) {
  await client.call("Target.closeTarget", { targetId: panel.targetId });
  await stopExtensionWorker(client, worker, rawPage.sessionId);
  await seedVersionOneVault(client, rawPage.sessionId);

  panel = await attachExtensionPage(client, worker.url);
  worker = await attachWorker(client);
  const migratedState = await panelCommand(
    client,
    panel.sessionId,
    { type: "getState" },
    "state.cardVault.aliases.includes('legacy-card')",
  );
  assert(
    migratedState.cardVault.approvedOrigins.includes("https://legacy.example"),
    "version-1 payment origins were not preserved during migration",
  );
  const migrated = await inspectVault(client, rawPage.sessionId);
  assert(migrated.databaseVersion === 2, "version-1 vault did not upgrade to version 2");
  assert(migrated.metadataVersion === 2, "vault migration did not persist schema metadata");
  assert(migrated.cards === 1 && migrated.hasKey, "vault migration lost a card or key");

  await panelCommand(
    client,
    panel.sessionId,
    { type: "deleteCardVault" },
    "state.cardVault.aliases.length === 0 && state.cardVault.approvedOrigins.length === 0",
  );

  await client.call("Target.closeTarget", { targetId: panel.targetId });
  await stopExtensionWorker(client, worker, rawPage.sessionId);
  await seedFutureVault(client, rawPage.sessionId);

  panel = await attachExtensionPage(client, worker.url);
  worker = await attachWorker(client);
  const futureState = await panelCommand(
    client,
    panel.sessionId,
    { type: "getState" },
    "typeof state.cardVault.error === 'string'",
  );
  assert(futureState.cardVault.aliases.length === 0, "future vault schema was exposed");
  const future = await inspectVaultVersion(client, rawPage.sessionId);
  assert(
    future.databaseVersion === 3 && future.metadataVersion === 3,
    "opening a future vault schema modified or downgraded it",
  );

  await client.call("Target.closeTarget", { targetId: panel.targetId });
  await stopExtensionWorker(client, worker, rawPage.sessionId);
  await deleteVaultDatabase(client, rawPage.sessionId);
  panel = await attachExtensionPage(client, worker.url);
  worker = await attachWorker(client);
  await panelCommand(
    client,
    panel.sessionId,
    { type: "getState" },
    "state.cardVault.aliases.length === 0 && state.cardVault.error === undefined",
  );
  return { worker, panel };
}

function seedVersionOneVault(client, sessionId) {
  return evaluate(client, sessionId, `(async () => {
    const databaseName = "understudy-payment-card-vault";
    await new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(databaseName);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("version-1 seed deletion blocked"));
      request.onsuccess = () => resolve();
    });
    const key = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
    await new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName, 1);
      request.onupgradeneeded = () => {
        const database = request.result;
        database.createObjectStore("keys", { keyPath: "id" });
        const cards = database.createObjectStore("cards", { keyPath: "id" });
        cards.createIndex("alias", "alias", { unique: true });
        database.createObjectStore("settings", { keyPath: "id" });
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result;
        const transaction = database.transaction(["keys", "cards", "settings"], "readwrite");
        transaction.objectStore("keys").put({ id: "payment-card-key", key });
        transaction.objectStore("cards").put({
          id: "00000000-0000-4000-8000-0000000000a1",
          alias: "legacy-card",
          schemaVersion: 1,
          purpose: "payment-card",
          iv: new Uint8Array(12).buffer,
          ciphertext: new Uint8Array(17).buffer,
        });
        transaction.objectStore("settings").put({
          id: "payment-origins",
          origins: ["https://legacy.example"],
        });
        transaction.onerror = () => reject(transaction.error);
        transaction.oncomplete = () => { database.close(); resolve(); };
      };
    });
    return true;
  })()`);
}

function seedFutureVault(client, sessionId) {
  return evaluate(client, sessionId, `(async () => {
    const databaseName = "understudy-payment-card-vault";
    await new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(databaseName);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("future-schema seed deletion blocked"));
      request.onsuccess = () => resolve();
    });
    await new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName, 3);
      request.onupgradeneeded = () => {
        const database = request.result;
        database.createObjectStore("keys", { keyPath: "id" });
        const cards = database.createObjectStore("cards", { keyPath: "id" });
        cards.createIndex("alias", "alias", { unique: true });
        database.createObjectStore("settings", { keyPath: "id" });
        const metadata = database.createObjectStore("metadata", { keyPath: "id" });
        metadata.put({ id: "schema", version: 3 });
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => { request.result.close(); resolve(); };
    });
    return true;
  })()`);
}

function deleteVaultDatabase(client, sessionId) {
  return evaluate(client, sessionId, `new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase("understudy-payment-card-vault");
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("vault deletion blocked"));
    request.onsuccess = () => resolve(true);
  })`);
}

function inspectVaultVersion(client, sessionId) {
  return evaluate(client, sessionId, `new Promise((resolve, reject) => {
    const request = indexedDB.open("understudy-payment-card-vault");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction("metadata", "readonly");
      const metadata = transaction.objectStore("metadata").get("schema");
      transaction.onerror = () => reject(transaction.error);
      transaction.oncomplete = () => {
        resolve({ databaseVersion: database.version, metadataVersion: metadata.result?.version });
        database.close();
      };
    };
  })`);
}

async function evaluate(client, sessionId, expression) {
  const result = await client.call("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  }, sessionId);
  if (result.exceptionDetails) {
    throw new Error(
      `extension evaluation failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`,
    );
  }
  return result.result.value;
}

function panelCommand(client, sessionId, message, condition) {
  return evaluate(client, sessionId, `new Promise((resolve, reject) => {
    const port = chrome.runtime.connect({name: "panel"});
    const timer = setTimeout(() => { port.disconnect(); reject(new Error("panel timeout")); }, 10000);
    port.onMessage.addListener((state) => {
      if (state?.type === "state" && (${condition})) {
        clearTimeout(timer);
        port.disconnect();
        resolve(state);
      }
    });
    port.postMessage(${JSON.stringify(message)});
  })`);
}

function panelCardSave(client, sessionId, card) {
  const requestId = `e2e-save-${Date.now()}`;
  return evaluate(client, sessionId, `new Promise((resolve, reject) => {
    const port = chrome.runtime.connect({name: "panel"});
    const timer = setTimeout(() => { port.disconnect(); reject(new Error("card save timeout")); }, 10000);
    let savedState;
    let acknowledged = false;
    const finish = () => {
      if (savedState === undefined || !acknowledged) return;
      clearTimeout(timer);
      port.disconnect();
      resolve(savedState);
    };
    port.onMessage.addListener((message) => {
      if (message?.type === "state" && message.cardVault.aliases.includes(${JSON.stringify(card.alias)})) {
        savedState = message;
        finish();
      }
      if (message?.type === "cardVaultSaveResult" && message.requestId === ${JSON.stringify(requestId)}) {
        if (!message.ok) {
          clearTimeout(timer);
          port.disconnect();
          reject(new Error(message.error));
          return;
        }
        acknowledged = true;
        finish();
      }
    });
    port.postMessage(${JSON.stringify({ type: "saveCard", requestId, card })});
  })`);
}

function inspectVault(client, sessionId) {
  return evaluate(client, sessionId, `new Promise((resolve, reject) => {
    const request = indexedDB.open("understudy-payment-card-vault", 2);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction(["keys", "cards", "metadata"], "readonly");
      const keyRequest = transaction.objectStore("keys").get("payment-card-key");
      const cardsRequest = transaction.objectStore("cards").getAll();
      const metadataRequest = transaction.objectStore("metadata").get("schema");
      transaction.onerror = () => reject(transaction.error);
      transaction.oncomplete = () => {
        const cards = cardsRequest.result;
        resolve({
          databaseVersion: database.version,
          metadataVersion: metadataRequest.result?.version,
          hasKey: keyRequest.result?.key instanceof CryptoKey,
          keyExtractable: keyRequest.result?.key?.extractable ?? null,
          cards: cards.length,
          ivBytes: cards[0]?.iv?.byteLength ?? null,
          envelopes: cards.map(({id, alias, schemaVersion, purpose, iv, ciphertext}) => ({
            id, alias, schemaVersion, purpose, ivBytes: iv.byteLength,
            ciphertextBytes: ciphertext.byteLength,
          })),
        });
        database.close();
      };
    };
  })`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
