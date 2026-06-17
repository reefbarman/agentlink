import * as path from "path";
import * as vscode from "vscode";

import {
  COMPLETION_KIND_NAMES,
  SYMBOL_KIND_NAMES,
  extractHoverContent,
  resolveAndOpenDocument,
  serializeLocation,
  toPosition,
} from "../../tools/languageFeatures.js";
import type {
  DiagnosticsProvider,
  LanguageCompletionsProvider,
  LanguageHoverProvider,
  LanguageNavigationParams,
  LanguageNavigationProvider,
  LanguageReferencesProvider,
  LanguageSymbolsProvider,
} from "../../core/capabilities/language.js";
import { getRelativePath, resolveAndValidatePath } from "../../util/paths.js";

import type { ApprovalManager } from "../../approvals/ApprovalManager.js";
import type { ApprovalPanelProvider } from "../../approvals/ApprovalPanelProvider.js";

export function createVscodeNavigationProvider(
  approvalManager: ApprovalManager,
  approvalPanel: ApprovalPanelProvider,
): LanguageNavigationProvider {
  return {
    goToDefinition(params) {
      return executeNavigationProvider({
        params,
        approvalManager,
        approvalPanel,
        command: "vscode.executeDefinitionProvider",
        resultKey: "definitions",
        emptyMessage: "No definition found",
      });
    },
    goToImplementation(params) {
      return executeNavigationProvider({
        params,
        approvalManager,
        approvalPanel,
        command: "vscode.executeImplementationProvider",
        resultKey: "implementations",
        emptyMessage: "No implementation found",
      });
    },
    goToTypeDefinition(params) {
      return executeNavigationProvider({
        params,
        approvalManager,
        approvalPanel,
        command: "vscode.executeTypeDefinitionProvider",
        resultKey: "type_definitions",
        emptyMessage: "No type definition found",
      });
    },
  };
}

export function createVscodeReferencesProvider(
  approvalManager: ApprovalManager,
  approvalPanel: ApprovalPanelProvider,
): LanguageReferencesProvider {
  return {
    async getReferences(params) {
      const { uri } = await resolveAndOpenDocument(
        params.path,
        approvalManager,
        approvalPanel,
        params.sessionId,
      );
      const position = toPosition(params.line, params.column);

      const locations = await vscode.commands.executeCommand<vscode.Location[]>(
        "vscode.executeReferenceProvider",
        uri,
        position,
      );

      if (!locations || locations.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                total_references: 0,
                truncated: false,
                references: [],
              }),
            },
          ],
        };
      }

      let filtered = locations;
      if (params.include_declaration === false) {
        filtered = locations.filter(
          (loc) =>
            !(
              loc.uri.fsPath === uri.fsPath &&
              loc.range.start.line === position.line &&
              loc.range.start.character <= position.character &&
              loc.range.end.character >= position.character
            ),
        );
      }

      const total = filtered.length;
      const truncated = total > MAX_REFERENCES;
      const capped = truncated ? filtered.slice(0, MAX_REFERENCES) : filtered;

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              total_references: total,
              truncated,
              references: capped.map(serializeLocation),
            }),
          },
        ],
      };
    },
  };
}

export function createVscodeSymbolsProvider(
  approvalManager: ApprovalManager,
  approvalPanel: ApprovalPanelProvider,
): LanguageSymbolsProvider {
  return {
    async getSymbols(params) {
      if (!params.path && !params.query) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error:
                  "Either 'path' (for document symbols) or 'query' (for workspace symbol search) is required",
              }),
            },
          ],
        };
      }

      if (params.path) {
        const { uri, relPath } = await resolveAndOpenDocument(
          params.path,
          approvalManager,
          approvalPanel,
          params.sessionId,
        );

        const symbols = await vscode.commands.executeCommand<
          vscode.DocumentSymbol[]
        >("vscode.executeDocumentSymbolProvider", uri);

        if (!symbols || symbols.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  mode: "document",
                  path: relPath,
                  symbols: [],
                }),
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                mode: "document",
                path: relPath,
                symbols: symbols.map(serializeDocumentSymbol),
              }),
            },
          ],
        };
      }

      const query = params.query!;
      const symbols = await vscode.commands.executeCommand<
        vscode.SymbolInformation[]
      >("vscode.executeWorkspaceSymbolProvider", query);

      if (!symbols || symbols.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                mode: "workspace",
                query,
                total: 0,
                symbols: [],
              }),
            },
          ],
        };
      }

      const total = symbols.length;
      const capped = symbols.slice(0, MAX_WORKSPACE_SYMBOLS);

      const serialized = capped.map((sym) => ({
        name: sym.name,
        kind: SYMBOL_KIND_NAMES[sym.kind] ?? "symbol",
        path: getRelativePath(sym.location.uri.fsPath),
        line: sym.location.range.start.line + 1,
        containerName: sym.containerName || undefined,
      }));

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              mode: "workspace",
              query,
              total,
              truncated: total > MAX_WORKSPACE_SYMBOLS,
              symbols: serialized,
            }),
          },
        ],
      };
    },
  };
}

