/**
 * AccountAgent — one Durable Object per tenant (idFromName(tenantId)),
 * the MCP layer's session brain. The LLM is not a session manager: no tool
 * takes or returns a sessionId, so this object owns
 *
 *  1. each device's current session binding (survives MCP client reconnects, which
 *     kill the per-connection UnderstudyMcp instance),
 *  2. the exact semantic snapshot binding and ref-staleness guard — the
 *     dominant LLM failure mode is reusing a generation-scoped ref after
 *     navigation, and this guard turns that into a zero-latency recovery
 *     result without touching the device,
 *  3. one command at a time per device plus the retry/poll recovery loops
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
  type ElementSnapshot,
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
// Protocol-2 storage keys are read only for one-way migration. Their coarse
// state is always invalidated rather than treated as a live semantic cache.
const REFS_VALID_KEY = "refsValid";
const REFS_EPOCH_KEY = "refsEpoch";
const REFS_URL_KEY = "refsUrl";
const SNAPSHOT_BINDING_KEY = "snapshotBinding";
const PENDING_CREATE_KEY = "pendingCreate";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isConnectingLifecycle(status: UnattendedSessionLifecycle): boolean {
  return status === "allocating" || status === "provisioning" || status === "suspended";
}

/**
 * Who is acting — the pseudonymous actor id from UnderstudyMcpProps. The
 * TENANT is this DO's own name, never a parameter, so no caller can pass a
 * foreign identity: device listing and session scoping both derive from the
 * name, and a stray userId cannot widen access.
 */
export interface McpActorRef {
  actorId: string;
  deviceId: string;
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
  /** Legacy no-argument snapshot fallback when semantic capture is unsupported. */
  legacyFallback?: CommandDraft;
}

export interface SnapshotBinding extends ElementSnapshot {
  url: string;
  valid: boolean;
}

