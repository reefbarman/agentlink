import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath, pathToFileURL } from "url";

import {
  SESSION_PROJECT_SCOPE_SCHEMA_VERSION,
  type SessionProjectScope,
} from "@agentlink/protocol/workspace-project";

import { createWorkspaceProjectId } from "../core/workspaceProjects.js";
import { readProjectLocationMarker } from "./projectLocationMarker.js";
import { hasPersistedWorkspaceHistory } from "./workspaceHistoryMigration.js";
import {
  normalizeWorkspaceUri,
  readV2HistoryDirectory,
  resolveWorkspaceSessionLocation,
  type WorkspaceSessionIdentityFile,
  type WorkspaceSessionIdentityFolder,
  type WorkspaceSessionIdentityUri,
} from "./workspaceSessionIdentity.js";

/**
 * Relocates persisted session history after a project folder was renamed or
 * moved. Sessions record their project by exact folder URI, so history that
 * travelled with the folder still points at the old path and cannot be
 * resumed. This rewrites those project records to the folder's current
 * identity and, for v2 lineage storage, moves the `ws-<identity>` directory
 * that is keyed by the old workspace identity.
 */

export interface ProjectFolderLocation {
  rootPath: string;
  /** Identity URI for workspace-identity hashing (vscode.Uri compatible). */
  uri: WorkspaceSessionIdentityUri;
}

export interface ProjectHistoryRelocationRequest {
  /** Current workspace folders, including the folder at its new location. */
  workspaceFolders: readonly WorkspaceSessionIdentityFolder[];
  workspaceFile: WorkspaceSessionIdentityFile | undefined;
  previous: ProjectFolderLocation & {
    /** Normalized project URI recorded in old session scopes. */
    projectUri: string;
  };
  current: ProjectFolderLocation & {
    /** Exact scope new sessions in this folder receive. */
    scope: SessionProjectScope;
  };
}

export type ProjectHistoryRelocationFailure =
  | "same_location"
  | "current_folder_not_open"
  | "source_unavailable"
  | "destination_unavailable"
  | "no_history"
  | "destination_has_history"
  | "unsupported_layout"
  | "nothing_to_migrate";

export interface ProjectHistoryRelocationPlan {
  request: ProjectHistoryRelocationRequest;
  storageKind: "legacy" | "lineage_v2";
  /** Directory moved as a unit: the v2 workspace root or legacy history dir. */
  sourceContainer: string;
  destinationContainer: string;
  /** History directories relative to the container ("" for legacy). */
  historyDirectories: string[];
  /** History directory AgentLink should select after migration. */
  expectedHistoryDirectory: string;
  sourceWorkspaceIdentity: string;
  destinationWorkspaceIdentity: string;
  destinationWorkspaceFolderUris: string[];
  destinationWorkspaceFileUri?: string;
  backupRoot: string;
  totalSessions: number;
  sessionsToRewrite: number;
}

export type ProjectHistoryRelocationPlanResult =
  | { ok: true; plan: ProjectHistoryRelocationPlan }
  | { ok: false; reason: ProjectHistoryRelocationFailure; message: string };

export interface ProjectHistoryRelocationResult {
  backupDirectory: string;
  historyDirectory: string;
  sessionsRewritten: number;
  totalSessions: number;
  moved: boolean;
}

