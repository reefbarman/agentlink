import * as path from "path";

import type { StructuralGraphProvider } from "../core/capabilities/readSearch.js";
import type {
  StructuralFileEntry,
  StructuralGraphCache,
} from "../indexer/structuralGraph.js";
import {
  errorResult,
  handleToolError,
  type ToolResult,
} from "../shared/types.js";

export interface GetRepoMapParams {
  path?: string;
  max_chars?: number;
  max_files?: number;
  include_external?: boolean;
}

interface DirectorySummary {
  path: string;
  files: number;
  internal_imports: number;
  external_imports: number;
  exports: number;
  symbols: number;
}

interface ExternalDependencySummary {
  specifier: string;
  importer_count: number;
}

interface FileSummary {
  path: string;
  language?: string;
  imports: string[];
  external_imports?: string[];
  exports: string[];
  symbols: string[];
  imported_by: number;
}

const DEFAULT_MAX_CHARS = 20_000;
const MIN_MAX_CHARS = 2_000;
const MAX_MAX_CHARS = 60_000;
const DEFAULT_MAX_FILES = 200;
const MAX_FILES = 1_000;
const MAX_IMPORTS_PER_FILE = 8;
const MAX_EXTERNAL_IMPORTS_PER_FILE = 6;
const MAX_EXPORTS_PER_FILE = 8;
const MAX_SYMBOLS_PER_FILE = 10;

export async function handleGetRepoMap(
  params: GetRepoMapParams,
  structuralGraphProvider: StructuralGraphProvider | undefined,
): Promise<ToolResult> {
  try {
    if (!structuralGraphProvider) {
      return errorResult(
        "get_repo_map is unavailable without global storage context.",
        {
          path: params.path,
        },
      );
    }

    const maxChars = parsePositiveInt(
      params.max_chars ?? DEFAULT_MAX_CHARS,
      "max_chars",
      MIN_MAX_CHARS,
      MAX_MAX_CHARS,
    );
    if (typeof maxChars === "string") {
      return errorResult(maxChars, { path: params.path });
    }

    const maxFiles = parsePositiveInt(
      params.max_files ?? DEFAULT_MAX_FILES,
      "max_files",
      1,
      MAX_FILES,
    );
    if (typeof maxFiles === "string") {
      return errorResult(maxFiles, { path: params.path });
    }

    const workspaceRoot = structuralGraphProvider.resolveWorkspaceRoot(
      params.path,
    );
    if (!workspaceRoot) {
      return errorResult("No workspace folder open.", { path: params.path });
    }

    let scopeRelPath: string | undefined;
    if (params.path) {
      const { absolutePath, inWorkspace } = structuralGraphProvider.resolvePath(
        params.path,
      );
      if (!inWorkspace) {
        return errorResult(
          "Path is outside the current workspace; structural graph data is workspace-scoped.",
          { path: params.path },
        );
      }
      scopeRelPath = normalizeRelPath(
        path.relative(workspaceRoot, absolutePath),
      );
      if (scopeRelPath === ".") scopeRelPath = undefined;
    }

    const { graph, collectionName, structuralCachePath, graphExists } =
      structuralGraphProvider.loadGraph(workspaceRoot);

    const payload = buildRepoMapPayload({
      graph,
      workspaceRoot,
      collectionName,
      structuralCachePath,
      graphExists,
      scopeRelPath,
      maxChars,
      maxFiles,
      includeExternal: params.include_external !== false,
    });

    return {
      content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    };
  } catch (err) {
    return handleToolError(err, { path: params.path });
  }
}