function elementsFailureInvalidatesSnapshot(
  event: Extract<Event, { type: "elements_result"; status: "error" }>,
): boolean {
  if (
    event.reason === "invalid_cursor" ||
    event.reason === "cursor_expired" ||
    event.reason === "unsupported"
  ) {
    return false;
  }
  return event.reason !== "page_too_large" || event.operation === "snapshot";
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
  | { kind: "legacy_snapshot_required" }
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
      snapshot: SnapshotBinding | null;
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
   * One operation at a time per physical browser, across every MCP
   * connection bound to it. Independent devices must not head-of-line block
   * one another.
   */
  private readonly deviceTails = new Map<string, Promise<void>>();

  private serialize<T>(actor: McpActorRef, task: () => Promise<T>): Promise<T> {
    const previous = this.deviceTails.get(actor.deviceId) ?? Promise.resolve();
    const next = previous.then(task, task);
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    this.deviceTails.set(actor.deviceId, tail);
    void tail.then(() => {
      if (this.deviceTails.get(actor.deviceId) === tail) {
        this.deviceTails.delete(actor.deviceId);
      }
    });
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

  private key(base: string, actor: McpActorRef): string {
    return `${base}:${actor.deviceId}`;
  }

  private async getBinding(actor: McpActorRef): Promise<BoundSession | undefined> {
    const scopedKey = this.key(BINDING_KEY, actor);
    const scoped = await this.ctx.storage.get<BoundSession>(scopedKey);
    if (scoped !== undefined) return scoped;

    // Protocol-2 AccountAgent state used one account-wide namespace. A live
    // binding already records the physical device that owns it, so it can be
    // migrated without guessing. Leave a different device's legacy binding
    // alone so the correctly bound credential can claim it later.
    const legacy = await this.ctx.storage.get<BoundSession>(BINDING_KEY);
    if (legacy === undefined || legacy.deviceId !== actor.deviceId) return undefined;
    const legacyState = await this.ctx.storage.get<unknown>([
      REFS_VALID_KEY,
      REFS_EPOCH_KEY,
      REFS_URL_KEY,
      PENDING_CREATE_KEY,
    ]);
    await this.ctx.storage.put({
      [scopedKey]: legacy,
      ...(legacyState.get(REFS_VALID_KEY) === undefined
        ? {}
        : { [this.key(REFS_VALID_KEY, actor)]: legacyState.get(REFS_VALID_KEY) }),
      ...(legacyState.get(REFS_EPOCH_KEY) === undefined
        ? {}
        : { [this.key(REFS_EPOCH_KEY, actor)]: legacyState.get(REFS_EPOCH_KEY) }),
      ...(legacyState.get(REFS_URL_KEY) === undefined
        ? {}
        : { [this.key(REFS_URL_KEY, actor)]: legacyState.get(REFS_URL_KEY) }),
      ...(legacyState.get(PENDING_CREATE_KEY) === undefined
        ? {}
        : { [this.key(PENDING_CREATE_KEY, actor)]: legacyState.get(PENDING_CREATE_KEY) }),
    });
    await this.ctx.storage.delete([
      BINDING_KEY,
      REFS_VALID_KEY,
      REFS_EPOCH_KEY,
      REFS_URL_KEY,
      PENDING_CREATE_KEY,
    ]);
    return legacy;
  }

  private async clearBinding(actor: McpActorRef): Promise<void> {
    await this.ctx.storage.delete([
      this.key(BINDING_KEY, actor),
      this.key(SNAPSHOT_BINDING_KEY, actor),
      this.key(REFS_VALID_KEY, actor),
      this.key(REFS_EPOCH_KEY, actor),
      this.key(REFS_URL_KEY, actor),
    ]);
  }

  private async setSnapshotBinding(
    actor: McpActorRef,
    binding: SnapshotBinding | null,
  ): Promise<void> {
    const key = this.key(SNAPSHOT_BINDING_KEY, actor);
    if (binding === null) await this.ctx.storage.delete(key);
    else await this.ctx.storage.put(key, binding);
  }

  private async invalidateSnapshot(actor: McpActorRef): Promise<void> {
    const current = await this.snapshotState(actor);
    if (current !== null && current.valid) {
      await this.setSnapshotBinding(actor, { ...current, valid: false });
    }
  }

  private async snapshotState(actor: McpActorRef): Promise<SnapshotBinding | null> {
    const key = this.key(SNAPSHOT_BINDING_KEY, actor);
    const current = await this.ctx.storage.get<SnapshotBinding>(key);
    if (current !== undefined) return current;

    const legacy = await this.ctx.storage.get<unknown>([
      this.key(REFS_VALID_KEY, actor),
      this.key(REFS_EPOCH_KEY, actor),
      this.key(REFS_URL_KEY, actor),
    ]);
    const valid = legacy.get(this.key(REFS_VALID_KEY, actor));
    const epoch = legacy.get(this.key(REFS_EPOCH_KEY, actor));
    const url = legacy.get(this.key(REFS_URL_KEY, actor));
    if (valid === undefined && epoch === undefined && url === undefined) return null;
    const migrated: SnapshotBinding = {
      id: "legacy-invalidated",
      generation: typeof epoch === "number" && Number.isInteger(epoch) ? epoch : 0,
      capturedAt: new Date(0).toISOString(),
      scope: "document",
      view: "interactive",
      coverage: "partial",
      url: typeof url === "string" ? url : "about:blank",
      valid: false,
    };
    await this.ctx.storage.put(key, migrated);
    await this.ctx.storage.delete([
      this.key(REFS_VALID_KEY, actor),
      this.key(REFS_EPOCH_KEY, actor),
      this.key(REFS_URL_KEY, actor),
    ]);
    return migrated;
  }

  private async reconcileSnapshotUrl(
    actor: McpActorRef,
    currentUrl: string | null,
  ): Promise<SnapshotBinding | null> {
    const snapshot = await this.snapshotState(actor);
    if (
      snapshot !== null &&
      snapshot.valid &&
      currentUrl !== snapshot.url
    ) {
      const invalidated = { ...snapshot, valid: false };
      await this.setSnapshotBinding(actor, invalidated);
      return invalidated;
    }
    return snapshot;
  }

  async openBrowser(
    actor: McpActorRef,
    input: { profile?: string; origins?: string[] },
  ): Promise<OpenBrowserResult> {
    return this.serialize(actor, () => this.openBrowserLocked(actor, input));
  }

  private async openBrowserLocked(
    actor: McpActorRef,
    input: { profile?: string; origins?: string[] },
  ): Promise<OpenBrowserResult> {
    const svcActor = this.serviceActor(actor);
    const profile = input.profile ?? "default";

    const binding = await this.getBinding(actor);
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
          if (isConnectingLifecycle(status.status)) {
            return { kind: "connecting", profile };
          }
          // "closing": the lease is shutting down; a new create would collide
          // on the profile-state key, so ask the model to retry shortly.
          return { kind: "closing_wait" };
        }
      }
      // Terminal, attended-shaped, or gone: drop the stale binding and open fresh.
      await this.clearBinding(actor);
    }

    const summaries = await this.deviceViews(svcActor);
    const chosen = summaries.find((device) => device.deviceId === actor.deviceId);
    if (chosen === undefined) return { kind: "no_paired_devices" };
    if (
      chosen.status !== "online" ||
      chosen.used === null ||
      chosen.capacity === null ||
      chosen.used >= chosen.capacity
    ) {
      return chosen.status === "online"
        ? { kind: "device_busy" }
        : { kind: "devices_offline", devices: [chosen] };
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
    const pendingKey = this.key(PENDING_CREATE_KEY, actor);
    const bindingKey = this.key(BINDING_KEY, actor);
    const pending = await this.ctx.storage.get<PendingCreate>(pendingKey);
    const createKey = pending?.profile === profile ? pending.key : crypto.randomUUID();
    await this.ctx.storage.put(pendingKey, { profile, key: createKey });

    const created = await createSession(this.env, svcActor, {
      // The attended/unattended footgun lives below this one call site: an
      // EMPTY body means attended. This request object is always present and
      // always mode:"unattended" — never send {}.
      request: {
        mode: "unattended",
        deviceId,
        allowedOrigins,
        profileStateKey: `mcp/${tenantId}/${actor.deviceId}/${profile}`,
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
      await this.ctx.storage.put(bindingKey, binding);
      await this.ctx.storage.delete(pendingKey);
      // The owned tab starts at about:blank — the model must snapshot first.
      await this.setSnapshotBinding(actor, null);
      return created.kind === "connected"
        ? { kind: "ready", adopted: false, profile, url: null, allowedOrigins, recovering: false }
        : { kind: "connecting", profile };
    }

    // Every non-success create clears the stored key: leaving it behind makes
    // the next browser_open replay the SAME idempotency key against a lease
    // the coordinator already failed, wedging the model on a dead session. A
    // genuine re-entrant retry mints a fresh key via the success path above,
    // so nothing legitimate is lost.
    await this.ctx.storage.delete(pendingKey);
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
      case "bad_request":
        return { kind: "create_failed", reason: created.message };
    }
  }

  async closeBrowser(actor: McpActorRef): Promise<CloseBrowserResult> {
    return this.serialize(actor, async () => {
      const binding = await this.getBinding(actor);
      if (binding === undefined) return { kind: "no_session" };
      const result = await deleteSession(
        this.env,
        this.serviceActor(actor),
        binding.sessionId,
        CANONICAL_URL,
      );
      await this.clearBinding(actor);
      return result.kind === "closing" ? { kind: "closing" } : { kind: "closed" };
    });
  }

  async status(actor: McpActorRef): Promise<StatusReport> {
    return this.serialize(actor, () => this.statusLocked(actor));
  }

  private async statusLocked(actor: McpActorRef): Promise<StatusReport> {
    const svcActor = this.serviceActor(actor);
    const devices = await this.deviceViews(svcActor);

    const binding = await this.getBinding(actor);
    if (binding === undefined) return { devices, session: { state: "none" } };
    const current = await getSessionStatus(this.env, svcActor, binding.sessionId);
    if (
      current.kind !== "ok" ||
      !("mode" in current.status) ||
      current.status.mode !== "unattended" ||
      current.terminal
    ) {
      await this.clearBinding(actor);
      return { devices, session: { state: "none" } };
    }
    const status = current.status;
    if (isConnectingLifecycle(status.status)) {
      return {
        devices,
        session: { state: "connecting", profile: binding.profile, status: status.status },
      };
    }
    if (status.status === "closing") {
      return { devices, session: { state: "closing", profile: binding.profile } };
    }
    const snapshot = await this.reconcileSnapshotUrl(actor, status.currentUrl);
    return {
      devices,
      session: {
        state: "open",
        profile: binding.profile,
        status: status.status,
        url: status.currentUrl,
        snapshot,
        dialogs: status.dialogs,
        allowedOrigins: binding.allowedOrigins,
      },
    };
  }

  async runCommand(actor: McpActorRef, input: RunCommandInput): Promise<RunCommandEnvelope> {
    return this.serialize(actor, async () => {
      const binding = await this.getBinding(actor);
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

    const svcActor = this.serviceActor(actor);
    let lastUrl: string | null = null;
    if (input.usesRef) {
      const current = await getSessionStatus(this.env, svcActor, binding.sessionId);
      const knownUrl =
        current.kind === "ok" &&
        !current.terminal &&
        "mode" in current.status &&
        current.status.mode === "unattended" &&
        current.status.status === "connected"
          ? current.status.currentUrl
          : null;
      const refs = await this.reconcileSnapshotUrl(actor, knownUrl);
      // Zero-latency hard guard: never send a doomed ref to the device.
      if (refs?.valid !== true) return { kind: "stale_refs" };
      lastUrl = refs.url;
    }

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
    if (
      result.kind === "legacy_snapshot_required" &&
      input.legacyFallback !== undefined
    ) {
      const fallback = await this.buildCommand(
        binding.sessionId,
        { ...input, draft: input.legacyFallback },
        crypto.randomUUID(),
      );
      const parsedFallback = CommandSchema.safeParse(fallback);
      if (parsedFallback.success) {
        result = await runDispatchLoop(parsedFallback.data, deps);
      }
    }
    if (result.kind === "legacy_snapshot_required") {
      result = { kind: "unsupported" };
    }
    if (result.kind === "id_conflict" && input.idempotencyKey !== undefined) {
      // The caller-chosen idempotency key collided with a different command
      // body. Retry exactly once under a fresh random identity.
      const fresh = await this.buildCommand(binding.sessionId, input, crypto.randomUUID());
      const reparsed = CommandSchema.safeParse(fresh);
      if (reparsed.success) {
        result = await runDispatchLoop(reparsed.data, deps);
      }
    }

    await this.applyRefBookkeeping(actor, input, result, lastUrl);
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
    actor: McpActorRef,
    input: RunCommandInput,
    result: RunCommandResult,
    lastUrl: string | null = null,
  ): Promise<void> {
    if (result.kind === "unknown_outcome") {
      // OUTCOME UNKNOWN: the page may have changed under us. Forcing a
      // snapshot before any further ref use makes the "do not retry,
      // observe" instruction enforced rather than merely requested.
      await this.invalidateSnapshot(actor);
      return;
    }
    if (input.draft.type === "navigate" && result.kind === "pending_exhausted") {
      await this.invalidateSnapshot(actor);
      return;
    }
    if (result.kind === "terminal_session") {
      await this.clearBinding(actor);
      return;
    }
    if (result.kind !== "terminal") return;
    const event = result.event;
    if (input.draft.type === "submit_card" && event.type === "card_submission_result") {
      await this.applyCardResultBookkeeping(actor, event);
      return;
    }
    if (await this.applySnapshotResultBookkeeping(actor, event)) return;
    if (event.type !== "action_result") return;
    const snapshot = await this.snapshotState(actor);
    if (
      event.refsStale === true ||
      (event.generation !== undefined &&
        snapshot !== null &&
        event.generation !== snapshot.generation) ||
      ["stale_ref", "target_changed", "frame_changed", "page_changed"].includes(
        event.reason ?? "",
      ) ||
      event.error?.startsWith("stale or unknown ref") === true
    ) {
      await this.invalidateSnapshot(actor);
      return;
    }
    if (!event.ok) return;
    // Any successful action that CHANGED the URL invalidates every ref — not
    // just an explicit navigate. A click that navigates is the most common
    // way an LLM moves pages, so the guard must catch it too (D11). The
    // extension echoes the post-action URL on action_result.
    const navigated =
      input.draft.type === "navigate" ||
      (event.url !== undefined && lastUrl !== null && event.url !== lastUrl);
    if (navigated) await this.invalidateSnapshot(actor);
  }

  /** Collects a command previously reported pending and converges local bookkeeping. */
  async getResult(actor: McpActorRef, commandId: string): Promise<GetResultOutcome> {
    return this.serialize(actor, () => this.getResultLocked(actor, commandId));
  }

  private async getResultLocked(
    actor: McpActorRef,
    commandId: string,
  ): Promise<GetResultOutcome> {
    const binding = await this.getBinding(actor);
    if (binding === undefined) return { kind: "no_session" };
    const polled = await pollCommand(
      this.env,
      this.serviceActor(actor),
      binding.sessionId,
      commandId,
    );
    if (polled.kind !== "ok") return { kind: "not_found" };
    switch (polled.record.status) {
      case "completed": {
        const event = polled.record.event;
        if (event === undefined) {
          await this.invalidateSnapshot(actor);
          return { kind: "unknown_outcome" };
        }
        await this.applyPolledEventBookkeeping(actor, event);
        return { kind: "completed", event };
      }
      case "not_started":
      case "timed_out":
        return { kind: "did_not_run", status: polled.record.status };
      case "unknown":
        await this.invalidateSnapshot(actor);
        return { kind: "unknown_outcome" };
      default:
        return { kind: "in_progress", status: polled.record.status };
    }
  }

  private async applyPolledEventBookkeeping(actor: McpActorRef, event: Event): Promise<void> {
    if (event.type === "card_submission_result") {
      await this.applyCardResultBookkeeping(actor, event);
      return;
    }
    if (await this.applySnapshotResultBookkeeping(actor, event)) return;
    if (event.type !== "action_result") return;
    const snapshot = await this.snapshotState(actor);
    if (
      event.refsStale === true ||
      (event.generation !== undefined &&
        snapshot !== null &&
        event.generation !== snapshot.generation) ||
      (event.url !== undefined && snapshot !== null && event.url !== snapshot.url)
    ) {
      await this.invalidateSnapshot(actor);
    }
  }

  private async applySnapshotResultBookkeeping(
    actor: McpActorRef,
    event: Event,
  ): Promise<boolean> {
    if (event.type === "elements_result") {
      if (event.status === "ok") {
        if (event.operation === "inspect" || event.operation === "next") {
          const current = await this.snapshotState(actor);
          if (
            current === null ||
            current.id !== event.snapshot.id ||
            current.generation !== event.snapshot.generation ||
            current.url !== event.url
          ) {
            await this.invalidateSnapshot(actor);
          }
        } else if (event.operation === "find") {
          const current = await this.snapshotState(actor);
          if (
            current === null ||
            current.id !== event.snapshot.id ||
            current.generation !== event.snapshot.generation ||
            current.url !== event.url
          ) {
            await this.setSnapshotBinding(actor, {
              ...event.snapshot,
              url: event.url,
              valid: true,
            });
          }
        } else {
          await this.setSnapshotBinding(actor, {
            ...event.snapshot,
            url: event.url,
            valid: true,
          });
        }
      } else if (elementsFailureInvalidatesSnapshot(event)) {
        await this.invalidateSnapshot(actor);
      }
      return true;
    }
    if (event.type !== "snapshot_result") return false;
    const previous = await this.snapshotState(actor);
    await this.setSnapshotBinding(actor, {
      id: `legacy:${event.commandId}`,
      generation: (previous?.generation ?? 0) + 1,
      capturedAt: new Date().toISOString(),
      scope: "document",
      view: "interactive",
      coverage: "partial",
      url: event.url,
      valid: true,
    });
    return true;
  }

  private async applyCardResultBookkeeping(
    actor: McpActorRef,
    event: Extract<Event, { type: "card_submission_result" }>,
  ): Promise<void> {
    if (event.status === "outcome_unknown") {
      await this.clearBinding(actor);
      return;
    }
    await this.invalidateSnapshot(actor);
  }
}
