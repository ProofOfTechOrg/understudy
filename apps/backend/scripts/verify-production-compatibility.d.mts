export interface ProductionCompatibilityMarker {
  schemaVersion: 1;
  contractVersion: 3;
  requiredSecrets: string[];
  files: Record<string, string>;
}

export function validateCompatibilityMarker(
  value: unknown,
): ProductionCompatibilityMarker;
export function verifyCurrentContract(
  repoRoot: string,
): Promise<ProductionCompatibilityMarker>;
export function validateHealthProvenance(value: unknown): string;
export function verifyLiveContract(
  repoRoot: string,
  healthUrl?: string,
): Promise<{
  activeCommit: string;
  candidateCommit: string;
  contractVersion: number;
}>;
