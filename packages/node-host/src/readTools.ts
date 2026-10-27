import {
  defineTool,
  type AgentPrincipal,
  type HostToolResolver,
} from "@agentlink/core";
import {
  parseRegexSearchFilesParams,
  regexSearchFilesInputSchema,
  SEARCH_FILES_DEFAULT_MAX_RESULTS,
} from "@agentlink/core/search-files";
import path from "node:path";

import {
  createNodeHostLocalFileSystem,
  type NodeHostFileSystem,
} from "./fileSystem.js";
import { searchNodeHostFiles } from "./regexSearch.js";
import { redactNodeHostStructuredConfig } from "./structuredConfigRedaction.js";

const MAX_FILE_BYTES = 1_000_000;
const MAX_LINE_LENGTH = 500;
const MAX_READ_LINES = 200;
const MAX_LIST_ENTRIES = 200;
const MAX_SEARCH_RESULTS = SEARCH_FILES_DEFAULT_MAX_RESULTS;
const MAX_SEARCH_DEPTH = 5;

type NodeReadGrantKind = "file" | "directory";

/** A host-approved, canonicalized read scope. No implicit working directory exists. */
export interface NodeHostReadGrant {
  readonly rootPath: string;
  readonly kind: NodeReadGrantKind;
}

export interface ResolveNodeHostReadGrantsRequest<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> {
  readonly principal: TPrincipal;
  readonly sessionId: string;
  readonly turnId: string;
}

export type ResolveNodeHostReadGrants<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> = (
  request: ResolveNodeHostReadGrantsRequest<TPrincipal>,
) => readonly NodeHostReadGrant[] | Promise<readonly NodeHostReadGrant[]>;

export interface CreateNodeHostReadToolsOptions<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> {
  readonly resolveGrants: ResolveNodeHostReadGrants<TPrincipal>;
  readonly maxFileBytes?: number;
  readonly maxListEntries?: number;
  /** Upper bound for search_files `max_results` (default and maximum 300). */
  readonly maxSearchResults?: number;
  /** Maximum list_files depth (default and maximum 5). */
  readonly maxSearchDepth?: number;
  /** Optional host policy checked before files or directories are listed or read. */
  readonly shouldIncludePath?: (absolutePath: string) => boolean;
  /** Display path for search_files results. Defaults to the absolute path. */
  readonly formatSearchPath?: (absolutePath: string) => string;
  /** Filesystem used for every read. Defaults to this machine's filesystem. */
  readonly fileSystem?: NodeHostFileSystem;
}

/**
 * Create read-only local tools that operate only inside host-provided grants.
 * C1 deliberately excludes semantic search, shell/ripgrep execution, writes,
 * and implicit current-working-directory access. `search_files` follows VS
 * Code's regex contract through a Node filesystem walk.
 */
