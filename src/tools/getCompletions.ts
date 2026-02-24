import * as vscode from "vscode";

import type { ApprovalManager } from "../approvals/ApprovalManager.js";
import type { ApprovalPanelProvider } from "../approvals/ApprovalPanelProvider.js";
import { resolveAndOpenDocument, toPosition, COMPLETION_KIND_NAMES } from "./languageFeatures.js";

type ToolResult = { content: Array<{ type: "text"; text: string }> };

const DEFAULT_LIMIT = 50;
const MAX_DOC_LENGTH = 200;

function extractDocumentation(doc: string | vscode.MarkdownString | undefined): string | undefined {
  if (!doc) return undefined;
  const text = typeof doc === "string" ? doc : doc.value;
  if (!text) return undefined;
  return text.length > MAX_DOC_LENGTH ? text.slice(0, MAX_DOC_LENGTH) + "..." : text;
}

function extractInsertText(item: vscode.CompletionItem): string | undefined {
  if (!item.insertText) return undefined;
  const text = typeof item.insertText === "string" ? item.insertText : item.insertText.value;
  // Omit if same as label
  const label = typeof item.label === "string" ? item.label : item.label.label;
  return text === label ? undefined : text;
}

export async function handleGetCompletions(
  params: { path: string; line: number; column: number; limit?: number },
  approvalManager: ApprovalManager,
  approvalPanel: ApprovalPanelProvider,
  sessionId: string,
): Promise<ToolResult> {
  try {
    const { uri } = await resolveAndOpenDocument(params.path, approvalManager, approvalPanel, sessionId);
    const position = toPosition(params.line, params.column);
    const limit = params.limit ?? DEFAULT_LIMIT;

    const completionList = await vscode.commands.executeCommand<vscode.CompletionList>(
      "vscode.executeCompletionItemProvider",
      uri,
      position,
    );

    if (!completionList || completionList.items.length === 0) {
      return {
        content: [{ type: "text", text: JSON.stringify({ is_incomplete: false, total_items: 0, showing: 0, items: [] }) }],
      };
    }

    const total = completionList.items.length;
    const capped = completionList.items.slice(0, limit);

    const items = capped.map((item) => {
      const label = typeof item.label === "string"
        ? item.label
        : item.label.label;

      const result: Record<string, unknown> = { label };

      if (item.kind !== undefined) {
        result.kind = COMPLETION_KIND_NAMES[item.kind] ?? "unknown";
      }
      if (item.detail) result.detail = item.detail;

      const doc = extractDocumentation(item.documentation);
      if (doc) result.documentation = doc;

      const insertText = extractInsertText(item);
      if (insertText) result.insertText = insertText;

      return result;
    });

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          is_incomplete: completionList.isIncomplete,
          total_items: total,
          showing: capped.length,
          items,
        }),
      }],
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
