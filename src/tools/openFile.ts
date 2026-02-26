import * as vscode from "vscode";

import { resolveAndValidatePath, getRelativePath } from "../util/paths.js";
import type { ApprovalManager } from "../approvals/ApprovalManager.js";
import type { ApprovalPanelProvider } from "../approvals/ApprovalPanelProvider.js";
import { approveOutsideWorkspaceAccess } from "./pathAccessUI.js";

type ToolResult = { content: Array<{ type: "text"; text: string }> };

export async function handleOpenFile(
  params: {
    path: string;
    line?: number;
    column?: number;
    end_line?: number;
    end_column?: number;
  },
  approvalManager: ApprovalManager,
  approvalPanel: ApprovalPanelProvider,
  sessionId: string,
): Promise<ToolResult> {
  try {
    const { absolutePath, inWorkspace } = resolveAndValidatePath(params.path);
    const relPath = getRelativePath(absolutePath);

    if (!inWorkspace && !approvalManager.isPathTrusted(sessionId, absolutePath)) {
      const { approved, reason } = await approveOutsideWorkspaceAccess(
        absolutePath,
        approvalManager,
        approvalPanel,
        sessionId,
      );
      if (!approved) {
        return {
          content: [{ type: "text", text: JSON.stringify({ status: "rejected", path: params.path, reason }) }],
        };
      }
    }

    const doc = await vscode.workspace.openTextDocument(absolutePath);
    const editor = await vscode.window.showTextDocument(doc, { preview: false });

    if (params.line) {
      const line = Math.max(0, params.line - 1);
      const col = Math.max(0, (params.column ?? 1) - 1);
      const startPos = new vscode.Position(line, col);

      if (params.end_line) {
        // Range selection — highlight the specified range
        const endLine = Math.max(0, params.end_line - 1);
        const endCol = Math.max(0, (params.end_column ?? 1) - 1);
        const endPos = new vscode.Position(endLine, endCol);
        editor.selection = new vscode.Selection(startPos, endPos);
        editor.revealRange(
          new vscode.Range(startPos, endPos),
          vscode.TextEditorRevealType.InCenterIfOutsideViewport,
        );
      } else {
        // Single position — cursor placement
        editor.selection = new vscode.Selection(startPos, startPos);
        editor.revealRange(
          new vscode.Range(startPos, startPos),
          vscode.TextEditorRevealType.InCenterIfOutsideViewport,
        );
      }
    }

    const response: Record<string, unknown> = { status: "opened", path: relPath };
    if (params.line) response.line = params.line;
    if (params.column) response.column = params.column;
    if (params.end_line) response.end_line = params.end_line;
    if (params.end_column) response.end_column = params.end_column;

    return {
      content: [{ type: "text", text: JSON.stringify(response) }],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: JSON.stringify({ error: message, path: params.path }) }],
    };
  }
}