export function createNodeHostReadTools<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
>(
  options: CreateNodeHostReadToolsOptions<TPrincipal>,
): HostToolResolver<TPrincipal> {
  const maxFileBytes = boundedPositiveInteger(
    options.maxFileBytes ?? MAX_FILE_BYTES,
    "maxFileBytes",
    MAX_FILE_BYTES,
  );
  const maxListEntries = boundedPositiveInteger(
    options.maxListEntries ?? MAX_LIST_ENTRIES,
    "maxListEntries",
    MAX_LIST_ENTRIES,
  );
  const maxSearchResults = boundedPositiveInteger(
    options.maxSearchResults ?? MAX_SEARCH_RESULTS,
    "maxSearchResults",
    MAX_SEARCH_RESULTS,
  );
  const maxSearchDepth = boundedNonNegativeInteger(
    options.maxSearchDepth ?? MAX_SEARCH_DEPTH,
    "maxSearchDepth",
    MAX_SEARCH_DEPTH,
  );
  const files = options.fileSystem ?? createNodeHostLocalFileSystem();

  return async (request) => {
    const grants = await resolveGrantedRoots(
      files,
      options.resolveGrants,
      request,
    );
    const resolve = (input: Record<string, unknown>) =>
      resolveGrantedPath(files, input.path, grants);

    return [
      defineTool<TPrincipal>({
        name: "read_file",
        description:
          "Read a text file only inside an explicit host-approved read grant.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", minLength: 1 },
            offset: { type: "integer", minimum: 1 },
            limit: { type: "integer", minimum: 1, maximum: MAX_READ_LINES },
          },
          required: ["path"],
          additionalProperties: false,
        },
        effect: "read",
        displayInput: (input) => ({ path: input.path }),
        handler: async (input) => {
          const resolved = await resolve(input);
          if (!resolved.ok) return error(resolved.error);
          const stat = await files.stat(resolved.path).catch(() => undefined);
          if (stat?.kind !== "file") return error("not_a_file");
          if (stat.size > maxFileBytes) return error("file_too_large");
          const bytes = await files.readFile(resolved.path);
          if (isBinary(bytes)) return error("binary_file");
          const redacted = redactNodeHostStructuredConfig(
            resolved.path,
            bytes.toString("utf8"),
          );
          const lines = redacted.content.split(/\r?\n/u);
          const offset = readBoundedInteger(
            input.offset,
            1,
            1,
            lines.length || 1,
          );
          const limit = readBoundedInteger(
            input.limit,
            MAX_READ_LINES,
            1,
            MAX_READ_LINES,
          );
          const selected = lines.slice(offset - 1, offset - 1 + limit);
          const payload = {
            path: resolved.path,
            offset,
            totalLines: lines.length,
            truncated: offset - 1 + selected.length < lines.length,
            text: selected
              .map((line, index) => `${offset + index} | ${boundText(line)}`)
              .join("\n"),
            ...(redacted.redacted ? { redacted: true } : {}),
          };
          return {
            modelContent: JSON.stringify(payload),
            displayContent: {
              path: resolved.path,
              lines: selected.length,
              truncated: payload.truncated,
            },
          };
        },
      }),
      defineTool<TPrincipal>({
        name: "list_files",
        description:
          "List files only inside an explicit host-approved directory read grant.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", minLength: 1 },
            recursive: { type: "boolean" },
            depth: { type: "integer", minimum: 0, maximum: MAX_SEARCH_DEPTH },
          },
          required: ["path"],
          additionalProperties: false,
        },
        effect: "read",
        displayInput: (input) => ({ path: input.path }),
        handler: async (input) => {
          const resolved = await resolve(input);
          if (!resolved.ok) return error(resolved.error);
          const stat = await files.stat(resolved.path).catch(() => undefined);
          if (stat?.kind !== "directory") return error("not_a_directory");
          const recursive =
            input.recursive === true || input.depth !== undefined;
          const depth = recursive
            ? readBoundedInteger(input.depth, 2, 0, maxSearchDepth)
            : 0;
          const entries: string[] = [];
          await visitDirectory({
            files,
            directory: resolved.path,
            displayRoot: resolved.path,
            rootPath: resolved.rootPath,
            shouldIncludePath: options.shouldIncludePath,
            depth: 0,
            maxDepth: depth,
            limit: maxListEntries,
            entries,
          });
          entries.sort((first, second) => first.localeCompare(second));
          const payload = {
            path: resolved.path,
            entries,
            count: entries.length,
            truncated: entries.length >= maxListEntries,
          };
          return {
            modelContent: JSON.stringify(payload),
            displayContent: {
              path: resolved.path,
              count: entries.length,
              truncated: payload.truncated,
            },
          };
        },
      }),
      defineTool<TPrincipal>({
        name: "search_files",
        description:
          "Search a file or directory inside an explicit host-approved read grant with a regex, matching VS Code's search_files contract. output_mode selects matching lines with context (content, default), file paths (files_with_matches), or per-file counts (count); file_pattern filters files by glob, context/context_before/context_after set context lines, case_insensitive and multiline adjust matching, and offset with max_results pages results. Hidden entries, .git and node_modules are skipped and structured-config secrets are redacted. This is not semantic search.",
        inputSchema: regexSearchFilesInputSchema({
          pathDescription: "Absolute file or directory inside a read grant.",
          maxResults: maxSearchResults,
        }),
        effect: "read",
        parallelSafe: true,
        displayInput: (input) => ({ path: input.path, regex: input.regex }),
        handler: async (input, context) => {
          const resolved = await resolve(input);
          if (!resolved.ok) return error(resolved.error);
          if (options.shouldIncludePath?.(resolved.path) === false) {
            return error("path_not_granted");
          }
          const params = parseRegexSearchFilesParams(input);
          const result = await searchNodeHostFiles({
            files,
            target: resolved.path,
            rootPath: resolved.rootPath,
            params: {
              ...params,
              max_results: Math.min(
                params.max_results ?? maxSearchResults,
                maxSearchResults,
              ),
            },
            maxFileBytes,
            ...(options.shouldIncludePath
              ? { shouldIncludePath: options.shouldIncludePath }
              : {}),
            ...(options.formatSearchPath
              ? { formatPath: options.formatSearchPath }
              : {}),
            ...(context?.signal ? { signal: context.signal } : {}),
          });
          const pick = (key: string) =>
            result.payload[key] !== undefined
              ? { [key]: result.payload[key] }
              : {};
          return {
            modelContent: JSON.stringify(result.payload),
            displayContent: {
              path: resolved.path,
              output_mode: params.output_mode ?? "content",
              ...pick("total_matches"),
              ...pick("total_files"),
              ...pick("truncated"),
              ...pick("offset"),
              ...pick("error"),
            },
            ...(result.isError ? { isError: true } : {}),
          };
        },
      }),
    ];
  };
}

