import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as vscode from "vscode";
import { createPatch } from "diff";
import type { OnApprovalRequest } from "@agentlink/protocol/inline-approval";
import {
  errorResult,
  jsonResult,
  type ToolResult,
} from "@agentlink/protocol/tool-result";
import type { PathAccessProvider } from "../core/capabilities/readSearch.js";
import { deriveExpectedDiskContent } from "../core/editDurability.js";
import { isMemoryProtectedPath } from "../approvals/protectedPaths.js";
import { redactStructuredSecrets } from "../shared/structuredSecretRedaction.js";
import { saveVerifiedEditorDocument } from "../integrations/editDurability.js";
import {
  canonicalizePath,
  getRelativePath,
  resolveAndValidatePath,
} from "../util/paths.js";
import { withFileLock } from "../util/fileLock.js";

const MAX_CONTENT_BYTES = 256 * 1024;
const MAX_PREVIEW_CHARS = 16_000;

export interface GetEditorStateParams {
  path: string;
  offset?: number;
  limit?: number;
}

export interface SaveEditorParams {
  path: string;
  disk_hash: string | null;
  editor_hash: string;
  editor_version: number;
}

export interface EditorStateContext {
  sessionId: string;
  pathAccessProvider: PathAccessProvider;
  onApprovalRequest?: OnApprovalRequest;
  signal?: AbortSignal;
}

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function readDisk(absolutePath: string): Promise<string | null> {
  try {
    const stat = await fs.stat(absolutePath);
    if (!stat.isFile() || stat.size > MAX_CONTENT_BYTES) {
      throw new Error(
        "Editor recovery requires a regular file no larger than 256 KiB. Review and save it in VS Code.",
      );
    }
    const bytes = await fs.readFile(absolutePath);
    if (bytes.length > MAX_CONTENT_BYTES)
      throw new Error("File grew beyond the editor recovery limit");
    return bytes.toString("utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function findDocument(absolutePath: string): vscode.TextDocument | undefined {
  return vscode.workspace.textDocuments.find(
    (document) =>
      document.uri.scheme === "file" &&
      canonicalizePath(document.uri.fsPath) === absolutePath &&
      !document.isClosed,
  );
}

function bufferContent(document: vscode.TextDocument): string {
  const content = document.getText();
  if (Buffer.byteLength(content) > MAX_CONTENT_BYTES) {
    throw new Error(
      "Editor recovery requires a buffer no larger than 256 KiB. Review and save it in VS Code.",
    );
  }
  return content;
}

async function authorizeRead(inputPath: string, context: EditorStateContext) {
  const target = resolveAndValidatePath(inputPath);
  const absolutePath = canonicalizePath(target.absolutePath);
  const access = await context.pathAccessProvider.ensureAccess({
    ...target,
    absolutePath,
    inputPath,
    sessionId: context.sessionId,
    kind: "read",
  });
  if (!access.approved)
    throw new Error("Editor inspection requires permission to read this path");
  if (
    context.signal?.aborted ||
    canonicalizePath(target.absolutePath) !== absolutePath
  ) {
    throw new Error(
      "Editor target changed or inspection was cancelled; inspect again",
    );
  }
  return { ...target, absolutePath };
}

export async function handleGetEditorState(
  params: GetEditorStateParams,
  context: EditorStateContext,
): Promise<ToolResult> {
  try {
    const { absolutePath } = await authorizeRead(params.path, context);
    return await withFileLock(absolutePath, async () => {
      const document = findDocument(absolutePath);
      if (!document)
        return errorResult(
          "No existing file-backed editor is open for this path",
          { reason: "editor_not_open" },
        );
      const version = document.version;
      const editor = bufferContent(document);
      const disk = await readDisk(absolutePath);
      if (
        document.version !== version ||
        canonicalizePath(document.uri.fsPath) !== absolutePath
      ) {
        return errorResult("Editor changed during inspection; inspect again", {
          reason: "editor_state_changed",
        });
      }
      const visibleEditor = redactStructuredSecrets(absolutePath, editor);
      const visibleDisk = redactStructuredSecrets(absolutePath, disk ?? "");
      const lines = visibleEditor.content.split("\n");
      const offset = Math.max(1, params.offset ?? 1);
      const limit = Math.min(200, Math.max(1, params.limit ?? 100));
      const content = lines
        .slice(offset - 1, offset - 1 + limit)
        .map((line, index) => `${offset + index} | ${line}`)
        .join("\n");
      const diff = createPatch(
        getRelativePath(absolutePath),
        visibleDisk.content,
        visibleEditor.content,
        "disk",
        "editor",
        { context: 3 },
      );
      return jsonResult({
        path: getRelativePath(absolutePath),
        canonical_path: absolutePath,
        source: "editor_buffer",
        editor_version: version,
        editor_hash: hash(editor),
        document_dirty: document.isDirty,
        disk_exists: disk !== null,
        disk_hash: disk === null ? null : hash(disk),
        total_lines: lines.length,
        content: content.slice(0, MAX_PREVIEW_CHARS),
        content_truncated:
          content.length > MAX_PREVIEW_CHARS ||
          offset - 1 + limit < lines.length,
        disk_to_editor_diff: diff.slice(0, MAX_PREVIEW_CHARS),
        diff_truncated: diff.length > MAX_PREVIEW_CHARS,
        redacted:
          visibleEditor.redactionCount > 0 ||
          visibleDisk.redactionCount > 0 ||
          Boolean(visibleEditor.status || visibleDisk.status),
        next_steps: [
          "To save this exact buffer, call save_editor with these disk/editor hashes and editor_version. Fresh human approval is required; rejection leaves the buffer unchanged.",
        ],
      });
    });
  } catch (error) {
    return errorResult(error instanceof Error ? error.message : String(error), {
      path: params.path,
    });
  }
}

export async function handleSaveEditor(
  params: SaveEditorParams,
  context: EditorStateContext,
): Promise<ToolResult> {
  try {
    const { absolutePath } = await authorizeRead(params.path, context);
    if (isMemoryProtectedPath(absolutePath)) {
      return errorResult(
        "Use the owning instruction or memory workflow to save this protected target",
        { reason: "protected_editor_target" },
      );
    }
    if (!context.onApprovalRequest)
      return errorResult("Human save approval is unavailable", {
        reason: "editor_approval_unavailable",
      });
    const prepared = await withFileLock(absolutePath, async () => {
      const document = findDocument(absolutePath);
      if (!document)
        return errorResult(
          "No existing file-backed editor is open for this path",
          { reason: "editor_not_open" },
        );
      const editor = bufferContent(document);
      const disk = await readDisk(absolutePath);
      const diskHash = disk === null ? null : hash(disk);
      if (
        document.version !== params.editor_version ||
        hash(editor) !== params.editor_hash ||
        diskHash !== params.disk_hash
      ) {
        return errorResult(
          "Disk or editor state changed; inspect again before saving",
          { reason: "editor_state_changed" },
        );
      }
      const expected = deriveExpectedDiskContent(disk ?? "", editor);
      if (!document.isDirty) {
        return disk === expected
          ? jsonResult({
              status: "already_saved",
              path: params.path,
              final_content_hash: hash(expected),
            })
          : errorResult(
              "Clean editor does not match disk; reconcile in VS Code",
              { reason: "editor_state_changed" },
            );
      }
      const redactedEditor = redactStructuredSecrets(absolutePath, editor);
      const redactedDisk = redactStructuredSecrets(absolutePath, disk ?? "");
      if (
        redactedEditor.redactionCount ||
        redactedDisk.redactionCount ||
        redactedEditor.status ||
        redactedDisk.status
      ) {
        return errorResult(
          "This configuration needs private native editor review. Save it in VS Code to avoid exposing secrets in approval history.",
          { reason: "editor_private_review_required" },
        );
      }
      const detail = createPatch(
        getRelativePath(absolutePath),
        disk ?? "",
        expected,
        "disk",
        "editor (save without formatting)",
        { context: 3 },
      );
      if (detail.length > MAX_PREVIEW_CHARS) {
        return errorResult(
          "The complete save diff exceeds the approval limit. Review and save in VS Code.",
          { reason: "editor_approval_too_large" },
        );
      }
      return { document, editor, diskHash, expected, detail };
    });
    if ("content" in prepared) return prepared;
    const { document, editor, diskHash, expected, detail } = prepared;
    const raw = await context.onApprovalRequest!(
      {
        kind: "write",
        id: randomUUID(),
        title: `Save existing editor buffer for \`${getRelativePath(absolutePath)}\`?`,
        detail,
        targetPath: absolutePath,
        writeChoices: [
          {
            label: "Save this buffer once",
            value: "accept",
            isPrimary: true,
          },
          { label: "Leave unsaved", value: "reject", isDanger: true },
        ],
        choices: [],
      },
      context.sessionId,
    );
    const decision = typeof raw === "string" ? raw : raw.decision;
    const followUp = typeof raw === "string" ? undefined : raw.followUp;
    if (decision !== "accept") {
      return jsonResult({
        status: "rejected_by_user",
        path: params.path,
        ...(followUp ? { follow_up: followUp } : {}),
      });
    }
    return await withFileLock(absolutePath, async () => {
      const unchanged = async () => {
        if (
          context.signal?.aborted ||
          findDocument(absolutePath) !== document ||
          document.version !== params.editor_version ||
          document.getText() !== editor ||
          !document.isDirty
        )
          return false;
        const currentDisk = await readDisk(absolutePath);
        return (
          canonicalizePath(resolveAndValidatePath(params.path).absolutePath) ===
            absolutePath &&
          (currentDisk === null ? null : hash(currentDisk)) === diskHash &&
          document.version === params.editor_version &&
          document.getText() === editor
        );
      };
      if (!(await unchanged()))
        return errorResult(
          "Disk or editor changed while awaiting approval; inspect again",
          { reason: "editor_state_changed" },
        );
      const saved = await saveVerifiedEditorDocument(
        document,
        absolutePath,
        unchanged,
      );
      const final = await readDisk(absolutePath);
      if (
        !saved ||
        document.isDirty ||
        document.getText() !== editor ||
        final !== expected
      ) {
        return errorResult(
          "Editor save was not durably preserved; inspect the current editor and disk state",
          {
            reason: "editor_save_failed",
            path: params.path,
            document_dirty: document.isDirty,
            editor_version: document.version,
            editor_hash: hash(document.getText()),
            expected_disk_hash: hash(expected),
            final_disk_hash: final === null ? null : hash(final),
            ...(followUp ? { follow_up: followUp } : {}),
          },
        );
      }
      return jsonResult({
        status: "accepted",
        path: params.path,
        operation: "saved_editor",
        durability: {
          status: "durable",
          outcome: "exact",
          policy: "preserve_exact",
          final_content_hash: hash(final),
          requires_reread: false,
        },
        ...(followUp ? { follow_up: followUp } : {}),
      });
    });
  } catch (error) {
    return errorResult(error instanceof Error ? error.message : String(error), {
      path: params.path,
    });
  }
}
