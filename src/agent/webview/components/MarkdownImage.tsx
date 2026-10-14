import type {
  MarkdownImageResolution,
  MarkdownImageResolveRequest,
} from "../../../shared/markdownImageSource";
import { ImagePreview, type OpenImageInEditor } from "./ImagePreview";
import { ImageSourceCaption, safeExternalHref } from "./ImageSourceCaption";
import { createContext, type ComponentChildren } from "preact";
import { useContext, useEffect, useMemo, useRef, useState } from "preact/hooks";

import { classifyMarkdownImageSource } from "../../../shared/markdownImageSource";

export type ResolveMarkdownImage = (
  request: MarkdownImageResolveRequest,
) => Promise<MarkdownImageResolution>;

export interface MarkdownImageHost {
  resolve: (
    src: string,
    userConfirmed: boolean,
  ) => Promise<MarkdownImageResolution>;
  /** Settled result for src, so remounted images render without flicker. */
  peek: (src: string) => MarkdownImageResolution | undefined;
  onOpenInEditor?: OpenImageInEditor;
}

const MarkdownImageContext = createContext<MarkdownImageHost | null>(null);

const MAX_CACHED_RESOLUTIONS = 64;

/**
 * Supplies the host resolver for Markdown images in transcripts. Results are
 * cached per scope (one session on one surface); the streaming renderer
 * remounts images on every reveal step.
 */
export function MarkdownImageProvider({
  scopeKey,
  sessionId,
  resolve,
  onOpenInEditor,
  children,
}: {
  scopeKey: string;
  sessionId?: string;
  resolve: ResolveMarkdownImage;
  onOpenInEditor?: OpenImageInEditor;
  children: ComponentChildren;
}) {
  const latest = useRef({ resolve, sessionId });
  latest.current = { resolve, sessionId };
  const host = useMemo<MarkdownImageHost>(() => {
    const pending = new Map<string, Promise<MarkdownImageResolution>>();
    const settled = new Map<string, MarkdownImageResolution>();
    const remember = (src: string, result: MarkdownImageResolution) => {
      settled.delete(src);
      settled.set(src, result);
      while (settled.size > MAX_CACHED_RESOLUTIONS) {
        const oldest = settled.keys().next().value;
        if (oldest === undefined) break;
        settled.delete(oldest);
      }
    };
    return {
      peek: (src) => settled.get(src),
      resolve: (src, userConfirmed) => {
        const known = settled.get(src);
        if (known && (known.status === "ready" || !userConfirmed)) {
          return Promise.resolve(known);
        }
        const key = `${userConfirmed ? "confirmed" : "auto"}\n${src}`;
        const existing = pending.get(key);
        if (existing) return existing;
        const request = latest.current
          .resolve({ src, sessionId: latest.current.sessionId, userConfirmed })
          .catch((error: unknown): MarkdownImageResolution => ({
            status: "unavailable",
            message:
              error instanceof Error ? error.message : "Image unavailable",
          }))
          .then((result) => {
            pending.delete(key);
            remember(src, result);
            return result;
          });
        pending.set(key, request);
        return request;
      },
      onOpenInEditor,
    };
    // A new scope (session or surface) starts a fresh cache; the latest
    // resolver is read through a ref so a re-created callback keeps it.
  }, [scopeKey]);
  host.onOpenInEditor = onOpenInEditor;
  return (
    <MarkdownImageContext.Provider value={host}>
      {children}
    </MarkdownImageContext.Provider>
  );
}

export function useMarkdownImageHost(): MarkdownImageHost | null {
  return useContext(MarkdownImageContext);
}

function hostLabel(href: string): string {
  try {
    return new URL(href).hostname.replace(/^www\./u, "");
  } catch {
    return href;
  }
}

