import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";

import {
  DiffViewProvider,
  createFormatOnSaveReport,
  diagnoseEditSaveFailure,
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
  OneShotWriteAuthorization,
  PreparedWriteProposal,
  RenameSymbolParams,
  RenameSymbolProvider,
  WriteApprovalPolicyProvider,
  WriteApprovalQuery,
} from "../../core/capabilities/editReview.js";
import type {
  FindReplaceFileGroup,
  FindReplacePreviewData,
} from "../../findReplace/webview/types.js";
import { isMemoryProtectedPath } from "../../approvals/protectedPaths.js";
import { classifyGuardianPathRisk } from "../../approvals/actionApprovalReview.js";
import {
  decisionToScope,
  saveInlineWriteTrustRules,
  saveWriteTrustRules,
} from "../../tools/writeApprovalUI.js";

import type { ApprovalManager } from "../../approvals/ApprovalManager.js";
import type { ApprovalPanelProvider } from "../../approvals/ApprovalPanelProvider.js";
import { FindReplacePreviewPanel } from "../../findReplace/FindReplacePreviewPanel.js";
import type { WriteApprovalResponse } from "../../approvals/ApprovalPanelProvider.js";
import { applyWorkspaceEditAndSave } from "./workspaceEditOrchestration.js";
import { approveOutsideWorkspaceAccess } from "../../tools/pathAccessUI.js";
import { getConfiguredMasterBypass } from "./agentLinkConfig.js";
import { canonicalizePath, getRelativePath } from "../../util/paths.js";
import { resolveAndValidatePath } from "../../util/paths.js";
import { withFileLock, withFileLocks } from "../../util/fileLock.js";
import { withPrimaryEditorColumn } from "../../util/editorPlacement.js";
import { errorResult, type ToolResult } from "../../shared/types.js";

interface ClassifiedWriteTarget {
  absolutePath: string;
  inWorkspace: boolean;
}

function classifyWriteTargets(
  paths: readonly string[],
): ClassifiedWriteTarget[] | undefined {
  const targets: ClassifiedWriteTarget[] = [];
  const canonicalPaths = new Set<string>();
  try {
    for (const filePath of paths) {
      const target = resolveAndValidatePath(filePath);
      if (canonicalPaths.has(target.absolutePath)) return undefined;
      canonicalPaths.add(target.absolutePath);
      targets.push(target);
    }
  } catch {
    return undefined;
  }
  return targets;
}

function areWriteTargetsAutoApproved(
  targets: readonly ClassifiedWriteTarget[],
  approvalManager: ApprovalManager,
  sessionId: string,
): boolean {
  if (
    targets.some(
      (target) =>
        !classifyGuardianPathRisk({
          status: "resolved",
          canonicalPath: target.absolutePath,
        }).guardianEligible,
    )
  ) {
    return false;
  }
  if (getConfiguredMasterBypass()) return true;
  return targets.every((target) =>
    target.inWorkspace
      ? approvalManager.isAgentWriteApproved(sessionId, target.absolutePath)
      : approvalManager.isFileWriteApproved(sessionId, target.absolutePath),
  );
}

function proposedContentForTextEdits(
  document: vscode.TextDocument,
  edits: readonly vscode.TextEdit[],
): string | undefined {
  const baseline = document.getText();
  const replacements = edits
    .map((edit) => ({
      start: document.offsetAt(edit.range.start),
      end: document.offsetAt(edit.range.end),
      newText: edit.newText,
    }))
    .sort((left, right) => left.start - right.start || left.end - right.end);

  let previousEnd = -1;
  let previousStart = -1;
  for (const replacement of replacements) {
    if (
      replacement.start < 0 ||
      replacement.end < replacement.start ||
      replacement.end > baseline.length ||
      replacement.start < previousEnd ||
      replacement.start === previousStart
    ) {
      return undefined;
    }
    previousStart = replacement.start;
    previousEnd = replacement.end;
  }

  let proposed = baseline;
  for (let index = replacements.length - 1; index >= 0; index--) {
    const replacement = replacements[index]!;
    proposed =
      proposed.slice(0, replacement.start) +
      replacement.newText +
      proposed.slice(replacement.end);
  }
  return proposed;
}

