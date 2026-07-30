/**
 * AccountAgent — one Durable Object per tenant (idFromName(tenantId)),
 * the MCP layer's session brain. The LLM is not a session manager: no tool
 * takes or returns a sessionId, so this object owns
 *
 *  1. the current session binding (survives MCP client reconnects, which
 *     kill the per-connection UnderstudyMcp instance),
 *  2. the ref-staleness guard (refsValid/refsEpoch) — the dominant LLM
 *     failure mode is reusing a single-use ref after navigation, and this
 *     guard turns that into a zero-latency, self-correcting error without
 *     touching the device,
 *  3. the one-command-at-a-time mutex plus the retry/poll recovery loops
 *     around the service layer's dispatch outcomes.
 *
 * Everything goes through src/api/sessions.ts — the same admission path the
 * /v1 handlers adapt — never through SessionAgent stubs directly.
 */

import { DurableObject } from "cloudflare:workers";
import {
  CommandSchema,
  type Command,
  type DialogRecord,
  type Event,
  type UnattendedSessionLifecycle,
} from "@understudy/protocol";
import {
  createSession,
  deleteSession,
  dispatchCommand,
  getSessionStatus,
  listDevices,
  pollCommand,
} from "./api/sessions";
import type { Actor } from "./auth";
import { sha256Hex } from "./auth";
import type { Env } from "./types";
import { canonicalizeOrigins, RequestBodyError, stableJson } from "./validation";

/**
 * Absolute base for the status URLs the service layer embeds in pending
 * outcomes. MCP polling happens in-process (never via these URLs), so the
 * canonical host is correct even when the MCP request arrived elsewhere.
 */
const CANONICAL_URL = "https://understudy.proofof.tech/";
const DISPATCH_RETRY_LIMIT = 2;
const BUSY_RETRY_LIMIT = 5;
const BUSY_RETRY_DELAY_MS = 2_000;
const PENDING_POLL_INTERVAL_MS = 2_000;
const PENDING_POLL_BUDGET_MS = 30_000;

const BINDING_KEY = "binding";
const REFS_VALID_KEY = "refsValid";
const REFS_EPOCH_KEY = "refsEpoch";
const PENDING_CREATE_KEY = "pendingCreate";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Who is acting, from UnderstudyMcpProps — tenant comes from this DO's name. */
export interface McpActorRef {
  userId: string;
  actorId: string;
}

interface BoundSession {
  sessionId: string;
  profile: string;
  createKey: string;
  deviceId: string;
  allowedOrigins: string[];
  createdAt: string;
}

interface PendingCreate {
  profile: string;
  key: string;
}

export type CommandDraft = {
  [K in Command["type"]]: Omit<Extract<Command, { type: K }>, "commandId">;
}[Command["type"]];

export interface RunCommandInput {
  /** Tool name, part of the write-identity hash and the ref bookkeeping. */
  tool: string;
  draft: CommandDraft;
  write: boolean;
  usesRef: boolean;
  idempotencyKey?: string;
}

export interface RunCommandEnvelope {
  outcome: RunCommandResult;
  /** The bound session's origin allowlist, for error texts that name it. */
  allowedOrigins: string[] | null;
}

export type RunCommandResult =
  | { kind: "no_session" }
  | { kind: "stale_refs" }
  | { kind: "invalid_command"; message: string }
  | { kind: "terminal"; event: Event }
  | { kind: "pending_exhausted"; commandId: string }
  | { kind: "retries_exhausted"; commandId: string }
  | { kind: "unknown_outcome"; commandId: string }
  | { kind: "id_conflict"; commandId: string }
  | { kind: "busy_exhausted" }
  | { kind: "not_connected" }
  | { kind: "unsupported" }
  | { kind: "terminal_session" };

export interface DeviceSummary {
  deviceId: string;
  label: string | null;
  status:
    | "online"
    | "offline"
    | "recovering"
    | "disabled"
    | "incompatible"
    | "never_connected";
  used: number | null;
  capacity: number | null;
  lastSeenAt: string | null;
  allowedOrigins: string[];
}