export function buildRepoMapPayload(args: {
  graph: StructuralGraphCache;
  workspaceRoot?: string;
  collectionName?: string;
  structuralCachePath?: string;
  graphExists?: boolean;
  scopeRelPath?: string;
  maxChars?: number;
  maxFiles?: number;
  includeExternal?: boolean;
}): Record<string, unknown> {
  // The public handler rejects invalid user input. The pure builder clamps so
  // tests and future internal callers cannot accidentally construct huge maps.
  const maxChars = clampInteger(
    args.maxChars ?? DEFAULT_MAX_CHARS,
    MIN_MAX_CHARS,
    MAX_MAX_CHARS,
  );
  const maxFiles = clampInteger(
    args.maxFiles ?? DEFAULT_MAX_FILES,
    1,
    MAX_FILES,
  );
  const includeExternal = args.includeExternal !== false;
  const scopeRelPath = normalizeOptionalRelPath(args.scopeRelPath);
  const graphExists = args.graphExists !== false;
  const entries = filterEntriesByScope(args.graph, scopeRelPath);
  const incomingCounts = buildIncomingCounts(args.graph);
  const directoryCandidates = buildDirectorySummaries(entries);
  const externalCandidates = includeExternal
    ? buildExternalDependencySummaries(entries)
    : [];
  const fileCandidates = entries.map((entry) =>
    buildFileSummary(
      entry,
      incomingCounts.get(normalizeRelPath(entry.relPath)) ?? 0,
    ),
  );

  let directories: DirectorySummary[] = [];
  let externalDependencies: ExternalDependencySummary[] = [];
  let files: FileSummary[] = [];

  const make = () =>
    makePayload({
      graph: args.graph,
      workspaceRoot: args.workspaceRoot,
      collectionName: args.collectionName,
      structuralCachePath: args.structuralCachePath,
      graphExists,
      scopeRelPath,
      maxChars,
      maxFiles,
      entries,
      directories,
      directoryTotal: directoryCandidates.length,
      externalDependencies,
      externalDependencyTotal: externalCandidates.length,
      files,
      fileTotal: fileCandidates.length,
      includeExternal,
    });

  for (const candidate of directoryCandidates) {
    const nextDirectories = [...directories, candidate];
    const nextPayload = makePayload({
      graph: args.graph,
      workspaceRoot: args.workspaceRoot,
      collectionName: args.collectionName,
      structuralCachePath: args.structuralCachePath,
      graphExists,
      scopeRelPath,
      maxChars,
      maxFiles,
      entries,
      directories: nextDirectories,
      directoryTotal: directoryCandidates.length,
      externalDependencies,
      externalDependencyTotal: externalCandidates.length,
      files,
      fileTotal: fileCandidates.length,
      includeExternal,
    });
    if (payloadLength(nextPayload) <= maxChars) directories = nextDirectories;
  }

  for (const candidate of externalCandidates) {
    const nextExternalDependencies = [...externalDependencies, candidate];
    const nextPayload = makePayload({
      graph: args.graph,
      workspaceRoot: args.workspaceRoot,
      collectionName: args.collectionName,
      structuralCachePath: args.structuralCachePath,
      graphExists,
      scopeRelPath,
      maxChars,
      maxFiles,
      entries,
      directories,
      directoryTotal: directoryCandidates.length,
      externalDependencies: nextExternalDependencies,
      externalDependencyTotal: externalCandidates.length,
      files,
      fileTotal: fileCandidates.length,
      includeExternal,
    });
    if (payloadLength(nextPayload) <= maxChars) {
      externalDependencies = nextExternalDependencies;
    }
  }

  for (const candidate of fileCandidates) {
    if (files.length >= maxFiles) break;
    const nextFiles = [...files, candidate];
    const nextPayload = makePayload({
      graph: args.graph,
      workspaceRoot: args.workspaceRoot,
      collectionName: args.collectionName,
      structuralCachePath: args.structuralCachePath,
      graphExists,
      scopeRelPath,
      maxChars,
      maxFiles,
      entries,
      directories,
      directoryTotal: directoryCandidates.length,
      externalDependencies,
      externalDependencyTotal: externalCandidates.length,
      files: nextFiles,
      fileTotal: fileCandidates.length,
      includeExternal,
    });
    if (payloadLength(nextPayload) <= maxChars) files = nextFiles;
  }

  return withActualChars(make());
}

