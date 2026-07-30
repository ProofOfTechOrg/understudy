/**
 * The authenticated MCP entry: both auth branches (OAuth grant props via the
 * provider, static usk_ props via static-auth.ts) land here with ctx.props
 * populated, so post-auth rate limiting covers them identically before the
 * transport hands off to the per-connection UnderstudyMcp DO.
 */

import { authenticatedRateAllowed } from "../auth";
import type { Env } from "../types";
import { UnderstudyMcp } from "./mcp-agent";
import { isUnderstudyMcpProps, mcpUnauthorized } from "./props";

const streamableHandler = UnderstudyMcp.serve("/mcp", { binding: "MCP_AGENT" });

export const guardedMcpHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const props = (ctx as { props?: unknown }).props;
    if (!isUnderstudyMcpProps(props)) {
      return mcpUnauthorized(new URL(request.url).origin);
    }
    if (
      !(await authenticatedRateAllowed(
        { kind: "caller", tenantId: props.tenantId, actor: props.actorId },
        env,
      ))
    ) {
      return Response.json({ error: "rate_limited" }, { status: 429 });
    }
    return streamableHandler.fetch(request, env, ctx);
  },
};
