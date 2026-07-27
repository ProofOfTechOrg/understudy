export interface QuotaPolicy {
  sessionCreatesPerActorMinute: number;
  commandsPerSessionMinute: number;
  commandsPerTenantMinute: number;
  credentialFillsPerActorMinute: number;
  deviceTicketsPerDeviceMinute: number;
  sessionCommandCap: number;
}

export const DEFAULT_QUOTA_POLICY: QuotaPolicy = {
  sessionCreatesPerActorMinute: 10,
  commandsPerSessionMinute: 120,
  commandsPerTenantMinute: 600,
  credentialFillsPerActorMinute: 30,
  deviceTicketsPerDeviceMinute: 30,
  sessionCommandCap: 10_000,
};

export function parseQuotaPolicy(raw: string): QuotaPolicy {
  if (!raw) return DEFAULT_QUOTA_POLICY;
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("invalid QUOTA_POLICY");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid QUOTA_POLICY");
  }
  const input = value as Record<string, unknown>;
  const expected = Object.keys(DEFAULT_QUOTA_POLICY);
  if (Object.keys(input).some((key) => !expected.includes(key))) {
    throw new Error("invalid QUOTA_POLICY");
  }
  const output = { ...DEFAULT_QUOTA_POLICY };
  for (const key of expected as Array<keyof QuotaPolicy>) {
    const candidate = input[key];
    if (candidate === undefined) continue;
    if (typeof candidate !== "number" || !Number.isInteger(candidate) || candidate < 1) {
      throw new Error("invalid QUOTA_POLICY");
    }
    output[key] = candidate;
  }
  return output;
}
