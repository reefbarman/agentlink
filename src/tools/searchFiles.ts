import * as fs from "fs/promises";
import * as path from "path";

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
  SEARCH_FILES_DEFAULT_MAX_RESULTS,
  type SearchFileRedactionView,
} from "@agentlink/core/search-files";
import type {
  PathAccessProvider,
  SearchFilesParams,
  SemanticSearchProvider,
  WorkspaceFileProvider,
} from "../core/capabilities/readSearch.js";
import { getRelativePath, resolveAndValidatePath } from "../util/paths.js";
import {
  getRipgrepBinPath,
  execRipgrepSearch,
  parseRipgrepOutput,
} from "../util/ripgrep.js";
import type { ApprovalManager } from "../approvals/ApprovalManager.js";
import type { ApprovalPanelProvider } from "../approvals/ApprovalPanelProvider.js";
import { isAgentInstructionReadPath } from "../approvals/protectedPaths.js";
import { approveOutsideWorkspaceAccess } from "./pathAccessUI.js";
import { isAgentlinkTmpArtifact } from "../util/agentlinkTmpArtifacts.js";
import {
  isStructuredConfigPath,
  redactStructuredSecrets,
} from "../shared/structuredSecretRedaction.js";

import {
  errorResult,
  handleToolError,
  jsonResult,
  type ToolResult,
} from "@agentlink/protocol/tool-result";
import { getSearchInputError } from "../core/tools/searchInputValidation.js";

export {
  expandSimpleBraceGlob,
  getEscapingHint,
  needsMultiline,
  needsPcre2,
  sanitizeRegex,
} from "@agentlink/core/search-files";

export interface SearchFilesProviders {
  workspaceFileProvider: WorkspaceFileProvider;
  pathAccessProvider: PathAccessProvider;
  semanticSearchProvider?: SemanticSearchProvider;
}

function formatResultPath(filePath: string, searchDir: string): string {
  const absolutePath = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(searchDir, filePath);
  return getRelativePath(absolutePath);
}

function withWarning(result: ToolResult, warning?: string): ToolResult {
  if (
    !warning ||
    result.isError ||
    !result.data ||
    typeof result.data !== "object" ||
    Array.isArray(result.data)
  ) {
    return result;
  }
  return jsonResult({ ...result.data, warning }, true);
}

function createLegacySearchFilesProviders(
  approvalManager: ApprovalManager,
  approvalPanel: ApprovalPanelProvider,
): SearchFilesProviders {
  return {
    workspaceFileProvider: {
      resolvePath(inputPath) {
        return resolveAndValidatePath(inputPath);
      },
    },
    pathAccessProvider: {
      async ensureAccess(request) {
        if (request.inWorkspace) {
          return { approved: true };
        }
        if (
          isAgentlinkTmpArtifact(request.absolutePath) ||
          isAgentInstructionReadPath(request.absolutePath)
        ) {
          return { approved: true };
        }
        if (
          approvalManager.isPathTrusted(request.sessionId, request.absolutePath)
        ) {
          return { approved: true };
        }
        return approveOutsideWorkspaceAccess(
          request.absolutePath,
          approvalManager,
          approvalPanel,
          request.sessionId,
        );
      },
    },
  };
}

async function addFilePatternArgs(
  args: string[],
  dirPath: string,
  filePattern?: string,
  defaultSearchTarget: string = dirPath,
): Promise<string> {
  if (!filePattern) {
    return defaultSearchTarget;
  }

  const resolvedFile = await resolveFilePatternAsPath(filePattern, dirPath);
  if (resolvedFile) {
    return resolvedFile;
  }

  args.push(...filePatternGlobArgs(filePattern));
  return defaultSearchTarget;
}

/**
 * Detect if `file_pattern` looks like a literal file path rather than a glob.
 * Returns the resolved absolute path if the file exists, otherwise undefined.
 *
 * A pattern is treated as a literal file path when it contains a path separator
 * (`/` or `\`) and does NOT contain any glob metacharacters (`*`, `?`, `[`, `{`).
 */
export async function resolveFilePatternAsPath(
  filePattern: string,
  searchDir: string,
): Promise<string | undefined> {
  if (!isLiteralFilePatternPath(filePattern)) {
    return undefined;
  }
  const candidate = path.isAbsolute(filePattern)
    ? filePattern
    : path.resolve(searchDir, filePattern);
  // Ensure the resolved path stays within the search directory
  // to prevent path traversal (e.g. ../../etc/passwd)
  const normalizedCandidate = path.normalize(candidate);
  const normalizedDir = path.normalize(searchDir) + path.sep;
  if (
    !normalizedCandidate.startsWith(normalizedDir) &&
    normalizedCandidate !== path.normalize(searchDir)
  ) {
    return undefined;
  }
  try {
    const stat = await fs.stat(candidate);
    if (stat.isFile()) {
      return candidate;
    }
  } catch {
    // file doesn't exist
  }
  return undefined;
}

