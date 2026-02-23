import * as vscode from "vscode";

import { getRelativePath } from "../util/paths.js";
import type { ApprovalManager } from "../approvals/ApprovalManager.js";
import { promptRejectionReason } from "../util/rejectionReason.js";
import {
  showWriteApprovalScopeChoice,
  showWritePatternEditor,
} from "./writeApprovalUI.js";
import { resolveAndOpenDocument, toPosition } from "./languageFeatures.js";

type ToolResult = { content: Array<{ type: "text"; text: string }> };

export async function handleRenameSymbol(
  params: { path: string; line: number; column: number; new_name: string },
  approvalManager: ApprovalManager,
  sessionId: string,
): Promise<ToolResult> {
  try {
    const { uri, document, relPath } = await resolveAndOpenDocument(
      params.path,
      approvalManager,
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

    if (!canAutoApprove) {
      const fileList = filesPreview.map((f) => `  ${f.path} (${f.changes} change${f.changes > 1 ? "s" : ""})`).join("\n");

      const choice = await vscode.window.showWarningMessage(
        `Rename "${oldName}" → "${params.new_name}"?`,
        {
          modal: true,
          detail: `${totalChanges} change${totalChanges > 1 ? "s" : ""} across ${entries.length} file${entries.length > 1 ? "s" : ""}:\n${fileList}`,
        },
        "Accept",
        "For Session",
        "For Project",
        "Always",
      );

      if (!choice) {
        const reason = await promptRejectionReason();
        return {
          content: [{ type: "text", text: JSON.stringify({ status: "rejected", old_name: oldName, new_name: params.new_name, reason }) }],
        };
      }

      // Handle scope-based approval
      if (choice === "For Session" || choice === "For Project" || choice === "Always") {
        const scope: "session" | "project" | "global" =
          choice === "For Session" ? "session" : choice === "For Project" ? "project" : "global";

        const scopeChoice = await showWriteApprovalScopeChoice(relPath);
        if (scopeChoice === "all-files") {
          approvalManager.setWriteApproval(sessionId, scope);
        } else if (scopeChoice === "this-file") {
          approvalManager.addWriteRule(
            sessionId,
            { pattern: relPath, mode: "exact" },
            scope,
          );
        } else if (scopeChoice === "pattern") {
          const rule = await showWritePatternEditor(relPath);
          if (rule) {
            approvalManager.addWriteRule(sessionId, rule, scope);
          }
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

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          status: "accepted",
          old_name: oldName,
          new_name: params.new_name,
          files_modified: filesPreview,
          total_changes: totalChanges,
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
