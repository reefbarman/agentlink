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
  LanguageCodeActionsProvider,
  LanguageCompletionsProvider,
  LanguageHierarchyParams,
  LanguageHierarchyProvider,
  LanguageHoverProvider,
  LanguageInlayHintsProvider,
  LanguageNavigationParams,
  LanguageNavigationProvider,
  LanguageReferencesProvider,
  LanguageSymbolsProvider,
} from "../../core/capabilities/language.js";
import {
  anyMemoryProtectedPath,
  isMemoryProtectedPath,
} from "../../approvals/protectedPaths.js";
import {
  clearCachedCodeActions,
  getCachedCodeActions,
  setCachedCodeActions,
} from "../../tools/codeActionCache.js";
import {
  getRelativePath,
  resolveAndValidatePath,
  tryGetFirstWorkspaceRoot,
} from "../../util/paths.js";

import type { ApprovalManager } from "../../approvals/ApprovalManager.js";
import type { ApprovalPanelProvider } from "../../approvals/ApprovalPanelProvider.js";
import { withPrimaryEditorColumn } from "../../util/editorPlacement.js";

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

export function createVscodeCodeActionsProvider(
  approvalManager: ApprovalManager,
  approvalPanel: ApprovalPanelProvider,
): LanguageCodeActionsProvider {
  return {
    async getCodeActions(params) {
      const { uri } = await resolveAndOpenDocument(
        params.path,
        approvalManager,
        approvalPanel,
        params.sessionId,
      );

      const startPos = toPosition(params.line, params.column);
      const endPos = params.end_line
        ? toPosition(params.end_line, params.end_column ?? params.column)
        : startPos;
      const range = new vscode.Range(startPos, endPos);

      let actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
        "vscode.executeCodeActionProvider",
        uri,
        range,
        params.kind,
      );

      if (!actions || actions.length === 0) {
        clearCachedCodeActions(params.sessionId);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                actions: [],
                message: "No code actions available",
              }),
            },
          ],
        };
      }

      if (params.only_preferred) {
        actions = actions.filter((a) => a.isPreferred);
      }

      setCachedCodeActions(params.sessionId, {
        path: params.path,
        line: params.line,
        column: params.column,
        actions,
      });

      const serialized = actions.map((action, index) => {
        const result: Record<string, unknown> = {
          index,
          title: action.title,
        };
        if (action.kind) result.kind = action.kind.value;
        if (action.isPreferred) result.preferred = true;
        if (action.diagnostics?.length) {
          result.fixes_diagnostics = action.diagnostics.map((d) => ({
            message: d.message,
            severity:
              d.severity === vscode.DiagnosticSeverity.Error
                ? "error"
                : d.severity === vscode.DiagnosticSeverity.Warning
                  ? "warning"
                  : "info",
          }));
        }
        if (action.edit) {
          const entries = action.edit.entries();
          const fileCount = entries.length;
          const editCount = entries.reduce(
            (sum, [, edits]) => sum + edits.length,
            0,
          );
          result.changes = { files: fileCount, edits: editCount };
        }
        if (action.command) {
          result.has_command = true;
        }
        return result;
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ actions: serialized }, null, 2),
          },
        ],
      };
    },
    async applyCodeAction(params) {
      const cachedActions = getCachedCodeActions(params.sessionId);
      if (!cachedActions) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: "No cached code actions. Call get_code_actions first.",
              }),
            },
          ],
        };
      }

      const { actions } = cachedActions;

      if (params.index < 0 || params.index >= actions.length) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: `Invalid index ${params.index}. Available: 0-${actions.length - 1}`,
              }),
            },
          ],
        };
      }

      const action = actions[params.index];
      const changedFiles: string[] = [];
      const cachedTargetPath = path.isAbsolute(cachedActions.path)
        ? cachedActions.path
        : path.resolve(
            tryGetFirstWorkspaceRoot() ?? process.cwd(),
            cachedActions.path,
          );
      const cachedTargetIsProtected = isMemoryProtectedPath(cachedTargetPath);

      if (cachedTargetIsProtected && action.command) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "rejected",
                action: action.title,
                reason:
                  "Code action includes an executable command while targeting a protected instructions/memory file. Command side effects cannot be preflighted; use write_file/apply_diff with explicit user approval or propose_memory instead.",
                protected_files: [getRelativePath(cachedTargetPath)],
              }),
            },
          ],
        };
      }

      if (action.edit) {
        const editFiles = action.edit.entries().map(([uri]) => uri.fsPath);
        if (anyMemoryProtectedPath(editFiles)) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  status: "rejected",
                  action: action.title,
                  reason:
                    "Code action edits a protected instructions/memory file. Use write_file/apply_diff with explicit user approval or propose_memory instead.",
                  protected_files: editFiles
                    .filter((filePath) => anyMemoryProtectedPath([filePath]))
                    .map((filePath) => getRelativePath(filePath)),
                }),
              },
            ],
          };
        }

        const success = await vscode.workspace.applyEdit(action.edit);
        if (!success) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: "Failed to apply workspace edit",
                  action: action.title,
                }),
              },
            ],
          };
        }

        for (const [uri] of action.edit.entries()) {
          changedFiles.push(getRelativePath(uri.fsPath));
          const doc = vscode.workspace.textDocuments.find(
            (d) => d.uri.fsPath === uri.fsPath,
          );
          if (doc?.isDirty) {
            await doc.save();
          }
        }
      }

      if (action.command) {
        await vscode.commands.executeCommand(
          action.command.command,
          ...(action.command.arguments ?? []),
        );
      }

      clearCachedCodeActions(params.sessionId);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "applied",
              action: action.title,
              kind: action.kind?.value,
              ...(changedFiles.length > 0 && { changed_files: changedFiles }),
            }),
          },
        ],
      };
    },
  };
}

