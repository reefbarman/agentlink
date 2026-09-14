import {
  defineTool,
  type AgentPrincipal,
  type AuthorizeToolCall,
  type CoreModelJsonSchema,
  type HostTool,
  type HostToolResolveRequest,
  type HostToolResolver,
} from "@agentlink/core";
import {
  createNodeHostApplyDiffTools,
  createNodeHostReadTools,
  createNodeHostWriteTools,
} from "@agentlink/node-host";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import { createTwoFilesPatch } from "diff";

const MAX_CONTEXT_BYTES = 1_000_000;
const MAX_CONTEXT_LINES = 200;
const MAX_SEARCH_RESULTS = 100;
const MAX_SEARCH_OUTPUT_BYTES = 2_000_000;
const SEARCH_TIMEOUT_MS = 10_000;
const POLICY_REVISION = "standalone-cli-files-v1";
const DEFAULT_IGNORED_SEGMENTS = new Set([".git", "node_modules"]);
const INSTRUCTION_FILES = new Set([
  "AGENT.md",
  "AGENTS.md",
  "AGENTS.local.md",
  "CLAUDE.md",
]);
const GIT_CANDIDATES = [
  "/usr/bin/git",
  "/opt/homebrew/bin/git",
  "/usr/local/bin/git",
] as const;
let gitExecutable: Promise<string | undefined> | undefined;

export interface WorkspaceFileApprovalDisplay {
  readonly kind: "file_write";
  readonly toolName: "write_file" | "apply_diff";
  readonly path: string;
  readonly operation: "created" | "modified";
  readonly expectedContentHash?: string;
  readonly expectedAbsent?: true;
  readonly proposedContentHash: string;
  readonly bytes: number;
  readonly diff: string;
  readonly protected: boolean;
  readonly protectionReason?: string;
  readonly scopeDigest: string;
  readonly operationDigest: string;
  readonly policyRevision: string;
}

export type WorkspaceFileScopeAccess = "read" | "write" | "read_write";

export interface WorkspaceFileScope {
  readonly path: string;
  readonly kind: "file" | "directory";
  readonly access?: WorkspaceFileScopeAccess;
}

export type WorkspaceFileScopeRequest = Pick<
  HostToolResolveRequest,
  "principal" | "sessionId" | "turnId"
>;

export type ResolveWorkspaceFileScopes = (
  request: WorkspaceFileScopeRequest,
) => readonly WorkspaceFileScope[] | Promise<readonly WorkspaceFileScope[]>;

export interface WorkspaceFileApprovalPolicy {
  readonly hasSessionGrant?: (
    proposal: WorkspaceFileApprovalDisplay,
    request: Pick<HostToolResolveRequest, "principal" | "sessionId" | "turnId">,
  ) => boolean;
}

export interface WorkspaceFileMutationCoordinator {
  withCommit<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T>;
}

export interface CreateWorkspaceFileToolsOptions {
  readonly projectRoot: string;
  readonly approvalPolicy?: WorkspaceFileApprovalPolicy;
  readonly resolveScopes?: ResolveWorkspaceFileScopes;
  /** Fixed absolute ripgrep binary selected and integrity-verified by the host. */
  readonly ripgrepExecutable?: string;
  /** Rechecked before approval and immediately before each physical write. */
  readonly canWritePath?: (
    request: WorkspaceFileScopeRequest,
    relativePath: string,
  ) => boolean | Promise<boolean>;
  readonly enrichContext?: (
    request: WorkspaceFileScopeRequest,
    relativePath: string,
    signal?: AbortSignal,
  ) => unknown | Promise<unknown>;
  readonly onFileCommitted?: (
    request: WorkspaceFileScopeRequest,
    relativePath: string,
  ) => void | Promise<void>;
  readonly mutations?: WorkspaceFileMutationCoordinator;
}

export interface WorkspaceFileTools {
  readonly resolveTools: HostToolResolver;
  readonly authorizeToolCall: AuthorizeToolCall;
  readonly validatePendingWrite: (request: {
    readonly principal: AgentPrincipal;
    readonly sessionId: string;
    readonly turnId: string;
    readonly toolName: string;
    readonly input: Readonly<Record<string, unknown>>;
    readonly displayContent: unknown;
  }) => Promise<{ readonly ok: true } | { readonly ok: false; reason: string }>;
}

