import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, describe, expect, it } from "vitest";
import {
  describeWorkspaceHistoryLocation,
  normalizeWorkspaceUri,
  resolveWorkspaceSessionLocation,
} from "./workspaceSessionIdentity.js";

const tempDirs: string[] = [];

function folder(
  fsPath: string,
  name = path.basename(fsPath),
  scheme = "file",
  authority = "",
) {
  return {
    name,
    uri: { scheme, authority, fsPath },
  };
}

function tempDir(name: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  tempDirs.push(root);
  return root;
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("resolveWorkspaceSessionLocation", () => {
  it("keeps single-folder workspaces on the legacy history layout", () => {
    const result = resolveWorkspaceSessionLocation({
      workspaceFolders: [folder("/workspace/app")],
      workspaceFile: undefined,
      fallbackCwd: "/fallback",
    });

    expect(result).toMatchObject({
      status: "ready",
      cwd: "/workspace/app",
      stateAnchor: {
        uri: "file:///workspace/app",
        rootPath: "/workspace/app",
      },
      stateAnchorSource: "single_folder",
      legacyPrimaryRootPath: "/workspace/app",
    });
    expect(result.historyNamespace).toBeUndefined();
    expect(result.historyDirectory).toBe("/workspace/app/.agentlink/history");
    expect(result.workspaceIdentity).toMatch(/^[a-f0-9]{64}$/);
    expect(result.workspaceFolderUris).toEqual(["file:///workspace/app"]);
    expect(describeWorkspaceHistoryLocation(result)).toMatchObject({
      status: "ready",
      directory: "/workspace/app/.agentlink/history",
      label: "Legacy single-folder history",
    });
  });

  it("uses an explicit unavailable state without a workspace folder", () => {
    const result = resolveWorkspaceSessionLocation({
      workspaceFolders: undefined,
      workspaceFile: undefined,
      fallbackCwd: "/fallback",
    });

    expect(result).toMatchObject({
      status: "unavailable",
      cwd: "/fallback",
    });
    expect(result.stateAnchor).toBeUndefined();
    expect(describeWorkspaceHistoryLocation(result)).toMatchObject({
      status: "unavailable",
      label: "Unavailable: no supported file-backed workspace location",
    });
  });

  it("namespaces multi-root workspaces by the stable folder set and anchors deterministically", () => {
    const first = resolveWorkspaceSessionLocation({
      workspaceFolders: [
        folder("/workspace/z-api"),
        folder("/workspace/a-web"),
      ],
      workspaceFile: undefined,
      fallbackCwd: "/fallback",
      historyNamespaceExists: () => false,
    });
    const reordered = resolveWorkspaceSessionLocation({
      workspaceFolders: [
        folder("/workspace/a-web"),
        folder("/workspace/z-api"),
      ],
      workspaceFile: undefined,
      fallbackCwd: "/fallback",
      historyNamespaceExists: () => false,
    });
    const changed = resolveWorkspaceSessionLocation({
      workspaceFolders: [folder("/workspace/z-api"), folder("/workspace/docs")],
      workspaceFile: undefined,
      fallbackCwd: "/fallback",
      historyNamespaceExists: () => false,
    });

    expect(first.cwd).toBe("/workspace/a-web");
    expect(first.legacyPrimaryRootPath).toBe("/workspace/z-api");
    expect(first.stateAnchorSource).toBe("deterministic");
    expect(first.historyNamespace).toMatch(/^workspace-[a-f0-9]{16}$/);
    expect(first.historyDirectory).toBe(
      `/workspace/a-web/.agentlink/history/${first.historyNamespace}`,
    );
    expect(reordered.workspaceIdentity).toBe(first.workspaceIdentity);
    expect(reordered.historyNamespace).toBe(first.historyNamespace);
    expect(reordered.stateAnchor).toEqual(first.stateAnchor);
    expect(changed.workspaceIdentity).not.toBe(first.workspaceIdentity);
    expect(changed.historyNamespace).not.toBe(first.historyNamespace);
    expect(first.workspaceFolderUris).toEqual([
      "file:///workspace/a-web",
      "file:///workspace/z-api",
    ]);
  });

  it("selects a valid v2 lineage over a legacy history location", () => {
    const root = tempDir("agentlink-v2-workspace");
    const workspaceIdentity = resolveWorkspaceSessionLocation({
      workspaceFolders: [folder(root)],
      workspaceFile: undefined,
      fallbackCwd: "/fallback",
    }).workspaceIdentity;
    const lineage = "l-imported";
    const lineageDirectory = path.join(
      root,
      ".agentlink",
      "workspaces",
      `ws-${workspaceIdentity.slice(0, 16)}`,
      lineage,
    );
    fs.mkdirSync(lineageDirectory, { recursive: true });
    fs.writeFileSync(
      path.join(path.dirname(lineageDirectory), "workspace.json"),
      JSON.stringify({
        version: 1,
        workspaceIdentity,
        activeLineage: lineage,
      }),
      "utf-8",
    );

    const result = resolveWorkspaceSessionLocation({
      workspaceFolders: [folder(root)],
      workspaceFile: undefined,
      fallbackCwd: "/fallback",
    });

    expect(result).toMatchObject({
      status: "ready",
      historyStorageKind: "lineage_v2",
      historyLineage: lineage,
      historyDirectory: lineageDirectory,
    });
    expect(describeWorkspaceHistoryLocation(result).label).toBe(
      `History lineage: ${lineage}`,
    );
  });

  it("finds a v2 lineage under a non-deterministic multi-root anchor", () => {
    const firstRoot = tempDir("agentlink-v2-first");
    const secondRoot = tempDir("agentlink-v2-second");
    const initial = resolveWorkspaceSessionLocation({
      workspaceFolders: [folder(firstRoot), folder(secondRoot)],
      workspaceFile: undefined,
      fallbackCwd: "/fallback",
      historyNamespaceExists: () => false,
    });
    const lineage = "l-imported";
    const lineageDirectory = path.join(
      secondRoot,
      ".agentlink",
      "workspaces",
      `ws-${initial.workspaceIdentity.slice(0, 16)}`,
      lineage,
    );
    fs.mkdirSync(lineageDirectory, { recursive: true });
    fs.writeFileSync(
      path.join(path.dirname(lineageDirectory), "workspace.json"),
      JSON.stringify({
        version: 1,
        workspaceIdentity: initial.workspaceIdentity,
        activeLineage: lineage,
      }),
      "utf-8",
    );

    const result = resolveWorkspaceSessionLocation({
      workspaceFolders: [folder(firstRoot), folder(secondRoot)],
      workspaceFile: undefined,
      fallbackCwd: "/fallback",
      historyNamespaceExists: () => false,
    });

    expect(result).toMatchObject({
      status: "ready",
      historyStorageKind: "lineage_v2",
      historyDirectory: lineageDirectory,
      stateAnchor: { rootPath: secondRoot },
      stateAnchorSource: "legacy_discovered",
    });
  });

  it("continues using exactly one discovered legacy namespace", () => {
    const firstRoot = tempDir("agentlink-state-first");
    const secondRoot = tempDir("agentlink-state-second");
    const rootsWithHistory = new Set([secondRoot]);

    const result = resolveWorkspaceSessionLocation({
      workspaceFolders: [folder(firstRoot), folder(secondRoot)],
      workspaceFile: undefined,
      fallbackCwd: "/fallback",
      historyNamespaceExists: (rootPath) => rootsWithHistory.has(rootPath),
    });

    expect(result).toMatchObject({
      status: "ready",
      cwd: secondRoot,
      stateAnchor: {
        uri: normalizeWorkspaceUri(folder(secondRoot).uri),
        rootPath: secondRoot,
      },
      stateAnchorSource: "legacy_discovered",
      legacyPrimaryRootPath: firstRoot,
    });
    expect(result.historyDirectory).toBe(
      path.join(secondRoot, ".agentlink", "history", result.historyNamespace!),
    );
  });

  it("reports a recoverable conflict when multiple legacy namespaces exist", () => {
    const firstRoot = tempDir("agentlink-state-first");
    const secondRoot = tempDir("agentlink-state-second");

    const result = resolveWorkspaceSessionLocation({
      workspaceFolders: [folder(firstRoot), folder(secondRoot)],
      workspaceFile: undefined,
      fallbackCwd: "/fallback",
      historyNamespaceExists: () => true,
    });

    expect(result.status).toBe("legacy_conflict");
    expect(result.conflictingLegacyRoots).toEqual(
      [firstRoot, secondRoot].sort(),
    );
    expect(result.stateAnchorSource).toBe("deterministic");
    expect(describeWorkspaceHistoryLocation(result)).toMatchObject({
      status: "legacy_conflict",
      label: "Unavailable: multiple legacy history locations conflict",
      conflictingLegacyRoots: [firstRoot, secondRoot].sort(),
    });
  });

  it("includes the workspace file in multi-root namespace identity", () => {
    const first = resolveWorkspaceSessionLocation({
      workspaceFolders: [folder("/workspace/api"), folder("/workspace/web")],
      workspaceFile: { scheme: "file", fsPath: "/workspace/a.code-workspace" },
      fallbackCwd: "/fallback",
      historyNamespaceExists: () => false,
    });
    const second = resolveWorkspaceSessionLocation({
      workspaceFolders: [folder("/workspace/api"), folder("/workspace/web")],
      workspaceFile: { scheme: "file", fsPath: "/workspace/b.code-workspace" },
      fallbackCwd: "/fallback",
      historyNamespaceExists: () => false,
    });

    expect(first.historyNamespace).toMatch(/^workspace-[a-f0-9]{16}$/);
    expect(second.historyNamespace).not.toBe(first.historyNamespace);
    expect(second.workspaceIdentity).not.toBe(first.workspaceIdentity);
  });

  it("distinguishes URI scheme and authority in the workspace identity", () => {
    const local = resolveWorkspaceSessionLocation({
      workspaceFolders: [folder("/workspace/api")],
      workspaceFile: undefined,
      fallbackCwd: "/fallback",
    });
    const remote = resolveWorkspaceSessionLocation({
      workspaceFolders: [
        folder("/workspace/api", "api", "vscode-remote", "ssh-remote+host"),
      ],
      workspaceFile: undefined,
      fallbackCwd: "/fallback",
    });

    expect(remote.status).toBe("unavailable");
    expect(remote.workspaceIdentity).not.toBe(local.workspaceIdentity);
  });
});
