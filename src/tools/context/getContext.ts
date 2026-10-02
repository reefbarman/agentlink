import * as vscode from "vscode";

import type {
  ContextDocumentProvider,
  ContextEnrichmentProvider,
  ContextResolvedDocument,
  ContextWorkingSetCheckResult,
  ContextWorkingSetProvider,
  ContextWorkingSetRange,
} from "../../core/capabilities/readSearch.js";

import { SYMBOL_KIND_NAMES } from "../languageFeatures.js";
import {
  errorResult,
  handleToolError,
  jsonResult,
  type ToolResult,
} from "@agentlink/protocol/tool-result";

import {
  getStructuredSecretRedactionMetadata,
  isStructuredConfigPath,
  redactStructuredSecrets,
  type StructuredSecretRedactionResult,
} from "../../shared/structuredSecretRedaction.js";

import { buildReadFileError, getGitStatus } from "../readFile.js";

export interface GetContextParams {
  path: string;
  offset?: number;
  limit?: number;
  character_offset?: number;
  include_symbols?: boolean;
  dedupe_unchanged_content?: boolean;
  refresh?: boolean;
}

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 400;
const MAX_LINE_CHARS = 2_000;
const MAX_CONTENT_CHARS = 20_000;
const SYMBOL_TIMEOUT_MS = 5_000;
const MAX_OUTLINE_SYMBOLS = 60;
const MAX_OUTLINE_BYTES = 6_000;
const CONTAINER_KINDS = new Set([
  vscode.SymbolKind.Class,
  vscode.SymbolKind.Interface,
  vscode.SymbolKind.Enum,
  vscode.SymbolKind.Struct,
  vscode.SymbolKind.Namespace,
  vscode.SymbolKind.Module,
]);

export interface GetContextProviders {
  documentProvider: ContextDocumentProvider;
  workingSetProvider: ContextWorkingSetProvider;
  enrichmentProvider: ContextEnrichmentProvider;
  symbolTimeoutMs?: number;
}

