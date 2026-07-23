import { createHash } from "crypto";

export const SESSION_PROJECT_SCOPE_SCHEMA_VERSION = 1 as const;
export const PROJECTLESS_SESSION_PROJECT_ID = "projectless";
export const PROJECTLESS_SESSION_URI = "agentlink://projectless";

export type WorkspaceProjectAvailability =
  | { status: "available" }
  | {
      status: "unsupported_scheme";
      scheme: string;
      message: string;
    }
  | {
      status: "unavailable";
      reason: "root_unavailable";
      message: string;
    };

export interface WorkspaceProject {
  id: string;
  name: string;
  /** Canonical full workspace-folder URI used as the durable identity source. */
  uri: string;
  /** Present only for a currently available local execution root. */
  rootPath?: string;
  availability: WorkspaceProjectAvailability;
}

export interface SessionProjectScope {
  schemaVersion: typeof SESSION_PROJECT_SCOPE_SCHEMA_VERSION;
  kind: "project";
  projectId: string;
  workspaceFolderUri: string;
  displayName: string;
  /** A refreshable execution snapshot, not part of durable project identity. */
  rootPath?: string;
}

export type WorkspaceProjectCatalogState =
  | "available"
  | "no_workspace_folders"
  | "no_available_projects";

export interface WorkspaceProjectCatalogSnapshot {
  state: WorkspaceProjectCatalogState;
  projects: readonly WorkspaceProject[];
}

export type SessionProjectResolution =
  | {
      status: "available";
      project: WorkspaceProject;
      /** Scope refreshed from the current catalog name and canonical root. */
      scope: SessionProjectScope;
    }
  | {
      status: "missing";
      scope: SessionProjectScope;
    }
  | {
      status: "unavailable";
      project: WorkspaceProject;
      scope: SessionProjectScope;
      availability: Exclude<
        WorkspaceProjectAvailability,
        { status: "available" }
      >;
    }
  | {
      status: "invalid";
      scope: SessionProjectScope;
      reason: "project_id_mismatch";
    };

export type ProjectAccessClassification =
  | "project"
  | "cross_project"
  | "outside_workspace";

export interface ResolvedProjectResource {
  resourceUri: string;
  owningProjectId?: string;
  access: ProjectAccessClassification;
}

export interface ProjectScopeResolver {
  listProjects(): readonly WorkspaceProject[];
  resolveProjectForResource(resourceUri: string): WorkspaceProject | undefined;
  resolvePersistedScope(scope: SessionProjectScope): SessionProjectResolution;
}

export interface NewSessionProjectSelectionInput {
  explicitProjectId?: string;
  /** An explicitly attached resource takes precedence over ambient editor focus. */
  attachedResourceUri?: string;
  activeResourceUri?: string;
  browserPreferredProjectId?: string;
}

export type NewSessionProjectSelectionSource =
  | "explicit"
  | "attached_resource"
  | "active_resource"
  | "browser_preference"
  | "only_project"
  | "compatibility_fallback";

export type NewSessionProjectSelectionResult =
  | {
      status: "selected";
      source: NewSessionProjectSelectionSource;
      project: WorkspaceProject;
      scope: SessionProjectScope;
    }
  | {
      status: "unavailable";
      reason: "no_workspace_folders";
    }
  | {
      status: "unavailable";
      reason: "project_not_found";
      source: "explicit" | "browser_preference";
      requestedProjectId: string;
    }
  | {
      status: "unavailable";
      reason: "project_unavailable";
      source: NewSessionProjectSelectionSource;
      project: WorkspaceProject;
    };

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

export function createSessionProjectScope(
  project: WorkspaceProject,
): SessionProjectScope {
  return {
    schemaVersion: SESSION_PROJECT_SCOPE_SCHEMA_VERSION,
    kind: "project",
    projectId: project.id,
    workspaceFolderUri: project.uri,
    displayName: project.name,
    ...(project.rootPath === undefined ? {} : { rootPath: project.rootPath }),
  };
}

/** Non-persisted identity used by Ask sessions when no workspace folder is open. */
export function createProjectlessSessionScope(): SessionProjectScope {
  return {
    schemaVersion: SESSION_PROJECT_SCOPE_SCHEMA_VERSION,
    kind: "project",
    projectId: PROJECTLESS_SESSION_PROJECT_ID,
    workspaceFolderUri: PROJECTLESS_SESSION_URI,
    displayName: "No folder",
  };
}

export function isProjectlessSessionScope(
  scope: Readonly<SessionProjectScope>,
): boolean {
  return (
    scope.projectId === PROJECTLESS_SESSION_PROJECT_ID &&
    scope.workspaceFolderUri === PROJECTLESS_SESSION_URI &&
    scope.rootPath === undefined
  );
}
