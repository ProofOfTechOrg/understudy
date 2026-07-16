import { RequestContext } from "@mastra/core/request-context";
import { AuditLogger } from "@proofoftech/breakwater/audit";
import {
  APPROVED_CONNECTORS_CONTEXT_KEY,
  ConnectorPolicyError,
  InMemoryIdempotencyStore,
  InMemoryRateLimitStore,
} from "@proofoftech/breakwater/connector-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BROWSER_ACT_CONNECTOR,
  BROWSER_FILL_CREDENTIAL_CONNECTOR,
  BROWSER_WRITE_CONNECTOR_IDS,
  type ActOutput,
  type ConnectorStores,
  type FillCredentialOutput,
  type ObserveInput,
  type ObserveOutput,
  callBrowserDryRun,
  callBrowserWrite,
  callConnector,
  createBrowserConnectors,
} from "./index";

const ENV = {
  UNDERSTUDY_URL: "https://understudy.example.com",
  UNDERSTUDY_TOKEN: "caller-token-1",
};

function stores(): ConnectorStores {
  return {
    idempotencyStore: new InMemoryIdempotencyStore(),
    rateLimitStore: new InMemoryRateLimitStore(),
  };
}

function grantFor(...ids: string[]): RequestContext {
  return new RequestContext(Object.entries({ [APPROVED_CONNECTORS_CONTEXT_KEY]: ids }));
}

