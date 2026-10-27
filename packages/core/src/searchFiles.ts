/**
 * Surface-neutral pieces of VS Code's regex `search_files` tool: regex
 * fix-ups, ripgrep argument construction, ripgrep `--json` parsing, and the
 * `content` / `files_with_matches` / `count` result formatters. Hosts own the
 * ripgrep process, path access, and file reads for secret redaction.
 */

export const SEARCH_FILES_DEFAULT_MAX_RESULTS = 300;
/** Lines of ripgrep output VS Code keeps before stopping the process. */
export const SEARCH_FILES_MAX_OUTPUT_LINES =
  SEARCH_FILES_DEFAULT_MAX_RESULTS * 5;
export const SEARCH_FILES_MAX_LINE_LENGTH = 500;
export const SEARCH_FILES_DEFAULT_EXCLUDE_GLOBS = [
  "!**/.git/**",
  "!**/node_modules/**",
] as const;

export type SearchFilesOutputMode = "content" | "files_with_matches" | "count";

/** The regex-mode `search_files` parameters shared by every surface. */
export interface RegexSearchFilesParams {
  readonly regex: string;
  readonly file_pattern?: string;
  readonly case_insensitive?: boolean;
  readonly multiline?: boolean;
  readonly context?: number;
  readonly context_before?: number;
  readonly context_after?: number;
  /** Unrecognized values fall back to `content`, as in VS Code. */
  readonly output_mode?: SearchFilesOutputMode | (string & {});
  readonly offset?: number;
  readonly max_results?: number;
}

/**
 * Fix common regex escaping mistakes that models make.
 *
 * Models often double-escape regex patterns due to JSON string escaping
 * confusion. For example, they send `\\s` (literal backslash + s) when they
 * mean `\s` (whitespace metacharacter). This collapses the most common
 * double-escaped sequences back to single-escaped form, and strips `\"`,
 * which is not a valid ripgrep escape.
 */
