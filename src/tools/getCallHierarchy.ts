import * as vscode from "vscode";

import type { ApprovalManager } from "../approvals/ApprovalManager.js";
import type { ApprovalPanelProvider } from "../approvals/ApprovalPanelProvider.js";
import { resolveAndOpenDocument, toPosition, SYMBOL_KIND_NAMES } from "./languageFeatures.js";
import { getRelativePath } from "../util/paths.js";

type ToolResult = { content: Array<{ type: "text"; text: string }> };

function serializeHierarchyItem(item: vscode.CallHierarchyItem): Record<string, unknown> {
  return {
    name: item.name,
    kind: SYMBOL_KIND_NAMES[item.kind] ?? "symbol",
    path: getRelativePath(item.uri.fsPath),
    line: item.selectionRange.start.line + 1,
    column: item.selectionRange.start.character + 1,
    ...(item.detail && { detail: item.detail }),
  };
}

export async function handleGetCallHierarchy(
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

    // Prepare call hierarchy
    const items = await vscode.commands.executeCommand<vscode.CallHierarchyItem[]>(
      "vscode.prepareCallHierarchy",
      uri,
      position,
    );

    if (!items || items.length === 0) {
      return {
        content: [{ type: "text", text: JSON.stringify({
          message: "No call hierarchy available at this position",
        }) }],
      };
    }

    const item = items[0]; // Use the first item
    const result: Record<string, unknown> = {
      symbol: serializeHierarchyItem(item),
    };

    const maxDepth = Math.min(params.max_depth ?? 1, 3); // Cap at 3 to prevent explosion
    const direction = params.direction ?? "both";

    if (direction === "incoming" || direction === "both") {
      result.incoming = await getIncomingCalls(item, maxDepth, 1);
    }

    if (direction === "outgoing" || direction === "both") {
      result.outgoing = await getOutgoingCalls(item, maxDepth, 1);
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

async function getIncomingCalls(
  item: vscode.CallHierarchyItem,
  maxDepth: number,
  currentDepth: number,
): Promise<unknown[]> {
  const calls = await vscode.commands.executeCommand<vscode.CallHierarchyIncomingCall[]>(
    "vscode.provideIncomingCalls",
    item,
  );

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
      const nested = await getIncomingCalls(call.from, maxDepth, currentDepth + 1);
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
  const calls = await vscode.commands.executeCommand<vscode.CallHierarchyOutgoingCall[]>(
    "vscode.provideOutgoingCalls",
    item,
  );

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
      const nested = await getOutgoingCalls(call.to, maxDepth, currentDepth + 1);
      if (nested.length > 0) entry.outgoing = nested;
    }

    results.push(entry);
  }
  return results;
}
