import { describe, expect, it, vi } from "vitest";

import { createSessionProjectScope } from "../../core/workspaceProjects.js";
import {
  createWorkspaceProjectCatalog,
  normalizeWorkspaceProjectUri,
  selectNewSessionProject,
  type WorkspaceProjectFolderInput,
  type WorkspaceProjectUriInput,
} from "./workspaceProjectCapabilities.js";

function uri(
  value: string,
  options: { fsPath?: string; path?: string } = {},
): WorkspaceProjectUriInput {
  const parsed = new URL(value);
  return {
    scheme: parsed.protocol.slice(0, -1),
    authority: parsed.host,
    path: options.path ?? decodeURIComponent(parsed.pathname),
    ...(options.fsPath === undefined ? {} : { fsPath: options.fsPath }),
    toString: () => value,
  };
}

function folder(
  name: string,
  value: string,
  options: { fsPath?: string; path?: string } = {},
): WorkspaceProjectFolderInput {
  return { name, uri: uri(value, options) };
}

function catalog(folders: readonly WorkspaceProjectFolderInput[]) {
  return createWorkspaceProjectCatalog({
    workspaceFolders: folders,
    canonicalizeFileRoot: (root) => `/canonical${root}`,
  });
}

describe("workspace project catalog", () => {
  it("keeps identity stable across reorder and display-name changes", () => {
    const first = catalog([
      folder("API", "file:///workspace/api", { fsPath: "/workspace/api" }),
      folder("Web", "file:///workspace/web", { fsPath: "/workspace/web" }),
    ]);
    const reordered = catalog([
      folder("Renamed Web", "file:///workspace/web", {
        fsPath: "/workspace/web",
      }),
      folder("Renamed API", "file:///workspace/api", {
        fsPath: "/workspace/api",
      }),
    ]);

    expect(first.listProjects().map(({ name }) => name)).toEqual([
      "API",
      "Web",
    ]);
    expect(reordered.listProjects().map(({ name }) => name)).toEqual([
      "Renamed Web",
      "Renamed API",
    ]);
    expect(reordered.listProjects()[0].id).toBe(first.listProjects()[1].id);
    expect(reordered.listProjects()[1].id).toBe(first.listProjects()[0].id);
  });

  it("includes URI scheme and authority in identity", () => {
    const result = catalog([
      folder("local", "file:///workspace/api", { fsPath: "/workspace/api" }),
      folder("remote-a", "vscode-remote://host-a/workspace/api"),
      folder("remote-b", "vscode-remote://host-b/workspace/api"),
    ]);

    expect(new Set(result.listProjects().map(({ id }) => id))).toHaveLength(3);
    expect(result.listProjects().map(({ uri }) => uri)).toEqual([
      "file:///workspace/api",
      "vscode-remote://host-a/workspace/api",
      "vscode-remote://host-b/workspace/api",
    ]);
  });

  it("normalizes URI case, dot segments, trailing separators, and escaping", () => {
    expect(
      normalizeWorkspaceProjectUri(
        uri("VSCODE-REMOTE://HOST/ignored", {
          path: "/workspace/area/../api folder/",
        }),
      ),
    ).toBe("vscode-remote://host/workspace/api%20folder");
  });

  it("retains duplicate display names with distinct identities", () => {
    const result = catalog([
      folder("app", "file:///workspace/one", { fsPath: "/workspace/one" }),
      folder("app", "file:///workspace/two", { fsPath: "/workspace/two" }),
    ]);

    expect(result.listProjects().map(({ name }) => name)).toEqual([
      "app",
      "app",
    ]);
    expect(result.listProjects()[0].id).not.toBe(result.listProjects()[1].id);
  });

  it("canonicalizes available file roots and exposes unsupported schemes", () => {
    const canonicalizeFileRoot = vi.fn((root: string) => `/real${root}`);
    const result = createWorkspaceProjectCatalog({
      workspaceFolders: [
        folder("local", "file:///workspace/local", {
          fsPath: "/workspace/local",
        }),
        folder("remote", "vscode-remote://host/workspace/remote"),
      ],
      canonicalizeFileRoot,
    });

    expect(canonicalizeFileRoot).toHaveBeenCalledOnce();
    expect(result.snapshot.state).toBe("available");
    expect(result.listProjects()[0]).toMatchObject({
      rootPath: "/real/workspace/local",
      availability: { status: "available" },
    });
    expect(result.listProjects()[1]).toMatchObject({
      availability: {
        status: "unsupported_scheme",
        scheme: "vscode-remote",
      },
    });
    expect(result.listProjects()[1]).not.toHaveProperty("rootPath");
  });

  it("exposes unavailable file roots without synthesizing a path", () => {
    const result = createWorkspaceProjectCatalog({
      workspaceFolders: [
        folder("missing", "file:///workspace/missing", {
          fsPath: "/workspace/missing",
        }),
      ],
      canonicalizeFileRoot: () => undefined,
    });

    expect(result.snapshot.state).toBe("no_available_projects");
    expect(result.listProjects()[0]).toMatchObject({
      availability: { status: "unavailable", reason: "root_unavailable" },
    });
    expect(result.listProjects()[0]).not.toHaveProperty("rootPath");
  });

  it("resolves nested ownership by the longest matching folder URI", () => {
    const result = catalog([
      folder("repo", "file:///workspace/repo", { fsPath: "/workspace/repo" }),
      folder("package", "file:///workspace/repo/packages/api", {
        fsPath: "/workspace/repo/packages/api",
      }),
    ]);

    expect(
      result.resolveProjectForResource(
        "file:///workspace/repo/packages/api/src/index.ts",
      )?.name,
    ).toBe("package");
    expect(
      result.resolveProjectForResource("file:///workspace/repository/file.ts"),
    ).toBeUndefined();
  });

  it("requires resource scheme and authority to match ownership", () => {
    const result = catalog([
      folder("a", "vscode-remote://host-a/workspace/repo"),
      folder("b", "vscode-remote://host-b/workspace/repo"),
    ]);

    expect(
      result.resolveProjectForResource(
        "vscode-remote://host-b/workspace/repo/file.ts",
      )?.name,
    ).toBe("b");
    expect(
      result.resolveProjectForResource("file:///workspace/repo/file.ts"),
    ).toBeUndefined();
  });

  it("matches encoded resource paths against decoded workspace URI paths", () => {
    const result = catalog([
      folder("spaced", "file:///workspace/api%20service", {
        path: "/workspace/api service",
        fsPath: "/workspace/api service",
      }),
    ]);

    expect(
      result.resolveProjectForResource(
        "file:///workspace/api%20service/src/index.ts",
      )?.name,
    ).toBe("spaced");
  });

  it("restores persisted scope only by exact URI identity and refreshes snapshots", () => {
    const initial = catalog([
      folder("Old API", "file:///workspace/api", { fsPath: "/workspace/api" }),
    ]);
    const scope = createSessionProjectScope(initial.listProjects()[0]);
    const refreshed = createWorkspaceProjectCatalog({
      workspaceFolders: [
        folder("New API", "file:///workspace/api", {
          fsPath: "/workspace/api",
        }),
      ],
      canonicalizeFileRoot: () => "/new-real/api",
    });

    expect(refreshed.resolvePersistedScope(scope)).toMatchObject({
      status: "available",
      scope: { displayName: "New API", rootPath: "/new-real/api" },
    });

    const moved = catalog([
      folder("Old API", "file:///moved/api", { fsPath: "/moved/api" }),
    ]);
    expect(moved.resolvePersistedScope(scope)).toEqual({
      status: "missing",
      scope,
    });
  });

  it("reports unsupported persisted projects and rejects mismatched IDs", () => {
    const result = catalog([
      folder("remote", "vscode-remote://host/workspace/repo"),
    ]);
    const project = result.listProjects()[0];
    const scope = createSessionProjectScope(project);

    expect(result.resolvePersistedScope(scope)).toMatchObject({
      status: "unavailable",
      availability: { status: "unsupported_scheme" },
    });
    expect(
      result.resolvePersistedScope({ ...scope, projectId: "project-wrong" }),
    ).toEqual({
      status: "invalid",
      scope: { ...scope, projectId: "project-wrong" },
      reason: "project_id_mismatch",
    });
  });

  it("represents zero-folder windows explicitly", () => {
    const result = createWorkspaceProjectCatalog({
      workspaceFolders: undefined,
    });

    expect(result.snapshot).toEqual({
      state: "no_workspace_folders",
      projects: [],
    });
    expect(selectNewSessionProject(result)).toEqual({
      status: "unavailable",
      reason: "no_workspace_folders",
    });
  });
});