export async function handleGetContext(
  params: GetContextParams,
  sessionId: string,
  providers: GetContextProviders,
): Promise<ToolResult> {
  try {
    const document = await providers.documentProvider.resolveDocument(
      params.path,
      sessionId,
    );
    const { absolutePath, relPath } = document;

    const rawLimit = Math.trunc(params.limit ?? DEFAULT_LIMIT);
    if (!Number.isFinite(rawLimit) || rawLimit <= 0) {
      return errorResult(
        `Invalid limit: ${params.limit}. Must be a positive number.`,
        { path: params.path },
      );
    }

    const characterOffset = params.character_offset ?? 0;
    if (!Number.isSafeInteger(characterOffset) || characterOffset < 0) {
      return errorResult(
        "Invalid character_offset: must be a non-negative safe integer.",
        {
          path: params.path,
        },
      );
    }
    const offset = Math.max(1, Math.trunc(params.offset ?? 1));
    let diskLines: string[] = [];
    let totalLines = 0;
    let structuredRedaction: StructuredSecretRedactionResult | undefined;
    const workingSet = await providers.workingSetProvider.check({
      sessionId,
      path: absolutePath,
      deriveRange: (contentBytes) => {
        const raw = Buffer.from(contentBytes).toString("utf-8");
        structuredRedaction = isStructuredConfigPath(absolutePath)
          ? redactStructuredSecrets(absolutePath, raw)
          : undefined;
        diskLines = (structuredRedaction?.content ?? raw).split("\n");
        totalLines = diskLines.length;
        if (offset > totalLines) {
          return { startLine: 0, endLine: 0 };
        }
        const limit = Math.min(rawLimit, MAX_LIMIT, totalLines - offset + 1);
        return {
          startLine: offset,
          endLine: offset + limit - 1,
          ...(characterOffset > 0 ? { characterOffset } : {}),
        };
      },
      dedupeUnchangedContent: params.dedupe_unchanged_content,
      // An explicit continuation requests content even if its page was seen.
      refresh: params.refresh || params.character_offset !== undefined,
    });

    const range = workingSet.range ?? { startLine: 0, endLine: 0 };
    if (offset > totalLines) {
      const redactionMetadata =
        getStructuredSecretRedactionMetadata(structuredRedaction);
      return jsonResult({
        path: relPath,
        status: "offset_out_of_range",
        requested_offset: offset,
        valid_offset_range: { start: 1, end: totalLines },
        total_lines: totalLines,
        showing: "0-0",
        truncated: true,
        size: workingSet.size,
        modified: new Date(workingSet.modifiedMs).toISOString(),
        language: document.languageId,
        working_set: buildWorkingSetPayload(workingSet, range),
        ...(redactionMetadata ? { redaction: redactionMetadata } : {}),
      });
    }

    if (characterOffset > (diskLines[range.startLine - 1]?.length ?? 0)) {
      return errorResult("character_offset is beyond the starting line.", {
        path: params.path,
        reason: "character_offset_out_of_range",
      });
    }
    const startingLine = diskLines[range.startLine - 1] ?? "";
    if (
      characterOffset > 0 &&
      /[\uD800-\uDBFF]/.test(startingLine[characterOffset - 1]) &&
      /[\uDC00-\uDFFF]/.test(startingLine[characterOffset] ?? "")
    ) {
      return errorResult(
        "character_offset must not split a UTF-16 surrogate pair.",
        { path: params.path },
      );
    }
    const preview = buildNumberedContent(
      diskLines,
      range.startLine,
      range.endLine,
      characterOffset,
    );
    const content = workingSet.shouldIncludeContent
      ? preview.content
      : undefined;

    const result: Record<string, unknown> = {
      path: relPath,
      total_lines: totalLines,
      showing: `${range.startLine}-${range.endLine}`,
      ...(range.startLine !== 1 ||
      range.endLine !== totalLines ||
      characterOffset > 0 ||
      preview.omittedBytes > 0 ||
      preview.omittedLines > 0
        ? { truncated: true }
        : {}),
      ...(preview.omittedBytes > 0 || preview.omittedLines > 0
        ? {
            content_truncation: {
              max_line_chars: MAX_LINE_CHARS,
              max_content_chars: MAX_CONTENT_CHARS,
              omitted_bytes: preview.omittedBytes,
              omitted_lines: preview.omittedLines,
              next_read: {
                path: relPath,
                view: "context",
                ...preview.nextRead,
              },
            },
          }
        : {}),
      size: workingSet.size,
      modified: new Date(workingSet.modifiedMs).toISOString(),
      language: document.languageId,
      working_set: buildWorkingSetPayload(workingSet, range),
    };
    const redactionMetadata =
      getStructuredSecretRedactionMetadata(structuredRedaction);
    if (redactionMetadata) result.redaction = redactionMetadata;

    const gitStatus =
      await providers.enrichmentProvider.getGitStatus(absolutePath);
    if (gitStatus) result.git_status = gitStatus;

    const symbols =
      params.include_symbols === false
        ? undefined
        : await getDocumentSymbolsWithTimeout(
            providers.enrichmentProvider,
            document,
            providers.symbolTimeoutMs ?? SYMBOL_TIMEOUT_MS,
          );
    if (symbols) {
      const outline = boundSymbolOutline(symbols, range);
      result.symbols = outline.symbols;
      if (outline.omitted > 0) {
        result.symbols_truncated = true;
        result.symbols_omitted = outline.omitted;
      }
    }

    const diagnostics =
      providers.enrichmentProvider.getDiagnosticsSummary(document);
    if (diagnostics) result.diagnostics = diagnostics;

    if (content !== undefined) {
      result.content = content;
    }

    return jsonResult(result, true);
  } catch (err) {
    if (isMissingFileError(err)) {
      const payload = await buildReadFileError(
        normalizeMissingFileError(err),
        params.path,
      );
      const { error, ...details } = payload;
      return errorResult(String(error), details);
    }
    return handleToolError(err, { path: params.path });
  }
}