export function createWorkspaceFileTools(
  options: CreateWorkspaceFileToolsOptions,
): WorkspaceFileTools {
  if (!path.isAbsolute(options.projectRoot)) {
    throw new Error("Workspace file tools require an absolute project root");
  }
  const projectRoot = path.resolve(options.projectRoot);
  const resolveScopes: ResolveWorkspaceFileScopes =
    options.resolveScopes ??
    (() => [{ path: ".", kind: "directory", access: "read_write" }]);
  const resolveTools: HostToolResolver = async (request) => {
    const scopes = await resolveFileScopes(projectRoot, resolveScopes, request);
    const [reads, writes, diffs] = await Promise.all([
      createNodeHostReadTools({
        resolveGrants: () => nodeGrantsForScopes(scopes, "read"),
        shouldIncludePath: (absolutePath) =>
          shouldIncludeProjectReadPath(projectRoot, absolutePath),
      })(request),
      createNodeHostWriteTools({
        resolveGrants: () => nodeGrantsForScopes(scopes, "write"),
      })(request),
      createNodeHostApplyDiffTools({
        resolveGrants: () => nodeGrantsForScopes(scopes, "write"),
      })(request),
    ]);
    const tools = [...reads, ...writes, ...diffs];
    if (options.ripgrepExecutable) {
      const searchIndex = tools.findIndex(
        (tool) => tool.definition.name === "search_files",
      );
      if (searchIndex >= 0) {
        tools[searchIndex] = createRipgrepSearchTool(
          options.ripgrepExecutable,
          projectRoot,
        );
      }
    }
    return [
      ...tools.map((tool) =>
        wrapProjectTool(
          tool,
          request,
          projectRoot,
          resolveScopes,
          options.canWritePath,
          options.onFileCommitted,
          options.mutations,
        ),
      ),
      createContextTool(
        request,
        projectRoot,
        resolveScopes,
        options.enrichContext,
      ),
    ];
  };

  const authorizeToolCall: AuthorizeToolCall = async (request) => {
    try {
      if (
        request.toolName !== "write_file" &&
        request.toolName !== "apply_diff"
      ) {
        return {
          decision: "deny",
          reason: "Unsupported authorization request",
        };
      }
      const scopes = await resolveFileScopes(
        projectRoot,
        resolveScopes,
        request,
      );
      const prepared = await prepareWriteApproval(
        projectRoot,
        request.toolName,
        request.input,
        scopes,
      );
      if (!prepared.ok) {
        return { decision: "deny", reason: prepared.reason };
      }
      if (
        options.canWritePath &&
        !(await options.canWritePath(request, prepared.display.path))
      ) {
        return {
          decision: "deny",
          reason: "Path is reserved by another active workspace writer",
        };
      }
      if (
        !prepared.display.protected &&
        options.approvalPolicy?.hasSessionGrant?.(prepared.display, request)
      ) {
        return { decision: "allow" };
      }
      return {
        decision: "require_user",
        summary: `${prepared.display.operation === "created" ? "Create" : "Modify"} ${prepared.display.path}`,
        displayContent: prepared.display,
      };
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error
          ? String((error as { code?: unknown }).code)
          : error instanceof Error
            ? error.name
            : "unknown";
      throw new Error(`workspace_file_approval_prepare_failed:${code}`);
    }
  };

  const validatePendingWrite: WorkspaceFileTools["validatePendingWrite"] =
    async (request) => {
      if (
        request.toolName !== "write_file" &&
        request.toolName !== "apply_diff"
      ) {
        return { ok: false, reason: "Pending operation is not a file write" };
      }
      if (!isWorkspaceFileApprovalDisplay(request.displayContent)) {
        return { ok: false, reason: "Pending file proposal is invalid" };
      }
      const scopes = await resolveFileScopes(projectRoot, resolveScopes, {
        principal: request.principal,
        sessionId: request.sessionId,
        turnId: request.turnId,
      });
      const prepared = await prepareWriteApproval(
        projectRoot,
        request.toolName,
        request.input,
        scopes,
      );
      if (!prepared.ok) return prepared;
      return sameApprovalDisplay(prepared.display, request.displayContent)
        ? { ok: true }
        : {
            ok: false,
            reason: "Pending file proposal no longer matches policy",
          };
    };

  return { resolveTools, authorizeToolCall, validatePendingWrite };
}

function wrapProjectTool(
  tool: HostTool,
  discovery: HostToolResolveRequest,
  projectRoot: string,
  resolveScopes: ResolveWorkspaceFileScopes,
  canWritePath: CreateWorkspaceFileToolsOptions["canWritePath"] | undefined,
  onFileCommitted:
    | CreateWorkspaceFileToolsOptions["onFileCommitted"]
    | undefined,
  mutations: WorkspaceFileMutationCoordinator | undefined,
): HostTool {
  const name = tool.definition.name;
  return defineTool({
    name,
    description: projectDescription(name),
    inputSchema: relativePathSchema(tool.definition.input_schema),
    effect: tool.effect,
    authorization: tool.authorization,
    parallelSafe: tool.parallelSafe,
    presentation: tool.presentation,
    displayInput: (input) => ({ path: input.path }),
    handler: async (input, context) => {
      if (!sameTurn(discovery, context)) return toolError("tool_turn_mismatch");
      const resolved = await resolveProjectPath(projectRoot, input.path, {
        allowAbsent: name === "write_file" && input.expectedAbsent === true,
      });
      if (!resolved.ok) return toolError(resolved.error);
      const relativePath = toRelativePath(projectRoot, resolved.path);
      const scopes = await resolveFileScopes(
        projectRoot,
        resolveScopes,
        discovery,
      );
      if (!scopeAllows(scopes, relativePath, tool.effect)) {
        return toolError("path_not_scoped");
      }
      const protection = protectedPath(relativePath);
      if (tool.effect === "read" && protection.blockRead) {
        return toolError(protection.reason ?? "protected_content");
      }

      if (tool.effect === "read" && isIgnoredPath(relativePath)) {
        return toolError("path_ignored");
      }
      const execute = async () => {
        if (
          tool.effect === "write" &&
          canWritePath &&
          !(await canWritePath(discovery, relativePath))
        ) {
          return toolError("path_reserved_by_active_writer");
        }
        if (name === "write_file" && input.expectedAbsent === true) {
          const parent = await ensureSafeParent(projectRoot, resolved.path);
          if (!parent.ok) return toolError(parent.error);
        }
        const result = await tool.execute(
          { ...input, path: resolved.path },
          context,
        );
        if (tool.effect === "write" && !result.isError && onFileCommitted) {
          await Promise.resolve(onFileCommitted(discovery, relativePath)).catch(
            () => undefined,
          );
        }
        return projectResult(result, projectRoot, name);
      };
      return tool.effect === "write" && mutations
        ? await mutations.withCommit(execute, context.signal)
        : await execute();
    },
  });
}

