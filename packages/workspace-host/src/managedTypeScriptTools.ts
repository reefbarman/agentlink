import {
  defineTool,
  type HostTool,
  type HostToolExecutionContext,
  type HostToolResolveRequest,
  type HostToolResolver,
} from "@agentlink/core";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  ManagedTypeScriptService,
  type ManagedTypeScriptLocation,
  type ManagedTypeScriptPosition,
  type ManagedTypeScriptQueryResult,
} from "./managedTypeScriptService.js";

export interface CreateManagedTypeScriptToolsOptions {
  readonly projectRoot: string;
  readonly service: ManagedTypeScriptService;
  readonly canReadPath?: (
    request: Pick<HostToolResolveRequest, "principal" | "sessionId" | "turnId">,
    relativePath: string,
  ) => boolean | Promise<boolean>;
}

export interface ManagedTypeScriptTools {
  readonly resolveTools: HostToolResolver;
}

export function createManagedTypeScriptTools(
  options: CreateManagedTypeScriptToolsOptions,
): ManagedTypeScriptTools {
  const projectRoot = path.resolve(options.projectRoot);
  return {
    resolveTools: async (request) => [
      createDiagnosticsTool(request, projectRoot, options),
      createSymbolsTool(request, projectRoot, options),
      createPositionTool(
        "go_to_definition",
        "Resolve a TypeScript or JavaScript symbol definition using the optional managed language server. Paths are project-relative, and positions are 1-indexed.",
        request,
        projectRoot,
        options,
        (filePath, position, context) =>
          options.service.definition(filePath, position, context.signal),
      ),
      createPositionTool(
        "get_references",
        "Find TypeScript or JavaScript symbol references using the optional managed language server. Paths are project-relative, and positions are 1-indexed.",
        request,
        projectRoot,
        options,
        (filePath, position, context, input) =>
          options.service.references(
            filePath,
            position,
            input.include_declaration !== false,
            context.signal,
          ),
        {
          include_declaration: {
            type: "boolean",
            description: "Include the symbol declaration. Defaults to true.",
          },
        },
      ),
      createPositionTool(
        "get_hover",
        "Get TypeScript or JavaScript type and documentation hover information using the optional managed language server. Paths are project-relative, and positions are 1-indexed.",
        request,
        projectRoot,
        options,
        (filePath, position, context) =>
          options.service.hover(filePath, position, context.signal),
      ),
    ],
  };
}

function createDiagnosticsTool(
  discovery: HostToolResolveRequest,
  projectRoot: string,
  options: CreateManagedTypeScriptToolsOptions,
): HostTool {
  return defineTool({
    name: "get_diagnostics",
    description:
      "Get bounded TypeScript or JavaScript diagnostics for one project-relative file. The result explicitly reports ready, stale, unavailable, warming, or failed state, so missing analysis is never presented as zero diagnostics.",
    inputSchema: fileSchema(),
    effect: "read",
    authorization: "none",
    parallelSafe: true,
    handler: async (input, context) =>
      await executeFileQuery(
        discovery,
        context,
        projectRoot,
        options,
        input.path,
        (filePath) => options.service.diagnostics(filePath, context.signal),
      ),
  });
}

function createSymbolsTool(
  discovery: HostToolResolveRequest,
  projectRoot: string,
  options: CreateManagedTypeScriptToolsOptions,
): HostTool {
  return defineTool({
    name: "get_symbols",
    description:
      "Get bounded document symbols for one TypeScript or JavaScript project-relative file through the optional managed language server.",
    inputSchema: fileSchema(),
    effect: "read",
    authorization: "none",
    parallelSafe: true,
    handler: async (input, context) =>
      await executeFileQuery(
        discovery,
        context,
        projectRoot,
        options,
        input.path,
        (filePath) => options.service.symbols(filePath, context.signal),
      ),
  });
}

