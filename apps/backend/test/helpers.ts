/**
 * Shared Workers-runtime test helpers for service.test.ts and
 * session.test.ts. Unlike tokens.ts, this file imports cloudflare:workers/
 * agents and so only loads inside the pool (never from vitest.config.ts).
 */

import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import type { SessionAgent } from "../src/session";

export const BASE = "https://understudy.example";

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
