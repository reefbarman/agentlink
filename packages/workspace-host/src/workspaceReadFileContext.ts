import { createHash } from "node:crypto";
import path from "node:path";

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 400;
const MAX_LINE_CHARS = 2_000;
const MAX_CONTENT_CHARS = 20_000;
const MAX_OUTLINE_SYMBOLS = 60;
const MAX_OUTLINE_BYTES = 6_000;
const MAX_SESSIONS = 32;
const MAX_FILES_PER_SESSION = 200;

export interface WorkspaceReadFileContextParams {
  readonly offset?: number;
  readonly limit?: number;
  readonly characterOffset?: number;
  readonly dedupeUnchangedContent?: boolean;
  readonly refresh?: boolean;
}

export interface WorkspaceReadFileContextEnrichment {
  readonly symbols?: Record<string, string[]>;
  readonly diagnostics?: {
    readonly errors: number;
    readonly warnings: number;
    readonly note?: string;
  };
}

export interface WorkspaceReadFileContextInput {
  readonly sessionId: string;
  readonly path: string;
  readonly absolutePath: string;
  readonly bytes: Uint8Array;
  readonly modifiedMs: number;
  readonly content: string;
  readonly redacted: boolean;
  readonly redactionStatus?:
    | "withheld_invalid_jsonc"
    | "withheld_unsupported_config";
  readonly language?: string;
  readonly gitStatus?: string;
  readonly enrichment?: WorkspaceReadFileContextEnrichment;
  /** Legacy extension payload retained for existing workspace-host SDK consumers. */
  readonly legacyLanguageIntelligence?: unknown;
  readonly params: WorkspaceReadFileContextParams;
  readonly now?: number;
}

export type WorkspaceReadFileContextResult =
  | {
      readonly ok: true;
      readonly payload: Record<string, unknown>;
      readonly display: {
        readonly path: string;
        readonly contentHash: string;
        readonly lines: number;
        readonly truncated: boolean;
        readonly git: "available" | "unavailable";
      };
    }
  | {
      readonly ok: false;
      readonly error: string;
    };

interface WorkingSetRange {
  readonly startLine: number;
  readonly endLine: number;
  readonly characterOffset?: number;
}

interface WorkingSetEntry {
  readonly contentHash: string;
  readonly returnedRanges: Set<string>;
  readonly lastReadAt: number;
}

interface WorkingSetSession {
  readonly files: Map<string, WorkingSetEntry>;
  lastAccessedAt: number;
}

interface WorkingSetResult {
  readonly status: "new" | "unchanged" | "changed" | "omitted_unchanged";
  readonly contentHash: string;
  readonly previousContentHash?: string;
  readonly shouldIncludeContent: boolean;
  readonly lastReadAt: number;
  readonly note?: string;
}

/** Session-local disk-read history used only for opt-in exact-range deduplication. */
export class WorkspaceReadFileContextTracker {
  private readonly sessions = new Map<string, WorkingSetSession>();

  check(request: {
    readonly sessionId: string;
    readonly absolutePath: string;
    readonly bytes: Uint8Array;
    readonly range: WorkingSetRange;
    readonly dedupeUnchangedContent?: boolean;
    readonly refresh?: boolean;
    readonly now?: number;
  }): WorkingSetResult {
    const now = request.now ?? Date.now();
    const contentHash = createHash("sha256")
      .update(request.bytes)
      .digest("hex");
    const session = this.getSession(request.sessionId, now);
    const absolutePath = path.resolve(request.absolutePath);
    const previous = session.files.get(absolutePath);
    const unchanged = previous?.contentHash === contentHash;
    const rangeKey = `${request.range.startLine}:${request.range.endLine}:${request.range.characterOffset ?? 0}`;
    const alreadyReturned = previous?.returnedRanges.has(rangeKey) ?? false;
    let status: WorkingSetResult["status"] = "new";
    let shouldIncludeContent = true;
    let note: string | undefined;
    if (previous && !unchanged) status = "changed";
    else if (unchanged) {
      if (
        request.dedupeUnchangedContent === true &&
        request.refresh !== true &&
        alreadyReturned
      ) {
        status = "omitted_unchanged";
        shouldIncludeContent = false;
        note =
          "Content omitted because this unchanged range was already returned in the session.";
      } else {
        status = "unchanged";
      }
    }
    const returnedRanges =
      previous && unchanged ? previous.returnedRanges : new Set<string>();
    if (shouldIncludeContent) returnedRanges.add(rangeKey);
    session.files.delete(absolutePath);
    session.files.set(absolutePath, {
      contentHash,
      returnedRanges,
      lastReadAt: now,
    });
    session.lastAccessedAt = now;
    while (session.files.size > MAX_FILES_PER_SESSION) {
      const oldest = session.files.keys().next().value;
      if (oldest === undefined) break;
      session.files.delete(oldest);
    }
    this.sessions.delete(request.sessionId);
    this.sessions.set(request.sessionId, session);
    while (this.sessions.size > MAX_SESSIONS) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) break;
      this.sessions.delete(oldest);
    }
    return {
      status,
      contentHash,
      ...(previous && !unchanged
        ? { previousContentHash: previous.contentHash }
        : {}),
      shouldIncludeContent,
      lastReadAt: now,
      ...(note ? { note } : {}),
    };
  }

  private getSession(sessionId: string, now: number): WorkingSetSession {
    return (
      this.sessions.get(sessionId) ?? {
        files: new Map<string, WorkingSetEntry>(),
        lastAccessedAt: now,
      }
    );
  }
}

