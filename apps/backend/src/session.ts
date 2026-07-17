import { Agent } from "agents";
import type { AgentContext, Connection, ConnectionContext, WSMessage } from "agents";
import { isWriteCommand, safeParseEvent } from "@understudy/protocol";
import type { Command, Event } from "@understudy/protocol";
import { scopeSession, tenantOf, verifyExtensionToken } from "./auth";
import {
  COMMAND_TIMED_OUT,
  DUPLICATE_COMMAND,
  SESSION_NOT_CONNECTED,
  SESSION_RESYNCED,
} from "./coordinator";
import { CfSessionCoordinator } from "./coordinator-cf";
import { resolveSecret } from "./secrets";
import { createVault } from "./vault";
import type { DispatchOutcome, Env, SessionState, SessionStatus } from "./types";

type FillSecretCommand = Extract<Command, { type: "fill_secret" }>;

// Bounds SessionState.completedWrites (the idempotent-retry replay record).
// 100 write results at ~100 bytes each is well under any DO state budget
// while covering far more retries than a consumer's per-case write count.
const COMPLETED_WRITES_CAP = 100;

// Bounds SessionState.dialogs (the recent-dialogs surface). Dialogs are far
// rarer than writes; 50 recent covers any realistic burst a consumer polls for.
const RECENT_DIALOGS_CAP = 50;