interface GrantedRoot {
  readonly path: string;
  readonly kind: NodeReadGrantKind;
}

async function resolveGrantedRoots<TPrincipal extends AgentPrincipal>(
  files: NodeHostFileSystem,
  resolveGrants: ResolveNodeHostReadGrants<TPrincipal>,
  request: ResolveNodeHostReadGrantsRequest<TPrincipal>,
): Promise<readonly GrantedRoot[]> {
  const roots: GrantedRoot[] = [];
  for (const grant of await resolveGrants(request)) {
    if (!path.isAbsolute(grant.rootPath)) continue;
    const realPath = await files
      .realpath(grant.rootPath)
      .catch(() => undefined);
    if (realPath) roots.push({ path: realPath, kind: grant.kind });
  }
  return roots;
}

async function resolveGrantedPath(
  files: NodeHostFileSystem,
  input: unknown,
  grants: readonly GrantedRoot[],
): Promise<
  { ok: true; path: string; rootPath: string } | { ok: false; error: string }
> {
  if (typeof input !== "string" || !path.isAbsolute(input)) {
    return { ok: false, error: "absolute_path_required" };
  }
  const requested = path.resolve(input);
  const resolved = await files.realpath(requested).catch(() => undefined);
  if (!resolved) return { ok: false, error: "path_not_found" };
  if (resolved !== requested) return { ok: false, error: "path_alias" };
  for (const grant of grants) {
    if (
      (grant.kind === "file" && resolved === grant.path) ||
      (grant.kind === "directory" && isPathWithin(resolved, grant.path))
    ) {
      return { ok: true, path: resolved, rootPath: grant.path };
    }
  }
  return { ok: false, error: "path_not_granted" };
}

async function visitDirectory(options: {
  readonly files: NodeHostFileSystem;
  readonly directory: string;
  readonly displayRoot: string;
  readonly rootPath: string;
  readonly depth: number;
  readonly maxDepth: number;
  readonly limit: number;
  readonly entries: string[];
  readonly shouldIncludePath?: (absolutePath: string) => boolean;
}): Promise<void> {
  if (options.entries.length >= options.limit) return;
  const { files } = options;
  const directory = await files
    .realpath(options.directory)
    .catch(() => undefined);
  if (!directory || !isPathWithin(directory, options.rootPath)) return;
  for (const entry of await files.readDirectory(directory)) {
    if (options.entries.length >= options.limit) return;
    if (entry.kind === "symlink") continue;
    const requestedChild = path.join(directory, entry.name);
    if (options.shouldIncludePath?.(requestedChild) === false) continue;
    const child = await files.realpath(requestedChild).catch(() => undefined);
    if (!child || !isPathWithin(child, options.rootPath)) continue;
    const stat = await files.stat(child).catch(() => undefined);
    if (!stat) continue;
    const relative = path.relative(options.displayRoot, child) || entry.name;
    options.entries.push(stat.kind === "directory" ? `${relative}/` : relative);
    if (stat.kind === "directory" && options.depth < options.maxDepth) {
      await visitDirectory({
        ...options,
        directory: child,
        depth: options.depth + 1,
      });
    }
  }
}

function isPathWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function isBinary(bytes: Uint8Array): boolean {
  return bytes.includes(0);
}

function boundText(value: string): string {
  return value.length <= MAX_LINE_LENGTH
    ? value
    : `${value.slice(0, MAX_LINE_LENGTH - 1)}…`;
}

function readBoundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const candidate = typeof value === "number" ? Math.floor(value) : fallback;
  return Math.max(minimum, Math.min(maximum, candidate));
}

function boundedPositiveInteger(
  value: number,
  label: string,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${label} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

function boundedNonNegativeInteger(
  value: number,
  label: string,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new Error(`${label} must be an integer between 0 and ${maximum}`);
  }
  return value;
}

function error(code: string) {
  return { modelContent: JSON.stringify({ error: code }), isError: true };
}
