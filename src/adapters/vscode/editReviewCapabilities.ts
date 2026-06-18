import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";

import {
  DiffViewProvider,
  createFormatOnSaveReport,
  snapshotDiagnostics,
} from "../../integrations/DiffViewProvider.js";
import type {
  EditReviewDecision,
  EditReviewParams,
  EditReviewProvider,
  EditorRevealParams,
  EditorRevealProvider,
  MultiFileEditReviewParams,
  MultiFileEditReviewProvider,
  RenameSymbolParams,
  RenameSymbolProvider,
  WriteApprovalPolicyProvider,
  WriteApprovalQuery,
} from "../../core/capabilities/editReview.js";
import type {
  FindReplaceFileGroup,
  FindReplacePreviewData,
} from "../../findReplace/webview/types.js";
import {
  anyMemoryProtectedPath,
  isMemoryProtectedPath,
} from "../../approvals/protectedPaths.js";
import {
  decisionToScope,
  saveInlineWriteTrustRules,
  saveWriteTrustRules,
} from "../../tools/writeApprovalUI.js";

import type { ApprovalManager } from "../../approvals/ApprovalManager.js";
import type { ApprovalPanelProvider } from "../../approvals/ApprovalPanelProvider.js";
import { FindReplacePreviewPanel } from "../../findReplace/FindReplacePreviewPanel.js";
import type { WriteApprovalResponse } from "../../approvals/ApprovalPanelProvider.js";
import { approveOutsideWorkspaceAccess } from "../../tools/pathAccessUI.js";
import { getRelativePath } from "../../util/paths.js";
import { resolveAndValidatePath } from "../../util/paths.js";
import { withFileLock } from "../../util/fileLock.js";
import { withPrimaryEditorColumn } from "../../util/editorPlacement.js";

export function createVscodeEditorRevealProvider(): EditorRevealProvider {
  return {
    async reveal(params: EditorRevealParams) {
      const doc = await vscode.workspace.openTextDocument(params.absolutePath);
      const editor = await vscode.window.showTextDocument(
        doc,
        withPrimaryEditorColumn({ preview: false }),
      );

      if (params.line) {
        const line = Math.max(0, params.line - 1);
        const col = Math.max(0, (params.column ?? 1) - 1);
        const startPos = new vscode.Position(line, col);

        if (params.end_line) {
          const endLine = Math.max(0, params.end_line - 1);
          const endCol = Math.max(0, (params.end_column ?? 1) - 1);
          const endPos = new vscode.Position(endLine, endCol);
          editor.selection = new vscode.Selection(startPos, endPos);
          editor.revealRange(
            new vscode.Range(startPos, endPos),
            vscode.TextEditorRevealType.InCenterIfOutsideViewport,
          );
        } else {
          editor.selection = new vscode.Selection(startPos, startPos);
          editor.revealRange(
            new vscode.Range(startPos, startPos),
            vscode.TextEditorRevealType.InCenterIfOutsideViewport,
          );
        }
      }

      const response: Record<string, unknown> = {
        status: "opened",
        path: getRelativePath(params.absolutePath),
      };
      if (params.line) response.line = params.line;
      if (params.column) response.column = params.column;
      if (params.end_line) response.end_line = params.end_line;
      if (params.end_column) response.end_column = params.end_column;

      return {
        content: [{ type: "text", text: JSON.stringify(response) }],
      };
    },
  };
}