export type OpenBrowserResult =
  | {
      kind: "ready";
      adopted: boolean;
      profile: string;
      url: string | null;
      allowedOrigins: string[];
      recovering: boolean;
    }
  | { kind: "connecting"; profile: string }
  | { kind: "closing_wait" }
  | { kind: "profile_conflict"; boundProfile: string }
  | { kind: "no_paired_devices" }
  | { kind: "devices_offline"; devices: DeviceSummary[] }
  | { kind: "device_busy" }
  | { kind: "origins_invalid"; message: string }
  | { kind: "origins_not_subset"; allowed: string[] }
  | { kind: "disabled" }
  | { kind: "create_failed"; reason: string }
  | { kind: "session_terminal"; status: UnattendedSessionLifecycle };

export type CloseBrowserResult =
  | { kind: "no_session" }
  | { kind: "closed" }
  | { kind: "closing" };

export type SessionReport =
  | { state: "none" }
  | { state: "connecting"; profile: string; status: string }
  | {
      state: "open";
      profile: string;
      status: string;
      url: string | null;
      refsValid: boolean;
      refsEpoch: number;
      dialogs: DialogRecord[];
      allowedOrigins: string[];
    }
  | { state: "closing"; profile: string };

export interface StatusReport {
  devices: DeviceSummary[];
  session: SessionReport;
}

export type GetResultOutcome =
  | { kind: "no_session" }
  | { kind: "not_found" }
  | { kind: "completed"; event: Event }
  | { kind: "in_progress"; status: string }
  | { kind: "did_not_run"; status: string }
  | { kind: "unknown_outcome" };

export class AccountAgent extends DurableObject<Env> {
  /**
   * One command at a time per tenant, across every MCP connection: tasks
   * chain onto this tail, and a failed task never blocks the next one.
   */
  private tail: Promise<unknown> = Promise.resolve();

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.then(task, task);
    this.tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private tenantId(): string {
    const name = this.ctx.id.name;
    if (name === undefined) {
      throw new Error("AccountAgent must be addressed by tenant name");
    }
    return name;
  }

  private serviceActor(actor: McpActorRef): Actor {
    return { actor: actor.actorId, tenantId: this.tenantId() };
  }

  private getBinding(): Promise<BoundSession | undefined> {
    return this.ctx.storage.get<BoundSession>(BINDING_KEY);
  }

  private async clearBinding(): Promise<void> {
    await this.ctx.storage.delete(BINDING_KEY);
    await this.setRefsValid(false);
  }

  private async setRefsValid(valid: boolean, bumpEpoch = false): Promise<void> {
    await this.ctx.storage.put(REFS_VALID_KEY, valid);
    if (bumpEpoch) {
      const epoch = (await this.ctx.storage.get<number>(REFS_EPOCH_KEY)) ?? 0;
      await this.ctx.storage.put(REFS_EPOCH_KEY, epoch + 1);
    }
  }

  private async refsState(): Promise<{ valid: boolean; epoch: number }> {
    return {
      valid: (await this.ctx.storage.get<boolean>(REFS_VALID_KEY)) ?? false,
      epoch: (await this.ctx.storage.get<number>(REFS_EPOCH_KEY)) ?? 0,
    };
  }

  async openBrowser(
    actor: McpActorRef,
    input: { profile?: string; origins?: string[] },
  ): Promise<OpenBrowserResult> {
    return this.serialize(() => this.openBrowserLocked(actor, input));
  }

