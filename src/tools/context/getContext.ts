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
import type { ToolResult } from "../../shared/types.js";
import path from "node:path";

export interface GetContextParams {
  path: string;
  offset?: number;
  limit?: number;
  dedupe_unchanged_content?: boolean;
  refresh?: boolean;
}

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 400;
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
      return textResult({
        error: `Invalid limit: ${params.limit}. Must be a positive number.`,
        path: params.path,
      });
    }

    const offset = Math.max(1, Math.trunc(params.offset ?? 1));
    let diskLines: string[] = [];
    let totalLines = 0;
    const workingSet = await providers.workingSetProvider.check({
      sessionId,
      path: absolutePath,
      deriveRange: (contentBytes) => {
        diskLines = Buffer.from(contentBytes).toString("utf-8").split("\n");
        totalLines = diskLines.length;
        if (offset > totalLines) {
          return { startLine: offset, endLine: offset - 1 };
        }
        const limit = Math.min(rawLimit, MAX_LIMIT, totalLines - offset + 1);
        return { startLine: offset, endLine: offset + limit - 1 };
      },
      dedupeUnchangedContent: params.dedupe_unchanged_content,
      refresh: params.refresh,
    });

    const range = workingSet.range ?? {
      startLine: offset,
      endLine: offset - 1,
    };
    if (offset > totalLines) {
      return textResult({
        path: relPath,
        total_lines: totalLines,
        showing: "0-0",
        truncated: true,
        size: workingSet.size,
        modified: new Date(workingSet.modifiedMs).toISOString(),
        language: document.languageId,
        working_set: buildWorkingSetPayload(workingSet, range),
      });
    }

    const content = workingSet.shouldIncludeContent
      ? buildNumberedContent(diskLines, range.startLine, range.endLine)
      : undefined;

    const result: Record<string, unknown> = {
      path: relPath,
      total_lines: totalLines,
      showing: `${range.startLine}-${range.endLine}`,
      ...(range.startLine !== 1 || range.endLine !== totalLines
        ? { truncated: true }
        : {}),
      size: workingSet.size,
      modified: new Date(workingSet.modifiedMs).toISOString(),
      language: document.languageId,
      working_set: buildWorkingSetPayload(workingSet, range),
    };

    const gitStatus = providers.enrichmentProvider.getGitStatus(absolutePath);
    if (gitStatus) result.git_status = gitStatus;

    const symbols =
      await providers.enrichmentProvider.getDocumentSymbols(document);
    if (symbols) result.symbols = symbols;

    const diagnostics =
      providers.enrichmentProvider.getDiagnosticsSummary(document);
    if (diagnostics) result.diagnostics = diagnostics;

    if (content !== undefined) {
      result.content = content;
    }

    return textResult(result, true);
  } catch (err) {
    if (typeof err === "object" && err !== null && "content" in err) {
      return err as ToolResult;
    }
    const message = err instanceof Error ? err.message : String(err);
    return textResult({ error: message, path: params.path });
  }
}

function buildNumberedContent(
  sourceLines: string[],
  startLine: number,
  endLine: number,
): string {
  const lines: string[] = [];
  for (let line = startLine; line <= endLine; line++) {
    lines.push(`${line} | ${sourceLines[line - 1] ?? ""}`);
  }
  return lines.join("\n");
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
): { errors: number; warnings: number } | undefined {
  const { uri } = getVscodeContextDocument(document);
  const diagnostics = vscode.languages.getDiagnostics(uri);
  if (!diagnostics.length) {
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
  return { errors, warnings };
}

interface GitChange {
  uri: vscode.Uri;
}

interface GitRepository {
  state: {
    indexChanges: GitChange[];
    workingTreeChanges: GitChange[];
    untrackedChanges?: GitChange[];
  };
  rootUri: vscode.Uri;
}

interface GitAPI {
  repositories: GitRepository[];
}

interface GitExtension {
  getAPI(version: 1): GitAPI;
}

export function getContextGitStatus(filePath: string): string | undefined {
  try {
    const gitExtension =
      vscode.extensions.getExtension<GitExtension>("vscode.git");
    if (!gitExtension?.isActive) {
      return undefined;
    }

    const api = gitExtension.exports.getAPI(1);
    for (const repo of api.repositories) {
      const repoRoot = repo.rootUri.fsPath;
      if (!path.relative(repoRoot, filePath).startsWith("..")) {
        if (
          repo.state.indexChanges.some(
            (change) => change.uri.fsPath === filePath,
          )
        ) {
          return "staged";
        }
        if (
          repo.state.workingTreeChanges.some(
            (change) => change.uri.fsPath === filePath,
          )
        ) {
          return "modified";
        }
        if (
          repo.state.untrackedChanges?.some(
            (change) => change.uri.fsPath === filePath,
          )
        ) {
          return "untracked";
        }
        return "clean";
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
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

function textResult(payload: unknown, pretty = false): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, pretty ? 2 : undefined),
      },
    ],
  };
}