export function createVscodeHoverProvider(
  approvalManager: ApprovalManager,
  approvalPanel: ApprovalPanelProvider,
): LanguageHoverProvider {
  return {
    async getHover(params) {
      const { uri } = await resolveAndOpenDocument(
        params.path,
        approvalManager,
        approvalPanel,
        params.sessionId,
      );
      const position = toPosition(params.line, params.column);

      const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
        "vscode.executeHoverProvider",
        uri,
        position,
      );

      if (!hovers || hovers.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                hover: null,
                message: "No hover information available at this position",
              }),
            },
          ],
        };
      }

      const parts: string[] = [];
      for (const hover of hovers) {
        for (const content of hover.contents) {
          const text = extractHoverContent(content);
          if (text.trim()) parts.push(text.trim());
        }
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ hover: parts.join("\n---\n") || null }),
          },
        ],
      };
    },
  };
}

export function createVscodeCompletionsProvider(
  approvalManager: ApprovalManager,
  approvalPanel: ApprovalPanelProvider,
): LanguageCompletionsProvider {
  return {
    async getCompletions(params) {
      const { uri } = await resolveAndOpenDocument(
        params.path,
        approvalManager,
        approvalPanel,
        params.sessionId,
      );
      const position = toPosition(params.line, params.column);
      const limit = params.limit ?? DEFAULT_COMPLETIONS_LIMIT;

      const completionList =
        await vscode.commands.executeCommand<vscode.CompletionList>(
          "vscode.executeCompletionItemProvider",
          uri,
          position,
        );

      if (!completionList || completionList.items.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                is_incomplete: false,
                total_items: 0,
                showing: 0,
                items: [],
              }),
            },
          ],
        };
      }

      const total = completionList.items.length;
      const capped = completionList.items.slice(0, limit);

      const items = capped.map((item) => {
        const label =
          typeof item.label === "string" ? item.label : item.label.label;

        const result: Record<string, unknown> = { label };

        if (item.kind !== undefined) {
          result.kind = COMPLETION_KIND_NAMES[item.kind] ?? "unknown";
        }
        if (item.detail) result.detail = item.detail;

        const doc = extractCompletionDocumentation(item.documentation);
        if (doc) result.documentation = doc;

        const insertText = extractCompletionInsertText(item);
        if (insertText) result.insertText = insertText;

        return result;
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              is_incomplete: completionList.isIncomplete,
              total_items: total,
              showing: capped.length,
              items,
            }),
          },
        ],
      };
    },
  };
}

export function createVscodeDiagnosticsProvider(): DiagnosticsProvider {
  return {
    async getDiagnostics(params) {
      let diagnostics: [vscode.Uri, vscode.Diagnostic[]][];

      if (params.path) {
        const { absolutePath: filePath } = resolveAndValidatePath(params.path);
        const uri = vscode.Uri.file(filePath);
        const fileDiags = vscode.languages.getDiagnostics(uri);
        diagnostics = [[uri, fileDiags]];
      } else {
        diagnostics = vscode.languages.getDiagnostics();
      }

      const severityFilter = params.severity
        ? parseSeverityFilter(params.severity)
        : undefined;

      const sourceFilter = params.source
        ? params.source
            .split(",")
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean)
        : undefined;

      const results: Array<{
        file: string;
        diagnostics: Array<{
          line: number;
          column: number;
          severity: string;
          message: string;
          source?: string;
          code?: string | number;
        }>;
      }> = [];

      for (const [uri, diags] of diagnostics) {
        const filteredDiags = diags.filter((d) => {
          if (severityFilter && !severityFilter.has(d.severity)) return false;
          if (
            sourceFilter &&
            !sourceFilter.some((s) => d.source?.toLowerCase().includes(s))
          ) {
            return false;
          }
          return true;
        });

        if (filteredDiags.length === 0) continue;

        const workspaceRoot =
          vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const filePath = workspaceRoot
          ? path.relative(workspaceRoot, uri.fsPath)
          : uri.fsPath;

        results.push({
          file: filePath,
          diagnostics: filteredDiags.map((d) => ({
            line: d.range.start.line + 1,
            column: d.range.start.character + 1,
            severity: severityToString(d.severity),
            message: d.message,
            ...(d.source && { source: d.source }),
            ...(d.code !== undefined && {
              code:
                typeof d.code === "object" && d.code !== null
                  ? (d.code as { value: string | number }).value
                  : d.code,
            }),
          })),
        });
      }

      if (results.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: params.path
                ? `No diagnostics found for ${params.path}`
                : "No diagnostics found in workspace",
            },
          ],
        };
      }

      return {
        content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
      };
    },
  };
}

