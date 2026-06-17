import { describe, expect, it } from "vitest";

import path from "path";
import { resolveWorkspaceSessionLocation } from "./workspaceSessionIdentity.js";

function folder(fsPath: string, name = path.basename(fsPath), scheme = "file") {
  return {
    name,
    uri: { scheme, fsPath },
  };
}

describe("resolveWorkspaceSessionLocation", () => {
  it("keeps single-folder workspaces on the legacy history layout", () => {
    const result = resolveWorkspaceSessionLocation({
      workspaceFolders: [folder("/workspace/app")],
      workspaceFile: undefined,
      fallbackCwd: "/fallback",
    });

    expect(result).toEqual({ cwd: "/workspace/app" });
  });

  it("uses fallback cwd without a workspace folder", () => {
    const result = resolveWorkspaceSessionLocation({
      workspaceFolders: undefined,
      workspaceFile: undefined,
      fallbackCwd: "/fallback",
    });

    expect(result).toEqual({ cwd: "/fallback" });
  });

  it("namespaces multi-root workspaces by the full stable folder set", () => {
    const first = resolveWorkspaceSessionLocation({
      workspaceFolders: [folder("/workspace/api"), folder("/workspace/web")],
      workspaceFile: undefined,
      fallbackCwd: "/fallback",
    });
    const reordered = resolveWorkspaceSessionLocation({
      workspaceFolders: [folder("/workspace/web"), folder("/workspace/api")],
      workspaceFile: undefined,
      fallbackCwd: "/fallback",
    });
    const changed = resolveWorkspaceSessionLocation({
      workspaceFolders: [folder("/workspace/api"), folder("/workspace/docs")],
      workspaceFile: undefined,
      fallbackCwd: "/fallback",
    });

    expect(first.cwd).toBe("/workspace/api");
    expect(first.historyNamespace).toMatch(/^workspace-[a-f0-9]{16}$/);
    expect(reordered.historyNamespace).toBe(first.historyNamespace);
    expect(changed.historyNamespace).not.toBe(first.historyNamespace);
  });

  it("includes the workspace file in multi-root namespace identity", () => {
    const first = resolveWorkspaceSessionLocation({
      workspaceFolders: [folder("/workspace/api"), folder("/workspace/web")],
      workspaceFile: { scheme: "file", fsPath: "/workspace/a.code-workspace" },
      fallbackCwd: "/fallback",
    });
    const second = resolveWorkspaceSessionLocation({
      workspaceFolders: [folder("/workspace/api"), folder("/workspace/web")],
      workspaceFile: { scheme: "file", fsPath: "/workspace/b.code-workspace" },
      fallbackCwd: "/fallback",
    });

    expect(first.historyNamespace).toMatch(/^workspace-[a-f0-9]{16}$/);
    expect(second.historyNamespace).not.toBe(first.historyNamespace);
  });
});