export function buildWorkspaceReadFileContext(
  input: WorkspaceReadFileContextInput,
  tracker: WorkspaceReadFileContextTracker,
): WorkspaceReadFileContextResult {
  const rawLimit = Math.trunc(input.params.limit ?? DEFAULT_LIMIT);
  if (!Number.isFinite(rawLimit) || rawLimit <= 0) {
    return {
      ok: false,
      error: `Invalid limit: ${input.params.limit}. Must be a positive number.`,
    };
  }
  const characterOffset = input.params.characterOffset ?? 0;
  if (!Number.isSafeInteger(characterOffset) || characterOffset < 0) {
    return {
      ok: false,
      error: "Invalid character_offset: must be a non-negative safe integer.",
    };
  }
  const offset = Math.max(1, Math.trunc(input.params.offset ?? 1));
  const lines = input.content.split("\n");
  const totalLines = lines.length;
  const limit = Math.min(
    rawLimit,
    MAX_LIMIT,
    Math.max(0, totalLines - offset + 1),
  );
  const range: WorkingSetRange =
    offset > totalLines
      ? { startLine: 0, endLine: 0 }
      : {
          startLine: offset,
          endLine: offset + limit - 1,
          ...(characterOffset > 0 ? { characterOffset } : {}),
        };
  const workingSet = tracker.check({
    sessionId: input.sessionId,
    absolutePath: input.absolutePath,
    bytes: input.bytes,
    range,
    dedupeUnchangedContent: input.params.dedupeUnchangedContent,
    refresh:
      input.params.refresh === true ||
      input.params.characterOffset !== undefined,
    now: input.now,
  });
  const common = {
    path: input.path,
    total_lines: totalLines,
    size: input.bytes.byteLength,
    modified: new Date(input.modifiedMs).toISOString(),
    ...(input.language ? { language: input.language } : {}),
    working_set: workingSetPayload(workingSet, range),
    ...(input.redacted
      ? {
          redaction: {
            type: "structured_secret_values",
            ...(input.redactionStatus ? { status: input.redactionStatus } : {}),
          },
        }
      : {}),
    ...(input.legacyLanguageIntelligence !== undefined
      ? { languageIntelligence: input.legacyLanguageIntelligence }
      : {}),
  };
  if (offset > totalLines) {
    return success(
      {
        ...common,
        status: "offset_out_of_range",
        requested_offset: offset,
        valid_offset_range: { start: 1, end: totalLines },
        showing: "0-0",
        truncated: true,
      },
      input,
      workingSet.contentHash,
      0,
      true,
    );
  }
  if (characterOffset > (lines[range.startLine - 1]?.length ?? 0)) {
    return {
      ok: false,
      error: "character_offset is beyond the starting line.",
    };
  }
  const startingLine = lines[range.startLine - 1] ?? "";
  if (
    characterOffset > 0 &&
    /[\uD800-\uDBFF]/u.test(startingLine[characterOffset - 1] ?? "") &&
    /[\uDC00-\uDFFF]/u.test(startingLine[characterOffset] ?? "")
  ) {
    return {
      ok: false,
      error: "character_offset must not split a UTF-16 surrogate pair.",
    };
  }
  const preview = buildNumberedContent(
    lines,
    range.startLine,
    range.endLine,
    characterOffset,
  );
  const truncated =
    range.startLine !== 1 ||
    range.endLine !== totalLines ||
    characterOffset > 0 ||
    preview.omittedBytes > 0 ||
    preview.omittedLines > 0;
  const payload: Record<string, unknown> = {
    ...common,
    showing: `${range.startLine}-${range.endLine}`,
    ...(truncated ? { truncated: true } : {}),
    ...(preview.omittedBytes > 0 || preview.omittedLines > 0
      ? {
          content_truncation: {
            max_line_chars: MAX_LINE_CHARS,
            max_content_chars: MAX_CONTENT_CHARS,
            omitted_bytes: preview.omittedBytes,
            omitted_lines: preview.omittedLines,
            next_read: {
              path: input.path,
              view: "context",
              ...preview.nextRead,
            },
          },
        }
      : {}),
    ...(input.gitStatus ? { git_status: input.gitStatus } : {}),
  };
  if (input.enrichment?.symbols) {
    const outline = boundSymbolOutline(input.enrichment.symbols, range);
    payload.symbols = outline.symbols;
    if (outline.omitted > 0) {
      payload.symbols_truncated = true;
      payload.symbols_omitted = outline.omitted;
    }
  }
  if (input.enrichment?.diagnostics) {
    payload.diagnostics = input.enrichment.diagnostics;
  }
  if (workingSet.shouldIncludeContent) payload.content = preview.content;
  return success(
    payload,
    input,
    workingSet.contentHash,
    Math.max(0, range.endLine - range.startLine + 1),
    truncated,
  );
}

