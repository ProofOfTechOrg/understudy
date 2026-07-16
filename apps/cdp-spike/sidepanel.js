const logEl = document.getElementById("log");

function log(line, cls) {
  const el = document.createElement("div");
  if (cls) el.className = cls;
  el.textContent = line;
  logEl.prepend(el);
}

function send(cmd) {
  return chrome.runtime.sendMessage({ cmd }).then((res) => {
    if (!res) throw new Error("no response (service worker asleep?) — click again");
    if (!res.ok) throw new Error(res.error);
    return res.data;
  });
}

function bind(id, label, render) {
  document.getElementById(id).addEventListener("click", async () => {
    try {
      render(await send(id));
    } catch (e) {
      log(`${label} failed: ${e.message}`, "fail");
    }
  });
}

bind("attach", "attach", (d) => log(`attached: tab ${d.tabId} ${d.url || ""}`, "ok"));

bind("probe", "probe", (d) => {
  log(`— ${d.summary} —`);
  for (const r of d.results) {
    log(`${r.ok ? "OK  " : "FAIL"} ${r.label}${r.detail ? " — " + r.detail : ""}`, r.ok ? "ok" : "fail");
  }
});

bind("oopif", "oopif", (d) => {
  log(`— ${d.summary} —`, d.summary.includes("WORKS") ? "ok" : undefined);
  for (const r of d.results) {
    log(`${r.ok ? "OK  " : "FAIL"} ${r.label}${r.detail ? " — " + r.detail : ""}`, r.ok ? "ok" : "fail");
  }
});

bind("a11y", "a11y", (d) =>
  log(`a11y: ${d.actionable}/${d.total} actionable\n` + JSON.stringify(d.sample, null, 2)),
);

bind("screenshot", "screenshot", (d) => log(`screenshot ok: ~${d.bytes} bytes`, "ok"));

bind("detach", "detach", (d) => log(`detached: ${JSON.stringify(d)}`));
