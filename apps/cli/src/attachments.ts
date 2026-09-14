import type { AgentTurnAttachment } from "@agentlink/core";
import type { StandaloneSubmitAttachment } from "./sessionController.js";
import { promises as fs } from "node:fs";
import path from "node:path";

const MAX_ATTACHMENTS = 4;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const IMAGE_MIME_BY_EXTENSION = new Map<string, ImageMimeType>([
  [".gif", "image/gif"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
]);
const DOCUMENT_MIME_BY_EXTENSION = new Map<string, DocumentMimeType>([
  [".csv", "text/csv"],
  [".json", "application/json"],
  [".md", "text/markdown"],
  [".pdf", "application/pdf"],
  [".txt", "text/plain"],
]);

type ImageMimeType = Extract<
  AgentTurnAttachment,
  { type: "image" }
>["source"]["media_type"];
type DocumentMimeType = Extract<
  AgentTurnAttachment,
  { type: "document" }
>["source"]["media_type"];

export interface ResolvedCliAttachments {
  readonly text: string;
  readonly attachments: readonly StandaloneSubmitAttachment[];
}

export async function resolveCliAttachments(
  projectRoot: string,
  text: string,
  requestedPaths: readonly string[],
): Promise<ResolvedCliAttachments> {
  const uniquePaths = [
    ...new Set(requestedPaths.map(normalizePastedPath)),
  ].filter(Boolean);
  if (uniquePaths.length > MAX_ATTACHMENTS) {
    throw new Error(`Attach at most ${MAX_ATTACHMENTS} files per message`);
  }
  const canonicalRoot = await fs.realpath(projectRoot);
  const attachments: StandaloneSubmitAttachment[] = [];
  const inlineText: string[] = [];
  let totalBytes = 0;

  for (const requestedPath of uniquePaths) {
    const absolutePath = await fs.realpath(
      path.resolve(canonicalRoot, requestedPath),
    );
    const relativePath = path.relative(canonicalRoot, absolutePath);
    if (
      relativePath === ".." ||
      relativePath.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativePath)
    ) {
      throw new Error(`Attachment is outside the project: ${requestedPath}`);
    }
    const stats = await fs.stat(absolutePath);
    if (!stats.isFile())
      throw new Error(`Attachment is not a file: ${requestedPath}`);
    if (stats.size > MAX_ATTACHMENT_BYTES) {
      throw new Error(`Attachment exceeds 10 MB: ${relativePath}`);
    }
    totalBytes += stats.size;
    if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
      throw new Error("Attachments exceed 20 MB altogether");
    }
    const content = await fs.readFile(absolutePath);
    const extension = path.extname(relativePath).toLowerCase();
    const imageMime = IMAGE_MIME_BY_EXTENSION.get(extension);
    if (imageMime) {
      const base64 = content.toString("base64");
      attachments.push({
        display: {
          name: relativePath,
          kind: "image",
          mimeType: imageMime,
          base64,
        },
        model: mediaBlock("image", imageMime, base64),
      });
      continue;
    }
    const documentMime = DOCUMENT_MIME_BY_EXTENSION.get(extension);
    if (documentMime === "application/pdf") {
      const base64 = content.toString("base64");
      attachments.push({
        display: {
          name: relativePath,
          kind: "document",
          mimeType: documentMime,
        },
        model: documentBlock(documentMime, base64, relativePath),
      });
      continue;
    }
    const decoded = decodeUtf8(content);
    if (decoded === undefined) {
      throw new Error(`Unsupported binary attachment: ${relativePath}`);
    }
    attachments.push({
      display: {
        name: relativePath,
        kind: "file",
        mimeType: documentMime ?? "text/plain",
      },
    });
    inlineText.push(`<file path="${relativePath}">\n${decoded}\n</file>`);
  }

  return {
    text: [...inlineText, text.trim()].filter(Boolean).join("\n\n"),
    attachments,
  };
}

export function attachmentPathsFromText(value: string): readonly string[] {
  return pastedAttachmentPaths(value);
}

export function pastedAttachmentPaths(value: string): readonly string[] {
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (trimmed.includes("\n")) return [];
  const candidate = normalizePastedPath(trimmed);
  return /^(?:\.?\.?\/|\/)?[^\s@]+\.[A-Za-z0-9]{1,8}$/u.test(candidate)
    ? [candidate]
    : [];
}

function normalizePastedPath(value: string): string {
  const trimmed = value.trim();
  const unquoted =
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
      ? trimmed.slice(1, -1)
      : trimmed;
  return unquoted.replaceAll("\\ ", " ");
}

function mediaBlock(
  type: "image",
  mediaType: ImageMimeType,
  data: string,
): Extract<AgentTurnAttachment, { type: "image" }> {
  return {
    type,
    source: { type: "base64", media_type: mediaType, data },
  };
}

function documentBlock(
  mediaType: DocumentMimeType,
  data: string,
  title: string,
): Extract<AgentTurnAttachment, { type: "document" }> {
  return {
    type: "document",
    source: { type: "base64", media_type: mediaType, data },
    title,
  };
}

function decodeUtf8(content: Buffer): string | undefined {
  if (content.includes(0)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    return undefined;
  }
}
