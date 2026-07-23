import * as vscode from "vscode";

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  readVscodeTerminalSurfaceConfiguration,
  resolveVscodeTerminalCreateRequest,
  resolveVscodeTerminalFontFamily,
} from "./vscodeTerminalConfiguration.js";

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

describe("resolveVscodeTerminalFontFamily", () => {
  it("matches the VS Code terminal fallback stack on macOS", () => {
    expect(resolveVscodeTerminalFontFamily("Cascadia Mono", "darwin")).toBe(
      "Cascadia Mono, monospace, AppleBraille",
    );
  });

  it("uses the monospace fallback stack on other platforms", () => {
    expect(resolveVscodeTerminalFontFamily("Cascadia Mono", "linux")).toBe(
      "Cascadia Mono, monospace",
    );
  });
});

describe("readVscodeTerminalSurfaceConfiguration", () => {
  it.each([
    ["auto", "auto"],
    ["always", "always"],
    ["never", "never"],
    [true, "auto"],
    [false, "never"],
    ["invalid", "auto"],
  ] as const)(
    "normalizes the VS Code multiline paste warning value %s",
    (configured, expected) => {
      vi.spyOn(vscode.workspace, "getConfiguration").mockImplementation(
        (section) =>
          ({
            get: (key: string, defaultValue?: unknown) => {
              if (
                section === "terminal.integrated" &&
                key === "enableMultiLinePasteWarning"
              ) {
                return configured;
              }
              return defaultValue;
            },
          }) as vscode.WorkspaceConfiguration,
      );

      expect(readVscodeTerminalSurfaceConfiguration()).toMatchObject({
        multiLinePasteWarning: expected,
      });
    },
  );

  it("uses the configured terminal font family with VS Code fallbacks", () => {
    vi.spyOn(vscode.workspace, "getConfiguration").mockImplementation(
      (section) =>
        ({
          get: (key: string, defaultValue?: unknown) => {
            if (section === "terminal.integrated" && key === "fontFamily") {
              return "Terminal Mono";
            }
            if (section === "terminal.integrated" && key === "scrollback") {
              return 1000;
            }
            if (section === "editor" && key === "fontFamily") {
              return "Editor Mono";
            }
            return defaultValue;
          },
        }) as vscode.WorkspaceConfiguration,
    );

    expect(readVscodeTerminalSurfaceConfiguration()).toMatchObject({
      fontFamily:
        process.platform === "darwin"
          ? "Terminal Mono, monospace, AppleBraille"
          : "Terminal Mono, monospace",
      scrollback: 1000,
    });
  });

  it("falls back to monospace when terminal and editor font families are blank", () => {
    vi.spyOn(vscode.workspace, "getConfiguration").mockImplementation(
      (section) =>
        ({
          get: (key: string, defaultValue?: unknown) => {
            if (
              (section === "terminal.integrated" || section === "editor") &&
              key === "fontFamily"
            ) {
              return " ";
            }
            if (section === "terminal.integrated" && key === "scrollback") {
              return 1000;
            }
            return defaultValue;
          },
        }) as vscode.WorkspaceConfiguration,
    );

    expect(readVscodeTerminalSurfaceConfiguration()).toMatchObject({
      fontFamily:
        process.platform === "darwin"
          ? "monospace, monospace, AppleBraille"
          : "monospace, monospace",
      scrollback: 1000,
    });
  });

  it("falls back to the editor font family like the VS Code terminal", () => {
    vi.spyOn(vscode.workspace, "getConfiguration").mockImplementation(
      (section) =>
        ({
          get: (key: string, defaultValue?: unknown) => {
            if (section === "terminal.integrated" && key === "fontFamily") {
              return " ";
            }
            if (section === "terminal.integrated" && key === "scrollback") {
              return 1000;
            }
            if (section === "editor" && key === "fontFamily") {
              return "Editor Mono";
            }
            return defaultValue;
          },
        }) as vscode.WorkspaceConfiguration,
    );

    expect(readVscodeTerminalSurfaceConfiguration()).toMatchObject({
      fontFamily:
        process.platform === "darwin"
          ? "Editor Mono, monospace, AppleBraille"
          : "Editor Mono, monospace",
      scrollback: 1000,
    });
  });
});