describe("new session project selection", () => {
  const result = catalog([
    folder("api", "file:///workspace/api", { fsPath: "/workspace/api" }),
    folder("web", "file:///workspace/web", { fsPath: "/workspace/web" }),
  ]);
  const [api, web] = result.listProjects();

  it("uses explicit selection before attached, active, and browser choices", () => {
    expect(
      selectNewSessionProject(result, {
        explicitProjectId: api.id,
        attachedResourceUri: "file:///workspace/web/attached.ts",
        activeResourceUri: "file:///workspace/web/active.ts",
        browserPreferredProjectId: web.id,
      }),
    ).toMatchObject({
      status: "selected",
      source: "explicit",
      project: { id: api.id },
    });
  });

  it("prefers attached resources over the active editor", () => {
    expect(
      selectNewSessionProject(result, {
        attachedResourceUri: "file:///workspace/web/attached.ts",
        activeResourceUri: "file:///workspace/api/active.ts",
      }),
    ).toMatchObject({
      status: "selected",
      source: "attached_resource",
      project: { id: web.id },
    });
  });

  it("uses active ownership before browser preference", () => {
    expect(
      selectNewSessionProject(result, {
        activeResourceUri: "file:///workspace/api/active.ts",
        browserPreferredProjectId: web.id,
      }),
    ).toMatchObject({
      status: "selected",
      source: "active_resource",
      project: { id: api.id },
    });
  });

  it("uses browser preference when resources have no owner", () => {
    expect(
      selectNewSessionProject(result, {
        activeResourceUri: "file:///outside/file.ts",
        browserPreferredProjectId: web.id,
      }),
    ).toMatchObject({
      status: "selected",
      source: "browser_preference",
      project: { id: web.id },
    });
  });

  it("selects the only folder then the first compatibility fallback", () => {
    const only = catalog([
      folder("api", "file:///workspace/api", { fsPath: "/workspace/api" }),
    ]);

    expect(selectNewSessionProject(only)).toMatchObject({
      status: "selected",
      source: "only_project",
    });
    expect(selectNewSessionProject(result)).toMatchObject({
      status: "selected",
      source: "compatibility_fallback",
      project: { id: api.id },
    });
  });

  it("surfaces stale authoritative IDs instead of falling through", () => {
    expect(
      selectNewSessionProject(result, { explicitProjectId: "missing" }),
    ).toEqual({
      status: "unavailable",
      reason: "project_not_found",
      source: "explicit",
      requestedProjectId: "missing",
    });
    expect(
      selectNewSessionProject(result, { browserPreferredProjectId: "missing" }),
    ).toEqual({
      status: "unavailable",
      reason: "project_not_found",
      source: "browser_preference",
      requestedProjectId: "missing",
    });
  });

  it("skips unavailable projects for the ambient compatibility fallback", () => {
    const mixed = catalog([
      folder("remote", "vscode-remote://host/workspace/remote"),
      folder("local", "file:///workspace/local", {
        fsPath: "/workspace/local",
      }),
    ]);

    expect(selectNewSessionProject(mixed)).toMatchObject({
      status: "selected",
      source: "compatibility_fallback",
      project: { name: "local" },
    });
  });

  it("surfaces an explicitly selected unsupported project", () => {
    const mixed = catalog([
      folder("remote", "vscode-remote://host/workspace/remote"),
      folder("local", "file:///workspace/local", {
        fsPath: "/workspace/local",
      }),
    ]);
    const remote = mixed.listProjects()[0];

    expect(
      selectNewSessionProject(mixed, { explicitProjectId: remote.id }),
    ).toMatchObject({
      status: "unavailable",
      reason: "project_unavailable",
      source: "explicit",
      project: { id: remote.id },
    });
  });

  it("does not silently retarget a resource owned by an unsupported project", () => {
    const mixed = catalog([
      folder("remote", "vscode-remote://host/workspace/remote"),
      folder("local", "file:///workspace/local", {
        fsPath: "/workspace/local",
      }),
    ]);

    expect(
      selectNewSessionProject(mixed, {
        activeResourceUri: "vscode-remote://host/workspace/remote/src/index.ts",
        browserPreferredProjectId: mixed.listProjects()[1].id,
      }),
    ).toMatchObject({
      status: "unavailable",
      reason: "project_unavailable",
      source: "active_resource",
      project: { id: mixed.listProjects()[0].id },
    });
  });
});