function success(
  payload: Record<string, unknown>,
  input: WorkspaceReadFileContextInput,
  contentHash: string,
  lines: number,
  truncated: boolean,
): WorkspaceReadFileContextResult {
  return {
    ok: true,
    payload,
    display: {
      path: input.path,
      contentHash,
      lines,
      truncated,
      git: input.gitStatus ? "available" : "unavailable",
    },
  };
}

function workingSetPayload(
  workingSet: WorkingSetResult,
  range: WorkingSetRange,
): Record<string, unknown> {
  return {
    status: workingSet.status,
    content_hash: workingSet.contentHash,
    ...(workingSet.previousContentHash
      ? { previous_content_hash: workingSet.previousContentHash }
      : {}),
    should_include_content: workingSet.shouldIncludeContent,
    range,
    last_read_at: workingSet.lastReadAt,
    ...(workingSet.note ? { note: workingSet.note } : {}),
  };
}

function buildNumberedContent(
  sourceLines: string[],
  startLine: number,
  endLine: number,
  characterOffset: number,
): {
  readonly content: string;
  readonly omittedBytes: number;
  readonly omittedLines: number;
  readonly nextRead?: {
    readonly offset: number;
    readonly character_offset: number;
    readonly limit: number;
  };
} {
  const lines: string[] = [];
  let remaining = MAX_CONTENT_CHARS;
  let omittedBytes = 0;
  let omittedLines = 0;
  let nextRead:
    | { offset: number; character_offset: number; limit: number }
    | undefined;
  for (let line = startLine; line <= endLine; line++) {
    const source = sourceLines[line - 1] ?? "";
    const start = line === startLine ? characterOffset : 0;
    const prefix = `${line} | `;
    const separatorLength = lines.length > 0 ? 1 : 0;
    const available = Math.max(0, remaining - prefix.length - separatorLength);
    let end = Math.min(
      source.length,
      start + MAX_LINE_CHARS,
      start + available,
    );
    if (
      end > start &&
      /[\uD800-\uDBFF]/u.test(source[end - 1] ?? "") &&
      /[\uDC00-\uDFFF]/u.test(source[end] ?? "")
    ) {
      end--;
    }
    const canInclude = remaining >= prefix.length + separatorLength;
    if (canInclude) {
      lines.push(prefix + source.slice(start, end));
      remaining -= prefix.length + separatorLength + (end - start);
    } else {
      omittedLines++;
      if (line > startLine) omittedBytes++;
    }
    const omitted = canInclude ? source.slice(end) : source.slice(start);
    omittedBytes += Buffer.byteLength(omitted, "utf8");
    if ((!canInclude || end < source.length) && !nextRead) {
      nextRead = {
        offset: line,
        character_offset: canInclude ? end : start,
        limit: 1,
      };
    }
  }
  return {
    content: lines.join("\n"),
    omittedBytes,
    omittedLines,
    ...(nextRead ? { nextRead } : {}),
  };
}

function boundSymbolOutline(
  symbols: Record<string, string[]>,
  range: WorkingSetRange,
): { readonly symbols: Record<string, string[]>; readonly omitted: number } {
  const entries = Object.entries(symbols).flatMap(([kind, names]) =>
    names.map((name) => {
      const line = Number(name.match(/\(line (\d+)\)$/u)?.[1]);
      return {
        kind,
        name,
        inRange: line >= range.startLine && line <= range.endLine,
      };
    }),
  );
  entries.sort((left, right) => Number(right.inRange) - Number(left.inRange));
  const bounded: Record<string, string[]> = Object.create(null);
  let included = 0;
  for (const { kind, name } of entries) {
    if (included >= MAX_OUTLINE_SYMBOLS) break;
    const bucket = (bounded[kind] ??= []);
    bucket.push(name);
    if (
      Buffer.byteLength(JSON.stringify(bounded), "utf8") > MAX_OUTLINE_BYTES
    ) {
      bucket.pop();
      if (!bucket.length) delete bounded[kind];
      continue;
    }
    included++;
  }
  return { symbols: bounded, omitted: entries.length - included };
}