export function createVscodeEditReviewProvider(): EditReviewProvider {
  return {
    async reviewAndApply(params: EditReviewParams) {
      if (params.mode === "auto") {
        return await withFileLock(params.absolutePath, async () => {
          const snap = snapshotDiagnostics(params.absolutePath);

          await fs.mkdir(path.dirname(params.absolutePath), {
            recursive: true,
          });

          try {
            await fs.access(params.absolutePath);
          } catch {
            if (params.allowCreate === false) {
              return {
                error: "File not found",
                path: params.relativePath,
              };
            }
            await fs.writeFile(params.absolutePath, "", "utf-8");
          }

          let content = params.content;
          if (params.prepareContent) {
            let currentContent = "";
            try {
              currentContent = await fs.readFile(params.absolutePath, "utf-8");
            } catch {
              // Missing files are represented as empty content after the
              // allowCreate branch above, matching the write_file behavior.
            }
            const prepared = await params.prepareContent(currentContent);
            if (prepared.status === "abort") {
              return prepared.result;
            }
            content = prepared.content;
          }

          const doc = await vscode.workspace.openTextDocument(
            params.absolutePath,
          );
          await vscode.window.showTextDocument(
            doc,
            withPrimaryEditorColumn({
              preview: false,
              preserveFocus: true,
            }),
          );

          if (doc.getText() !== content) {
            const edit = new vscode.WorkspaceEdit();
            edit.replace(
              doc.uri,
              new vscode.Range(
                doc.positionAt(0),
                doc.positionAt(doc.getText().length),
              ),
              content,
            );
            const applied = await vscode.workspace.applyEdit(edit);
            if (!applied) {
              return {
                error: "File edit failed",
                path: params.relativePath,
                reason: "apply_edit_failed",
              };
            }
          }
          if (doc.isDirty) {
            const saved = await doc.save();
            if (!saved) {
              return {
                error: "File save failed",
                path: params.relativePath,
                reason: "save_failed",
              };
            }
          }
          const finalContent = await fs.readFile(params.absolutePath, "utf-8");
          const newDiagnostics = await snap.collectNewErrors(
            params.diagnosticDelay,
          );

          const response: Record<string, unknown> = {
            status: "accepted",
            path: params.relativePath,
            operation: params.operation ?? "auto-approved",
          };
          const formatOnSaveReport = createFormatOnSaveReport(
            params.relativePath,
            content,
            finalContent,
          );
          if (formatOnSaveReport) {
            Object.assign(response, formatOnSaveReport);
          }
          if (newDiagnostics) {
            response.new_diagnostics = newDiagnostics;
          }
          return response;
        });
      }

      return await withFileLock(params.absolutePath, async () => {
        let content = params.content;
        if (params.prepareContent) {
          let currentContent = "";
          try {
            currentContent = await fs.readFile(params.absolutePath, "utf-8");
          } catch {
            // Missing files are represented as empty content here for
            // symmetry with the auto path; callers that require existing
            // files should return an abort from prepareContent.
          }
          const prepared = await params.prepareContent(currentContent);
          if (prepared.status === "abort") {
            return prepared.result;
          }
          content = prepared.content;
        }

        const diffView = new DiffViewProvider(params.diagnosticDelay);

        await diffView.open(params.absolutePath, params.relativePath, content, {
          outsideWorkspace: params.outsideWorkspace,
        });
        const decision = (await diffView.waitForUserDecision(
          params.approvalPanel as ApprovalPanelProvider,
          params.onApprovalRequest,
          params.sessionId,
        )) as EditReviewDecision;

        if (decision === "reject") {
          return {
            ...(await diffView.revertChanges(
              diffView.writeApprovalResponse?.rejectionReason,
            )),
            decision,
            writeApprovalResponse: diffView.writeApprovalResponse,
          };
        }

        return {
          ...(await diffView.saveChanges()),
          decision,
          writeApprovalResponse: diffView.writeApprovalResponse,
        };
      });
    },
  };
}