function eventResponse(event: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(event), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// The egress guard passes (url, init) through to the base fetch on hop 0, so
// the spy sees exactly what callUnderstudy sent (plus redirect: 'manual').
function sentRequest(spy: ReturnType<typeof vi.fn>, call = 0): { url: string; body: unknown; headers: Record<string, string> } {
  const args = spy.mock.calls[call];
  if (!args) throw new Error(`fetch call ${call} not recorded`);
  const [url, init] = args as [string, { body: string; headers: Record<string, string> }];
  return { url, body: JSON.parse(init.body), headers: init.headers };
}

const CLICK = { sessionId: "s-1", action: { type: "click", ref: "s1e2" } } as const;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("grant gate (fail closed)", () => {
  it("denies a write without the approval grant and never reaches the service", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { act } = createBrowserConnectors(ENV, stores());

    await expect(
      callBrowserWrite(act, CLICK, undefined, "case1:step1:click"),
    ).rejects.toThrowError(ConnectorPolicyError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a grant for a DIFFERENT connector id does not authorize act", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { act } = createBrowserConnectors(ENV, stores());

    await expect(
      callBrowserWrite(act, CLICK, grantFor("browser.observe"), "case1:step1:click"),
    ).rejects.toThrowError(ConnectorPolicyError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects invalid input with a throw before any request (Mastra sentinel normalized)", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { act } = createBrowserConnectors(ENV, stores());
    const missingSession = { action: { type: "click", ref: "s1e2" } } as unknown as typeof CLICK;

    await expect(
      callBrowserWrite(act, missingSession, grantFor(BROWSER_ACT_CONNECTOR), "k1"),
    ).rejects.toThrow(/input validation failed/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("lists exactly the write connectors for grant minting", () => {
    expect(BROWSER_WRITE_CONNECTOR_IDS).toContain(BROWSER_ACT_CONNECTOR);
    expect(BROWSER_WRITE_CONNECTOR_IDS).toContain(BROWSER_FILL_CREDENTIAL_CONNECTOR);
    expect(BROWSER_WRITE_CONNECTOR_IDS).toHaveLength(2);
  });
});

describe("act", () => {
  it("executes with the grant: bearer auth, /v1 route, protocol command; replays on the same key", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      eventResponse({ type: "action_result", commandId: "c1", ok: true, url: "https://portal.example/" }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const { act } = createBrowserConnectors(ENV, stores());
    const grant = grantFor(BROWSER_ACT_CONNECTOR);

    const first = await callBrowserWrite<typeof CLICK, ActOutput>(act, CLICK, grant, "case1:step1:click");
    const second = await callBrowserWrite<typeof CLICK, ActOutput>(act, CLICK, grant, "case1:step1:click");

    expect(first).toEqual({ ok: true, url: "https://portal.example/", error: undefined });
    expect(second).toEqual(first); // replayed, not re-executed
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const { url, body, headers } = sentRequest(fetchSpy);
    expect(url).toBe("https://understudy.example.com/v1/sessions/s-1/commands");
    expect(headers.authorization).toBe("Bearer caller-token-1");
    expect(body).toMatchObject({
      dryRun: false,
      command: { type: "click", ref: "s1e2" },
    });
    expect((body as { command: { commandId: unknown } }).command.commandId).toBeTypeOf("string");
  });

  it("dry-run needs no grant, sends dryRun:true, and marks the output simulated", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      eventResponse({ type: "action_result", commandId: "c1", ok: true, simulated: true }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const { act } = createBrowserConnectors(ENV, stores());

    const preview = await callBrowserDryRun<typeof CLICK, ActOutput>(act, CLICK);

    expect(preview.simulated).toBe(true);
    expect(preview.ok).toBe(true);
    const { body } = sentRequest(fetchSpy);
    expect(body).toMatchObject({ dryRun: true, command: { type: "click" } });
  });
});

describe("observe (read - no grant, no idempotency)", () => {
  async function observeRead(read: ObserveInput["read"], event: Record<string, unknown>): Promise<ObserveOutput> {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(eventResponse(event)));
    const { observe } = createBrowserConnectors(ENV, stores());
    return callConnector(observe, { sessionId: "s-1", read }, undefined);
  }

  it("snapshot returns the a11y tree", async () => {
    const tree = [{ ref: "s1e1", role: "button", name: "Go" }];
    const out = await observeRead(
      { type: "snapshot", mode: "a11y" },
      { type: "snapshot_result", commandId: "c1", tree },
    );
    expect(out).toEqual({ tree });
  });

  it("snapshot in screenshot mode returns the image artifact", async () => {
    const out = await observeRead(
      { type: "snapshot", mode: "screenshot" },
      { type: "screenshot_result", commandId: "c1", mime: "image/png", b64: "aGk=" },
    );
    expect(out).toEqual({ screenshot: { mime: "image/png", b64: "aGk=" } });
  });

  it("get_tabs returns the tab list", async () => {
    const tabs = [{ tabId: 7, url: "https://x/", title: "X", active: true }];
    const out = await observeRead({ type: "get_tabs" }, { type: "tabs_result", commandId: "c1", tabs });
    expect(out).toEqual({ tabs });
  });

  it("wait returns the action outcome", async () => {
    const out = await observeRead(
      { type: "wait", for: "load" },
      { type: "action_result", commandId: "c1", ok: true },
    );
    expect(out).toEqual({ ok: true, error: undefined });
  });

  it("wait surfaces a failed outcome with its error", async () => {
    const out = await observeRead(
      { type: "wait", for: "load" },
      { type: "action_result", commandId: "c1", ok: false, error: "timeout waiting for load" },
    );
    expect(out).toEqual({ ok: false, error: "timeout waiting for load" });
  });

  it("throws on an event that does not answer the read", async () => {
    await expect(
      observeRead({ type: "get_tabs" }, { type: "action_result", commandId: "c1", ok: true }),
    ).rejects.toThrow(/unexpected event 'action_result' for read 'get_tabs'/);
  });
});

describe("fill_credential (vaulted write)", () => {
  const INPUT = { sessionId: "s-1", ref: "s1e9", secretRef: "vault://acme/portal/password" };

  it("passes the opaque secretRef through - the wire carries no plaintext field", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      eventResponse({ type: "action_result", commandId: "c1", ok: true }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const { fillCredential } = createBrowserConnectors(ENV, stores());

    const out = await callBrowserWrite<typeof INPUT, FillCredentialOutput>(
      fillCredential,
      INPUT,
      grantFor(BROWSER_FILL_CREDENTIAL_CONNECTOR),
      "case1:login:fill",
    );

    expect(out).toEqual({ ok: true, filled: true, error: undefined });
    const { body } = sentRequest(fetchSpy);
    expect(body).toMatchObject({
      command: { type: "fill_secret", ref: "s1e9", secretRef: "vault://acme/portal/password" },
    });
    expect(Object.keys((body as { command: Record<string, unknown> }).command).sort()).toEqual([
      "commandId",
      "ref",
      "secretRef",
      "type",
    ]);
  });

  it("dry-run confirms the ref without filling: filled stays false, simulated true", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      eventResponse({ type: "action_result", commandId: "c1", ok: true, simulated: true }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const { fillCredential } = createBrowserConnectors(ENV, stores());

    const preview = await callBrowserDryRun<typeof INPUT, FillCredentialOutput>(fillCredential, INPUT);

    expect(preview).toEqual({ ok: true, filled: false, error: undefined, simulated: true });
    const { body } = sentRequest(fetchSpy);
    expect(body).toMatchObject({ dryRun: true });
  });
});

describe("service bridge hardening", () => {
  it("denies a redirect off the understudy host (egress guard, per hop)", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(null, { status: 302, headers: { location: "https://evil.example/exfil" } }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const { observe } = createBrowserConnectors(ENV, stores());

    await expect(
      callConnector(observe, { sessionId: "s-1", read: { type: "get_tabs" } }, undefined),
    ).rejects.toThrowError(ConnectorPolicyError);
    expect(fetchSpy).toHaveBeenCalledTimes(1); // the hop was denied before a second request
  });

  it("throws status-only on an HTTP error - response bodies are never echoed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(eventResponse({ error: "unauthorized", detail: "S3CRET-DETAIL" }, 401)),
    );
    const { observe } = createBrowserConnectors(ENV, stores());

    const failure = callConnector(observe, { sessionId: "s-1", read: { type: "get_tabs" } }, undefined);
    await expect(failure).rejects.toThrow(/understudy service 401 for session s-1/);
    await expect(failure).rejects.not.toThrow(/S3CRET-DETAIL/);
  });

  it("rejects a payload that is not a protocol Event", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(eventResponse({ nope: true })));
    const { observe } = createBrowserConnectors(ENV, stores());

    await expect(
      callConnector(observe, { sessionId: "s-1", read: { type: "get_tabs" } }, undefined),
    ).rejects.toThrow();
  });

  it("denies the 61st act execution in a fixed rate window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(60_000); // window start - all calls land in one fixed window
    try {
      const fetchSpy = vi.fn(async () =>
        eventResponse({ type: "action_result", commandId: "c1", ok: true }),
      );
      vi.stubGlobal("fetch", fetchSpy);
      const { act } = createBrowserConnectors(ENV, stores());
      const grant = grantFor(BROWSER_ACT_CONNECTOR);

      for (let i = 0; i < 60; i++) {
        await callBrowserWrite(act, CLICK, grant, `k${i}`);
      }
      await expect(callBrowserWrite(act, CLICK, grant, "k60")).rejects.toThrow(
        /exceeded 60\/min/,
      );
      expect(fetchSpy).toHaveBeenCalledTimes(60);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a failed execute is not cached: the same key re-executes on retry", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(eventResponse({ error: "boom" }, 500))
      .mockResolvedValueOnce(eventResponse({ type: "action_result", commandId: "c1", ok: true }));
    vi.stubGlobal("fetch", fetchSpy);
    const { act } = createBrowserConnectors(ENV, stores());
    const grant = grantFor(BROWSER_ACT_CONNECTOR);

    await expect(callBrowserWrite(act, CLICK, grant, "retry-key")).rejects.toThrow(
      /understudy service 500/,
    );
    const retried = await callBrowserWrite<typeof CLICK, ActOutput>(act, CLICK, grant, "retry-key");
    expect(retried.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2); // reservation released, retry re-executed
  });

  it("accepts a ported dev URL - egress pins to the hostname, not host:port", async () => {
    // .host would carry ':8787', which breakwater's egress allowlist rejects
    // at construction - the wrangler-dev consumer loop depends on this.
    const fetchSpy = vi.fn().mockResolvedValue(
      eventResponse({ type: "tabs_result", commandId: "c1", tabs: [] }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const { observe } = createBrowserConnectors(
      { UNDERSTUDY_URL: "http://localhost:8787", UNDERSTUDY_TOKEN: "dev-caller-token" },
      stores(),
    );

    const out = await callConnector(observe, { sessionId: "s-1", read: { type: "get_tabs" } }, undefined);
    expect(out).toEqual({ tabs: [] });
    expect(sentRequest(fetchSpy).url).toBe("http://localhost:8787/v1/sessions/s-1/commands");
  });

  it("records decisions through the audit pass-through", async () => {
    const events: Array<{ decision: string; resource: string }> = [];
    const audit = new AuditLogger({
      sink: (event) => {
        events.push({ decision: event.decision, resource: event.resource });
      },
    });
    vi.stubGlobal("fetch", vi.fn());
    const { act } = createBrowserConnectors(ENV, stores(), { audit });

    await expect(callBrowserWrite(act, CLICK, undefined, "k1")).rejects.toThrowError(
      ConnectorPolicyError,
    );
    expect(events).toContainEqual({ decision: "denied", resource: BROWSER_ACT_CONNECTOR });
  });

  it("URL-encodes the sessionId path segment", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      eventResponse({ type: "tabs_result", commandId: "c1", tabs: [] }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const { observe } = createBrowserConnectors(ENV, stores());

    await callConnector(observe, { sessionId: "s/../1", read: { type: "get_tabs" } }, undefined);
    expect(sentRequest(fetchSpy).url).toBe(
      "https://understudy.example.com/v1/sessions/s%2F..%2F1/commands",
    );
  });
});
