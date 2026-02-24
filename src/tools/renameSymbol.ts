import * as vscode from "vscode";

import { getRelativePath } from "../util/paths.js";
import type { ApprovalManager } from "../approvals/ApprovalManager.js";
import type { ApprovalPanelProvider } from "../approvals/ApprovalPanelProvider.js";
import { promptRejectionReason } from "../util/rejectionReason.js";
import { showApprovalAlert } from "../util/approvalAlert.js";
import { enqueueApproval } from "../util/quickPickQueue.js";
import {
  showWriteApprovalScopeChoice,
  showWritePatternEditor,
} from "./writeApprovalUI.js";
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

    if (!canAutoApprove) {
      const fileList = filesPreview.map((f) => `  ${f.path} (${f.changes} change${f.changes > 1 ? "s" : ""})`).join("\n");
      const summary = `${totalChanges} change${totalChanges > 1 ? "s" : ""} across ${entries.length} file${entries.length > 1 ? "s" : ""}`;

      // Wrap entire approval flow in the queue so concurrent approvals
      // don't collide (QP + follow-up scope/pattern + rejection reason).
      type RenameDecision = "accept" | "session" | "project" | "global" | "reject";
      const result = await enqueueApproval("Rename approval", async () => {
        type Item = vscode.QuickPickItem & { decision: RenameDecision };
        const items: Item[] = [
          { label: "$(check) Accept", description: "Apply this rename", decision: "accept", alwaysShow: true },
          { label: "$(check) For Session", description: "Auto-accept writes this session", decision: "session", alwaysShow: true },
          { label: "$(folder) For Project", description: "Auto-accept writes for this project", decision: "project", alwaysShow: true },
          { label: "$(globe) Always", description: "Auto-accept writes globally", decision: "global", alwaysShow: true },
          { label: "$(close) Reject", description: "Cancel this rename", decision: "reject", alwaysShow: true },
        ];

        const choice = await new Promise<RenameDecision>((resolve) => {
          const alert = showApprovalAlert("Rename approval required");
          const qp = vscode.window.createQuickPick<Item>();
          qp.title = `Rename "${oldName}" → "${params.new_name}"?`;
          qp.placeholder = `${summary}: ${fileList.replace(/\n/g, ", ")}`;
          qp.items = items;
          qp.activeItems = [];
          qp.ignoreFocusOut = true;

          let resolved = false;
          qp.onDidAccept(() => {
            const selected = qp.selectedItems[0];
            if (selected) {
              resolved = true;
              alert.dispose();
              resolve(selected.decision);
              qp.dispose();
            }
          });
          qp.onDidHide(() => {
            alert.dispose();
            if (!resolved) resolve("reject");
            qp.dispose();
          });
          qp.show();
          qp.activeItems = [];
        });

        if (choice === "reject") {
          const reason = await promptRejectionReason();
          return { choice, reason };
        }

        // Handle scope-based approval (follow-up dialogs stay inside queue slot)
        if (choice === "session" || choice === "project" || choice === "global") {
          const scope: "session" | "project" | "global" = choice;

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

        return { choice };
      });

      if (result.choice === "reject") {
        return {
          content: [{ type: "text", text: JSON.stringify({ status: "rejected", old_name: oldName, new_name: params.new_name, reason: result.reason }) }],
        };
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