function createRipgrepSearchTool(
  executable: string,
  projectRoot: string,
): HostTool {
  if (!path.isAbsolute(executable)) {
    throw new Error("Workspace ripgrep executable must be absolute");
  }
  return defineTool({
    name: "search_files",
    description:
      "Run bounded case-insensitive regex search with the host-packaged ripgrep binary using a project-relative path. This is not semantic search.",
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
    parallelSafe: true,
    displayInput: (input) => ({ path: input.path, regex: input.regex }),
    handler: async (input, context) => {
      if (typeof input.path !== "string" || typeof input.regex !== "string") {
        return toolError("invalid_search_input");
      }
      const limit = boundedInteger(
        input.maxResults,
        MAX_SEARCH_RESULTS,
        1,
        MAX_SEARCH_RESULTS,
      );
      return await executeRipgrepSearch(
        executable,
        projectRoot,
        input.path,
        input.regex,
        limit,
        context.signal,
      );
    },
  });
}

async function executeRipgrepSearch(
  executable: string,
  projectRoot: string,
  target: string,
  regex: string,
  limit: number,
  signal?: AbortSignal,
) {
  if (signal?.aborted) return toolError("search_cancelled");
  const available = await fs
    .access(executable, fsConstants.X_OK)
    .then(() => true)
    .catch(() => false);
  if (!available) return toolError("packaged_ripgrep_unavailable");
  return await new Promise<
    | ReturnType<typeof toolError>
    | {
        modelContent: string;
        displayContent: { path: string; count: number; truncated: boolean };
      }
  >((resolve) => {
    const child = spawn(
      executable,
      [
        "--json",
        "--ignore-case",
        "--no-config",
        "--max-filesize",
        "1000K",
        "--glob",
        "!.git/**",
        "--glob",
        "!node_modules/**",
        "--regexp",
        regex,
        "--",
        target,
      ],
      { cwd: projectRoot, stdio: ["ignore", "pipe", "ignore"] },
    );
    const matches: Array<{ path: string; line: number; text: string }> = [];
    let buffered = "";
    let outputBytes = 0;
    let truncated = false;
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const abort = () => child.kill("SIGTERM");
    const finish = (
      result:
        | ReturnType<typeof toolError>
        | {
            modelContent: string;
            displayContent: { path: string; count: number; truncated: boolean };
          },
    ) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      resolve(result);
    };
    const stopForBound = () => {
      truncated = true;
      child.kill("SIGTERM");
    };
    const consumeLine = (line: string) => {
      if (!line.trim() || matches.length >= limit) return;
      try {
        const event = JSON.parse(line) as {
          type?: string;
          data?: {
            path?: { text?: string };
            line_number?: number;
            lines?: { text?: string };
          };
        };
        if (
          event.type === "match" &&
          typeof event.data?.path?.text === "string" &&
          typeof event.data.line_number === "number" &&
          typeof event.data.lines?.text === "string"
        ) {
          const matchedPath = path.isAbsolute(event.data.path.text)
            ? path.resolve(event.data.path.text)
            : path.resolve(projectRoot, event.data.path.text);
          if (!shouldIncludeProjectReadPath(projectRoot, matchedPath)) return;
          matches.push({
            path: matchedPath,
            line: event.data.line_number,
            text: event.data.lines.text.replace(/[\r\n]+$/u, "").slice(0, 500),
          });
          if (matches.length >= limit) stopForBound();
        }
      } catch {
        // Ignore malformed or partial protocol lines from the subprocess.
      }
    };
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_SEARCH_OUTPUT_BYTES) {
        stopForBound();
        return;
      }
      buffered += chunk.toString("utf8");
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) consumeLine(line);
    });
    child.once("error", () => finish(toolError("packaged_ripgrep_failed")));
    child.once("exit", (code, exitSignal) => {
      if (buffered) consumeLine(buffered);
      if (signal?.aborted) {
        finish(toolError("search_cancelled"));
        return;
      }
      if (code !== 0 && code !== 1 && !truncated && exitSignal === null) {
        finish(toolError(`packaged_ripgrep_exit_${code ?? "unknown"}`));
        return;
      }
      const payload = {
        path: target,
        matches,
        count: matches.length,
        truncated,
      };
      finish({
        modelContent: JSON.stringify(payload),
        displayContent: { path: target, count: matches.length, truncated },
      });
    });
    timeout = setTimeout(() => {
      truncated = true;
      child.kill("SIGTERM");
    }, SEARCH_TIMEOUT_MS);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

