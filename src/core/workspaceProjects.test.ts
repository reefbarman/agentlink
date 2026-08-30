import { describe, expect, expectTypeOf, it } from "vitest";

import {
  createProjectlessSessionScope,
  createSessionProjectScope,
  createWorkspaceProjectId,
  isProjectlessSessionScope,
  PROJECTLESS_SESSION_PROJECT_ID,
  PROJECTLESS_SESSION_URI,
  SESSION_PROJECT_SCOPE_SCHEMA_VERSION,
  type SessionProjectResolution,
  type SessionProjectScope,
  type WorkspaceProject,
  type WorkspaceProjectCatalogSnapshot,
} from "./workspaceProjects.js";

describe("workspace project values", () => {
  it("preserves package-owned DTOs through the core compatibility facade", () => {
    expectTypeOf<SessionProjectScope>().toEqualTypeOf<
      import("@agentlink/protocol/workspace-project").SessionProjectScope
    >();
    expectTypeOf<WorkspaceProject>().toEqualTypeOf<
      import("@agentlink/protocol/workspace-project").WorkspaceProject
    >();
    expectTypeOf<WorkspaceProjectCatalogSnapshot>().toEqualTypeOf<
      import("@agentlink/protocol/workspace-project").WorkspaceProjectCatalogSnapshot
    >();
    expectTypeOf<SessionProjectResolution>().toEqualTypeOf<
      import("@agentlink/protocol/workspace-project").SessionProjectResolution
    >();
  });

  it("derives stable opaque IDs from normalized full URIs", () => {
    const uri = "file:///workspace/api";

    expect(createWorkspaceProjectId(uri)).toBe(createWorkspaceProjectId(uri));
    expect(createWorkspaceProjectId(uri)).toMatch(/^project-[a-f0-9]{16}$/);
    expect(createWorkspaceProjectId("file://remote/workspace/api")).not.toBe(
      createWorkspaceProjectId(uri),
    );
    expect(createWorkspaceProjectId("vscode-remote:///workspace/api")).not.toBe(
      createWorkspaceProjectId(uri),
    );
  });

  it("creates a reserved rootless identity for non-persisted projectless sessions", () => {
    const scope = createProjectlessSessionScope();

    expect(scope).toEqual({
      schemaVersion: SESSION_PROJECT_SCOPE_SCHEMA_VERSION,
      kind: "project",
      projectId: PROJECTLESS_SESSION_PROJECT_ID,
      workspaceFolderUri: PROJECTLESS_SESSION_URI,
      displayName: "No folder",
    });
    expect(isProjectlessSessionScope(scope)).toBe(true);
    expect(
      isProjectlessSessionScope({
        ...scope,
        workspaceFolderUri: "file:///workspace/projectless",
      }),
    ).toBe(false);
  });

  it("creates a serializable scope without inventing an unavailable root", () => {
    const project: WorkspaceProject = {
      id: createWorkspaceProjectId("git:///workspace/api"),
      name: "api",
      uri: "git:///workspace/api",
      availability: {
        status: "unsupported_scheme",
        scheme: "git",
        message: "Unsupported",
      },
    };

    expect(createSessionProjectScope(project)).toEqual({
      schemaVersion: SESSION_PROJECT_SCOPE_SCHEMA_VERSION,
      kind: "project",
      projectId: project.id,
      workspaceFolderUri: project.uri,
      displayName: "api",
    });
  });

  it("copies an available canonical root into the scope snapshot", () => {
    const project: WorkspaceProject = {
      id: createWorkspaceProjectId("file:///workspace/api"),
      name: "API",
      uri: "file:///workspace/api",
      rootPath: "/canonical/workspace/api",
      availability: { status: "available" },
    };

    expect(createSessionProjectScope(project)).toEqual({
      schemaVersion: 1,
      kind: "project",
      projectId: project.id,
      workspaceFolderUri: project.uri,
      displayName: "API",
      rootPath: "/canonical/workspace/api",
    });
  });
});