  private async openBrowserLocked(
    actor: McpActorRef,
    input: { profile?: string; origins?: string[] },
  ): Promise<OpenBrowserResult> {
    const svcActor = this.serviceActor(actor);
    const profile = input.profile ?? "default";

    const binding = await this.getBinding();
    if (binding !== undefined) {
      const current = await getSessionStatus(this.env, svcActor, binding.sessionId);
      if (current.kind === "ok" && "mode" in current.status && current.status.mode === "unattended") {
        const status = current.status;
        if (!current.terminal) {
          if (binding.profile !== profile) {
            return { kind: "profile_conflict", boundProfile: binding.profile };
          }
          if (status.status === "connected" || status.status === "recovering") {
            return {
              kind: "ready",
              adopted: true,
              profile,
              url: status.currentUrl,
              allowedOrigins: binding.allowedOrigins,
              recovering: status.status === "recovering",
            };
          }
          if (status.status === "allocating" || status.status === "provisioning") {
            return { kind: "connecting", profile };
          }
          // "closing": the lease is shutting down; a new create would collide
          // on the profile-state key, so ask the model to retry shortly.
          return { kind: "closing_wait" };
        }
      }
      // Terminal, attended-shaped, or gone: drop the stale binding and open fresh.
      await this.clearBinding();
    }

    const directoryDevices = await this.env.ACCOUNT_DIRECTORY.getByName("directory").listDevices(
      actor.userId,
    );
    if (directoryDevices.length === 0) return { kind: "no_paired_devices" };
    const live = await listDevices(this.env, svcActor);
    const liveById = new Map(live.map((device) => [device.deviceId, device]));
    const summaries: DeviceSummary[] = directoryDevices.map((device) => {
      const liveDevice = liveById.get(device.deviceId);
      return {
        deviceId: device.deviceId,
        label: device.label,
        status: liveDevice?.status ?? "never_connected",
        used: liveDevice?.used ?? null,
        capacity: liveDevice?.capacity ?? null,
        lastSeenAt: liveDevice?.lastSeenAt ?? null,
        allowedOrigins: device.allowedOrigins,
      };
    });

    const online = summaries.filter(
      (device) =>
        device.status === "online" &&
        device.used !== null &&
        device.capacity !== null &&
        device.used < device.capacity,
    );
    if (online.length === 0) {
      return summaries.some((device) => device.status === "online")
        ? { kind: "device_busy" }
        : { kind: "devices_offline", devices: summaries };
    }
    const chosen = online[0];
    if (chosen === undefined) return { kind: "devices_offline", devices: summaries };

    let allowedOrigins = chosen.allowedOrigins;
    if (input.origins !== undefined) {
      let requested: string[];
      try {
        requested = canonicalizeOrigins(input.origins);
      } catch (error) {
        return {
          kind: "origins_invalid",
          message: error instanceof RequestBodyError ? error.message : "invalid origin",
        };
      }
      if (!requested.every((origin) => chosen.allowedOrigins.includes(origin))) {
        return { kind: "origins_not_subset", allowed: chosen.allowedOrigins };
      }
      allowedOrigins = requested;
    }
    if (allowedOrigins.length === 0) {
      return { kind: "create_failed", reason: "device has no allowed origins" };
    }

    return this.createForDevice(actor, profile, chosen.deviceId, allowedOrigins, true);
  }

