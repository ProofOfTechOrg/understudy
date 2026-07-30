/**
 * UnderstudyMcp — one Durable Object per MCP connection (the streamable-HTTP
 * transport names instances by MCP session id). Deliberately stateless
 * beyond the transport: the browser-session binding lives in AccountAgent,
 * keyed by tenant, because this instance dies with the client connection and
 * the binding must not.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import type { Env } from "../types";
import type { UnderstudyMcpProps } from "./props";
import { registerTools, SERVER_INSTRUCTIONS } from "./tools";

export class UnderstudyMcp extends McpAgent<Env, unknown, UnderstudyMcpProps> {
  server = new McpServer(
    { name: "understudy", version: "0.1.0" },
    { instructions: SERVER_INSTRUCTIONS },
  );

  async init(): Promise<void> {
    // Props can be updated between calls (client reconnects re-run auth), so
    // the host exposes a live view rather than a snapshot. env is protected
    // on the Agent base class; this adapter is the public seam tools use.
    const agent = this;
    registerTools(this.server, {
      env: this.env,
      get props() {
        return agent.props;
      },
    });
  }
}
