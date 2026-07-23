import { readFile, realpath } from "fs/promises";
import * as path from "path";

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
