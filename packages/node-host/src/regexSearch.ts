import {
  emptyContentSearchResult,
  expandSimpleBraceGlob,
  formatContentSearchResults,
  formatCountSearchResults,
  formatFilesWithMatchesResults,
  getEscapingHint,
  isLiteralFilePatternPath,
  needsMultiline,
  sanitizeRegex,
  SEARCH_FILES_DEFAULT_MAX_RESULTS,
  truncateLine,
  type RegexSearchFilesParams,
  type SearchFileRedactionView,
  type SearchFileResult,
  type SearchLineResult,
} from "@agentlink/core/search-files";
import path from "node:path";
import picomatch from "picomatch";

import type { NodeHostFileSystem } from "./fileSystem.js";
import { redactNodeHostStructuredConfig } from "./structuredConfigRedaction.js";

/** Files read before the walk stops and reports incomplete results. */
const MAX_SEARCH_FILES = 20_000;
/** Directory depth below the search target; ripgrep has none, so keep it generous. */
const MAX_SEARCH_WALK_DEPTH = 32;
const DEFAULT_EXCLUDED_DIRECTORIES = new Set([".git", "node_modules"]);
const BOUNDED_WARNING =
  "Search output reached the host time or size bound; results may be incomplete";

export interface NodeHostRegexSearchRequest {
  readonly files: NodeHostFileSystem;
  /** Canonical absolute file or directory, already inside `rootPath`. */
  readonly target: string;
  /** Canonical grant root every visited path must stay within. */
  readonly rootPath: string;
  readonly params: RegexSearchFilesParams;
  readonly maxFileBytes: number;
  readonly shouldIncludePath?: (absolutePath: string) => boolean;
  /** Display path for a matched file. Defaults to the absolute path. */
  readonly formatPath?: (absolutePath: string) => string;
  readonly signal?: AbortSignal;
}

export interface NodeHostRegexSearchResult {
  readonly payload: Record<string, unknown>;
  readonly isError?: true;
}

interface MatchUnit {
  readonly start: number;
  readonly end: number;
}

/**
 * VS Code's regex `search_files` without a ripgrep process: the same
 * parameters, defaults (`.git`/`node_modules` and hidden entries skipped,
 * one context line), and `content`/`files_with_matches`/`count` payloads.
 * Matching uses JavaScript regular expressions after VS Code's escaping
 * fix-ups, and structured-config secrets are redacted before matching.
 * `.gitignore` files are not read.
 */
export async function searchNodeHostFiles(
  request: NodeHostRegexSearchRequest,
): Promise<NodeHostRegexSearchResult> {
  const { files, target } = request;
  const formatPath = request.formatPath ?? ((file: string) => file);
  const stat = await files.stat(target).catch(() => undefined);
  if (stat?.kind !== "file" && stat?.kind !== "directory") {
    return errorPayload({
      error: "path must point to either a file or directory",
    });
  }
  const pathIsFile = stat.kind === "file";
  const warnings: string[] = [];
  if (pathIsFile && request.params.file_pattern) {
    warnings.push(
      "Ignored file_pattern because path already scopes the search to a single file",
    );
  }
  const params: RegexSearchFilesParams = pathIsFile
    ? { ...request.params, file_pattern: undefined }
    : request.params;
  const sanitized = sanitizeRegex(params.regex);
  const multiline = params.multiline === true || needsMultiline(sanitized);
  let regex: RegExp;
  try {
    regex = new RegExp(
      sanitized,
      `${multiline ? "gms" : ""}${params.case_insensitive ? "i" : ""}`,
    );
  } catch (error) {
    const hint = getEscapingHint(params.regex);
    return errorPayload({
      error: `Invalid regex: ${error instanceof Error ? error.message : String(error)}`,
      regex: params.regex,
      ...(hint ? { hint } : {}),
    });
  }
  const maxResults = params.max_results ?? SEARCH_FILES_DEFAULT_MAX_RESULTS;
  const offset = params.offset ?? 0;
  const outputMode = params.output_mode ?? "content";
  const contextBefore = params.context_before ?? params.context ?? 1;
  const contextAfter = params.context_after ?? params.context ?? 1;

  const candidates = await searchCandidates(request, params, pathIsFile);
  if (candidates.bounded) warnings.push(BOUNDED_WARNING);

  const contentResults: SearchFileResult[] = [];
  const matchedFiles: string[] = [];
  const counts: Array<{ file: string; count: number }> = [];
  const redactionViews = new Map<string, SearchFileRedactionView>();
  let totalMatches = 0;
  let bounded = candidates.bounded;
  for (const file of candidates.files) {
    if (request.signal?.aborted) {
      bounded = true;
      break;
    }
    const text = await readSearchableText(files, file, request.maxFileBytes);
    if (text === undefined) continue;
    const redacted = redactNodeHostStructuredConfig(file, text);
    const lines = splitLines(redacted.content);
    const units = multiline
      ? multilineMatches(lines, regex)
      : lineMatches(lines, regex);
    if (units.length === 0) continue;
    if (redacted.redacted) {
      redactionViews.set(file, {
        visibleLines: lines,
        redactionCount: redacted.redactionCount ?? 0,
        ...(redacted.status
          ? {
              withheldMessage:
                "[CONTENT WITHHELD: structured configuration could not be read safely]",
            }
          : {}),
      });
    }
    totalMatches += units.length;
    if (outputMode === "files_with_matches") {
      matchedFiles.push(file);
      if (matchedFiles.length > offset + maxResults) break;
    } else if (outputMode === "count") {
      counts.push({ file, count: units.length });
    } else {
      contentResults.push({
        file,
        searchResults: contextGroups(lines, units, contextBefore, contextAfter),
      });
      // One match past the page is enough to report `truncated`.
      if (totalMatches > offset + maxResults) break;
    }
  }
  if (bounded && !candidates.bounded) warnings.push(BOUNDED_WARNING);
  const warning = warnings.length > 0 ? warnings.join("; ") : undefined;

  let payload: Record<string, unknown>;
  if (outputMode === "files_with_matches") {
    payload = formatFilesWithMatchesResults(matchedFiles.join("\n"), {
      maxResults,
      offset,
      formatPath,
    });
    if (warning) payload = { ...payload, warning };
  } else if (outputMode === "count") {
    payload = formatCountSearchResults(counts, {
      maxResults,
      offset,
      formatPath,
    });
    if (warning) payload = { ...payload, warning };
  } else {
    payload =
      contentResults.length === 0
        ? emptyContentSearchResult(warning)
        : formatContentSearchResults(contentResults, totalMatches, {
            maxResults,
            offset,
            formatPath,
            redactionViews,
            warning,
          });
  }
  return { payload };
}

