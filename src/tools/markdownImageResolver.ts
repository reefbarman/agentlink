import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type {
  MarkdownImageResolution,
  MarkdownImageResolveRequest,
} from "../shared/markdownImageSource.js";
import type { WebImagePolicy, WebImageToolRuntime } from "@agentlink/node-host";

import type { SessionImageReference } from "../core/tools/types.js";
import { classifyMarkdownImageSource } from "../shared/markdownImageSource.js";

/** Largest local image file the transcript will display. */
export const MAX_LOCAL_MARKDOWN_IMAGE_BYTES = 16 * 1024 * 1024;

export interface LocalMarkdownImage {
  base64: string;
  mimeType: string;
  name: string;
}

export interface MarkdownImageResolverContext {
  sessionId: string;
  getSessionImages: () => readonly SessionImageReference[];
  /**
   * Transcript messages. A web image loads without a click only when its URL
   * already appeared in content the user or a tool supplied; assistant text
   * never counts, so injected instructions cannot make the transcript fetch
   * a URL of the model's choosing.
   */
  getMessages: () => readonly unknown[];
  web?: {
    runtime: Pick<WebImageToolRuntime, "fetchForDisplay">;
    policy: WebImagePolicy;
  };
  /** Reads a local image file, or throws with a user-facing reason. */
  readLocalImage?: (filePath: string) => Promise<LocalMarkdownImage>;
  signal?: AbortSignal;
}

