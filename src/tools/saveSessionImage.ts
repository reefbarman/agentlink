import * as fs from "fs/promises";
import * as path from "path";

import type { OnApprovalRequest } from "@agentlink/protocol/inline-approval";
import { errorResult, type ToolResult } from "@agentlink/protocol/tool-result";
import {
  evaluateWriteAuthorization,
  type EditReviewDecision,
  type WriteApprovalPolicyProvider,
  type WriteApprovalPromptEvent,
  type WriteApprovalQuery,
} from "../core/capabilities/editReview.js";
import type { SessionImageReference } from "../core/tools/types.js";
import { toSupportedImageMediaType } from "../agent/providers/types.js";
import { getRelativePath, resolveAndValidatePath } from "../util/paths.js";

export interface SaveSessionImageInput {
  image_id?: unknown;
  path?: unknown;
  overwrite?: unknown;
}

export interface SaveSessionImageDeps {
  sessionId: string;
  mode?: string;
  getSessionImages?: () => SessionImageReference[];
  writeApprovalPolicyProvider: WriteApprovalPolicyProvider;
  onApprovalRequest?: OnApprovalRequest;
  onApprovalPrompt?: (event: WriteApprovalPromptEvent) => void;
}

const EXTENSIONS_BY_MEDIA_TYPE: Record<string, readonly string[]> = {
  "image/png": [".png"],
  "image/jpeg": [".jpg", ".jpeg"],
  "image/gif": [".gif"],
  "image/webp": [".webp"],
};

const APPROVAL_DECISIONS = new Set<EditReviewDecision>([
  "accept",
  "accept-session",
  "accept-project",
  "accept-always",
]);

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function findSessionImage(
  imageId: string,
  sessionImages: readonly SessionImageReference[],
): SessionImageReference {
  const image = sessionImages.find((candidate) => candidate.id === imageId);
  if (image) return image;
  const available = sessionImages.map((candidate) => candidate.id).join(", ");
  throw new Error(
    `No session image found for image_id "${imageId}"${available ? `. Available image IDs: ${available}` : ". No images are available in the current session"}`,
  );
}

function targetPathForImage(inputPath: string, mediaType: string): string {
  const extensions = EXTENSIONS_BY_MEDIA_TYPE[mediaType] ?? [];
  const extension = path.extname(inputPath).toLowerCase();
  if (!extension) return `${inputPath}${extensions[0] ?? ""}`;
  if (!extensions.includes(extension)) {
    throw new Error(
      `path extension ${extension} does not match the image type ${mediaType}; use ${extensions.join(" or ")}. Images are written as stored, without format conversion.`,
    );
  }
  return inputPath;
}

async function existingFileKind(
  absolutePath: string,
): Promise<"missing" | "file" | "directory"> {
  try {
    const stats = await fs.stat(absolutePath);
    return stats.isDirectory() ? "directory" : "file";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

function jsonResult(payload: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

/**
 * Write a retained session image (user attachment, screenshot, generated
 * image, or other image tool result) to a workspace file. Writes follow the
 * same agent write-approval policy as file edits.
 */
export async function handleSaveSessionImage(
  input: SaveSessionImageInput,
  deps: SaveSessionImageDeps,
): Promise<ToolResult> {
  try {
    const imageId = requiredString(input.image_id, "image_id");
    const pathInput = requiredString(input.path, "path");
    if (input.overwrite !== undefined && typeof input.overwrite !== "boolean") {
      throw new Error("overwrite must be a boolean");
    }
    const overwrite = input.overwrite === true;

    const image = findSessionImage(imageId, deps.getSessionImages?.() ?? []);
    const mediaType = toSupportedImageMediaType(image.mimeType);
    if (!mediaType) {
      throw new Error(
        `Session image ${image.id} has an unsupported MIME type: ${image.mimeType}`,
      );
    }
    const bytes = Buffer.from(image.base64, "base64");
    if (bytes.length === 0) {
      throw new Error(`Session image ${image.id} has no image data`);
    }

    const { absolutePath, inWorkspace } = resolveAndValidatePath(
      targetPathForImage(pathInput, mediaType),
    );
    if (!inWorkspace) {
      throw new Error(
        "save_session_image path must resolve inside the workspace",
      );
    }
    const relativePath = getRelativePath(absolutePath);

    const existing = await existingFileKind(absolutePath);
    if (existing === "directory") {
      throw new Error(
        `${relativePath} is a directory; pass a file path such as ${relativePath}/${image.id}${EXTENSIONS_BY_MEDIA_TYPE[mediaType]?.[0] ?? ""}`,
      );
    }
    if (existing === "file" && !overwrite) {
      return errorResult(
        `${relativePath} already exists. Choose a different path, or pass overwrite: true to replace it.`,
        { status: "exists", path: relativePath },
      );
    }

    const query: WriteApprovalQuery = {
      sessionId: deps.sessionId,
      absolutePath,
      relativePath,
      inWorkspace: true,
      mode: deps.mode,
    };
    const authorization = evaluateWriteAuthorization(
      deps.writeApprovalPolicyProvider,
      query,
    );
    let followUp: string | undefined;

    if (!authorization.allowed) {
      if (!deps.onApprovalRequest) {
        return errorResult(
          `Saving ${relativePath} requires write approval, but no approval surface is available in this session.`,
          { status: "approval_unavailable", path: relativePath },
        );
      }
      deps.onApprovalPrompt?.({ ...query, authorization });
      const operation = existing === "file" ? "modify" : "create";
      const raw = await deps.onApprovalRequest(
        {
          kind: "write",
          title: `${operation === "create" ? "Create" : "Overwrite"} \`${relativePath}\`?`,
          detail: [
            `Save session image ${image.id} (${image.name})`,
            `Type: ${mediaType}`,
            `Size: ${bytes.length.toLocaleString()} bytes`,
            operation === "modify"
              ? "The existing file will be replaced."
              : undefined,
          ]
            .filter((line): line is string => line !== undefined)
            .join("\n"),
          targetPath: absolutePath,
          fileWrite: { operation, outsideWorkspace: false },
          choices: [],
        },
        deps.sessionId,
      );
      const response = typeof raw === "string" ? { decision: raw } : raw;
      const decision = response.decision as EditReviewDecision;
      if (!APPROVAL_DECISIONS.has(decision)) {
        return jsonResult({
          status: "rejected_by_user",
          path: relativePath,
          ...(response.rejectionReason
            ? { reason: response.rejectionReason }
            : {}),
          ...(response.followUp ? { follow_up: response.followUp } : {}),
        });
      }
      deps.writeApprovalPolicyProvider.recordDecision({
        decision,
        sessionId: deps.sessionId,
        absolutePath,
        relativePath,
        inWorkspace: true,
        writeApprovalResponse: response,
      });
      followUp = response.followUp;
    }

    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, bytes, { flag: overwrite ? "w" : "wx" });

    return jsonResult({
      status: "saved",
      image_id: image.id,
      path: relativePath,
      mime_type: mediaType,
      bytes: bytes.length,
      ...(existing === "file" ? { overwritten: true } : {}),
      authorization: authorization.allowed
        ? { basis: authorization.basis, scope: authorization.scope }
        : { basis: "human" },
      ...(followUp ? { follow_up: followUp } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return errorResult(
        `The target file was created while waiting for approval. Choose a different path, or pass overwrite: true to replace it.`,
        { status: "exists" },
      );
    }
    return errorResult(message);
  }
}
