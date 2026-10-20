// get_repo_map and get_module_neighbors for standalone hosts, backed by the
// shared StandaloneStructuralIndex and limited to the session's file scopes.
// IMPORTANT: No `vscode` or LanceDB imports (see standaloneBoundary.test.ts).

import {
  defineTool,
  type AgentPrincipal,
  type HostTool,
  type HostToolResolver,
  type HostToolResult,
} from "@agentlink/core";
import type { ToolResult } from "@agentlink/protocol/tool-result";
import * as fs from "node:fs";
import * as path from "node:path";

import type { StructuralGraphProvider } from "../../core/capabilities/readSearch.js";
import { handleGetModuleNeighbors } from "../../tools/getModuleNeighbors.js";
import { handleGetRepoMap } from "../../tools/getRepoMap.js";
import { canonicalizePath } from "../../util/canonicalPath.js";
import { resolveContainedCodeIndexPath } from "../codeIndexPaths.js";
import type { StructuralGraphCache } from "../structuralGraph.js";
import { hashContent } from "../workerLib.js";
import type {
  StandaloneStructuralIndex,
  StandaloneStructuralReadResult,
} from "./StandaloneStructuralIndex.js";

/** The same shape as workspace-host's WorkspaceFileScope. */
export interface StructuralIndexScope {
  readonly path: string;
  readonly kind: "file" | "directory";
  readonly access?: "read" | "write" | "read_write";
}

export interface StructuralIndexScopeRequest {
  readonly principal: AgentPrincipal;
  readonly sessionId: string;
  readonly turnId: string;
}

export interface CreateStructuralIndexToolsOptions {
  readonly index: StandaloneStructuralIndex;
  /** The session's current file scopes, read on every call. */
  readonly resolveScopes: (
    request: StructuralIndexScopeRequest,
  ) => Promise<readonly StructuralIndexScope[]>;
}

export function createStructuralIndexTools(
  options: CreateStructuralIndexToolsOptions,
): HostToolResolver {
  const tools = [repoMapTool(options), moduleNeighborsTool(options)];
  return () => tools;
}

function repoMapTool(options: CreateStructuralIndexToolsOptions): HostTool {
  return defineTool({
    name: "get_repo_map",
    description:
      "Return a budgeted structural skeleton of this project from the shared code index: aggregate counts, directory summaries, external dependency summaries, and prioritized file entries with imports, exports and top-level symbols. Use before broad edits to understand module boundaries, then drill into files with get_module_neighbors. The index is built on first use and refreshed from changed files on every call; only files you may read are included.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: {
          type: "string",
          description:
            "Optional project-relative file or directory to limit the map to. Omit for the whole project.",
        },
        max_chars: {
          type: "integer",
          description:
            "Hard output budget in characters for the JSON payload (default 20000, minimum 2000, capped at 60000).",
        },
        max_files: {
          type: "integer",
          description:
            "Maximum file skeleton entries to include before budget truncation (default 200, capped at 1000).",
        },
        include_external: {
          type: "boolean",
          description:
            "Include summarized external dependency specifiers (default true). This does not read external repositories.",
        },
      },
    },
    displayInput: (input) => input,
    effect: "read",
    parallelSafe: true,
    presentation: { title: "Repo map" },
    handler: async (input, context) =>
      await run(options, context, input.path, async (provider) =>
        handleGetRepoMap(
          {
            ...(typeof input.path === "string" ? { path: input.path } : {}),
            ...(typeof input.max_chars === "number"
              ? { max_chars: input.max_chars }
              : {}),
            ...(typeof input.max_files === "number"
              ? { max_files: input.max_files }
              : {}),
            ...(typeof input.include_external === "boolean"
              ? { include_external: input.include_external }
              : {}),
          },
          provider,
        ),
      ),
  });
}

function moduleNeighborsTool(
  options: CreateStructuralIndexToolsOptions,
): HostTool {
  return defineTool({
    name: "get_module_neighbors",
    description:
      "Return one file's imports, exports, top-level symbols and reverse dependents (files that import it) from the shared code index, with freshness metadata. Use before editing a module to see its blast radius. Only files you may read are included.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: {
          type: "string",
          minLength: 1,
          description: "Project-relative source or config file path.",
        },
        max_results: {
          type: "integer",
          description:
            "Maximum items in each list: imports, exports, symbols and dependents (default 50, capped at 200).",
        },
      },
      required: ["path"],
    },
    displayInput: (input) => input,
    effect: "read",
    parallelSafe: true,
    presentation: { title: "Module neighbors" },
    handler: async (input, context) =>
      await run(options, context, input.path, async (provider) =>
        handleGetModuleNeighbors(
          {
            path: String(input.path),
            ...(typeof input.max_results === "number"
              ? { max_results: input.max_results }
              : {}),
          },
          provider,
        ),
      ),
  });
}