async function buildPreparedWorkspaceEditProposals(
  entries: readonly (readonly [vscode.Uri, readonly vscode.TextEdit[]])[],
  expectedCanonicalPaths?: readonly string[],
): Promise<PreparedWriteProposal[] | undefined> {
  if (entries.length === 0) return undefined;
  const documents = await Promise.all(
    entries.map(([uri]) => vscode.workspace.openTextDocument(uri)),
  );
  const proposals: PreparedWriteProposal[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < entries.length; index++) {
    const [uri, edits] = entries[index]!;
    const canonicalPath = canonicalizePath(uri.fsPath);
    if (
      seen.has(canonicalPath) ||
      (expectedCanonicalPaths &&
        expectedCanonicalPaths[index] !== canonicalPath)
    ) {
      return undefined;
    }
    seen.add(canonicalPath);
    const document = documents[index]!;
    if (document.isDirty) return undefined;
    const baselineContent = document.getText();
    const proposedContent = proposedContentForTextEdits(document, edits);
    if (proposedContent === undefined) return undefined;
    proposals.push({
      absolutePath: canonicalPath,
      baselineExists: true,
      baselineContent,
      proposedContent,
    });
  }
  return proposals;
}

async function prepareAtomicWorkspaceEditAuthorization(
  edit: vscode.WorkspaceEdit,
  prepareOneShotAuthorization: MultiFileEditReviewParams["prepareOneShotAuthorization"],
): Promise<OneShotWriteAuthorization | undefined> {
  if (!prepareOneShotAuthorization) return undefined;
  const proposals = await buildPreparedWorkspaceEditProposals(edit.entries());
  if (!proposals) return undefined;
  return prepareOneShotAuthorization(proposals);
}

async function consumeAtomicWorkspaceEditAuthorization(
  edit: vscode.WorkspaceEdit,
  authorization: OneShotWriteAuthorization,
): Promise<boolean> {
  const entries = edit.entries();
  const current = await buildPreparedWorkspaceEditProposals(entries);
  return !!current && authorization.consume(current);
}

function renameFailureResult(params: {
  error: string;
  reason?: string;
  path: string;
  line: number;
  column: number;
  oldName: string;
  newName: string;
  languageId?: string;
}): ToolResult {
  return errorResult(params.error, {
    ...(params.reason ? { reason: params.reason } : {}),
    path: params.path,
    line: params.line,
    column: params.column,
    old_name: params.oldName,
    new_name: params.newName,
    ...(params.languageId ? { language_id: params.languageId } : {}),
    next_steps: [
      "Verify that line and column point to the intended symbol; both are 1-indexed.",
      "If the position is correct, inspect the symbol with get_hover or go_to_definition. When the language service cannot rename this element, use get_references and reviewed edits as a fallback.",
    ],
  });
}

