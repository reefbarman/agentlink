import * as vscode from "vscode";

import { getRelativePath } from "../util/paths.js";
import type { ApprovalManager } from "../approvals/ApprovalManager.js";
import type { ApprovalPanelProvider } from "../approvals/ApprovalPanelProvider.js";
import { resolveAndOpenDocument, toPosition } from "./languageFeatures.js";

type ToolResult = { content: Array<{ type: "text"; text: string }> };

export async function handleRenameSymbol(
  params: { path: string; line: number; column: number; new_name: string },
  approvalManager: ApprovalManager,
  approvalPanel: ApprovalPanelProvider,
  sessionId: string,
): Promise<ToolResult> {
  try {
    const { uri, document, relPath } = await resolveAndOpenDocument(
      params.path,
      approvalManager,
      approvalPanel,
      sessionId,
    );
    const position = toPosition(params.line, params.column);

    // Get the old name for display
    const wordRange = document.getWordRangeAtPosition(position);
    const oldName = wordRange ? document.getText(wordRange) : `symbol at ${params.line}:${params.column}`;

    // Compute the rename edit
    const edit = await vscode.commands.executeCommand<vscode.WorkspaceEdit>(
      "vscode.executeDocumentRenameProvider",
      uri,
      position,
      params.new_name,
    );

    if (!edit) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: "Symbol at this position cannot be renamed", path: relPath, line: params.line, column: params.column }) }],
      };
    }

    // Build preview of affected files
    const entries = edit.entries();
    if (entries.length === 0) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: "Rename produced no changes", path: relPath }) }],
      };
    }

    const filesPreview: Array<{ path: string; changes: number }> = [];
    let totalChanges = 0;
    for (const [entryUri, edits] of entries) {
      const count = edits.length;
      totalChanges += count;
      filesPreview.push({ path: getRelativePath(entryUri.fsPath), changes: count });
    }

    // Check write approval
    const masterBypass = vscode.workspace
      .getConfiguration("native-claude")
      .get<boolean>("masterBypass", false);

    const canAutoApprove = masterBypass || approvalManager.isWriteApproved(sessionId);
    let renameFollowUp: string | undefined;

    if (!canAutoApprove) {
      const { promise } = approvalPanel.enqueueRenameApproval(
        oldName,
        params.new_name,
        filesPreview,
        totalChanges,
      );

      const response = await promise;
      renameFollowUp = response.followUp;

      if (response.decision === "reject") {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              status: "rejected",
              old_name: oldName,
              new_name: params.new_name,
              reason: response.rejectionReason,
            }),
          }],
        };
      }

      // Save trust rules for session/project/always decisions
      if (
        response.decision === "accept-session" ||
        response.decision === "accept-project" ||
        response.decision === "accept-always"
      ) {
        const scope: "session" | "project" | "global" =
          response.decision === "accept-session"
            ? "session"
            : response.decision === "accept-project"
              ? "project"
              : "global";

        if (response.trustScope === "all-files") {
          approvalManager.setWriteApproval(sessionId, scope);
        } else if (response.trustScope === "this-file") {
          approvalManager.addWriteRule(
            sessionId,
            { pattern: relPath, mode: "exact" },
            scope,
          );
        } else if (
          response.trustScope === "pattern" &&
          response.rulePattern &&
          response.ruleMode
        ) {
          approvalManager.addWriteRule(
            sessionId,
            { pattern: response.rulePattern, mode: response.ruleMode },
            scope,
          );
        }
      }
    }

    // Apply the rename
    const applied = await vscode.workspace.applyEdit(edit);

    if (!applied) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: "Failed to apply rename edit", path: relPath }) }],
      };
    }

    // Save all affected documents
    for (const [entryUri] of entries) {
      const doc = vscode.workspace.textDocuments.find(
        (d) => d.uri.fsPath === entryUri.fsPath,
      );
      if (doc?.isDirty) {
        await doc.save();
      }
    }

    const result: Record<string, unknown> = {
      status: "accepted",
      old_name: oldName,
      new_name: params.new_name,
      files_modified: filesPreview,
      total_changes: totalChanges,
    };
    if (renameFollowUp) {
      result.follow_up = renameFollowUp;
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify(result),
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
