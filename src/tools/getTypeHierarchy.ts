import * as vscode from "vscode";

import type { ApprovalManager } from "../approvals/ApprovalManager.js";
import type { ApprovalPanelProvider } from "../approvals/ApprovalPanelProvider.js";
import { resolveAndOpenDocument, toPosition, SYMBOL_KIND_NAMES } from "./languageFeatures.js";
import { getRelativePath } from "../util/paths.js";

type ToolResult = { content: Array<{ type: "text"; text: string }> };

function serializeTypeItem(item: vscode.TypeHierarchyItem): Record<string, unknown> {
  return {
    name: item.name,
    kind: SYMBOL_KIND_NAMES[item.kind] ?? "symbol",
    path: getRelativePath(item.uri.fsPath),
    line: item.selectionRange.start.line + 1,
    column: item.selectionRange.start.character + 1,
    ...(item.detail && { detail: item.detail }),
  };
}

export async function handleGetTypeHierarchy(
  params: {
    path: string;
    line: number;
    column: number;
    direction: string;
    max_depth?: number;
  },
  approvalManager: ApprovalManager,
  approvalPanel: ApprovalPanelProvider,
  sessionId: string,
): Promise<ToolResult> {
  try {
    const { uri } = await resolveAndOpenDocument(
      params.path, approvalManager, approvalPanel, sessionId,
    );
    const position = toPosition(params.line, params.column);

    const items = await vscode.commands.executeCommand<vscode.TypeHierarchyItem[]>(
      "vscode.prepareTypeHierarchy",
      uri,
      position,
    );

    if (!items || items.length === 0) {
      return {
        content: [{ type: "text", text: JSON.stringify({
          message: "No type hierarchy available at this position",
        }) }],
      };
    }

    const item = items[0];
    const result: Record<string, unknown> = {
      symbol: serializeTypeItem(item),
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
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    if (typeof err === "object" && err !== null && "content" in err) {
      return err as ToolResult;
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: JSON.stringify({ error: message, path: params.path }) }],
    };
  }
}

async function getSupertypes(
  item: vscode.TypeHierarchyItem,
  maxDepth: number,
  currentDepth: number,
): Promise<unknown[]> {
  const supertypes = await vscode.commands.executeCommand<vscode.TypeHierarchyItem[]>(
    "vscode.provideTypeHierarchySupertypes",
    item,
  );

  if (!supertypes || supertypes.length === 0) return [];

  const results: unknown[] = [];
  for (const st of supertypes) {
    const entry: Record<string, unknown> = serializeTypeItem(st);

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
  const subtypes = await vscode.commands.executeCommand<vscode.TypeHierarchyItem[]>(
    "vscode.provideTypeHierarchySubtypes",
    item,
  );

  if (!subtypes || subtypes.length === 0) return [];

  const results: unknown[] = [];
  for (const st of subtypes) {
    const entry: Record<string, unknown> = serializeTypeItem(st);

    if (currentDepth < maxDepth) {
      const nested = await getSubtypes(st, maxDepth, currentDepth + 1);
      if (nested.length > 0) entry.subtypes = nested;
    }

    results.push(entry);
  }
  return results;
}
