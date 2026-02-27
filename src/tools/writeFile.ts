import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as path from "path";

import { resolveAndValidatePath, getRelativePath } from "../util/paths.js";
import {
  DiffViewProvider,
  withFileLock,
  snapshotDiagnostics,
} from "../integrations/DiffViewProvider.js";
import type { ApprovalManager } from "../approvals/ApprovalManager.js";
import type { ApprovalPanelProvider } from "../approvals/ApprovalPanelProvider.js";
import { decisionToScope, saveWriteTrustRules } from "./writeApprovalUI.js";

type ToolResult = { content: Array<{ type: "text"; text: string }> };

export async function handleWriteFile(
  params: { path: string; content: string },
  approvalManager: ApprovalManager,
  approvalPanel: ApprovalPanelProvider,
  sessionId: string,
): Promise<ToolResult> {
  try {
    const { absolutePath: filePath, inWorkspace } = resolveAndValidatePath(
      params.path,
    );
    const relPath = getRelativePath(filePath);

    // Note: for writes, the diff view acts as the approval gate for outside-workspace paths.
    // No separate path access prompt — that would be double-prompting. The PathRule is stored
    // as a side effect when the user clicks "For Session"/"Always" on the diff view.

    const diagnosticDelay = vscode.workspace
      .getConfiguration("agentlink")
      .get<number>("diagnosticDelay", 1500);

    const masterBypass = vscode.workspace
      .getConfiguration("agentlink")
      .get<boolean>("masterBypass", false);

    // Auto-approve check (includes recent single-use approvals within TTL)
    const canAutoApprove = inWorkspace
      ? masterBypass ||
        approvalManager.isWriteApproved(sessionId, filePath) ||
        approvalPanel.isRecentlyApproved("write", relPath)
      : approvalManager.isFileWriteApproved(sessionId, filePath) ||
        approvalPanel.isRecentlyApproved("write", relPath);

    if (canAutoApprove) {
      // Snapshot diagnostics before the write
      const snap = snapshotDiagnostics();

      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, params.content, "utf-8");

      // Open the file in VS Code so the user can see what was written
      const doc = await vscode.workspace.openTextDocument(filePath);
      await vscode.window.showTextDocument(doc, {
        preview: false,
        preserveFocus: true,
      });

      // Collect new diagnostics
      const newDiagnostics = await snap.collectNewErrors(
        filePath,
        diagnosticDelay,
      );

      const response: Record<string, unknown> = {
        status: "accepted",
        path: relPath,
        operation: "auto-approved",
      };
      if (newDiagnostics) {
        response.new_diagnostics = newDiagnostics;
      }

      return {
        content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
      };
    }

    // Use diff view with file lock
    const result = await withFileLock(filePath, async () => {
      const diffView = new DiffViewProvider(diagnosticDelay);

      await diffView.open(filePath, relPath, params.content, {
        outsideWorkspace: !inWorkspace,
      });
      const decision = await diffView.waitForUserDecision(approvalPanel);

      if (decision === "reject") {
        return await diffView.revertChanges(
          diffView.writeApprovalResponse?.rejectionReason,
        );
      }

      // Handle session/always acceptance — save rules.
      const scope = decisionToScope(decision);
      if (scope) {
        await saveWriteTrustRules({
          panelResponse: diffView.writeApprovalResponse,
          approvalManager,
          sessionId,
          scope,
          relPath,
          filePath,
          inWorkspace,
        });
      }

      return await diffView.saveChanges();
    });

    const { finalContent, ...response } = result;
    return {
      content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ error: message, path: params.path }),
        },
      ],
    };
  }
}
