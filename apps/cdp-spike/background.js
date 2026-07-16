// M0 CDP spike — background service worker.
//
// Purpose: confirm that `chrome.debugger` exposes the CDP commands the plan's
// targeting layer needs (docs/technical-plan.md, D2/D7). Throwaway harness —
// the real extension is M2 (WXT + TypeScript, apps/extension). Deliberately
// buildless vanilla JS so it loads with zero setup.

const PROTOCOL = "1.3";

// Open the side panel when the toolbar icon is clicked.
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

/** @type {{ tabId: number } | null} */
let attached = null;

async function attach() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || tab.id === undefined) throw new Error("No active tab to attach to");
  await chrome.debugger.attach({ tabId: tab.id }, PROTOCOL);
  attached = { tabId: tab.id };
  return { tabId: tab.id, url: tab.url };
}

async function detach() {
  if (!attached) return { detached: false };
  const tabId = attached.tabId;
  await chrome.debugger.detach({ tabId });
  attached = null;
  return { detached: true, tabId };
}

function cdp(method, params = {}) {
  if (!attached) throw new Error("Not attached — click Attach first");
  return chrome.debugger.sendCommand({ tabId: attached.tabId }, method, params);
}

// Prune the full AX tree into the compact {ref, role, name} shape the backend
// would send to the LLM. Approximate — this is a spike, not the real reducer.
function pruneAxTree(nodes) {
  const meaningful = new Set([
    "button", "link", "textbox", "checkbox", "radio", "combobox", "listbox",
    "menuitem", "tab", "heading", "image", "searchbox", "switch", "slider", "cell",
  ]);
  const out = [];
  for (const n of nodes) {
    const role = n.role && n.role.value ? n.role.value : "";
    const name = n.name && n.name.value ? n.name.value : "";
    if (meaningful.has(role)) {
      out.push({ ref: String(n.backendDOMNodeId ?? n.nodeId), role, name });
    }
  }
  return out;
}

async function getA11y() {
  await cdp("Accessibility.enable");
  const { nodes } = await cdp("Accessibility.getFullAXTree");
  const pruned = pruneAxTree(nodes);
  return { total: nodes.length, actionable: pruned.length, sample: pruned.slice(0, 20) };
}

async function screenshot() {
  await cdp("Page.enable");
  const { data } = await cdp("Page.captureScreenshot", { format: "png" });
  return { bytes: Math.round((data.length * 3) / 4) };
}

// The actual M0 deliverable: probe each CDP command the targeting layer needs
// and report OK/FAIL per command, so we know exactly what chrome.debugger allows.
async function probe() {
  const results = [];
  const step = async (label, fn) => {
    try {
      const detail = await fn();
      results.push({ label, ok: true, detail: detail ?? "" });
    } catch (e) {
      results.push({ label, ok: false, detail: String((e && e.message) || e) });
    }
  };

  let firstBackendId = null;

  await step("Accessibility.enable", () => cdp("Accessibility.enable"));
  await step("Accessibility.getFullAXTree", async () => {
    const { nodes } = await cdp("Accessibility.getFullAXTree");
    const withNode = nodes.find((n) => n.backendDOMNodeId);
    firstBackendId = withNode ? withNode.backendDOMNodeId : null;
    return `${nodes.length} nodes`;
  });
  await step("DOM.enable", () => cdp("DOM.enable"));
  await step("DOM.getDocument", async () => {
    const { root } = await cdp("DOM.getDocument", { depth: 1 });
    return `root nodeId ${root.nodeId}`;
  });
  await step("DOM.getBoxModel (via backendNodeId)", async () => {
    if (!firstBackendId) return "skipped — no backendDOMNodeId in tree";
    const { model } = await cdp("DOM.getBoxModel", { backendNodeId: firstBackendId });
    return `box ${model.width}x${model.height}`;
  });
  await step("Runtime.enable", () => cdp("Runtime.enable"));
  await step("Runtime.evaluate", async () => {
    const { result } = await cdp("Runtime.evaluate", {
      expression: "location.href",
      returnByValue: true,
    });
    return String(result.value);
  });
  await step("Input.dispatchMouseEvent (no-op move)", () =>
    cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 5 }),
  );
  await step("Page.enable", () => cdp("Page.enable"));
  await step("Page.captureScreenshot", async () => {
    const { data } = await cdp("Page.captureScreenshot", { format: "png" });
    return `${Math.round((data.length * 3) / 4)} bytes`;
  });
  await step("Target.getTargets", async () => {
    const { targetInfos } = await cdp("Target.getTargets");
    return `${targetInfos.length} targets`;
  });

  const passed = results.filter((r) => r.ok).length;
  return { summary: `${passed}/${results.length} commands OK`, results };
}