export function planProjectHistoryRelocation(
  request: ProjectHistoryRelocationRequest,
): ProjectHistoryRelocationPlanResult {
  const fail = (
    reason: ProjectHistoryRelocationFailure,
    message: string,
  ): ProjectHistoryRelocationPlanResult => ({ ok: false, reason, message });

  const previousRoot = path.resolve(request.previous.rootPath);
  const currentRoot = path.resolve(request.current.rootPath);
  const currentKey = normalizeWorkspaceUri(request.current.uri);
  if (
    previousRoot === currentRoot ||
    normalizeWorkspaceUri(request.previous.uri) === currentKey ||
    request.previous.projectUri === request.current.scope.workspaceFolderUri
  ) {
    return fail(
      "same_location",
      "The previous folder is the same as the current folder.",
    );
  }
  const folderIndex = request.workspaceFolders.findIndex(
    (folder) => normalizeWorkspaceUri(folder.uri) === currentKey,
  );
  if (folderIndex < 0) {
    return fail(
      "current_folder_not_open",
      "The destination folder is not open in this workspace.",
    );
  }

  const remap = (value: string) =>
    remapPath(value, previousRoot, request.current.rootPath);
  const previousFolders = request.workspaceFolders.map((folder, index) =>
    index === folderIndex
      ? { name: path.basename(previousRoot), uri: request.previous.uri }
      : folder,
  );
  const source = resolveWorkspaceSessionLocation({
    workspaceFolders: previousFolders,
    workspaceFile: previousWorkspaceFile(
      request.workspaceFile,
      currentRoot,
      previousRoot,
    ),
    fallbackCwd: currentRoot,
    historyNamespaceExists: (rootPath, namespace) =>
      fs.existsSync(
        path.join(remap(rootPath), ".agentlink", "history", namespace),
      ),
    resolveV2HistoryDirectory: (rootPath, workspaceIdentity) =>
      readV2HistoryDirectory(remap(rootPath), workspaceIdentity),
  });
  if (source.status !== "ready" || !source.historyDirectory) {
    return fail(
      "source_unavailable",
      source.status === "legacy_conflict"
        ? "The previous workspace has conflicting legacy history locations."
        : "No history location could be resolved for the previous folder.",
    );
  }
  const destination = resolveWorkspaceSessionLocation({
    workspaceFolders: request.workspaceFolders,
    workspaceFile: request.workspaceFile,
    fallbackCwd: currentRoot,
  });
  if (
    destination.status !== "ready" ||
    !destination.historyDirectory ||
    !destination.stateAnchor
  ) {
    return fail(
      "destination_unavailable",
      "This workspace has no usable history location.",
    );
  }

  const storageKind =
    source.historyStorageKind === "lineage_v2" ? "lineage_v2" : "legacy";
  const sourceHistoryDirectory = remap(source.historyDirectory);
  if (
    !isRealDirectory(sourceHistoryDirectory) ||
    !hasPersistedWorkspaceHistory(sourceHistoryDirectory, storageKind)
  ) {
    return fail(
      "no_history",
      `No session history from ${request.previous.rootPath} was found in this folder.`,
    );
  }

  let sourceContainer: string;
  let destinationContainer: string;
  let historyDirectories: string[];
  let expectedHistoryDirectory: string;
  if (storageKind === "lineage_v2") {
    sourceContainer = path.dirname(sourceHistoryDirectory);
    destinationContainer = path.join(
      destination.stateAnchor.rootPath,
      ".agentlink",
      "workspaces",
      `ws-${destination.workspaceIdentity.slice(0, 16)}`,
    );
    if (
      destination.historyStorageKind === "lineage_v2" ||
      (fs.existsSync(destinationContainer) &&
        !samePath(destinationContainer, sourceContainer))
    ) {
      return fail(
        "destination_has_history",
        `This workspace already has its own history at ${destinationContainer}.`,
      );
    }
    // Sessions saved here since the rename would be hidden once the moved v2
    // manifest takes precedence. Stale pre-v2 sessions still carry the old
    // scope and are superseded by the v2 history, so they do not block.
    if (
      countSessionsWithScope(
        destination.historyDirectory,
        request.current.scope.workspaceFolderUri,
      ) > 0
    ) {
      return fail(
        "destination_has_history",
        `This folder already has sessions created since the move at ${destination.historyDirectory}.`,
      );
    }
    historyDirectories = listLineageDirectories(sourceContainer);
    expectedHistoryDirectory = path.join(
      destinationContainer,
      path.basename(sourceHistoryDirectory),
    );
  } else {
    sourceContainer = sourceHistoryDirectory;
    destinationContainer = destination.historyDirectory;
    if (destination.historyStorageKind === "lineage_v2") {
      return fail(
        "destination_has_history",
        `This workspace already has its own history at ${destination.historyDirectory}.`,
      );
    }
    if (!samePath(sourceContainer, destinationContainer)) {
      if (
        isPathInside(sourceContainer, destinationContainer) ||
        isPathInside(destinationContainer, sourceContainer)
      ) {
        return fail(
          "unsupported_layout",
          "The previous and current history directories overlap.",
        );
      }
      if (hasPersistedWorkspaceHistory(destinationContainer, "legacy")) {
        return fail(
          "destination_has_history",
          `This workspace already has its own history at ${destinationContainer}.`,
        );
      }
    }
    historyDirectories = [""];
    expectedHistoryDirectory = destinationContainer;
  }

  let totalSessions = 0;
  let sessionsToRewrite = 0;
  for (const relative of historyDirectories) {
    const counts = processHistoryDirectory(
      path.join(sourceContainer, relative),
      request,
      false,
    );
    totalSessions += counts.total;
    sessionsToRewrite += counts.rewritten;
  }
  const moves = !samePath(sourceContainer, destinationContainer);
  if (!moves && sessionsToRewrite === 0) {
    return fail(
      "nothing_to_migrate",
      `No sessions in this folder still reference ${request.previous.rootPath}.`,
    );
  }

  return {
    ok: true,
    plan: {
      request,
      storageKind,
      sourceContainer,
      destinationContainer,
      historyDirectories,
      expectedHistoryDirectory,
      sourceWorkspaceIdentity: source.workspaceIdentity,
      destinationWorkspaceIdentity: destination.workspaceIdentity,
      destinationWorkspaceFolderUris: [...destination.workspaceFolderUris],
      ...(destination.workspaceFileUri
        ? { destinationWorkspaceFileUri: destination.workspaceFileUri }
        : {}),
      backupRoot: path.join(
        destination.stateAnchor.rootPath,
        ".agentlink",
        "backups",
      ),
      totalSessions,
      sessionsToRewrite,
    },
  };
}

