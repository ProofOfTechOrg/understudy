# CDP Spike (M0)

Throwaway harness that answers the plan's one gating question (M0): **does
`chrome.debugger` expose the CDP commands the targeting layer needs?**
(`docs/technical-plan.md`, decisions D2 + D7.)

The real extension is **M2** (WXT + TypeScript, `apps/extension`). This one is deliberately
buildless vanilla JS so it loads with zero setup — do not build on it.

## Run

1. Open a **Chromium** browser (Chrome / Edge / Brave / Arc) → `chrome://extensions`.
2. Enable **Developer mode** → **Load unpacked** → select this `apps/cdp-spike` folder.
3. Open a tab you are **logged into** (e.g. your email or a dashboard).
4. Click the extension's toolbar icon to open the **side panel**.
5. Click **Attach to active tab** — a yellow "… is being debugged" banner appears
   (expected; it's Chrome's non-suppressible debugger notice). Then click **Probe CDP surface**.

## What success looks like

The probe reports OK / FAIL for each command the plan depends on:

- `Accessibility.enable` / `getFullAXTree` — the a11y snapshot
- `DOM.enable` / `getDocument` / `getBoxModel` — resolving a `ref` to screen coordinates
- `Runtime.enable` / `evaluate` — page state + fallback `.click()` via `callFunctionOn`
- `Input.dispatchMouseEvent` — synthetic clicks/typing
- `Page.enable` / `captureScreenshot` — the vision fallback
- `Target.getTargets` — multi-tab awareness

**Outcomes:**

- **All OK** → the CDP targeting approach is validated. Proceed to M1/M2.
- **Any FAIL** → that command is restricted under `chrome.debugger`. Record which, and adjust
  the plan's targeting section — e.g. if `DOM.getBoxModel` / `Input.*` are limited, fall back
  to `Runtime.callFunctionOn(node, () => el.click())` for actions.

The **A11y tree sample** button shows the pruned `{ref, role, name}` shape the backend would
feed to the LLM — eyeball it on a real page to sanity-check that the actionable elements are
captured with usable names.
