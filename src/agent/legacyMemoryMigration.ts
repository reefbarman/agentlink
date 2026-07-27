import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type {
  ImportMemoryRecordsRequest,
  ImportMemoryRecordsResult,
  MemoryImportCheckpoint,
  MemoryScope,
  RecordMemoryImportFailureRequest,
} from "../core/memory/contracts.js";
import {
  LEGACY_MEMORY_IMPORTER_SCHEMA_VERSION,
  buildLegacyMemoryImportRequest,
  getLegacyMemoryImportIds,
  getLegacyMemorySourceRevision,
} from "../core/memory/legacyMemoryImport.js";

import type { ProjectScopeResolver } from "../core/workspaceProjects.js";

export interface LegacyMemoryMigrationProvider {
  importRecords(
    request: ImportMemoryRecordsRequest,
  ): Promise<ImportMemoryRecordsResult>;
  recordImportFailure(
    request: RecordMemoryImportFailureRequest,
  ): Promise<MemoryImportCheckpoint>;
}

export interface LegacyMemoryMigrationResult {
  imported: ImportMemoryRecordsResult[];
  skippedMissing: string[];
}

interface LegacyMemoryFileSource {
  sourceKey: string;
  filePath: string;
  scope: MemoryScope;
}

export async function migrateLegacyMemoryFiles(options: {
  provider: LegacyMemoryMigrationProvider;
  projectCatalog: Pick<ProjectScopeResolver, "listProjects">;
  homeDirectory?: string;
  now?: () => Date;
}): Promise<LegacyMemoryMigrationResult> {
  const now = options.now ?? (() => new Date());
  const sources = legacyMemorySources(
    options.projectCatalog,
    options.homeDirectory ?? os.homedir(),
  );
  const imported: ImportMemoryRecordsResult[] = [];
  const skippedMissing: string[] = [];
  const failures: unknown[] = [];

  for (const source of sources) {
    const startedAt = now().toISOString();
    let content: string;
    let observedAt: string;
    try {
      const read = await readStableLegacyMemoryFile(source.filePath);
      if (!read) {
        skippedMissing.push(source.filePath);
        continue;
      }
      content = read.content;
      observedAt = read.observedAt;
    } catch (error) {
      const failure = migrationFailure(error, "read-failed");
      const sourceRevision = `unreadable:${failure.code}`;
      const ids = getLegacyMemoryImportIds(source.sourceKey, sourceRevision);
      await options.provider.recordImportFailure({
        checkpointId: ids.checkpointId,
        sourceKey: source.sourceKey,
        sourceRevision,
        importerSchemaVersion: LEGACY_MEMORY_IMPORTER_SCHEMA_VERSION,
        startedAt,
        error: failure,
      });
      failures.push(error);
      continue;
    }

    const sourceRevision = getLegacyMemorySourceRevision(content);
    let request: ImportMemoryRecordsRequest;
    try {
      request = buildLegacyMemoryImportRequest({
        ...source,
        content,
        observedAt,
      });
    } catch (error) {
      const ids = getLegacyMemoryImportIds(source.sourceKey, sourceRevision);
      await options.provider.recordImportFailure({
        checkpointId: ids.checkpointId,
        sourceKey: source.sourceKey,
        sourceRevision,
        importerSchemaVersion: LEGACY_MEMORY_IMPORTER_SCHEMA_VERSION,
        startedAt,
        error: migrationFailure(error, "parse-failed"),
      });
      failures.push(error);
      continue;
    }
    try {
      imported.push(await options.provider.importRecords(request));
    } catch (error) {
      failures.push(error);
    }
  }

  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(
      failures,
      `Legacy memory migration failed for ${failures.length} sources`,
    );
  }
  return { imported, skippedMissing };
}

function legacyMemorySources(
  projectCatalog: Pick<ProjectScopeResolver, "listProjects">,
  homeDirectory: string,
): LegacyMemoryFileSource[] {
  const globalPath = path.join(homeDirectory, ".agentlink", "memory.md");
  const projects = projectCatalog
    .listProjects()
    .filter(
      (project) =>
        project.availability.status === "available" && project.rootPath,
    )
    .sort((left, right) => left.id.localeCompare(right.id));
  return [
    {
      sourceKey: "global:agentlink-user:memory.md",
      filePath: globalPath,
      scope: { kind: "global", id: "agentlink-user" },
    },
    ...projects.map((project) => ({
      sourceKey: `workspace:${project.id}:memory.md`,
      filePath: path.join(project.rootPath!, ".agentlink", "memory.md"),
      scope: { kind: "workspace" as const, id: project.id },
    })),
  ];
}

async function readStableLegacyMemoryFile(
  filePath: string,
): Promise<{ content: string; observedAt: string } | null> {
  const attempts = 3;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await readLegacyMemoryFileOnce(filePath);
    } catch (error) {
      if (
        !(error instanceof LegacyMemoryMigrationError) ||
        error.code !== "source-changed-during-read" ||
        attempt === attempts
      ) {
        throw error;
      }
    }
  }
  throw new Error("unreachable");
}

async function readLegacyMemoryFileOnce(
  filePath: string,
): Promise<{ content: string; observedAt: string } | null> {
  let before: Awaited<ReturnType<typeof fs.stat>>;
  try {
    before = await fs.stat(filePath);
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
  if (!before.isFile()) {
    throw new LegacyMemoryMigrationError(
      "not-a-file",
      `Legacy memory source is not a regular file: ${filePath}`,
    );
  }
  const content = await fs.readFile(filePath, "utf8");
  const after = await fs.stat(filePath);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw new LegacyMemoryMigrationError(
      "source-changed-during-read",
      `Legacy memory source changed while it was being read: ${filePath}`,
    );
  }
  return { content, observedAt: before.mtime.toISOString() };
}

class LegacyMemoryMigrationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "LegacyMemoryMigrationError";
  }
}

function migrationFailure(
  error: unknown,
  fallbackCode: string,
): RecordMemoryImportFailureRequest["error"] {
  return {
    code:
      error instanceof LegacyMemoryMigrationError
        ? error.code
        : (errorCode(error) ?? fallbackCode),
    message: error instanceof Error ? error.message : String(error),
  };
}

function isMissingFileError(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}
