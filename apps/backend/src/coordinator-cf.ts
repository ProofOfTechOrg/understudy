/**
 * Cloudflare implementation of SessionCoordinator (DL-010).
 *
 * Couples the portable command<->event correlation contract to a live
 * extension WebSocket and Durable Object state via a constructor-injected
 * CoordinatorHost, rather than a direct import of session.ts (circular:
 * session.ts imports CfSessionCoordinator) or the `agents` package. This
 * keeps the Cloudflare coupling localized to this one file.
 */

import type { Command, Event } from "@understudy/protocol";
import type { PendingCommand, PendingMap, SessionCoordinator } from "./coordinator";
import type { SessionStatus } from "./types";

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * The capabilities CfSessionCoordinator needs from its owning SessionAgent
 * (M-004). Implemented by the DO and injected here, so this file never
 * imports session.ts or `agents` directly.
 */
export interface CoordinatorHost {
  /** Writes a JSON frame to the live extension WebSocket. */
  sendToExtension(payload: string): void;
  /** Reads the persisted awaiting-commandId marker (SessionState.awaitingCommandIds). */
  getAwaitingCommandIds(): string[];
  /** Persists the awaiting-commandId marker via the DO's setState. */
  persistAwaitingCommandIds(ids: string[]): void;
  /** Persists the session status via the DO's setState. */
  persistStatus(status: SessionStatus): void;
}

export class CfSessionCoordinator implements SessionCoordinator {
  private readonly pending: PendingMap = new Map();
  private readonly host: CoordinatorHost;
  private readonly timeoutMs: number;

  constructor(host: CoordinatorHost, opts?: { timeoutMs?: number }) {
    this.host = host;
    this.timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Hibernation-reconciliation rationale (DL-007), verified against the
   * current Cloudflare Durable Objects docs
   * (durable-objects/concepts/durable-object-lifecycle/, checked
   * 2026-07-14): hibernation requires ALL of - no pending
   * setTimeout/setInterval, no in-progress awaited fetch(), no WebSocket
   * standard API in use, no request/event still being processed, no active
   * outbound TCP/WebSocket connection - and even then only fires after
   * roughly 10s of subsequent inactivity. A `send()` in flight violates two
   * of those by itself: the RPC/HTTP request awaiting its result is a
   * "request/event still being processed", and the timer below is a
   * "scheduled callback". So this DO cannot hibernate mid-command - an
   * in-flight promise is never silently lost to hibernation; that half of
   * DL-007 is a platform guarantee, not an assumption.
   *
   * What CAN still interrupt a command is a different eviction path -
   * shutdown/restart (deploys, runtime updates, host rebalancing; per the
   * Agents SDK durable-execution docs this is non-deterministic, roughly
   * 1-2x/day) - which terminates the extension WebSocket outright,
   * independent of the hibernation preconditions above. The per-command
   * timeout below is the caller-side guarantee for that case: `send()`
   * always settles even if the WebSocket is gone.
   */
  send(cmd: Command): Promise<Event> {
    return new Promise<Event>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(`command ${cmd.commandId} (${cmd.type}) timed out after ${this.timeoutMs}ms`),
        );
        this.pending.delete(cmd.commandId);
        this.dropAwaiting(cmd.commandId);
      }, this.timeoutMs);

      const pendingCommand: PendingCommand = { resolve, reject, timer };
      this.pending.set(cmd.commandId, pendingCommand);
      this.addAwaiting(cmd.commandId);

      // DL-004: metadata only, never the full command - a fill_secret's
      // eventual plaintext (type.text) and its secretRef must never reach a
      // log, by construction.
      console.log("coordinator.send", { commandId: cmd.commandId, type: cmd.type });

      this.host.sendToExtension(JSON.stringify(cmd));
    });
  }

  /**
   * The other half of DL-007 (see `send` above): once a command settles
   * (resolved here, or timed out) this DO can genuinely go idle and later
   * hibernate, wiping the in-memory `pending` Map. If a stray or duplicate
   * `*_result` for an already-settled commandId arrives after that wake,
   * there is no resolver left to call for it - the persisted marker is the
   * only remaining record that it was ever outstanding. Recognize that
   * case, drop the event, and reconcile the marker, instead of leaking a
   * phantom "awaiting" entry in SessionState forever or mis-resolving some
   * unrelated later command that happens to reuse pending-map bookkeeping.
   */
  resolvePending(ev: Event): void {
    const commandId = "commandId" in ev ? ev.commandId : undefined;
    if (commandId === undefined) return; // hello / page_event / pong: no-op.

    const pendingCommand = this.pending.get(commandId);
    if (pendingCommand) {
      clearTimeout(pendingCommand.timer);
      pendingCommand.resolve(ev);
      this.pending.delete(commandId);
      this.dropAwaiting(commandId);
      return;
    }

    if (this.host.getAwaitingCommandIds().includes(commandId)) {
      // Orphaned/late result: reconcile the marker, resolve nothing.
      this.dropAwaiting(commandId);
      return;
    }

    // Unknown commandId: never sent, or already reconciled. No-op, never throw.
  }

  setStatus(s: SessionStatus): void {
    this.host.persistStatus(s);
  }

  /**
   * Rejects every outstanding command and clears all bookkeeping. M-004
   * calls this on a fresh `hello` resync, when the extension side is known
   * to have dropped whatever was in flight.
   */
  abandonInFlight(reason: string): void {
    for (const pendingCommand of this.pending.values()) {
      clearTimeout(pendingCommand.timer);
      pendingCommand.reject(new Error(reason));
    }
    this.pending.clear();
    this.host.persistAwaitingCommandIds([]);
  }

  private addAwaiting(commandId: string): void {
    const current = this.host.getAwaitingCommandIds();
    const next = current.includes(commandId) ? current : [...current, commandId];
    this.host.persistAwaitingCommandIds(next);
  }

  private dropAwaiting(commandId: string): void {
    const current = this.host.getAwaitingCommandIds();
    this.host.persistAwaitingCommandIds(current.filter((id) => id !== commandId));
  }
}
