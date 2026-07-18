import * as path from "path";

import {
  createSessionProjectScope,
  createWorkspaceProjectId,
  type NewSessionProjectSelectionInput,
  type NewSessionProjectSelectionResult,
  type NewSessionProjectSelectionSource,
  type ProjectScopeResolver,
  type SessionProjectResolution,
  type SessionProjectScope,
  type WorkspaceProject,
  type WorkspaceProjectCatalogSnapshot,
} from "../../core/workspaceProjects.js";

export interface WorkspaceProjectUriInput {
  scheme: string;
  authority?: string;
  path: string;
  fsPath?: string;
  toString(): string;
}

export interface WorkspaceProjectFolderInput {
  name: string;
  uri: WorkspaceProjectUriInput;
}

export interface WorkspaceProjectCatalogOptions {
  workspaceFolders: readonly WorkspaceProjectFolderInput[] | undefined;
  /** Resolves symlinks/casing and verifies that a file root is available. */
  canonicalizeFileRoot?: (rootPath: string) => string | undefined;
  normalizeUri?: (uri: WorkspaceProjectUriInput) => string;
}

export interface WorkspaceProjectCatalog extends ProjectScopeResolver {
  readonly snapshot: WorkspaceProjectCatalogSnapshot;
}

interface CatalogProject extends WorkspaceProject {
  identityUri: WorkspaceProjectUriInput;
}

export function createWorkspaceProjectCatalog(
  options: WorkspaceProjectCatalogOptions,
): WorkspaceProjectCatalog {
  const folders = options.workspaceFolders ?? [];
  const normalizeUri = options.normalizeUri ?? normalizeWorkspaceProjectUri;
  const projects: CatalogProject[] = folders.map((folder) => {
    const uri = normalizeUri(folder.uri);
    const base = {
      id: createWorkspaceProjectId(uri),
      name: folder.name,
      uri,
      identityUri: folder.uri,
    };

    if (folder.uri.scheme.toLowerCase() !== "file") {
      return {
        ...base,
        availability: {
          status: "unsupported_scheme" as const,
          scheme: folder.uri.scheme,
          message: `Workspace folder scheme '${folder.uri.scheme}' does not support local execution.`,
        },
      };
    }

    const inputRoot = folder.uri.fsPath;
    const rootPath =
      inputRoot === undefined
        ? undefined
        : options.canonicalizeFileRoot
          ? options.canonicalizeFileRoot(inputRoot)
          : path.resolve(inputRoot);
    if (rootPath === undefined) {
      return {
        ...base,
        availability: {
          status: "unavailable" as const,
          reason: "root_unavailable" as const,
          message: "The workspace folder local root is unavailable.",
        },
      };
    }

    return {
      ...base,
      rootPath,
      availability: { status: "available" as const },
    };
  });

  const snapshot: WorkspaceProjectCatalogSnapshot = {
    state:
      projects.length === 0
        ? "no_workspace_folders"
        : projects.some(
              (project) => project.availability.status === "available",
            )
          ? "available"
          : "no_available_projects",
    projects,
  };

  function resolveProjectForResource(
    resourceUri: string,
  ): WorkspaceProject | undefined {
    let resource: URL;
    try {
      resource = new URL(resourceUri);
    } catch {
      return undefined;
    }

    let best: { project: CatalogProject; depth: number } | undefined;
    for (const project of projects) {
      const root = project.identityUri;
      if (
        resource.protocol.slice(0, -1).toLowerCase() !==
          root.scheme.toLowerCase() ||
        resource.host.toLowerCase() !== (root.authority ?? "").toLowerCase()
      ) {
        continue;
      }

      const rootPath = normalizeUriPath(root.path);
      const resourcePath = normalizeUriPath(decodeUriPath(resource.pathname));
      if (!uriPathContains(rootPath, resourcePath)) continue;

      const depth = rootPath.length;
      if (best === undefined || depth > best.depth) best = { project, depth };
    }
    return best?.project;
  }

  function resolvePersistedScope(
    scope: SessionProjectScope,
  ): SessionProjectResolution {
    const project = projects.find(
      (candidate) => candidate.uri === scope.workspaceFolderUri,
    );
    if (project === undefined) return { status: "missing", scope };
    if (project.id !== scope.projectId) {
      return { status: "invalid", scope, reason: "project_id_mismatch" };
    }
    if (project.availability.status !== "available") {
      return {
        status: "unavailable",
        project,
        scope,
        availability: project.availability,
      };
    }
    return {
      status: "available",
      project,
      scope: createSessionProjectScope(project),
    };
  }

  return {
    snapshot,
    listProjects: () => projects,
    resolveProjectForResource,
    resolvePersistedScope,
  };
}

