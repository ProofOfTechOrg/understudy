/**
 * The one props shape both MCP auth branches converge on. The OAuth grant
 * stores it at consent time (dashboard completeAuthorization) and the static
 * usk_ branch builds it per request; everything downstream — rate limiting,
 * AccountAgent scoping, telemetry pseudonyms — reads only this.
 */

export type UnderstudyMcpProps = {
  userId: string;
  /** Drives mintSessionId/scopeSession exactly like a /v1 Actor.tenantId. */
  tenantId: string;
  /** "oauth:<clientId>" | "usk:<tokenId>" — feeds telemetryPseudonym, never logged raw. */
  actorId: string;
  authMethod: "oauth" | "static";
  scopes: string[];
  deviceId: string;
  authEpoch: number;
  contractVersion: number;
};

export function isUnderstudyMcpProps(value: unknown): value is UnderstudyMcpProps {
  if (typeof value !== "object" || value === null) return false;
  const props = value as Partial<UnderstudyMcpProps>;
  return (
    typeof props.userId === "string" &&
    props.userId.length > 0 &&
    typeof props.tenantId === "string" &&
    props.tenantId.length > 0 &&
    typeof props.actorId === "string" &&
    props.actorId.length > 0 &&
    (props.authMethod === "oauth" || props.authMethod === "static") &&
    Array.isArray(props.scopes) &&
    typeof props.deviceId === "string" &&
    props.deviceId.length > 0 &&
    Number.isInteger(props.authEpoch) &&
    Number.isInteger(props.contractVersion)
  );
}

/**
 * The 401 both auth paths must emit for a present-but-invalid credential:
 * the resource_metadata pointer is what lets an OAuth-capable client
 * discover the authorization server and bootstrap itself (RFC 9728), so the
 * static branch mirrors the provider's discovery-grade shape instead of
 * inventing its own.
 */
export function mcpUnauthorized(origin: string): Response {
  return new Response(JSON.stringify({ error: "invalid_token" }), {
    status: 401,
    headers: {
      "content-type": "application/json",
      "www-authenticate":
        `Bearer realm="OAuth", error="invalid_token", ` +
        `resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
    },
  });
}
