import type {
  SessionProjectResolution,
  SessionProjectScope,
  WorkspaceProject,
} from "@agentlink/protocol/workspace-project";

import { createHash } from "crypto";

export * from "@agentlink/protocol/workspace-project";

export interface ProjectScopeResolver {
  listProjects(): readonly WorkspaceProject[];
  resolveProjectForResource(resourceUri: string): WorkspaceProject | undefined;
  resolvePersistedScope(scope: SessionProjectScope): SessionProjectResolution;
}

/** Derives a stable opaque ID from an already normalized full project URI. */
export function createWorkspaceProjectId(
  normalizedWorkspaceFolderUri: string,
): string {
  const hash = createHash("sha256")
    .update(normalizedWorkspaceFolderUri)
    .digest("hex")
    .slice(0, 16);
  return `project-${hash}`;
}
