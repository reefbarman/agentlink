import * as path from "path";

import { createHash } from "crypto";

export interface WorkspaceSessionIdentityFolder {
  name?: string;
  uri: {
    scheme?: string;
    fsPath: string;
  };
}

export interface WorkspaceSessionIdentityFile {
  scheme?: string;
  fsPath: string;
}

export interface WorkspaceSessionLocation {
  cwd: string;
  /** Undefined means use the legacy single-folder `.agentlink/history` layout. */
  historyNamespace?: string;
}

export function resolveWorkspaceSessionLocation(options: {
  workspaceFolders: readonly WorkspaceSessionIdentityFolder[] | undefined;
  workspaceFile: WorkspaceSessionIdentityFile | undefined;
  fallbackCwd: string;
}): WorkspaceSessionLocation {
  const folders = options.workspaceFolders ?? [];
  const cwd = folders[0]?.uri.fsPath ?? options.fallbackCwd;

  if (folders.length <= 1) {
    return { cwd };
  }

  const workspaceFileKey = options.workspaceFile
    ? normalizeIdentityPart(options.workspaceFile)
    : undefined;
  const folderKeys = folders
    .map((folder) => normalizeIdentityPart(folder.uri))
    .sort();
  const hash = createHash("sha256")
    .update(
      JSON.stringify({
        workspaceFile: workspaceFileKey,
        folders: folderKeys,
      }),
    )
    .digest("hex")
    .slice(0, 16);

  return { cwd, historyNamespace: `workspace-${hash}` };
}

function normalizeIdentityPart(part: {
  scheme?: string;
  fsPath: string;
}): string {
  const scheme = part.scheme ?? "file";
  const normalizedPath = path.resolve(part.fsPath);
  return `${scheme}:${normalizedPath}`;
}