export function selectNewSessionProject(
  catalog: ProjectScopeResolver,
  input: NewSessionProjectSelectionInput = {},
): NewSessionProjectSelectionResult {
  const projects = catalog.listProjects();
  if (projects.length === 0) {
    return { status: "unavailable", reason: "no_workspace_folders" };
  }

  if (input.explicitProjectId !== undefined) {
    const project = projects.find(({ id }) => id === input.explicitProjectId);
    if (project === undefined) {
      return {
        status: "unavailable",
        reason: "project_not_found",
        source: "explicit",
        requestedProjectId: input.explicitProjectId,
      };
    }
    return selectProject(project, "explicit");
  }

  const attachedProject = input.attachedResourceUri
    ? catalog.resolveProjectForResource(input.attachedResourceUri)
    : undefined;
  if (attachedProject !== undefined)
    return selectProject(attachedProject, "attached_resource");

  const activeProject = input.activeResourceUri
    ? catalog.resolveProjectForResource(input.activeResourceUri)
    : undefined;
  if (activeProject !== undefined)
    return selectProject(activeProject, "active_resource");

  if (input.browserPreferredProjectId !== undefined) {
    const project = projects.find(
      ({ id }) => id === input.browserPreferredProjectId,
    );
    if (project === undefined) {
      return {
        status: "unavailable",
        reason: "project_not_found",
        source: "browser_preference",
        requestedProjectId: input.browserPreferredProjectId,
      };
    }
    return selectProject(project, "browser_preference");
  }

  if (projects.length === 1) return selectProject(projects[0], "only_project");
  const fallbackProject = projects.find(
    (project) => project.availability.status === "available",
  );
  return selectProject(
    fallbackProject ?? projects[0],
    "compatibility_fallback",
  );
}

export function normalizeWorkspaceProjectUri(
  uri: WorkspaceProjectUriInput,
): string {
  const scheme = uri.scheme.toLowerCase();
  const authority = (uri.authority ?? "").toLowerCase();
  const normalizedPath = normalizeUriPath(uri.path);
  return `${scheme}://${authority}${encodeURI(normalizedPath).replace(/#/g, "%23").replace(/\?/g, "%3F")}`;
}

function selectProject(
  project: WorkspaceProject,
  source: NewSessionProjectSelectionSource,
): NewSessionProjectSelectionResult {
  if (project.availability.status !== "available") {
    return {
      status: "unavailable",
      reason: "project_unavailable",
      source,
      project,
    };
  }
  return {
    status: "selected",
    source,
    project,
    scope: createSessionProjectScope(project),
  };
}

function normalizeUriPath(uriPath: string): string {
  const normalized = path.posix.normalize(
    uriPath.startsWith("/") ? uriPath : `/${uriPath}`,
  );
  return normalized === "/" ? normalized : normalized.replace(/\/$/, "");
}

function decodeUriPath(uriPath: string): string {
  try {
    return decodeURIComponent(uriPath);
  } catch {
    return uriPath;
  }
}

function uriPathContains(rootPath: string, resourcePath: string): boolean {
  if (rootPath === "/") return resourcePath.startsWith("/");
  return resourcePath === rootPath || resourcePath.startsWith(`${rootPath}/`);
}
