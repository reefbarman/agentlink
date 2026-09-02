import {
  defineTool,
  type AgentPrincipal,
  type HostToolResolver,
} from "@agentlink/core";
import { promises as fs } from "node:fs";
import path from "node:path";

const MAX_FILE_BYTES = 1_000_000;
const MAX_LINE_LENGTH = 500;
const MAX_READ_LINES = 200;
const MAX_LIST_ENTRIES = 200;
const MAX_SEARCH_RESULTS = 100;
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
  readonly maxSearchResults?: number;
  readonly maxSearchDepth?: number;
}

/**
 * Create read-only local tools that operate only inside host-provided grants.
 * C1 deliberately excludes semantic search, shell/ripgrep execution, writes,
 * and implicit current-working-directory access.
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

  return async (request) => {
    const grants = await resolveGrantedRoots(options.resolveGrants, request);
    const resolve = (input: Record<string, unknown>) =>
      resolveGrantedPath(input.path, grants);

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
          const stat = await fs.stat(resolved.path).catch(() => undefined);
          if (!stat?.isFile()) return error("not_a_file");
          if (stat.size > maxFileBytes) return error("file_too_large");
          const bytes = await fs.readFile(resolved.path);
          if (isBinary(bytes)) return error("binary_file");
          const redacted = redactStructuredConfig(
            resolved.path,
            bytes.toString("utf8"),
          );
          if (redacted.error) return error(redacted.error);
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
          const stat = await fs.stat(resolved.path).catch(() => undefined);
          if (!stat?.isDirectory()) return error("not_a_directory");
          const recursive =
            input.recursive === true || input.depth !== undefined;
          const depth = recursive
            ? readBoundedInteger(input.depth, 2, 0, maxSearchDepth)
            : 0;
          const entries: string[] = [];
          await visitDirectory({
            directory: resolved.path,
            displayRoot: resolved.path,
            rootPath: resolved.rootPath,
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
          "Search text files only inside an explicit host-approved read grant. This is bounded regex search, not semantic search.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", minLength: 1 },
            regex: { type: "string", minLength: 1, maxLength: 1_000 },
            maxResults: {
              type: "integer",
              minimum: 1,
              maximum: MAX_SEARCH_RESULTS,
            },
          },
          required: ["path", "regex"],
          additionalProperties: false,
        },
        effect: "read",
        displayInput: (input) => ({ path: input.path, regex: input.regex }),
        handler: async (input) => {
          const resolved = await resolve(input);
          if (!resolved.ok) return error(resolved.error);
          const regexText = typeof input.regex === "string" ? input.regex : "";
          let regex: RegExp;
          try {
            regex = new RegExp(regexText, "i");
          } catch {
            return error("invalid_regex");
          }
          const limit = readBoundedInteger(
            input.maxResults,
            maxSearchResults,
            1,
            maxSearchResults,
          );
          const matches: Array<{ path: string; line: number; text: string }> =
            [];
          await searchPath({
            target: resolved.path,
            rootPath: resolved.rootPath,
            maxDepth: maxSearchDepth,
            depth: 0,
            limit,
            regex,
            matches,
          });
          const payload = {
            path: resolved.path,
            matches,
            count: matches.length,
            truncated: matches.length >= limit,
          };
          return {
            modelContent: JSON.stringify(payload),
            displayContent: {
              path: resolved.path,
              count: matches.length,
              truncated: payload.truncated,
            },
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
  resolveGrants: ResolveNodeHostReadGrants<TPrincipal>,
  request: ResolveNodeHostReadGrantsRequest<TPrincipal>,
): Promise<readonly GrantedRoot[]> {
  const roots: GrantedRoot[] = [];
  for (const grant of await resolveGrants(request)) {
    if (!path.isAbsolute(grant.rootPath)) continue;
    const realPath = await fs.realpath(grant.rootPath).catch(() => undefined);
    if (realPath) roots.push({ path: realPath, kind: grant.kind });
  }
  return roots;
}

async function resolveGrantedPath(
  input: unknown,
  grants: readonly GrantedRoot[],
): Promise<
  { ok: true; path: string; rootPath: string } | { ok: false; error: string }
> {
  if (typeof input !== "string" || !path.isAbsolute(input)) {
    return { ok: false, error: "absolute_path_required" };
  }
  const resolved = await fs.realpath(input).catch(() => undefined);
  if (!resolved) return { ok: false, error: "path_not_found" };
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
  readonly directory: string;
  readonly displayRoot: string;
  readonly rootPath: string;
  readonly depth: number;
  readonly maxDepth: number;
  readonly limit: number;
  readonly entries: string[];
}): Promise<void> {
  if (options.entries.length >= options.limit) return;
  const directory = await fs.realpath(options.directory).catch(() => undefined);
  if (!directory || !isPathWithin(directory, options.rootPath)) return;
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (options.entries.length >= options.limit) return;
    const child = await fs
      .realpath(path.join(directory, entry.name))
      .catch(() => undefined);
    if (!child || !isPathWithin(child, options.rootPath)) continue;
    const stat = await fs.stat(child).catch(() => undefined);
    if (!stat) continue;
    const relative = path.relative(options.displayRoot, child) || entry.name;
    options.entries.push(stat.isDirectory() ? `${relative}/` : relative);
    if (stat.isDirectory() && options.depth < options.maxDepth) {
      await visitDirectory({
        ...options,
        directory: child,
        depth: options.depth + 1,
      });
    }
  }
}

async function searchPath(options: {
  readonly target: string;
  readonly rootPath: string;
  readonly maxDepth: number;
  readonly depth: number;
  readonly limit: number;
  readonly regex: RegExp;
  readonly matches: Array<{ path: string; line: number; text: string }>;
}): Promise<void> {
  if (
    options.matches.length >= options.limit ||
    options.depth > options.maxDepth
  )
    return;
  const target = await fs.realpath(options.target).catch(() => undefined);
  if (!target || !isPathWithin(target, options.rootPath)) return;
  const stat = await fs.stat(target).catch(() => undefined);
  if (!stat) return;
  if (stat.isFile()) {
    const bytes = await fs.readFile(target).catch(() => undefined);
    if (!bytes || bytes.length > MAX_FILE_BYTES || isBinary(bytes)) return;
    const redacted = redactStructuredConfig(target, bytes.toString("utf8"));
    if (redacted.error) return;
    for (const [index, line] of redacted.content.split(/\r?\n/u).entries()) {
      if (options.matches.length >= options.limit) return;
      if (options.regex.test(line)) {
        options.matches.push({
          path: target,
          line: index + 1,
          text: boundText(line),
        });
      }
    }
    return;
  }
  if (!stat.isDirectory()) return;
  for (const entry of await fs.readdir(target, { withFileTypes: true })) {
    if (options.matches.length >= options.limit) return;
    await searchPath({
      ...options,
      target: path.join(target, entry.name),
      depth: options.depth + 1,
    });
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

function redactStructuredConfig(
  filePath: string,
  content: string,
):
  | { content: string; redacted: boolean; error?: never }
  | {
      content: string;
      redacted: boolean;
      error: string;
    } {
  if (!isStructuredConfigPath(filePath)) return { content, redacted: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return {
      content: "",
      redacted: false,
      error: "malformed_structured_config",
    };
  }
  const redacted = redactStructuredValue(parsed);
  return {
    content: `${JSON.stringify(redacted.value, null, 2)}\n`,
    redacted: redacted.changed,
  };
}

function isStructuredConfigPath(filePath: string): boolean {
  const base = path.basename(filePath).toLowerCase();
  return (
    base.endsWith(".json") ||
    base.endsWith(".jsonc") ||
    base.includes("config") ||
    base.includes("settings")
  );
}

function redactStructuredValue(value: unknown): {
  value: unknown;
  changed: boolean;
} {
  if (Array.isArray(value)) {
    const entries = value.map(redactStructuredValue);
    return {
      value: entries.map((entry) => entry.value),
      changed: entries.some((entry) => entry.changed),
    };
  }
  if (!value || typeof value !== "object") return { value, changed: false };
  let changed = false;
  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (/(api[-_]?key|auth|credential|password|secret|token)/iu.test(key)) {
      result[key] = "[REDACTED]";
      changed = true;
      continue;
    }
    const redacted = redactStructuredValue(nested);
    result[key] = redacted.value;
    changed ||= redacted.changed;
  }
  return { value: result, changed };
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
