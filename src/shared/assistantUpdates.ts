/** Browser-visible Assistant deployment update state. No paths, tokens or command output. */
export type AssistantUpdatePhase =
  | "queued"
  | "downloading"
  | "validating"
  | "pulling"
  | "draining"
  | "backing_up"
  | "installing"
  | "checking_health"
  | "rolling_back"
  | "reconnecting"
  | "completed"
  | "failed"
  | "interrupted";

export interface AssistantUpdateOperation {
  id: string;
  kind: "update" | "rollback";
  fromVersion: string;
  targetVersion: string;
  phase: AssistantUpdatePhase;
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
  /** Bounded public code, never raw process output or secrets. */
  error?: string;
}

export interface AssistantRelease {
  version: string;
  tag: string;
  channel: "stable" | "preview";
  releaseUrl: string;
  notes: string;
}

export interface AssistantUpdateDiscovery {
  status:
    | "idle"
    | "checking"
    | "available"
    | "current"
    | "unavailable"
    | "rate_limited"
    | "unsupported";
  automaticChecks: boolean;
  includePreviews: boolean;
  checkedAt: number | null;
  lastAttemptAt: number | null;
  retryAt: number | null;
  stale: boolean;
  error?: string;
  releases: AssistantRelease[];
}

export interface AssistantUpdateStatus {
  configured: boolean;
  managed: boolean;
  installedVersion: string | null;
  installedCommit: string | null;
  updaterProtocol: 1;
  canRollback: boolean;
  rollbackVersion: string | null;
  discovery: AssistantUpdateDiscovery;
  operation: AssistantUpdateOperation | null;
  error?: string;
}

export const ASSISTANT_UPDATER_PROTOCOL = 1;
export const ASSISTANT_TERMINAL_UPDATE_PHASES: readonly AssistantUpdatePhase[] =
  ["completed", "failed", "interrupted"];
export function assistantUpdateIsActive(
  operation: AssistantUpdateOperation | null,
): boolean {
  return (
    operation !== null &&
    !ASSISTANT_TERMINAL_UPDATE_PHASES.includes(operation.phase)
  );
}
