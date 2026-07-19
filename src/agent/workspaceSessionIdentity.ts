import * as fs from "fs";
import * as path from "path";

import { createHash } from "crypto";

export interface WorkspaceSessionIdentityUri {
  scheme?: string;
  authority?: string;
  path?: string;
  fsPath: string;
  toString?(): string;
}

export interface WorkspaceSessionIdentityFolder {
  name?: string;
  uri: WorkspaceSessionIdentityUri;
}

export type WorkspaceSessionIdentityFile = WorkspaceSessionIdentityUri;

export type WorkspaceSessionLocationStatus =
  | "ready"
  | "legacy_conflict"
  | "unavailable";

export interface WorkspaceSessionStateAnchor {
  uri: string;
  rootPath: string;
}

export interface WorkspaceSessionLocation {
  status: WorkspaceSessionLocationStatus;
  /** Stable identity derived from the sorted full workspace-folder URI set. */
  workspaceIdentity: string;
  /**
   * Deprecated compatibility cwd. New session execution must use project scope;
   * workspace-level persistence uses stateAnchor instead.
   */
  cwd: string;
  /** Undefined means use the legacy single-folder `.agentlink/history` layout. */
  historyNamespace?: string;
  stateAnchor?: WorkspaceSessionStateAnchor;
  stateAnchorSource?: "single_folder" | "legacy_discovered" | "deterministic";
  /** Activation-time first file-backed folder used only for old session migration. */
  legacyPrimaryRootPath?: string;
  conflictingLegacyRoots?: string[];
}

export interface WorkspaceSessionLocationOptions {
  workspaceFolders: readonly WorkspaceSessionIdentityFolder[] | undefined;
  workspaceFile: WorkspaceSessionIdentityFile | undefined;
  fallbackCwd: string;
  historyNamespaceExists?: (rootPath: string, namespace: string) => boolean;
}

export function resolveWorkspaceSessionLocation(
  options: WorkspaceSessionLocationOptions,
): WorkspaceSessionLocation {
  const folders = options.workspaceFolders ?? [];
  const fileFolders = folders.filter((folder) => isFileUri(folder.uri));
  const normalizedFolderUris = folders
    .map((folder) => normalizeWorkspaceUri(folder.uri))
    .sort();
  const normalizedWorkspaceFileUri = options.workspaceFile
    ? normalizeWorkspaceUri(options.workspaceFile)
    : undefined;
  const workspaceIdentity = hashIdentity({
    workspaceFile: normalizedWorkspaceFileUri,
    folders: normalizedFolderUris,
  });
  const legacyPrimaryRootPath = fileFolders[0]?.uri.fsPath;

  if (folders.length === 0) {
    return {
      status: "unavailable",
      workspaceIdentity,
      cwd: options.fallbackCwd,
    };
  }

  if (folders.length === 1) {
    const folder = fileFolders[0];
    if (!folder) {
      return {
        status: "unavailable",
        workspaceIdentity,
        cwd: options.fallbackCwd,
      };
    }
    return {
      status: "ready",
      workspaceIdentity,
      cwd: folder.uri.fsPath,
      stateAnchor: {
        uri: normalizeWorkspaceUri(folder.uri),
        rootPath: folder.uri.fsPath,
      },
      stateAnchorSource: "single_folder",
      legacyPrimaryRootPath,
    };
  }

  if (fileFolders.length === 0) {
    return {
      status: "unavailable",
      workspaceIdentity,
      cwd: options.fallbackCwd,
    };
  }

  const historyNamespace = legacyHistoryNamespace(options);
  const historyNamespaceExists =
    options.historyNamespaceExists ?? defaultHistoryNamespaceExists;
  const legacyRoots = fileFolders
    .map((folder) => folder.uri.fsPath)
    .filter((rootPath) => historyNamespaceExists(rootPath, historyNamespace));
  const deterministicFolder = [...fileFolders].sort((left, right) =>
    normalizeWorkspaceUri(left.uri).localeCompare(
      normalizeWorkspaceUri(right.uri),
    ),
  )[0]!;
  const deterministicAnchor = {
    uri: normalizeWorkspaceUri(deterministicFolder.uri),
    rootPath: deterministicFolder.uri.fsPath,
  };

  if (legacyRoots.length > 1) {
    return {
      status: "legacy_conflict",
      workspaceIdentity,
      cwd: deterministicAnchor.rootPath,
      historyNamespace,
      stateAnchor: deterministicAnchor,
      stateAnchorSource: "deterministic",
      legacyPrimaryRootPath,
      conflictingLegacyRoots: legacyRoots.sort(),
    };
  }

  if (legacyRoots.length === 1) {
    const legacyRootPath = legacyRoots[0]!;
    const legacyFolder = fileFolders.find(
      (folder) =>
        path.resolve(folder.uri.fsPath) === path.resolve(legacyRootPath),
    )!;
    return {
      status: "ready",
      workspaceIdentity,
      cwd: legacyRootPath,
      historyNamespace,
      stateAnchor: {
        uri: normalizeWorkspaceUri(legacyFolder.uri),
        rootPath: legacyRootPath,
      },
      stateAnchorSource: "legacy_discovered",
      legacyPrimaryRootPath,
    };
  }

  return {
    status: "ready",
    workspaceIdentity,
    cwd: deterministicAnchor.rootPath,
    historyNamespace,
    stateAnchor: deterministicAnchor,
    stateAnchorSource: "deterministic",
    legacyPrimaryRootPath,
  };
}