export async function handleSearchFiles(
  params: SearchFilesParams,
  approvalManager: ApprovalManager,
  approvalPanel: ApprovalPanelProvider,
  sessionId: string,
  providers = createLegacySearchFilesProviders(approvalManager, approvalPanel),
): Promise<ToolResult> {
  try {
    const inputError = getSearchInputError("search_files", params);
    if (inputError)
      return errorResult(inputError, { status: "invalid_search_input" });
    const { absolutePath: resolvedPath, inWorkspace } =
      providers.workspaceFileProvider.resolvePath(params.path);
    if (params.query !== undefined && !inWorkspace) {
      return errorResult(
        "Indexed query search is restricted to workspace folders. Use regex for external paths.",
        { path: params.path },
      );
    }

    const access = await providers.pathAccessProvider.ensureAccess({
      absolutePath: resolvedPath,
      inputPath: params.path,
      inWorkspace,
      sessionId,
      kind: "read",
    });
    if (!access.approved) {
      return jsonResult({
        status: "rejected",
        path: params.path,
        ...(access.reason && { reason: access.reason }),
      });
    }

    let searchDir = resolvedPath;
    let defaultSearchTarget = resolvedPath;
    let pathIsFile = false;

    try {
      const stat = await fs.stat(resolvedPath);
      if (stat.isFile()) {
        pathIsFile = true;
        searchDir = path.dirname(resolvedPath);
      } else if (!stat.isDirectory()) {
        return errorResult(
          "path must point to either a file or directory for search_files",
          { path: params.path },
        );
      }
    } catch {
      return errorResult("path does not exist", { path: params.path });
    }

    if (params.query !== undefined) {
      if (!providers.semanticSearchProvider) {
        return errorResult(
          "Indexed query search is unavailable on this surface.",
        );
      }
      const result = await providers.semanticSearchProvider.search({
        query: params.query,
        path: resolvedPath,
        exactFile: pathIsFile,
        limit: Math.max(1, Math.min(300, Math.trunc(params.max_results ?? 10))),
        exclude_globs: params.exclude_globs,
      });
      const ignored = [
        "file_pattern",
        "case_insensitive",
        "multiline",
        "context",
        "context_before",
        "context_after",
        "output_mode",
        "offset",
      ].filter((key) => Object.hasOwn(params, key));
      const output = jsonResult(result.payload, true);
      if (result.isError) output.isError = true;
      if (result.error) output.error = result.error;
      return withWarning(
        output,
        ignored.length
          ? `Ignored regex-only parameters in query mode: ${ignored.join(", ")}`
          : undefined,
      );
    }

    const warnings = [];
    if (pathIsFile && params.file_pattern)
      warnings.push(
        "Ignored file_pattern because path already scopes the search to a single file",
      );
    if (params.exclude_globs !== undefined)
      warnings.push("Ignored query-only exclude_globs in regex mode");
    const warning = warnings.length ? warnings.join("; ") : undefined;
    const effectiveParams = {
      ...params,
      regex: params.regex!,
      ...(pathIsFile ? { file_pattern: undefined } : {}),
    };

    const maxResults =
      effectiveParams.max_results ?? SEARCH_FILES_DEFAULT_MAX_RESULTS;
    const offset = effectiveParams.offset ?? 0;
    const outputMode = effectiveParams.output_mode ?? "content";
    const formatPath = (file: string) => formatResultPath(file, searchDir);

    const rgPath = await getRipgrepBinPath();
    const args = buildRipgrepSearchArgs(effectiveParams);
    // Handle file_pattern: if it looks like a literal file path that exists,
    // use it as the search target instead of --glob to avoid glob matching issues.
    // Normalize simple brace globs like src/**/*.{ts,tsx} into multiple --glob args.
    const searchTarget = await addFilePatternArgs(
      args,
      searchDir,
      effectiveParams.file_pattern,
      defaultSearchTarget,
    );
    args.push(searchTarget);

    let output: string;
    try {
      output = await execRipgrepSearch(rgPath, args, { cwd: searchDir });
    } catch (error) {
      // Ripgrep error — may be invalid regex syntax etc.
      const message = error instanceof Error ? error.message : String(error);
      const hint = getEscapingHint(params.regex!);
      return errorResult(message, {
        regex: params.regex,
        ...(hint && { hint }),
      });
    }

    if (outputMode === "files_with_matches") {
      return withWarning(
        jsonResult(
          formatFilesWithMatchesResults(output, {
            maxResults,
            offset,
            formatPath,
          }),
          true,
        ),
        warning,
      );
    }

    if (outputMode === "count") {
      return withWarning(
        jsonResult(
          formatCountSearchResults(
            parseRipgrepCountOutput(output, defaultSearchTarget),
            { maxResults, offset, formatPath },
          ),
          true,
        ),
        warning,
      );
    }

    if (!output.trim()) {
      return jsonResult(emptyContentSearchResult(warning));
    }

    const { results: fileResults, totalMatches } = parseRipgrepOutput(
      output,
      searchDir,
    );

    const redactionViews = new Map<string, SearchFileRedactionView>();
    for (const file of fileResults) {
      const absoluteFile = path.resolve(searchDir, file.file);
      if (!isStructuredConfigPath(absoluteFile)) continue;
      try {
        const redacted = redactStructuredSecrets(
          absoluteFile,
          await fs.readFile(absoluteFile, "utf8"),
        );
        redactionViews.set(
          file.file,
          redacted.status
            ? {
                withheldMessage:
                  "[CONTENT WITHHELD: invalid structured configuration]",
                redactionCount: redacted.redactionCount,
              }
            : {
                visibleLines: redacted.content.split("\n"),
                redactionCount: redacted.redactionCount,
              },
        );
      } catch {
        redactionViews.set(file.file, {
          withheldMessage:
            "[CONTENT WITHHELD: structured configuration could not be read safely]",
          redactionCount: 0,
        });
      }
    }

    return jsonResult(
      formatContentSearchResults(fileResults, totalMatches, {
        maxResults,
        offset,
        formatPath,
        redactionViews,
        warning,
      }),
      true,
    );
  } catch (err) {
    return handleToolError(err, { path: params.path });
  }
}