function dataUrl(mimeType: string, base64: string): string {
  return `data:${mimeType};base64,${base64}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Resolves one Markdown image source for transcript display. */
export async function resolveMarkdownImage(
  request: MarkdownImageResolveRequest,
  ctx: MarkdownImageResolverContext,
): Promise<MarkdownImageResolution> {
  const source = classifyMarkdownImageSource(request.src);
  if (!source) {
    return { status: "unavailable", message: "Unsupported image source." };
  }
  switch (source.kind) {
    case "data": {
      const mimeType = /^data:([^;,]+)/i.exec(source.src)?.[1] ?? "image/png";
      return { status: "ready", src: source.src, mimeType };
    }
    case "session": {
      const image = ctx
        .getSessionImages()
        .find((candidate) => candidate.id === source.imageId);
      if (!image) {
        return {
          status: "unavailable",
          message: `No image ${source.imageId} in this chat.`,
        };
      }
      return {
        status: "ready",
        src: dataUrl(image.mimeType, image.base64),
        mimeType: image.mimeType,
        name: image.name,
        ...(image.attribution ? { attribution: image.attribution } : {}),
      };
    }
    case "file": {
      if (!ctx.readLocalImage) {
        return {
          status: "unavailable",
          message: "Local image files cannot be shown here.",
        };
      }
      try {
        const image = await ctx.readLocalImage(source.path);
        return {
          status: "ready",
          src: dataUrl(image.mimeType, image.base64),
          mimeType: image.mimeType,
          name: image.name,
        };
      } catch (error) {
        return { status: "unavailable", message: errorMessage(error) };
      }
    }
    case "web": {
      // A web image already in the chat (for example from present_images)
      // displays from its stored bytes without another download.
      const stored = [...ctx.getSessionImages()]
        .reverse()
        .find(
          (image) =>
            image.attribution?.imageUrl === source.url ||
            image.attribution?.imageUrl === request.src.trim(),
        );
      if (stored) {
        return {
          status: "ready",
          src: dataUrl(stored.mimeType, stored.base64),
          mimeType: stored.mimeType,
          name: stored.name,
          ...(stored.attribution ? { attribution: stored.attribution } : {}),
        };
      }
      if (!ctx.web || ctx.web.policy.mode === "disabled") {
        return {
          status: "unavailable",
          message:
            "Web images are turned off in AgentLink's web access settings.",
        };
      }
      const automatic =
        ctx.web.policy.mode === "enabled" &&
        urlAppearsInConversation(ctx.getMessages(), [
          request.src.trim(),
          source.url,
        ]);
      if (!automatic && !request.userConfirmed) {
        return { status: "needs_confirmation", host: source.host };
      }
      try {
        const image = await ctx.web.runtime.fetchForDisplay(source.url, {
          sessionId: ctx.sessionId,
          policy: ctx.web.policy,
          signal: ctx.signal,
        });
        return {
          status: "ready",
          src: dataUrl(image.mimeType, image.data.toString("base64")),
          mimeType: image.mimeType,
          attribution: image.attribution,
        };
      } catch (error) {
        return { status: "unavailable", message: errorMessage(error) };
      }
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * True when any needle appears in non-assistant transcript content: user
 * messages and tool results such as web_search, web_fetch and
 * inspect_page_images. Image bytes are skipped.
 */
export function urlAppearsInConversation(
  messages: readonly unknown[],
  urls: readonly string[],
): boolean {
  const needles = new Set<string>();
  for (const url of urls) {
    if (!url) continue;
    needles.add(url);
    needles.add(url.replace(/&/g, "&amp;"));
    needles.add(url.replace(/\//g, "\\/"));
  }
  const visit = (value: unknown, depth: number): boolean => {
    if (depth > 12) return false;
    if (typeof value === "string") {
      for (const needle of needles) if (value.includes(needle)) return true;
      return false;
    }
    if (Array.isArray(value)) {
      return value.some((entry) => visit(entry, depth + 1));
    }
    if (!isRecord(value)) return false;
    if (value.type === "image" || value.type === "document") {
      return isRecord(value.attribution)
        ? visit(value.attribution, depth + 1)
        : false;
    }
    for (const [key, entry] of Object.entries(value)) {
      if (key === "data" || key === "base64") continue;
      if (visit(entry, depth + 1)) return true;
    }
    return false;
  };
  return messages.some(
    (message) =>
      isRecord(message) && message.role !== "assistant" && visit(message, 0),
  );
}

const IMAGE_MIME_BY_EXTENSION = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
]);

function sniffImageMimeType(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
    return "image/png";
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  const head = bytes.subarray(0, 12).toString("latin1");
  if (head.startsWith("GIF87a") || head.startsWith("GIF89a")) {
    return "image/gif";
  }
  if (head.startsWith("RIFF") && head.slice(8, 12) === "WEBP") {
    return "image/webp";
  }
  return undefined;
}

function isWithin(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

/**
 * Reads PNG, JPEG, GIF or WebP files inside the given roots (plus the OS
 * temporary directory, where generated images are often saved). Relative
 * paths resolve against the first root.
 */
export function createLocalMarkdownImageReader(
  getRoots: () => readonly string[],
): (filePath: string) => Promise<LocalMarkdownImage> {
  return async (filePath) => {
    const roots = getRoots().filter(Boolean);
    const expanded = filePath.startsWith("~/")
      ? path.join(os.homedir(), filePath.slice(2))
      : filePath;
    const requested = path.isAbsolute(expanded)
      ? expanded
      : roots[0]
        ? path.resolve(roots[0], expanded)
        : undefined;
    if (!requested) throw new Error("No workspace folder to resolve the path.");
    const mimeFromName = IMAGE_MIME_BY_EXTENSION.get(
      path.extname(requested).toLowerCase(),
    );
    if (!mimeFromName) {
      throw new Error("Only PNG, JPEG, GIF and WebP files can be shown.");
    }
    let canonical: string;
    try {
      canonical = await fs.promises.realpath(requested);
    } catch {
      throw new Error(`Image file not found: ${filePath}`);
    }
    const allowedRoots = await Promise.all(
      [...roots, os.tmpdir()].map((root) =>
        fs.promises.realpath(root).catch(() => root),
      ),
    );
    if (!allowedRoots.some((root) => isWithin(canonical, root))) {
      throw new Error(
        "Only images inside the workspace or the temporary folder can be shown.",
      );
    }
    const stat = await fs.promises.stat(canonical);
    if (!stat.isFile()) throw new Error(`Not a file: ${filePath}`);
    if (stat.size > MAX_LOCAL_MARKDOWN_IMAGE_BYTES) {
      throw new Error("Image file is larger than 16 MiB.");
    }
    const bytes = await fs.promises.readFile(canonical);
    const mimeType = sniffImageMimeType(bytes);
    if (!mimeType) throw new Error("The file is not a supported image.");
    return {
      base64: bytes.toString("base64"),
      mimeType,
      name: path.basename(canonical),
    };
  };
}