function errorPayload(
  payload: Record<string, unknown>,
): NodeHostRegexSearchResult {
  return { payload, isError: true };
}

async function searchCandidates(
  request: NodeHostRegexSearchRequest,
  params: RegexSearchFilesParams,
  pathIsFile: boolean,
): Promise<{ files: string[]; bounded: boolean }> {
  const { files, target } = request;
  if (pathIsFile) return { files: [target], bounded: false };
  const filePattern = params.file_pattern;
  if (filePattern && isLiteralFilePatternPath(filePattern)) {
    const literal = await literalTarget(request, filePattern);
    if (literal) return { files: [literal], bounded: false };
  }
  const matchesGlob = filePattern ? globFilter(filePattern) : () => true;
  const found: string[] = [];
  let bounded = false;
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (bounded) return;
    if (depth > MAX_SEARCH_WALK_DEPTH) {
      bounded = true;
      return;
    }
    const entries = [
      ...(await files.readDirectory(directory).catch(() => [])),
    ].sort((first, second) => first.name.localeCompare(second.name));
    for (const entry of entries) {
      if (bounded) return;
      // ripgrep skips hidden entries and symlinks by default.
      if (entry.kind === "symlink" || entry.name.startsWith(".")) continue;
      const child = path.join(directory, entry.name);
      if (request.shouldIncludePath?.(child) === false) continue;
      const canonical = await files.realpath(child).catch(() => undefined);
      if (canonical !== child || !isPathWithin(canonical, request.rootPath)) {
        continue;
      }
      if (entry.kind === "directory") {
        if (DEFAULT_EXCLUDED_DIRECTORIES.has(entry.name)) continue;
        await visit(child, depth + 1);
      } else if (entry.kind === "file") {
        if (!matchesGlob(path.relative(target, child))) continue;
        if (found.length >= MAX_SEARCH_FILES) {
          bounded = true;
          return;
        }
        found.push(child);
      }
    }
  };
  await visit(target, 0);
  return { files: found, bounded };
}

/** VS Code searches a separator-containing, glob-free file_pattern as a file. */
async function literalTarget(
  request: NodeHostRegexSearchRequest,
  filePattern: string,
): Promise<string | undefined> {
  if (path.isAbsolute(filePattern)) return undefined;
  const candidate = path.resolve(request.target, filePattern);
  if (!isPathWithin(candidate, request.target)) return undefined;
  if (request.shouldIncludePath?.(candidate) === false) return undefined;
  const canonical = await request.files
    .realpath(candidate)
    .catch(() => undefined);
  if (canonical !== candidate || !isPathWithin(canonical, request.rootPath)) {
    return undefined;
  }
  const stat = await request.files.stat(candidate).catch(() => undefined);
  return stat?.kind === "file" ? candidate : undefined;
}

