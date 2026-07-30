/**
 * Shared Workers-runtime test helpers for service.test.ts and
 * session.test.ts. Unlike tokens.ts, this file imports cloudflare:workers/
 * agents and so only loads inside the pool (never from vitest.config.ts).
 */

import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import mainModule from "../src/index";
import type { AccountDirectory } from "../src/account-directory";
import type { SessionAgent } from "../src/session";

export const BASE = "https://understudy.example";
export const CANONICAL = "https://understudy.proofof.tech";

export function getSessionStub(sessionId: string): Promise<DurableObjectStub<SessionAgent>> {
  return getAgentByName(env.SESSION, sessionId);
}

export function getWebSocket(response: Response): WebSocket {
  const socket = response.webSocket;
  if (socket === null || socket === undefined) {
    throw new TypeError("Expected a WebSocket upgrade response");
  }
  return socket;
}

/** The singleton account store — one accessor for every suite. */
export function directory(): DurableObjectStub<AccountDirectory> {
  return env.ACCOUNT_DIRECTORY.getByName("directory");
}

/**
 * Drives the Worker's module fetch directly. The pool's `exports` wrapper
 * rewrites the request URL onto a loopback host, which the dashboard's
 * host-sensitive checks (canonical-host redirect, __Host- cookie origin)
 * must see intact — so host-dependent suites call this, not `exports`.
 */
export function fetchApp(request: Request): Promise<Response> {
  return mainModule.fetch(
    request,
    env as never,
    { waitUntil() {}, passThroughOnException() {} } as never,
  );
}

/** Mints a fresh signed-up user via the real OTP path (no email send needed). */
export async function mintUser(): Promise<{
  userId: string;
  tenantId: string;
  email: string;
}> {
  const email = `${crypto.randomUUID()}@example.com`;
  const requested = await directory().requestOtp(email);
  if (requested.kind !== "ok") throw new Error(`otp request failed: ${requested.kind}`);
  const verified = await directory().verifyOtp(requested.challengeId, requested.code);
  if (verified.kind !== "ok") throw new Error("otp verify failed");
  return { userId: verified.userId, tenantId: verified.tenantId, email };
}