export function createVscodeEditorRevealProvider(): EditorRevealProvider {
  return {
    async reveal(params: EditorRevealParams) {
      const uri = vscode.Uri.file(params.absolutePath);
      const stat = await fs.stat(params.absolutePath);
      if (stat.isDirectory()) {
        await vscode.commands.executeCommand("revealInExplorer", uri);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "revealed",
                path: getRelativePath(params.absolutePath),
              }),
            },
          ],
        };
      }

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

          let baselineContent = "";
          try {
            baselineContent = await fs.readFile(params.absolutePath, "utf-8");
          } catch {
            // Missing files are represented as empty content after the
            // allowCreate branch above, matching the write_file behavior.
          }
          let content = params.content;
          if (params.prepareContent) {
            const prepared = await params.prepareContent(baselineContent);
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
                ...(await diagnoseEditSaveFailure({
                  absolutePath: params.absolutePath,
                  baselineContent,
                  documentDirty: doc.isDirty,
                  reviewState: "dirty_document_preserved",
                })),
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
            finalContent,
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
        const readBaseline = async () => {
          try {
            return {
              exists: true as const,
              content: await fs.readFile(params.absolutePath, "utf-8"),
            };
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            return { exists: false as const, content: "" };
          }
        };
        const prepare = async (baselineContent: string) => {
          if (!params.prepareContent) {
            return { status: "continue" as const, content: params.content };
          }
          return params.prepareContent(baselineContent);
        };

        let baseline = await readBaseline();
        let prepared = await prepare(baseline.content);
        if (prepared.status === "abort") return prepared.result;
        let content = prepared.content;

        if (params.outsideWorkspace && params.prepareOneShotAuthorization) {
          const proposal = {
            absolutePath: canonicalizePath(params.absolutePath),
            baselineExists: baseline.exists,
            baselineContent: baseline.content,
            proposedContent: content,
          };
          const authorization =
            await params.prepareOneShotAuthorization(proposal);
          if (authorization) {
            baseline = await readBaseline();
            prepared = await prepare(baseline.content);
            if (prepared.status === "abort") return prepared.result;
            content = prepared.content;
            const currentProposal = {
              absolutePath: canonicalizePath(params.absolutePath),
              baselineExists: baseline.exists,
              baselineContent: baseline.content,
              proposedContent: content,
            };
            const existingDocument = baseline.exists
              ? await vscode.workspace.openTextDocument(params.absolutePath)
              : undefined;
            const documentMatchesBaseline =
              !existingDocument ||
              (!existingDocument.isDirty &&
                existingDocument.getText() === baseline.content);
            if (
              documentMatchesBaseline &&
              authorization.consume(currentProposal)
            ) {
              const snap = snapshotDiagnostics(params.absolutePath);
              await fs.mkdir(path.dirname(params.absolutePath), {
                recursive: true,
              });
              if (!baseline.exists) {
                if (params.allowCreate === false) {
                  return {
                    error: "File not found",
                    path: params.relativePath,
                  };
                }
                await fs.writeFile(params.absolutePath, "", "utf-8");
              }
              const doc =
                existingDocument ??
                (await vscode.workspace.openTextDocument(params.absolutePath));
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
                if (!(await vscode.workspace.applyEdit(edit))) {
                  return {
                    error: "File edit failed",
                    path: params.relativePath,
                    reason: "apply_edit_failed",
                  };
                }
              }
              if (doc.isDirty && !(await doc.save())) {
                return {
                  error: "File save failed",
                  path: params.relativePath,
                  reason: "save_failed",
                  ...(await diagnoseEditSaveFailure({
                    absolutePath: params.absolutePath,
                    baselineContent: baseline.content,
                    documentDirty: doc.isDirty,
                    reviewState: "dirty_document_preserved",
                  })),
                };
              }
              const finalContent = await fs.readFile(
                params.absolutePath,
                "utf-8",
              );
              const formatOnSaveReport = createFormatOnSaveReport(
                params.relativePath,
                content,
                finalContent,
              );
              const newDiagnostics = await snap.collectNewErrors(
                params.diagnosticDelay,
              );
              return {
                status: "accepted",
                path: params.relativePath,
                operation: params.operation ?? "auto-approved",
                finalContent,
                authorization: authorization.authorization,
                ...formatOnSaveReport,
                ...(newDiagnostics ? { new_diagnostics: newDiagnostics } : {}),
              };
            }
          }
        }

        const diffView = new DiffViewProvider(params.diagnosticDelay);

        await diffView.open(params.absolutePath, params.relativePath, content, {
          outsideWorkspace: params.outsideWorkspace,
        });
        const decision = (await diffView.waitForUserDecision(
          params.approvalPanel as ApprovalPanelProvider,
          params.onApprovalRequest,
          params.sessionId,
          params.onApprovalPresented,
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

        const targets = classifyWriteTargets(
          params.files.map((file) => file.absolutePath),
        );
        let canAutoApprove =
          !!targets &&
          areWriteTargetsAutoApproved(
            targets,
            approvalManager,
            params.sessionId,
          );

        let followUp: string | undefined;
        let acceptedIds: Set<string> | undefined;

        if (
          !canAutoApprove &&
          targets?.some((target) => !target.inWorkspace) &&
          params.prepareOneShotAuthorization
        ) {
          const candidateEdit = new vscode.WorkspaceEdit();
          let candidateMatchesBaseline = true;
          for (const file of params.files) {
            const uri = vscode.Uri.file(file.absolutePath);
            const doc = await vscode.workspace.openTextDocument(uri);
            const baselineContent = doc.getText();
            const matchesById = new Map(
              file.matches.map((match) => [match.id, match.matchText]),
            );
            for (const replacement of file.replacements) {
              const expectedMatch = matchesById.get(replacement.matchId);
              if (
                expectedMatch === undefined ||
                baselineContent.slice(
                  replacement.startOffset,
                  replacement.endOffset,
                ) !== expectedMatch
              ) {
                candidateMatchesBaseline = false;
                break;
              }
              candidateEdit.replace(
                uri,
                new vscode.Range(
                  doc.positionAt(replacement.startOffset),
                  doc.positionAt(replacement.endOffset),
                ),
                replacement.newText,
              );
            }
            if (!candidateMatchesBaseline) break;
          }
          const authorization = candidateMatchesBaseline
            ? await prepareAtomicWorkspaceEditAuthorization(
                candidateEdit,
                params.prepareOneShotAuthorization,
              )
            : undefined;
          if (authorization) {
            const guardianResult = await withFileLocks(
              targets.map((target) => target.absolutePath),
              async () => {
                if (
                  !(await consumeAtomicWorkspaceEditAuthorization(
                    candidateEdit,
                    authorization,
                  ))
                ) {
                  return undefined;
                }
                return applyWorkspaceEditAndSave({
                  edit: candidateEdit,
                  affectedPaths: targets.map((target) => target.absolutePath),
                  applyFailure: {
                    content: [
                      {
                        type: "text" as const,
                        text: JSON.stringify({
                          error: "Failed to apply replacements",
                        }),
                      },
                    ],
                  },
                  saveFailure: {
                    content: [
                      {
                        type: "text" as const,
                        text: JSON.stringify({
                          error: "Failed to save replacement changes",
                        }),
                      },
                    ],
                  },
                  buildSuccess: () => ({
                    content: [
                      {
                        type: "text" as const,
                        text: JSON.stringify(
                          {
                            status: "applied",
                            find: params.find,
                            replace: params.replace,
                            files_changed: filesPreview.length,
                            total_replacements: params.totalMatches,
                            files: filesPreview,
                            authorization: authorization.authorization,
                          },
                          null,
                          2,
                        ),
                      },
                    ],
                  }),
                });
              },
            );
            if (guardianResult) return guardianResult;
          }
        }

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
                targetPath: filesPreview[0]?.path,
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
              absolutePath: params.files[0]?.absolutePath ?? params.find,
              relPath:
                filesPreview.length > 0
                  ? filesPreview[0].path
                  : "find-and-replace",
              inWorkspace: targets?.[0]?.inWorkspace ?? true,
            });
            acceptedIds = previewPanel.getAcceptedMatchIds();
          } else {
            const approvalPanel = params.approvalPanel as ApprovalPanelProvider;
            const { promise } = approvalPanel.enqueueRenameApproval(
              params.find,
              params.replace,
              filesPreview,
              params.totalMatches,
              {
                sessionId: params.sessionId,
                targetPath: filesPreview[0]?.path,
              },
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
              absolutePath: params.files[0]?.absolutePath ?? params.find,
              relPath:
                filesPreview.length > 0
                  ? filesPreview[0].path
                  : "find-and-replace",
              inWorkspace: targets?.[0]?.inWorkspace ?? true,
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
          const baselineContent = doc.getText();
          const matchesById = new Map(
            file.matches.map((match) => [match.id, match.matchText]),
          );
          let fileChanges = 0;
          for (const replacement of file.replacements) {
            if (!acceptedIds || acceptedIds.has(replacement.matchId)) {
              const expectedMatch = matchesById.get(replacement.matchId);
              if (
                expectedMatch === undefined ||
                baselineContent.slice(
                  replacement.startOffset,
                  replacement.endOffset,
                ) !== expectedMatch
              ) {
                return {
                  content: [
                    {
                      type: "text",
                      text: JSON.stringify({
                        status: "stale_proposal",
                        no_changes_applied: true,
                        path: file.relativePath,
                        match_id: replacement.matchId,
                        message:
                          "File content changed after the replacement preview; review a fresh proposal before retrying.",
                      }),
                    },
                  ],
                };
              }
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

        return await applyWorkspaceEditAndSave({
          edit,
          affectedPaths: params.files.map((file) => file.absolutePath),
          applyFailure: {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ error: "Failed to apply replacements" }),
              },
            ],
          },
          saveFailure: {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: "Failed to save replacement changes",
                }),
              },
            ],
          },
          buildSuccess: () => {
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
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify(result, null, 2),
                },
              ],
            };
          },
        });
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
        !params.sourceReadAuthorized &&
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

      let edit: vscode.WorkspaceEdit | undefined;
      try {
        edit = await vscode.commands.executeCommand<vscode.WorkspaceEdit>(
          "vscode.executeDocumentRenameProvider",
          uri,
          position,
          params.newName,
        );
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return renameFailureResult({
          error: `Rename request was rejected by the ${document.languageId || "active"} language service`,
          reason,
          path: relPath,
          line: params.line,
          column: params.column,
          oldName,
          newName: params.newName,
          languageId: document.languageId,
        });
      }

      if (!edit) {
        return renameFailureResult({
          error: `The ${document.languageId || "active"} language service returned no rename edits`,
          reason:
            "The selected element may not support language-aware rename at this position.",
          path: relPath,
          line: params.line,
          column: params.column,
          oldName,
          newName: params.newName,
          languageId: document.languageId,
        });
      }

      const entries = edit.entries();
      if (entries.length === 0) {
        return renameFailureResult({
          error: "Rename produced no changes",
          reason:
            oldName === params.newName
              ? "The requested name is the same as the current symbol name."
              : "The language service accepted the request but returned an empty workspace edit.",
          path: relPath,
          line: params.line,
          column: params.column,
          oldName,
          newName: params.newName,
          languageId: document.languageId,
        });
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

      const targets = classifyWriteTargets(
        entries.map(([entryUri]) => entryUri.fsPath),
      );
      const canAutoApprove =
        !!targets &&
        areWriteTargetsAutoApproved(targets, approvalManager, params.sessionId);
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
              targetPath: filesPreview[0]?.path,
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
            absolutePath: entries[0]![0].fsPath,
            relPath,
            inWorkspace: targets?.[0]?.inWorkspace ?? inWorkspace,
          });
        } else {
          const approvalPanel = params.approvalPanel as ApprovalPanelProvider;
          const { promise } = approvalPanel.enqueueRenameApproval(
            oldName,
            params.newName,
            filesPreview,
            totalChanges,
            { sessionId: params.sessionId, targetPath: filesPreview[0]?.path },
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
            absolutePath: entries[0]![0].fsPath,
            relPath,
            inWorkspace: targets?.[0]?.inWorkspace ?? inWorkspace,
          });
        }
      }

      return await applyWorkspaceEditAndSave({
        edit,
        affectedPaths: entries.map(([entryUri]) => entryUri.fsPath),
        applyFailure: {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: "Failed to apply rename edit",
                path: relPath,
              }),
            },
          ],
        },
        saveFailure: {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: "Failed to save rename edit",
                path: relPath,
              }),
            },
          ],
        },
        buildSuccess: () => {
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
            content: [{ type: "text" as const, text: JSON.stringify(result) }],
          };
        },
      });
    },
  };
}