function createContextTool(
  discovery: HostToolResolveRequest,
  projectRoot: string,
  resolveScopes: ResolveWorkspaceFileScopes,
  enrichContext: CreateWorkspaceFileToolsOptions["enrichContext"],
): HostTool {
  return defineTool({
    name: "get_context",
    description:
      "Read a bounded project-relative text file slice with SHA-256 baseline, file metadata, and explicit Git availability.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1 },
        offset: { type: "integer", minimum: 1 },
        limit: { type: "integer", minimum: 1, maximum: MAX_CONTEXT_LINES },
      },
      required: ["path"],
      additionalProperties: false,
    },
    effect: "read",
    displayInput: (input) => ({ path: input.path }),
    handler: async (input, context) => {
      if (!sameTurn(discovery, context)) return toolError("tool_turn_mismatch");
      const resolved = await resolveProjectPath(projectRoot, input.path, {
        allowAbsent: false,
      });
      if (!resolved.ok) return toolError(resolved.error);
      const relativePath = toRelativePath(projectRoot, resolved.path);
      const scopes = await resolveFileScopes(
        projectRoot,
        resolveScopes,
        discovery,
      );
      if (!scopeAllows(scopes, relativePath, "read")) {
        return toolError("path_not_scoped");
      }
      const protection = protectedPath(relativePath);
      if (protection.blockRead) {
        return toolError(protection.reason ?? "protected_content");
      }
      if (isIgnoredPath(relativePath)) return toolError("path_ignored");
      const stat = await fs.lstat(resolved.path).catch(() => undefined);
      if (!stat?.isFile() || stat.isSymbolicLink() || stat.nlink > 1) {
        return toolError("not_a_private_regular_file");
      }
      if (stat.size > MAX_CONTEXT_BYTES) return toolError("file_too_large");
      const bytes = await fs.readFile(resolved.path);
      if (bytes.includes(0)) return toolError("binary_file");
      const text = bytes.toString("utf8");
      const lines = text.split(/\r?\n/u);
      const offset = boundedInteger(input.offset, 1, 1, lines.length || 1);
      const limit = boundedInteger(
        input.limit,
        MAX_CONTEXT_LINES,
        1,
        MAX_CONTEXT_LINES,
      );
      const selected = lines.slice(offset - 1, offset - 1 + limit);
      const [git, languageIntelligence] = await Promise.all([
        readGitStatus(projectRoot, relativePath),
        enrichContext
          ? Promise.resolve(
              enrichContext(discovery, relativePath, context.signal),
            ).catch((error) => ({
              state: "failed",
              reason: `language_context_failed:${toolErrorCode(error)}`,
              retryable: true,
            }))
          : undefined,
      ]);
      const payload = {
        path: relativePath,
        contentHash: contentHash(bytes),
        bytes: bytes.length,
        modifiedAt: stat.mtime.toISOString(),
        offset,
        totalLines: lines.length,
        truncated: offset - 1 + selected.length < lines.length,
        text: selected
          .map((line, index) => `${offset + index} | ${line}`)
          .join("\n"),
        git,
        ...(languageIntelligence !== undefined ? { languageIntelligence } : {}),
      };
      return {
        modelContent: JSON.stringify(payload),
        displayContent: {
          path: relativePath,
          contentHash: payload.contentHash,
          lines: selected.length,
          truncated: payload.truncated,
          git: git.status,
          ...(languageIntelligence &&
          typeof languageIntelligence === "object" &&
          "state" in languageIntelligence
            ? { languageIntelligence: languageIntelligence.state }
            : {}),
        },
      };
    },
  });
}

function relativePathSchema(schema: CoreModelJsonSchema): CoreModelJsonSchema {
  const cloned = structuredClone(schema);
  const properties = cloned.properties;
  if (
    properties &&
    typeof properties === "object" &&
    !Array.isArray(properties)
  ) {
    (properties as Record<string, unknown>).path = {
      type: "string",
      minLength: 1,
      description:
        "Project-relative path. Absolute paths and project escapes are rejected.",
    };
  }
  return cloned;
}

function projectDescription(name: string): string {
  switch (name) {
    case "read_file":
      return "Read a bounded text file using a project-relative path. Sensitive or ignored content is withheld.";
    case "list_files":
      return "List bounded project files using a project-relative directory path.";
    case "search_files":
      return "Run bounded regex text search using a project-relative path. This is not semantic search.";
    case "write_file":
      return "Propose a reviewed project-relative file replacement. Existing files require the SHA-256 hash returned by get_context; new files require expectedAbsent=true.";
    case "apply_diff":
      return "Propose reviewed canonical SEARCH/DIVIDER/REPLACE blocks for one project-relative file pinned by its SHA-256 hash.";
    default:
      return name;
  }
}

