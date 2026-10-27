import {
  defineTool,
  type AgentPrincipal,
  type AuthorizeToolCall,
  type CoreModelJsonSchema,
  type HostTool,
  type HostToolResolveRequest,
  type HostToolResolver,
} from "@agentlink/core";
import { planApplyDiff } from "@agentlink/core/apply-diff";
import {
  buildFindAndReplacePattern,
  FIND_AND_REPLACE_MAX_GLOB_FILES,
  planFindAndReplace,
  type FindAndReplaceFilePlan,
} from "@agentlink/core/find-and-replace";
import {
  buildRipgrepSearchArgs,
  emptyContentSearchResult,
  filePatternGlobArgs,
  formatContentSearchResults,
  formatCountSearchResults,
  formatFilesWithMatchesResults,
  getEscapingHint,
  isLiteralFilePatternPath,
  parseRipgrepCountOutput,
  parseRipgrepOutput,
  SEARCH_FILES_DEFAULT_MAX_RESULTS,
  SEARCH_FILES_MAX_OUTPUT_LINES,
  type RegexSearchFilesParams,
  type SearchFileRedactionView,
} from "@agentlink/core/search-files";
import {
  applyDiffBlockOptions,
  createNodeHostApplyDiffTools,
  createNodeHostGlobMatcher,
  createNodeHostReadTools,
  createNodeHostWriteTools,
  isNodeHostStructuredConfigPath,
  redactNodeHostStructuredConfig,
} from "@agentlink/node-host";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { createTwoFilesPatch } from "diff";

import {
  createLocalWorkspaceExecutionBackend,
  type WorkspaceExecutionBackend,
  type WorkspaceFileSystem,
  type WorkspaceProcessHandle,
  type WorkspaceProcessLauncher,
} from "./workspaceExecutionBackend.js";
import {
  buildWorkspaceReadFileContext,
  detectWorkspaceReadFileLanguage,
  WorkspaceReadFileContextTracker,
  type WorkspaceReadFileContextEnrichment,
} from "./workspaceReadFileContext.js";

const MAX_CONTEXT_BYTES = 1_000_000;

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
const DEFAULT_PROCESS_OWNER_ID = "workspace-file-tools";
const BACKEND_SEARCH_ENVIRONMENT: Readonly<Record<string, string>> = {
  PATH: "/usr/bin:/bin",
};

/** One file in a multi-file (`find_and_replace`) proposal. */
export interface WorkspaceFileApprovalDisplayFile {
  readonly path: string;
  readonly changes: number;
  readonly expectedContentHash: string;
  readonly proposedContentHash: string;
  readonly bytes: number;
  readonly protected: boolean;
  readonly protectionReason?: string;
}

export interface WorkspaceFileApprovalDisplay {
  readonly kind: "file_write";
  readonly toolName: "write_file" | "apply_diff" | "find_and_replace";
  /**
   * Project-relative target. A multi-file `find_and_replace` proposal uses
   * its single file's path, or `N files`; see `files` for each target.
   */
  readonly path: string;
  readonly operation: "created" | "modified";
  readonly expectedContentHash?: string;
  readonly expectedAbsent?: true;
  readonly proposedContentHash: string;
  readonly bytes: number;
  readonly diff: string;
  readonly protected: boolean;
  readonly protectionReason?: string;
  /** `find_and_replace` only: every reviewed file with its pinned baseline. */
  readonly files?: readonly WorkspaceFileApprovalDisplayFile[];
  /** `find_and_replace` only: total replacements across `files`. */
  readonly replacements?: number;
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
  /** @deprecated Use enrichReadFileContext for VS Code-shaped enrichment. */
  readonly enrichContext?: (
    request: WorkspaceFileScopeRequest,
    relativePath: string,
    signal?: AbortSignal,
  ) => unknown | Promise<unknown>;
  readonly enrichReadFileContext?: (
    request: WorkspaceFileScopeRequest,
    relativePath: string,
    options: {
      readonly includeSymbols: boolean;
      readonly signal?: AbortSignal;
    },
  ) =>
    | WorkspaceReadFileContextEnrichment
    | Promise<WorkspaceReadFileContextEnrichment>;
  readonly onFileCommitted?: (
    request: WorkspaceFileScopeRequest,
    relativePath: string,
  ) => void | Promise<void>;
  readonly mutations?: WorkspaceFileMutationCoordinator;
  /**
   * Backend for file access and the ripgrep/git subprocesses. Defaults to
   * this machine. An injected backend never receives the host environment:
   * search runs with a minimal fixed PATH.
   */
  readonly executionBackend?: WorkspaceExecutionBackend;
  /** Owner identity attached to search and git process requests. */
  readonly processOwnerId?: string;
}

interface FileToolsRuntime {
  readonly files: WorkspaceFileSystem;
  readonly processes: WorkspaceProcessLauncher;
  readonly processOwnerId: string;
  readonly searchEnvironment: Readonly<Record<string, string>>;
  readonly resolveGitExecutable: () => Promise<string | undefined>;
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
  const runtime = createFileToolsRuntime(options);
  const { files } = runtime;
  const resolveScopes: ResolveWorkspaceFileScopes =
    options.resolveScopes ??
    (() => [{ path: ".", kind: "directory", access: "read_write" }]);
  const contextTracker = new WorkspaceReadFileContextTracker();
  const resolveTools: HostToolResolver = async (request) => {
    const scopes = await resolveFileScopes(
      files,
      projectRoot,
      resolveScopes,
      request,
    );
    const [reads, writes, diffs] = await Promise.all([
      createNodeHostReadTools({
        resolveGrants: () => nodeGrantsForScopes(scopes, "read"),
        shouldIncludePath: (absolutePath) =>
          shouldIncludeProjectReadPath(projectRoot, absolutePath),
        fileSystem: files,
      })(request),
      createNodeHostWriteTools({
        resolveGrants: () => nodeGrantsForScopes(scopes, "write"),
        fileSystem: files,
      })(request),
      createNodeHostApplyDiffTools({
        resolveGrants: () => nodeGrantsForScopes(scopes, "write"),
        fileSystem: files,
        // authorizeToolCall pins the reviewed baseline through preparedInput.
        contentHashInput: "host_prepared",
      })(request),
    ]);
    const tools = [...reads, ...writes, ...diffs];
    const nodeWriteFile = writes.find(
      (tool) => tool.definition.name === "write_file",
    );
    if (options.ripgrepExecutable) {
      const searchIndex = tools.findIndex(
        (tool) => tool.definition.name === "search_files",
      );
      if (searchIndex >= 0) {
        tools[searchIndex] = createRipgrepSearchTool(
          runtime,
          options.ripgrepExecutable,
          projectRoot,
        );
      }
    }
    const projectTools = tools.map((tool) =>
      tool.definition.name === "read_file"
        ? createWorkspaceReadFileTool(
            runtime,
            tool,
            request,
            projectRoot,
            resolveScopes,
            options.enrichReadFileContext,
            options.enrichContext,
            contextTracker,
          )
        : wrapProjectTool(
            files,
            tool,
            request,
            projectRoot,
            resolveScopes,
            options.canWritePath,
            options.onFileCommitted,
            options.mutations,
          ),
    );
    return nodeWriteFile
      ? [
          ...projectTools,
          createFindAndReplaceTool(
            files,
            request,
            projectRoot,
            resolveScopes,
            nodeWriteFile,
            options.canWritePath,
            options.onFileCommitted,
            options.mutations,
          ),
        ]
      : projectTools;
  };

