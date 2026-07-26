import { Agent } from "agents";
import type { AgentContext, Connection, ConnectionContext, WSMessage } from "agents";
import { z } from "zod";
import {
  PROTOCOL_CAPABILITIES,
  PROTOCOL_VERSION,
  SESSION_RESULT_FRAME_MAX_BYTES,
  isWriteCommand,
  safeParseEvent,
  safeParseSessionClientFrame,
} from "@understudy/protocol";
import type {
  Command,
  CommandState,
  Event,
  ProtocolCapability,
  SessionClientFrame,
  SessionServerFrame,
  TabInfo,
  UnattendedSessionLifecycle,
} from "@understudy/protocol";
import {
  scopeSession,
  tenantOf,
  verifyExtensionToken,
  verifyWsTicket,
  type WsTicketClaims,
} from "./auth";
import {
  COMMAND_TIMED_OUT,
  DUPLICATE_COMMAND,
  SESSION_NOT_CONNECTED,
  SESSION_RESYNCED,
  SESSION_BUSY,
} from "./coordinator";
import { CfSessionCoordinator } from "./coordinator-cf";
import { resolveSecret } from "./secrets";
import { createVault } from "./vault";
import type {
  CommandStatusRecord,
  DispatchOutcome,
  Env,
  SessionState,
  SessionStatus,
  V2DispatchOutcome,
} from "./types";
import type { LeaseResource, TenantDeviceCoordinator } from "./tenant-coordinator";
import { parseQuotaPolicy } from "./quota";
import { requestFingerprint } from "./validation";
import { emitTelemetry, type TelemetryEvent } from "./telemetry";

type FillSecretCommand = Extract<Command, { type: "fill_secret" }>;

// Bounds SessionState.completedWrites (the idempotent-retry replay record).
// 100 write results at ~100 bytes each is well under any DO state budget
// while covering far more retries than a consumer's per-case write count.
const COMPLETED_WRITES_CAP = 100;

// Bounds SessionState.dialogs (the recent-dialogs surface). Dialogs are far
// rarer than writes; 50 recent covers any realistic burst a consumer polls for.
const RECENT_DIALOGS_CAP = 50;
const PREPARE_DEADLINE_MS = 5_000;
const EXECUTION_DEADLINE_MS = 25_000;
const SYNCHRONOUS_WAIT_MS = 20_000;
const LegacyDialogEventSchema = z
  .object({
    type: z.literal("dialog"),
    tabId: z.number().int().nonnegative(),
    dialogType: z.enum(["alert", "confirm", "prompt", "beforeunload"]),
    message: z.string().max(4 * 1024),
    url: z.string().min(1).max(8 * 1024),
    defaultPrompt: z.string().max(1024).optional(),
    disposition: z.enum(["accept", "dismiss"]),
  })
  .strict();

interface CommandRow {
  command_id: string;
  fingerprint: string;
  command_type: Command["type"];
  dry_run: number;
  state: CommandState;
  attempt_id: string;
  ready_deadline_at: number;
  execution_deadline_at: number | null;
  result_json: string | null;
  created_at: number;
  updated_at: number;
  is_write: number;
}

interface AuthorizedConnectionState {
  authorized: true;
  ticket?: WsTicketClaims;
}

export class SessionAgent extends Agent<Env, SessionState> {
  initialState: SessionState = {
    browser: null,
    tabs: [],
    currentUrl: null,
    generation: 0,
    awaitingCommandIds: [],
    status: "pending",
    activeConnectionId: null,
    completedWrites: [],
    dialogs: [],
    protocolVersion: 1,
    capabilities: [],
    mode: "attended",
  };

