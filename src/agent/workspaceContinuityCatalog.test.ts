import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, describe, expect, it } from "vitest";

import { WorkspaceContinuityCatalog } from "./workspaceContinuityCatalog.js";

const directories: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "agentlink-continuity-catalog-"),
  );
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("WorkspaceContinuityCatalog", () => {
  it("persists entries and returns only workspace-expansion candidates", () => {
    const storage = temporaryDirectory();
    const catalog = new WorkspaceContinuityCatalog(storage);
    catalog.remember({
      workspaceIdentity: "single",
      workspaceFolderUris: ["file:///workspace/app"],
      historyDirectory: "/history/single",
      anchorRootPath: "/workspace/app",
      updatedAt: 1,
    });
    catalog.remember({
      workspaceIdentity: "unrelated",
      workspaceFolderUris: ["file:///workspace/other"],
      historyDirectory: "/history/unrelated",
      anchorRootPath: "/workspace/other",
      updatedAt: 2,
    });

    const reopened = new WorkspaceContinuityCatalog(storage);
    expect(
      reopened.findMigrationCandidates({
        workspaceIdentity: "expanded",
        workspaceFolderUris: [
          "file:///workspace/app",
          "file:///workspace/docs",
        ],
      }),
    ).toEqual([expect.objectContaining({ workspaceIdentity: "single" })]);
    expect(
      reopened.findMigrationCandidates({
        workspaceIdentity: "untitled-expanded",
        workspaceFileUri: "untitled:workspace-configuration",
        workspaceFolderUris: [
          "file:///workspace/app",
          "file:///workspace/docs",
        ],
      }),
    ).toEqual([expect.objectContaining({ workspaceIdentity: "single" })]);
    expect(
      reopened.findMigrationCandidates({
        workspaceIdentity: "single-again",
        workspaceFolderUris: ["file:///workspace/app"],
      }),
    ).toEqual([]);
    expect(
      reopened.findMigrationCandidates({
        workspaceIdentity: "other-workspace-file",
        workspaceFileUri: "file:///workspace/other.code-workspace",
        workspaceFolderUris: [
          "file:///workspace/app",
          "file:///workspace/docs",
        ],
      }),
    ).toEqual([]);
  });

  it("returns untitled workspaces with the same folders as saved-workspace candidates", () => {
    const storage = temporaryDirectory();
    const catalog = new WorkspaceContinuityCatalog(storage);
    const folders = ["file:///workspace/api", "file:///workspace/app"];
    catalog.remember({
      workspaceIdentity: "untitled",
      workspaceFileUri: "untitled://Untitled-1/workspace.json",
      workspaceFolderUris: folders,
      historyDirectory: "/history/untitled",
      anchorRootPath: "/workspace/api",
      updatedAt: 1,
    });
    catalog.remember({
      workspaceIdentity: "untitled-other-folders",
      workspaceFileUri: "untitled://Untitled-2/workspace.json",
      workspaceFolderUris: ["file:///workspace/api", "file:///workspace/docs"],
      historyDirectory: "/history/untitled-other",
      anchorRootPath: "/workspace/api",
      updatedAt: 2,
    });

    const reopened = new WorkspaceContinuityCatalog(storage);
    expect(
      reopened.findMigrationCandidates({
        workspaceIdentity: "saved",
        workspaceFileUri: "file:///workspace/app.code-workspace",
        workspaceFolderUris: folders,
      }),
    ).toEqual([expect.objectContaining({ workspaceIdentity: "untitled" })]);
    expect(
      reopened.findMigrationCandidates({
        workspaceIdentity: "untitled-again",
        workspaceFileUri: "untitled://Untitled-3/workspace.json",
        workspaceFolderUris: folders,
      }),
    ).toEqual([]);
  });

  it("replaces stale observations for the same workspace identity", () => {
    const catalog = new WorkspaceContinuityCatalog(temporaryDirectory());
    catalog.remember({
      workspaceIdentity: "workspace",
      workspaceFolderUris: ["file:///workspace/app"],
      historyDirectory: "/history/old",
      anchorRootPath: "/workspace/app",
      updatedAt: 1,
    });
    catalog.remember({
      workspaceIdentity: "workspace",
      workspaceFolderUris: ["file:///workspace/app"],
      historyDirectory: "/history/new",
      anchorRootPath: "/workspace/app",
      updatedAt: 2,
    });

    expect(catalog.list()).toEqual([
      expect.objectContaining({
        historyDirectory: "/history/new",
        updatedAt: 2,
      }),
    ]);
  });
});