async function prepareWriteApproval(
  projectRoot: string,
  toolName: "write_file" | "apply_diff",
  input: Readonly<Record<string, unknown>>,
  scopes: readonly ResolvedWorkspaceFileScope[],
): Promise<
  | { ok: true; display: WorkspaceFileApprovalDisplay }
  | { ok: false; reason: string }
> {
  const resolved = await resolveProjectPath(projectRoot, input.path, {
    allowAbsent: toolName === "write_file" && input.expectedAbsent === true,
  });
  if (!resolved.ok) return { ok: false, reason: resolved.error };
  const relativePath = toRelativePath(projectRoot, resolved.path);
  if (!scopeAllows(scopes, relativePath, "write")) {
    return { ok: false, reason: "Path is outside the active write scope" };
  }
  const protection = protectedPath(relativePath);
  if (protection.blockWrite) {
    return {
      ok: false,
      reason: `Writes to ${protection.reason ?? "this protected path"} are not supported`,
    };
  }
  const stat = await fs.lstat(resolved.path).catch(() => undefined);
  if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1)) {
    return { ok: false, reason: "Target is not a private regular file" };
  }
  if (stat && stat.size > MAX_CONTEXT_BYTES) {
    return { ok: false, reason: "File is too large for reviewed editing" };
  }
  const currentBytes = stat ? await fs.readFile(resolved.path) : undefined;
  if (currentBytes?.includes(0)) {
    return { ok: false, reason: "Binary files cannot be reviewed as text" };
  }
  const current = currentBytes?.toString("utf8");
  let proposed: string;
  let operation: "created" | "modified";
  let expectedContentHash: string | undefined;
  let expectedAbsent: true | undefined;
  if (toolName === "write_file") {
    if (typeof input.content !== "string")
      return { ok: false, reason: "Invalid content" };
    proposed = input.content;
    if (stat) {
      expectedContentHash = stringValue(input.expectedContentHash);
      if (
        !expectedContentHash ||
        contentHash(current!) !== expectedContentHash
      ) {
        return { ok: false, reason: "File baseline changed before review" };
      }
      operation = "modified";
    } else {
      if (input.expectedAbsent !== true) {
        return { ok: false, reason: "New files require expectedAbsent=true" };
      }
      expectedAbsent = true;
      operation = "created";
    }
  } else {
    if (!stat || current === undefined)
      return { ok: false, reason: "Patch target is missing" };
    expectedContentHash = stringValue(input.expectedContentHash);
    if (!expectedContentHash || contentHash(current) !== expectedContentHash) {
      return { ok: false, reason: "File baseline changed before review" };
    }
    const applied = applyStrictDiff(current, input.diff);
    if (!applied.ok) return { ok: false, reason: applied.reason };
    proposed = applied.content;
    operation = "modified";
  }
  const proposedBytes = Buffer.byteLength(proposed, "utf8");
  if (proposedBytes > MAX_CONTEXT_BYTES) {
    return { ok: false, reason: "Proposed file is too large" };
  }
  const proposedContentHash = contentHash(proposed);
  const scopeDigest = fileScopeDigest(scopes);
  const inputDigest = contentHash(JSON.stringify(input));
  const operationDigest = contentHash(
    JSON.stringify({
      policyRevision: POLICY_REVISION,
      toolName,
      projectRoot,
      relativePath,
      expectedContentHash,
      expectedAbsent,
      proposedContentHash,
      scopeDigest,
      inputDigest,
    }),
  );
  return {
    ok: true,
    display: {
      kind: "file_write",
      toolName,
      path: relativePath,
      operation,
      ...(expectedContentHash ? { expectedContentHash } : {}),
      ...(expectedAbsent ? { expectedAbsent } : {}),
      proposedContentHash,
      bytes: proposedBytes,
      diff: renderReviewDiff(relativePath, current ?? "", proposed, operation),
      protected: protection.protected,
      ...(protection.reason ? { protectionReason: protection.reason } : {}),
      scopeDigest,
      operationDigest,
      policyRevision: POLICY_REVISION,
    },
  };
}

async function resolveProjectPath(
  projectRoot: string,
  input: unknown,
  options: { allowAbsent: boolean },
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  if (typeof input !== "string" || !input.trim() || path.isAbsolute(input)) {
    return { ok: false, error: "project_relative_path_required" };
  }
  const requested = path.resolve(projectRoot, input);
  if (!isPathWithin(requested, projectRoot))
    return { ok: false, error: "path_escape" };
  const existing = await fs.realpath(requested).catch(() => undefined);
  if (existing) {
    if (!isPathWithin(existing, projectRoot)) {
      return { ok: false, error: "symlink_escape" };
    }
    return existing === requested
      ? { ok: true, path: existing }
      : { ok: false, error: "path_alias" };
  }
  if (!options.allowAbsent) return { ok: false, error: "path_not_found" };
  const ancestor = await nearestExistingAncestor(path.dirname(requested));
  if (!ancestor) return { ok: false, error: "parent_not_found" };
  const realAncestor = await fs.realpath(ancestor).catch(() => undefined);
  if (!realAncestor || !isPathWithin(realAncestor, projectRoot)) {
    return { ok: false, error: "parent_escape" };
  }
  if (realAncestor !== ancestor) return { ok: false, error: "path_alias" };
  return { ok: true, path: requested };
}