  private async createForDevice(
    actor: McpActorRef,
    profile: string,
    deviceId: string,
    allowedOrigins: string[],
    retryOnKeyConflict: boolean,
  ): Promise<OpenBrowserResult> {
    const tenantId = this.tenantId();
    const svcActor = this.serviceActor(actor);
    // Reuse the stored create key for this profile so a re-entrant open
    // (e.g. the model retrying after a transport error) replays the same
    // lease instead of allocating a second one.
    const pending = await this.ctx.storage.get<PendingCreate>(PENDING_CREATE_KEY);
    const createKey = pending?.profile === profile ? pending.key : crypto.randomUUID();
    await this.ctx.storage.put(PENDING_CREATE_KEY, { profile, key: createKey });

    const created = await createSession(this.env, svcActor, {
      // The attended/unattended footgun lives below this one call site: an
      // EMPTY body means attended. This request object is always present and
      // always mode:"unattended" — never send {}.
      request: {
        mode: "unattended",
        deviceId,
        allowedOrigins,
        profileStateKey: `mcp/${tenantId}/${profile}`,
      },
      idempotencyKey: createKey,
      requestUrl: CANONICAL_URL,
    });

    switch (created.kind) {
      case "connected":
      case "pending": {
        const binding: BoundSession = {
          sessionId: created.sessionId,
          profile,
          createKey,
          deviceId,
          allowedOrigins,
          createdAt: new Date().toISOString(),
        };
        await this.ctx.storage.put(BINDING_KEY, binding);
        await this.ctx.storage.delete(PENDING_CREATE_KEY);
        // The owned tab starts at about:blank — the model must snapshot first.
        await this.setRefsValid(false);
        return created.kind === "connected"
          ? { kind: "ready", adopted: false, profile, url: null, allowedOrigins, recovering: false }
          : { kind: "connecting", profile };
      }
      case "idempotency_conflict": {
        // The stored key was used with a different fingerprint (e.g. the
        // origin set changed since the aborted attempt). Mint a fresh key
        // and retry once.
        await this.ctx.storage.delete(PENDING_CREATE_KEY);
        if (retryOnKeyConflict) {
          return this.createForDevice(actor, profile, deviceId, allowedOrigins, false);
        }
        return { kind: "create_failed", reason: "idempotency key conflict" };
      }
      case "terminal":
        await this.ctx.storage.delete(PENDING_CREATE_KEY);
        return { kind: "session_terminal", status: created.status };
      case "disabled":
        return { kind: "disabled" };
      case "no_device":
        return { kind: "devices_offline", devices: [] };
      case "device_not_found":
        return { kind: "create_failed", reason: "device not found" };
      case "capacity":
        return { kind: "device_busy" };
      case "collision":
        return {
          kind: "create_failed",
          reason:
            "another session already drives this profile (origin or profile-state collision)",
        };
      case "provision_failed":
        return { kind: "create_failed", reason: "device connection unavailable" };
      case "bad_request":
        return { kind: "create_failed", reason: created.message };
    }
  }

  async closeBrowser(actor: McpActorRef): Promise<CloseBrowserResult> {
    return this.serialize(async () => {
      const binding = await this.getBinding();
      if (binding === undefined) return { kind: "no_session" };
      const result = await deleteSession(
        this.env,
        this.serviceActor(actor),
        binding.sessionId,
        CANONICAL_URL,
      );
      await this.clearBinding();
      return result.kind === "closing" ? { kind: "closing" } : { kind: "closed" };
    });
  }

  async status(actor: McpActorRef): Promise<StatusReport> {
    const svcActor = this.serviceActor(actor);
    const directoryDevices = await this.env.ACCOUNT_DIRECTORY.getByName("directory").listDevices(
      actor.userId,
    );
    const live = directoryDevices.length > 0 ? await listDevices(this.env, svcActor) : [];
    const liveById = new Map(live.map((device) => [device.deviceId, device]));
    const devices: DeviceSummary[] = directoryDevices.map((device) => {
      const liveDevice = liveById.get(device.deviceId);
      return {
        deviceId: device.deviceId,
        label: device.label,
        status: liveDevice?.status ?? "never_connected",
        used: liveDevice?.used ?? null,
        capacity: liveDevice?.capacity ?? null,
        lastSeenAt: liveDevice?.lastSeenAt ?? null,
        allowedOrigins: device.allowedOrigins,
      };
    });

    const binding = await this.getBinding();
    if (binding === undefined) return { devices, session: { state: "none" } };
    const current = await getSessionStatus(this.env, svcActor, binding.sessionId);
    if (
      current.kind !== "ok" ||
      !("mode" in current.status) ||
      current.status.mode !== "unattended" ||
      current.terminal
    ) {
      await this.clearBinding();
      return { devices, session: { state: "none" } };
    }
    const status = current.status;
    if (status.status === "allocating" || status.status === "provisioning") {
      return {
        devices,
        session: { state: "connecting", profile: binding.profile, status: status.status },
      };
    }
    if (status.status === "closing") {
      return { devices, session: { state: "closing", profile: binding.profile } };
    }
    const refs = await this.refsState();
    return {
      devices,
      session: {
        state: "open",
        profile: binding.profile,
        status: status.status,
        url: status.currentUrl,
        refsValid: refs.valid,
        refsEpoch: refs.epoch,
        dialogs: status.dialogs,
        allowedOrigins: binding.allowedOrigins,
      },
    };
  }

