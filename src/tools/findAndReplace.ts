import * as vscode from "vscode";
import * as path from "path";

import {
  resolveAndValidatePath,
  getFirstWorkspaceRoot,
  getRelativePath,
} from "../util/paths.js";
import type { ApprovalManager } from "../approvals/ApprovalManager.js";
import type { ApprovalPanelProvider } from "../approvals/ApprovalPanelProvider.js";
import { decisionToScope, applyInlineTrustScope } from "./writeApprovalUI.js";

type ToolResult = { content: Array<{ type: "text"; text: string }> };

export async function handleFindAndReplace(
  params: {
    find: string;
    replace: string;
    path?: string;
    glob?: string;
    regex?: boolean;
  },
  approvalManager: ApprovalManager,
  approvalPanel: ApprovalPanelProvider,
  sessionId: string,
): Promise<ToolResult> {
  try {
    const workspaceRoot = getFirstWorkspaceRoot();
    const findStr = params.find;
    const replaceStr = params.replace;

    if (!findStr) {
      return error("'find' parameter is required");
    }

    // Build the search pattern
    let pattern: RegExp;
    if (params.regex) {
      try {
        pattern = new RegExp(findStr, "g");
      } catch (e) {
        return error(`Invalid regex: ${e instanceof Error ? e.message : e}`);
      }
    } else {
      // Escape special regex characters for literal search
      const escaped = findStr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      pattern = new RegExp(escaped, "g");
    }

    // Resolve target files
    let fileUris: vscode.Uri[];

    if (params.path) {
      const { absolutePath } = resolveAndValidatePath(params.path);
      fileUris = [vscode.Uri.file(absolutePath)];
    } else if (params.glob) {
      // Use VS Code's file finder with the glob pattern
      const relGlob = new vscode.RelativePattern(workspaceRoot, params.glob);
      fileUris = await vscode.workspace.findFiles(relGlob, "**/node_modules/**", 500);
      if (fileUris.length === 0) {
        return error(`No files matched glob pattern: ${params.glob}`);
      }
    } else {
      return error("Either 'path' or 'glob' must be specified");
    }

    // Find all occurrences and build WorkspaceEdit
    const edit = new vscode.WorkspaceEdit();
    const filesPreview: Array<{ path: string; changes: number }> = [];
    let totalChanges = 0;

    for (const uri of fileUris) {
      let doc: vscode.TextDocument;
      try {
        doc = await vscode.workspace.openTextDocument(uri);
      } catch {
        continue; // Skip files that can't be opened (binary, etc.)
      }

      const text = doc.getText();
      const replacements: Array<{ range: vscode.Range; newText: string }> = [];

      // Reset regex lastIndex for each file
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;

      while ((match = pattern.exec(text)) !== null) {
        const startPos = doc.positionAt(match.index);
        const endPos = doc.positionAt(match.index + match[0].length);
        const range = new vscode.Range(startPos, endPos);

        // For regex, support capture group references ($1, $2, etc.)
        const newText = params.regex
          ? match[0].replace(pattern, replaceStr)
          : replaceStr;

        // Reset pattern since we used it for the replacement
        if (params.regex) {
          pattern.lastIndex = match.index + match[0].length;
        }

        replacements.push({ range, newText });
      }

      if (replacements.length > 0) {
        for (const r of replacements) {
          edit.replace(uri, r.range, r.newText);
        }
        totalChanges += replacements.length;
        filesPreview.push({
          path: getRelativePath(uri.fsPath),
          changes: replacements.length,
        });
      }
    }

    if (totalChanges === 0) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "no_matches",
              find: findStr,
              files_searched: fileUris.length,
            }),
          },
        ],
      };
    }

    // Check write approval
    const masterBypass = vscode.workspace
      .getConfiguration("native-claude")
      .get<boolean>("masterBypass", false);

    const canAutoApprove =
      masterBypass || approvalManager.isWriteApproved(sessionId);
    let followUp: string | undefined;

    if (!canAutoApprove) {
      // Reuse the rename approval UI — it already shows old→new with affected files
      const { promise } = approvalPanel.enqueueRenameApproval(
        findStr,
        replaceStr,
        filesPreview,
        totalChanges,
      );

      const response = await promise;
      followUp = response.followUp;

      if (response.decision === "reject") {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "rejected",
                find: findStr,
                replace: replaceStr,
                reason: response.rejectionReason,
              }),
            },
          ],
        };
      }

      // Save trust rules
      const scope = decisionToScope(response.decision);
      if (scope && response.trustScope) {
        // For multi-file, use the first file as the representative path
        const repPath =
          filesPreview.length > 0 ? filesPreview[0].path : "find-and-replace";
        applyInlineTrustScope(response, approvalManager, sessionId, scope, repPath);
      }
    }

    // Apply the edit
    const applied = await vscode.workspace.applyEdit(edit);

    if (!applied) {
      return error("Failed to apply replacements");
    }

    // Save all affected documents
    for (const uri of fileUris) {
      const doc = vscode.workspace.textDocuments.find(
        (d) => d.uri.fsPath === uri.fsPath,
      );
      if (doc?.isDirty) {
        await doc.save();
      }
    }

    const result: Record<string, unknown> = {
      status: "applied",
      find: findStr,
      replace: replaceStr,
      files_changed: filesPreview.length,
      total_replacements: totalChanges,
      files: filesPreview,
    };
    if (followUp) {
      result.follow_up = followUp;
    }

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    if (typeof err === "object" && err !== null && "content" in err) {
      return err as ToolResult;
    }
    const message = err instanceof Error ? err.message : String(err);
    return error(message);
  }
}

function error(message: string): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: message }) }],
  };
}