function boundSymbolOutline(
  symbols: Record<string, string[]>,
  range: ContextWorkingSetRange,
): { symbols: Record<string, string[]>; omitted: number } {
  const entries = Object.entries(symbols).flatMap(([kind, names]) =>
    names.map((name) => {
      const line = Number(name.match(/\(line (\d+)\)$/)?.[1]);
      return {
        kind,
        name,
        inRange: line >= range.startLine && line <= range.endLine,
      };
    }),
  );
  // Keep the existing grouped shape, prioritising the requested slice before
  // the whole-file overview. Bound serialized bytes as well as symbol count.
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

function buildNumberedContent(
  sourceLines: string[],
  startLine: number,
  endLine: number,
  characterOffset: number,
): {
  content: string;
  omittedBytes: number;
  omittedLines: number;
  nextRead?: { offset: number; character_offset: number; limit: number };
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
    // Do not cut a surrogate pair at the end of a preview.
    if (
      end > start &&
      /[\uD800-\uDBFF]/.test(source[end - 1]) &&
      /[\uDC00-\uDFFF]/.test(source[end] ?? "")
    )
      end--;
    const excerpt = source.slice(start, end);
    const canInclude = remaining >= prefix.length + separatorLength;
    if (canInclude) {
      lines.push(prefix + excerpt);
      remaining -= prefix.length + separatorLength + excerpt.length;
    }
    if (!canInclude) {
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
  return { content: lines.join("\n"), omittedBytes, omittedLines, nextRead };
}

function buildWorkingSetPayload(
  workingSet: ContextWorkingSetCheckResult,
  range: ContextWorkingSetRange,
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

async function getDocumentSymbolsWithTimeout(
  provider: ContextEnrichmentProvider,
  document: ContextResolvedDocument,
  timeoutMs: number,
): Promise<Record<string, string[]> | undefined> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = Symbol("timeout");
  try {
    const symbols = await Promise.race([
      provider.getDocumentSymbols(document),
      new Promise<typeof timedOut>((resolve) => {
        timeout = setTimeout(() => resolve(timedOut), timeoutMs);
        timeout.unref?.();
      }),
    ]);
    return symbols === timedOut ? undefined : symbols;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function getContextDocumentSymbols(
  document: ContextResolvedDocument,
): Promise<Record<string, string[]> | undefined> {
  const { uri } = getVscodeContextDocument(document);
  const languageId = document.languageId;
  if (languageId === "json" || languageId === "jsonc") {
    return undefined;
  }

  const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
    "vscode.executeDocumentSymbolProvider",
    uri,
  );
  if (!symbols?.length) {
    return undefined;
  }

  const grouped: Record<string, string[]> = Object.create(null) as Record<
    string,
    string[]
  >;
  for (const symbol of symbols) {
    addSymbol(grouped, symbol);
    if (CONTAINER_KINDS.has(symbol.kind)) {
      for (const child of symbol.children.slice(0, 10)) {
        addSymbol(grouped, child, symbol.name);
      }
    }
  }
  return grouped;
}

function addSymbol(
  grouped: Record<string, string[]>,
  symbol: vscode.DocumentSymbol,
  parentName?: string,
): void {
  const kind = SYMBOL_KIND_NAMES[symbol.kind] ?? "symbol";
  const bucket = (grouped[kind] ??= []);
  const name = parentName ? `${parentName}.${symbol.name}` : symbol.name;
  bucket.push(`${name} (line ${symbol.range.start.line + 1})`);
}

export function getContextDiagnosticsSummary(
  document: ContextResolvedDocument,
):
  | {
      errors: number;
      warnings: number;
      note: string;
      open_document_dirty: boolean;
      buffer_note?: string;
    }
  | undefined {
  const { uri, document: editorDocument } = getVscodeContextDocument(document);
  const diagnostics = vscode.languages.getDiagnostics(uri);
  if (!diagnostics.length && !editorDocument.isDirty) {
    return undefined;
  }

  let errors = 0;
  let warnings = 0;
  for (const diagnostic of diagnostics) {
    if (diagnostic.severity === vscode.DiagnosticSeverity.Error) {
      errors++;
    } else if (diagnostic.severity === vscode.DiagnosticSeverity.Warning) {
      warnings++;
    }
  }
  return {
    errors,
    warnings,
    note: "Cached language-service counts; source freshness is unverified and counts are not tied to a specific document version.",
    open_document_dirty: editorDocument.isDirty,
    ...(editorDocument.isDirty
      ? {
          buffer_note:
            "The matching file-backed editor is dirty, so its buffer may differ from the disk text returned here.",
        }
      : {}),
  };
}

export function getContextGitStatus(
  filePath: string,
): Promise<string | undefined> {
  return getGitStatus(filePath);
}

function isMissingFileError(err: unknown): err is NodeJS.ErrnoException {
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "FileNotFound";
}

function normalizeMissingFileError(err: NodeJS.ErrnoException): Error {
  if ((err as NodeJS.ErrnoException).code === "ENOENT") return err;
  return Object.assign(new Error(err.message), { code: "ENOENT" });
}

function getVscodeContextDocument(document: ContextResolvedDocument): {
  uri: vscode.Uri;
  document: vscode.TextDocument;
} {
  const hostDocument = document.hostDocument as
    | { uri?: vscode.Uri; document?: vscode.TextDocument }
    | undefined;
  if (!hostDocument?.uri || !hostDocument.document) {
    throw new Error("VS Code context document is unavailable.");
  }
  return { uri: hostDocument.uri, document: hostDocument.document };
}