  async runCommand(actor: McpActorRef, input: RunCommandInput): Promise<RunCommandEnvelope> {
    return this.serialize(async () => {
      const binding = await this.getBinding();
      const outcome = await this.runCommandLocked(actor, input);
      return { outcome, allowedOrigins: binding?.allowedOrigins ?? null };
    });
  }

  private async runCommandLocked(
    actor: McpActorRef,
    input: RunCommandInput,
  ): Promise<RunCommandResult> {
    const binding = await this.getBinding();
    if (binding === undefined) return { kind: "no_session" };

    if (input.usesRef) {
      const refs = await this.refsState();
      // Zero-latency hard guard: never send a doomed ref to the device.
      if (!refs.valid) return { kind: "stale_refs" };
    }

    const svcActor = this.serviceActor(actor);
    const salt = input.idempotencyKey ?? crypto.randomUUID();
    const command = await this.buildCommand(binding.sessionId, input, salt);
    const parsed = CommandSchema.safeParse(command);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return {
        kind: "invalid_command",
        message: issue === undefined ? "invalid command" : `${issue.path.join(".")}: ${issue.message}`,
      };
    }

    let result = await this.runDispatchLoop(svcActor, binding.sessionId, parsed.data);
    if (result.kind === "id_conflict" && input.idempotencyKey !== undefined) {
      // The caller-chosen idempotency key collided with a different command
      // body. Retry exactly once under a fresh random identity.
      const fresh = await this.buildCommand(binding.sessionId, input, crypto.randomUUID());
      const reparsed = CommandSchema.safeParse(fresh);
      if (reparsed.success) {
        result = await this.runDispatchLoop(svcActor, binding.sessionId, reparsed.data);
      }
    }