export function createVscodeHierarchyProvider(
  approvalManager: ApprovalManager,
  approvalPanel: ApprovalPanelProvider,
): LanguageHierarchyProvider {
  return {
    getCallHierarchy(params) {
      return executeCallHierarchyProvider(
        params,
        approvalManager,
        approvalPanel,
      );
    },
    getTypeHierarchy(params) {
      return executeTypeHierarchyProvider(
        params,
        approvalManager,
        approvalPanel,
      );
    },
  };
}

export function createVscodeInlayHintsProvider(
  approvalManager: ApprovalManager,
  approvalPanel: ApprovalPanelProvider,
): LanguageInlayHintsProvider {
  return {
    async getInlayHints(params) {
      const { uri, document } = await resolveAndOpenDocument(
        params.path,
        approvalManager,
        approvalPanel,
        params.sessionId,
      );

      // Inlay hint providers may require the document to be visible in an editor.
      await vscode.window.showTextDocument(
        document,
        withPrimaryEditorColumn({
          preserveFocus: true,
          preview: true,
        }),
      );

      const startLine = Math.max(0, (params.start_line ?? 1) - 1);
      const endLine = Math.min(
        document.lineCount,
        params.end_line ?? document.lineCount,
      );
      const range = new vscode.Range(
        new vscode.Position(startLine, 0),
        new vscode.Position(endLine, 0),
      );

      const hints = await vscode.commands.executeCommand<vscode.InlayHint[]>(
        "vscode.executeInlayHintProvider",
        uri,
        range,
      );

      if (!hints || hints.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                hints: [],
                message: "No inlay hints in this range",
              }),
            },
          ],
        };
      }

      const serialized = hints.map((hint) => {
        const result: Record<string, unknown> = {
          line: hint.position.line + 1,
          column: hint.position.character + 1,
          label: extractInlayHintLabel(hint.label),
        };
        if (hint.kind !== undefined) {
          result.kind = INLAY_HINT_KIND_NAMES[hint.kind] ?? "unknown";
        }
        if (hint.paddingLeft) result.padding_left = true;
        if (hint.paddingRight) result.padding_right = true;
        return result;
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ hints: serialized }, null, 2),
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

async function executeCallHierarchyProvider(
  params: LanguageHierarchyParams,
  approvalManager: ApprovalManager,
  approvalPanel: ApprovalPanelProvider,
) {
  const { uri } = await resolveAndOpenDocument(
    params.path,
    approvalManager,
    approvalPanel,
    params.sessionId,
  );
  const position = toPosition(params.line, params.column);

  const items = await vscode.commands.executeCommand<
    vscode.CallHierarchyItem[]
  >("vscode.prepareCallHierarchy", uri, position);

  if (!items || items.length === 0) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            message: "No call hierarchy available at this position",
          }),
        },
      ],
    };
  }

  const item = items[0];
  const result: Record<string, unknown> = {
    symbol: serializeHierarchyItem(item),
  };

  const maxDepth = Math.min(params.max_depth ?? 1, 3);
  const direction = params.direction ?? "both";

  if (direction === "incoming" || direction === "both") {
    result.incoming = await getIncomingCalls(item, maxDepth, 1);
  }

  if (direction === "outgoing" || direction === "both") {
    result.outgoing = await getOutgoingCalls(item, maxDepth, 1);
  }

  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
  };
}