/**
 * ripgrep `--glob` semantics: a glob without `/` matches the file name at
 * any depth; one with `/` matches the path below the search directory; a
 * leading `!` excludes.
 */
function globFilter(filePattern: string): (relativePath: string) => boolean {
  const include: Array<(value: string) => boolean> = [];
  const exclude: Array<(value: string) => boolean> = [];
  for (const raw of expandSimpleBraceGlob(filePattern)) {
    const negated = raw.startsWith("!");
    const glob = (negated ? raw.slice(1) : raw).replace(/^\//u, "");
    if (!glob) continue;
    const anchored = glob.includes("/");
    const matcher = picomatch(glob, { dot: true });
    const test = (relativePath: string) => {
      const normalized = relativePath.split(path.sep).join("/");
      return matcher(anchored ? normalized : path.posix.basename(normalized));
    };
    (negated ? exclude : include).push(test);
  }
  return (relativePath) =>
    (include.length === 0 || include.some((test) => test(relativePath))) &&
    !exclude.some((test) => test(relativePath));
}

async function readSearchableText(
  files: NodeHostFileSystem,
  file: string,
  maxFileBytes: number,
): Promise<string | undefined> {
  const stat = await files.stat(file).catch(() => undefined);
  if (stat?.kind !== "file" || stat.size > maxFileBytes) return undefined;
  const bytes = await files.readFile(file).catch(() => undefined);
  // ripgrep treats a NUL byte as binary and skips the file.
  if (!bytes || bytes.includes(0)) return undefined;
  return Buffer.from(bytes).toString("utf8");
}

function splitLines(content: string): string[] {
  const lines = content.split(/\r?\n/u);
  // A trailing newline ends the last line; it does not start another.
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  return lines;
}

function lineMatches(lines: readonly string[], regex: RegExp): MatchUnit[] {
  const units: MatchUnit[] = [];
  lines.forEach((line, index) => {
    if (regex.test(line)) units.push({ start: index, end: index });
  });
  return units;
}

/** Matches over the whole text; each match spans the lines it touches. */
function multilineMatches(
  lines: readonly string[],
  regex: RegExp,
): MatchUnit[] {
  const text = lines.join("\n");
  const lineStarts: number[] = [];
  let position = 0;
  for (const line of lines) {
    lineStarts.push(position);
    position += line.length + 1;
  }
  const lineAt = (offset: number) => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (lineStarts[middle]! <= offset) low = middle;
      else high = middle - 1;
    }
    return low;
  };
  const units: MatchUnit[] = [];
  regex.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const start = lineAt(match.index);
    const end = lineAt(match.index + Math.max(0, match[0].length - 1));
    const previous = units.at(-1);
    // ripgrep reports one match per line; merge matches sharing a line.
    if (previous && start <= previous.end) {
      units[units.length - 1] = {
        start: previous.start,
        end: Math.max(previous.end, end),
      };
    } else {
      units.push({ start, end });
    }
    if (match[0].length === 0) regex.lastIndex += 1;
  }
  return units;
}

/** Group matches and their context the way ripgrep's `--json` output does. */
function contextGroups(
  lines: readonly string[],
  units: readonly MatchUnit[],
  before: number,
  after: number,
): SearchFileResult["searchResults"] {
  const groups: SearchFileResult["searchResults"] = [];
  let lastEmitted = -1;
  const push = (line: SearchLineResult, endIndex: number) => {
    const current = groups.at(-1);
    if (current && line.line - 1 <= lastEmitted + 1) current.lines.push(line);
    else groups.push({ lines: [line] });
    lastEmitted = endIndex;
  };
  units.forEach((unit, index) => {
    const nextStart = units[index + 1]?.start ?? lines.length;
    for (
      let line = Math.max(lastEmitted + 1, unit.start - before);
      line < unit.start;
      line += 1
    ) {
      push(contextLine(lines, line), line);
    }
    push(
      {
        line: unit.start + 1,
        text: truncateLine(lines.slice(unit.start, unit.end + 1).join("\n")),
        isMatch: true,
      },
      unit.end,
    );
    for (
      let line = unit.end + 1;
      line <= Math.min(lines.length - 1, unit.end + after) && line < nextStart;
      line += 1
    ) {
      push(contextLine(lines, line), line);
    }
  });
  return groups;
}

function contextLine(
  lines: readonly string[],
  index: number,
): SearchLineResult {
  return { line: index + 1, text: truncateLine(lines[index]!), isMatch: false };
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
