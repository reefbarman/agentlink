export type ReleaseProduct = "vscode" | "desktop" | "cli";
export type ReleaseChannel = "stable" | "preview";

export interface ReleaseUpdateMetadata {
  schemaVersion: 1;
  product: ReleaseProduct;
  version: string;
  tag: string;
  channel: ReleaseChannel;
  targets: Record<string, string>;
  engines: { vscode?: string };
}

export interface ReleaseUpdateIdentity {
  product: ReleaseProduct;
  version: string;
  target: string;
  vscodeVersion?: string;
  hostLabel?: string;
  development: boolean;
}

export interface ReleaseUpdateCandidate {
  version: string;
  tag: string;
  channel: ReleaseChannel;
  target: string;
  releaseUrl: string;
  instructionsUrl: string;
}

export interface ReleaseUpdateState {
  identity: ReleaseUpdateIdentity;
  status:
    | "idle"
    | "checking"
    | "available"
    | "current"
    | "unavailable"
    | "rate_limited"
    | "unsupported"
    | "metadata_unavailable";
  automaticChecks: boolean;
  lastAttemptAt: number | null;
  checkedAt: number | null;
  retryAt: number | null;
  candidate: ReleaseUpdateCandidate | null;
  dismissedVersion: string | null;
  stale: boolean;
}

export interface HostReleaseUpdateStatus {
  hostId: string;
  generationId: string;
  state: ReleaseUpdateState;
  requestId?: string;
}

export const RELEASE_UPDATE_METADATA_NAME = "agentlink-update.json";
export const RELEASE_REPOSITORY_URL = "https://github.com/reefbarman/agentlink";

export function releaseInstructionsUrl(product: ReleaseProduct): string {
  return `${RELEASE_REPOSITORY_URL}/blob/main/resources/builtin-skills/documentation/references/${product === "cli" ? "standalone-cli" : "getting-started"}.md`;
}

export function hasVisibleReleaseUpdate(
  state: ReleaseUpdateState | null | undefined,
): boolean {
  return Boolean(
    state?.candidate && state.candidate.version !== state.dismissedVersion,
  );
}