async function executeTypeHierarchyProvider(
  params: LanguageHierarchyParams,
  approvalManager: ApprovalManager,
  approvalPanel: ApprovalPanelProvider,
) {
  const { uri } = await resolveAndOpenDocument(
    params.path,
    approvalManager,
    approvalPanel,
    params.sessionId,
  );
  const position = toPosition(params.line, params.column);

  const items = await vscode.commands.executeCommand<
    vscode.TypeHierarchyItem[]
  >("vscode.prepareTypeHierarchy", uri, position);

  if (!items || items.length === 0) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            message: "No type hierarchy available at this position",
          }),
        },
      ],
    };
  }

  const item = items[0];
  const result: Record<string, unknown> = {
    symbol: serializeHierarchyItem(item),
  };

  const maxDepth = Math.min(params.max_depth ?? 2, 5);
  const direction = params.direction ?? "both";

  if (direction === "supertypes" || direction === "both") {
    result.supertypes = await getSupertypes(item, maxDepth, 1);
  }

  if (direction === "subtypes" || direction === "both") {
    result.subtypes = await getSubtypes(item, maxDepth, 1);
  }

  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
  };
}

async function getIncomingCalls(
  item: vscode.CallHierarchyItem,
  maxDepth: number,
  currentDepth: number,
): Promise<unknown[]> {
  const calls = await vscode.commands.executeCommand<
    vscode.CallHierarchyIncomingCall[]
  >("vscode.provideIncomingCalls", item);

  if (!calls || calls.length === 0) return [];

  const results: unknown[] = [];
  for (const call of calls) {
    const entry: Record<string, unknown> = {
      from: serializeHierarchyItem(call.from),
      call_sites: call.fromRanges.map((r) => ({
        line: r.start.line + 1,
        column: r.start.character + 1,
      })),
    };

    if (currentDepth < maxDepth) {
      const nested = await getIncomingCalls(
        call.from,
        maxDepth,
        currentDepth + 1,
      );
      if (nested.length > 0) entry.incoming = nested;
    }

    results.push(entry);
  }
  return results;
}

async function getOutgoingCalls(
  item: vscode.CallHierarchyItem,
  maxDepth: number,
  currentDepth: number,
): Promise<unknown[]> {
  const calls = await vscode.commands.executeCommand<
    vscode.CallHierarchyOutgoingCall[]
  >("vscode.provideOutgoingCalls", item);

  if (!calls || calls.length === 0) return [];

  const results: unknown[] = [];
  for (const call of calls) {
    const entry: Record<string, unknown> = {
      to: serializeHierarchyItem(call.to),
      call_sites: call.fromRanges.map((r) => ({
        line: r.start.line + 1,
        column: r.start.character + 1,
      })),
    };

    if (currentDepth < maxDepth) {
      const nested = await getOutgoingCalls(
        call.to,
        maxDepth,
        currentDepth + 1,
      );
      if (nested.length > 0) entry.outgoing = nested;
    }

    results.push(entry);
  }
  return results;
}

async function getSupertypes(
  item: vscode.TypeHierarchyItem,
  maxDepth: number,
  currentDepth: number,
): Promise<unknown[]> {
  const supertypes = await vscode.commands.executeCommand<
    vscode.TypeHierarchyItem[]
  >("vscode.provideTypeHierarchySupertypes", item);

  if (!supertypes || supertypes.length === 0) return [];

  const results: unknown[] = [];
  for (const st of supertypes) {
    const entry: Record<string, unknown> = serializeHierarchyItem(st);

    if (currentDepth < maxDepth) {
      const nested = await getSupertypes(st, maxDepth, currentDepth + 1);
      if (nested.length > 0) entry.supertypes = nested;
    }

    results.push(entry);
  }
  return results;
}

async function getSubtypes(
  item: vscode.TypeHierarchyItem,
  maxDepth: number,
  currentDepth: number,
): Promise<unknown[]> {
  const subtypes = await vscode.commands.executeCommand<
    vscode.TypeHierarchyItem[]
  >("vscode.provideTypeHierarchySubtypes", item);

  if (!subtypes || subtypes.length === 0) return [];

  const results: unknown[] = [];
  for (const st of subtypes) {
    const entry: Record<string, unknown> = serializeHierarchyItem(st);

    if (currentDepth < maxDepth) {
      const nested = await getSubtypes(st, maxDepth, currentDepth + 1);
      if (nested.length > 0) entry.subtypes = nested;
    }

    results.push(entry);
  }
  return results;
}

function serializeHierarchyItem(
  item: vscode.CallHierarchyItem | vscode.TypeHierarchyItem,
): Record<string, unknown> {
  return {
    name: item.name,
    kind: SYMBOL_KIND_NAMES[item.kind] ?? "symbol",
    path: getRelativePath(item.uri.fsPath),
    line: item.selectionRange.start.line + 1,
    column: item.selectionRange.start.character + 1,
    ...(item.detail && { detail: item.detail }),
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

function extractInlayHintLabel(
  label: string | vscode.InlayHintLabelPart[],
): string {
  if (typeof label === "string") return label;
  return label.map((part) => part.value).join("");
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

const INLAY_HINT_KIND_NAMES: Record<number, string> = {
  [vscode.InlayHintKind.Type]: "type",
  [vscode.InlayHintKind.Parameter]: "parameter",
};

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
