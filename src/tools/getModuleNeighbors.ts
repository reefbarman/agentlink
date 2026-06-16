import * as path from "path";

import type { StructuralGraphProvider } from "../core/capabilities/readSearch.js";
import type {
  StructuralFileEntry,
  StructuralGraphCache,
  StructuralImport,
} from "../indexer/structuralGraph.js";
import {
  errorResult,
  handleToolError,
  successResult,
  type ToolResult,
} from "../shared/types.js";

export interface GetModuleNeighborsParams {
  path: string;
  max_results?: number;
}

interface LimitedList<T> {
  items: T[];
  total: number;
  truncated: boolean;
}

interface DependentEntry {
  path: string;
  imports: StructuralImport[];
}

const DEFAULT_MAX_RESULTS = 50;
const MAX_RESULTS = 200;

export async function handleGetModuleNeighbors(
  params: GetModuleNeighborsParams,
  structuralGraphProvider: StructuralGraphProvider | undefined,
): Promise<ToolResult> {
  try {
    if (!structuralGraphProvider) {
      return errorResult(
        "get_module_neighbors is unavailable without global storage context.",
        { path: params.path },
      );
    }

    const rawLimit = Math.trunc(params.max_results ?? DEFAULT_MAX_RESULTS);
    if (!Number.isFinite(rawLimit) || rawLimit <= 0) {
      return errorResult(
        `Invalid max_results: ${params.max_results}. Must be a positive number.`,
        { path: params.path },
      );
    }
    const limit = Math.min(rawLimit, MAX_RESULTS);

    const { absolutePath, inWorkspace } = structuralGraphProvider.resolvePath(
      params.path,
    );
    if (!inWorkspace) {
      return errorResult(
        "Path is outside the current workspace; structural graph data is workspace-scoped.",
        { path: params.path },
      );
    }

    const workspaceRoot =
      structuralGraphProvider.getWorkspaceRootForPath(absolutePath);
    if (!workspaceRoot) {
      return errorResult("No workspace folder owns this path.", {
        path: params.path,
      });
    }

    const { graph, collectionName, structuralCachePath, graphExists } =
      structuralGraphProvider.loadGraph(workspaceRoot);

    const targetRelPath = normalizeRelPath(
      path.relative(workspaceRoot, absolutePath),
    );
    const target = findEntry(graph, targetRelPath);
    const dependents = findDependents(graph, targetRelPath);
    const targetFreshness = structuralGraphProvider.getTargetFreshness(
      absolutePath,
      target,
    );

    return successResult({
      path: targetRelPath,
      workspace_root: workspaceRoot,
      cache: {
        collection_name: collectionName,
        structural_cache_path: structuralCachePath,
      },
      freshness: {
        target: targetFreshness,
        graph: {
          status: graphExists ? "available" : "missing",
          generated_at: graph.generatedAt,
          file_count: Object.keys(graph.files).length,
          cache_version: graph.version,
        },
      },
      imports: limitList(target?.imports ?? [], limit),
      exports: limitList(target?.exports ?? [], limit),
      symbols: limitList(target?.symbols ?? [], limit),
      dependents: limitList(dependents, limit),
      note: buildNote(target, graphExists, targetFreshness.status),
    });
  } catch (err) {
    return handleToolError(err, { path: params.path });
  }
}

export function buildModuleNeighborsPayload(args: {
  graph: StructuralGraphCache;
  targetRelPath: string;
  targetFreshness?: Record<string, unknown>;
  graphExists?: boolean;
  maxResults?: number;
}): Record<string, unknown> {
  const limit = Math.min(
    Math.max(1, Math.trunc(args.maxResults ?? DEFAULT_MAX_RESULTS)),
    MAX_RESULTS,
  );
  const targetRelPath = normalizeRelPath(args.targetRelPath);
  const target = findEntry(args.graph, targetRelPath);
  const targetFreshness = args.targetFreshness ?? {
    status: target ? "unknown" : "missing_from_graph",
  };

  return {
    path: targetRelPath,
    freshness: {
      target: targetFreshness,
      graph: {
        status: args.graphExists === false ? "missing" : "available",
        generated_at: args.graph.generatedAt,
        file_count: Object.keys(args.graph.files).length,
        cache_version: args.graph.version,
      },
    },
    imports: limitList(target?.imports ?? [], limit),
    exports: limitList(target?.exports ?? [], limit),
    symbols: limitList(target?.symbols ?? [], limit),
    dependents: limitList(findDependents(args.graph, targetRelPath), limit),
    note: buildNote(target, args.graphExists !== false, targetFreshness.status),
  };
}

function findEntry(
  graph: StructuralGraphCache,
  targetRelPath: string,
): StructuralFileEntry | undefined {
  return (
    graph.files[targetRelPath] ??
    Object.values(graph.files).find((entry) => {
      return normalizeRelPath(entry.relPath) === targetRelPath;
    })
  );
}

function findDependents(
  graph: StructuralGraphCache,
  targetRelPath: string,
): DependentEntry[] {
  const dependents: DependentEntry[] = [];
  for (const entry of Object.values(graph.files)) {
    const relPath = normalizeRelPath(entry.relPath);
    if (relPath === targetRelPath) continue;
    const imports = entry.imports.filter(
      (candidate) =>
        candidate.resolvedRelPath !== undefined &&
        normalizeRelPath(candidate.resolvedRelPath) === targetRelPath,
    );
    if (imports.length > 0) {
      dependents.push({ path: relPath, imports });
    }
  }
  dependents.sort((a, b) => a.path.localeCompare(b.path));
  return dependents;
}

function limitList<T>(items: T[], limit: number): LimitedList<T> {
  return {
    items: items.slice(0, limit),
    total: items.length,
    truncated: items.length > limit,
  };
}

function buildNote(
  target: StructuralFileEntry | undefined,
  graphExists: boolean,
  targetStatus: unknown,
): string | undefined {
  if (!graphExists) {
    return "Structural sidecar cache is missing. Build or refresh the codebase index before relying on module neighbors.";
  }
  if (!target) {
    return "Target file is not present in the structural graph. It may be unindexed, ignored, too large, unsupported, or awaiting the next index refresh.";
  }
  if (targetStatus === "stale") {
    return "Target file has changed since the structural graph entry was indexed. Refresh the codebase index before relying on this result.";
  }
  return undefined;
}

function normalizeRelPath(relPath: string): string {
  return relPath.replace(/\\/g, "/");
}