export function createVscodeMultiFileEditReviewProvider(
  approvalManager: ApprovalManager,
  extensionUri: vscode.Uri,
): MultiFileEditReviewProvider {
  return {
    async reviewAndApply(params: MultiFileEditReviewParams) {
      let previewPanel: FindReplacePreviewPanel | undefined;
      try {
        const fileGroups: FindReplaceFileGroup[] = params.files.map((file) => ({
          path: file.relativePath,
          matches: file.matches,
        }));
        const filesPreview = params.files.map((file) => ({
          path: file.relativePath,
          changes: file.replacements.length,
        }));

        const masterBypass = vscode.workspace
          .getConfiguration("agentlink")
          .get<boolean>("masterBypass", false);
        const touchesProtectedMemoryPath = anyMemoryProtectedPath(
          params.files.map((file) => file.absolutePath),
        );
        const canAutoApprove =
          !touchesProtectedMemoryPath &&
          (masterBypass ||
            params.files.every((file) =>
              approvalManager.isAgentWriteApproved(
                params.sessionId,
                file.absolutePath,
              ),
            ));

        let followUp: string | undefined;
        let acceptedIds: Set<string> | undefined;

        if (!canAutoApprove) {
          previewPanel = new FindReplacePreviewPanel(extensionUri);
          const previewData: FindReplacePreviewData = {
            findText: params.find,
            replaceText: params.replace,
            isRegex: params.isRegex,
            fileGroups,
            totalMatches: params.totalMatches,
          };
          previewPanel.show(previewData);

          if (params.onApprovalRequest) {
            const filesDetail = filesPreview
              .map(
                (file) =>
                  `${file.path} (${file.changes} change${file.changes !== 1 ? "s" : ""})`,
              )
              .join("\n");
            const approvalResponse = await params.onApprovalRequest(
              {
                kind: "rename",
                title: `Replace \`${params.find}\` → \`${params.replace}\`?`,
                detail: `${params.totalMatches} match${params.totalMatches !== 1 ? "es" : ""} across ${filesPreview.length} file${filesPreview.length !== 1 ? "s" : ""}:\n${filesDetail}`,
                choices: [
                  { label: "Accept all", value: "accept", isPrimary: true },
                  { label: "Reject", value: "reject", isDanger: true },
                ],
              },
              params.sessionId,
            );
            const decision =
              typeof approvalResponse === "string"
                ? approvalResponse
                : approvalResponse.decision;
            followUp =
              typeof approvalResponse === "string"
                ? undefined
                : approvalResponse.followUp;
            const rejectionReason =
              typeof approvalResponse === "string"
                ? undefined
                : approvalResponse.rejectionReason;
            if (decision === "reject") {
              return {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      status: "rejected_by_user",
                      find: params.find,
                      replace: params.replace,
                      ...(rejectionReason ? { reason: rejectionReason } : {}),
                      ...(followUp ? { follow_up: followUp } : {}),
                    }),
                  },
                ],
              };
            }
            saveInlineWriteTrustRules({
              response: approvalResponse,
              approvalManager,
              sessionId: params.sessionId,
              relPath:
                filesPreview.length > 0
                  ? filesPreview[0].path
                  : "find-and-replace",
            });
            acceptedIds = previewPanel.getAcceptedMatchIds();
          } else {
            const approvalPanel = params.approvalPanel as ApprovalPanelProvider;
            const { promise } = approvalPanel.enqueueRenameApproval(
              params.find,
              params.replace,
              filesPreview,
              params.totalMatches,
            );

            const response = await promise;
            followUp = response.followUp;

            if (response.decision === "reject") {
              return {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      status: "rejected_by_user",
                      find: params.find,
                      replace: params.replace,
                      reason: response.rejectionReason,
                    }),
                  },
                ],
              };
            }

            acceptedIds = previewPanel.getAcceptedMatchIds();
            saveWriteTrustRules({
              panelResponse: response,
              approvalManager,
              sessionId: params.sessionId,
              relPath:
                filesPreview.length > 0
                  ? filesPreview[0].path
                  : "find-and-replace",
              inWorkspace: true,
            });
          }
          previewPanel.close();
          previewPanel = undefined;
        }

        const edit = new vscode.WorkspaceEdit();
        let appliedCount = 0;
        const appliedFiles: Array<{ path: string; changes: number }> = [];

        for (const file of params.files) {
          const uri = vscode.Uri.file(file.absolutePath);
          const doc = await vscode.workspace.openTextDocument(uri);
          let fileChanges = 0;
          for (const replacement of file.replacements) {
            if (!acceptedIds || acceptedIds.has(replacement.matchId)) {
              edit.replace(
                uri,
                new vscode.Range(
                  doc.positionAt(replacement.startOffset),
                  doc.positionAt(replacement.endOffset),
                ),
                replacement.newText,
              );
              fileChanges++;
            }
          }
          if (fileChanges > 0) {
            appliedCount += fileChanges;
            appliedFiles.push({
              path: file.relativePath,
              changes: fileChanges,
            });
          }
        }

        if (appliedCount === 0) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  status: "no_changes",
                  find: params.find,
                  replace: params.replace,
                  message: "All matches were excluded by user",
                }),
              },
            ],
          };
        }

        const applied = await vscode.workspace.applyEdit(edit);
        if (!applied) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ error: "Failed to apply replacements" }),
              },
            ],
          };
        }

        for (const file of params.files) {
          const doc = vscode.workspace.textDocuments.find(
            (document) => document.uri.fsPath === file.absolutePath,
          );
          if (doc?.isDirty) {
            await doc.save();
          }
        }

        const result: Record<string, unknown> = {
          status: "applied",
          find: params.find,
          replace: params.replace,
          files_changed: appliedFiles.length,
          total_replacements: appliedCount,
          files: appliedFiles,
        };
        if (acceptedIds && appliedCount < params.totalMatches) {
          result.excluded = params.totalMatches - appliedCount;
        }
        if (followUp) {
          result.follow_up = followUp;
        }

        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } finally {
        previewPanel?.close();
      }
    },
  };
}