async function ensureSafeParent(
  projectRoot: string,
  target: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const parent = path.dirname(target);
  const relative = path.relative(projectRoot, parent);
  let current = projectRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current).catch(() => undefined);
    if (stat) {
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        return { ok: false, error: "unsafe_parent" };
      }
      continue;
    }
    try {
      await fs.mkdir(current, { mode: 0o700 });
    } catch {
      return { ok: false, error: "parent_creation_failed" };
    }
  }
  const realParent = await fs.realpath(parent).catch(() => undefined);
  return realParent && isPathWithin(realParent, projectRoot)
    ? { ok: true }
    : { ok: false, error: "parent_escape" };
}

async function nearestExistingAncestor(
  candidate: string,
): Promise<string | undefined> {
  let current = candidate;
  for (;;) {
    if (await fs.lstat(current).catch(() => undefined)) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function applyStrictDiff(
  content: string,
  input: unknown,
): { ok: true; content: string } | { ok: false; reason: string } {
  if (typeof input !== "string" || !input.trim()) {
    return { ok: false, reason: "Invalid patch" };
  }
  const lines = input.split("\n");
  let index = 0;
  let result = content;
  let blocks = 0;
  while (index < lines.length) {
    if (!lines[index]?.trim()) {
      index += 1;
      continue;
    }
    if (lines[index]?.trim() !== "<<<<<<< SEARCH") {
      return { ok: false, reason: "Invalid patch marker" };
    }
    index += 1;
    const search: string[] = [];
    while (
      index < lines.length &&
      lines[index]?.trim() !== "======= DIVIDER ======="
    ) {
      search.push(lines[index++]!);
    }
    if (index >= lines.length || search.length === 0) {
      return { ok: false, reason: "Invalid patch block" };
    }
    index += 1;
    const replacement: string[] = [];
    while (index < lines.length && lines[index]?.trim() !== ">>>>>>> REPLACE") {
      replacement.push(lines[index++]!);
    }
    if (index >= lines.length)
      return { ok: false, reason: "Invalid patch block" };
    index += 1;
    const searchText = search.join("\n");
    const first = result.indexOf(searchText);
    if (first < 0) return { ok: false, reason: "Patch search was not found" };
    if (result.indexOf(searchText, first + searchText.length) >= 0) {
      return { ok: false, reason: "Patch search is ambiguous" };
    }
    result = `${result.slice(0, first)}${replacement.join("\n")}${result.slice(first + searchText.length)}`;
    blocks += 1;
  }
  return blocks > 0
    ? { ok: true, content: result }
    : { ok: false, reason: "Patch has no blocks" };
}

function renderReviewDiff(
  relativePath: string,
  before: string,
  after: string,
  operation: "created" | "modified",
): string {
  return createTwoFilesPatch(
    operation === "created" ? "/dev/null" : `a/${relativePath}`,
    `b/${relativePath}`,
    before,
    after,
    undefined,
    undefined,
    { context: 3 },
  );
}

function protectedPath(relativePath: string): {
  protected: boolean;
  blockRead: boolean;
  blockWrite: boolean;
  reason?: string;
} {
  const segments = relativePath.split("/");
  const name = segments.at(-1) ?? "";
  if (name === ".env" || name.startsWith(".env.")) {
    return {
      protected: true,
      blockRead: true,
      blockWrite: true,
      reason: "environment_file",
    };
  }
  if (segments[0] === ".git") {
    return {
      protected: true,
      blockRead: true,
      blockWrite: true,
      reason: "git_metadata",
    };
  }
  if (segments[0] === ".agentlink" || segments[0] === ".claude") {
    return {
      protected: true,
      blockRead: false,
      blockWrite: false,
      reason: "authority_configuration",
    };
  }
  if (INSTRUCTION_FILES.has(name)) {
    return {
      protected: true,
      blockRead: false,
      blockWrite: false,
      reason: "instruction_file",
    };
  }
  return { protected: false, blockRead: false, blockWrite: false };
}

type ResolvedWorkspaceFileScope = WorkspaceFileScope & {
  readonly path: string;
  readonly absolutePath: string;
  readonly grantPath: string;
  readonly access: WorkspaceFileScopeAccess;
};

export async function workspaceFileScopesContain(
  projectRoot: string,
  parentScopes: readonly WorkspaceFileScope[],
  childScopes: readonly WorkspaceFileScope[],
): Promise<boolean> {
  const [parents, children] = await Promise.all([
    resolveDeclaredFileScopes(projectRoot, parentScopes),
    resolveDeclaredFileScopes(projectRoot, childScopes),
  ]);
  return children.every((child) =>
    parents.some((parent) => {
      const pathCovered =
        parent.kind === "directory"
          ? isRelativePathWithin(child.path, parent.path)
          : child.kind === "file" && child.path === parent.path;
      if (!pathCovered) return false;
      return child.access === "read_write"
        ? parent.access === "read_write"
        : parent.access === "read" || parent.access === "read_write";
    }),
  );
}

async function resolveFileScopes(
  projectRoot: string,
  resolveScopes: ResolveWorkspaceFileScopes,
  request: WorkspaceFileScopeRequest,
): Promise<readonly ResolvedWorkspaceFileScope[]> {
  return await resolveDeclaredFileScopes(
    projectRoot,
    await resolveScopes(request),
  );
}

async function resolveDeclaredFileScopes(
  projectRoot: string,
  scopes: readonly WorkspaceFileScope[],
): Promise<readonly ResolvedWorkspaceFileScope[]> {
  const resolved: ResolvedWorkspaceFileScope[] = [];
  for (const scope of scopes) {
    if (
      !scope ||
      (scope.kind !== "file" && scope.kind !== "directory") ||
      (scope.access !== undefined &&
        scope.access !== "read" &&
        scope.access !== "write" &&
        scope.access !== "read_write")
    ) {
      throw new Error("invalid_workspace_file_scope");
    }
    const candidate = await resolveProjectPath(projectRoot, scope.path, {
      allowAbsent: true,
    });
    if (!candidate.ok)
      throw new Error(`invalid_workspace_file_scope:${candidate.error}`);
    const stat = await fs.lstat(candidate.path).catch(() => undefined);
    if (
      stat &&
      ((scope.kind === "file" && !stat.isFile()) ||
        (scope.kind === "directory" && !stat.isDirectory()))
    ) {
      throw new Error("invalid_workspace_file_scope:kind_mismatch");
    }
    const relativePath = toRelativePath(projectRoot, candidate.path);
    const ancestor = stat
      ? candidate.path
      : await nearestExistingAncestor(path.dirname(candidate.path));
    if (!ancestor)
      throw new Error("invalid_workspace_file_scope:parent_not_found");
    resolved.push({
      path: relativePath,
      absolutePath: candidate.path,
      grantPath: ancestor,
      kind: scope.kind,
      access: scope.access ?? "read_write",
    });
  }
  return [
    ...new Map(
      resolved.map((scope) => [JSON.stringify(scope), scope]),
    ).values(),
  ].sort(
    (left, right) =>
      left.path.localeCompare(right.path) ||
      left.kind.localeCompare(right.kind) ||
      left.access.localeCompare(right.access),
  );
}

function nodeGrantsForScopes(
  scopes: readonly ResolvedWorkspaceFileScope[],
  effect: "read" | "write",
): Array<{ rootPath: string; kind: "file" | "directory" }> {
  return scopes
    .filter((scope) => scopeAllowsAccess(scope.access, effect))
    .map((scope) =>
      scope.absolutePath === scope.grantPath
        ? { rootPath: scope.absolutePath, kind: scope.kind }
        : { rootPath: scope.grantPath, kind: "directory" },
    );
}

function scopeAllows(
  scopes: readonly ResolvedWorkspaceFileScope[],
  relativePath: string,
  effect: "read" | "write" | "external",
): boolean {
  if (effect === "external") return false;
  return scopes.some(
    (scope) =>
      scopeAllowsAccess(scope.access, effect) &&
      (scope.kind === "file"
        ? relativePath === scope.path
        : isRelativePathWithin(relativePath, scope.path)),
  );
}

function scopeAllowsAccess(
  access: WorkspaceFileScopeAccess,
  effect: "read" | "write",
): boolean {
  return access === "read_write" || access === effect;
}

function isRelativePathWithin(candidate: string, root: string): boolean {
  const relative = path.posix.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith("../") &&
      !path.posix.isAbsolute(relative))
  );
}

