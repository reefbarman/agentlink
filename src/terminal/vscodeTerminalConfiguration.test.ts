import * as vscode from "vscode";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { resolveVscodeTerminalCreateRequest } from "./vscodeTerminalConfiguration.js";

function folder(name: string, fsPath: string, scheme = "file") {
  return {
    name,
    uri: { scheme, fsPath },
  } as vscode.WorkspaceFolder;
}

const request = {
  type: "host-terminal/create" as const,
  requestId: "request-1",
};

function setWorkspaceFolders(
  folders: readonly vscode.WorkspaceFolder[] | undefined,
): void {
  Object.defineProperty(vscode.workspace, "workspaceFolders", {
    configurable: true,
    value: folders,
  });
}

describe("resolveVscodeTerminalCreateRequest", () => {
  beforeEach(() => {
    setWorkspaceFolders(undefined);
    vi.restoreAllMocks();
  });

  it("preserves an explicit cwd without prompting", async () => {
    const showQuickPick = vi.spyOn(vscode.window, "showQuickPick");

    await expect(
      resolveVscodeTerminalCreateRequest({ ...request, cwd: "/explicit" }),
    ).resolves.toEqual({ ...request, cwd: "/explicit" });
    expect(showQuickPick).not.toHaveBeenCalled();
  });

  it("uses the only local workspace folder", async () => {
    setWorkspaceFolders([folder("Project", "/workspace/project")]);

    await expect(resolveVscodeTerminalCreateRequest(request)).resolves.toEqual({
      ...request,
      cwd: "/workspace/project",
    });
  });

  it("ignores non-file workspace folders", async () => {
    setWorkspaceFolders([
      folder("Remote", "/workspace/remote", "vscode-remote"),
    ]);

    await expect(resolveVscodeTerminalCreateRequest(request)).resolves.toBe(
      request,
    );
  });

  it("prompts for a local folder in a multi-root workspace", async () => {
    const first = folder("Project A", "/workspace/a");
    const second = folder("Project B", "/workspace/b");
    setWorkspaceFolders([first, second]);
    vi.spyOn(vscode.window, "showQuickPick").mockResolvedValue({
      label: second.name,
      description: second.uri.fsPath,
      folder: second,
    } as never);

    await expect(resolveVscodeTerminalCreateRequest(request)).resolves.toEqual({
      ...request,
      cwd: "/workspace/b",
    });
    expect(vscode.window.showQuickPick).toHaveBeenCalledWith(
      [
        { label: first.name, description: first.uri.fsPath, folder: first },
        { label: second.name, description: second.uri.fsPath, folder: second },
      ],
      {
        placeHolder: "Select the workspace folder for the new terminal",
        title: "New AgentLink Terminal",
      },
    );
  });

  it("cancels creation when the multi-root picker is dismissed", async () => {
    setWorkspaceFolders([
      folder("Project A", "/workspace/a"),
      folder("Project B", "/workspace/b"),
    ]);
    vi.spyOn(vscode.window, "showQuickPick").mockResolvedValue(undefined);

    await expect(
      resolveVscodeTerminalCreateRequest(request),
    ).resolves.toBeUndefined();
  });
});
