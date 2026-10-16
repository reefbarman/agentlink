import type { ImageAttribution } from "@agentlink/protocol/tool-result";

/**
 * Markdown `![alt](source)` is the one way an agent shows an image. The
 * transcript never loads `source` itself: it asks the owning host (VS Code
 * extension host or the browser gateway helper) to resolve it, so remote
 * images go through the public-only fetcher and local files through the
 * host's path rules.
 */
export interface MarkdownImageResolveRequest {
  src: string;
  /** Session that rendered the image. Hosts fall back to the foreground session. */
  sessionId?: string;
  /** True after the user clicked "Load image" on a source not seen in this chat. */
  userConfirmed?: boolean;
}

export type MarkdownImageResolution =
  | {
      status: "ready";
      /** `data:` URL the transcript can render directly. */
      src: string;
      mimeType: string;
      name?: string;
      attribution?: ImageAttribution;
    }
  | {
      /** A web image that did not appear in this chat; the user must opt in. */
      status: "needs_confirmation";
      host: string;
    }
  | { status: "unavailable"; message: string };

export type MarkdownImageSource =
  | { kind: "web"; url: string; host: string }
  | { kind: "session"; imageId: string }
  | { kind: "data"; src: string }
  | { kind: "file"; path: string };

const SESSION_IMAGE_ID_RE = /^image_\d+$/;
const DATA_IMAGE_RE =
  /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=\s]+$/i;
const URI_SCHEME_RE = /^[a-z][a-z0-9.+-]*:/i;
const WINDOWS_DRIVE_RE = /^[a-z]:[\\/]/i;

function safeDecode(value: string): string {
  try {
    return decodeURI(value);
  } catch {
    return value;
  }
}

/** Classifies a Markdown image source. Unsupported sources return undefined. */
export function classifyMarkdownImageSource(
  raw: string,
): MarkdownImageSource | undefined {
  const src = raw.trim();
  if (!src) return undefined;
  if (SESSION_IMAGE_ID_RE.test(src)) return { kind: "session", imageId: src };
  if (/^data:/i.test(src)) {
    // SVG and other data types can carry script; only raster images render.
    return DATA_IMAGE_RE.test(src) ? { kind: "data", src } : undefined;
  }
  if (/^https?:\/\//i.test(src)) {
    try {
      const url = new URL(src);
      if (url.username || url.password) return undefined;
      return { kind: "web", url: url.href, host: url.hostname };
    } catch {
      return undefined;
    }
  }
  if (/^file:\/\//i.test(src)) {
    try {
      return { kind: "file", path: decodeURIComponent(new URL(src).pathname) };
    } catch {
      return undefined;
    }
  }
  if (URI_SCHEME_RE.test(src) && !WINDOWS_DRIVE_RE.test(src)) return undefined;
  return { kind: "file", path: safeDecode(src) };
}
