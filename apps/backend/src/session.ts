import { Agent } from "agents";
import type { AgentContext, Connection, ConnectionContext, WSMessage } from "agents";
import { isWriteCommand, safeParseEvent } from "@understudy/protocol";
import type { Command, Event } from "@understudy/protocol";
import { scopeSession, verifyExtensionToken } from "./auth";
import { SESSION_NOT_CONNECTED } from "./coordinator";
import { CfSessionCoordinator } from "./coordinator-cf";
import { resolveSecret } from "./secrets";
import type { Env, SessionState, SessionStatus } from "./types";

type FillSecretCommand = Extract<Command, { type: "fill_secret" }>;

export class SessionAgent extends Agent<Env, SessionState> {
  initialState: SessionState = {
    browser: null,
    tabs: [],
    currentUrl: null,
    generation: 0,
    awaitingCommandIds: [],
    status: "pending",
  };

  private readonly coordinator: CfSessionCoordinator;

  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env);
    this.coordinator = new CfSessionCoordinator({
      // getConnections() is hibernation-safe like broadcast(), but filtered to
      // connections onConnect has marked authorized: the SDK accepts a socket
      // (and admits it to the connection set) before onConnect's async auth
      // check resolves, so an unverified or wrong-tenant socket can sit here
      // during that gap - sending to it directly would hand it a plaintext
      // command.
      sendToExtension: (payload) => {
        for (const connection of this.getConnections()) {
          if (this.isAuthorizedConnection(connection)) connection.send(payload);
        }
      },
      hasAuthorizedConnection: () => this.hasAuthorizedConnection(),
      getAwaitingCommandIds: () => this.state.awaitingCommandIds,
      persistAwaitingCommandIds: (ids) => this.setState({ ...this.state, awaitingCommandIds: ids }),
      persistStatus: (status) => this.setState({ ...this.state, status }),
    });
  }

  async onConnect(connection: Connection, ctx: ConnectionContext): Promise<void> {
    const token = new URL(ctx.request.url).searchParams.get("token") ?? "";
    const res = await verifyExtensionToken(token, this.env);
    if (res === null) {
      connection.close(1008, "invalid extension token");
      return;
    }
    const scope = await scopeSession(this.name, res.tenantId, this.env);
    if (scope !== "ok") {
      connection.close(1008, "tenant mismatch");
      return;
    }
    connection.setState({ authorized: true });
    this.setState({ ...this.state, status: "connected" });
  }

  /**
   * accept() (and the SDK's own connect-time protocol frames) can happen
   * before onConnect's async auth check above resolves, so any accepted
   * connection - not just ones onConnect has verified - would otherwise
   * receive them. The extension only speaks the @understudy/protocol
   * Event/Command wire shape and already discards anything else (see
   * safeParseEvent/safeParseCommand), so suppressing the SDK's own frames
   * unconditionally costs nothing for a real connection.
   */
  shouldSendProtocolMessages(connection: Connection, ctx: ConnectionContext): boolean {
    return false;
  }

  /**
   * The SDK's generic client -> server state-sync path (a `cf_agent_state`
   * WS message) reaches this hook for ANY accepted connection - including
   * one still waiting on onConnect's auth check - via `source` set to the
   * sending Connection rather than "server". This DO's state is
   * server-driven only (onMessage sets it from parsed protocol Events, and
   * this class's own writes always go through the default "server"
   * source), so any other source is rejected outright.
   */
  validateStateChange(nextState: SessionState, source: Connection | "server"): void {
    if (source !== "server") {
      throw new Error("session state is server-driven; rejecting a client-initiated update");
    }
  }

  async onMessage(connection: Connection, message: WSMessage): Promise<void> {
    if (!this.isAuthorizedConnection(connection)) return;
    if (typeof message !== "string") return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch {
      return;
    }

    const result = safeParseEvent(parsed);
    if (!result.success) return;
    const ev = result.data;

    switch (ev.type) {
      case "snapshot_result":
      case "screenshot_result":
      case "tabs_result":
      case "action_result":
      case "pong":
        this.coordinator.resolvePending(ev);
        return;
      case "hello":
        this.coordinator.abandonInFlight("session resynced: hello");
        this.setState({
          ...this.state,
          browser: { browser: ev.browser, extVersion: ev.extVersion },
          tabs: ev.tabs,
          generation: this.state.generation + 1,
          status: "connected",
        });
        return;
      case "page_event":
        this.setState({ ...this.state, currentUrl: ev.url });
        return;
    }
  }

  async onClose(connection: Connection, code: number, reason: string, wasClean: boolean): Promise<void> {
    // Only the LAST authorized socket's close detaches the session: a late
    // close event from a replaced socket must not stamp "detached" over a
    // healthy reconnect (the closing connection is excluded explicitly, in
    // case the SDK has not yet reaped it from the connection set).
    const stillLive = [...this.getConnections()].some(
      (c) => c !== connection && this.isAuthorizedConnection(c),
    );
    if (!stillLive) this.setState({ ...this.state, status: "detached" });
  }

  async dispatch(command: Command, dryRun?: boolean): Promise<Event> {
    if (!dryRun) {
      return this.coordinator.send(command);
    }
    if (!isWriteCommand(command)) {
      return this.coordinator.send(command);
    }

    const probe = await this.checkRefResolves(this.commandRef(command));
    return this.simulatedResult(command.commandId, probe);
  }

  async fillSecret(cmd: FillSecretCommand, dryRun?: boolean): Promise<Event> {
    if (dryRun) {
      return this.simulatedResult(cmd.commandId, await this.checkRefResolves(cmd.ref));
    }

    // Gate BEFORE the vault: resolving a secret for a command that cannot
    // dispatch would materialize plaintext (and emit a vault access) for
    // nothing - fail-fast matters most exactly here (DL-004).
    if (!this.hasAuthorizedConnection()) {
      throw new Error(`${SESSION_NOT_CONNECTED}: no authorized extension connection`);
    }

    let secret: string;
    try {
      secret = await resolveSecret(this.env.VAULT, cmd.secretRef);
    } catch {
      return {
        type: "action_result",
        commandId: cmd.commandId,
        ok: false,
        error: "fill_secret: secret could not be resolved",
      };
    }

    return this.coordinator.send({
      type: "type",
      commandId: cmd.commandId,
      ref: cmd.ref,
      text: secret,
      submit: cmd.submit,
    });
  }

  async getStatus(): Promise<{
    status: SessionStatus;
    browser: SessionState["browser"];
    tabs: SessionState["tabs"];
    currentUrl: string | null;
  }> {
    return {
      status: this.state.status,
      browser: this.state.browser,
      tabs: this.state.tabs,
      currentUrl: this.state.currentUrl,
    };
  }

  // Probes via resolve_ref - a pure ref-map lookup extension-side. A snapshot
  // probe is disqualified here: the extension re-mints every ref per snapshot
  // (generation bump), so it can never contain the consumer's ref AND it
  // invalidates the consumer's outstanding refs, breaking the approved
  // command that follows the dry-run.
  private async checkRefResolves(
    ref: string | undefined,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (ref === undefined) return { ok: true };

    const ev = await this.coordinator.send({
      type: "resolve_ref",
      commandId: crypto.randomUUID(),
      ref,
    });
    if (ev.type !== "action_result") {
      return { ok: false, reason: `unexpected probe response '${ev.type}'` };
    }
    if (ev.ok) return { ok: true };
    // Surface the extension's own reason (e.g. "stale or unknown ref: s1e2")
    // instead of collapsing every probe failure into one generic string.
    return { ok: false, reason: ev.error ?? "ref did not resolve" };
  }

  /** The simulated action_result a dry-run returns in place of dispatching. */
  private simulatedResult(
    commandId: string,
    probe: { ok: true } | { ok: false; reason: string },
  ): Event {
    return {
      type: "action_result",
      commandId,
      ok: probe.ok,
      ...(probe.ok ? {} : { error: `dry-run: ${probe.reason}` }),
      simulated: true,
    };
  }

  private commandRef(command: Command): string | undefined {
    switch (command.type) {
      case "click":
      case "type":
      case "fill_secret":
      case "key":
        return command.ref;
      default:
        return undefined;
    }
  }

  private isAuthorizedConnection(connection: Connection): boolean {
    return (connection.state as { authorized?: boolean } | null)?.authorized === true;
  }

  // The delivery predicate the coordinator's fail-fast gate consults: the
  // same precondition sendToExtension relies on, NOT the persisted status
  // scalar (which a late onClose from a replaced socket can leave stale).
  private hasAuthorizedConnection(): boolean {
    for (const connection of this.getConnections()) {
      if (this.isAuthorizedConnection(connection)) return true;
    }
    return false;
  }
}