/**
 * Executes a plan: backs up the source container, moves it when its location
 * depends on the old identity, rewrites project scopes, and verifies that
 * AgentLink now selects the migrated history. Any failure after the backup
 * restores the original layout from the backup before rethrowing.
 */
export async function relocateProjectHistory(
  plan: ProjectHistoryRelocationPlan,
  options: { now?: () => number; onProgress?: (message: string) => void } = {},
): Promise<ProjectHistoryRelocationResult> {
  const now = options.now ?? Date.now;
  if (!isRealDirectory(plan.sourceContainer)) {
    throw new Error(`History source is missing: ${plan.sourceContainer}`);
  }

  options.onProgress?.("Backing up session history…");
  const backupDirectory = path.join(
    plan.backupRoot,
    `history-migration-${new Date(now()).toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}`,
  );
  const backupHistory = path.join(backupDirectory, "history");
  await fs.promises.mkdir(backupDirectory, { recursive: true });
  await fs.promises.cp(plan.sourceContainer, backupHistory, {
    recursive: true,
    errorOnExist: true,
    force: false,
    verbatimSymlinks: true,
  });
  if (
    inventoryDigest(plan.sourceContainer) !== inventoryDigest(backupHistory)
  ) {
    throw new Error("Session history backup does not match the original");
  }
  await fs.promises.writeFile(
    path.join(backupDirectory, "backup.json"),
    `${JSON.stringify(
      {
        version: 1,
        createdAt: now(),
        storageKind: plan.storageKind,
        previousRootPath: plan.request.previous.rootPath,
        currentRootPath: plan.request.current.rootPath,
        restoreTo: plan.sourceContainer,
        migratedTo: plan.destinationContainer,
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );

  const moved = !samePath(plan.sourceContainer, plan.destinationContainer);
  // Only paths this run has changed may be removed during rollback.
  let mutated = false;
  try {
    if (moved) {
      options.onProgress?.("Moving session history…");
      await fs.promises.mkdir(path.dirname(plan.destinationContainer), {
        recursive: true,
      });
      await removeEmptyDirectory(plan.destinationContainer);
      if (fs.existsSync(plan.destinationContainer)) {
        throw new Error(
          `History appeared at ${plan.destinationContainer} during migration`,
        );
      }
      await fs.promises.rename(plan.sourceContainer, plan.destinationContainer);
    }
    mutated = true;

    options.onProgress?.("Updating session project records…");
    let sessionsRewritten = 0;
    for (const relative of plan.historyDirectories) {
      sessionsRewritten += processHistoryDirectory(
        path.join(plan.destinationContainer, relative),
        plan.request,
        true,
      ).rewritten;
    }
    if (plan.storageKind === "lineage_v2") {
      rewriteWorkspaceManifest(plan, now());
    }

    options.onProgress?.("Verifying migrated history…");
    verifyRelocation(plan);
    return {
      backupDirectory,
      historyDirectory: plan.expectedHistoryDirectory,
      sessionsRewritten,
      totalSessions: plan.totalSessions,
      moved,
    };
  } catch (error) {
    if (!mutated) {
      throw new Error(
        `Session history migration failed before changing anything: ${String(error)}. A backup is at ${backupHistory}.`,
      );
    }
    try {
      // destinationContainer is either the moved source or, in place, the
      // source itself; both are owned by this run and covered by the backup.
      await fs.promises.rm(plan.destinationContainer, {
        recursive: true,
        force: true,
      });
      await fs.promises.cp(backupHistory, plan.sourceContainer, {
        recursive: true,
        verbatimSymlinks: true,
      });
    } catch (restoreError) {
      throw new Error(
        `Session history migration failed (${String(error)}) and automatic restore also failed (${String(restoreError)}). The original history is backed up at ${backupHistory}.`,
      );
    }
    throw new Error(
      `Session history migration failed and the original history was restored: ${String(error)}`,
    );
  }
}

export interface ProjectHistoryRelocationCandidate {
  previousRootPath: string;
  previousDisplayName: string;
  /** Normalized project URI from evidence, when known. */
  previousProjectUri?: string;
  /** Current folder the history belongs to, when the evidence says so. */
  currentRootPath?: string;
  previousExists: boolean;
  evidence: ("location_marker" | "session_history" | "workspace_manifest")[];
}

export interface CandidateDiscoveryFolder {
  rootPath: string;
  uri: WorkspaceSessionIdentityUri;
  projectUri: string;
}

/**
 * Finds previous locations whose history may need migrating, from the
 * `.agentlink/location.json` marker, project scopes in the current history
 * directory that match no open folder, and v2 manifests for other locations.
 */
export function findProjectHistoryRelocationCandidates(options: {
  folders: readonly CandidateDiscoveryFolder[];
  currentHistoryDirectory?: string;
}): ProjectHistoryRelocationCandidate[] {
  const candidates = new Map<string, ProjectHistoryRelocationCandidate>();
  const currentUris = new Set(
    options.folders.map((folder) => folder.projectUri),
  );
  const currentRoots = new Set(
    options.folders.map((folder) => path.resolve(folder.rootPath)),
  );
  const add = (
    previousRootPath: string,
    displayName: string,
    evidence: ProjectHistoryRelocationCandidate["evidence"][number],
    currentRootPath: string | undefined,
    previousProjectUri?: string,
  ) => {
    const resolved = path.resolve(previousRootPath);
    if (currentRoots.has(resolved)) return;
    if (previousProjectUri && currentUris.has(previousProjectUri)) return;
    const key = `${resolved}\u0000${currentRootPath ?? ""}`;
    const existing = candidates.get(key);
    if (existing) {
      if (!existing.evidence.includes(evidence))
        existing.evidence.push(evidence);
      existing.previousProjectUri ??= previousProjectUri;
      return;
    }
    candidates.set(key, {
      previousRootPath: resolved,
      previousDisplayName: displayName || path.basename(resolved),
      ...(previousProjectUri ? { previousProjectUri } : {}),
      ...(currentRootPath ? { currentRootPath } : {}),
      previousExists: fs.existsSync(resolved),
      evidence: [evidence],
    });
  };

  for (const folder of options.folders) {
    const marker = readProjectLocationMarker(folder.rootPath);
    for (const previous of marker?.previous ?? []) {
      add(
        previous.rootPath,
        previous.displayName,
        "location_marker",
        folder.rootPath,
        previous.workspaceFolderUri,
      );
    }
    for (const uri of singleFolderManifestUris(folder.rootPath)) {
      if (uri === normalizeWorkspaceUri(folder.uri)) continue;
      const rootPath = fileUriToPath(uri);
      if (rootPath) {
        add(
          rootPath,
          path.basename(rootPath),
          "workspace_manifest",
          folder.rootPath,
        );
      }
    }
  }

  if (options.currentHistoryDirectory) {
    const singleFolder =
      options.folders.length === 1 ? options.folders[0] : undefined;
    for (const scope of collectHistoryScopes(options.currentHistoryDirectory)) {
      if (currentUris.has(scope.workspaceFolderUri)) continue;
      const rootPath =
        scope.rootPath ?? fileUriToPath(scope.workspaceFolderUri);
      if (!rootPath) continue;
      add(
        rootPath,
        scope.displayName,
        "session_history",
        singleFolder?.rootPath,
        scope.workspaceFolderUri,
      );
    }
  }
  return [...candidates.values()];
}

interface HistoryDirectoryCounts {
  total: number;
  rewritten: number;
}

/**
 * Counts (and, when `write` is true, rewrites) sessions in one history
 * directory whose project scope references the previous folder. Unreadable
 * session files are left untouched.
 */
function processHistoryDirectory(
  directory: string,
  request: ProjectHistoryRelocationRequest,
  write: boolean,
): HistoryDirectoryCounts {
  const counts: HistoryDirectoryCounts = { total: 0, rewritten: 0 };
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return counts;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const metadataPath = path.join(directory, entry.name, "metadata.json");
    const metadata = readJson(metadataPath);
    if (!isObject(metadata)) continue;
    counts.total += 1;
    let changed = false;
    if (matchesPrevious(metadata.projectScope, request)) {
      metadata.projectScope = { ...request.current.scope };
      changed = true;
    }
    if (
      isObject(metadata.summary) &&
      matchesPrevious(metadata.summary.projectScope, request)
    ) {
      metadata.summary.projectScope = { ...request.current.scope };
      changed = true;
    }
    const resource = remapResourceUri(
      metadata.activeContextResourceUri,
      request,
    );
    if (resource !== undefined) {
      metadata.activeContextResourceUri = resource;
      changed = true;
    }
    if (!changed) continue;
    counts.rewritten += 1;
    if (write) writeJsonAtomicSync(metadataPath, metadata);
  }

  const indexPath = path.join(directory, "sessions.json");
  const index = readJson(indexPath);
  if (Array.isArray(index)) {
    let indexChanged = false;
    for (const summary of index) {
      if (isObject(summary) && matchesPrevious(summary.projectScope, request)) {
        summary.projectScope = { ...request.current.scope };
        indexChanged = true;
      }
    }
    if (indexChanged && write) writeJsonAtomicSync(indexPath, index);
  }
  return counts;
}

function verifyRelocation(plan: ProjectHistoryRelocationPlan): void {
  const resolved = resolveWorkspaceSessionLocation({
    workspaceFolders: plan.request.workspaceFolders,
    workspaceFile: plan.request.workspaceFile,
    fallbackCwd: plan.request.current.rootPath,
  });
  if (
    !resolved.historyDirectory ||
    !samePath(resolved.historyDirectory, plan.expectedHistoryDirectory)
  ) {
    throw new Error(
      `AgentLink would select ${resolved.historyDirectory ?? "no history directory"} instead of ${plan.expectedHistoryDirectory}`,
    );
  }
  let total = 0;
  for (const relative of plan.historyDirectories) {
    const directory = path.join(plan.destinationContainer, relative);
    const counts = processHistoryDirectory(directory, plan.request, false);
    if (counts.rewritten > 0) {
      throw new Error(
        `${counts.rewritten} sessions in ${directory} still reference the previous folder`,
      );
    }
    const index = readJson(path.join(directory, "sessions.json"));
    if (
      Array.isArray(index) &&
      index.some(
        (summary) =>
          isObject(summary) &&
          matchesPrevious(summary.projectScope, plan.request),
      )
    ) {
      throw new Error(`The session index in ${directory} was not updated`);
    }
    total += counts.total;
  }
  if (total !== plan.totalSessions) {
    throw new Error(
      `Expected ${plan.totalSessions} sessions after migration but found ${total}`,
    );
  }
}

function rewriteWorkspaceManifest(
  plan: ProjectHistoryRelocationPlan,
  now: number,
): void {
  const manifestPath = path.join(plan.destinationContainer, "workspace.json");
  const manifest = readJson(manifestPath);
  if (
    !isObject(manifest) ||
    manifest.workspaceIdentity !== plan.sourceWorkspaceIdentity
  ) {
    throw new Error("The v2 workspace manifest does not match the old folder");
  }
  manifest.workspaceIdentity = plan.destinationWorkspaceIdentity;
  manifest.workspaceFolderUris = [...plan.destinationWorkspaceFolderUris];
  if (plan.destinationWorkspaceFileUri) {
    manifest.workspaceFileUri = plan.destinationWorkspaceFileUri;
  } else {
    delete manifest.workspaceFileUri;
  }
  manifest.updatedAt = now;
  writeJsonAtomicSync(manifestPath, manifest);
}

function matchesPrevious(
  value: unknown,
  request: ProjectHistoryRelocationRequest,
): boolean {
  if (!isSessionProjectScope(value)) return false;
  if (value.workspaceFolderUri === request.current.scope.workspaceFolderUri) {
    return false;
  }
  return (
    value.workspaceFolderUri === request.previous.projectUri ||
    value.projectId === createWorkspaceProjectId(request.previous.projectUri) ||
    (value.rootPath !== undefined &&
      samePath(value.rootPath, request.previous.rootPath))
  );
}

function remapResourceUri(
  value: unknown,
  request: ProjectHistoryRelocationRequest,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const previous = request.previous.projectUri;
  if (value !== previous && !value.startsWith(`${previous}/`)) return undefined;
  return `${request.current.scope.workspaceFolderUri}${value.slice(previous.length)}`;
}

function countSessionsWithScope(
  directory: string,
  workspaceFolderUri: string,
): number {
  return collectHistoryScopes(directory).filter(
    (scope) => scope.workspaceFolderUri === workspaceFolderUri,
  ).length;
}

/**
 * A workspace file stored inside the renamed folder moved with it, so the old
 * workspace identity was hashed with its previous path.
 */
function previousWorkspaceFile(
  workspaceFile: WorkspaceSessionIdentityFile | undefined,
  currentRoot: string,
  previousRoot: string,
): WorkspaceSessionIdentityFile | undefined {
  if (!workspaceFile || (workspaceFile.scheme ?? "file") !== "file") {
    return workspaceFile;
  }
  const remapped = remapPath(workspaceFile.fsPath, currentRoot, previousRoot);
  if (remapped === workspaceFile.fsPath) return workspaceFile;
  return {
    scheme: "file",
    authority: "",
    path: pathToFileURL(remapped).pathname,
    fsPath: remapped,
    toString: () => pathToFileURL(remapped).href,
  };
}

function collectHistoryScopes(directory: string): SessionProjectScope[] {
  const scopes: SessionProjectScope[] = [];
  const index = readJson(path.join(directory, "sessions.json"));
  if (Array.isArray(index)) {
    for (const summary of index) {
      if (isObject(summary) && isSessionProjectScope(summary.projectScope)) {
        scopes.push(summary.projectScope);
      }
    }
  }
  return scopes;
}

function singleFolderManifestUris(rootPath: string): string[] {
  const workspacesRoot = path.join(rootPath, ".agentlink", "workspaces");
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(workspacesRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const uris: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("ws-")) continue;
    const manifest = readJson(
      path.join(workspacesRoot, entry.name, "workspace.json"),
    );
    if (
      isObject(manifest) &&
      manifest.workspaceFileUri === undefined &&
      Array.isArray(manifest.workspaceFolderUris) &&
      manifest.workspaceFolderUris.length === 1 &&
      typeof manifest.workspaceFolderUris[0] === "string"
    ) {
      uris.push(manifest.workspaceFolderUris[0]);
    }
  }
  return uris;
}

function listLineageDirectories(workspaceRoot: string): string[] {
  try {
    return fs
      .readdirSync(workspaceRoot, { withFileTypes: true })
      .filter(
        (entry) => entry.isDirectory() && /^l-[a-z\d]+$/i.test(entry.name),
      )
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function inventoryDigest(directory: string): string {
  const hash = crypto.createHash("sha256");
  const walk = (current: string, relative: string) => {
    for (const entry of fs
      .readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(current, entry.name);
      const entryRelative = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) {
        walk(absolute, entryRelative);
      } else if (entry.isFile()) {
        hash.update(entryRelative);
        hash.update("\u0000");
        hash.update(fs.readFileSync(absolute));
        hash.update("\u0000");
      } else {
        hash.update(`${entryRelative}\u0000link\u0000`);
      }
    }
  };
  walk(directory, "");
  return hash.digest("hex");
}

async function removeEmptyDirectory(directory: string): Promise<void> {
  try {
    if ((await fs.promises.readdir(directory)).length === 0) {
      await fs.promises.rmdir(directory);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function remapPath(value: string, fromRoot: string, toRoot: string): string {
  const resolved = path.resolve(value);
  if (resolved === fromRoot) return path.resolve(toRoot);
  if (resolved.startsWith(`${fromRoot}${path.sep}`)) {
    return path.join(toRoot, resolved.slice(fromRoot.length + 1));
  }
  return value;
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right);
}

function isPathInside(child: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return (
    relative.length > 0 &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative)
  );
}

function isRealDirectory(directory: string): boolean {
  try {
    const stat = fs.lstatSync(directory);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function fileUriToPath(uri: string): string | undefined {
  try {
    return fileURLToPath(uri);
  } catch {
    return undefined;
  }
}

function isSessionProjectScope(value: unknown): value is SessionProjectScope {
  return (
    isObject(value) &&
    value.schemaVersion === SESSION_PROJECT_SCOPE_SCHEMA_VERSION &&
    value.kind === "project" &&
    typeof value.projectId === "string" &&
    typeof value.workspaceFolderUri === "string" &&
    typeof value.displayName === "string"
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return undefined;
  }
}

function writeJsonAtomicSync(filePath: string, value: unknown): void {
  const tempPath = `${filePath}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value)}\n`, "utf-8");
  fs.renameSync(tempPath, filePath);
}