export function normalizeWorkspaceUri(
  uri: WorkspaceSessionIdentityUri,
): string {
  const explicit = uri.toString?.();
  if (explicit && /^[a-z][a-z\d+.-]*:/i.test(explicit)) {
    return normalizeUriString(explicit);
  }

  const scheme = (uri.scheme ?? "file").toLowerCase();
  const authority = uri.authority ?? "";
  const uriPath = uri.path ?? normalizeUriPath(uri.fsPath);
  return `${scheme}://${authority}${normalizeUriPath(uriPath)}`;
}

function legacyHistoryNamespace(
  options: Pick<
    WorkspaceSessionLocationOptions,
    "workspaceFolders" | "workspaceFile"
  >,
): string {
  const folders = options.workspaceFolders ?? [];
  const workspaceFileKey = options.workspaceFile
    ? normalizeLegacyIdentityPart(options.workspaceFile)
    : undefined;
  const folderKeys = folders
    .map((folder) => normalizeLegacyIdentityPart(folder.uri))
    .sort();
  const hash = hashIdentity({
    workspaceFile: workspaceFileKey,
    folders: folderKeys,
  }).slice(0, 16);
  return `workspace-${hash}`;
}

function hashIdentity(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function normalizeLegacyIdentityPart(part: {
  scheme?: string;
  fsPath: string;
}): string {
  const scheme = part.scheme ?? "file";
  const normalizedPath = path.resolve(part.fsPath);
  return `${scheme}:${normalizedPath}`;
}

function normalizeUriString(value: string): string {
  try {
    const parsed = new URL(value);
    const scheme = parsed.protocol.slice(0, -1).toLowerCase();
    return `${scheme}://${parsed.host}${normalizeUriPath(decodeURI(parsed.pathname))}`;
  } catch {
    return value;
  }
}

function normalizeUriPath(value: string): string {
  const withSlashes = value.replaceAll("\\", "/");
  const absolute = withSlashes.startsWith("/")
    ? withSlashes
    : `/${withSlashes}`;
  const normalized = path.posix.normalize(absolute);
  return normalized === "/" ? normalized : normalized.replace(/\/$/, "");
}

function isFileUri(uri: WorkspaceSessionIdentityUri): boolean {
  return (uri.scheme ?? "file").toLowerCase() === "file";
}

function defaultHistoryNamespaceExists(
  rootPath: string,
  namespace: string,
): boolean {
  return fs.existsSync(path.join(rootPath, ".agentlink", "history", namespace));
}
