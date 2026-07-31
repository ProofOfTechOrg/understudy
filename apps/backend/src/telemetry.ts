import { telemetryPseudonym } from "./auth";
import type { Env } from "./types";

export type TelemetryEvent =
  | "authentication"
  | "session_create"
  | "session_replay"
  | "session_close"
  | "session_expiry"
  | "device_connect"
  | "device_offline"
  // Owner-initiated revocation as an operation, distinct from device_offline,
  // which means "a device stopped serving". A failed or refused revoke leaves
  // the device online, so counting it as offline would corrupt offline rates.
  | "device_revoke"
  | "device_epoch_change"
  | "reservation"
  | "release"
  | "capacity"
  | "provisioning"
  | "recovery"
  | "command"
  | "command_prepare"
  | "command_grant"
  | "command_pending"
  | "command_unknown"
  | "dialog"
  | "quota";

export interface TelemetryInput {
  event: TelemetryEvent;
  outcome: string;
  tenantId?: string;
  actor?: string;
  deviceId?: string;
  sessionId?: string;
  commandType?: string;
  durationMs?: number;
}

export async function emitTelemetry(env: Env, input: TelemetryInput): Promise<void> {
  const dimensions: Record<string, string | number> = {
    event: input.event,
    outcome: input.outcome.slice(0, 128),
  };
  const identifiers = [
    ["tenant", input.tenantId],
    ["actor", input.actor],
    ["device", input.deviceId],
    ["session", input.sessionId],
  ] as const;
  for (const [domain, value] of identifiers) {
    if (value !== undefined) {
      dimensions[domain] = await telemetryPseudonym(domain, value, env);
    }
  }
  if (input.commandType !== undefined) dimensions.commandType = input.commandType.slice(0, 64);
  if (input.durationMs !== undefined) dimensions.durationMs = Math.max(0, input.durationMs);

  console.log(JSON.stringify({ telemetry: dimensions }));
  env.ANALYTICS?.writeDataPoint({
    blobs: [
      String(dimensions.event),
      String(dimensions.outcome),
      String(dimensions.tenant ?? ""),
      String(dimensions.actor ?? ""),
      String(dimensions.device ?? ""),
      String(dimensions.session ?? ""),
      String(dimensions.commandType ?? ""),
    ],
    doubles: [typeof dimensions.durationMs === "number" ? dimensions.durationMs : 0],
    indexes: [String(dimensions.tenant ?? "anonymous")],
  });
}