export function sanitizeRegex(regex: string): string {
  return regex
    .replace(/\\\\([sSdDwWbBntrf(){}[\].|+*?^$/])/g, "\\$1")
    .replace(/\\["/]/g, (m) => m[1]);
}

/** Whether a sanitized regex requires multiline mode (contains `\n`). */
export function needsMultiline(sanitizedRegex: string): boolean {
  return /(?<!\\)\\n/.test(sanitizedRegex);
}

/** Whether a regex uses look-around assertions that require PCRE2. */
export function needsPcre2(regex: string): boolean {
  return /\(\?[=!]|\(\?<[=!]/.test(regex);
}

/** Glob metacharacters that indicate a true glob pattern (not a literal file path). */
const GLOB_META = /[*?[\]{}]/;

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

/**
 * Whether `file_pattern` looks like a literal file path rather than a glob:
 * it contains a path separator and no glob metacharacters. Hosts resolve such
 * a pattern against the search directory and, when it names an existing file
 * inside it, search that file instead of passing a glob.
 */
export function isLiteralFilePatternPath(filePattern: string): boolean {
  if (!filePattern.includes("/") && !filePattern.includes("\\")) return false;
  return !GLOB_META.test(filePattern);
}

/** `--glob` arguments for a glob-style `file_pattern`. */
export function filePatternGlobArgs(filePattern: string): string[] {
  return expandSimpleBraceGlob(filePattern).flatMap((glob) => ["--glob", glob]);
}

export function getEscapingHint(regex: string): string | undefined {
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

/**
 * VS Code's ripgrep arguments for one output mode, excluding `file_pattern`
 * globs and the search target. The default `.git`/`node_modules` excludes are
 * included.
 */
export function buildRipgrepSearchArgs(
  params: RegexSearchFilesParams,
): string[] {
  const sanitized = sanitizeRegex(params.regex);
  const mode = params.output_mode ?? "content";
  const args =
    mode === "files_with_matches"
      ? ["--files-with-matches", "-e", sanitized, "--no-messages"]
      : mode === "count"
        ? ["--count", "--with-filename", "-e", sanitized, "--no-messages"]
        : ["--json", "-e", sanitized, "--no-messages"];
  if (mode === "content") {
    const contextBefore = params.context_before ?? params.context ?? 1;
    const contextAfter = params.context_after ?? params.context ?? 1;
    if (contextBefore === contextAfter) {
      args.push("--context", String(contextBefore));
    } else {
      args.push("-B", String(contextBefore), "-A", String(contextAfter));
    }
  }
  if (params.case_insensitive) args.push("--ignore-case");
  if (params.multiline || needsMultiline(sanitized)) {
    args.push("--multiline", "--multiline-dotall");
  }
  if (needsPcre2(sanitized)) args.push("--pcre2");
  for (const glob of SEARCH_FILES_DEFAULT_EXCLUDE_GLOBS) {
    args.push("--glob", glob);
  }
  return args;
}

// --- Ripgrep JSON output ---

export interface RgBegin {
  type: "begin";
  data: { path: { text: string } };
}

export interface RgMatch {
  type: "match";
  data: {
    path: { text: string };
    lines: { text: string };
    line_number: number;
    absolute_offset: number;
  };
}

export interface RgContext {
  type: "context";
  data: {
    path: { text: string };
    lines: { text: string };
    line_number: number;
  };
}

export interface RgEnd {
  type: "end";
  data: { path: { text: string } };
}

export type RgMessage = RgBegin | RgMatch | RgContext | RgEnd;

export interface SearchLineResult {
  line: number;
  text: string;
  isMatch: boolean;
}

export interface SearchResult {
  lines: SearchLineResult[];
}

export interface SearchFileResult {
  file: string;
  searchResults: SearchResult[];
}

export function truncateLine(
  line: string,
  maxLength: number = SEARCH_FILES_MAX_LINE_LENGTH,
): string {
  return line.length > maxLength
    ? line.substring(0, maxLength) + " [truncated...]"
    : line;
}

/** Parse ripgrep `--json` output into per-file match groups. */
export function parseRipgrepOutput(
  output: string,
  _cwd?: string,
): { results: SearchFileResult[]; totalMatches: number } {
  const results: SearchFileResult[] = [];
  let currentFile: SearchFileResult | null = null;
  let totalMatches = 0;

  for (const line of output.split("\n")) {
    if (!line) continue;

    try {
      const parsed = JSON.parse(line) as RgMessage;

      if (parsed.type === "begin") {
        // A capped stream may omit the previous file's `end` event. Preserve
        // any captured matches before starting the next file rather than
        // silently dropping inspectable results.
        if (
          currentFile?.searchResults.some((result) =>
            result.lines.some((line) => line.isMatch),
          )
        ) {
          results.push(currentFile);
        }
        currentFile = {
          file: parsed.data.path.text,
          searchResults: [],
        };
      } else if (parsed.type === "end") {
        if (currentFile) {
          results.push(currentFile);
          currentFile = null;
        }
      } else if (
        (parsed.type === "match" || parsed.type === "context") &&
        currentFile
      ) {
        if (parsed.type === "match") {
          totalMatches++;
        }

        const lineResult: SearchLineResult = {
          line: parsed.data.line_number,
          text: truncateLine(parsed.data.lines.text),
          isMatch: parsed.type === "match",
        };

        const lastResult =
          currentFile.searchResults[currentFile.searchResults.length - 1];
        if (lastResult?.lines.length > 0) {
          const lastLine = lastResult.lines[lastResult.lines.length - 1];
          if (parsed.data.line_number <= lastLine.line + 1) {
            lastResult.lines.push(lineResult);
          } else {
            currentFile.searchResults.push({ lines: [lineResult] });
          }
        } else {
          currentFile.searchResults.push({ lines: [lineResult] });
        }
      }
    } catch {
      // Skip unparseable lines
    }
  }

  // Output may be capped before ripgrep emits the final `end` event. Keep the
  // in-progress file when it contains a captured match so totalMatches never
  // refers to hidden data.
  if (
    currentFile?.searchResults.some((result) =>
      result.lines.some((line) => line.isMatch),
    )
  ) {
    results.push(currentFile);
  }

  return { results, totalMatches };
}

// --- Result formatting ---

/**
 * A host's secret-safe view of one structured configuration file, keyed by
 * the ripgrep-reported file path. Either the redacted file lines or a
 * withheld message replaces the raw matched text.
 */
export interface SearchFileRedactionView {
  readonly visibleLines?: readonly string[];
  readonly withheldMessage?: string;
  readonly redactionCount: number;
}

export interface FormatContentSearchOptions {
  readonly maxResults: number;
  readonly offset: number;
  /** Display path for a ripgrep-reported file. */
  readonly formatPath: (file: string) => string;
  /** Redaction views for structured configuration files. */
  readonly redactionViews?: ReadonlyMap<string, SearchFileRedactionView>;
  readonly warning?: string;
}

/** VS Code's `content` output: `## file (N matches)` and `> line | text`. */
export function formatContentSearchResults(
  fileResults: readonly SearchFileResult[],
  totalMatches: number,
  options: FormatContentSearchOptions,
): Record<string, unknown> {
  const { maxResults, offset, warning } = options;
  const formatted: string[] = [];
  let matchCount = 0;
  let skipped = 0;
  let redactionCount = 0;
  let withheldFiles = 0;

  for (const file of fileResults) {
    if (matchCount >= maxResults) break;

    const relPath = options.formatPath(file.file);
    const view = options.redactionViews?.get(file.file);
    const visibleLines = view?.visibleLines;
    const withheldMessage = view?.withheldMessage;
    if (view) {
      redactionCount += view.redactionCount;
      if (withheldMessage) withheldFiles += 1;
    }
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

      // Emit match lines individually so adjacent matches merged into one
      // ripgrep group still respect offset and max_results.
      const groupLines: string[] = [];
      let countable = 0;
      for (const line of result.lines) {
        if (line.isMatch) {
          if (skipped < offset) {
            skipped += 1;
            // Context collected so far belonged to a skipped match.
            groupLines.length = 0;
            continue;
          }
          if (matchCount + countable >= maxResults) break;
          countable += 1;
          skipped += 1;
        }
        const prefix = line.isMatch ? ">" : " ";
        const visibleText =
          withheldMessage ??
          (visibleLines
            ? visibleLines
                .slice(
                  line.line - 1,
                  line.line -
                    1 +
                    Math.max(1, line.text.trimEnd().split("\n").length),
                )
                .join("\n")
            : line.text);
        groupLines.push(
          `${prefix} ${line.line} | ${truncateLine(visibleText).trimEnd()}`,
        );
      }
      if (countable > 0) {
        fileLines.push(...groupLines, "---");
      }
      fileMatchCount += countable;
      matchCount += countable;
    }

    if (fileLines.length > 0) {
      const countLabel =
        fileMatchCount === 1 ? "1 match" : `${fileMatchCount} matches`;
      formatted.push(`## ${relPath} (${countLabel})\n${fileLines.join("\n")}`);
    }
  }

  return {
    total_matches: Math.min(totalMatches, maxResults),
    truncated: totalMatches > maxResults + offset,
    ...(offset > 0 && { offset }),
    results: formatted.join("\n\n"),
    ...((redactionCount > 0 || withheldFiles > 0) && {
      redaction: {
        type: "structured_secret_values",
        count: redactionCount,
        withheld_files: withheldFiles,
      },
    }),
    ...(warning && { warning }),
  };
}

/** VS Code's empty `content` result. */
export function emptyContentSearchResult(
  warning?: string,
): Record<string, unknown> {
  return {
    total_matches: 0,
    truncated: false,
    results: "No results found",
    ...(warning && { warning }),
  };
}

export interface FormatListSearchOptions {
  readonly maxResults: number;
  readonly offset: number;
  readonly formatPath: (file: string) => string;
}

/** VS Code's `files_with_matches` output from ripgrep's file list. */
export function formatFilesWithMatchesResults(
  output: string,
  options: FormatListSearchOptions,
): Record<string, unknown> {
  const files = output.trim().split("\n").filter(Boolean);
  const { maxResults, offset } = options;
  const limited = files
    .slice(offset, offset + maxResults)
    .map((file) => options.formatPath(file));
  return {
    total_files: limited.length,
    truncated: files.length > offset + maxResults,
    ...(offset > 0 && { offset }),
    files: limited,
  };
}

/** Parse ripgrep `--count --with-filename` output into per-file counts. */
export function parseRipgrepCountOutput(
  output: string,
  defaultSearchTarget: string,
): Array<{ file: string; count: number }> {
  const counts: Array<{ file: string; count: number }> = [];
  for (const line of output.trim().split("\n").filter(Boolean)) {
    const sepIdx = line.lastIndexOf(":");
    const file =
      sepIdx === -1 ? defaultSearchTarget : line.substring(0, sepIdx);
    const count = Number.parseInt(
      sepIdx === -1 ? line : line.substring(sepIdx + 1),
      10,
    );
    if (!Number.isNaN(count)) counts.push({ file, count });
  }
  return counts;
}

/** VS Code's `count` output from parsed per-file counts. */
export function formatCountSearchResults(
  counts: readonly { file: string; count: number }[],
  options: FormatListSearchOptions,
): Record<string, unknown> {
  const { maxResults, offset } = options;
  let totalMatches = 0;
  const allCounts = counts.map(({ file, count }) => {
    totalMatches += count;
    return { file: options.formatPath(file), count };
  });
  const sliced = allCounts.slice(offset, offset + maxResults);
  return {
    total_files: sliced.length,
    total_matches: totalMatches,
    truncated: allCounts.length > offset + maxResults,
    ...(offset > 0 && { offset }),
    counts: sliced,
  };
}