export function createVscodeRenameSymbolProvider(
  approvalManager: ApprovalManager,
): RenameSymbolProvider {
  return {
    async rename(params: RenameSymbolParams) {
      const { absolutePath, inWorkspace } = resolveAndValidatePath(params.path);
      const relPath = getRelativePath(absolutePath);
      if (
        !inWorkspace &&
        !approvalManager.isPathTrusted(params.sessionId, absolutePath)
      ) {
        const { approved, reason } = await approveOutsideWorkspaceAccess(
          absolutePath,
          approvalManager,
          params.approvalPanel as ApprovalPanelProvider,
          params.sessionId,
        );
        if (!approved) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  status: "rejected",
                  path: params.path,
                  reason,
                }),
              },
            ],
          };
        }
      }

      const uri = vscode.Uri.file(absolutePath);
      const document = await vscode.workspace.openTextDocument(uri);
      const position = new vscode.Position(
        Math.max(0, params.line - 1),
        Math.max(0, params.column - 1),
      );

      const wordRange = document.getWordRangeAtPosition(position);
      let oldName: string;
      if (wordRange) {
        oldName = document.getText(wordRange);
      } else {
        const lineText = document.lineAt(position.line).text;
        const before =
          lineText.slice(0, position.character).match(/\w+$/)?.[0] ?? "";
        const after =
          lineText.slice(position.character).match(/^\w+/)?.[0] ?? "";
        oldName = before + after || `symbol at ${params.line}:${params.column}`;
      }

      const edit = await vscode.commands.executeCommand<vscode.WorkspaceEdit>(
        "vscode.executeDocumentRenameProvider",
        uri,
        position,
        params.newName,
      );

      if (!edit) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: "Symbol at this position cannot be renamed",
                path: relPath,
                line: params.line,
                column: params.column,
              }),
            },
          ],
        };
      }

      const entries = edit.entries();
      if (entries.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: "Rename produced no changes",
                path: relPath,
              }),
            },
          ],
        };
      }

      const filesPreview: Array<{ path: string; changes: number }> = [];
      let totalChanges = 0;
      for (const [entryUri, edits] of entries) {
        const count = edits.length;
        totalChanges += count;
        filesPreview.push({
          path: getRelativePath(entryUri.fsPath),
          changes: count,
        });
      }

      const masterBypass = vscode.workspace
        .getConfiguration("agentlink")
        .get<boolean>("masterBypass", false);
      const touchesProtectedMemoryPath = anyMemoryProtectedPath(
        entries.map(([entryUri]) => entryUri.fsPath),
      );
      const canAutoApprove =
        !touchesProtectedMemoryPath &&
        (masterBypass ||
          approvalManager.isAgentWriteApproved(params.sessionId));
      let renameFollowUp: string | undefined;

      if (!canAutoApprove) {
        if (params.onApprovalRequest) {
          const filesDetail = filesPreview
            .map(
              (file) =>
                `${file.path} (${file.changes} change${file.changes !== 1 ? "s" : ""})`,
            )
            .join("\n");
          const result = await params.onApprovalRequest(
            {
              kind: "rename",
              title: `Rename \`${oldName}\` → \`${params.newName}\`?`,
              detail: `${totalChanges} change${totalChanges !== 1 ? "s" : ""} across ${filesPreview.length} file${filesPreview.length !== 1 ? "s" : ""}:\n${filesDetail}`,
              choices: [
                { label: "Accept", value: "accept", isPrimary: true },
                { label: "Reject", value: "reject", isDanger: true },
              ],
            },
            params.sessionId,
          );
          const decision =
            typeof result === "string" ? result : result.decision;
          renameFollowUp =
            typeof result === "string" ? undefined : result.followUp;
          const rejectionReason =
            typeof result === "string" ? undefined : result.rejectionReason;
          if (decision === "reject") {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    status: "rejected_by_user",
                    old_name: oldName,
                    new_name: params.newName,
                    ...(rejectionReason ? { reason: rejectionReason } : {}),
                    ...(renameFollowUp ? { follow_up: renameFollowUp } : {}),
                  }),
                },
              ],
            };
          }
          saveInlineWriteTrustRules({
            response: result,
            approvalManager,
            sessionId: params.sessionId,
            relPath,
          });
        } else {
          const approvalPanel = params.approvalPanel as ApprovalPanelProvider;
          const { promise } = approvalPanel.enqueueRenameApproval(
            oldName,
            params.newName,
            filesPreview,
            totalChanges,
          );

          const response = await promise;
          renameFollowUp = response.followUp;

          if (response.decision === "reject") {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    status: "rejected_by_user",
                    old_name: oldName,
                    new_name: params.newName,
                    reason: response.rejectionReason,
                  }),
                },
              ],
            };
          }

          saveWriteTrustRules({
            panelResponse: response,
            approvalManager,
            sessionId: params.sessionId,
            relPath,
            inWorkspace: true,
          });
        }
      }

      const applied = await vscode.workspace.applyEdit(edit);
      if (!applied) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: "Failed to apply rename edit",
                path: relPath,
              }),
            },
          ],
        };
      }

      for (const [entryUri] of entries) {
        const doc = vscode.workspace.textDocuments.find(
          (candidate) => candidate.uri.fsPath === entryUri.fsPath,
        );
        if (doc?.isDirty) {
          await doc.save();
        }
      }

      const result: Record<string, unknown> = {
        status: "accepted",
        old_name: oldName,
        new_name: params.newName,
        files_modified: filesPreview,
        total_changes: totalChanges,
      };
      if (renameFollowUp) {
        result.follow_up = renameFollowUp;
      }

      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    },
  };
}