function fileScopeDigest(
  scopes: readonly ResolvedWorkspaceFileScope[],
): string {
  return contentHash(
    JSON.stringify(
      scopes.map(({ path: scopePath, kind, access }) => ({
        path: scopePath,
        kind,
        access,
      })),
    ),
  );
}

function isWorkspaceFileApprovalDisplay(
  value: unknown,
): value is WorkspaceFileApprovalDisplay {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const display = value as Partial<WorkspaceFileApprovalDisplay>;
  return (
    display.kind === "file_write" &&
    (display.toolName === "write_file" || display.toolName === "apply_diff") &&
    typeof display.path === "string" &&
    (display.operation === "created" || display.operation === "modified") &&
    typeof display.proposedContentHash === "string" &&
    typeof display.bytes === "number" &&
    typeof display.diff === "string" &&
    typeof display.protected === "boolean" &&
    typeof display.scopeDigest === "string" &&
    typeof display.operationDigest === "string" &&
    typeof display.policyRevision === "string"
  );
}

function sameApprovalDisplay(
  current: WorkspaceFileApprovalDisplay,
  stored: WorkspaceFileApprovalDisplay,
): boolean {
  return (
    current.policyRevision === stored.policyRevision &&
    current.scopeDigest === stored.scopeDigest &&
    current.operationDigest === stored.operationDigest &&
    current.toolName === stored.toolName &&
    current.path === stored.path &&
    current.operation === stored.operation &&
    current.expectedContentHash === stored.expectedContentHash &&
    current.expectedAbsent === stored.expectedAbsent &&
    current.proposedContentHash === stored.proposedContentHash &&
    current.bytes === stored.bytes &&
    current.diff === stored.diff &&
    current.protected === stored.protected &&
    current.protectionReason === stored.protectionReason
  );
}

