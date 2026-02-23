import * as vscode from "vscode";

import { resolveAndValidatePath, getRelativePath } from "../util/paths.js";
import type { ApprovalManager } from "../approvals/ApprovalManager.js";
import { approveOutsideWorkspaceAccess } from "./pathAccessUI.js";

// --- Types ---

type ToolResult = { content: Array<{ type: "text"; text: string }> };

export interface ResolvedDocument {
  uri: vscode.Uri;
  document: vscode.TextDocument;
  absolutePath: string;
  relPath: string;
}

// --- Shared helpers ---

/**
 * Resolve a path, gate outside-workspace access, and open the document.
 * Throws a `ToolResult` (via rejection) if the user denies access.
 */
export async function resolveAndOpenDocument(
  inputPath: string,
  approvalManager: ApprovalManager,
  sessionId: string,
): Promise<ResolvedDocument> {
  const { absolutePath, inWorkspace } = resolveAndValidatePath(inputPath);
  const relPath = getRelativePath(absolutePath);

  if (!inWorkspace && !approvalManager.isPathTrusted(sessionId, absolutePath)) {
    const { approved, reason } = await approveOutsideWorkspaceAccess(
      absolutePath,
      approvalManager,
      sessionId,
    );
    if (!approved) {
      const result: ToolResult = {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "rejected",
              path: inputPath,
              reason,
            }),
          },
        ],
      };
      throw result;
    }
  }

  const uri = vscode.Uri.file(absolutePath);
  const document = await vscode.workspace.openTextDocument(uri);
  return { uri, document, absolutePath, relPath };
}

/** Convert 1-indexed line/column to 0-indexed vscode.Position */
export function toPosition(line: number, column: number): vscode.Position {
  return new vscode.Position(Math.max(0, line - 1), Math.max(0, column - 1));
}

/** Serialize a vscode.Location to a plain object with 1-indexed positions and relative path */
export function serializeLocation(loc: vscode.Location): {
  path: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
} {
  return {
    path: getRelativePath(loc.uri.fsPath),
    line: loc.range.start.line + 1,
    column: loc.range.start.character + 1,
    endLine: loc.range.end.line + 1,
    endColumn: loc.range.end.character + 1,
  };
}

// --- Symbol kind names ---

export const SYMBOL_KIND_NAMES: Record<number, string> = {
  [vscode.SymbolKind.File]: "file",
  [vscode.SymbolKind.Module]: "module",
  [vscode.SymbolKind.Namespace]: "namespace",
  [vscode.SymbolKind.Package]: "package",
  [vscode.SymbolKind.Class]: "class",
  [vscode.SymbolKind.Method]: "method",
  [vscode.SymbolKind.Property]: "property",
  [vscode.SymbolKind.Field]: "field",
  [vscode.SymbolKind.Constructor]: "constructor",
  [vscode.SymbolKind.Enum]: "enum",
  [vscode.SymbolKind.Interface]: "interface",
  [vscode.SymbolKind.Function]: "function",
  [vscode.SymbolKind.Variable]: "variable",
  [vscode.SymbolKind.Constant]: "constant",
  [vscode.SymbolKind.String]: "string",
  [vscode.SymbolKind.Number]: "number",
  [vscode.SymbolKind.Boolean]: "boolean",
  [vscode.SymbolKind.Array]: "array",
  [vscode.SymbolKind.Object]: "object",
  [vscode.SymbolKind.Key]: "key",
  [vscode.SymbolKind.Null]: "null",
  [vscode.SymbolKind.EnumMember]: "enum member",
  [vscode.SymbolKind.Struct]: "struct",
  [vscode.SymbolKind.Event]: "event",
  [vscode.SymbolKind.Operator]: "operator",
  [vscode.SymbolKind.TypeParameter]: "type parameter",
};

// --- Completion item kind names ---

export const COMPLETION_KIND_NAMES: Record<number, string> = {
  [vscode.CompletionItemKind.Text]: "text",
  [vscode.CompletionItemKind.Method]: "method",
  [vscode.CompletionItemKind.Function]: "function",
  [vscode.CompletionItemKind.Constructor]: "constructor",
  [vscode.CompletionItemKind.Field]: "field",
  [vscode.CompletionItemKind.Variable]: "variable",
  [vscode.CompletionItemKind.Class]: "class",
  [vscode.CompletionItemKind.Interface]: "interface",
  [vscode.CompletionItemKind.Module]: "module",
  [vscode.CompletionItemKind.Property]: "property",
  [vscode.CompletionItemKind.Unit]: "unit",
  [vscode.CompletionItemKind.Value]: "value",
  [vscode.CompletionItemKind.Enum]: "enum",
  [vscode.CompletionItemKind.Keyword]: "keyword",
  [vscode.CompletionItemKind.Snippet]: "snippet",
  [vscode.CompletionItemKind.Color]: "color",
  [vscode.CompletionItemKind.File]: "file",
  [vscode.CompletionItemKind.Reference]: "reference",
  [vscode.CompletionItemKind.Folder]: "folder",
  [vscode.CompletionItemKind.EnumMember]: "enum member",
  [vscode.CompletionItemKind.Constant]: "constant",
  [vscode.CompletionItemKind.Struct]: "struct",
  [vscode.CompletionItemKind.Event]: "event",
  [vscode.CompletionItemKind.Operator]: "operator",
  [vscode.CompletionItemKind.TypeParameter]: "type parameter",
};

/** Extract text from a hover content item */
export function extractHoverContent(
  content: vscode.MarkedString | vscode.MarkdownString,
): string {
  if (typeof content === "string") return content;
  if (content instanceof vscode.MarkdownString) return content.value;
  // { language, value } form (deprecated MarkedString)
  if ("language" in content && "value" in content) {
    return `\`\`\`${content.language}\n${content.value}\n\`\`\``;
  }
  return String(content);
}