async function run(
  options: CreateStructuralIndexToolsOptions,
  context: StructuralIndexScopeRequest & { readonly signal?: AbortSignal },
  requestedPath: unknown,
  query: (provider: StructuralGraphProvider) => Promise<ToolResult>,
): Promise<HostToolResult> {
  const root = options.index.workspaceRoot;
  const isVisible = await createVisibility(
    root,
    await options.resolveScopes(context),
  );
  const relPath =
    typeof requestedPath === "string" && requestedPath.trim()
      ? projectRelativePath(root, requestedPath)
      : "";
  if (relPath === undefined) {
    return failure(
      "Path is outside this project; the code index is project-scoped.",
    );
  }
  let read: StandaloneStructuralReadResult;
  try {
    read = await options.index.read(context.signal);
  } catch (error) {
    return failure(
      `The code index is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  // A directory is readable when any file under it is.
  if (
    relPath &&
    !isVisible(relPath) &&
    !Object.keys(read.graph.files).some(
      (file) => file.startsWith(`${relPath}/`) && isVisible(file),
    )
  ) {
    return failure("path_not_scoped");
  }
  const result = await query(createScopedProvider(root, read, isVisible));
  const text = result.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
  let modelContent = text;
  if (!result.isError) {
    try {
      modelContent = JSON.stringify({
        ...(JSON.parse(text) as Record<string, unknown>),
        index: {
          state: read.state,
          generation: read.generation,
          ...(read.partial ? { partial: true } : {}),
        },
      });
    } catch {
      // Not JSON: return the handler's text unchanged.
    }
  }
  return { modelContent, ...(result.isError ? { isError: true } : {}) };
}

/** A provider over one read, showing only visible files. */
export function createScopedProvider(
  workspaceRoot: string,
  read: StandaloneStructuralReadResult,
  isVisible: (relPath: string) => boolean,
): StructuralGraphProvider {
  const resolvePath = (inputPath: string) => {
    const absolutePath = path.resolve(workspaceRoot, inputPath);
    return {
      absolutePath,
      inWorkspace: projectRelativePath(workspaceRoot, inputPath) !== undefined,
    };
  };
  const graph = projectVisibleGraph(read.graph, isVisible);
  return {
    resolveWorkspaceRoot: (inputPath) =>
      !inputPath || resolvePath(inputPath).inWorkspace
        ? workspaceRoot
        : undefined,
    resolvePath,
    getWorkspaceRootForPath: (absolutePath) =>
      projectRelativePath(workspaceRoot, absolutePath) !== undefined
        ? workspaceRoot
        : undefined,
    loadGraph: async () => ({
      graph,
      workspaceRoot,
      indexName: read.indexName,
      structuralStorePath: read.storePath,
      graphExists: read.generation !== "none",
    }),
    getScopeStatus(absolutePath, matchedFiles) {
      if (matchedFiles > 0) return "indexed";
      try {
        return fs.statSync(absolutePath).isDirectory()
          ? "unindexed"
          : "unindexed_file";
      } catch {
        return "missing";
      }
    },
    getTargetFreshness(absolutePath, target) {
      if (!target) return { status: "missing_from_graph" };
      try {
        const stat = fs.statSync(absolutePath);
        if (!stat.isFile()) {
          return { status: "target_not_file", indexed_at: target.indexedAt };
        }
        const currentHash = hashContent(fs.readFileSync(absolutePath, "utf8"));
        return {
          status: currentHash === target.hash ? "fresh" : "stale",
          indexed_at: target.indexedAt,
          indexed_hash: target.hash,
          current_hash: currentHash,
          size: stat.size,
          mtime_ms: stat.mtimeMs,
        };
      } catch {
        return { status: "target_missing", indexed_at: target.indexedAt };
      }
    },
  };
}

/**
 * Drop hidden files, and the links that would reveal them: a visible file's
 * import or re-export of a hidden file keeps its specifier (it is in the
 * visible source) but loses the resolved path. Counts, directory summaries
 * and dependents are then computed from visible files only.
 */
export function projectVisibleGraph(
  graph: StructuralGraphCache,
  isVisible: (relPath: string) => boolean,
): StructuralGraphCache {
  const files: StructuralGraphCache["files"] = {};
  for (const [relPath, entry] of Object.entries(graph.files)) {
    if (!isVisible(relPath)) continue;
    files[relPath] = {
      ...entry,
      imports: entry.imports.map(({ resolvedRelPath, ...item }) =>
        resolvedRelPath && isVisible(resolvedRelPath)
          ? { ...item, resolvedRelPath }
          : item,
      ),
      exports: entry.exports.map(({ resolvedRelPath, ...item }) =>
        resolvedRelPath && isVisible(resolvedRelPath)
          ? { ...item, resolvedRelPath }
          : item,
      ),
    };
  }
  return { ...graph, files };
}

/** A predicate over canonical project-relative paths for readable scopes. */
export async function createVisibility(
  workspaceRoot: string,
  scopes: readonly StructuralIndexScope[],
): Promise<(relPath: string) => boolean> {
  const rules: { relPath: string; kind: "file" | "directory" }[] = [];
  for (const scope of scopes) {
    if ((scope.access ?? "read_write") === "write") continue;
    const relPath = projectRelativePath(workspaceRoot, scope.path);
    if (relPath === undefined) continue;
    if (relPath === "" && scope.kind === "directory") return () => true;
    rules.push({ relPath, kind: scope.kind });
  }
  return (relPath) =>
    rules.some((rule) =>
      rule.kind === "file"
        ? relPath === rule.relPath
        : relPath === rule.relPath || relPath.startsWith(`${rule.relPath}/`),
    );
}

/**
 * The canonical project-relative path ("" for the root), or undefined when
 * the path (after resolving symlinks) is outside the project.
 */
function projectRelativePath(
  workspaceRoot: string,
  inputPath: string,
): string | undefined {
  const absolute = path.resolve(workspaceRoot, inputPath);
  if (canonicalizePath(absolute) === workspaceRoot) return "";
  return resolveContainedCodeIndexPath(workspaceRoot, absolute)
    ?.portableRelativePath;
}

function failure(message: string): HostToolResult {
  return { modelContent: message, isError: true };
}