function shouldIncludeProjectReadPath(
  projectRoot: string,
  absolutePath: string,
): boolean {
  if (!isPathWithin(absolutePath, projectRoot)) return false;
  const relativePath = toRelativePath(projectRoot, absolutePath);
  return !isIgnoredPath(relativePath) && !protectedPath(relativePath).blockRead;
}

function isIgnoredPath(relativePath: string): boolean {
  return relativePath
    .split("/")
    .some((segment) => DEFAULT_IGNORED_SEGMENTS.has(segment));
}

function projectResult(
  result: Awaited<ReturnType<HostTool["execute"]>>,
  projectRoot: string,
  toolName: string,
) {
  if (typeof result.modelContent !== "string") return result;
  try {
    const value = sanitizeProjectResult(
      replaceAbsolutePaths(JSON.parse(result.modelContent), projectRoot),
      toolName,
    );
    return {
      ...result,
      modelContent: JSON.stringify(value),
      ...(result.displayContent !== undefined
        ? {
            displayContent: replaceAbsolutePaths(
              result.displayContent,
              projectRoot,
            ),
          }
        : {}),
    };
  } catch {
    return result;
  }
}

function sanitizeProjectResult(value: unknown, toolName: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (toolName === "list_files" && Array.isArray(record.entries)) {
    const entries = record.entries.filter(
      (entry): entry is string =>
        typeof entry === "string" &&
        !isIgnoredPath(entry.replace(/\/$/u, "")) &&
        !protectedPath(entry.replace(/\/$/u, "")).blockRead,
    );
    return { ...record, entries, count: entries.length };
  }
  if (toolName === "search_files" && Array.isArray(record.matches)) {
    const matches = record.matches.filter((match) => {
      if (!match || typeof match !== "object") return false;
      const matchPath = (match as { path?: unknown }).path;
      if (typeof matchPath !== "string") return false;
      return !isIgnoredPath(matchPath) && !protectedPath(matchPath).blockRead;
    });
    return { ...record, matches, count: matches.length };
  }
  return value;
}

function replaceAbsolutePaths(value: unknown, projectRoot: string): unknown {
  if (typeof value === "string") {
    return isPathWithin(value, projectRoot)
      ? toRelativePath(projectRoot, value)
      : value;
  }
  if (Array.isArray(value))
    return value.map((item) => replaceAbsolutePaths(item, projectRoot));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        replaceAbsolutePaths(item, projectRoot),
      ]),
    );
  }
  return value;
}

async function readGitStatus(
  projectRoot: string,
  relativePath: string,
): Promise<{ status: "available"; value: string } | { status: "unavailable" }> {
  const executable = await resolveGitExecutable();
  if (!executable) return { status: "unavailable" };
  return await new Promise((resolve) => {
    const child = spawn(
      executable,
      ["status", "--short", "--untracked-files=all", "--", relativePath],
      {
        cwd: projectRoot,
        env: { PATH: "/usr/bin:/bin", GIT_OPTIONAL_LOCKS: "0" },
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (output.length < 4_000) output += chunk;
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
    child.once("error", () => {
      clearTimeout(timer);
      resolve({ status: "unavailable" });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve(
        code === 0
          ? { status: "available", value: output.trim() || "clean" }
          : { status: "unavailable" },
      );
    });
  });
}

function resolveGitExecutable(): Promise<string | undefined> {
  gitExecutable ??= (async () => {
    for (const candidate of GIT_CANDIDATES) {
      try {
        await fs.access(candidate, fsConstants.X_OK);
        return candidate;
      } catch {
        // Try the next fixed executable location.
      }
    }
    return undefined;
  })();
  return gitExecutable;
}

function sameTurn(
  discovery: HostToolResolveRequest,
  invocation: { principal: AgentPrincipal; sessionId: string; turnId: string },
): boolean {
  return (
    discovery.principal.tenantId === invocation.principal.tenantId &&
    discovery.principal.subjectId === invocation.principal.subjectId &&
    discovery.sessionId === invocation.sessionId &&
    discovery.turnId === invocation.turnId
  );
}

function isPathWithin(candidate: string, root: string): boolean {
  if (!path.isAbsolute(candidate)) return false;
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function toRelativePath(projectRoot: string, absolutePath: string): string {
  return (
    path.relative(projectRoot, absolutePath).split(path.sep).join("/") || "."
  );
}

function contentHash(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function boundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return Number.isSafeInteger(value)
    ? Math.max(minimum, Math.min(maximum, Number(value)))
    : fallback;
}

function toolErrorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    return String((error as { code?: unknown }).code);
  }
  return error instanceof Error ? error.name : "unknown";
}

function toolError(code: string) {
  return { modelContent: JSON.stringify({ error: code }), isError: true };
}