function downloadName(alt: string, mimeType: string): string {
  const stem =
    alt
      .trim()
      .split("")
      .filter((character) => character >= " ")
      .join("")
      .replace(/[\\/:*?"<>|]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 60) || "image";
  const extension =
    mimeType === "image/jpeg"
      ? "jpg"
      : mimeType === "image/webp"
        ? "webp"
        : mimeType === "image/gif"
          ? "gif"
          : "png";
  return `${stem}.${extension}`;
}

function dataUrlMimeType(src: string): string {
  return /^data:([^;,]+)/i.exec(src)?.[1]?.toLowerCase() ?? "image/png";
}

/**
 * One Markdown image: resolved through the host, then shown with the shared
 * viewer (lightbox, open in editor, copy, print, download) and, for web
 * images, a source caption.
 */
export function MarkdownImage({
  src,
  alt,
  title,
  host,
}: {
  src: string;
  alt: string;
  title?: string;
  host: MarkdownImageHost | null;
}) {
  const source = useMemo(() => classifyMarkdownImageSource(src), [src]);
  const inline: MarkdownImageResolution | undefined =
    source?.kind === "data"
      ? { status: "ready", src: source.src, mimeType: dataUrlMimeType(src) }
      : undefined;
  const [result, setResult] = useState<MarkdownImageResolution | undefined>(
    () => inline ?? host?.peek(src),
  );
  const [confirmed, setConfirmed] = useState(false);

  useEffect(() => {
    if (inline || !source || !host) return;
    let current = true;
    void host.resolve(src, confirmed).then((next) => {
      if (current) setResult(next);
    });
    return () => {
      current = false;
    };
  }, [host, src, source, confirmed, inline]);

  const label = alt.trim() || title?.trim() || "Image";
  const webHref =
    source?.kind === "web" ? safeExternalHref(source.url) : undefined;
  const sourceLink = webHref ? (
    <a href={webHref} target="_blank" rel="noreferrer noopener" title={webHref}>
      {hostLabel(webHref)}
    </a>
  ) : null;

  if (result?.status === "ready") {
    const image = {
      src: result.src,
      mimeType: result.mimeType,
      name: result.name ?? downloadName(label, result.mimeType),
    };
    return (
      <span class="markdown-image" data-testid="markdown-image">
        <ImagePreview
          image={image}
          alt={label}
          className="markdown-image-img"
          buttonClassName="markdown-image-button"
          loading="lazy"
          onOpenInEditor={host?.onOpenInEditor}
          showDownload
        />
        {result.attribution ? (
          <ImageSourceCaption attribution={result.attribution} />
        ) : (
          sourceLink && (
            <span class="image-source-caption">
              <span class="image-source-link-row">
                <i class="codicon codicon-link-external" aria-hidden="true" />
                {sourceLink}
              </span>
            </span>
          )
        )}
      </span>
    );
  }

  if (result?.status === "needs_confirmation") {
    return (
      <span
        class="markdown-image markdown-image-blocked"
        data-testid="markdown-image-blocked"
      >
        <i class="codicon codicon-file-media" aria-hidden="true" />
        <span class="markdown-image-label">{label}</span>
        <button
          type="button"
          class="markdown-image-load"
          title={`This image link did not come from a search or page in this chat. Load it from ${result.host}?`}
          onClick={() => setConfirmed(true)}
        >
          Load image from {result.host.replace(/^www\./u, "")}
        </button>
      </span>
    );
  }

  if (result?.status === "unavailable" || !source || (!host && !inline)) {
    const message =
      result?.status === "unavailable"
        ? result.message
        : source
          ? "Images cannot be shown here."
          : "Unsupported image source.";
    return (
      <span
        class="markdown-image markdown-image-unavailable"
        title={message}
        data-testid="markdown-image-unavailable"
      >
        <i class="codicon codicon-file-media" aria-hidden="true" />
        <span class="markdown-image-label">{label}</span>
        {sourceLink}
      </span>
    );
  }

  return (
    <span
      class="markdown-image markdown-image-loading"
      aria-busy="true"
      data-testid="markdown-image-loading"
    >
      <i
        class="codicon codicon-loading codicon-modifier-spin"
        aria-hidden="true"
      />
      <span class="markdown-image-label">{label}</span>
    </span>
  );
}