function createPositionTool(
  name: "go_to_definition" | "get_references" | "get_hover",
  description: string,
  discovery: HostToolResolveRequest,
  projectRoot: string,
  options: CreateManagedTypeScriptToolsOptions,
  query: (
    filePath: string,
    position: ManagedTypeScriptPosition,
    context: HostToolExecutionContext,
    input: Readonly<Record<string, unknown>>,
  ) => Promise<ManagedTypeScriptQueryResult<unknown>>,
  extraProperties: Readonly<Record<string, unknown>> = {},
): HostTool {
  return defineTool({
    name,
    description,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1 },
        line: { type: "integer", minimum: 1 },
        column: { type: "integer", minimum: 1 },
        ...extraProperties,
      },
      required: ["path", "line", "column"],
      additionalProperties: false,
    },
    effect: "read",
    authorization: "none",
    parallelSafe: true,
    handler: async (input, context) => {
      const line = positiveInteger(input.line);
      const column = positiveInteger(input.column);
      if (line === undefined || column === undefined) {
        return toolError("line_and_column_must_be_positive_integers");
      }
      return await executeFileQuery(
        discovery,
        context,
        projectRoot,
        options,
        input.path,
        (filePath) =>
          query(
            filePath,
            { line: line - 1, character: column - 1 },
            context,
            input,
          ),
      );
    },
  });
}

async function executeFileQuery(
  discovery: HostToolResolveRequest,
  context: HostToolExecutionContext,
  projectRoot: string,
  options: CreateManagedTypeScriptToolsOptions,
  inputPath: unknown,
  query: (filePath: string) => Promise<ManagedTypeScriptQueryResult<unknown>>,
) {
  if (!sameTurn(discovery, context)) return toolError("tool_turn_mismatch");
  if (typeof inputPath !== "string" || !inputPath.trim()) {
    return toolError("path_required");
  }
  const resolved = resolveProjectRelativePath(projectRoot, inputPath);
  if (!resolved.ok) return toolError(resolved.reason);
  const canonical = await canonicalProjectFile(
    projectRoot,
    resolved.absolutePath,
  );
  if (!canonical.ok) return toolError(canonical.reason);
  if (
    options.canReadPath &&
    !(await options.canReadPath(discovery, canonical.relativePath))
  ) {
    return toolError("path_not_scoped");
  }
  const result = await query(canonical.absolutePath);
  if (result.state === "ready" || result.state === "stale") {
    const sanitized = await sanitizeManagedTypeScriptResult(
      result,
      projectRoot,
      options.canReadPath
        ? (relativePath) => options.canReadPath!(discovery, relativePath)
        : undefined,
    );
    const text = JSON.stringify(sanitized);
    return {
      content: [{ type: "text" as const, text }],
      modelContent: text,
    };
  }
  const text = JSON.stringify(result);
  return {
    content: [{ type: "text" as const, text }],
    modelContent: text,
    isError: result.state === "failed",
  };
}

export async function sanitizeManagedTypeScriptResult<T>(
  result: ManagedTypeScriptQueryResult<T>,
  projectRoot: string,
  canReadPath?: (relativePath: string) => boolean | Promise<boolean>,
): Promise<
  ManagedTypeScriptQueryResult<unknown> & { readonly omittedLocations?: number }
> {
  if (result.state !== "ready" && result.state !== "stale") return result;
  const normalized = await normalizeLocations(
    result.value,
    projectRoot,
    canReadPath,
  );
  return {
    ...result,
    metadata: { ...result.metadata, projectRoot: "." },
    value: normalized.value,
    ...(normalized.omittedLocations > 0
      ? { omittedLocations: normalized.omittedLocations }
      : {}),
  };
}

interface NormalizedLocations {
  readonly value: unknown;
  readonly omittedLocations: number;
  readonly omitSelf?: true;
}