const LSP_SYMBOL_KINDS = [
  "",
  "file",
  "module",
  "namespace",
  "package",
  "class",
  "method",
  "property",
  "field",
  "constructor",
  "enum",
  "interface",
  "function",
  "variable",
  "constant",
  "string",
  "number",
  "boolean",
  "array",
  "object",
  "key",
  "null",
  "enum member",
  "struct",
  "event",
  "operator",
  "type parameter",
] as const;
const LSP_CONTAINER_KINDS = new Set([2, 3, 5, 10, 11, 23]);

export function createManagedTypeScriptReadFileEnrichment(
  diagnosticsResult: unknown,
  symbolsResult: unknown,
): WorkspaceReadFileContextEnrichment {
  const diagnostics = managedDiagnosticsSummary(diagnosticsResult);
  const symbols = managedSymbolOutline(symbolsResult);
  return {
    ...(diagnostics ? { diagnostics } : {}),
    ...(symbols ? { symbols } : {}),
  };
}

function managedDiagnosticsSummary(
  result: unknown,
): WorkspaceReadFileContextEnrichment["diagnostics"] {
  if (
    !isRecord(result) ||
    (result.state !== "ready" && result.state !== "stale")
  ) {
    return undefined;
  }
  if (!Array.isArray(result.value)) return undefined;
  let errors = 0;
  let warnings = 0;
  for (const diagnostic of result.value) {
    if (!isRecord(diagnostic)) continue;
    if (diagnostic.severity === 1) errors++;
    else if (diagnostic.severity === 2) warnings++;
  }
  if (errors === 0 && warnings === 0 && result.state === "ready")
    return undefined;
  return {
    errors,
    warnings,
    note:
      result.state === "stale"
        ? "Managed TypeScript language-service counts are stale and may not match the returned disk text."
        : "Managed TypeScript language-service counts are tied to its current document snapshot.",
  };
}

function managedSymbolOutline(
  result: unknown,
): Record<string, string[]> | undefined {
  if (
    !isRecord(result) ||
    (result.state !== "ready" && result.state !== "stale")
  ) {
    return undefined;
  }
  if (!Array.isArray(result.value)) return undefined;
  const grouped: Record<string, string[]> = Object.create(null);
  for (const symbol of result.value) {
    addManagedSymbol(grouped, symbol);
    if (
      isRecord(symbol) &&
      typeof symbol.kind === "number" &&
      LSP_CONTAINER_KINDS.has(symbol.kind) &&
      Array.isArray(symbol.children)
    ) {
      for (const child of symbol.children.slice(0, 10)) {
        addManagedSymbol(
          grouped,
          child,
          typeof symbol.name === "string" ? symbol.name : undefined,
        );
      }
    }
  }
  return Object.keys(grouped).length > 0 ? grouped : undefined;
}

function addManagedSymbol(
  grouped: Record<string, string[]>,
  value: unknown,
  parentName?: string,
): void {
  if (!isRecord(value) || typeof value.name !== "string") return;
  const kind =
    typeof value.kind === "number"
      ? (LSP_SYMBOL_KINDS[value.kind] ?? "symbol")
      : "symbol";
  const range = isRecord(value.range) ? value.range : undefined;
  const start = range && isRecord(range.start) ? range.start : undefined;
  const line = typeof start?.line === "number" ? start.line + 1 : undefined;
  const name = parentName ? `${parentName}.${value.name}` : value.name;
  (grouped[kind] ??= []).push(
    line === undefined ? name : `${name} (line ${line})`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".c": "c",
  ".cc": "cpp",
  ".cjs": "javascript",
  ".cpp": "cpp",
  ".cs": "csharp",
  ".css": "css",
  ".go": "go",
  ".h": "c",
  ".hpp": "cpp",
  ".html": "html",
  ".java": "java",
  ".js": "javascript",
  ".json": "json",
  ".jsonc": "jsonc",
  ".jsx": "javascriptreact",
  ".md": "markdown",
  ".mjs": "javascript",
  ".py": "python",
  ".rs": "rust",
  ".scss": "scss",
  ".sh": "shellscript",
  ".sql": "sql",
  ".swift": "swift",
  ".toml": "toml",
  ".ts": "typescript",
  ".tsx": "typescriptreact",
  ".xml": "xml",
  ".yaml": "yaml",
  ".yml": "yaml",
};

export function detectWorkspaceReadFileLanguage(
  filePath: string,
): string | undefined {
  const base = path.basename(filePath).toLowerCase();
  if (base === "dockerfile") return "dockerfile";
  if (base === "makefile") return "makefile";
  return LANGUAGE_BY_EXTENSION[path.extname(base)];
}
