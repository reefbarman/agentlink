import * as vscode from "vscode";

import type { ApprovalManager } from "../approvals/ApprovalManager.js";
import type { ApprovalPanelProvider } from "../approvals/ApprovalPanelProvider.js";
import { resolveAndOpenDocument, toPosition, extractHoverContent } from "./languageFeatures.js";

type ToolResult = { content: Array<{ type: "text"; text: string }> };

export async function handleGetHover(
  params: { path: string; line: number; column: number },
  approvalManager: ApprovalManager,
  approvalPanel: ApprovalPanelProvider,
  sessionId: string,
): Promise<ToolResult> {
  try {
    const { uri } = await resolveAndOpenDocument(params.path, approvalManager, approvalPanel, sessionId);
    const position = toPosition(params.line, params.column);

    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      "vscode.executeHoverProvider",
      uri,
      position,
    );

    if (!hovers || hovers.length === 0) {
      return {
        content: [{ type: "text", text: JSON.stringify({ hover: null, message: "No hover information available at this position" }) }],
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
      content: [{ type: "text", text: JSON.stringify({ hover: parts.join("\n---\n") || null }) }],
    };
  } catch (err) {
    // Rejection from resolveAndOpenDocument
    if (typeof err === "object" && err !== null && "content" in err) {
      return err as ToolResult;
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: JSON.stringify({ error: message, path: params.path }) }],
    };
  }
}