// ── OOPIF probe (M5 follow-up to the M0 findings) ────────────────────────────
// Answers the sub-question M0 deferred: does Target.setAutoAttach{flatten:true}
// work under chrome.debugger, delivering attachedToTarget events with
// sessionIds that session-scoped sendCommand (Chrome 125+) can drive? That is
// the entire mechanism cross-origin-iframe (OOPIF) targeting would build on.

/** Target.attachedToTarget params observed since the last OOPIF probe reset. */
let attachedTargetEvents = [];

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!attached || source.tabId !== attached.tabId) return;
  if (method === "Target.attachedToTarget") attachedTargetEvents.push(params);
});

async function probeOopif() {
  if (!attached) throw new Error("Not attached — click Attach first");
  const tabId = attached.tabId;
  const results = [];
  const step = async (label, fn) => {
    try {
      const detail = await fn();
      results.push({ label, ok: true, detail: detail ?? "" });
    } catch (e) {
      results.push({ label, ok: false, detail: String((e && e.message) || e) });
    }
  };
  const inSession = (sessionId, method, params) =>
    chrome.debugger.sendCommand({ tabId, sessionId }, method, params);

  attachedTargetEvents = [];
  await step("Target.setAutoAttach {flatten:true}", () =>
    cdp("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }),
  );
  // Auto-attach announces existing OOPIFs asynchronously; give it a beat.
  await new Promise((resolve) => setTimeout(resolve, 1500));

  const frames = attachedTargetEvents.filter((p) => p.targetInfo && p.targetInfo.type === "iframe");
  results.push({
    label: "Target.attachedToTarget events",
    ok: attachedTargetEvents.length > 0,
    detail:
      attachedTargetEvents
        .map((p) => `${p.targetInfo.type} ${String(p.targetInfo.url || "").slice(0, 60)}`)
        .join(" | ") || "none received",
  });

  // Drive each auto-attached target through ITS OWN session: proves the
  // sessionId routing the real driver (apps/extension) would need.
  for (const p of attachedTargetEvents) {
    const sessionId = p.sessionId;
    const tag = `[${String(p.targetInfo.url || p.targetInfo.type).slice(0, 40)}]`;
    await step(`${tag} Runtime.evaluate via sessionId`, async () => {
      await inSession(sessionId, "Runtime.enable");
      const { result } = await inSession(sessionId, "Runtime.evaluate", {
        expression: "location.href",
        returnByValue: true,
      });
      return String(result.value).slice(0, 70);
    });
    await step(`${tag} Accessibility.getFullAXTree via sessionId`, async () => {
      await inSession(sessionId, "Accessibility.enable");
      const { nodes } = await inSession(sessionId, "Accessibility.getFullAXTree");
      const pruned = pruneAxTree(nodes);
      const sample = pruned
        .slice(0, 3)
        .map((n) => `${n.role}:${n.name}`)
        .join(", ");
      return `${nodes.length} nodes, ${pruned.length} actionable${sample ? ` (${sample})` : ""}`;
    });
  }

  await step("Target.setAutoAttach off (cleanup)", () =>
    cdp("Target.setAutoAttach", { autoAttach: false, waitForDebuggerOnStart: false, flatten: true }),
  );

  const sessionSteps = results.filter((r) => r.label.includes("via sessionId"));
  const sessionsOk = sessionSteps.length > 0 && sessionSteps.every((r) => r.ok);
  const summary =
    frames.length > 0 && sessionsOk
      ? `OOPIF auto-attach WORKS: ${frames.length} iframe target(s) attached and driven via session-scoped commands`
      : frames.length > 0
        ? "iframe target(s) attached but session-scoped commands FAILED — see rows above"
        : "no OOPIF targets announced — is oopif-test.html (cross-origin iframe) open in the attached tab?";
  return { summary, results };
}

const HANDLERS = { attach, detach, a11y: getA11y, screenshot, probe, oopif: probeOopif };

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handler = msg && HANDLERS[msg.cmd];
  if (!handler) {
    sendResponse({ ok: false, error: `Unknown cmd: ${msg && msg.cmd}` });
    return false;
  }
  handler()
    .then((data) => sendResponse({ ok: true, data }))
    .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
  return true; // keep the message channel open for the async response
});

// If the user navigates away or DevTools steals the session, drop our state.
chrome.debugger.onDetach.addListener((source) => {
  if (attached && source.tabId === attached.tabId) attached = null;
});
