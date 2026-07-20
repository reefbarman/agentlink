import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

import type {
  InspectedConfiguration,
  VscodeTerminalConfigurationSnapshot,
} from "./vscodeTerminalProfileAdapter.js";
import type {
  TerminalSurfaceConfiguration,
  TerminalSurfaceRequest,
} from "./terminalSurfaceProtocol.js";

import type { HostShellProfileConfiguration } from "./shellProfileResolver.js";

function inspect<T>(
  configuration: vscode.WorkspaceConfiguration,
  key: string,
): InspectedConfiguration<T> {
  const inspected = configuration.inspect<T>(key);
  return {
    defaultValue: inspected?.defaultValue,
    globalValue: inspected?.globalValue,
    workspaceValue: inspected?.workspaceValue,
    workspaceFolderValue: inspected?.workspaceFolderValue,
  };
}

function localWorkspaceDirectories(): string[] {
  return (
    vscode.workspace.workspaceFolders
      ?.filter((folder) => folder.uri.scheme === "file")
      .map((folder) => folder.uri.fsPath) ?? []
  );
}

function activeLocalEditorDirectory(): string | undefined {
  const uri = vscode.window.activeTextEditor?.document.uri;
  return uri?.scheme === "file" ? path.dirname(uri.fsPath) : undefined;
}

function processEnvironment(): Record<string, string | undefined> {
  return { ...process.env };
}

export async function resolveVscodeTerminalCreateRequest(
  request: Extract<TerminalSurfaceRequest, { type: "host-terminal/create" }>,
): Promise<
  Extract<TerminalSurfaceRequest, { type: "host-terminal/create" }> | undefined
> {
  if (request.cwd) return request;
  const folders =
    vscode.workspace.workspaceFolders?.filter(
      (folder) => folder.uri.scheme === "file",
    ) ?? [];
  if (folders.length === 0) return request;
  if (folders.length === 1) {
    return { ...request, cwd: folders[0].uri.fsPath };
  }
  const selected = await vscode.window.showQuickPick(
    folders.map((folder) => ({
      label: folder.name,
      description: folder.uri.fsPath,
      folder,
    })),
    {
      placeHolder: "Select the workspace folder for the new terminal",
      title: "New AgentLink Terminal",
    },
  );
  return selected ? { ...request, cwd: selected.folder.uri.fsPath } : undefined;
}

export function readVscodeTerminalConfigurationSnapshot(
  options: {
    selectedProfileName?: string;
    requestedCwd?: string;
  } = {},
): VscodeTerminalConfigurationSnapshot {
  const terminal = vscode.workspace.getConfiguration("terminal.integrated");
  const homeDirectory = os.homedir();
  const requestedCwd = options.requestedCwd;
  const activeEditorDirectory =
    requestedCwd &&
    path.isAbsolute(requestedCwd) &&
    !requestedCwd.includes("\0")
      ? requestedCwd
      : activeLocalEditorDirectory();

  return {
    isWorkspaceTrusted: vscode.workspace.isTrusted,
    platform: process.platform,
    selectedProfileName: options.selectedProfileName,
    defaultProfile: inspect<string | null>(terminal, "defaultProfile.osx"),
    profiles: inspect<Record<string, HostShellProfileConfiguration | null>>(
      terminal,
      "profiles.osx",
    ),
    environment: inspect<Record<string, string | null>>(terminal, "env.osx"),
    fontFamily: inspect<string>(terminal, "fontFamily"),
    fontSize: inspect<number>(terminal, "fontSize"),
    lineHeight: inspect<number>(terminal, "lineHeight"),
    letterSpacing: inspect<number>(terminal, "letterSpacing"),
    cursorStyle: inspect<"block" | "line" | "underline">(
      terminal,
      "cursorStyle",
    ),
    cursorBlink: inspect<boolean>(terminal, "cursorBlinking"),
    scrollback: inspect<number>(terminal, "scrollback"),
    baseEnvironment: processEnvironment(),
    fallbackShellPath: vscode.env.shell || process.env.SHELL || "/bin/zsh",
    fallbackShellArgs: [],
    activeEditorDirectory,
    workspaceDirectories: localWorkspaceDirectories(),
    homeDirectory,
  };
}

export function readVscodeTerminalSurfaceConfiguration(): TerminalSurfaceConfiguration {
  const terminal = vscode.workspace.getConfiguration("terminal.integrated");
  const select = <T>(key: string): T | undefined => terminal.get<T>(key);
  const fontSize = select<number>("fontSize");
  const lineHeight = select<number>("lineHeight");
  const letterSpacing = select<number>("letterSpacing");
  const scrollback = select<number>("scrollback");
  return {
    ...(select<string>("fontFamily")?.trim()
      ? { fontFamily: select<string>("fontFamily")!.trim() }
      : {}),
    ...(fontSize !== undefined && Number.isFinite(fontSize) && fontSize > 0
      ? { fontSize }
      : {}),
    ...(lineHeight !== undefined &&
    Number.isFinite(lineHeight) &&
    lineHeight > 0
      ? { lineHeight }
      : {}),
    ...(letterSpacing !== undefined &&
    Number.isFinite(letterSpacing) &&
    letterSpacing >= 0
      ? { letterSpacing }
      : {}),
    ...(select<"block" | "line" | "underline">("cursorStyle")
      ? {
          cursorStyle: select<"block" | "line" | "underline">("cursorStyle"),
        }
      : {}),
    ...(select<boolean>("cursorBlinking") !== undefined
      ? { cursorBlink: select<boolean>("cursorBlinking") }
      : {}),
    screenReaderMode:
      vscode.workspace
        .getConfiguration("editor")
        .get<"auto" | "off" | "on">("accessibilitySupport", "auto") === "on",
    scrollback:
      scrollback !== undefined && Number.isFinite(scrollback) && scrollback > 0
        ? Math.floor(scrollback)
        : 1000,
  };
}