  private readonly coordinator: CfSessionCoordinator;
  private readonly stateWaiters = new Map<string, Set<() => void>>();
  private readonly connectionWaiters = new Set<(connected: boolean) => void>();

  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env);
    this.coordinator = new CfSessionCoordinator({
      sendToExtension: (payload) => {
        const connection = this.authoritativeConnection();
        if (connection === undefined) {
          throw new Error("authoritative extension connection disappeared before send");
        }
        connection.send(payload);
      },
      hasAuthorizedConnection: () => this.hasAuthorizedConnection(),
      getAwaitingCommandIds: () => this.state.awaitingCommandIds,
      persistAwaitingCommandIds: (ids) => this.setState({ ...this.state, awaitingCommandIds: ids }),
      persistStatus: (status) => this.setState({ ...this.state, status }),
      persistLateResult: (event) => this.rememberLegacyLateResult(event),
    });
    this.sql`
      CREATE TABLE IF NOT EXISTS command_journal (
        command_id TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL,
        command_type TEXT NOT NULL,
        dry_run INTEGER NOT NULL,
        state TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        ready_deadline_at INTEGER NOT NULL,
        execution_deadline_at INTEGER,
        result_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        is_write INTEGER NOT NULL
      )
    `;
    this.sql`
      CREATE UNIQUE INDEX IF NOT EXISTS command_attempt_id
      ON command_journal(attempt_id)
    `;
    this.sql`
      CREATE TABLE IF NOT EXISTS consumed_session_ticket (
        jti_hash TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL
      )
    `;
    this.sql`
      CREATE TABLE IF NOT EXISTS dialog_seen (
        dialog_id TEXT PRIMARY KEY,
        occurred_at TEXT NOT NULL
      )
    `;
    this.sql`
      CREATE TABLE IF NOT EXISTS session_flag (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `;
  }

  async onConnect(connection: Connection, ctx: ConnectionContext): Promise<void> {
    const url = new URL(ctx.request.url);
    if (this.state.mode === "unattended" && this.state.unattended !== undefined) {
      const ticket = url.searchParams.get("ticket") ?? "";
      const claims = await verifyWsTicket(
        ticket,
        { aud: "session", agentName: this.name },
        this.env,
      );
      const unattended = this.state.unattended;
      if (
        claims === null ||
        claims.sessionId !== this.name ||
        claims.tenantId !== unattended.tenantId ||
        claims.deviceId !== unattended.deviceId ||
        claims.leaseId !== unattended.leaseId ||
        claims.leaseEpoch !== unattended.leaseEpoch ||
        claims.browserEpoch !== unattended.browserEpoch ||
        !(await this.consumeSessionTicket(claims))
      ) {
        connection.close(1008, "invalid or replayed session ticket");
        return;
      }
      this.makeConnectionAuthoritative(connection, claims);
      return;
    }

    const token = url.searchParams.get("token") ?? "";
    const verified = await verifyExtensionToken(token, this.env);
    if (verified === null) {
      connection.close(1008, "invalid extension token");
      return;
    }
    const scope = await scopeSession(this.name, verified.tenantId, this.env);
    if (scope !== "ok") {
      connection.close(1008, "tenant mismatch");
      return;
    }
    this.makeConnectionAuthoritative(connection);
  }

  private makeConnectionAuthoritative(
    connection: Connection,
    ticket?: WsTicketClaims,
  ): void {
    connection.setState({
      authorized: true,
      ...(ticket === undefined ? {} : { ticket }),
    } satisfies AuthorizedConnectionState);
    this.setState({
      ...this.state,
      activeConnectionId: connection.id,
      status: "connected",
    });

    for (const previous of this.getConnections()) {
      if (previous.id === connection.id || !this.isAuthorizedConnection(previous)) continue;
      previous.setState({ authorized: false });
      try {
        previous.close(4001, "replaced by newer extension connection");
      } catch {
        // Authority already moved and the predecessor is demoted. A socket
        // that raced to CLOSED must not make the successful replacement's
        // onConnect reject.
      }
    }
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
    if (!this.isAuthoritativeConnection(connection)) return;
    if (typeof message !== "string") {
      connection.close(1009, "binary session frames are not supported");
      return;
    }
    if (new TextEncoder().encode(message).byteLength > SESSION_RESULT_FRAME_MAX_BYTES) {
      connection.close(1009, "session frame too large");
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(message) as unknown;
    } catch {
      if (this.state.protocolVersion === PROTOCOL_VERSION) {
        connection.close(1008, "invalid session frame");
      }
      return;
    }

    const v2 = safeParseSessionClientFrame(parsed);
    if (v2.success) {
      await this.handleV2Frame(connection, v2.data);
      return;
    }

    const result = safeParseEvent(parsed);
    if (!result.success) {
      const legacyDialog = LegacyDialogEventSchema.safeParse(parsed);
      if (this.state.protocolVersion === PROTOCOL_VERSION) {
        connection.close(1008, "invalid session frame");
        return;
      }
      if (!legacyDialog.success) return;
      if (this.rememberDialog({
        ...legacyDialog.data,
        dialogId: crypto.randomUUID(),
        occurredAt: new Date().toISOString(),
      })) {
        await this.emitSessionTelemetry("dialog", "legacy_recorded");
      }
      return;
    }
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
        if (ev.protocolVersion === PROTOCOL_VERSION) {
          if (
            ev.tabs.length !== 1 ||
            ev.capabilities === undefined ||
            (this.state.mode === "unattended" &&
              (ev.browserEpoch !== this.state.unattended?.browserEpoch ||
                ev.leaseId !== this.state.unattended?.leaseId ||
                ev.leaseEpoch !== this.state.unattended?.leaseEpoch))
          ) {
            connection.close(1008, "protocol-v2 hello fence mismatch");
            return;
          }
        }
        this.coordinator.abandonInFlight(`${SESSION_RESYNCED}: hello`);
        this.setState({
          ...this.state,
          browser: { browser: ev.browser, extVersion: ev.extVersion },
          tabs: ev.tabs,
          generation: this.state.generation + 1,
          status: "connected",
          protocolVersion: ev.protocolVersion ?? 1,
          capabilities: ev.capabilities ?? [],
          ...(this.state.unattended === undefined
            ? {}
            : {
                unattended: {
                  ...this.state.unattended,
                  status: "connected" as const,
                },
              }),
        });
        const safeV2 =
          ev.protocolVersion === PROTOCOL_VERSION &&
          (ev.capabilities ?? []).includes("safe-write-v2");
        if (safeV2 && this.writesBlocked()) {
          this.trySendSessionFrame({
            type: "writes_blocked",
            reason: "session write authority requires reconciliation",
          });
        }
        for (const resolve of [...this.connectionWaiters]) resolve(safeV2);
        this.connectionWaiters.clear();
        return;
      case "page_event":
        this.setState({ ...this.state, currentUrl: ev.url });
        return;
      case "dialog":
        if (this.rememberDialog(ev)) {
          await this.emitSessionTelemetry("dialog", "recorded");
        }
        if ("dialogId" in ev) {
          this.trySendSessionFrame({ type: "dialog_ack", dialogId: ev.dialogId });
        }
        return;
    }
  }

  private async handleV2Frame(
    connection: Connection,
    frame: SessionClientFrame,
  ): Promise<void> {
    switch (frame.type) {
      case "write_ready": {
        const row = this.commandByAttempt(frame.attemptId);
        if (
          row === undefined ||
          row.command_id !== frame.commandId ||
          row.fingerprint !== frame.requestFingerprint ||
          row.state !== "preparing" ||
          row.ready_deadline_at <= Date.now() ||
          !this.frameMatchesCurrentLease(frame)
        ) {
          connection.send(
            JSON.stringify({
              type: "attempt_cancel",
              attemptId: frame.attemptId,
              commandId: frame.commandId,
            } satisfies SessionServerFrame),
          );
          return;
        }
        this.sql`
          UPDATE command_journal SET state = 'ready', updated_at = ${Date.now()}
          WHERE attempt_id = ${frame.attemptId} AND state = 'preparing'
            AND ready_deadline_at > ${Date.now()}
        `;
        this.notifyAttempt(frame.attemptId);
        return;
      }
      case "command_result": {
        const row = this.commandByAttempt(frame.attemptId);
        const now = Date.now();
        if (
          row !== undefined &&
          row.command_id === frame.commandId &&
          row.state === "granted" &&
          row.execution_deadline_at !== null &&
          row.execution_deadline_at > now &&
          this.frameMatchesCurrentLease(frame)
        ) {
          const event =
            row.dry_run === 1 && row.is_write === 1 && frame.event.type === "action_result"
              ? { ...frame.event, simulated: true }
              : frame.event;
          this.sql`
            UPDATE command_journal
            SET state = 'completed', result_json = ${JSON.stringify(event)},
                updated_at = ${now}
            WHERE attempt_id = ${frame.attemptId} AND state = 'granted'
              AND execution_deadline_at > ${now}
          `;
          this.notifyAttempt(frame.attemptId);
        } else if (
          row?.state === "granted" &&
          row.execution_deadline_at !== null &&
          row.execution_deadline_at <= now
        ) {
          await this.expireAttempt({ attemptId: frame.attemptId });
        }
        connection.send(
          JSON.stringify({
            type: "result_ack",
            attemptId: frame.attemptId,
            commandId: frame.commandId,
          } satisfies SessionServerFrame),
        );
        return;
      }
      case "dialog":
        if (this.rememberDialog(frame)) {
          await this.emitSessionTelemetry("dialog", "recorded");
        } else {
          await this.emitSessionTelemetry("dialog", "deduplicated");
        }
        connection.send(
          JSON.stringify({ type: "dialog_ack", dialogId: frame.dialogId } satisfies SessionServerFrame),
        );
        return;
      case "health":
        if (this.state.unattended !== undefined) {
          this.setState({
            ...this.state,
            unattended: {
              ...this.state.unattended,
              dialogDelivery:
                this.state.unattended.dialogDelivery === "overflow"
                  ? "overflow"
                  : frame.dialogDelivery,
            },
          });
          await this.tenantCoordinator().setDialogDelivery(this.name, frame.dialogDelivery);
        }
        return;
      case "pong":
        return;
    }
  }

  async onClose(connection: Connection, code: number, reason: string, wasClean: boolean): Promise<void> {
    if (!this.isAuthorizedConnection(connection)) return;

    const activeConnectionId = this.persistedActiveConnectionId();
    if (activeConnectionId === undefined) {
      const anotherAuthorizedConnection = [...this.getConnections()].some(
        (candidate) =>
          candidate.id !== connection.id && this.isAuthorizedConnection(candidate),
      );
      if (anotherAuthorizedConnection) return;
    } else if (activeConnectionId !== connection.id) {
      return;
    }

    const unattendedBeforeClose = this.state.unattended;
    this.setState({
      ...this.state,
      activeConnectionId: null,
      status: "detached",
      ...(unattendedBeforeClose === undefined ||
      unattendedBeforeClose.status !== "connected"
        ? {}
        : {
            unattended: {
              ...unattendedBeforeClose,
              status: "recovering" as const,
              needsReconciliation: true,
            },
          }),
    });
    if (unattendedBeforeClose?.status === "connected") {
      await this.tenantCoordinator().markRecovering({
        sessionId: this.name,
        leaseId: unattendedBeforeClose.leaseId,
        leaseEpoch: unattendedBeforeClose.leaseEpoch,
        browserEpoch: unattendedBeforeClose.browserEpoch,
      });
    }
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

  async dispatchV2(
    command: Command,
    dryRun: boolean,
    actorPseudonym: string,
    statusUrl: string,
  ): Promise<V2DispatchOutcome> {
    const startedAt = Date.now();
    const fingerprint = await requestFingerprint(command, dryRun);
    const existing = this.command(command.commandId);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) {
        return { kind: "id_conflict", commandId: command.commandId };
      }
      if (existing.state !== "not_started" && existing.state !== "timed_out") {
        return this.outcomeForRow(existing, statusUrl);
      }
    }

    if (this.isTerminalSession()) {
      return { kind: "terminal_session", commandId: command.commandId };
    }
    if (!this.hasAuthorizedConnection()) {
      return { kind: "not_connected", commandId: command.commandId };
    }
    if (
      isWriteCommand(command) &&
      !dryRun &&
      (this.state.protocolVersion !== PROTOCOL_VERSION ||
        !(this.state.capabilities ?? []).includes("safe-write-v2"))
    ) {
      return { kind: "unsupported", commandId: command.commandId };
    }
    if (isWriteCommand(command) && !dryRun && this.writesBlocked()) {
      return { kind: "unknown", commandId: command.commandId, safeToRetry: false };
    }

    const active = this.sql<{ command_id: string }>`
      SELECT command_id FROM command_journal
      WHERE state IN ('preparing','ready','granted')
        AND command_id <> ${command.commandId}
      LIMIT 1
    `[0];
    if (active !== undefined) {
      return { kind: "busy", commandId: command.commandId };
    }

    const policy = parseQuotaPolicy(this.env.QUOTA_POLICY);
    if (
      existing === undefined &&
      (this.sql<{ count: number }>`SELECT COUNT(*) AS count FROM command_journal`[0]?.count ?? 0) >=
        policy.sessionCommandCap
    ) {
      return { kind: "busy", commandId: command.commandId };
    }

    const attemptId = crypto.randomUUID();
    const readyDeadlineAt = Date.now() + PREPARE_DEADLINE_MS;
    if (existing === undefined) {
      this.sql`
        INSERT INTO command_journal (
          command_id, fingerprint, command_type, dry_run, state, attempt_id,
          ready_deadline_at, execution_deadline_at, result_json, created_at,
          updated_at, is_write
        ) VALUES (
          ${command.commandId}, ${fingerprint}, ${command.type}, ${dryRun ? 1 : 0},
          'preparing', ${attemptId}, ${readyDeadlineAt}, NULL, NULL,
          ${Date.now()}, ${Date.now()}, ${isWriteCommand(command) ? 1 : 0}
        )
      `;
    } else {
      this.sql`
        UPDATE command_journal SET
          state = 'preparing', attempt_id = ${attemptId},
          ready_deadline_at = ${readyDeadlineAt}, execution_deadline_at = NULL,
          result_json = NULL, updated_at = ${Date.now()}
        WHERE command_id = ${command.commandId}
          AND state IN ('not_started','timed_out')
      `;
      const claimed =
        (this.sql<{ count: number }>`SELECT changes() AS count`[0]?.count ?? 0) === 1;
      if (!claimed) {
        const raced = this.command(command.commandId);
        if (raced === undefined) throw new Error("command retry disappeared");
        return this.outcomeForRow(raced, statusUrl);
      }
    }

    if (this.state.mode === "unattended") {
      const admission = await this.tenantCoordinator().authorizeCommand({
        sessionId: this.name,
        actorPseudonym,
        credentialFill: command.type === "fill_secret" && !dryRun,
      });
      if (!admission.ok) {
        this.sql`
          UPDATE command_journal SET state = 'not_started', updated_at = ${Date.now()}
          WHERE attempt_id = ${attemptId} AND state = 'preparing'
        `;
        return admission.reason === "terminal"
          ? { kind: "terminal_session", commandId: command.commandId }
          : { kind: "busy", commandId: command.commandId };
      }
      if (this.state.unattended !== undefined) {
        this.setState({
          ...this.state,
          unattended: {
            ...this.state.unattended,
            lastActivityAt: new Date().toISOString(),
            idleExpiresAt: new Date(admission.idleExpiresAt).toISOString(),
          },
        });
      }
    } else {
      const tenantId = await tenantOf(this.name, this.env);
      if (tenantId === null) {
        this.markAttempt(attemptId, "not_started");
        return { kind: "terminal_session", commandId: command.commandId };
      }
      const admitted = await this.env.TENANT_CONTROL.getByName(tenantId).authorizeAttendedCommand({
        sessionId: this.name,
        actorPseudonym,
        credentialFill: command.type === "fill_secret" && !dryRun,
      });
      if (!admitted) {
        this.markAttempt(attemptId, "not_started");
        return { kind: "busy", commandId: command.commandId };
      }
    }

    if (dryRun && isWriteCommand(command)) {
      if (command.type === "fill_secret" && !(await this.secretRefInTenant(command.secretRef))) {
        const event = this.simulatedResult(command.commandId, {
          ok: false,
          reason: "secret could not be resolved",
        });
        this.completeAttempt(attemptId, event);
        return { kind: "terminal", event };
      }
      const ref = this.commandRef(command);
      if (ref === undefined) {
        const event = this.simulatedResult(command.commandId, { ok: true });
        this.completeAttempt(attemptId, event);
        return { kind: "terminal", event };
      }
      return this.executeReadV2(
        { type: "resolve_ref", commandId: command.commandId, ref },
        attemptId,
        startedAt,
        statusUrl,
      );
    }

    if (!isWriteCommand(command)) {
      return this.executeReadV2(command, attemptId, startedAt, statusUrl);
    }

    await this.schedule(
      new Date(readyDeadlineAt),
      "expireAttempt",
      { attemptId },
      { idempotent: true },
    );
    try {
      this.sendSessionFrame({
        type: "write_prepare",
        ...this.currentFence(attemptId, readyDeadlineAt),
        commandId: command.commandId,
        commandType: command.type,
        requestFingerprint: fingerprint,
      });
      await this.emitSessionTelemetry("command_prepare", "sent", command.type);
    } catch {
      const won = this.markAttempt(attemptId, "not_started", "preparing");
      if (won) return { kind: "not_started", commandId: command.commandId, safeToRetry: true };
      return this.outcomeForRow(this.commandByAttempt(attemptId)!, statusUrl);
    }

    let row = await this.waitForAttempt(
      attemptId,
      (candidate) => candidate.state !== "preparing",
      Math.max(0, readyDeadlineAt - Date.now()),
    );
    if (row.state === "preparing") {
      const won = this.markAttempt(attemptId, "not_started", "preparing");
      if (won) {
        this.trySendSessionFrame({
          type: "attempt_cancel",
          attemptId,
          commandId: command.commandId,
        });
        return { kind: "not_started", commandId: command.commandId, safeToRetry: true };
      }
      row = this.commandByAttempt(attemptId) ?? row;
    }
    if (row.state !== "ready") return this.outcomeForRow(row, statusUrl);

    let grantedCommand: Command = command;
    if (command.type === "fill_secret") {
      if (!(await this.secretRefInTenant(command.secretRef))) {
        const event = this.unresolvableSecretResult(command.commandId);
        const completed = this.completeAttempt(attemptId, event, "ready");
        this.trySendSessionFrame({ type: "attempt_cancel", attemptId, commandId: command.commandId });
        return completed
          ? { kind: "terminal", event }
          : this.outcomeForRow(this.commandByAttempt(attemptId)!, statusUrl);
      }
      const resolution = await resolveBeforeDeadline(
        resolveSecret(createVault(this.env), command.secretRef),
        readyDeadlineAt,
      );
      if (resolution.kind === "timeout") {
        const won = this.markAttempt(attemptId, "not_started", "ready");
        this.trySendSessionFrame({ type: "attempt_cancel", attemptId, commandId: command.commandId });
        return won
          ? { kind: "not_started", commandId: command.commandId, safeToRetry: true }
          : this.outcomeForRow(this.commandByAttempt(attemptId)!, statusUrl);
      }
      if (resolution.kind === "error") {
        const event = this.unresolvableSecretResult(command.commandId);
        const completed = this.completeAttempt(attemptId, event, "ready");
        this.trySendSessionFrame({ type: "attempt_cancel", attemptId, commandId: command.commandId });
        return completed
          ? { kind: "terminal", event }
          : this.outcomeForRow(this.commandByAttempt(attemptId)!, statusUrl);
      }
      const secret = resolution.value;
      grantedCommand = {
        type: "type",
        commandId: command.commandId,
        ref: command.ref,
        text: secret,
        submit: command.submit,
      };
    }

    const executionDeadlineAt = Date.now() + EXECUTION_DEADLINE_MS;
    this.sql`
      UPDATE command_journal
      SET state = 'granted', execution_deadline_at = ${executionDeadlineAt},
          updated_at = ${Date.now()}
      WHERE attempt_id = ${attemptId} AND state = 'ready'
        AND ready_deadline_at > ${Date.now()}
    `;
    row = this.commandByAttempt(attemptId) ?? row;
    if (row.state !== "granted") {
      const won =
        row.state === "ready" &&
        this.markAttempt(attemptId, "not_started", "ready");
      if (won) {
        return { kind: "not_started", commandId: command.commandId, safeToRetry: true };
      }
      return this.outcomeForRow(this.commandByAttempt(attemptId) ?? row, statusUrl);
    }
    await this.emitSessionTelemetry("command_grant", "persisted", command.type);
    await this.schedule(
      new Date(executionDeadlineAt),
      "expireAttempt",
      { attemptId },
      { idempotent: true },
    );
    try {
      this.sendSessionFrame({
        type: "write_grant",
        ...this.currentFence(attemptId, executionDeadlineAt),
        command: grantedCommand,
      });
    } catch {
      return this.pendingOutcome(command.commandId, statusUrl);
    }
    return this.awaitSynchronousOutcome(
      attemptId,
      command.commandId,
      startedAt,
      statusUrl,
    );
  }

  async getCommandStatus(commandId: string): Promise<CommandStatusRecord | null> {
    const row = this.command(commandId);
    if (row === undefined) return null;
    return {
      commandId,
      status: row.state,
      ...(row.result_json === null ? {} : { event: JSON.parse(row.result_json) as Event }),
      safeToRetry: row.state === "not_started" || row.state === "timed_out",
    };
  }

  async expireAttempt(payload: { attemptId: string }): Promise<void> {
    const row = this.commandByAttempt(payload.attemptId);
    if (row === undefined) return;
    const now = Date.now();
    if (
      (row.state === "preparing" || row.state === "ready") &&
      row.ready_deadline_at <= now
    ) {
      this.markAttempt(payload.attemptId, "not_started", row.state);
      this.notifyAttempt(payload.attemptId);
      return;
    }
    if (
      row.state === "granted" &&
      row.execution_deadline_at !== null &&
      row.execution_deadline_at <= now
    ) {
      const terminal: CommandState =
        row.is_write === 1 && row.dry_run === 0 ? "unknown" : "timed_out";
      this.markAttempt(payload.attemptId, terminal, "granted");
      if (terminal === "unknown") {
        this.sql`
          INSERT INTO session_flag (key, value) VALUES ('writes_blocked', '1')
          ON CONFLICT(key) DO UPDATE SET value = '1'
        `;
        try {
          this.sendSessionFrame({
            type: "writes_blocked",
            reason: "a granted write reached its execution deadline without a result",
          });
        } catch {
          // The durable unknown tombstone is authoritative while disconnected.
        }
        await this.emitSessionTelemetry("command_unknown", "deadline", row.command_type);
      }
      this.notifyAttempt(payload.attemptId);
    }
  }

  async initializeUnattended(
    tenantId: string,
    lease: LeaseResource,
  ): Promise<void> {
    this.setState({
      ...this.state,
      mode: "unattended",
      status: "pending",
      browser: null,
      tabs: [],
      currentUrl: null,
      activeConnectionId: null,
      protocolVersion: 2,
      capabilities: [],
      unattended: {
        tenantId,
        deviceId: lease.deviceId,
        leaseId: lease.leaseId,
        leaseEpoch: lease.leaseEpoch,
        browserEpoch: lease.browserEpoch,
        status: lease.status,
        createdAt: new Date(lease.createdAt).toISOString(),
        lastActivityAt: new Date(lease.lastActivityAt).toISOString(),
        idleExpiresAt: new Date(lease.idleExpiresAt).toISOString(),
        hardExpiresAt: new Date(lease.hardExpiresAt).toISOString(),
        needsReconciliation: lease.needsReconciliation,
        dialogDelivery: lease.dialogDelivery,
        allowedOrigins: lease.allowedOrigins,
      },
    });
  }

  async beginRecovery(lease: LeaseResource): Promise<void> {
    const unattended = this.state.unattended;
    if (
      unattended === undefined ||
      lease.sessionId !== this.name ||
      lease.leaseId !== unattended.leaseId ||
      lease.leaseEpoch !== unattended.leaseEpoch ||
      lease.deviceId !== unattended.deviceId
    ) {
      return;
    }
    const epochChanged = lease.browserEpoch !== unattended.browserEpoch;
    this.terminalizeGrantedAttempts();
    if (epochChanged) {
      this.sql`
        INSERT INTO session_flag (key, value) VALUES ('writes_blocked', '1')
        ON CONFLICT(key) DO UPDATE SET value = '1'
      `;
    }
    this.fenceConnections(epochChanged ? "browser epoch changed" : "session reconnecting");
    this.setState({
      ...this.state,
      activeConnectionId: null,
      status: "detached",
      browser: epochChanged ? null : this.state.browser,
      tabs: epochChanged ? [] : this.state.tabs,
      currentUrl: epochChanged ? null : this.state.currentUrl,
      unattended: {
        ...unattended,
        browserEpoch: lease.browserEpoch,
        status: "recovering",
        needsReconciliation: true,
        dialogDelivery:
          epochChanged && unattended.dialogDelivery !== "overflow"
            ? "interrupted"
            : unattended.dialogDelivery,
      },
    });
  }

  async needsSessionTicket(): Promise<boolean> {
    return (
      this.state.mode === "unattended" &&
      !this.hasAuthorizedConnection() &&
      !this.isTerminalSession()
    );
  }

  async revokeDevice(): Promise<void> {
    if (this.state.unattended === undefined) return;
    this.terminalizeGrantedAttempts();
    this.fenceConnections("device credential revoked");
    this.setState({
      ...this.state,
      activeConnectionId: null,
      status: "detached",
      unattended: {
        ...this.state.unattended,
        status: "lost",
        needsReconciliation: true,
      },
    });
  }

  async markProvisioned(tab: TabInfo, browserEpoch: string): Promise<void> {
    const unattended = this.state.unattended;
    if (unattended === undefined || unattended.browserEpoch !== browserEpoch) return;
    this.setState({
      ...this.state,
      tabs: [tab],
      currentUrl: tab.url === "about:blank" ? null : tab.url,
      unattended: {
        ...unattended,
        status: "provisioning",
      },
    });
  }

  async markLifecycle(
    status: UnattendedSessionLifecycle,
    needsReconciliation: boolean,
  ): Promise<void> {
    if (this.state.unattended === undefined) return;
    this.setState({
      ...this.state,
      activeConnectionId: isTerminalLifecycle(status) ? null : this.state.activeConnectionId,
      status: isTerminalLifecycle(status) ? "detached" : this.state.status,
      unattended: {
        ...this.state.unattended,
        status,
        needsReconciliation,
      },
    });
  }

  async requestCloseAttended(): Promise<boolean> {
    if (this.state.mode === "unattended") return false;
    this.sql`
      INSERT INTO session_flag (key, value) VALUES ('closed', '1')
      ON CONFLICT(key) DO UPDATE SET value = '1'
    `;
    const connection = this.authoritativeConnection();
    if (connection === undefined) {
      this.setState({ ...this.state, status: "detached", activeConnectionId: null });
      return true;
    }
    connection.send(
      JSON.stringify({ type: "close_session", closeTab: false } satisfies SessionServerFrame),
    );
    return false;
  }

  async waitForProtocolV2Connection(timeoutMs: number): Promise<boolean> {
    if (
      this.state.status === "connected" &&
      this.state.protocolVersion === PROTOCOL_VERSION &&
      (this.state.capabilities ?? []).includes("safe-write-v2")
    ) {
      return true;
    }
    return new Promise((resolve) => {
      const finish = (connected: boolean) => {
        clearTimeout(timer);
        this.connectionWaiters.delete(finish);
        resolve(connected);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      this.connectionWaiters.add(finish);
    });
  }

  async usesV2CommandProtocol(): Promise<boolean> {
    return (
      this.state.mode === "unattended" ||
      this.state.protocolVersion === PROTOCOL_VERSION
    );
  }

  private async executeReadV2(
    command: Command,
    attemptId: string,
    startedAt: number,
    statusUrl: string,
  ): Promise<V2DispatchOutcome> {
    const executionDeadlineAt = Date.now() + EXECUTION_DEADLINE_MS;
    this.sql`
      UPDATE command_journal
      SET state = 'granted', execution_deadline_at = ${executionDeadlineAt},
          updated_at = ${Date.now()}
      WHERE attempt_id = ${attemptId} AND state = 'preparing'
    `;
    await this.schedule(
      new Date(executionDeadlineAt),
      "expireAttempt",
      { attemptId },
      { idempotent: true },
    );
    try {
      this.sendSessionFrame({
        type: "command",
        ...this.currentFence(attemptId, executionDeadlineAt),
        command,
      });
    } catch {
      this.markAttempt(attemptId, "timed_out", "granted");
      return { kind: "not_connected", commandId: command.commandId };
    }
    return this.awaitSynchronousOutcome(attemptId, command.commandId, startedAt, statusUrl);
  }

  private async awaitSynchronousOutcome(
    attemptId: string,
    commandId: string,
    startedAt: number,
    statusUrl: string,
  ): Promise<V2DispatchOutcome> {
    const remaining = Math.max(0, SYNCHRONOUS_WAIT_MS - (Date.now() - startedAt));
    const row = await this.waitForAttempt(
      attemptId,
      (candidate) =>
        candidate.state === "completed" ||
        candidate.state === "not_started" ||
        candidate.state === "timed_out" ||
        candidate.state === "unknown",
      remaining,
    );
    if (row.state === "granted" || row.state === "ready" || row.state === "preparing") {
      return this.pendingOutcome(commandId, statusUrl);
    }
    return this.outcomeForRow(row, statusUrl);
  }

  private outcomeForRow(row: CommandRow, statusUrl: string): V2DispatchOutcome {
    switch (row.state) {
      case "completed": {
        if (row.result_json === null) throw new Error("completed command is missing its result");
        return { kind: "terminal", event: JSON.parse(row.result_json) as Event };
      }
      case "not_started":
        return { kind: "not_started", commandId: row.command_id, safeToRetry: true };
      case "timed_out":
        return { kind: "timed_out", commandId: row.command_id, safeToRetry: true };
      case "unknown":
        return { kind: "unknown", commandId: row.command_id, safeToRetry: false };
      case "preparing":
      case "ready":
      case "granted":
        return this.pendingOutcome(row.command_id, statusUrl);
    }
  }

  private pendingOutcome(commandId: string, statusUrl: string): V2DispatchOutcome {
    return {
      kind: "pending",
      pending: {
        commandId,
        status: "pending",
        statusUrl,
        retryPolicy: "poll_same_command",
      },
    };
  }

  private command(commandId: string): CommandRow | undefined {
    return this.sql<CommandRow>`
      SELECT * FROM command_journal WHERE command_id = ${commandId}
    `[0];
  }

  private commandByAttempt(attemptId: string): CommandRow | undefined {
    return this.sql<CommandRow>`
      SELECT * FROM command_journal WHERE attempt_id = ${attemptId}
    `[0];
  }

  private markAttempt(
    attemptId: string,
    next: CommandState,
    expected?: CommandState,
  ): boolean {
    const before = this.commandByAttempt(attemptId);
    if (before === undefined || (expected !== undefined && before.state !== expected)) return false;
    this.sql`
      UPDATE command_journal SET state = ${next}, updated_at = ${Date.now()}
      WHERE attempt_id = ${attemptId} AND state = ${before.state}
    `;
    const changed = this.sql<{ count: number }>`SELECT changes() AS count`[0]?.count ?? 0;
    if (changed === 1) this.notifyAttempt(attemptId);
    return changed === 1;
  }

  private completeAttempt(
    attemptId: string,
    event: Event,
    expected: CommandState = "preparing",
  ): boolean {
    this.sql`
      UPDATE command_journal
      SET state = 'completed', result_json = ${JSON.stringify(event)},
          updated_at = ${Date.now()}
      WHERE attempt_id = ${attemptId} AND state = ${expected}
    `;
    const changed = this.sql<{ count: number }>`SELECT changes() AS count`[0]?.count ?? 0;
    if (changed === 1) this.notifyAttempt(attemptId);
    return changed === 1;
  }

  private waitForAttempt(
    attemptId: string,
    predicate: (row: CommandRow) => boolean,
    timeoutMs: number,
  ): Promise<CommandRow> {
    const current = this.commandByAttempt(attemptId);
    if (current === undefined) return Promise.reject(new Error("command attempt disappeared"));
    if (predicate(current) || timeoutMs <= 0) return Promise.resolve(current);
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const wake = () => {
        const row = this.commandByAttempt(attemptId);
        if (row === undefined) {
          clearTimeout(timer);
          this.removeWaiter(attemptId, wake);
          reject(new Error("command attempt disappeared"));
          return;
        }
        if (!predicate(row)) return;
        clearTimeout(timer);
        this.removeWaiter(attemptId, wake);
        resolve(row);
      };
      const waiters = this.stateWaiters.get(attemptId) ?? new Set();
      waiters.add(wake);
      this.stateWaiters.set(attemptId, waiters);
      timer = setTimeout(() => {
        this.removeWaiter(attemptId, wake);
        const row = this.commandByAttempt(attemptId);
        if (row === undefined) reject(new Error("command attempt disappeared"));
        else resolve(row);
      }, timeoutMs);
    });
  }

  private notifyAttempt(attemptId: string): void {
    for (const wake of [...(this.stateWaiters.get(attemptId) ?? [])]) wake();
  }

  private removeWaiter(attemptId: string, wake: () => void): void {
    const waiters = this.stateWaiters.get(attemptId);
    if (waiters === undefined) return;
    waiters.delete(wake);
    if (waiters.size === 0) this.stateWaiters.delete(attemptId);
  }

  private currentFence(
    attemptId: string,
    deadlineAt: number,
  ): Omit<Extract<SessionServerFrame, { type: "command" }>, "type" | "command"> {
    const unattended = this.state.unattended;
    return {
      attemptId,
      deadlineAt: new Date(deadlineAt).toISOString(),
      ...(unattended === undefined
        ? {}
        : {
            leaseId: unattended.leaseId,
            leaseEpoch: unattended.leaseEpoch,
            browserEpoch: unattended.browserEpoch,
          }),
    };
  }

  private frameMatchesCurrentLease(frame: {
    leaseId?: string;
    leaseEpoch?: number;
    browserEpoch?: string;
  }): boolean {
    const unattended = this.state.unattended;
    if (unattended === undefined) {
      return (
        frame.leaseId === undefined &&
        frame.leaseEpoch === undefined &&
        frame.browserEpoch === undefined
      );
    }
    return (
      frame.leaseId === unattended.leaseId &&
      frame.leaseEpoch === unattended.leaseEpoch &&
      frame.browserEpoch === unattended.browserEpoch
    );
  }

  private sendSessionFrame(frame: SessionServerFrame): void {
    const connection = this.authoritativeConnection();
    if (connection === undefined) throw new Error("session connection unavailable");
    connection.send(JSON.stringify(frame));
  }

  private trySendSessionFrame(frame: SessionServerFrame): boolean {
    try {
      this.sendSessionFrame(frame);
      return true;
    } catch {
      return false;
    }
  }

  private writesBlocked(): boolean {
    return (
      this.sql<{ value: string }>`
        SELECT value FROM session_flag WHERE key = 'writes_blocked'
      `[0]?.value === "1"
    );
  }

  private isTerminalSession(): boolean {
    if (
      this.sql<{ value: string }>`
        SELECT value FROM session_flag WHERE key = 'closed'
      `[0]?.value === "1"
    ) {
      return true;
    }
    const status = this.state.unattended?.status;
    return (
      status === "closing" ||
      status === "closed" ||
      status === "expired" ||
      status === "lost"
    );
  }

  private terminalizeGrantedAttempts(): void {
    const granted = this.sql<{ attempt_id: string; is_write: number; dry_run: number }>`
      SELECT attempt_id, is_write, dry_run FROM command_journal WHERE state = 'granted'
    `;
    let blocked = false;
    for (const row of granted) {
      const terminal =
        row.is_write === 1 && row.dry_run === 0 ? "unknown" : "timed_out";
      if (terminal === "unknown") blocked = true;
      this.markAttempt(row.attempt_id, terminal, "granted");
    }
    if (blocked) {
      this.sql`
        INSERT INTO session_flag (key, value) VALUES ('writes_blocked', '1')
        ON CONFLICT(key) DO UPDATE SET value = '1'
      `;
    }
  }

  private fenceConnections(reason: string): void {
    for (const connection of this.getConnections()) {
      connection.setState(null);
      try {
        connection.close(4002, reason);
      } catch {
        // Persisted lifecycle and epochs are already authoritative.
      }
    }
  }

  private tenantCoordinator(): DurableObjectStub<TenantDeviceCoordinator> {
    const tenantId = this.state.unattended?.tenantId;
    if (tenantId === undefined) throw new Error("unattended tenant is missing");
    return this.env.TENANT_CONTROL.getByName(tenantId);
  }

  private async consumeSessionTicket(claims: WsTicketClaims): Promise<boolean> {
    const jtiHash = await sha256Hex(claims.jti);
    this.sql`
      DELETE FROM consumed_session_ticket
      WHERE expires_at <= ${Math.floor(Date.now() / 1000)}
    `;
    this.sql`
      INSERT OR IGNORE INTO consumed_session_ticket (jti_hash, expires_at)
      VALUES (${jtiHash}, ${claims.exp})
    `;
    return (this.sql<{ count: number }>`SELECT changes() AS count`[0]?.count ?? 0) === 1;
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
    if (message.startsWith(SESSION_BUSY)) {
      return { ok: false, reason: "session_busy", message };
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

  private rememberLegacyLateResult(event: Event): void {
    if (!("commandId" in event)) return;
    const next = [
      ...this.completedWrites().filter((entry) => entry.commandId !== event.commandId),
      { commandId: event.commandId, event },
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
  private rememberDialog(ev: Extract<Event, { type: "dialog" }>): boolean {
    // Strip only the wire discriminator: object-rest yields exactly DialogRecord
    // (preserving defaultPrompt's presence/absence), so a new protocol dialog
    // field persists automatically - no hand-copied field list to drift.
    const { type: _type, ...record } = ev;
    const existing = this.sql<{ dialog_id: string }>`
      SELECT dialog_id FROM dialog_seen WHERE dialog_id = ${record.dialogId}
    `[0];
    if (existing !== undefined) return false;
    this.sql`
      INSERT INTO dialog_seen (dialog_id, occurred_at)
      VALUES (${record.dialogId}, ${record.occurredAt})
    `;
    const next = [...this.dialogs(), record];
    while (next.length > RECENT_DIALOGS_CAP) next.shift();
    this.setState({ ...this.state, dialogs: next });
    return true;
  }

  private async emitSessionTelemetry(
    event: TelemetryEvent,
    outcome: string,
    commandType?: string,
  ): Promise<void> {
    const tenantId =
      this.state.unattended?.tenantId ?? await tenantOf(this.name, this.env) ?? undefined;
    await emitTelemetry(this.env, {
      event,
      outcome,
      ...(tenantId === undefined ? {} : { tenantId }),
      sessionId: this.name,
      ...(commandType === undefined ? {} : { commandType }),
    });
  }

  // Persisted before this field existed, a session's state can lack it.
  private dialogs(): SessionState["dialogs"] {
    return this.state.dialogs ?? [];
  }

  async getStatus(): Promise<
    | {
        status: SessionStatus;
        browser: SessionState["browser"];
        tabs: SessionState["tabs"];
        currentUrl: string | null;
        dialogs: SessionState["dialogs"];
      }
    | {
        mode: "unattended";
        status: UnattendedSessionLifecycle;
        deviceId: string;
        createdAt: string;
        lastActivityAt: string;
        idleExpiresAt: string;
        hardExpiresAt: string;
        needsReconciliation: boolean;
        dialogDelivery: "ok" | "interrupted" | "overflow";
        browser: SessionState["browser"];
        tabs: SessionState["tabs"];
        currentUrl: string | null;
        dialogs: SessionState["dialogs"];
      }
  > {
    if (this.state.unattended !== undefined) {
      const lease = await this.tenantCoordinator().getLease(this.name);
      const unattended =
        lease === null
          ? { ...this.state.unattended, status: "lost" as const, needsReconciliation: true }
          : {
              ...this.state.unattended,
              status: lease.status,
              lastActivityAt: new Date(lease.lastActivityAt).toISOString(),
              idleExpiresAt: new Date(lease.idleExpiresAt).toISOString(),
              hardExpiresAt: new Date(lease.hardExpiresAt).toISOString(),
              needsReconciliation: lease.needsReconciliation,
              dialogDelivery: lease.dialogDelivery,
            };
      this.setState({ ...this.state, unattended });
      return {
        mode: "unattended",
        status: unattended.status,
        deviceId: unattended.deviceId,
        createdAt: unattended.createdAt,
        lastActivityAt: unattended.lastActivityAt,
        idleExpiresAt: unattended.idleExpiresAt,
        hardExpiresAt: unattended.hardExpiresAt,
        needsReconciliation: unattended.needsReconciliation,
        dialogDelivery: unattended.dialogDelivery,
        browser: this.state.browser,
        tabs: this.state.tabs.slice(0, 1),
        currentUrl: this.state.currentUrl,
        dialogs: this.dialogs(),
      };
    }
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

  private hasAuthorizedConnection(): boolean {
    return this.authoritativeConnection() !== undefined;
  }

  private isAuthoritativeConnection(connection: Connection): boolean {
    if (!this.isAuthorizedConnection(connection)) return false;

    const activeConnectionId = this.persistedActiveConnectionId();
    if (activeConnectionId !== undefined) {
      return activeConnectionId !== null && connection.id === activeConnectionId;
    }

    return this.authoritativeConnection()?.id === connection.id;
  }

  /**
   * Returns the one live socket Commands may be sent to. A state persisted
   * before activeConnectionId existed is migrated only when its connection
   * set has exactly one authorized socket; zero or multiple candidates fail
   * closed rather than reviving the old broadcast behavior.
   */
  private authoritativeConnection(): Connection | undefined {
    const activeConnectionId = this.persistedActiveConnectionId();
    if (activeConnectionId === null) return undefined;

    const authorized = [...this.getConnections()].filter((connection) =>
      this.isAuthorizedConnection(connection),
    );
    if (activeConnectionId !== undefined) {
      return authorized.find((connection) => connection.id === activeConnectionId);
    }
    if (authorized.length !== 1) return undefined;

    const [connection] = authorized;
    if (connection === undefined) return undefined;
    this.setState({
      ...this.state,
      activeConnectionId: connection.id,
      status: "connected",
    });
    return connection;
  }

  // Persisted before this field existed, a session's state can lack it;
  // initialState only seeds brand-new DOs.
  private persistedActiveConnectionId(): string | null | undefined {
    return (
      this.state as SessionState & {
        activeConnectionId?: string | null;
      }
    ).activeConnectionId;
  }
}

function isTerminalLifecycle(status: UnattendedSessionLifecycle): boolean {
  return status === "closed" || status === "expired" || status === "lost";
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function resolveBeforeDeadline<T>(
  promise: Promise<T>,
  deadlineAt: number,
): Promise<
  | { kind: "value"; value: T }
  | { kind: "error" }
  | { kind: "timeout" }
> {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) return { kind: "timeout" };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(
        (value) => ({ kind: "value" as const, value }),
        () => ({ kind: "error" as const }),
      ),
      new Promise<{ kind: "timeout" }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: "timeout" }), remaining);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
