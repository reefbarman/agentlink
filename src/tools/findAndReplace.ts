import { readFile } from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";

import {
  resolveAndValidatePath,
  tryGetFirstWorkspaceRoot,
  getRelativePath,
} from "../util/paths.js";
import type { ApprovalManager } from "../approvals/ApprovalManager.js";
import type { ApprovalPanelProvider } from "../approvals/ApprovalPanelProvider.js";
import { isAgentInstructionReadPath } from "../approvals/protectedPaths.js";
import { approveOutsideWorkspaceAccess } from "./pathAccessUI.js";
import { waitForDocumentToMatchDisk } from "../integrations/editDurability.js";
import { getGitIgnoredRelativePaths } from "../indexer/IndexableFileDiscovery.js";

import {
  buildFindAndReplacePattern,
  checkFindAndReplaceGuardrail,
  collectFindAndReplaceMatches,
  findAndReplaceNoMatchesResult,
  validateFindAndReplaceTemplate,
} from "@agentlink/core/find-and-replace";
import { errorResult, type ToolResult } from "@agentlink/protocol/tool-result";
import type { OnApprovalRequest } from "@agentlink/protocol/inline-approval";
import type {
  EditReviewParams,
  MultiFileEditMatch,
  MultiFileEditReviewProvider,
} from "../core/capabilities/editReview.js";
import type { PathAccessProvider } from "../core/capabilities/readSearch.js";

export { expandReplacement } from "@agentlink/core/find-and-replace";

const MAX_GLOB_FILES = 500;
/**
 * Candidates scanned before git-ignored files are dropped. Ignored build
 * copies can outnumber the tracked files a glob is meant for, so the edit
 * limit applies after filtering.
 */
const MAX_GLOB_SCAN_FILES = 5_000;

interface FileReplacement {
  absolutePath: string;
  relPath: string;
  replacements: Array<{
    startOffset: number;
    endOffset: number;
    newText: string;
    matchId: string;
  }>;
  matches: MultiFileEditMatch[];
}

export interface FindAndReplaceProviders {
  multiFileEditReviewProvider?: MultiFileEditReviewProvider;
  pathAccessProvider?: PathAccessProvider;
  prepareOneShotAuthorization?: EditReviewParams["prepareOneShotAuthorization"];
}