function makePayload(args: {
  graph: StructuralGraphCache;
  workspaceRoot?: string;
  collectionName?: string;
  structuralCachePath?: string;
  graphExists: boolean;
  scopeRelPath?: string;
  maxChars: number;
  maxFiles: number;
  entries: StructuralFileEntry[];
  directories: DirectorySummary[];
  directoryTotal: number;
  externalDependencies: ExternalDependencySummary[];
  externalDependencyTotal: number;
  files: FileSummary[];
  fileTotal: number;
  includeExternal: boolean;
}): Record<string, unknown> {
  const omittedFiles = Math.max(0, args.fileTotal - args.files.length);
  const omittedDirectories = Math.max(
    0,
    args.directoryTotal - args.directories.length,
  );
  const omittedExternalDependencies = Math.max(
    0,
    args.externalDependencyTotal - args.externalDependencies.length,
  );

  return {
    workspace_root: args.workspaceRoot ?? args.graph.workspaceRoot,
    cache: {
      collection_name: args.collectionName ?? args.graph.collectionName,
      ...(args.structuralCachePath
        ? { structural_cache_path: args.structuralCachePath }
        : {}),
    },
    freshness: {
      graph: {
        status: args.graphExists ? "available" : "missing",
        generated_at: args.graph.generatedAt,
        file_count: Object.keys(args.graph.files).length,
        cache_version: args.graph.version,
      },
    },
    scope: {
      path: args.scopeRelPath ?? ".",
      matched_files: args.entries.length,
    },
    totals: buildTotals(args.entries),
    directories: {
      items: args.directories,
      total: args.directoryTotal,
      truncated: omittedDirectories > 0,
      omitted: omittedDirectories,
    },
    ...(args.includeExternal
      ? {
          external_dependencies: {
            items: args.externalDependencies,
            total: args.externalDependencyTotal,
            truncated: omittedExternalDependencies > 0,
            omitted: omittedExternalDependencies,
          },
        }
      : {}),
    files: {
      items: args.files,
      total: args.fileTotal,
      truncated: omittedFiles > 0,
      omitted: omittedFiles,
      max_files: args.maxFiles,
    },
    budget: {
      max_chars: args.maxChars,
      actual_chars: args.maxChars,
      truncated:
        omittedFiles > 0 ||
        omittedDirectories > 0 ||
        omittedExternalDependencies > 0,
      omitted_files: omittedFiles,
      omitted_directories: omittedDirectories,
      omitted_external_dependencies: omittedExternalDependencies,
    },
    note: buildNote(args.graphExists, args.entries.length, args.scopeRelPath),
  };
}

function buildTotals(entries: StructuralFileEntry[]): Record<string, number> {
  let imports = 0;
  let internalImports = 0;
  let externalImports = 0;
  let exports = 0;
  let symbols = 0;

  for (const entry of entries) {
    imports += entry.imports.length;
    internalImports += entry.imports.filter(
      (item) => item.resolvedRelPath,
    ).length;
    externalImports += entry.imports.filter((item) => item.external).length;
    exports += entry.exports.length;
    symbols += entry.symbols.length;
  }

  return {
    files: entries.length,
    imports,
    internal_imports: internalImports,
    external_imports: externalImports,
    exports,
    symbols,
  };
}

function buildDirectorySummaries(
  entries: StructuralFileEntry[],
): DirectorySummary[] {
  const byDirectory = new Map<string, DirectorySummary>();

  for (const entry of entries) {
    const dir = normalizeRelPath(path.dirname(entry.relPath));
    const key = dir === "." ? "." : dir;
    const summary = byDirectory.get(key) ?? {
      path: key,
      files: 0,
      internal_imports: 0,
      external_imports: 0,
      exports: 0,
      symbols: 0,
    };
    summary.files += 1;
    summary.internal_imports += entry.imports.filter(
      (item) => item.resolvedRelPath,
    ).length;
    summary.external_imports += entry.imports.filter(
      (item) => item.external,
    ).length;
    summary.exports += entry.exports.length;
    summary.symbols += entry.symbols.length;
    byDirectory.set(key, summary);
  }

  return [...byDirectory.values()].sort(
    (a, b) => b.files - a.files || a.path.localeCompare(b.path),
  );
}

function buildExternalDependencySummaries(
  entries: StructuralFileEntry[],
): ExternalDependencySummary[] {
  const importersBySpecifier = new Map<string, Set<string>>();

  for (const entry of entries) {
    for (const item of entry.imports) {
      if (!item.external) continue;
      const importers =
        importersBySpecifier.get(item.specifier) ?? new Set<string>();
      importers.add(normalizeRelPath(entry.relPath));
      importersBySpecifier.set(item.specifier, importers);
    }
  }

  return [...importersBySpecifier.entries()]
    .map(([specifier, importers]) => ({
      specifier,
      importer_count: importers.size,
    }))
    .sort(
      (a, b) =>
        b.importer_count - a.importer_count ||
        a.specifier.localeCompare(b.specifier),
    );
}

