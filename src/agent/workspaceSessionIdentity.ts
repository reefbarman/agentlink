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
  /** Normalized sorted folder URIs used to derive workspaceIdentity. */
  workspaceFolderUris: string[];
  /** Normalized workspace file URI used to derive workspaceIdentity, if present. */
  workspaceFileUri?: string;
  /**
   * Deprecated compatibility cwd. New session execution must use project scope;
   * workspace-level persistence uses stateAnchor instead.
   */
  cwd: string;
  /** Undefined means use the legacy single-folder `.agentlink/history` layout. */
  historyNamespace?: string;
  /** Exact current history directory derived from the selected state anchor. */
  historyDirectory?: string;
  historyStorageKind?: "legacy" | "lineage_v2";
  historyLineage?: string;
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
  resolveV2HistoryDirectory?: (
    rootPath: string,
    workspaceIdentity: string,
  ) => { directory: string; lineage: string } | undefined;
}

export interface WorkspaceHistoryLocationDiagnostic {
  status: WorkspaceSessionLocationStatus;
  workspaceIdentity: string;
  directory?: string;
  label: string;
  stateAnchor?: WorkspaceSessionStateAnchor;
  stateAnchorSource?: WorkspaceSessionLocation["stateAnchorSource"];
  conflictingLegacyRoots?: string[];
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
      workspaceFolderUris: normalizedFolderUris,
      ...(normalizedWorkspaceFileUri
        ? { workspaceFileUri: normalizedWorkspaceFileUri }
        : {}),
      cwd: options.fallbackCwd,
    };
  }

  if (folders.length === 1) {
    const folder = fileFolders[0];
    if (!folder) {
      return {
        status: "unavailable",
        workspaceIdentity,
        workspaceFolderUris: normalizedFolderUris,
        ...(normalizedWorkspaceFileUri
          ? { workspaceFileUri: normalizedWorkspaceFileUri }
          : {}),
        cwd: options.fallbackCwd,
      };
    }
    const v2 = resolveV2HistoryDirectory(
      options,
      folder.uri.fsPath,
      workspaceIdentity,
    );
    return {
      status: "ready",
      workspaceIdentity,
      workspaceFolderUris: normalizedFolderUris,
      ...(normalizedWorkspaceFileUri
        ? { workspaceFileUri: normalizedWorkspaceFileUri }
        : {}),
      cwd: folder.uri.fsPath,
      stateAnchor: {
        uri: normalizeWorkspaceUri(folder.uri),
        rootPath: folder.uri.fsPath,
      },
      historyDirectory: v2?.directory ?? historyDirectory(folder.uri.fsPath),
      ...(v2
        ? {
            historyStorageKind: "lineage_v2" as const,
            historyLineage: v2.lineage,
          }
        : { historyStorageKind: "legacy" as const }),
      stateAnchorSource: "single_folder",
      legacyPrimaryRootPath,
    };
  }

  if (fileFolders.length === 0) {
    return {
      status: "unavailable",
      workspaceIdentity,
      workspaceFolderUris: normalizedFolderUris,
      ...(normalizedWorkspaceFileUri
        ? { workspaceFileUri: normalizedWorkspaceFileUri }
        : {}),
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

  const v2Anchor = fileFolders
    .map((folder) => ({
      anchor: {
        uri: normalizeWorkspaceUri(folder.uri),
        rootPath: folder.uri.fsPath,
      },
      history: resolveV2HistoryDirectory(
        options,
        folder.uri.fsPath,
        workspaceIdentity,
      ),
    }))
    .find((candidate) => candidate.history);
  if (v2Anchor?.history) {
    return {
      status: "ready",
      workspaceIdentity,
      workspaceFolderUris: normalizedFolderUris,
      ...(normalizedWorkspaceFileUri
        ? { workspaceFileUri: normalizedWorkspaceFileUri }
        : {}),
      cwd: v2Anchor.anchor.rootPath,
      historyDirectory: v2Anchor.history.directory,
      historyStorageKind: "lineage_v2",
      historyLineage: v2Anchor.history.lineage,
      stateAnchor: v2Anchor.anchor,
      stateAnchorSource:
        v2Anchor.anchor.rootPath === deterministicAnchor.rootPath
          ? "deterministic"
          : "legacy_discovered",
      legacyPrimaryRootPath,
    };
  }

  if (legacyRoots.length > 1) {
    return {
      status: "legacy_conflict",
      workspaceIdentity,
      workspaceFolderUris: normalizedFolderUris,
      ...(normalizedWorkspaceFileUri
        ? { workspaceFileUri: normalizedWorkspaceFileUri }
        : {}),
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
      workspaceFolderUris: normalizedFolderUris,
      ...(normalizedWorkspaceFileUri
        ? { workspaceFileUri: normalizedWorkspaceFileUri }
        : {}),
      cwd: legacyRootPath,
      historyNamespace,
      historyDirectory: historyDirectory(legacyRootPath, historyNamespace),
      historyStorageKind: "legacy",
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
    workspaceFolderUris: normalizedFolderUris,
    ...(normalizedWorkspaceFileUri
      ? { workspaceFileUri: normalizedWorkspaceFileUri }
      : {}),
    cwd: deterministicAnchor.rootPath,
    historyNamespace,
    historyDirectory: historyDirectory(
      deterministicAnchor.rootPath,
      historyNamespace,
    ),
    historyStorageKind: "legacy",
    stateAnchor: deterministicAnchor,
    stateAnchorSource: "deterministic",
    legacyPrimaryRootPath,
  };
}

/**
 * Produces a concise, user-facing description of the currently selected
 * file-backed history location without inspecting or mutating disk state.
 */
export function describeWorkspaceHistoryLocation(
  location: WorkspaceSessionLocation,
): WorkspaceHistoryLocationDiagnostic {
  if (location.status !== "ready" || !location.historyDirectory) {
    return {
      status: location.status,
      workspaceIdentity: location.workspaceIdentity,
      label:
        location.status === "legacy_conflict"
          ? "Unavailable: multiple legacy history locations conflict"
          : "Unavailable: no supported file-backed workspace location",
      ...(location.stateAnchor ? { stateAnchor: location.stateAnchor } : {}),
      ...(location.stateAnchorSource
        ? { stateAnchorSource: location.stateAnchorSource }
        : {}),
      ...(location.conflictingLegacyRoots
        ? { conflictingLegacyRoots: location.conflictingLegacyRoots }
        : {}),
    };
  }
  return {
    status: location.status,
    workspaceIdentity: location.workspaceIdentity,
    directory: location.historyDirectory,
    label:
      location.historyStorageKind === "lineage_v2"
        ? `History lineage: ${location.historyLineage}`
        : location.historyNamespace
          ? `Legacy namespace: ${location.historyNamespace}`
          : "Legacy single-folder history",
    ...(location.stateAnchor ? { stateAnchor: location.stateAnchor } : {}),
    ...(location.stateAnchorSource
      ? { stateAnchorSource: location.stateAnchorSource }
      : {}),
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

function resolveV2HistoryDirectory(
  options: WorkspaceSessionLocationOptions,
  rootPath: string,
  workspaceIdentity: string,
): { directory: string; lineage: string } | undefined {
  return (
    options.resolveV2HistoryDirectory?.(rootPath, workspaceIdentity) ??
    defaultResolveV2HistoryDirectory(rootPath, workspaceIdentity)
  );
}

function defaultResolveV2HistoryDirectory(
  rootPath: string,
  workspaceIdentity: string,
): { directory: string; lineage: string } | undefined {
  const workspaceRoot = path.join(
    rootPath,
    ".agentlink",
    "workspaces",
    `ws-${workspaceIdentity.slice(0, 16)}`,
  );
  try {
    const raw = fs.readFileSync(
      path.join(workspaceRoot, "workspace.json"),
      "utf-8",
    );
    const parsed = JSON.parse(raw) as {
      version?: unknown;
      workspaceIdentity?: unknown;
      activeLineage?: unknown;
    };
    if (
      parsed.version !== 1 ||
      parsed.workspaceIdentity !== workspaceIdentity ||
      typeof parsed.activeLineage !== "string" ||
      !/^l-[a-z\d]+$/i.test(parsed.activeLineage)
    ) {
      return undefined;
    }
    const directory = path.join(workspaceRoot, parsed.activeLineage);
    return fs.statSync(directory).isDirectory()
      ? { directory, lineage: parsed.activeLineage }
      : undefined;
  } catch {
    return undefined;
  }
}

function historyDirectory(rootPath: string, namespace?: string): string {
  const historyRoot = path.join(rootPath, ".agentlink", "history");
  return namespace ? path.join(historyRoot, namespace) : historyRoot;
}

function defaultHistoryNamespaceExists(
  rootPath: string,
  namespace: string,
): boolean {
  return fs.existsSync(path.join(rootPath, ".agentlink", "history", namespace));
}
