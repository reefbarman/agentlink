import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";

import {
  HOST_TERMINAL_TASKS_RELATIVE_PATH,
  MAX_HOST_TERMINAL_TASKS_FILE_BYTES,
} from "./hostTerminalTasks.js";

export interface VscodeTasksFileAdapter {
  resolveProjectRoot(activeTerminalCwd?: string): Promise<string | undefined>;
  read(projectRoot: string): Promise<string | undefined>;
  open(projectRoot: string, template: string): Promise<void>;
}

function localWorkspaceFolders(): readonly vscode.WorkspaceFolder[] {
  return (vscode.workspace.workspaceFolders ?? []).filter(
    ({ uri }) => uri.scheme === "file",
  );
}

export function createVscodeTasksFileAdapter(): VscodeTasksFileAdapter {
  return {
    async resolveProjectRoot(activeTerminalCwd) {
      const folders = localWorkspaceFolders();
      if (activeTerminalCwd) {
        const owner = vscode.workspace.getWorkspaceFolder(
          vscode.Uri.file(activeTerminalCwd),
        );
        if (owner?.uri.scheme === "file") return owner.uri.fsPath;
      }
      if (folders.length === 1) return folders[0]?.uri.fsPath;
      if (folders.length === 0) return undefined;
      return (await vscode.window.showWorkspaceFolderPick())?.uri.fsPath;
    },

    async read(projectRoot) {
      const taskPath = path.join(
        projectRoot,
        HOST_TERMINAL_TASKS_RELATIVE_PATH,
      );
      try {
        const handle = await fs.open(taskPath, "r");
        try {
          const stat = await handle.stat();
          if (stat.size > MAX_HOST_TERMINAL_TASKS_FILE_BYTES) {
            throw new Error("tasks.json exceeds the 256 KB limit");
          }
          return await handle.readFile("utf8");
        } finally {
          await handle.close();
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          return undefined;
        throw error;
      }
    },

    async open(projectRoot, template) {
      const taskPath = path.join(
        projectRoot,
        HOST_TERMINAL_TASKS_RELATIVE_PATH,
      );
      await fs.mkdir(path.dirname(taskPath), { recursive: true });
      try {
        await fs.writeFile(taskPath, template, { flag: "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const document = await vscode.workspace.openTextDocument(taskPath);
      await vscode.window.showTextDocument(document);
    },
  };
}
