import * as fs from "fs/promises";
import * as path from "path";

import type {
  PathAccessProvider,
  SearchFilesParams,
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

const DEFAULT_MAX_RESULTS = 300;

import {
  errorResult,
  handleToolError,
  jsonResult,
  type ToolResult,
} from "@agentlink/protocol/tool-result";
import type { SemanticQueryOptions } from "../services/semanticSearch.js";

export interface SearchFilesProviders {
  workspaceFileProvider: WorkspaceFileProvider;
  pathAccessProvider: PathAccessProvider;
  semanticQueryOptions?: SemanticQueryOptions;
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

/**
 * Fix common regex escaping mistakes that Claude makes.
 *
 * Claude often double-escapes regex patterns due to JSON string escaping
 * confusion. For example, it sends `\\s` (literal backslash + s) when it
 * means `\s` (whitespace metacharacter). This function collapses the most
 * common double-escaped sequences back to single-escaped form.
 *
 * Also strips `\"` which is not a valid ripgrep escape.
 */
export function sanitizeRegex(regex: string): string {
  // Collapse \\X → \X for known regex metacharacters and escape sequences.
  // Covers: \s \S \d \D \w \W \b \B \n \t \r \f and punctuation escapes
  // like \( \) \{ \} \[ \] \. \| \+ \* \? \^ \$ \/
  return regex
    .replace(/\\\\([sSdDwWbBntrf(){}[\].|+*?^$/])/g, "\\$1")
    .replace(/\\["/]/g, (m) => m[1]);
}

/**
 * Check if a regex pattern appears to be double-escaped and return a hint.
 */
/**
 * Check if a sanitized regex requires multiline mode (contains \n).
 */
export function needsMultiline(sanitizedRegex: string): boolean {
  // After sanitization, a literal \n in the regex means the agent wants to match newlines.
  // We look for the two-character sequence backslash + 'n' not preceded by another backslash.
  return /(?<!\\)\\n/.test(sanitizedRegex);
}

/**
 * Detect if a regex uses look-around assertions that require PCRE2.
 * Matches (?=...), (?!...), (?<=...), (?<!...) patterns.
 */
export function needsPcre2(regex: string): boolean {
  return /\(\?[=!]|\(\?<[=!]/.test(regex);
}

/** Glob metacharacters that indicate a true glob pattern (not a literal file path). */
const GLOB_META = /[*?[\]{}]/;
const DEFAULT_EXCLUDE_GLOBS = ["!**/.git/**", "!**/node_modules/**"] as const;

/**
 * Expand a simple single brace group in a glob pattern, e.g. `*.{ts,tsx}`.
 * Falls back to the original pattern when the input is malformed or too complex.
 */
export function expandSimpleBraceGlob(filePattern: string): string[] {
  const firstOpen = filePattern.indexOf("{");
  const firstClose = filePattern.indexOf("}", firstOpen + 1);
  if (firstOpen === -1 || firstClose === -1) {
    return [filePattern];
  }

  if (filePattern.indexOf("{", firstOpen + 1) !== -1) {
    return [filePattern];
  }

  const prefix = filePattern.slice(0, firstOpen);
  const suffix = filePattern.slice(firstClose + 1);
  const body = filePattern.slice(firstOpen + 1, firstClose);
  const options = body
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  if (options.length <= 1) {
    return [filePattern];
  }

  return options.map((option) => `${prefix}${option}${suffix}`);
}

function addDefaultExcludeGlobs(args: string[]): void {
  for (const glob of DEFAULT_EXCLUDE_GLOBS) {
    args.push("--glob", glob);
  }
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

  for (const glob of expandSimpleBraceGlob(filePattern)) {
    args.push("--glob", glob);
  }
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
  if (!filePattern.includes("/") && !filePattern.includes("\\")) {
    return undefined; // bare filename — valid glob usage
  }
  if (GLOB_META.test(filePattern)) {
    return undefined; // contains glob characters — valid glob usage
  }
  // Looks like a literal file path — try to resolve it
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

export function getEscapingHint(regex: string): string | undefined {
  // Look for patterns like \\s, \\d, \\(, \\{ that suggest double-escaping
  if (/\\\\[sSdDwWbBntrf(){}[\].|+*?^$/]/.test(regex)) {
    return (
      "Your regex appears double-escaped (e.g. \\\\s instead of \\s). " +
      "The regex parameter is passed directly to ripgrep — only single " +
      "backslash escapes are needed (e.g. \\s, \\d, \\(). JSON string " +
      "escaping is handled automatically by the transport layer."
    );
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
    const { absolutePath: resolvedPath, inWorkspace } =
      providers.workspaceFileProvider.resolvePath(params.path);

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

    // Semantic search is handled separately
    if (params.semantic) {
      const { semanticSearch } = await import("../services/semanticSearch.js");
      return semanticSearch(
        resolvedPath,
        params.regex,
        params.max_results,
        undefined,
        {
          exactFile: pathIsFile,
          ...providers.semanticQueryOptions,
        },
      );
    }

    const warning =
      pathIsFile && params.file_pattern
        ? "Ignored file_pattern because path already scopes the search to a single file"
        : undefined;
    const effectiveParams = warning
      ? { ...params, file_pattern: undefined }
      : params;

    const maxResults = effectiveParams.max_results ?? DEFAULT_MAX_RESULTS;
    const outputMode = effectiveParams.output_mode ?? "content";

    // Ripgrep regex search
    const rgPath = await getRipgrepBinPath();

    // --- files_with_matches mode ---
    if (outputMode === "files_with_matches") {
      return withWarning(
        await searchFilesOnly(
          rgPath,
          searchDir,
          defaultSearchTarget,
          effectiveParams,
        ),
        warning,
      );
    }

    // --- count mode ---
    if (outputMode === "count") {
      return withWarning(
        await searchCount(
          rgPath,
          searchDir,
          defaultSearchTarget,
          effectiveParams,
        ),
        warning,
      );
    }

    // --- content mode (default) ---
    const contextBefore = params.context_before ?? params.context ?? 1;
    const contextAfter = params.context_after ?? params.context ?? 1;
    const offset = params.offset ?? 0;
    const sanitized = sanitizeRegex(params.regex);
    const args = ["--json", "-e", sanitized, "--no-messages"];

    // Use asymmetric -B/-A when they differ, symmetric -C when equal
    if (contextBefore === contextAfter) {
      args.push("--context", String(contextBefore));
    } else {
      args.push("-B", String(contextBefore), "-A", String(contextAfter));
    }

    if (params.case_insensitive) {
      args.push("--ignore-case");
    }
    if (params.multiline || needsMultiline(sanitized)) {
      args.push("--multiline", "--multiline-dotall");
    }
    if (needsPcre2(sanitized)) {
      args.push("--pcre2");
    }

    addDefaultExcludeGlobs(args);

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
      const hint = getEscapingHint(params.regex);
      return errorResult(message, {
        regex: params.regex,
        ...(hint && { hint }),
      });
    }

    if (!output.trim()) {
      return jsonResult({
        total_matches: 0,
        truncated: false,
        results: "No results found",
        ...(warning && { warning }),
      });
    }

    const { results: fileResults, totalMatches } = parseRipgrepOutput(
      output,
      searchDir,
    );

    // Format output — keep ## file.ts + "> linenum | content" format
    const formatted: string[] = [];
    let matchCount = 0;
    let skipped = 0;

    for (const file of fileResults) {
      if (matchCount >= maxResults) break;

      const relPath = formatResultPath(file.file, searchDir);
      const fileLines: string[] = [];
      let fileMatchCount = 0;

      for (const result of file.searchResults) {
        if (matchCount >= maxResults) break;

        const groupMatches = result.lines.filter((l) => l.isMatch).length;

        // Skip this group entirely if all its matches fall within the offset
        if (offset > 0 && skipped + groupMatches <= offset) {
          skipped += groupMatches;
          continue;
        }

        for (const line of result.lines) {
          const prefix = line.isMatch ? ">" : " ";
          fileLines.push(`${prefix} ${line.line} | ${line.text.trimEnd()}`);
        }
        fileLines.push("---");

        // Count only the matches past the offset threshold
        const countable = Math.max(
          0,
          groupMatches - Math.max(0, offset - skipped),
        );
        fileMatchCount += countable;
        matchCount += countable;
        skipped += groupMatches;
      }

      if (fileLines.length > 0) {
        const countLabel =
          fileMatchCount === 1 ? "1 match" : `${fileMatchCount} matches`;
        formatted.push(
          `## ${relPath} (${countLabel})\n${fileLines.join("\n")}`,
        );
      }
    }

    const result = {
      total_matches: Math.min(totalMatches, maxResults),
      truncated: totalMatches > maxResults + offset,
      ...(offset > 0 && { offset }),
      results: formatted.join("\n\n"),
      ...(warning && { warning }),
    };

    return jsonResult(result, true);
  } catch (err) {
    return handleToolError(err, { path: params.path });
  }
}

// --- files_with_matches mode ---

async function searchFilesOnly(
  rgPath: string,
  searchDir: string,
  defaultSearchTarget: string,
  params: {
    regex: string;
    file_pattern?: string;
    case_insensitive?: boolean;
    multiline?: boolean;
    max_results?: number;
    offset?: number;
  },
): Promise<ToolResult> {
  const sanitized = sanitizeRegex(params.regex);
  const args = ["--files-with-matches", "-e", sanitized, "--no-messages"];

  if (params.case_insensitive) args.push("--ignore-case");
  if (params.multiline || needsMultiline(sanitized))
    args.push("--multiline", "--multiline-dotall");
  if (needsPcre2(sanitized)) args.push("--pcre2");
  addDefaultExcludeGlobs(args);
  const searchTarget = await addFilePatternArgs(
    args,
    searchDir,
    params.file_pattern,
    defaultSearchTarget,
  );
  args.push(searchTarget);

  let output: string;
  try {
    output = await execRipgrepSearch(rgPath, args, { cwd: searchDir });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const hint = getEscapingHint(params.regex);
    return errorResult(message, {
      regex: params.regex,
      ...(hint && { hint }),
    });
  }

  const files = output.trim().split("\n").filter(Boolean);
  const maxResults = params.max_results ?? DEFAULT_MAX_RESULTS;
  const offsetVal = params.offset ?? 0;
  const sliced = files.slice(offsetVal, offsetVal + maxResults);
  const limited = sliced.map((file) => formatResultPath(file, searchDir));

  return jsonResult(
    {
      total_files: limited.length,
      truncated: files.length > offsetVal + maxResults,
      ...(offsetVal > 0 && { offset: offsetVal }),
      files: limited,
    },
    true,
  );
}

// --- count mode ---

async function searchCount(
  rgPath: string,
  searchDir: string,
  defaultSearchTarget: string,
  params: {
    regex: string;
    file_pattern?: string;
    case_insensitive?: boolean;
    multiline?: boolean;
    max_results?: number;
    offset?: number;
  },
): Promise<ToolResult> {
  const sanitized = sanitizeRegex(params.regex);
  const args = ["--count", "--with-filename", "-e", sanitized, "--no-messages"];

  if (params.case_insensitive) args.push("--ignore-case");
  if (params.multiline || needsMultiline(sanitized))
    args.push("--multiline", "--multiline-dotall");
  if (needsPcre2(sanitized)) args.push("--pcre2");
  addDefaultExcludeGlobs(args);
  const searchTarget = await addFilePatternArgs(
    args,
    searchDir,
    params.file_pattern,
    defaultSearchTarget,
  );
  args.push(searchTarget);

  let output: string;
  try {
    output = await execRipgrepSearch(rgPath, args, { cwd: searchDir });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const hint = getEscapingHint(params.regex);
    return errorResult(message, {
      regex: params.regex,
      ...(hint && { hint }),
    });
  }

  const lines = output.trim().split("\n").filter(Boolean);
  const maxResults = params.max_results ?? DEFAULT_MAX_RESULTS;
  const offsetVal = params.offset ?? 0;
  let totalMatches = 0;
  const allCounts: Array<{ file: string; count: number }> = [];

  for (const line of lines) {
    const sepIdx = line.lastIndexOf(":");
    const bareCount = sepIdx === -1 ? Number.parseInt(line, 10) : Number.NaN;
    const file =
      sepIdx === -1
        ? formatResultPath(defaultSearchTarget, searchDir)
        : formatResultPath(line.substring(0, sepIdx), searchDir);
    const count =
      sepIdx === -1
        ? bareCount
        : Number.parseInt(line.substring(sepIdx + 1), 10);
    if (!isNaN(count)) {
      allCounts.push({ file, count });
      totalMatches += count;
    }
  }

  const sliced = allCounts.slice(offsetVal, offsetVal + maxResults);

  return jsonResult(
    {
      total_files: sliced.length,
      total_matches: totalMatches,
      truncated: allCounts.length > offsetVal + maxResults,
      ...(offsetVal > 0 && { offset: offsetVal }),
      counts: sliced,
    },
    true,
  );
}
