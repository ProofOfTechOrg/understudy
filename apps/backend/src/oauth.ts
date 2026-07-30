/**
 * The OAuth 2.1 authorization server for /mcp (D1/D2). Deliberately NOT the
 * Worker's default export: src/index.ts delegates a closed pathname-prefix
 * list here, so every pre-existing route — /agents WebSocket upgrades
 * included — never traverses this third-party code, and a provider or
 * OAUTH_KV fault cannot reach /v1.
 *
 * The provider owns /oauth/token, /oauth/register (RFC 7591 DCR — required
 * by claude.ai and ChatGPT connectors), and the RFC 8414 / RFC 9728
 * well-known metadata. /oauth/authorize is ours: it reaches dashboardApp
 * (defaultHandler) which renders consent and calls completeAuthorization.
 */

import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { CANONICAL_ORIGIN, MCP_URL } from "./canonical";
import { dashboardApp } from "./dashboard/app";
import { guardedMcpHandler } from "./mcp/handler";
import type { Env } from "./types";

export const oauthProvider = new OAuthProvider<Env>({
  apiRoute: "/mcp",
  apiHandler: guardedMcpHandler,
  defaultHandler: {
    fetch: (request: Request, env: Env, ctx: ExecutionContext) =>
      dashboardApp.fetch(request, env, ctx),
  },
  authorizeEndpoint: "/oauth/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",
  scopesSupported: ["mcp"],
  // OAuth 2.1: S256 only. The library default (true) exists for backward
  // compatibility with older deployments; a new MCP server has none.
  allowPlainPKCE: false,
  resourceMetadata: {
    resource: MCP_URL,
    authorization_servers: [CANONICAL_ORIGIN],
    resource_name: "understudy browser",
  },
});
