import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

export interface WorkspaceHistoryShape {
  workspaceIdentity: string;
  workspaceFolderUris: readonly string[];
  workspaceFileUri?: string;
}

export type WorkspaceHistoryTransition =
  | "source_subset_of_destination"
  | "destination_subset_of_source"
  | "unrelated";

export interface WorkspaceHistoryInventoryEntry {
  relativePath: string;
  size: number;
  sha256: string;
}

export interface WorkspaceHistoryMigrationRequest {
  source: WorkspaceHistoryShape;
  destination: WorkspaceHistoryShape;
  sourceHistoryDirectory: string;
  destinationAnchorRootPath: string;
  /**
   * The destination's currently selected legacy history directory, if one
   * exists. It is copied to a rollback lineage before the imported branch is
   * made active.
   */
  destinationLegacyHistoryDirectory?: string;
  onProgress?: (message: string) => void;
}

export interface WorkspaceHistoryMigrationResult {
  workspaceRoot: string;
  lineage: string;
  historyDirectory: string;
  rollbackLineage?: string;
  sourceInventoryDigest: string;
}

export function hasPersistedWorkspaceHistory(
  historyDirectory: string,
  storageKind: "legacy" | "lineage_v2" | undefined,
): boolean {
  if (storageKind === "lineage_v2") return true;
  try {
    for (const entry of fs.readdirSync(historyDirectory, {
      withFileTypes: true,
    })) {
      if (entry.isDirectory() || entry.name !== "sessions.json") return true;
      try {
        const sessions = JSON.parse(
          fs.readFileSync(path.join(historyDirectory, entry.name), "utf-8"),
        );
        if (!Array.isArray(sessions) || sessions.length > 0) return true;
      } catch {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

interface WorkspaceManifest {
  version: 1;
  workspaceIdentity: string;
  workspaceFolderUris: string[];
  workspaceFileUri?: string;
  activeLineage: string;
  previousLineages: string[];
  updatedAt: number;
}

interface LineageReceipt {
  version: 1;
  lineage: string;
  sourceWorkspaceIdentity: string;
  sourceHistoryDirectory: string;
  importedAt: number;
  inventoryDigest: string;
  inventory: WorkspaceHistoryInventoryEntry[];
  kind: "import" | "rollback";
}

/**
 * A folder workspace becomes an untitled workspace when VS Code adds another
 * folder. Treat that promotion as the same workspace lineage, while requiring
 * an exact workspace-file URI match for every other transition.
 */
export function hasCompatibleWorkspaceFileUri(
  source: WorkspaceHistoryShape,
  destination: WorkspaceHistoryShape,
): boolean {
  return (
    source.workspaceFileUri === destination.workspaceFileUri ||
    (source.workspaceFileUri === undefined &&
      destination.workspaceFileUri?.startsWith("untitled:") === true)
  );
}

/**
 * A transition is eligible for automatic migration only when the folder sets
 * differ by strict containment. Equal and partially-overlapping sets require
 * explicit recovery because there is no safe source to infer.
 */
export function classifyWorkspaceHistoryTransition(
  source: WorkspaceHistoryShape,
  destination: WorkspaceHistoryShape,
): WorkspaceHistoryTransition {
  if (!hasCompatibleWorkspaceFileUri(source, destination)) {
    return "unrelated";
  }
  const sourceFolders = new Set(source.workspaceFolderUris);
  const destinationFolders = new Set(destination.workspaceFolderUris);
  if (sourceFolders.size === 0 || destinationFolders.size === 0) {
    return "unrelated";
  }
  if (
    sourceFolders.size < destinationFolders.size &&
    [...sourceFolders].every((folder) => destinationFolders.has(folder))
  ) {
    return "source_subset_of_destination";
  }
  if (
    destinationFolders.size < sourceFolders.size &&
    [...destinationFolders].every((folder) => sourceFolders.has(folder))
  ) {
    return "destination_subset_of_source";
  }
  return "unrelated";
}

/**
 * Copies a closed source history into a new destination lineage. The source is
 * never mutated; a partially copied stage is never selected by workspace.json.
 */
export async function migrateWorkspaceHistory(
  request: WorkspaceHistoryMigrationRequest,
): Promise<WorkspaceHistoryMigrationResult> {
  if (
    classifyWorkspaceHistoryTransition(request.source, request.destination) ===
    "unrelated"
  ) {
    throw new Error(
      "Workspace-history migration requires strict source/destination folder containment",
    );
  }

  const sourceDirectory = path.resolve(request.sourceHistoryDirectory);
  request.onProgress?.("Inspecting source history…");
  const sourceStat = await fs.promises.lstat(sourceDirectory);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new Error(
      "Workspace-history migration source must be a real directory",
    );
  }

  const workspaceRoot = path.join(
    path.resolve(request.destinationAnchorRootPath),
    ".agentlink",
    "workspaces",
    `ws-${request.destination.workspaceIdentity.slice(0, 16)}`,
  );
  await fs.promises.mkdir(workspaceRoot, { recursive: true });

  const existingManifest = await readWorkspaceManifest(workspaceRoot);
  if (
    existingManifest &&
    existingManifest.workspaceIdentity !== request.destination.workspaceIdentity
  ) {
    throw new Error("Workspace-history destination identity collision");
  }

  const sourceInventoryOptions = {
    excludeLegacyNamespaces: isLegacyHistoryRoot(sourceDirectory),
  };
  const sourceInventory = await buildInventory(
    sourceDirectory,
    sourceInventoryOptions,
  );
  request.onProgress?.(`Copying ${sourceInventory.length} history files…`);
  if (sourceInventory.length === 0) {
    throw new Error(
      "Workspace-history migration source has no persisted history",
    );
  }
  const sourceInventoryDigest = inventoryDigest(sourceInventory);
  const rollbackLineage = await snapshotLegacyDestinationIfNeeded({
    workspaceRoot,
    sourceDirectory,
    destinationLegacyHistoryDirectory:
      request.destinationLegacyHistoryDirectory,
    destination: request.destination,
  });

  const lineage = createLineageId();
  const historyDirectory = await publishLineage({
    workspaceRoot,
    lineage,
    sourceDirectory,
    source: request.source,
    inventory: sourceInventory,
    inventoryDigest: sourceInventoryDigest,
    inventoryOptions: sourceInventoryOptions,
    onProgress: request.onProgress,
    kind: "import",
  });

  const previousLineages = uniqueLineages([
    ...(existingManifest?.previousLineages ?? []),
    ...(existingManifest?.activeLineage
      ? [existingManifest.activeLineage]
      : []),
    ...(rollbackLineage ? [rollbackLineage] : []),
  ]).filter((entry) => entry !== lineage);
  request.onProgress?.("Publishing migrated history…");
  await writeWorkspaceManifest(workspaceRoot, {
    version: 1,
    workspaceIdentity: request.destination.workspaceIdentity,
    workspaceFolderUris: [...request.destination.workspaceFolderUris],
    ...(request.destination.workspaceFileUri
      ? { workspaceFileUri: request.destination.workspaceFileUri }
      : {}),
    activeLineage: lineage,
    previousLineages,
    updatedAt: Date.now(),
  });

  return {
    workspaceRoot,
    lineage,
    historyDirectory,
    ...(rollbackLineage ? { rollbackLineage } : {}),
    sourceInventoryDigest,
  };
}

async function snapshotLegacyDestinationIfNeeded({
  workspaceRoot,
  sourceDirectory,
  destinationLegacyHistoryDirectory,
  destination,
}: {
  workspaceRoot: string;
  sourceDirectory: string;
  destinationLegacyHistoryDirectory: string | undefined;
  destination: WorkspaceHistoryShape;
}): Promise<string | undefined> {
  if (!destinationLegacyHistoryDirectory) return undefined;
  const legacyDirectory = path.resolve(destinationLegacyHistoryDirectory);
  if (legacyDirectory === sourceDirectory) return undefined;
  try {
    const stat = await fs.promises.lstat(legacyDirectory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("Destination legacy history must be a real directory");
    }
    if ((await fs.promises.readdir(legacyDirectory)).length === 0)
      return undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }

  const inventoryOptions = {
    excludeDirectories: [sourceDirectory],
    excludeLegacyNamespaces: isLegacyHistoryRoot(legacyDirectory),
  };
  const inventory = await buildInventory(legacyDirectory, inventoryOptions);
  if (inventory.length === 0) return undefined;
  const lineage = createLineageId();
  await publishLineage({
    workspaceRoot,
    lineage,
    sourceDirectory: legacyDirectory,
    source: destination,
    inventory,
    inventoryDigest: inventoryDigest(inventory),
    inventoryOptions,
    kind: "rollback",
  });
  return lineage;
}

async function publishLineage({
  workspaceRoot,
  lineage,
  sourceDirectory,
  source,
  inventory,
  inventoryDigest: digest,
  inventoryOptions,
  onProgress,
  kind,
}: {
  workspaceRoot: string;
  lineage: string;
  sourceDirectory: string;
  source: WorkspaceHistoryShape;
  inventory: WorkspaceHistoryInventoryEntry[];
  inventoryDigest: string;
  inventoryOptions: Parameters<typeof buildInventory>[1];
  onProgress?: (message: string) => void;
  kind: LineageReceipt["kind"];
}): Promise<string> {
  const finalDirectory = path.join(workspaceRoot, lineage);
  if (await pathExists(finalDirectory)) {
    throw new Error(`Workspace-history lineage already exists: ${lineage}`);
  }
  const stageDirectory = path.join(
    workspaceRoot,
    `.stage-${lineage}-${crypto.randomUUID().slice(0, 8)}`,
  );
  try {
    onProgress?.(`Writing ${kind} lineage…`);
    await copyInventory(sourceDirectory, stageDirectory, inventory);
    const verifiedInventory = await buildInventory(
      sourceDirectory,
      inventoryOptions,
    );
    if (inventoryDigest(verifiedInventory) !== digest) {
      throw new Error("Workspace-history source changed during migration");
    }
    await writeAtomicJson(path.join(stageDirectory, "lineage.json"), {
      version: 1,
      lineage,
      sourceWorkspaceIdentity: source.workspaceIdentity,
      sourceHistoryDirectory: sourceDirectory,
      importedAt: Date.now(),
      inventoryDigest: digest,
      inventory,
      kind,
    } satisfies LineageReceipt);
    await fs.promises.rename(stageDirectory, finalDirectory);
    return finalDirectory;
  } catch (error) {
    await fs.promises.rm(stageDirectory, { recursive: true, force: true });
    throw error;
  }
}

async function buildInventory(
  directory: string,
  options: {
    excludeDirectories?: readonly string[];
    excludeLegacyNamespaces?: boolean;
  } = {},
  relativeDirectory = "",
): Promise<WorkspaceHistoryInventoryEntry[]> {
  const entries = await fs.promises.readdir(directory, { withFileTypes: true });
  const inventory: WorkspaceHistoryInventoryEntry[] = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const relativePath = path.posix.join(relativeDirectory, entry.name);
    const absolutePath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(
        `Workspace-history migration rejects symbolic links: ${relativePath}`,
      );
    }
    if (entry.isDirectory()) {
      if (
        options.excludeDirectories?.some(
          (excluded) => path.resolve(excluded) === path.resolve(absolutePath),
        ) ||
        (options.excludeLegacyNamespaces &&
          relativeDirectory === "" &&
          /^workspace-[a-f\d]{16}$/i.test(entry.name))
      ) {
        continue;
      }
      inventory.push(
        ...(await buildInventory(absolutePath, options, relativePath)),
      );
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(
        `Workspace-history migration rejects unsupported entry: ${relativePath}`,
      );
    }
    const stat = await fs.promises.stat(absolutePath);
    inventory.push({
      relativePath,
      size: stat.size,
      sha256: await hashFile(absolutePath),
    });
  }
  return inventory;
}

async function copyInventory(
  sourceDirectory: string,
  stageDirectory: string,
  inventory: readonly WorkspaceHistoryInventoryEntry[],
): Promise<void> {
  await fs.promises.mkdir(stageDirectory, { recursive: true });
  for (const entry of inventory) {
    const sourcePath = path.join(sourceDirectory, entry.relativePath);
    const targetPath = path.join(stageDirectory, entry.relativePath);
    const actual = await fs.promises.lstat(sourcePath);
    if (
      !actual.isFile() ||
      actual.isSymbolicLink() ||
      actual.size !== entry.size
    ) {
      throw new Error(
        `Workspace-history source changed during migration: ${entry.relativePath}`,
      );
    }
    if ((await hashFile(sourcePath)) !== entry.sha256) {
      throw new Error(
        `Workspace-history source changed during migration: ${entry.relativePath}`,
      );
    }
    await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.promises.copyFile(
      sourcePath,
      targetPath,
      fs.constants.COPYFILE_EXCL,
    );
  }
}

async function readWorkspaceManifest(
  workspaceRoot: string,
): Promise<WorkspaceManifest | undefined> {
  try {
    const parsed = JSON.parse(
      await fs.promises.readFile(
        path.join(workspaceRoot, "workspace.json"),
        "utf-8",
      ),
    ) as Partial<WorkspaceManifest>;
    if (
      parsed.version !== 1 ||
      typeof parsed.workspaceIdentity !== "string" ||
      !Array.isArray(parsed.workspaceFolderUris) ||
      typeof parsed.activeLineage !== "string" ||
      !Array.isArray(parsed.previousLineages)
    ) {
      throw new Error("Workspace-history manifest is malformed");
    }
    return parsed as WorkspaceManifest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeWorkspaceManifest(
  workspaceRoot: string,
  manifest: WorkspaceManifest,
): Promise<void> {
  await writeAtomicJson(path.join(workspaceRoot, "workspace.json"), manifest);
}

async function writeAtomicJson(
  filePath: string,
  value: unknown,
): Promise<void> {
  const tempPath = `${filePath}.${crypto.randomUUID()}.tmp`;
  await fs.promises.writeFile(
    tempPath,
    `${JSON.stringify(value, null, 2)}\n`,
    "utf-8",
  );
  await fs.promises.rename(tempPath, filePath);
}

async function hashFile(filePath: string): Promise<string> {
  const content = await fs.promises.readFile(filePath);
  return crypto.createHash("sha256").update(content).digest("hex");
}

function inventoryDigest(
  inventory: readonly WorkspaceHistoryInventoryEntry[],
): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(inventory))
    .digest("hex");
}

function createLineageId(): string {
  return `l-${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

function isLegacyHistoryRoot(directory: string): boolean {
  return path.basename(directory) === "history";
}

function uniqueLineages(lineages: readonly string[]): string[] {
  return [...new Set(lineages)];
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.lstat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
