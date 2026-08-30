import { describe, expect, expectTypeOf, it } from "vitest";

import {
  createProjectlessSessionScope,
  createSessionProjectScope,
  isProjectlessSessionScope,
  PROJECTLESS_SESSION_PROJECT_ID,
  PROJECTLESS_SESSION_URI,
  SESSION_PROJECT_SCOPE_SCHEMA_VERSION,
  type NewSessionProjectSelectionResult,
  type SessionProjectResolution,
  type WorkspaceProject,
  type WorkspaceProjectCatalogSnapshot,
} from "./workspaceProject.js";

describe("workspace project protocol", () => {
  it("creates a reserved rootless identity for projectless sessions", () => {
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
      id: "project-api",
      name: "api",
      uri: "git:///workspace/api",
      availability: {
        status: "unsupported_scheme",
        scheme: "git",
        message: "Unsupported",
      },
    };

    expect(createSessionProjectScope(project)).toEqual({
      schemaVersion: 1,
      kind: "project",
      projectId: "project-api",
      workspaceFolderUri: "git:///workspace/api",
      displayName: "api",
    });
  });

  it("copies an available canonical root into the scope snapshot", () => {
    const project: WorkspaceProject = {
      id: "project-api",
      name: "API",
      uri: "file:///workspace/api",
      rootPath: "/canonical/workspace/api",
      availability: { status: "available" },
    };

    expect(createSessionProjectScope(project)).toEqual({
      schemaVersion: 1,
      kind: "project",
      projectId: "project-api",
      workspaceFolderUri: "file:///workspace/api",
      displayName: "API",
      rootPath: "/canonical/workspace/api",
    });
  });

  it("keeps catalog, resolution, and selection result DTOs package-owned", () => {
    expectTypeOf<WorkspaceProjectCatalogSnapshot>().toMatchTypeOf<{
      state: "available" | "no_workspace_folders" | "no_available_projects";
      projects: readonly WorkspaceProject[];
    }>();
    expectTypeOf<SessionProjectResolution>().toBeObject();
    expectTypeOf<NewSessionProjectSelectionResult>().toBeObject();
  });
});