async function normalizeLocations(
  value: unknown,
  projectRoot: string,
  canReadPath?: (relativePath: string) => boolean | Promise<boolean>,
): Promise<NormalizedLocations> {
  if (Array.isArray(value)) {
    const normalized: unknown[] = [];
    let omittedLocations = 0;
    for (const entry of value) {
      const item = await normalizeLocations(entry, projectRoot, canReadPath);
      omittedLocations += item.omittedLocations;
      if (!item.omitSelf) normalized.push(item.value);
    }
    return { value: normalized, omittedLocations };
  }
  if (typeof value === "string") {
    return {
      value: sanitizeLanguageString(value, projectRoot),
      omittedLocations: 0,
    };
  }
  if (!isRecord(value)) return { value, omittedLocations: 0 };
  const copy: Record<string, unknown> = {};
  let omittedLocations = 0;
  for (const [key, entry] of Object.entries(value)) {
    if ((key === "uri" || key === "targetUri") && typeof entry === "string") {
      let filePath: string;
      try {
        filePath = fileURLToPath(entry);
      } catch {
        return { value: null, omittedLocations: 1, omitSelf: true };
      }
      const relative = path.relative(projectRoot, filePath);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        return { value: null, omittedLocations: 1, omitSelf: true };
      }
      const projectPath = relative || ".";
      if (canReadPath && !(await canReadPath(projectPath))) {
        return { value: null, omittedLocations: 1, omitSelf: true };
      }
      copy[key === "uri" ? "path" : "targetPath"] = projectPath;
    } else {
      const normalized = await normalizeLocations(
        entry,
        projectRoot,
        canReadPath,
      );
      omittedLocations += normalized.omittedLocations;
      if (!normalized.omitSelf) copy[key] = normalized.value;
    }
  }
  return { value: copy, omittedLocations };
}

function sanitizeLanguageString(value: string, projectRoot: string): string {
  const projectUri = pathToFileURL(projectRoot).href.replace(/\/$/u, "");
  return value.replaceAll(projectUri, ".").replaceAll(projectRoot, ".");
}

function fileSchema() {
  return {
    type: "object" as const,
    properties: { path: { type: "string", minLength: 1 } },
    required: ["path"],
    additionalProperties: false,
  };
}

function resolveProjectRelativePath(
  projectRoot: string,
  requested: string,
):
  | {
      readonly ok: true;
      readonly absolutePath: string;
      readonly relativePath: string;
    }
  | { readonly ok: false; readonly reason: string } {
  if (path.isAbsolute(requested))
    return { ok: false, reason: "path_must_be_relative" };
  const absolutePath = path.resolve(projectRoot, requested);
  const relativePath = path.relative(projectRoot, absolutePath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return { ok: false, reason: "path_outside_project" };
  }
  return { ok: true, absolutePath, relativePath: relativePath || "." };
}

async function canonicalProjectFile(
  projectRoot: string,
  requestedPath: string,
): Promise<
  | {
      readonly ok: true;
      readonly absolutePath: string;
      readonly relativePath: string;
    }
  | { readonly ok: false; readonly reason: string }
> {
  try {
    const [root, canonical, requestedMetadata] = await Promise.all([
      fs.realpath(projectRoot),
      fs.realpath(requestedPath),
      fs.lstat(requestedPath),
    ]);
    if (!requestedMetadata.isFile() || requestedMetadata.isSymbolicLink()) {
      return { ok: false, reason: "path_not_regular_file" };
    }
    const relativePath = path.relative(root, canonical);
    if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      return { ok: false, reason: "path_outside_project" };
    }
    return { ok: true, absolutePath: canonical, relativePath };
  } catch (error) {
    return {
      ok: false,
      reason:
        error && typeof error === "object" && "code" in error
          ? String((error as { code?: unknown }).code)
          : "path_unavailable",
    };
  }
}

function sameTurn(
  discovery: HostToolResolveRequest,
  execution: HostToolExecutionContext,
): boolean {
  return (
    discovery.sessionId === execution.sessionId &&
    discovery.turnId === execution.turnId
  );
}

function positiveInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) > 0
    ? Number(value)
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toolError(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    modelContent: message,
    isError: true,
  };
}

export function isManagedTypeScriptLocation(
  value: unknown,
): value is ManagedTypeScriptLocation {
  return (
    isRecord(value) && typeof value.uri === "string" && isRecord(value.range)
  );
}