function buildIncomingCounts(graph: StructuralGraphCache): Map<string, number> {
  const incomingCounts = new Map<string, number>();
  for (const entry of Object.values(graph.files)) {
    for (const item of entry.imports) {
      if (!item.resolvedRelPath) continue;
      const target = normalizeRelPath(item.resolvedRelPath);
      incomingCounts.set(target, (incomingCounts.get(target) ?? 0) + 1);
    }
  }
  return incomingCounts;
}

function buildFileSummary(
  entry: StructuralFileEntry,
  importedBy: number,
): FileSummary {
  const internalImports = unique(
    entry.imports
      .map((item) => item.resolvedRelPath)
      .filter((item): item is string => Boolean(item))
      .map(normalizeRelPath),
  );
  const externalImports = unique(
    entry.imports.filter((item) => item.external).map((item) => item.specifier),
  );
  const exports = entry.exports.map((item) =>
    item.kind === "default" ? "default" : item.name,
  );
  const symbols = entry.symbols.map((item) => {
    const exported = item.exported ? "export " : "";
    return `${exported}${item.kind} ${item.name}`;
  });

  return {
    path: normalizeRelPath(entry.relPath),
    ...(entry.language ? { language: entry.language } : {}),
    imports: limitStrings(internalImports, MAX_IMPORTS_PER_FILE),
    ...(externalImports.length > 0
      ? {
          external_imports: limitStrings(
            externalImports,
            MAX_EXTERNAL_IMPORTS_PER_FILE,
          ),
        }
      : {}),
    exports: limitStrings(exports, MAX_EXPORTS_PER_FILE),
    symbols: limitStrings(symbols, MAX_SYMBOLS_PER_FILE),
    imported_by: importedBy,
  };
}

function filterEntriesByScope(
  graph: StructuralGraphCache,
  scopeRelPath: string | undefined,
): StructuralFileEntry[] {
  const entries = Object.values(graph.files).sort((a, b) =>
    normalizeRelPath(a.relPath).localeCompare(normalizeRelPath(b.relPath)),
  );
  if (!scopeRelPath) return entries;

  return entries.filter((entry) => {
    const relPath = normalizeRelPath(entry.relPath);
    return relPath === scopeRelPath || relPath.startsWith(`${scopeRelPath}/`);
  });
}

function buildNote(
  graphExists: boolean,
  matchedFiles: number,
  scopeRelPath: string | undefined,
): string | undefined {
  if (!graphExists) {
    return "Structural sidecar cache is missing. Build or refresh the codebase index before relying on the repo map.";
  }
  if (matchedFiles === 0) {
    return scopeRelPath
      ? "No indexed files matched the requested scope. The path may be unindexed, ignored, unsupported, or awaiting the next index refresh."
      : "Structural sidecar cache is available but contains no indexed files.";
  }
  return undefined;
}

function parsePositiveInt(
  value: number,
  name: string,
  min: number,
  max: number,
): number | string {
  const parsed = Math.trunc(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return `Invalid ${name}: ${value}. Must be a positive number.`;
  }
  if (parsed < min) {
    return `Invalid ${name}: ${value}. Must be at least ${min}.`;
  }
  return Math.min(parsed, max);
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

function limitStrings(items: string[], limit: number): string[] {
  const uniqueItems = unique(items);
  const limited = uniqueItems.slice(0, limit);
  if (uniqueItems.length > limit) {
    limited.push(`… ${uniqueItems.length - limit} more`);
  }
  return limited;
}

function unique(items: string[]): string[] {
  return [...new Set(items)].sort((a, b) => a.localeCompare(b));
}

function withActualChars(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  let nextPayload = payload;
  for (let i = 0; i < 5; i++) {
    const actualChars = payloadLength(nextPayload);
    const candidate = {
      ...nextPayload,
      budget: {
        ...(nextPayload.budget as Record<string, unknown>),
        actual_chars: actualChars,
      },
    };
    if (payloadLength(candidate) === actualChars) return candidate;
    nextPayload = candidate;
  }
  return nextPayload;
}

function payloadLength(payload: Record<string, unknown>): number {
  return JSON.stringify(payload, null, 2).length;
}

function normalizeOptionalRelPath(
  relPath: string | undefined,
): string | undefined {
  if (!relPath) return undefined;
  const normalized = normalizeRelPath(relPath).replace(/^\.\//, "");
  return normalized === "." || normalized === "" ? undefined : normalized;
}

function normalizeRelPath(relPath: string): string {
  return relPath.replace(/\\/g, "/");
}
