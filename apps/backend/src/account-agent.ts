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
import { getDirectory } from "./account-directory";
import {
  createSession,
  deleteSession,
  dispatchCommand,
  getSessionStatus,
  listDevices,
  mergeDeviceViews,
  pollCommand,
  type AccountDeviceView,
} from "./api/sessions";
import type { Actor } from "./auth";
import { sha256Hex } from "./auth";
import { CANONICAL_BASE_URL } from "./canonical";
import {
  runDispatchLoop,
  type DispatchStep,
} from "./mcp/dispatch-loop";
import type { Env } from "./types";
import { canonicalizeOrigins, RequestBodyError, stableJson } from "./validation";

/**
 * Absolute base for the status URLs the service layer embeds in pending
 * outcomes. MCP polling happens in-process (never via these URLs), so the
 * canonical host is correct even when the MCP request arrived elsewhere.
 */
const CANONICAL_URL = CANONICAL_BASE_URL;

const BINDING_KEY = "binding";
const REFS_VALID_KEY = "refsValid";
const REFS_EPOCH_KEY = "refsEpoch";
const REFS_URL_KEY = "refsUrl";
const PENDING_CREATE_KEY = "pendingCreate";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Who is acting — the pseudonymous actor id from UnderstudyMcpProps. The
 * TENANT is this DO's own name, never a parameter, so no caller can pass a
 * foreign identity: device listing and session scoping both derive from the
 * name, and a stray userId cannot widen access.
 */
export interface McpActorRef {
  actorId: string;
}

/** The device shape MCP tools render, re-exported from the service layer. */
export type DeviceSummary = AccountDeviceView;

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

  /** This tenant's paired devices joined with their live coordinator state. */
  private async deviceViews(svcActor: Actor): Promise<DeviceSummary[]> {
    const directoryDevices = await getDirectory(this.env).listDevicesForTenant(
      this.tenantId(),
    );
    if (directoryDevices.length === 0) return [];
    return mergeDeviceViews(directoryDevices, await listDevices(this.env, svcActor));
  }

  private getBinding(): Promise<BoundSession | undefined> {
    return this.ctx.storage.get<BoundSession>(BINDING_KEY);
  }

  private async clearBinding(): Promise<void> {
    await this.ctx.storage.delete(BINDING_KEY);
    await this.setRefsValid(false);
  }

  private async setRefsValid(
    valid: boolean,
    bumpEpoch = false,
    url: string | null = null,
  ): Promise<void> {
    await this.ctx.storage.put(REFS_VALID_KEY, valid);
    // The URL the current refs were observed at, so a later click that
    // navigates can be detected by URL change and invalidate them.
    await this.ctx.storage.put(REFS_URL_KEY, url);
    if (bumpEpoch) {
      const epoch = (await this.ctx.storage.get<number>(REFS_EPOCH_KEY)) ?? 0;
      await this.ctx.storage.put(REFS_EPOCH_KEY, epoch + 1);
    }
  }

  private async refsState(): Promise<{ valid: boolean; epoch: number; url: string | null }> {
    return {
      valid: (await this.ctx.storage.get<boolean>(REFS_VALID_KEY)) ?? false,
      epoch: (await this.ctx.storage.get<number>(REFS_EPOCH_KEY)) ?? 0,
      url: (await this.ctx.storage.get<string | null>(REFS_URL_KEY)) ?? null,
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

    const summaries = await this.deviceViews(svcActor);
    if (summaries.length === 0) return { kind: "no_paired_devices" };

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
    // Unreachable (online.length > 0), but noUncheckedIndexedAccess forces
    // the guard. Reaching it means a device we just proved online vanished,
    // which is a create failure, not "everything is offline".
    if (chosen === undefined) {
      return { kind: "create_failed", reason: "device state changed mid-open" };
    }

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

    if (created.kind === "connected" || created.kind === "pending") {
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

    // Every non-success create clears the stored key: leaving it behind makes
    // the next browser_open replay the SAME idempotency key against a lease
    // the coordinator already failed, wedging the model on a dead session. A
    // genuine re-entrant retry mints a fresh key via the success path above,
    // so nothing legitimate is lost.
    await this.ctx.storage.delete(PENDING_CREATE_KEY);
    switch (created.kind) {
      case "idempotency_conflict":
        // The stored key was used with a different fingerprint (e.g. the
        // origin set changed since the aborted attempt). Retry once fresh.
        return retryOnKeyConflict
          ? this.createForDevice(actor, profile, deviceId, allowedOrigins, false)
          : { kind: "create_failed", reason: "idempotency key conflict" };
      case "terminal":
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
    const devices = await this.deviceViews(svcActor);

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
      const outcome = await this.runCommandLocked(actor, input, binding);
      return { outcome, allowedOrigins: binding?.allowedOrigins ?? null };
    });
  }

  private async runCommandLocked(
    actor: McpActorRef,
    input: RunCommandInput,
    binding: BoundSession | undefined,
  ): Promise<RunCommandResult> {
    if (binding === undefined) return { kind: "no_session" };

    let lastUrl: string | null = null;
    if (input.usesRef) {
      const refs = await this.refsState();
      // Zero-latency hard guard: never send a doomed ref to the device.
      if (!refs.valid) return { kind: "stale_refs" };
      lastUrl = refs.url;
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

    const deps = this.dispatchDeps(svcActor, binding.sessionId);
    let result: RunCommandResult = await runDispatchLoop(parsed.data, deps);
    if (result.kind === "id_conflict" && input.idempotencyKey !== undefined) {
      // The caller-chosen idempotency key collided with a different command
      // body. Retry exactly once under a fresh random identity.
      const fresh = await this.buildCommand(binding.sessionId, input, crypto.randomUUID());
      const reparsed = CommandSchema.safeParse(fresh);
      if (reparsed.success) {
        result = await runDispatchLoop(reparsed.data, deps);
      }
    }

    await this.applyRefBookkeeping(input, result, lastUrl);
    return result;
  }

  /** The three injected side effects the dispatch loop drives. */
  private dispatchDeps(svcActor: Actor, sessionId: string) {
    return {
      dispatch: async (command: Command): Promise<DispatchStep> => {
        const result = await dispatchCommand(this.env, svcActor, sessionId, {
          command,
          dryRun: false,
          contractV2: true,
          requestUrl: CANONICAL_URL,
        });
        if (result.kind === "not_found" || result.kind === "terminal_session") {
          return { kind: "gone" };
        }
        if (result.kind !== "v2") {
          // contractV2:true makes the legacy branch unreachable in the service.
          throw new Error(`unreachable dispatch result: ${result.kind}`);
        }
        return result.outcome;
      },
      poll: async (commandId: string) => {
        const polled = await pollCommand(this.env, svcActor, sessionId, commandId);
        return polled.kind === "ok" ? polled.record : null;
      },
      sleep,
    };
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

  private async applyRefBookkeeping(
    input: RunCommandInput,
    result: RunCommandResult,
    lastUrl: string | null = null,
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
      await this.setRefsValid(true, true, event.url);
      return;
    }
    if (event.type !== "action_result" || !event.ok) return;
    // Any successful action that CHANGED the URL invalidates every ref — not
    // just an explicit navigate. A click that navigates is the most common
    // way an LLM moves pages, so the guard must catch it too (D11). The
    // extension echoes the post-action URL on action_result.
    const navigated =
      input.draft.type === "navigate" ||
      (event.url !== undefined && lastUrl !== null && event.url !== lastUrl);
    if (navigated) await this.setRefsValid(false);
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
