import * as path from "path";

import { readFile, realpath, stat } from "fs/promises";

export interface ResolvedAttachmentMedia {
  name: string;
  mimeType: string;
  base64: string;
}

export interface ResolvedAttachments {
  text: string;
  images: ResolvedAttachmentMedia[];
  documents: ResolvedAttachmentMedia[];
}

export interface ResolvedAttachmentImagePreview {
  path: string;
  mimeType: string;
  base64: string;
}

const MAX_IMAGE_PREVIEW_BYTES = 10 * 1024 * 1024;
const MAX_IMAGE_PREVIEW_TOTAL_BYTES = 20 * 1024 * 1024;
const IMAGE_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

function isPathInsideRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function decodeTextFile(content: Buffer): string | null {
  if (content.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    return null;
  }
}

function cleanAttachmentMarkers(text: string): string {
  return text.replace(/\[Attached: [^\]]+\]\n*/g, "").trim();
}

export async function resolveProjectImagePreviews(
  attachments: readonly string[],
  projectRoot: string,
): Promise<ResolvedAttachmentImagePreview[]> {
  let canonicalProjectRoot: string;
  try {
    canonicalProjectRoot = await realpath(projectRoot);
  } catch {
    return [];
  }

  const previews: ResolvedAttachmentImagePreview[] = [];
  let totalBytes = 0;
  for (const attachmentPath of attachments) {
    try {
      const mimeType =
        IMAGE_MIME_BY_EXTENSION[path.extname(attachmentPath).toLowerCase()];
      if (!mimeType) continue;
      const absolutePath = await realpath(
        path.resolve(canonicalProjectRoot, attachmentPath),
      );
      if (!isPathInsideRoot(canonicalProjectRoot, absolutePath)) continue;
      const fileSize = (await stat(absolutePath)).size;
      if (
        fileSize > MAX_IMAGE_PREVIEW_BYTES ||
        totalBytes + fileSize > MAX_IMAGE_PREVIEW_TOTAL_BYTES
      ) {
        continue;
      }
      const content = await readFile(absolutePath);
      totalBytes += content.byteLength;
      previews.push({
        path: attachmentPath,
        mimeType,
        base64: content.toString("base64"),
      });
    } catch {
      // Keep the path as a normal attachment when a preview cannot be read.
    }
  }
  return previews;
}

/**
 * Resolve workspace-path attachments without ever decoding binary files as
 * prompt text. Supported images and PDFs become model media; valid UTF-8 files
 * retain the existing inline-text behavior.
 */
export async function resolveProjectAttachments(
  text: string,
  attachments: readonly string[],
  projectRoot: string,
): Promise<ResolvedAttachments> {
  if (attachments.length === 0) {
    return { text, images: [], documents: [] };
  }

  const textBlocks: string[] = [];
  const images: ResolvedAttachmentMedia[] = [];
  const documents: ResolvedAttachmentMedia[] = [];
  let canonicalProjectRoot: string;
  try {
    canonicalProjectRoot = await realpath(projectRoot);
  } catch {
    const cleanText = cleanAttachmentMarkers(text);
    return {
      text: [
        ...attachments.map(
          (attachmentPath) =>
            `<file path="${attachmentPath}">\n[Error: could not read file]\n</file>`,
        ),
        cleanText,
      ]
        .filter(Boolean)
        .join("\n\n"),
      images,
      documents,
    };
  }

  for (const attachmentPath of attachments) {
    try {
      const absolutePath = await realpath(
        path.resolve(canonicalProjectRoot, attachmentPath),
      );
      if (!isPathInsideRoot(canonicalProjectRoot, absolutePath)) {
        throw new Error("Attachment is outside the session project");
      }

      const content = await readFile(absolutePath);
      const extension = path.extname(attachmentPath).toLowerCase();
      const imageMimeType = IMAGE_MIME_BY_EXTENSION[extension];
      if (imageMimeType) {
        images.push({
          name: attachmentPath,
          mimeType: imageMimeType,
          base64: content.toString("base64"),
        });
        continue;
      }
      if (extension === ".pdf") {
        documents.push({
          name: attachmentPath,
          mimeType: "application/pdf",
          base64: content.toString("base64"),
        });
        continue;
      }

      const decoded = decodeTextFile(content);
      if (decoded === null) {
        textBlocks.push(
          `<file path="${attachmentPath}">\n[Unsupported binary attachment]\n</file>`,
        );
        continue;
      }

      const language = extension.slice(1);
      textBlocks.push(
        `<file path="${attachmentPath}">\n\`\`\`${language}\n${decoded}\n\`\`\`\n</file>`,
      );
    } catch {
      textBlocks.push(
        `<file path="${attachmentPath}">\n[Error: could not read file]\n</file>`,
      );
    }
  }

  const cleanText = cleanAttachmentMarkers(text);
  return {
    text: [...textBlocks, cleanText].filter(Boolean).join("\n\n"),
    images,
    documents,
  };
}