export class SessionAgent extends Agent<Env, SessionState> {
  initialState: SessionState = {
    browser: null,
    tabs: [],
    currentUrl: null,
    generation: 0,
    awaitingCommandIds: [],
    status: "pending",
    completedWrites: [],
    dialogs: [],
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
        this.coordinator.abandonInFlight(`${SESSION_RESYNCED}: hello`);
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
      case "dialog":
        this.rememberDialog(ev);
        return;
    }
  }

  async onClose(connection: Connection, code: number, reason: string, wasClean: boolean): Promise<void> {
    // A socket that never passed onConnect's auth check never contributed
    // to the session's status, so its close must not change it either - a
    // rejected/never-authorized socket closing on a fresh session would
    // otherwise stamp "pending" over with "detached".
    if (!this.isAuthorizedConnection(connection)) return;
    // Only the LAST authorized socket's close detaches the session: a late
    // close event from a replaced socket must not stamp "detached" over a
    // healthy reconnect (the closing connection is excluded explicitly, in
    // case the SDK has not yet reaped it from the connection set).
    const stillLive = [...this.getConnections()].some(
      (c) => c !== connection && this.isAuthorizedConnection(c),
    );
    if (!stillLive) this.setState({ ...this.state, status: "detached" });
  }

  async dispatch(command: Command, dryRun?: boolean): Promise<DispatchOutcome> {
    try {
      if (dryRun === true && isWriteCommand(command)) {
        const probe = await this.checkRefResolves(this.commandRef(command));
        return { ok: true, event: this.simulatedResult(command.commandId, probe) };
      }

      // Real dispatch (a dry-run READ also lands here: it executes for real).
      // A write whose Event was already recorded replays it instead of
      // executing twice - the consumer retries under the same commandId when
      // its previous attempt's response was lost or unparseable. The
      // completedWrite helpers no-op for reads (incl. a dry-run read), so no
      // dryRun guard is needed here: a dry-run write already returned above.
      const replayed = this.completedWriteEvent(command);
      if (replayed !== undefined) return { ok: true, event: replayed };

      const event = await this.coordinator.send(command);
      this.rememberCompletedWrite(command, event);
      return { ok: true, event };
    } catch (err) {
      return this.dispatchFailure(err);
    }
  }

  async fillSecret(cmd: FillSecretCommand, dryRun?: boolean): Promise<DispatchOutcome> {
    try {
      if (dryRun === true) {
        // A dry-run the real call would refuse for tenant scoping simulates
        // that refusal (before the DOM ref probe), so a governance pre-approval
        // preview is honest rather than reporting ok:true for a fill that can
        // never dispatch. Still zero vault access and no wire traffic:
        // secretRefInTenant only reads the signed sessionId (this.name).
        if (!(await this.secretRefInTenant(cmd.secretRef))) {
          return {
            ok: true,
            event: this.simulatedResult(cmd.commandId, {
              ok: false,
              reason: "secret could not be resolved",
            }),
          };
        }
        return {
          ok: true,
          event: this.simulatedResult(cmd.commandId, await this.checkRefResolves(cmd.ref)),
        };
      }

      // Tenant scoping FIRST, before replay/gate/vault: a secretRef resolves
      // only within this session's OWN tenant, derived from the HMAC-signed
      // sessionId (this.name) - never a caller claim - so tenantB driving its
      // own session can never read vault://tenantA/... understudy owns one
      // shared vault across tenants, so this check lives here, not in a
      // consumer's breakwater. A ref outside the tenant namespace collapses to
      // the SAME scrubbed ok:false an absent secret returns: no vault read, no
      // dispatch, and no oracle telling "not yours" from "does not exist"
      // (DL-008).
      if (!(await this.secretRefInTenant(cmd.secretRef))) {
        return { ok: true, event: this.unresolvableSecretResult(cmd.commandId) };
      }

      // Replay BEFORE the connection gate and the vault: a retry of an
      // already-performed fill needs neither liveness nor plaintext.
      const replayed = this.completedWriteEvent(cmd);
      if (replayed !== undefined) return { ok: true, event: replayed };

      // Gate BEFORE the vault: resolving a secret for a command that cannot
      // dispatch would materialize plaintext (and emit a vault access) for
      // nothing - fail-fast matters most exactly here (DL-004).
      if (!this.hasAuthorizedConnection()) {
        return {
          ok: false,
          reason: "not_connected",
          message: `${SESSION_NOT_CONNECTED}: no authorized extension connection`,
        };
      }

      let secret: string;
      try {
        secret = await resolveSecret(createVault(this.env), cmd.secretRef);
      } catch {
        return { ok: true, event: this.unresolvableSecretResult(cmd.commandId) };
      }

      const event = await this.coordinator.send({
        type: "type",
        commandId: cmd.commandId,
        ref: cmd.ref,
        text: secret,
        submit: cmd.submit,
      });
      this.rememberCompletedWrite(cmd, event);
      return { ok: true, event };
    } catch (err) {
      return this.dispatchFailure(err);
    }
  }

  /**
   * Whether `secretRef` lives in this session's own tenant namespace. The
   * tenant is the one HMAC-signed into the sessionId (this.name) - the same
   * authoritative source onConnect scopes the socket against - so it cannot be
   * forged by a caller. Vault keys are canonically `vault://<tenantId>/<name>`
   * (README "Design decisions"). tenantOf only returns a `/`-free, non-empty
   * tenant (auth.ts::isValidTenantId), so the trailing slash makes the prefix
   * exact and unambiguous: tenant "acme" reaches neither "acme-corp"'s nor a
   * hypothetical "acme/eu"'s keys.
   */
  private async secretRefInTenant(secretRef: string): Promise<boolean> {
    const tenant = await tenantOf(this.name, this.env);
    return tenant !== null && secretRef.startsWith(`vault://${tenant}/`);
  }

  /**
   * The one scrubbed ok:false a fill_secret returns when the secret cannot be
   * produced - whether the ref is outside the caller's tenant, absent, or
   * undecryptable. Byte-identical across those causes on purpose: the caller
   * (and an attacker) learns only "could not be resolved", never which
   * (DL-008), and no secret material appears in it (DL-004).
   */
  private unresolvableSecretResult(commandId: string): Event {
    return {
      type: "action_result",
      commandId,
      ok: false,
      error: "fill_secret: secret could not be resolved",
    };
  }

  /**
   * Maps the coordinator's prefixed rejections to the typed outcome union
   * IN-ISOLATE, so no expected failure ever crosses the RPC boundary as a
   * rejected promise (workerd logs those as uncaught exceptions even when
   * the Worker-side caller handles them). Anything unrecognized rethrows -
   * that is a genuine bug and deserves both the noise and the 500.
   */
  private dispatchFailure(err: unknown): DispatchOutcome {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith(SESSION_NOT_CONNECTED)) {
      return { ok: false, reason: "not_connected", message };
    }
    if (message.startsWith(COMMAND_TIMED_OUT)) {
      return { ok: false, reason: "timed_out", message };
    }
    if (message.startsWith(SESSION_RESYNCED)) {
      return { ok: false, reason: "resynced", message };
    }
    if (message.startsWith(DUPLICATE_COMMAND)) {
      return { ok: false, reason: "duplicate_in_flight", message };
    }
    throw err;
  }

  /** The recorded Event for an already-completed write commandId, if any. */
  private completedWriteEvent(command: Command): Event | undefined {
    if (!isWriteCommand(command)) return undefined;
    return this.completedWrites().find((entry) => entry.commandId === command.commandId)?.event;
  }

  private rememberCompletedWrite(command: Command, event: Event): void {
    if (!isWriteCommand(command)) return;
    const next = [
      ...this.completedWrites().filter((entry) => entry.commandId !== command.commandId),
      { commandId: command.commandId, event },
    ];
    while (next.length > COMPLETED_WRITES_CAP) next.shift();
    this.setState({ ...this.state, completedWrites: next });
  }

  // Persisted before this field existed, a session's state can lack it;
  // initialState only seeds brand-new DOs.
  private completedWrites(): SessionState["completedWrites"] {
    return this.state.completedWrites ?? [];
  }

  /** Records a handled page dialog (capped) for the GET /v1/sessions/:id surface. */
  private rememberDialog(ev: Extract<Event, { type: "dialog" }>): void {
    // Strip only the wire discriminator: object-rest yields exactly DialogRecord
    // (preserving defaultPrompt's presence/absence), so a new protocol dialog
    // field persists automatically - no hand-copied field list to drift.
    const { type: _type, ...record } = ev;
    const next = [...this.dialogs(), record];
    while (next.length > RECENT_DIALOGS_CAP) next.shift();
    this.setState({ ...this.state, dialogs: next });
  }

  // Persisted before this field existed, a session's state can lack it.
  private dialogs(): SessionState["dialogs"] {
    return this.state.dialogs ?? [];
  }

  async getStatus(): Promise<{
    status: SessionStatus;
    browser: SessionState["browser"];
    tabs: SessionState["tabs"];
    currentUrl: string | null;
    dialogs: SessionState["dialogs"];
  }> {
    return {
      status: this.state.status,
      browser: this.state.browser,
      tabs: this.state.tabs,
      currentUrl: this.state.currentUrl,
      dialogs: this.dialogs(),
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
      case "scroll":
        // scroll.ref is optional (undefined => a window scroll): a ref-bearing
        // dry-run probes it, a ref-less one simulates ok:true with no wire hop
        // (like navigate/switch_tab) - it was never a liveness signal.
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
  // scalar (onClose guards the stamping races, but the scalar remains an
  // eventually-consistent echo, not the delivery truth).
  private hasAuthorizedConnection(): boolean {
    for (const connection of this.getConnections()) {
      if (this.isAuthorizedConnection(connection)) return true;
    }
    return false;
  }
}
