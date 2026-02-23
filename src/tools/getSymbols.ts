import * as vscode from "vscode";

import type { ApprovalManager } from "../approvals/ApprovalManager.js";
import { getRelativePath } from "../util/paths.js";
import { resolveAndOpenDocument, SYMBOL_KIND_NAMES } from "./languageFeatures.js";

type ToolResult = { content: Array<{ type: "text"; text: string }> };

const MAX_WORKSPACE_SYMBOLS = 100;

interface SerializedSymbol {
  name: string;
  kind: string;
  line: number;
  endLine: number;
  children: SerializedSymbol[];
}

function serializeDocumentSymbol(sym: vscode.DocumentSymbol): SerializedSymbol {
  return {
    name: sym.name,
    kind: SYMBOL_KIND_NAMES[sym.kind] ?? "symbol",
    line: sym.range.start.line + 1,
    endLine: sym.range.end.line + 1,
    children: sym.children.map(serializeDocumentSymbol),
  };
}

export async function handleGetSymbols(
  params: { path?: string; query?: string },
  approvalManager: ApprovalManager,
  sessionId: string,
): Promise<ToolResult> {
  try {
    if (!params.path && !params.query) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: "Either 'path' (for document symbols) or 'query' (for workspace symbol search) is required" }) }],
      };
    }

    // Document symbols mode
    if (params.path) {
      const { uri, relPath } = await resolveAndOpenDocument(params.path, approvalManager, sessionId);

      const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        "vscode.executeDocumentSymbolProvider",
        uri,
      );

      if (!symbols || symbols.length === 0) {
        return {
          content: [{ type: "text", text: JSON.stringify({ mode: "document", path: relPath, symbols: [] }) }],
        };
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            mode: "document",
            path: relPath,
            symbols: symbols.map(serializeDocumentSymbol),
          }),
        }],
      };
    }

    // Workspace symbols mode
    const query = params.query!;
    const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
      "vscode.executeWorkspaceSymbolProvider",
      query,
    );

    if (!symbols || symbols.length === 0) {
      return {
        content: [{ type: "text", text: JSON.stringify({ mode: "workspace", query, total: 0, symbols: [] }) }],
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
      content: [{
        type: "text",
        text: JSON.stringify({
          mode: "workspace",
          query,
          total,
          truncated: total > MAX_WORKSPACE_SYMBOLS,
          symbols: serialized,
        }),
      }],
    };
  } catch (err) {
    if (typeof err === "object" && err !== null && "content" in err) {
      return err as ToolResult;
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: JSON.stringify({ error: message }) }],
    };
  }
}
