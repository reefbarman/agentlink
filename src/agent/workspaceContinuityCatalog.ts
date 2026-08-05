import * as fs from "fs";
import * as path from "path";

import type { WorkspaceHistoryShape } from "./workspaceHistoryMigration.js";

const CATALOG_VERSION = 1;
const CATALOG_FILE = "workspace-history-catalog.json";

export interface WorkspaceHistoryCatalogEntry extends WorkspaceHistoryShape {
  historyDirectory: string;
  anchorRootPath: string;
  updatedAt: number;
}

interface WorkspaceHistoryCatalogFile {
  version: 1;
  entries: WorkspaceHistoryCatalogEntry[];
}

/**
 * Small global catalog that bridges VS Code workspace-state changes. Entries
 * are hints only: callers must still validate a history path before use.
 */
export class WorkspaceContinuityCatalog {
  private readonly filePath: string;

  constructor(globalStoragePath: string) {
    this.filePath = path.join(globalStoragePath, CATALOG_FILE);
  }

  list(): WorkspaceHistoryCatalogEntry[] {
    return this.read().entries;
  }

  remember(entry: WorkspaceHistoryCatalogEntry): void {
    const catalog = this.read();
    const entries = catalog.entries.filter(
      (candidate) => candidate.workspaceIdentity !== entry.workspaceIdentity,
    );
    entries.push({
      ...entry,
      workspaceFolderUris: [...entry.workspaceFolderUris],
    });
    this.write({ version: CATALOG_VERSION, entries });
  }

  findExpansionCandidates(
    destination: WorkspaceHistoryShape,
  ): WorkspaceHistoryCatalogEntry[] {
    return this.list().filter(
      (entry) =>
        entry.workspaceIdentity !== destination.workspaceIdentity &&
        entry.workspaceFileUri === destination.workspaceFileUri &&
        isStrictSubset(
          entry.workspaceFolderUris,
          destination.workspaceFolderUris,
        ),
    );
  }

  private read(): WorkspaceHistoryCatalogFile {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf-8")) as {
        version?: unknown;
        entries?: unknown;
      };
      if (
        parsed.version !== CATALOG_VERSION ||
        !Array.isArray(parsed.entries) ||
        !parsed.entries.every(isCatalogEntry)
      ) {
        return { version: CATALOG_VERSION, entries: [] };
      }
      return {
        version: CATALOG_VERSION,
        entries: parsed.entries,
      };
    } catch {
      return { version: CATALOG_VERSION, entries: [] };
    }
  }

  private write(catalog: WorkspaceHistoryCatalogFile): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(
      temporaryPath,
      `${JSON.stringify(catalog, null, 2)}\n`,
      "utf-8",
    );
    fs.renameSync(temporaryPath, this.filePath);
  }
}

function isStrictSubset(
  source: readonly string[],
  destination: readonly string[],
): boolean {
  const sourceSet = new Set(source);
  const destinationSet = new Set(destination);
  return (
    sourceSet.size > 0 &&
    sourceSet.size < destinationSet.size &&
    [...sourceSet].every((entry) => destinationSet.has(entry))
  );
}

function isCatalogEntry(value: unknown): value is WorkspaceHistoryCatalogEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<WorkspaceHistoryCatalogEntry>;
  return (
    typeof entry.workspaceIdentity === "string" &&
    Array.isArray(entry.workspaceFolderUris) &&
    entry.workspaceFolderUris.every((uri) => typeof uri === "string") &&
    (entry.workspaceFileUri === undefined ||
      typeof entry.workspaceFileUri === "string") &&
    typeof entry.historyDirectory === "string" &&
    typeof entry.anchorRootPath === "string" &&
    typeof entry.updatedAt === "number"
  );
}