async function executeNavigationProvider({
  params,
  approvalManager,
  approvalPanel,
  command,
  resultKey,
  emptyMessage,
}: {
  params: LanguageNavigationParams;
  approvalManager: ApprovalManager;
  approvalPanel: ApprovalPanelProvider;
  command:
    | "vscode.executeDefinitionProvider"
    | "vscode.executeImplementationProvider"
    | "vscode.executeTypeDefinitionProvider";
  resultKey: "definitions" | "implementations" | "type_definitions";
  emptyMessage: string;
}) {
  const { uri } = await resolveAndOpenDocument(
    params.path,
    approvalManager,
    approvalPanel,
    params.sessionId,
  );
  const position = toPosition(params.line, params.column);

  const results = await vscode.commands.executeCommand<
    (vscode.Location | vscode.LocationLink)[]
  >(command, uri, position);

  if (!results || results.length === 0) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            [resultKey]: [],
            message: emptyMessage,
          }),
        },
      ],
    };
  }

  const locations = results.map((result) => {
    if ("targetUri" in result) {
      const loc = new vscode.Location(result.targetUri, result.targetRange);
      return serializeLocation(loc);
    }
    return serializeLocation(result);
  });

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ [resultKey]: locations }),
      },
    ],
  };
}

interface SerializedDocumentSymbol {
  name: string;
  kind: string;
  line: number;
  endLine: number;
  children: SerializedDocumentSymbol[];
}

function serializeDocumentSymbol(
  sym: vscode.DocumentSymbol,
): SerializedDocumentSymbol {
  return {
    name: sym.name,
    kind: SYMBOL_KIND_NAMES[sym.kind] ?? "symbol",
    line: sym.range.start.line + 1,
    endLine: sym.range.end.line + 1,
    children: sym.children.map(serializeDocumentSymbol),
  };
}

function extractCompletionDocumentation(
  doc: string | vscode.MarkdownString | undefined,
): string | undefined {
  if (!doc) return undefined;
  const text = typeof doc === "string" ? doc : doc.value;
  if (!text) return undefined;
  return text.length > MAX_COMPLETION_DOC_LENGTH
    ? text.slice(0, MAX_COMPLETION_DOC_LENGTH) + "..."
    : text;
}

function extractCompletionInsertText(
  item: vscode.CompletionItem,
): string | undefined {
  if (!item.insertText) return undefined;
  const text =
    typeof item.insertText === "string"
      ? item.insertText
      : item.insertText.value;
  const label = typeof item.label === "string" ? item.label : item.label.label;
  return text === label ? undefined : text;
}

const DEFAULT_COMPLETIONS_LIMIT = 50;
const MAX_COMPLETION_DOC_LENGTH = 200;
const MAX_REFERENCES = 200;
const MAX_WORKSPACE_SYMBOLS = 100;

const VALID_SEVERITIES = new Set([
  "error",
  "warning",
  "info",
  "information",
  "hint",
]);

function parseSeverityFilter(input: string): Set<vscode.DiagnosticSeverity> {
  const parts = input
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const result = new Set<vscode.DiagnosticSeverity>();
  for (const part of parts) {
    if (!VALID_SEVERITIES.has(part)) continue;
    switch (part) {
      case "error":
        result.add(vscode.DiagnosticSeverity.Error);
        break;
      case "warning":
        result.add(vscode.DiagnosticSeverity.Warning);
        break;
      case "info":
      case "information":
        result.add(vscode.DiagnosticSeverity.Information);
        break;
      case "hint":
        result.add(vscode.DiagnosticSeverity.Hint);
        break;
    }
  }
  return result;
}

function severityToString(severity: vscode.DiagnosticSeverity): string {
  switch (severity) {
    case vscode.DiagnosticSeverity.Error:
      return "error";
    case vscode.DiagnosticSeverity.Warning:
      return "warning";
    case vscode.DiagnosticSeverity.Information:
      return "info";
    case vscode.DiagnosticSeverity.Hint:
      return "hint";
    default:
      return "unknown";
  }
}