    await this.applyRefBookkeeping(input, result);
    return result;
  }

  private async buildCommand(
    sessionId: string,
    input: RunCommandInput,
    salt: string,
  ): Promise<Command> {
    const commandId = input.write
      ? `ik_${await sha256Hex(
          [this.tenantId(), sessionId, input.tool, stableJson(input.draft), salt].join("|"),
        )}`
      : `r_${crypto.randomUUID()}`;
    return { ...input.draft, commandId } as Command;
  }

  private async runDispatchLoop(
    svcActor: Actor,
    sessionId: string,
    command: Command,
  ): Promise<RunCommandResult> {
    let busyAttempts = 0;
    let dispatchAttempts = 0;
    // Each iteration re-POSTs the SAME commandId: 504-class outcomes carry
    // safeToRetry:true because the journal proves the write never started,
    // and busy re-admissions must share one identity with the original.
    while (true) {
      const result = await dispatchCommand(this.env, svcActor, sessionId, {
        command,
        dryRun: false,
        contractV2: true,
        requestUrl: CANONICAL_URL,
      });
      if (result.kind === "not_found" || result.kind === "terminal_session") {
        return { kind: "terminal_session" };
      }
      if (result.kind !== "v2") {
        // contractV2:true makes the legacy branch unreachable in the service.
        throw new Error(`unreachable dispatch result: ${result.kind}`);
      }
      const outcome = result.outcome;
      switch (outcome.kind) {
        case "terminal":
          return { kind: "terminal", event: outcome.event };
        case "pending": {
          const polled = await this.pollUntilSettled(svcActor, sessionId, command.commandId);
          if (polled === "retry") {
            dispatchAttempts += 1;
            if (dispatchAttempts > DISPATCH_RETRY_LIMIT) {
              return { kind: "retries_exhausted", commandId: command.commandId };
            }
            continue;
          }
          return polled;
        }
        case "not_started":
        case "timed_out":
          dispatchAttempts += 1;
          if (dispatchAttempts > DISPATCH_RETRY_LIMIT) {
            return { kind: "retries_exhausted", commandId: command.commandId };
          }
          continue;
        case "unknown":
          return { kind: "unknown_outcome", commandId: command.commandId };
        case "id_conflict":
          return { kind: "id_conflict", commandId: command.commandId };
        case "busy":
          busyAttempts += 1;
          if (busyAttempts >= BUSY_RETRY_LIMIT) return { kind: "busy_exhausted" };
          await sleep(BUSY_RETRY_DELAY_MS);
          continue;
        case "not_connected":
          return { kind: "not_connected" };
        case "unsupported":
          return { kind: "unsupported" };
        case "terminal_session":
          return { kind: "terminal_session" };
      }
    }
  }

  /**
   * Polls a pending command past the server's ~20s synchronous window for
   * another ~30s. Returns "retry" when the journal proves the command never
   * started (safe to re-POST the same id); otherwise a final result.
   */
  private async pollUntilSettled(
    svcActor: Actor,
    sessionId: string,
    commandId: string,
  ): Promise<RunCommandResult | "retry"> {
    const deadline = Date.now() + PENDING_POLL_BUDGET_MS;
    while (Date.now() < deadline) {
      await sleep(PENDING_POLL_INTERVAL_MS);
      const polled = await pollCommand(this.env, svcActor, sessionId, commandId);
      if (polled.kind !== "ok") continue;
      switch (polled.record.status) {
        case "completed":
          return polled.record.event !== undefined
            ? { kind: "terminal", event: polled.record.event }
            : { kind: "pending_exhausted", commandId };
        case "not_started":
        case "timed_out":
          return "retry";
        case "unknown":
          return { kind: "unknown_outcome", commandId };
        default:
          continue;
      }
    }
    return { kind: "pending_exhausted", commandId };
  }

  private async applyRefBookkeeping(
    input: RunCommandInput,
    result: RunCommandResult,
  ): Promise<void> {
    if (result.kind === "unknown_outcome") {
      // OUTCOME UNKNOWN: the page may have changed under us. Forcing a
      // snapshot before any further ref use makes the "do not retry,
      // observe" instruction enforced rather than merely requested.
      await this.setRefsValid(false);
      return;
    }
    if (result.kind === "terminal_session") {
      await this.clearBinding();
      return;
    }
    if (result.kind !== "terminal") return;
    const event = result.event;
    if (input.draft.type === "snapshot" && event.type === "snapshot_result") {
      await this.setRefsValid(true, true);
      return;
    }
    if (input.draft.type === "navigate" && event.type === "action_result" && event.ok) {
      await this.setRefsValid(false);
    }
  }

  /** Collects a command previously reported pending — read-only, no mutex. */
  async getResult(actor: McpActorRef, commandId: string): Promise<GetResultOutcome> {
    const binding = await this.getBinding();
    if (binding === undefined) return { kind: "no_session" };
    const polled = await pollCommand(
      this.env,
      this.serviceActor(actor),
      binding.sessionId,
      commandId,
    );
    if (polled.kind !== "ok") return { kind: "not_found" };
    switch (polled.record.status) {
      case "completed":
        return polled.record.event !== undefined
          ? { kind: "completed", event: polled.record.event }
          : { kind: "unknown_outcome" };
      case "not_started":
      case "timed_out":
        return { kind: "did_not_run", status: polled.record.status };
      case "unknown":
        return { kind: "unknown_outcome" };
      default:
        return { kind: "in_progress", status: polled.record.status };
    }
  }
}