export function createVscodeWriteApprovalPolicyProvider(
  approvalManager: ApprovalManager,
): WriteApprovalPolicyProvider {
  return {
    canAutoApprove(query: WriteApprovalQuery) {
      const masterBypass = vscode.workspace
        .getConfiguration("agentlink")
        .get<boolean>("masterBypass", false);
      const isArchitectPlanFile =
        query.mode === "architect" &&
        query.inWorkspace &&
        query.relativePath.startsWith("plans/");
      const isProtectedMemoryPath = isMemoryProtectedPath(query.absolutePath);

      return (
        !isProtectedMemoryPath &&
        (masterBypass ||
          isArchitectPlanFile ||
          (query.inWorkspace
            ? approvalManager.isAgentWriteApproved(
                query.sessionId,
                query.absolutePath,
              )
            : approvalManager.isFileWriteApproved(
                query.sessionId,
                query.absolutePath,
              )))
      );
    },

    recordDecision(params) {
      const scope = decisionToScope(params.decision);
      if (!scope) return;

      saveWriteTrustRules({
        panelResponse: params.writeApprovalResponse as
          | WriteApprovalResponse
          | undefined,
        approvalManager,
        sessionId: params.sessionId,
        scope,
        relPath: params.relativePath,
        inWorkspace: params.inWorkspace,
      });
    },
  };
}
