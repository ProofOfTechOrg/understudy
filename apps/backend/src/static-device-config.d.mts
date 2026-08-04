export interface StaticDeviceConfig {
  tenantId: string;
  deviceId: string;
  credentialVersion: number;
  allowedOrigins: string[];
  policyVersion: number;
}

export function parseStaticDeviceTokens(
  value: unknown,
): Record<string, StaticDeviceConfig>;
