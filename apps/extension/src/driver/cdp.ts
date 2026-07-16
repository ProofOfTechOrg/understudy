import type { Event } from "@understudy/protocol";
import type { Protocol } from "devtools-protocol";
import { actionError, errorMessage } from "../events";
import { buildA11ySnapshot } from "./a11y";
import { parseKeys } from "./keymap";

type WaitFor = "load" | "idle" | "ms";

// A hung/wedged page must still resolve to a reportable action_result instead
// of leaving a peer's pending-map stuck forever.
const SEND_TIMEOUT_MS = 15000;
const LOAD_TIMEOUT_MS = 15000;
const IDLE_QUIET_MS = 500;

function isBoxModelError(cause: unknown): boolean {
  return errorMessage(cause).includes("Could not compute box model");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function quadCenter(quad: Protocol.DOM.Quad): { x: number; y: number } {
  if (quad.length < 8) {
    throw new Error(`Unexpected box-model quad of length ${quad.length}`);
  }
  const x = ((quad[0] ?? 0) + (quad[2] ?? 0) + (quad[4] ?? 0) + (quad[6] ?? 0)) / 4;
  const y = ((quad[1] ?? 0) + (quad[3] ?? 0) + (quad[5] ?? 0) + (quad[7] ?? 0)) / 4;
  return { x, y };
}

// One session per attached tab, one CDP channel. Every executor runs through
// `run`/`enqueue`, which chains onto `queue` so commands stay FIFO even if the
// peer pipelines several at once — interleaved multi-step executors (e.g.
// focus-then-insertText) would otherwise corrupt each other on a shared channel.
export class CdpSession {
  enabled = false;
  generation = 0;
  refMap: Map<string, number> = new Map();
  currentUrl = "";

  private loadInFlight = false;
  private readonly loadWaiters = new Set<() => void>();
  private queue: Promise<unknown> = Promise.resolve();
  // Chained (not fire-and-forget) so concurrent bumpGeneration() calls persist
  // in order instead of racing to overwrite browser.storage.session.
  private genPersistChain: Promise<unknown> = Promise.resolve();

  private constructor(readonly tabId: number) {}

  static async create(tabId: number): Promise<CdpSession> {
    const session = new CdpSession(tabId);
    await session.loadGeneration();
    return session;
  }

  private static genKey(tabId: number): string {
    return `understudy:cdp:gen:${tabId}`;
  }

  private async loadGeneration(): Promise<void> {
    const key = CdpSession.genKey(this.tabId);
    const stored = await browser.storage.session.get(key);
    const value = stored[key];
    this.generation = typeof value === "number" ? value : 0;
  }

  bumpGeneration(): Promise<number> {
    this.generation += 1;
    const value = this.generation;
    const write = this.genPersistChain.then(() =>
      browser.storage.session.set({ [CdpSession.genKey(this.tabId)]: value }),
    );
    this.genPersistChain = write.then(
      () => undefined,
      () => undefined,
    );
    return write.then(() => value);
  }

  async send<R>(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs = SEND_TIMEOUT_MS,
  ): Promise<R> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    try {
      const raw: unknown = await Promise.race([
        browser.debugger.sendCommand({ tabId: this.tabId }, method, params),
        timeout,
      ]);
      return raw as R;
    } finally {
      clearTimeout(timer);
    }
  }

  async attach(): Promise<void> {
    await browser.debugger.attach({ tabId: this.tabId }, "1.3");
  }

  async detach(): Promise<void> {
    this.enabled = false;
    await browser.debugger.detach({ tabId: this.tabId });
  }

  async enableDomains(): Promise<void> {
    if (this.enabled) return;
    await this.send("Accessibility.enable");
    await this.send("DOM.enable");
    await this.send("Page.enable");
    await this.send("Runtime.enable");
    this.enabled = true;
  }

  async reconcile(): Promise<void> {
    this.enabled = false;
    await this.enableDomains();
    await this.bumpGeneration();
  }

  // Generation-namespaced refs (see driver/a11y.ts) make staleness detectable:
  // a ref from a prior snapshot generation fails the prefix check below.
  resolveRef(ref: string): number | null {
    if (!ref.startsWith(`s${this.generation}e`)) return null;
    return this.refMap.get(ref) ?? null;
  }

  markLoadStarted(): void {
    this.loadInFlight = true;
  }

  notifyLoadEventFired(): void {
    this.loadInFlight = false;
    const waiters = [...this.loadWaiters];
    this.loadWaiters.clear();
    for (const wake of waiters) wake();
  }

  private waitForLoad(timeoutMs: number): Promise<void> {
    if (!this.loadInFlight) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      const wake = (): void => {
        clearTimeout(timer);
        this.loadWaiters.delete(wake);
        resolve();
      };
      timer = setTimeout(() => {
        this.loadInFlight = false;
        wake();
      }, timeoutMs);
      this.loadWaiters.add(wake);
    });
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn, fn);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private run(commandId: string, body: () => Promise<Event>): Promise<Event> {
    return this.enqueue(async () => {
      try {
        return await body();
      } catch (cause) {
        return { type: "action_result", commandId, ok: false, error: errorMessage(cause) };
      }
    });
  }

  private async optional<T>(action: Promise<T>): Promise<T | undefined> {
    try {
      return await action;
    } catch {
      return undefined;
    }
  }

  private async dispatchClick(backendNodeId: number): Promise<void> {
    await this.optional(this.send("DOM.scrollIntoViewIfNeeded", { backendNodeId }));
    let model: Protocol.DOM.BoxModel;
    try {
      const res = await this.send<Protocol.DOM.GetBoxModelResponse>("DOM.getBoxModel", {
        backendNodeId,
      });
      model = res.model;
    } catch (cause) {
      if (isBoxModelError(cause)) {
        await this.clickViaScript(backendNodeId);
        return;
      }
      throw cause;
    }
    const { x, y } = quadCenter(model.content);
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await this.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    await this.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });
  }

  private async clickViaScript(backendNodeId: number): Promise<void> {
    const resolved = await this.send<Protocol.DOM.ResolveNodeResponse>("DOM.resolveNode", {
      backendNodeId,
    });
    const objectId = resolved.object.objectId;
    if (objectId === undefined) {
      throw new Error("DOM.resolveNode returned no objectId for click fallback");
    }
    await this.send("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: "function(){this.scrollIntoView({block:'center'});this.click();}",
    });
  }

  private async focusOrClick(backendNodeId: number): Promise<void> {
    try {
      await this.send("DOM.focus", { backendNodeId });
    } catch {
      await this.dispatchClick(backendNodeId);
    }
  }

  snapshotA11y(commandId: string): Promise<Event> {
    return this.run(commandId, async () => {
      const { nodes } = await this.send<Protocol.Accessibility.GetFullAXTreeResponse>(
        "Accessibility.getFullAXTree",
      );
      const gen = await this.bumpGeneration();
      const { tree, refMap } = buildA11ySnapshot(nodes, gen);
      this.refMap = refMap;
      return { type: "snapshot_result", commandId, tree };
    });
  }

  // Pure ref-map lookup: MUST NOT snapshot or bump the generation. This is
  // the dry-run probe's truth source; taking a snapshot here would invalidate
  // the very ref being checked (and every other outstanding ref). Runs through
  // the FIFO queue so it observes any generation bump already in flight.
  resolveRefCheck(commandId: string, ref: string): Promise<Event> {
    return this.run(commandId, async () => {
      if (this.resolveRef(ref) === null) {
        return actionError(commandId, `stale or unknown ref: ${ref}`);
      }
      return { type: "action_result", commandId, ok: true };
    });
  }

  screenshot(commandId: string): Promise<Event> {
    return this.run(commandId, async () => {
      const { data } = await this.send<Protocol.Page.CaptureScreenshotResponse>(
        "Page.captureScreenshot",
        { format: "png" },
      );
      return { type: "screenshot_result", commandId, mime: "image/png", b64: data };
    });
  }

  click(commandId: string, ref: string): Promise<Event> {
    return this.run(commandId, async () => {
      const backendNodeId = this.resolveRef(ref);
      if (backendNodeId === null) {
        return actionError(commandId, `stale or unknown ref: ${ref}`);
      }
      await this.dispatchClick(backendNodeId);
      return { type: "action_result", commandId, ok: true };
    });
  }

  type(commandId: string, ref: string, text: string, submit?: boolean): Promise<Event> {
    return this.run(commandId, async () => {
      const backendNodeId = this.resolveRef(ref);
      if (backendNodeId === null) {
        return actionError(commandId, `stale or unknown ref: ${ref}`);
      }
      await this.focusOrClick(backendNodeId);
      await this.send("Input.insertText", { text });
      if (submit === true) {
        const enter = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 };
        await this.send("Input.dispatchKeyEvent", { type: "keyDown", ...enter });
        await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...enter });
      }
      return { type: "action_result", commandId, ok: true };
    });
  }

  key(commandId: string, keys: string, ref?: string): Promise<Event> {
    return this.run(commandId, async () => {
      if (ref !== undefined) {
        const backendNodeId = this.resolveRef(ref);
        if (backendNodeId === null) {
          return actionError(commandId, `stale or unknown ref: ${ref}`);
        }
        await this.optional(this.send("DOM.focus", { backendNodeId }));
      }
      const parsed = parseKeys(keys);
      const base: Record<string, unknown> = {
        modifiers: parsed.modifiers,
        key: parsed.key,
        code: parsed.code,
        windowsVirtualKeyCode: parsed.windowsVirtualKeyCode,
      };
      const keyDown: Record<string, unknown> = { ...base, type: "keyDown" };
      if (parsed.text !== undefined) keyDown.text = parsed.text;
      await this.send("Input.dispatchKeyEvent", keyDown);
      await this.send("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
      return { type: "action_result", commandId, ok: true };
    });
  }

  scroll(commandId: string, dy: number, ref?: string): Promise<Event> {
    return this.run(commandId, async () => {
      if (ref === undefined) {
        await this.send("Runtime.evaluate", { expression: `window.scrollBy(0,${dy})` });
      } else {
        const backendNodeId = this.resolveRef(ref);
        if (backendNodeId === null) {
          return actionError(commandId, `stale or unknown ref: ${ref}`);
        }
        const { model } = await this.send<Protocol.DOM.GetBoxModelResponse>("DOM.getBoxModel", {
          backendNodeId,
        });
        const { x, y } = quadCenter(model.content);
        await this.send("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x,
          y,
          deltaX: 0,
          deltaY: dy,
        });
      }
      return { type: "action_result", commandId, ok: true };
    });
  }

  wait(commandId: string, waitFor: WaitFor, value?: number): Promise<Event> {
    return this.run(commandId, async () => {
      if (waitFor === "ms") {
        await delay(value ?? 0);
      } else if (waitFor === "load") {
        await this.waitForLoad(LOAD_TIMEOUT_MS);
      } else {
        await this.waitForLoad(LOAD_TIMEOUT_MS);
        await delay(IDLE_QUIET_MS);
      }
      return { type: "action_result", commandId, ok: true, url: this.currentUrl };
    });
  }

  navigate(commandId: string, url: string): Promise<Event> {
    return this.run(commandId, async () => {
      await this.bumpGeneration();
      this.markLoadStarted();
      const res = await this.send<Protocol.Page.NavigateResponse>("Page.navigate", { url });
      if (res.errorText !== undefined) {
        this.loadInFlight = false;
        return actionError(commandId, res.errorText || `Page.navigate failed for ${url}`);
      }
      await this.waitForLoad(LOAD_TIMEOUT_MS);
      return { type: "action_result", commandId, ok: true, url: this.currentUrl };
    });
  }
}