export async function handleFindAndReplace(
  params: {
    find: string;
    replace: string;
    path?: string;
    glob?: string;
    regex?: boolean;
    max_replacements?: number;
    save_without_formatting?: boolean;
    include_ignored?: boolean;
  },
  approvalManager: ApprovalManager,
  approvalPanel: ApprovalPanelProvider,
  sessionId: string,
  _extensionUri: vscode.Uri,
  onApprovalRequest?: OnApprovalRequest,
  providers: FindAndReplaceProviders = {},
): Promise<ToolResult> {
  try {
    const workspaceRoot = tryGetFirstWorkspaceRoot();
    if (!workspaceRoot) {
      return errorResult(
        "No workspace folder open. find_and_replace with glob requires a workspace.",
      );
    }
    const findStr = params.find;
    const replaceStr = params.replace;

    if (!findStr) {
      return errorResult("'find' parameter is required");
    }

    const built = buildFindAndReplacePattern(findStr, params.regex);
    if (!built.ok) return errorResult(built.error);
    const { pattern } = built;
    const templateError = validateFindAndReplaceTemplate(
      replaceStr,
      params.regex,
    );
    if (templateError) {
      return errorResult(templateError, {
        reason: "unsupported_replacement_reference",
      });
    }

    // Resolve target files
    let fileUris: vscode.Uri[];
    let ignoredSkipped = 0;

    if (params.path) {
      const { absolutePath, inWorkspace } = resolveAndValidatePath(params.path);

      // Outside-workspace read gate. The later write review is independent and
      // proposal-bound; read approval never authorizes the mutation.
      if (
        !inWorkspace &&
        !isAgentInstructionReadPath(absolutePath) &&
        !approvalManager.isPathTrusted(sessionId, absolutePath)
      ) {
        const { approved, reason } = providers.pathAccessProvider
          ? await providers.pathAccessProvider.ensureAccess({
              absolutePath,
              inputPath: params.path,
              inWorkspace,
              sessionId,
              kind: "read",
            })
          : await approveOutsideWorkspaceAccess(
              absolutePath,
              approvalManager,
              approvalPanel,
              sessionId,
            );
        if (!approved) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  status: "rejected",
                  path: params.path,
                  ...(reason && { reason }),
                }),
              },
            ],
          };
        }
      }

      fileUris = [vscode.Uri.file(absolutePath)];
    } else if (params.glob) {
      // Leave the exclude pattern undefined so VS Code applies its configured
      // workspace search exclusions. Supplying a narrow exclude here overrides
      // those defaults and can unexpectedly propose edits to excluded caches.
      const relGlob = new vscode.RelativePattern(workspaceRoot, params.glob);
      // Request a sentinel beyond each limit so a truncated scan can never
      // produce a partial edit proposal or a misleading no_matches result.
      fileUris = await vscode.workspace.findFiles(
        relGlob,
        undefined,
        MAX_GLOB_SCAN_FILES + 1,
      );
      if (fileUris.length > MAX_GLOB_SCAN_FILES) {
        return errorResult(
          `Glob matched more than ${MAX_GLOB_SCAN_FILES} files before git-ignored files were removed. Narrow the glob or use an exact path; no files were edited.`,
          {
            reason: "glob_file_limit_exceeded",
            glob: params.glob,
            file_limit: MAX_GLOB_SCAN_FILES,
          },
        );
      }
      // findFiles applies files.exclude and search.exclude but not .gitignore,
      // so ignored build or snapshot copies would otherwise be edited.
      if (params.include_ignored !== true && fileUris.length > 0) {
        const relativePaths = fileUris.map((uri) =>
          path.relative(workspaceRoot, uri.fsPath).split(path.sep).join("/"),
        );
        const ignored = await getGitIgnoredRelativePaths(
          relativePaths,
          workspaceRoot,
          () => {},
        );
        if (ignored.size > 0) {
          const kept = fileUris.filter(
            (_uri, index) => !ignored.has(relativePaths[index]),
          );
          ignoredSkipped = fileUris.length - kept.length;
          fileUris = kept;
        }
      }
      if (fileUris.length > MAX_GLOB_FILES) {
        return errorResult(
          `Glob matched more than ${MAX_GLOB_FILES} files. Narrow the glob or use an exact path; no files were edited.`,
          {
            reason: "glob_file_limit_exceeded",
            glob: params.glob,
            file_limit: MAX_GLOB_FILES,
          },
        );
      }
      if (fileUris.length === 0) {
        return ignoredSkipped > 0
          ? errorResult(
              `Every file matching glob pattern ${params.glob} is git-ignored. Set include_ignored=true to edit ignored files.`,
              {
                reason: "glob_matched_only_ignored_files",
                glob: params.glob,
                ignored_files_skipped: ignoredSkipped,
              },
            )
          : errorResult(`No files matched glob pattern: ${params.glob}`);
      }
    } else {
      return errorResult("Either 'path' or 'glob' must be specified");
    }

    // Find all occurrences with context
    const fileReplacements: FileReplacement[] = [];
    const outOfDatePaths: string[] = [];
    let totalChanges = 0;

    for (let fileIdx = 0; fileIdx < fileUris.length; fileIdx++) {
      const uri = fileUris[fileIdx];
      let doc: vscode.TextDocument;
      try {
        doc = await vscode.workspace.openTextDocument(uri);
      } catch {
        continue; // Skip files that can't be opened (binary, etc.)
      }

      // Matches are located in VS Code's copy of the file. A clean copy that
      // has not reloaded a newer disk version would produce edits against
      // old content and a "file is newer" conflict when saved.
      if (doc.uri.scheme === "file" && !doc.isDirty) {
        const diskContent = await readFile(doc.uri.fsPath, "utf-8").catch(
          () => undefined,
        );
        if (
          diskContent !== undefined &&
          !(await waitForDocumentToMatchDisk(doc, doc.uri.fsPath, diskContent))
        ) {
          outOfDatePaths.push(getRelativePath(doc.uri.fsPath));
          continue;
        }
      }

      const { replacements, matches } = collectFindAndReplaceMatches(
        doc.getText(),
        pattern,
        { replace: replaceStr, regex: params.regex, fileIndex: fileIdx },
      );

      if (replacements.length > 0) {
        totalChanges += replacements.length;
        fileReplacements.push({
          absolutePath: uri.fsPath,
          relPath: getRelativePath(uri.fsPath),
          replacements,
          matches,
        });
      }
    }

    if (outOfDatePaths.length > 0) {
      return errorResult(
        "VS Code has not yet reloaded some files that changed on disk. No files were edited.",
        {
          reason: "editor_out_of_date_with_disk",
          no_changes_applied: true,
          paths: outOfDatePaths.slice(0, 20),
          ...(outOfDatePaths.length > 20
            ? { paths_omitted: outOfDatePaths.length - 20 }
            : {}),
          next_steps: [
            "Retry the same find_and_replace shortly, or edit these files with apply_diff or write_file, which write to disk directly when VS Code's copy is out of date.",
          ],
        },
      );
    }

    if (totalChanges === 0) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ...findAndReplaceNoMatchesResult(findStr, fileUris.length),
              ...(ignoredSkipped > 0
                ? { ignored_files_skipped: ignoredSkipped }
                : {}),
            }),
          },
        ],
      };
    }

    const guardrail = checkFindAndReplaceGuardrail(
      params,
      totalChanges,
      fileReplacements.length,
    );
    if (guardrail?.kind === "invalid") return errorResult(guardrail.error);
    if (guardrail?.kind === "exceeded") {
      return {
        content: [{ type: "text", text: JSON.stringify(guardrail.payload) }],
      };
    }

    if (!providers.multiFileEditReviewProvider) {
      return errorResult(
        "Multi-file edit review is unavailable in this runtime",
        {
          reason: "edit_review_unavailable",
        },
      );
    }

    const reviewed = await providers.multiFileEditReviewProvider.reviewAndApply(
      {
        find: findStr,
        replace: replaceStr,
        isRegex: !!params.regex,
        files: fileReplacements.map((fr) => ({
          absolutePath: fr.absolutePath,
          relativePath: fr.relPath,
          replacements: fr.replacements,
          matches: fr.matches,
        })),
        totalMatches: totalChanges,
        sessionId,
        approvalPanel,
        onApprovalRequest,
        prepareOneShotAuthorization: providers.prepareOneShotAuthorization,
        saveWithoutFormatting: params.save_without_formatting,
      },
    );
    return ignoredSkipped > 0
      ? withIgnoredFilesSkipped(reviewed, ignoredSkipped)
      : reviewed;
  } catch (err) {
    if (typeof err === "object" && err !== null && "content" in err) {
      return err as ToolResult;
    }
    const message = err instanceof Error ? err.message : String(err);
    return errorResult(message);
  }
}

/** Reports how many git-ignored glob matches were left out of the edit. */
function withIgnoredFilesSkipped(
  result: ToolResult,
  ignoredSkipped: number,
): ToolResult {
  const [first, ...rest] = result.content;
  if (first?.type !== "text") return result;
  try {
    const payload = JSON.parse(first.text) as unknown;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return result;
    }
    return {
      ...result,
      content: [
        {
          ...first,
          text: JSON.stringify({
            ...payload,
            ignored_files_skipped: ignoredSkipped,
          }),
        },
        ...rest,
      ],
    };
  } catch {
    return result;
  }
}
