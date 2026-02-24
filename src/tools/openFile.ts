import * as vscode from "vscode";

import { resolveAndValidatePath, getRelativePath } from "../util/paths.js";
import type { ApprovalManager } from "../approvals/ApprovalManager.js";
import type { ApprovalPanelProvider } from "../approvals/ApprovalPanelProvider.js";
import { approveOutsideWorkspaceAccess } from "./pathAccessUI.js";

type ToolResult = { content: Array<{ type: "text"; text: string }> };

export async function handleOpenFile(
  params: { path: string; line?: number; column?: number },
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
      const pos = new vscode.Position(line, col);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(
        new vscode.Range(pos, pos),
        vscode.TextEditorRevealType.InCenterIfOutsideViewport,
      );
    }

    const response: Record<string, unknown> = { status: "opened", path: relPath };
    if (params.line) response.line = params.line;
    if (params.column) response.column = params.column;

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