export function createVscodeWriteApprovalPolicyProvider(
  approvalManager: ApprovalManager,
): WriteApprovalPolicyProvider {
  const getAuthorization = (query: WriteApprovalQuery) => {
    const masterBypass = getConfiguredMasterBypass();
    const isArchitectPlanFile =
      query.mode === "architect" &&
      query.inWorkspace &&
      query.relativePath.startsWith("plans/");
    const isProtectedMemoryPath = isMemoryProtectedPath(query.absolutePath);

    if (isProtectedMemoryPath) {
      return {
        allowed: false,
        basis: "none" as const,
        reason: "protected_memory_path",
      };
    }
    if (masterBypass) {
      return { allowed: true, basis: "master_bypass" as const };
    }
    if (isArchitectPlanFile) {
      return { allowed: true, basis: "architect_plan" as const };
    }
    const authorization = query.inWorkspace
      ? approvalManager.getAgentWriteAuthorization(
          query.sessionId,
          query.absolutePath,
        )
      : approvalManager.getFileWriteAuthorization(
          query.sessionId,
          query.absolutePath,
        );
    if (authorization.allowed || authorization.reason) return authorization;
    return {
      ...authorization,
      reason: query.inWorkspace
        ? "no_matching_write_authority"
        : "outside_workspace_requires_matching_rule",
    };
  };

  return {
    getAuthorization,
    canAutoApprove(query: WriteApprovalQuery) {
      return getAuthorization(query).allowed;
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
        absolutePath: params.absolutePath,
        relPath: params.relativePath,
        inWorkspace: params.inWorkspace,
      });
    },
  };
}