  const authorizeToolCall: AuthorizeToolCall = async (request) => {
    try {
      if (
        request.toolName !== "write_file" &&
        request.toolName !== "apply_diff" &&
        request.toolName !== "find_and_replace"
      ) {
        return {
          decision: "deny",
          reason: "Unsupported authorization request",
        };
      }
      const scopes = await resolveFileScopes(
        files,
        projectRoot,
        resolveScopes,
        request,
      );
      if (request.toolName === "find_and_replace") {
        const prepared = await prepareFindAndReplaceApproval(
          files,
          projectRoot,
          request.input,
          scopes,
        );
        if (prepared.ok === "no_write") {
          // Nothing to write: executing returns VS Code's no_matches,
          // guardrail, or error payload.
          return { decision: "allow", preparedInput: prepared.preparedInput };
        }
        if (!prepared.ok) return { decision: "deny", reason: prepared.reason };
        for (const file of prepared.display.files ?? []) {
          if (
            options.canWritePath &&
            !(await options.canWritePath(request, file.path))
          ) {
            return {
              decision: "deny",
              reason: "Path is reserved by another active workspace writer",
            };
          }
        }
        if (
          !prepared.display.protected &&
          options.approvalPolicy?.hasSessionGrant?.(prepared.display, request)
        ) {
          return { decision: "allow", preparedInput: prepared.preparedInput };
        }
        const fileCount = prepared.display.files?.length ?? 0;
        return {
          decision: "require_user",
          summary: `Replace \`${String(request.input.find)}\` → \`${String(request.input.replace)}\` (${prepared.display.replacements} match${prepared.display.replacements === 1 ? "" : "es"} in ${fileCount} file${fileCount === 1 ? "" : "s"})`,
          displayContent: prepared.display,
          preparedInput: prepared.preparedInput,
        };
      }
      const prepared = await prepareWriteApproval(
        files,
        projectRoot,
        request.toolName,
        request.input,
        scopes,
      );
      if (prepared.ok === "no_write") {
        // A failed or no-op diff writes nothing; executing it returns VS
        // Code's detailed result against the same pinned baseline.
        return { decision: "allow", preparedInput: prepared.preparedInput };
      }
      if (!prepared.ok) {
        return { decision: "deny", reason: prepared.reason };
      }
      const preparedInput =
        request.toolName === "apply_diff"
          ? { preparedInput: prepared.preparedInput }
          : {};
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
        return { decision: "allow", ...preparedInput };
      }
      return {
        decision: "require_user",
        summary: `${prepared.display.operation === "created" ? "Create" : "Modify"} ${prepared.display.path}`,
        displayContent: prepared.display,
        ...preparedInput,
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
        request.toolName !== "apply_diff" &&
        request.toolName !== "find_and_replace"
      ) {
        return { ok: false, reason: "Pending operation is not a file write" };
      }
      if (!isWorkspaceFileApprovalDisplay(request.displayContent)) {
        return { ok: false, reason: "Pending file proposal is invalid" };
      }
      const scopes = await resolveFileScopes(
        files,
        projectRoot,
        resolveScopes,
        {
          principal: request.principal,
          sessionId: request.sessionId,
          turnId: request.turnId,
        },
      );
      const prepared = await (request.toolName === "find_and_replace"
        ? prepareFindAndReplaceApproval(
            files,
            projectRoot,
            request.input,
            scopes,
          )
        : prepareWriteApproval(
            files,
            projectRoot,
            request.toolName,
            request.input,
            scopes,
          ));
      if (prepared.ok === "no_write") {
        return { ok: false, reason: "Pending file proposal no longer applies" };
      }
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

function createFileToolsRuntime(
  options: CreateWorkspaceFileToolsOptions,
): FileToolsRuntime {
  const backend =
    options.executionBackend ?? createLocalWorkspaceExecutionBackend();
  const files = backend.fileSystem;
  let gitExecutable: Promise<string | undefined> | undefined;
  return {
    files,
    processes: backend,
    processOwnerId: options.processOwnerId ?? DEFAULT_PROCESS_OWNER_ID,
    // The local default keeps the historical inherited environment; an
    // injected backend only ever receives a fixed minimal environment.
    searchEnvironment: options.executionBackend
      ? BACKEND_SEARCH_ENVIRONMENT
      : definedEnvironment(process.env),
    resolveGitExecutable() {
      gitExecutable ??= (async () => {
        for (const candidate of GIT_CANDIDATES) {
          if (await files.canExecute(candidate)) return candidate;
        }
        return undefined;
      })();
      return gitExecutable;
    },
  };
}

function definedEnvironment(
  source: NodeJS.ProcessEnv,
): Readonly<Record<string, string>> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

function launchFileToolProcess(
  runtime: FileToolsRuntime,
  input: {
    readonly executable: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly environment: Readonly<Record<string, string>>;
    readonly sessionId: string;
    readonly turnId: string;
  },
  onOutput: (stream: "stdout" | "stderr", bytes: Buffer) => void,
): WorkspaceProcessHandle {
  return runtime.processes.launchProcess({
    request: {
      schemaVersion: 1,
      operationId: randomUUID(),
      ownerId: runtime.processOwnerId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      policyFingerprint: POLICY_REVISION,
      operationDigest: contentHash(
        JSON.stringify({
          executable: input.executable,
          args: input.args,
          cwd: input.cwd,
        }),
      ),
      executable: input.executable,
      args: [...input.args],
      cwd: input.cwd,
      environment: { ...input.environment },
    },
    onOutput,
  });
}

function wrapProjectTool(
  files: WorkspaceFileSystem,
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
      const resolved = await resolveProjectPath(
        files,
        projectRoot,
        input.path,
        {
          allowAbsent: name === "write_file" && input.expectedAbsent === true,
        },
      );
      if (!resolved.ok) return toolError(resolved.error);
      const relativePath = toRelativePath(projectRoot, resolved.path);
      const scopes = await resolveFileScopes(
        files,
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
          const parent = await ensureSafeParent(
            files,
            projectRoot,
            resolved.path,
          );
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

const SEARCH_CONTEXT_LINES_LIMIT = 50;
const SEARCH_STDERR_BYTES = 16_384;

/** VS Code's regex `search_files` input; indexed `query` mode is VS Code-only. */
const SEARCH_FILES_INPUT_SCHEMA: CoreModelJsonSchema = {
  type: "object",
  properties: {
    path: {
      type: "string",
      minLength: 1,
      description: "Project-relative file or directory to search.",
    },
    regex: {
      type: "string",
      minLength: 1,
      maxLength: 1_000,
      description: "Regular expression for exact search (ripgrep syntax).",
    },
    file_pattern: {
      type: "string",
      minLength: 1,
      maxLength: 500,
      description: "Glob pattern to filter files (e.g. '*.ts').",
    },
    context: {
      type: "integer",
      minimum: 0,
      maximum: SEARCH_CONTEXT_LINES_LIMIT,
      description:
        "Number of context lines to show around each match (default: 1). Only used for content output mode. Overridden by context_before/context_after if specified.",
    },
    context_before: {
      type: "integer",
      minimum: 0,
      maximum: SEARCH_CONTEXT_LINES_LIMIT,
      description:
        "Number of context lines to show BEFORE each match (like grep -B). Overrides 'context' for before-match lines.",
    },
    context_after: {
      type: "integer",
      minimum: 0,
      maximum: SEARCH_CONTEXT_LINES_LIMIT,
      description:
        "Number of context lines to show AFTER each match (like grep -A). Overrides 'context' for after-match lines.",
    },
    case_insensitive: {
      type: "boolean",
      description: "Case-insensitive search (default: false).",
    },
    multiline: {
      type: "boolean",
      description:
        "Enable multiline matching where . matches newlines and patterns can span lines (default: false).",
    },
    max_results: {
      type: "integer",
      minimum: 1,
      maximum: SEARCH_FILES_DEFAULT_MAX_RESULTS,
      description: `Maximum results (default: ${SEARCH_FILES_DEFAULT_MAX_RESULTS}).`,
    },
    offset: {
      type: "integer",
      minimum: 0,
      description:
        "Skip first N matches before returning results. Use with max_results for pagination (e.g. offset=100, max_results=100 for second page).",
    },
    output_mode: {
      type: "string",
      enum: ["content", "files_with_matches", "count"],
      description:
        "Output format: 'content' shows matching lines with context (default), 'files_with_matches' shows only file paths, 'count' shows match counts per file.",
    },
  },
  required: ["path", "regex"],
  additionalProperties: false,
};

function createRipgrepSearchTool(
  runtime: FileToolsRuntime,
  executable: string,
  projectRoot: string,
): HostTool {
  if (!path.isAbsolute(executable)) {
    throw new Error("Workspace ripgrep executable must be absolute");
  }
  return defineTool({
    name: "search_files",
    description:
      "Search a project-relative file or directory with ripgrep regex, matching VS Code's search_files contract.",
    inputSchema: SEARCH_FILES_INPUT_SCHEMA,
    effect: "read",
    parallelSafe: true,
    displayInput: (input) => ({ path: input.path, regex: input.regex }),
    handler: async (input, context) => {
      if (typeof input.path !== "string" || typeof input.regex !== "string") {
        return toolError("invalid_search_input");
      }
      return await executeRipgrepSearch(
        runtime,
        executable,
        projectRoot,
        input.path,
        regexSearchParams(input),
        { sessionId: context.sessionId, turnId: context.turnId },
        context.signal,
      );
    },
  });
}

function regexSearchParams(
  input: Record<string, unknown>,
): RegexSearchFilesParams {
  const integer = (value: unknown) =>
    Number.isSafeInteger(value) ? Number(value) : undefined;
  const mode = input.output_mode;
  return {
    regex: String(input.regex),
    ...(typeof input.file_pattern === "string"
      ? { file_pattern: input.file_pattern }
      : {}),
    ...(input.case_insensitive === true ? { case_insensitive: true } : {}),
    ...(input.multiline === true ? { multiline: true } : {}),
    ...(integer(input.context) !== undefined
      ? { context: integer(input.context) }
      : {}),
    ...(integer(input.context_before) !== undefined
      ? { context_before: integer(input.context_before) }
      : {}),
    ...(integer(input.context_after) !== undefined
      ? { context_after: integer(input.context_after) }
      : {}),
    ...(mode === "content" || mode === "files_with_matches" || mode === "count"
      ? { output_mode: mode }
      : {}),
    ...(integer(input.offset) !== undefined
      ? { offset: integer(input.offset) }
      : {}),
    ...(integer(input.max_results) !== undefined
      ? { max_results: integer(input.max_results) }
      : {}),
  };
}

async function executeRipgrepSearch(
  runtime: FileToolsRuntime,
  executable: string,
  projectRoot: string,
  target: string,
  requested: RegexSearchFilesParams,
  identity: { readonly sessionId: string; readonly turnId: string },
  signal?: AbortSignal,
) {
  if (signal?.aborted) return toolError("search_cancelled");
  const available = await runtime.files.canExecute(executable);
  if (!available) return toolError("packaged_ripgrep_unavailable");
  const stat = await runtime.files.lstat(target).catch(() => undefined);
  if (stat?.kind !== "file" && stat?.kind !== "directory") {
    return toolError("path must point to either a file or directory");
  }
  const pathIsFile = stat.kind === "file";
  const searchDir = pathIsFile ? path.dirname(target) : target;
  const warnings: string[] = [];
  if (pathIsFile && requested.file_pattern) {
    warnings.push(
      "Ignored file_pattern because path already scopes the search to a single file",
    );
  }
  const params: RegexSearchFilesParams = pathIsFile
    ? { ...requested, file_pattern: undefined }
    : requested;
  const maxResults = params.max_results ?? SEARCH_FILES_DEFAULT_MAX_RESULTS;
  const offset = params.offset ?? 0;
  const outputMode = params.output_mode ?? "content";

  const args = [
    "--no-config",
    "--max-filesize",
    "1000K",
    ...buildRipgrepSearchArgs(params),
  ];
  let searchTarget = target;
  if (params.file_pattern) {
    const literal = await literalFilePatternTarget(
      runtime.files,
      projectRoot,
      searchDir,
      params.file_pattern,
    );
    if (literal) searchTarget = literal;
    else args.push(...filePatternGlobArgs(params.file_pattern));
  }
  args.push("--", searchTarget);

  const run = await runRipgrep(
    runtime,
    executable,
    args,
    searchDir,
    identity,
    signal,
  );
  if (!run.ok) {
    if (run.error !== "ripgrep_failed") return toolError(run.error);
    const hint = getEscapingHint(params.regex);
    const payload = {
      error: `ripgrep error: ${run.stderr || `exit code ${run.exitCode ?? "unknown"}`}`,
      regex: params.regex,
      ...(hint ? { hint } : {}),
    };
    return { modelContent: JSON.stringify(payload), isError: true };
  }
  if (run.bounded) {
    warnings.push(
      "Search output reached the host time or size bound; results may be incomplete",
    );
  }
  const warning = warnings.length > 0 ? warnings.join("; ") : undefined;
  const absolute = (file: string) => path.resolve(searchDir, file);
  const included = (file: string) =>
    shouldIncludeProjectReadPath(projectRoot, absolute(file));
  const formatPath = (file: string) =>
    toRelativePath(projectRoot, absolute(file));

  let payload: Record<string, unknown>;
  if (outputMode === "files_with_matches") {
    payload = formatFilesWithMatchesResults(
      run.lines.filter(included).join("\n"),
      { maxResults, offset, formatPath },
    );
    if (warning) payload = { ...payload, warning };
  } else if (outputMode === "count") {
    payload = formatCountSearchResults(
      parseRipgrepCountOutput(run.lines.join("\n"), searchTarget).filter(
        (entry) => included(entry.file),
      ),
      { maxResults, offset, formatPath },
    );
    if (warning) payload = { ...payload, warning };
  } else {
    const parsed = parseRipgrepOutput(run.lines.join("\n"));
    const fileResults = parsed.results.filter((file) => included(file.file));
    const totalMatches = fileResults.reduce(
      (total, file) =>
        total +
        file.searchResults.reduce(
          (count, group) =>
            count + group.lines.filter((line) => line.isMatch).length,
          0,
        ),
      0,
    );
    payload =
      fileResults.length === 0
        ? emptyContentSearchResult(warning)
        : formatContentSearchResults(fileResults, totalMatches, {
            maxResults,
            offset,
            formatPath,
            redactionViews: await searchRedactionViews(
              runtime.files,
              projectRoot,
              fileResults.map((file) => file.file),
              absolute,
            ),
            warning,
          });
  }
  return {
    modelContent: JSON.stringify(payload),
    displayContent: {
      path: target,
      output_mode: outputMode,
      ...pickDefined(payload, [
        "total_matches",
        "total_files",
        "truncated",
        "offset",
      ]),
    },
  };
}

function pickDefined(
  value: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(
    keys
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, value[key]]),
  );
}

/**
 * VS Code treats a separator-containing, glob-free `file_pattern` naming an
 * existing file inside the search directory as the search target. Standalone
 * also requires a private regular file the project read policy allows.
 */
async function literalFilePatternTarget(
  files: WorkspaceFileSystem,
  projectRoot: string,
  searchDir: string,
  filePattern: string,
): Promise<string | undefined> {
  if (!isLiteralFilePatternPath(filePattern) || path.isAbsolute(filePattern)) {
    return undefined;
  }
  const candidate = path.resolve(searchDir, filePattern);
  if (!isPathWithin(candidate, searchDir)) return undefined;
  if (!shouldIncludeProjectReadPath(projectRoot, candidate)) return undefined;
  const stat = await files.lstat(candidate).catch(() => undefined);
  return stat?.kind === "file" ? candidate : undefined;
}

/** Redacted views for matched structured configuration files, as in VS Code. */
async function searchRedactionViews(
  files: WorkspaceFileSystem,
  projectRoot: string,
  matchedFiles: readonly string[],
  absolute: (file: string) => string,
): Promise<Map<string, SearchFileRedactionView>> {
  const views = new Map<string, SearchFileRedactionView>();
  for (const file of matchedFiles) {
    const relativePath = toRelativePath(projectRoot, absolute(file));
    if (!isNodeHostStructuredConfigPath(relativePath)) continue;
    const withheld = {
      withheldMessage:
        "[CONTENT WITHHELD: structured configuration could not be read safely]",
      redactionCount: 0,
    };
    const stat = await files.lstat(absolute(file)).catch(() => undefined);
    if (stat?.kind !== "file" || stat.size > MAX_CONTEXT_BYTES) {
      views.set(file, withheld);
      continue;
    }
    const bytes = await files.readFile(absolute(file)).catch(() => undefined);
    if (!bytes) {
      views.set(file, withheld);
      continue;
    }
    const redacted = redactNodeHostStructuredConfig(
      relativePath,
      bytes.toString("utf8"),
    );
    views.set(
      file,
      redacted.status
        ? {
            withheldMessage:
              "[CONTENT WITHHELD: invalid structured configuration]",
            redactionCount: 0,
          }
        : {
            visibleLines: redacted.content.split("\n"),
            redactionCount: redacted.redactionCount ?? 0,
          },
    );
  }
  return views;
}

type RipgrepRun =
  | {
      readonly ok: true;
      readonly lines: readonly string[];
      /** Stopped by the host time or byte bound rather than ripgrep. */
      readonly bounded: boolean;
    }
  | {
      readonly ok: false;
      readonly error: string;
      readonly stderr?: string;
      readonly exitCode?: number | null;
    };

/**
 * Run the host-packaged ripgrep through the execution backend, keeping at
 * most VS Code's output line cap within the host byte and time bounds.
 */
async function runRipgrep(
  runtime: FileToolsRuntime,
  executable: string,
  args: readonly string[],
  cwd: string,
  identity: { readonly sessionId: string; readonly turnId: string },
  signal?: AbortSignal,
): Promise<RipgrepRun> {
  return await new Promise<RipgrepRun>((resolve) => {
    const lines: string[] = [];
    let buffered = "";
    let stderr = "";
    let outputBytes = 0;
    let bounded = false;
    let lineCapped = false;
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let child: WorkspaceProcessHandle | undefined;
    let terminateRequested = false;
    const terminate = () => {
      terminateRequested = true;
      child?.signal("SIGTERM");
    };
    const abort = terminate;
    const finish = (result: RipgrepRun) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      resolve(result);
    };
    const pushLine = (line: string) => {
      if (lineCapped || !line) return;
      if (lines.length >= SEARCH_FILES_MAX_OUTPUT_LINES) {
        lineCapped = true;
        terminate();
        return;
      }
      lines.push(line.replace(/\r$/u, ""));
    };
    const decoder = new StringDecoder("utf8");
    const onStdout = (chunk: Buffer) => {
      if (lineCapped || outputBytes > MAX_SEARCH_OUTPUT_BYTES) return;
      outputBytes += chunk.length;
      if (outputBytes > MAX_SEARCH_OUTPUT_BYTES) {
        bounded = true;
        terminate();
        return;
      }
      buffered += decoder.write(chunk);
      const parts = buffered.split("\n");
      buffered = parts.pop() ?? "";
      for (const line of parts) pushLine(line);
    };
    const onStderr = (chunk: Buffer) => {
      if (stderr.length < SEARCH_STDERR_BYTES) {
        stderr = (stderr + chunk.toString("utf8")).slice(
          0,
          SEARCH_STDERR_BYTES,
        );
      }
    };
    const onExit = (exit: {
      readonly exitCode?: number;
      readonly signal?: NodeJS.Signals;
    }) => {
      const code = exit.exitCode ?? null;
      const exitSignal = exit.signal ?? null;
      if (buffered && !bounded) pushLine(buffered);
      if (signal?.aborted) {
        finish({ ok: false, error: "search_cancelled" });
        return;
      }
      const stopped = bounded || lineCapped;
      if (
        lines.length === 0 &&
        !stopped &&
        exitSignal === null &&
        code !== 0 &&
        code !== 1
      ) {
        finish({
          ok: false,
          error: "ripgrep_failed",
          stderr: stderr.trim(),
          exitCode: code,
        });
        return;
      }
      finish({ ok: true, lines, bounded });
    };
    try {
      child = launchFileToolProcess(
        runtime,
        {
          executable,
          args,
          cwd,
          environment: runtime.searchEnvironment,
          ...identity,
        },
        (stream, chunk) => {
          if (stream === "stdout") onStdout(chunk);
          else onStderr(chunk);
        },
      );
    } catch {
      finish({ ok: false, error: "packaged_ripgrep_failed" });
      return;
    }
    const launched = child;
    if (terminateRequested) launched.signal("SIGTERM");
    launched.started.then(
      () => launched.exited.then(onExit),
      () => finish({ ok: false, error: "packaged_ripgrep_failed" }),
    );
    timeout = setTimeout(() => {
      bounded = true;
      terminate();
    }, SEARCH_TIMEOUT_MS);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

function createWorkspaceReadFileTool(
  runtime: FileToolsRuntime,
  contentTool: HostTool,
  discovery: HostToolResolveRequest,
  projectRoot: string,
  resolveScopes: ResolveWorkspaceFileScopes,
  enrichReadFileContext: CreateWorkspaceFileToolsOptions["enrichReadFileContext"],
  enrichLegacyContext: CreateWorkspaceFileToolsOptions["enrichContext"],
  tracker: WorkspaceReadFileContextTracker,
): HostTool {
  return defineTool({
    name: "read_file",
    description:
      'Read a project-relative text file with line numbers. Use view "context" for a VS Code-shaped first-pass pack with bounded content, file metadata, Git status, optional symbols and diagnostics, and session working-set state. The default "content" view keeps the narrower exact text reader.',
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          minLength: 1,
          description:
            "Project-relative path. Absolute paths and project escapes are rejected.",
        },
        view: { type: "string", enum: ["content", "context"] },
        offset: { type: "integer", minimum: 1 },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 400,
          description:
            "Maximum lines: 200 for the default content view, 400 for context.",
        },
        include_symbols: { type: "boolean" },
        character_offset: { type: "integer", minimum: 0 },
        dedupe_unchanged_content: { type: "boolean" },
        refresh: { type: "boolean" },
      },
      required: ["path"],
      additionalProperties: false,
    },
    effect: "read",
    authorization: "none",
    parallelSafe: true,
    displayInput: (input) => ({ path: input.path, view: input.view }),
    handler: async (input, context) => {
      if (!sameTurn(discovery, context)) return toolError("tool_turn_mismatch");
      const { files } = runtime;
      const resolved = await resolveProjectPath(
        files,
        projectRoot,
        input.path,
        { allowAbsent: false },
      );
      if (!resolved.ok) return toolError(resolved.error);
      const relativePath = toRelativePath(projectRoot, resolved.path);
      const scopes = await resolveFileScopes(
        files,
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
      if (
        input.view !== undefined &&
        input.view !== "content" &&
        input.view !== "context"
      ) {
        return toolError("invalid_read_file_view");
      }
      if (
        input.view !== "context" &&
        typeof input.limit === "number" &&
        input.limit > 200
      ) {
        return toolError("content_limit_exceeds_200");
      }
      if (
        input.view !== "context" &&
        (input.include_symbols !== undefined ||
          input.character_offset !== undefined ||
          input.dedupe_unchanged_content !== undefined ||
          input.refresh !== undefined)
      ) {
        return toolError("context_options_require_context_view");
      }
      if (input.view !== "context") {
        const contentInput = { ...input };
        delete contentInput.view;
        delete contentInput.include_symbols;
        delete contentInput.character_offset;
        delete contentInput.dedupe_unchanged_content;
        delete contentInput.refresh;
        return projectResult(
          await contentTool.execute(
            { ...contentInput, path: resolved.path },
            context,
          ),
          projectRoot,
          "read_file",
        );
      }
      const stat = await files.lstat(resolved.path).catch(() => undefined);
      if (stat?.kind !== "file" || stat.nlink > 1) {
        return toolError("not_a_private_regular_file");
      }
      if (stat.size > MAX_CONTEXT_BYTES) return toolError("file_too_large");
      const bytes = await files.readFile(resolved.path);
      if (bytes.includes(0)) return toolError("binary_file");
      const redacted = redactNodeHostStructuredConfig(
        resolved.path,
        bytes.toString("utf8"),
      );
      const includeSymbols = input.include_symbols !== false;
      const [git, enrichment, legacyLanguageIntelligence] = await Promise.all([
        readGitStatus(runtime, projectRoot, relativePath, discovery),
        enrichReadFileContext
          ? Promise.resolve(
              enrichReadFileContext(discovery, relativePath, {
                includeSymbols,
                signal: context.signal,
              }),
            ).catch(() => undefined)
          : undefined,
        enrichLegacyContext
          ? Promise.resolve(
              enrichLegacyContext(discovery, relativePath, context.signal),
            ).catch((error) => ({
              state: "failed",
              reason: `language_context_failed:${toolErrorCode(error)}`,
              retryable: true,
            }))
          : undefined,
      ]);
      const result = buildWorkspaceReadFileContext(
        {
          sessionId: context.sessionId,
          path: relativePath,
          absolutePath: resolved.path,
          bytes,
          modifiedMs: stat.mtimeMs,
          content: redacted.content,
          redacted: redacted.redacted,
          ...(redacted.status ? { redactionStatus: redacted.status } : {}),
          language: detectWorkspaceReadFileLanguage(relativePath),
          ...(git.status === "available" ? { gitStatus: git.value } : {}),
          ...(enrichment ? { enrichment } : {}),
          ...(legacyLanguageIntelligence !== undefined
            ? { legacyLanguageIntelligence }
            : {}),
          params: {
            ...(typeof input.offset === "number"
              ? { offset: input.offset }
              : {}),
            ...(typeof input.limit === "number" ? { limit: input.limit } : {}),
            ...(typeof input.character_offset === "number"
              ? { characterOffset: input.character_offset }
              : {}),
            ...(input.dedupe_unchanged_content === true
              ? { dedupeUnchangedContent: true }
              : {}),
            ...(input.refresh === true ? { refresh: true } : {}),
          },
        },
        tracker,
      );
      if (!result.ok) return toolError(result.error);
      return {
        modelContent: JSON.stringify(result.payload, null, 2),
        displayContent: result.display,
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
    case "list_files":
      return "List bounded project files using a project-relative directory path.";
    case "search_files":
      return "Search a project-relative file or directory with a ripgrep regex. output_mode selects matching lines with context (content, default), file paths (files_with_matches), or per-file counts (count); file_pattern filters files by glob, context/context_before/context_after set context lines, case_insensitive and multiline adjust matching, and offset with max_results pages results. Ignored and protected paths are excluded and structured-config secrets are redacted. Indexed natural-language query search is not available on this surface.";
    case "write_file":
      return 'Propose a reviewed project-relative file replacement. Existing files require the SHA-256 hash returned by read_file with view "context"; new files require expectedAbsent=true.';
    case "apply_diff":
      return "Edit one existing project-relative file with SEARCH/REPLACE blocks or unified-diff hunks, reviewed before writing. Each block requires a unique match by default; block_options can select a 1-based occurrence or intentionally replace all exact matches, and atomic=true requires every block to validate. expectedContentHash is optional: when omitted, the baseline shown for review is pinned. Ambiguous failures include candidate locations plus copy-ready block_options.";
    default:
      return name;
  }
}

async function prepareWriteApproval(
  files: WorkspaceFileSystem,
  projectRoot: string,
  toolName: "write_file" | "apply_diff",
  input: Readonly<Record<string, unknown>>,
  scopes: readonly ResolvedWorkspaceFileScope[],
): Promise<
  | {
      ok: true;
      display: WorkspaceFileApprovalDisplay;
      /** Input executed after approval; apply_diff gains its pinned baseline. */
      preparedInput: Readonly<Record<string, unknown>>;
    }
  | { ok: "no_write"; preparedInput: Readonly<Record<string, unknown>> }
  | { ok: false; reason: string }
> {
  const resolved = await resolveProjectPath(files, projectRoot, input.path, {
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
  const stat = await files.lstat(resolved.path).catch(() => undefined);
  if (stat && (stat.kind !== "file" || stat.nlink > 1)) {
    return { ok: false, reason: "Target is not a private regular file" };
  }
  if (stat && stat.size > MAX_CONTEXT_BYTES) {
    return { ok: false, reason: "File is too large for reviewed editing" };
  }
  const currentBytes = stat ? await files.readFile(resolved.path) : undefined;
  if (currentBytes?.includes(0)) {
    return { ok: false, reason: "Binary files cannot be reviewed as text" };
  }
  const current = currentBytes?.toString("utf8");
  let proposed: string;
  let operation: "created" | "modified";
  let expectedContentHash: string | undefined;
  let expectedAbsent: true | undefined;
  let effectiveInput: Readonly<Record<string, unknown>> = input;
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
    if (typeof input.diff !== "string" || !input.diff) {
      return { ok: false, reason: "Invalid patch" };
    }
    const currentHash = contentHash(current);
    const suppliedHash = stringValue(input.expectedContentHash);
    if (suppliedHash !== undefined && suppliedHash !== currentHash) {
      return { ok: false, reason: "File baseline changed before review" };
    }
    // VS Code reads the file itself; standalone review pins the baseline it
    // shows, so the write applies to exactly the reviewed content.
    expectedContentHash = currentHash;
    effectiveInput = { ...input, expectedContentHash };
    const plan = planApplyDiff(relativePath, current, {
      diff: input.diff,
      block_options: applyDiffBlockOptions(input.block_options),
      atomic: input.atomic === true,
    });
    if (plan.status === "failed" || !plan.changed) {
      return { ok: "no_write", preparedInput: effectiveInput };
    }
    proposed = plan.content;
    operation = "modified";
  }
  const proposedBytes = Buffer.byteLength(proposed, "utf8");
  if (proposedBytes > MAX_CONTEXT_BYTES) {
    return { ok: false, reason: "Proposed file is too large" };
  }
  const proposedContentHash = contentHash(proposed);
  const scopeDigest = fileScopeDigest(scopes);
  const inputDigest = contentHash(JSON.stringify(effectiveInput));
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
    preparedInput: effectiveInput,
  };
}

const FIND_AND_REPLACE_WALK_ENTRY_LIMIT = 50_000;

/** VS Code's `find_and_replace` input; writes never run a formatter here. */
const FIND_AND_REPLACE_INPUT_SCHEMA: CoreModelJsonSchema = {
  type: "object",
  properties: {
    find: {
      type: "string",
      description:
        "Text to find. Treated as a literal string unless regex=true.",
    },
    replace: { type: "string", description: "Replacement text" },
    path: {
      type: "string",
      minLength: 1,
      description:
        "Single project-relative file path to search in. Mutually exclusive with glob.",
    },
    glob: {
      type: "string",
      minLength: 1,
      maxLength: 500,
      description:
        "Glob pattern relative to the project root (e.g. 'src/**/*.ts'). Mutually exclusive with path.",
    },
    regex: {
      type: "boolean",
      description:
        "Regex search (default false). Replacement: $1-$99 captures, $$ literal dollar, \\n \\t \\\\ escapes. Missing captures and $0 stay literal; unmatched optional groups become empty. Two-digit references fall back to one digit. Other $ and \\ tokens stay literal.",
    },
    max_replacements: {
      type: "integer",
      description:
        "Maximum allowed matches to replace. Must be a positive integer. If total matches exceed this value, no edits are applied and the tool returns a guardrail error payload.",
    },
    expectedContentHashes: {
      type: "object",
      maxProperties: FIND_AND_REPLACE_MAX_GLOB_FILES,
      additionalProperties: { type: "string", pattern: "^[a-f0-9]{64}$" },
      description:
        "Optional map of project-relative path to the SHA-256 you read. Normally omitted: the host pins the baselines shown for review.",
    },
  },
  required: ["find", "replace"],
  additionalProperties: false,
};

interface FindAndReplaceTarget {
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly content: string;
}

type WorkspaceFindAndReplacePlan =
  | { readonly status: "error"; readonly error: string }
  | { readonly status: "final"; readonly payload: Record<string, unknown> }
  | {
      readonly status: "ready";
      readonly files: readonly FindAndReplaceFilePlan[];
      readonly totalMatches: number;
      readonly absolutePaths: ReadonlyMap<string, string>;
    };

/**
 * VS Code's find_and_replace decision over project files: `path` names one
 * file, `glob` walks the project (skipping `.git`, `node_modules`, and
 * read-protected paths) for up to 500 matching readable text files.
 */
async function planWorkspaceFindAndReplace(
  files: WorkspaceFileSystem,
  projectRoot: string,
  input: Readonly<Record<string, unknown>>,
  scopes: readonly ResolvedWorkspaceFileScope[],
): Promise<WorkspaceFindAndReplacePlan> {
  if (typeof input.find !== "string" || typeof input.replace !== "string") {
    return { status: "error", error: "'find' and 'replace' must be strings" };
  }
  if (!input.find) {
    return { status: "error", error: "'find' parameter is required" };
  }
  const regex = input.regex === true;
  const pattern = buildFindAndReplacePattern(input.find, regex);
  if (!pattern.ok) return { status: "error", error: pattern.error };

  let candidates: string[];
  if (typeof input.path === "string" && input.path) {
    const resolved = await resolveProjectPath(files, projectRoot, input.path, {
      allowAbsent: false,
    });
    if (!resolved.ok) return { status: "error", error: resolved.error };
    const relativePath = toRelativePath(projectRoot, resolved.path);
    if (!scopeAllows(scopes, relativePath, "read")) {
      return { status: "error", error: "path_not_scoped" };
    }
    const protection = protectedPath(relativePath);
    if (protection.blockRead) {
      return {
        status: "error",
        error: protection.reason ?? "protected_content",
      };
    }
    if (isIgnoredPath(relativePath)) {
      return { status: "error", error: "path_ignored" };
    }
    candidates = [resolved.path];
  } else if (typeof input.glob === "string" && input.glob) {
    candidates = await findProjectFilesByGlob(
      files,
      projectRoot,
      input.glob,
      scopes,
    );
    if (candidates.length === 0) {
      return {
        status: "error",
        error: `No files matched glob pattern: ${input.glob}`,
      };
    }
  } else {
    return {
      status: "error",
      error: "Either 'path' or 'glob' must be specified",
    };
  }

  // Like VS Code, files that cannot be opened as text are skipped.
  const targets: FindAndReplaceTarget[] = [];
  for (const absolutePath of candidates) {
    const content = await readReviewableText(files, absolutePath);
    if (content === undefined) continue;
    targets.push({
      relativePath: toRelativePath(projectRoot, absolutePath),
      absolutePath,
      content,
    });
  }
  const plan = planFindAndReplace(
    {
      find: input.find,
      replace: input.replace,
      regex,
      ...(input.max_replacements !== undefined
        ? { max_replacements: input.max_replacements as number }
        : {}),
    },
    targets.map((target) => ({
      path: target.relativePath,
      content: target.content,
    })),
  );
  if (plan.status !== "ready") return plan;
  return {
    ...plan,
    absolutePaths: new Map(
      targets.map((target) => [target.relativePath, target.absolutePath]),
    ),
  };
}

async function findProjectFilesByGlob(
  files: WorkspaceFileSystem,
  projectRoot: string,
  glob: string,
  scopes: readonly ResolvedWorkspaceFileScope[],
): Promise<string[]> {
  const matches = createNodeHostGlobMatcher(glob);
  const found: string[] = [];
  const queue = [projectRoot];
  let visited = 0;
  while (queue.length > 0) {
    const directory = queue.shift()!;
    const entries = await files.readDirectory(directory).catch(() => []);
    // Sorted so review and pending validation see the same file order.
    for (const entry of [...entries].sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    )) {
      visited += 1;
      if (visited > FIND_AND_REPLACE_WALK_ENTRY_LIMIT) return found;
      const absolutePath = path.join(directory, entry.name);
      const relativePath = toRelativePath(projectRoot, absolutePath);
      if (
        isIgnoredPath(relativePath) ||
        protectedPath(relativePath).blockRead
      ) {
        continue;
      }
      if (entry.kind === "directory") {
        queue.push(absolutePath);
      } else if (
        entry.kind === "file" &&
        matches(relativePath) &&
        scopeAllows(scopes, relativePath, "read")
      ) {
        found.push(absolutePath);
        if (found.length >= FIND_AND_REPLACE_MAX_GLOB_FILES) return found;
      }
    }
  }
  return found;
}

async function readReviewableText(
  files: WorkspaceFileSystem,
  absolutePath: string,
): Promise<string | undefined> {
  const stat = await files.lstat(absolutePath).catch(() => undefined);
  if (
    stat?.kind !== "file" ||
    stat.nlink > 1 ||
    stat.size > MAX_CONTEXT_BYTES
  ) {
    return undefined;
  }
  const bytes = await files.readFile(absolutePath).catch(() => undefined);
  if (!bytes || bytes.includes(0)) return undefined;
  return bytes.toString("utf8");
}

function findAndReplaceBaselines(
  planned: readonly FindAndReplaceFilePlan[],
): Record<string, string> {
  return Object.fromEntries(
    planned.map((file) => [file.path, contentHash(file.content)]),
  );
}

function sameBaselines(
  supplied: unknown,
  current: Readonly<Record<string, string>>,
): boolean {
  if (!supplied || typeof supplied !== "object" || Array.isArray(supplied)) {
    return false;
  }
  const record = supplied as Record<string, unknown>;
  const keys = Object.keys(current);
  return (
    Object.keys(record).length === keys.length &&
    keys.every((key) => record[key] === current[key])
  );
}

/**
 * Review one find_and_replace proposal. The reviewed baseline of every file
 * is pinned into `expectedContentHashes` (host-prepared input) so the write
 * applies to exactly the content shown.
 */
async function prepareFindAndReplaceApproval(
  files: WorkspaceFileSystem,
  projectRoot: string,
  input: Readonly<Record<string, unknown>>,
  scopes: readonly ResolvedWorkspaceFileScope[],
): Promise<
  | {
      ok: true;
      display: WorkspaceFileApprovalDisplay;
      preparedInput: Readonly<Record<string, unknown>>;
    }
  | { ok: "no_write"; preparedInput: Readonly<Record<string, unknown>> }
  | { ok: false; reason: string }
> {
  const { expectedContentHashes: supplied, ...rest } = input;
  const planned = await planWorkspaceFindAndReplace(
    files,
    projectRoot,
    rest,
    scopes,
  );
  if (planned.status !== "ready") {
    return {
      ok: "no_write",
      preparedInput: { ...rest, expectedContentHashes: {} },
    };
  }
  const baselines = findAndReplaceBaselines(planned.files);
  if (supplied !== undefined && !sameBaselines(supplied, baselines)) {
    return { ok: false, reason: "File baseline changed before review" };
  }
  const entries: WorkspaceFileApprovalDisplayFile[] = [];
  const diffs: string[] = [];
  let bytes = 0;
  for (const file of planned.files) {
    if (!scopeAllows(scopes, file.path, "write")) {
      return {
        ok: false,
        reason: `Path is outside the active write scope: ${file.path}`,
      };
    }
    const protection = protectedPath(file.path);
    if (protection.blockWrite) {
      return {
        ok: false,
        reason: `Writes to ${protection.reason ?? "this protected path"} are not supported`,
      };
    }
    const fileBytes = Buffer.byteLength(file.proposedContent, "utf8");
    if (fileBytes > MAX_CONTEXT_BYTES) {
      return { ok: false, reason: "Proposed file is too large" };
    }
    bytes += fileBytes;
    entries.push({
      path: file.path,
      changes: file.replacements.length,
      expectedContentHash: baselines[file.path]!,
      proposedContentHash: contentHash(file.proposedContent),
      bytes: fileBytes,
      protected: protection.protected,
      ...(protection.reason ? { protectionReason: protection.reason } : {}),
    });
    diffs.push(
      renderReviewDiff(
        file.path,
        file.content,
        file.proposedContent,
        "modified",
      ),
    );
  }
  const preparedInput = { ...rest, expectedContentHashes: baselines };
  const protectedEntry = entries.find((entry) => entry.protected);
  const scopeDigest = fileScopeDigest(scopes);
  const operationDigest = contentHash(
    JSON.stringify({
      policyRevision: POLICY_REVISION,
      toolName: "find_and_replace",
      projectRoot,
      files: entries,
      scopeDigest,
      inputDigest: contentHash(JSON.stringify(preparedInput)),
    }),
  );
  return {
    ok: true,
    display: {
      kind: "file_write",
      toolName: "find_and_replace",
      path: entries.length === 1 ? entries[0]!.path : `${entries.length} files`,
      operation: "modified",
      expectedContentHash: contentHash(JSON.stringify(baselines)),
      proposedContentHash: contentHash(
        JSON.stringify(
          entries.map((entry) => [entry.path, entry.proposedContentHash]),
        ),
      ),
      bytes,
      diff: diffs.join("\n"),
      protected: protectedEntry !== undefined,
      ...(protectedEntry?.protectionReason
        ? { protectionReason: protectedEntry.protectionReason }
        : {}),
      files: entries,
      replacements: planned.totalMatches,
      scopeDigest,
      operationDigest,
      policyRevision: POLICY_REVISION,
    },
    preparedInput,
  };
}

/**
 * VS Code's `find_and_replace` over project-relative files. Execution needs
 * the per-file baselines pinned at review; each file is then written with
 * the same locked, hash-pinned, exact replacement as `write_file`.
 */
function createFindAndReplaceTool(
  files: WorkspaceFileSystem,
  discovery: HostToolResolveRequest,
  projectRoot: string,
  resolveScopes: ResolveWorkspaceFileScopes,
  writeFile: HostTool,
  canWritePath: CreateWorkspaceFileToolsOptions["canWritePath"] | undefined,
  onFileCommitted:
    | CreateWorkspaceFileToolsOptions["onFileCommitted"]
    | undefined,
  mutations: WorkspaceFileMutationCoordinator | undefined,
): HostTool {
  return defineTool({
    name: "find_and_replace",
    description:
      "Bulk find-and-replace across one or more project files (project-relative path or glob). The complete diff is reviewed before applying, and literal strings or regex with capture groups are supported. Writes preserve exact content; no formatter runs.",
    inputSchema: FIND_AND_REPLACE_INPUT_SCHEMA,
    effect: "write",
    authorization: "required",
    parallelSafe: false,
    displayInput: (input) => ({
      find: input.find,
      replace: input.replace,
      ...(input.path !== undefined ? { path: input.path } : {}),
      ...(input.glob !== undefined ? { glob: input.glob } : {}),
    }),
    handler: async (input, context) => {
      if (!sameTurn(discovery, context)) return toolError("tool_turn_mismatch");
      const scopes = await resolveFileScopes(
        files,
        projectRoot,
        resolveScopes,
        discovery,
      );
      const { expectedContentHashes, ...rest } = input;
      const planned = await planWorkspaceFindAndReplace(
        files,
        projectRoot,
        rest,
        scopes,
      );
      if (planned.status === "error") {
        const payload = { error: planned.error };
        return {
          modelContent: JSON.stringify(payload),
          displayContent: payload,
          isError: true,
        };
      }
      if (planned.status === "final") {
        return {
          modelContent: JSON.stringify(planned.payload),
          displayContent: planned.payload,
        };
      }
      if (
        !expectedContentHashes ||
        typeof expectedContentHashes !== "object" ||
        Array.isArray(expectedContentHashes)
      ) {
        return toolError("expected_content_hashes_required");
      }
      const baselines = findAndReplaceBaselines(planned.files);
      if (!sameBaselines(expectedContentHashes, baselines)) {
        const pinned = expectedContentHashes as Record<string, unknown>;
        const changed =
          planned.files.find(
            (file) => pinned[file.path] !== baselines[file.path],
          )?.path ?? Object.keys(pinned).find((key) => !(key in baselines));
        const payload = {
          status: "stale_proposal",
          no_changes_applied: true,
          ...(changed ? { path: changed } : {}),
          message:
            "File content changed after the replacement preview; review a fresh proposal before retrying.",
        };
        return {
          modelContent: JSON.stringify(payload),
          displayContent: payload,
        };
      }
      for (const file of planned.files) {
        if (
          !scopeAllows(scopes, file.path, "write") ||
          protectedPath(file.path).blockWrite
        ) {
          return toolError("path_not_scoped");
        }
      }
      const execute = async () => {
        if (canWritePath) {
          for (const file of planned.files) {
            if (!(await canWritePath(discovery, file.path))) {
              return toolError("path_reserved_by_active_writer");
            }
          }
        }
        const results: Array<Record<string, unknown>> = [];
        const saved: string[] = [];
        let failure: string | undefined;
        for (const file of planned.files) {
          const changes = file.replacements.length;
          if (failure) {
            results.push({ path: file.path, changes, status: "not_attempted" });
            continue;
          }
          const written = await writeFile.execute(
            {
              path: planned.absolutePaths.get(file.path),
              content: file.proposedContent,
              expectedContentHash: baselines[file.path],
            },
            context,
          );
          const parsed = parseJsonRecord(written.modelContent);
          const durability = parsed?.durability as
            | { status?: unknown; final_content_hash?: unknown }
            | undefined;
          if (
            written.isError ||
            durability?.status !== "durable" ||
            typeof durability.final_content_hash !== "string"
          ) {
            failure = file.path;
            results.push({
              path: file.path,
              changes,
              status: "error",
              error:
                typeof parsed?.error === "string"
                  ? parsed.error
                  : "write_failed",
            });
            continue;
          }
          saved.push(file.path);
          results.push({
            path: file.path,
            changes,
            durability,
            post_edit_content_hash: durability.final_content_hash,
          });
          if (onFileCommitted) {
            await Promise.resolve(onFileCommitted(discovery, file.path)).catch(
              () => undefined,
            );
          }
        }
        const summary = {
          find: rest.find,
          replace: rest.replace,
          total_replacements: planned.totalMatches,
        };
        if (!failure) {
          const payload = {
            status: "applied",
            ...summary,
            files_changed: saved.length,
            files: results,
          };
          return {
            modelContent: JSON.stringify(payload),
            displayContent: payload,
          };
        }
        const failed = planned.files
          .map((file) => file.path)
          .filter((filePath) => !saved.includes(filePath));
        const payload = {
          error: `Failed to write ${failed.length} of ${planned.files.length} replacement file${planned.files.length !== 1 ? "s" : ""}`,
          ...summary,
          status: saved.length > 0 ? "partial" : "error",
          reason: "write_failed",
          saved_files: saved,
          failed_files: failed,
          files: results,
          next_steps: [
            "Replacements in saved_files were written and verified; do not repeat them.",
            "Re-read each failed file before retrying.",
          ],
        };
        return {
          modelContent: JSON.stringify(payload),
          displayContent: payload,
          isError: true,
        };
      };
      return mutations
        ? await mutations.withCommit(execute, context.signal)
        : await execute();
    },
  });
}

function parseJsonRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

async function resolveProjectPath(
  files: WorkspaceFileSystem,
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
  const existing = await files.realpath(requested).catch(() => undefined);
  if (existing) {
    if (!isPathWithin(existing, projectRoot)) {
      return { ok: false, error: "symlink_escape" };
    }
    return existing === requested
      ? { ok: true, path: existing }
      : { ok: false, error: "path_alias" };
  }
  if (!options.allowAbsent) return { ok: false, error: "path_not_found" };
  const ancestor = await nearestExistingAncestor(
    files,
    path.dirname(requested),
  );
  if (!ancestor) return { ok: false, error: "parent_not_found" };
  const realAncestor = await files.realpath(ancestor).catch(() => undefined);
  if (!realAncestor || !isPathWithin(realAncestor, projectRoot)) {
    return { ok: false, error: "parent_escape" };
  }
  if (realAncestor !== ancestor) return { ok: false, error: "path_alias" };
  return { ok: true, path: requested };
}

async function ensureSafeParent(
  files: WorkspaceFileSystem,
  projectRoot: string,
  target: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const parent = path.dirname(target);
  const relative = path.relative(projectRoot, parent);
  let current = projectRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = await files.lstat(current).catch(() => undefined);
    if (stat) {
      if (stat.kind !== "directory") {
        return { ok: false, error: "unsafe_parent" };
      }
      continue;
    }
    try {
      await files.mkdir(current, { mode: 0o700 });
    } catch {
      return { ok: false, error: "parent_creation_failed" };
    }
  }
  const realParent = await files.realpath(parent).catch(() => undefined);
  return realParent && isPathWithin(realParent, projectRoot)
    ? { ok: true }
    : { ok: false, error: "parent_escape" };
}

async function nearestExistingAncestor(
  files: WorkspaceFileSystem,
  candidate: string,
): Promise<string | undefined> {
  let current = candidate;
  for (;;) {
    if (await files.lstat(current).catch(() => undefined)) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
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
  fileSystem: WorkspaceFileSystem = createLocalWorkspaceExecutionBackend()
    .fileSystem,
): Promise<boolean> {
  const [parents, children] = await Promise.all([
    resolveDeclaredFileScopes(fileSystem, projectRoot, parentScopes),
    resolveDeclaredFileScopes(fileSystem, projectRoot, childScopes),
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
  files: WorkspaceFileSystem,
  projectRoot: string,
  resolveScopes: ResolveWorkspaceFileScopes,
  request: WorkspaceFileScopeRequest,
): Promise<readonly ResolvedWorkspaceFileScope[]> {
  return await resolveDeclaredFileScopes(
    files,
    projectRoot,
    await resolveScopes(request),
  );
}

async function resolveDeclaredFileScopes(
  files: WorkspaceFileSystem,
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
    const candidate = await resolveProjectPath(files, projectRoot, scope.path, {
      allowAbsent: true,
    });
    if (!candidate.ok)
      throw new Error(`invalid_workspace_file_scope:${candidate.error}`);
    const stat = await files.lstat(candidate.path).catch(() => undefined);
    if (
      stat &&
      ((scope.kind === "file" && stat.kind !== "file") ||
        (scope.kind === "directory" && stat.kind !== "directory"))
    ) {
      throw new Error("invalid_workspace_file_scope:kind_mismatch");
    }
    const relativePath = toRelativePath(projectRoot, candidate.path);
    const ancestor = stat
      ? candidate.path
      : await nearestExistingAncestor(files, path.dirname(candidate.path));
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
    (display.toolName === "write_file" ||
      display.toolName === "apply_diff" ||
      display.toolName === "find_and_replace") &&
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
    current.protectionReason === stored.protectionReason &&
    current.replacements === stored.replacements &&
    JSON.stringify(current.files) === JSON.stringify(stored.files)
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
  // Fallback node-host search (no packaged ripgrep) returns a match array.
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
  runtime: FileToolsRuntime,
  projectRoot: string,
  relativePath: string,
  identity: { readonly sessionId: string; readonly turnId: string },
): Promise<{ status: "available"; value: string } | { status: "unavailable" }> {
  const executable = await runtime.resolveGitExecutable();
  if (!executable) return { status: "unavailable" };
  return await new Promise((resolve) => {
    let output = "";
    const decoder = new StringDecoder("utf8");
    let child: WorkspaceProcessHandle;
    try {
      child = launchFileToolProcess(
        runtime,
        {
          executable,
          args: [
            "status",
            "--porcelain=v1",
            "--untracked-files=all",
            "--",
            relativePath,
          ],
          cwd: projectRoot,
          environment: { PATH: "/usr/bin:/bin", GIT_OPTIONAL_LOCKS: "0" },
          sessionId: identity.sessionId,
          turnId: identity.turnId,
        },
        (stream, chunk) => {
          if (stream === "stdout" && output.length < 4_000) {
            output += decoder.write(chunk);
          }
        },
      );
    } catch {
      resolve({ status: "unavailable" });
      return;
    }
    const timer = setTimeout(() => child.signal("SIGKILL"), 2_000);
    child.started.then(
      () =>
        child.exited.then((exit) => {
          clearTimeout(timer);
          resolve(
            exit.exitCode === 0
              ? {
                  status: "available",
                  value: normalizeWorkspaceGitStatus(output + decoder.end()),
                }
              : { status: "unavailable" },
          );
        }),
      () => {
        clearTimeout(timer);
        resolve({ status: "unavailable" });
      },
    );
  });
}

export type WorkspaceGitStatus =
  | "unmerged"
  | "staged"
  | "modified"
  | "untracked"
  | "clean";

export function normalizeWorkspaceGitStatus(
  output: string,
): WorkspaceGitStatus {
  const codes = output
    .split(/\r?\n/gu)
    .map((line) => line.slice(0, 2))
    .filter((code) => code.length === 2 && code !== "##");
  if (codes.some((code) => /^(?:DD|AU|UD|UA|DU|AA|UU)$/u.test(code))) {
    return "unmerged";
  }
  if (codes.some((code) => code[0] !== " " && code[0] !== "?")) {
    return "staged";
  }
  if (codes.some((code) => code[1] !== " " && code[1] !== "?")) {
    return "modified";
  }
  if (codes.some((code) => code === "??")) return "untracked";
  return "clean";
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

function toolErrorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    return String((error as { code?: unknown }).code);
  }
  return error instanceof Error ? error.name : "unknown";
}

function toolError(code: string) {
  return { modelContent: JSON.stringify({ error: code }), isError: true };
}
