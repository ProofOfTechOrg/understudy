export interface WorkerVersion {
  id: string;
  annotations?: Record<string, string>;
}

export function newSecretVersion(
  before: WorkerVersion[],
  after: WorkerVersion[],
): WorkerVersion;
