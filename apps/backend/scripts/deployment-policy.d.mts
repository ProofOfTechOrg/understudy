export interface DeploymentContextInput {
  mode: string;
  fullSha: string;
  dirty: boolean;
  fingerprint: string;
  githubActions: boolean;
  githubRef?: string;
  githubSha?: string;
  productionEnabled: boolean;
}

export interface DeploymentContext {
  branch: "dev" | "master" | null;
  sourceTag: string;
  target: "production" | "staging";
}

export function deploymentContext(input: DeploymentContextInput): DeploymentContext;
export function assertCurrentBranchHead(
  branch: string,
  sourceSha: string,
  remoteSha: string,
): void;
export function assertSourceSnapshot(
  initialSha: string,
  currentSha: string,
  initialFingerprint: string,
  currentFingerprint: string,
): void;
