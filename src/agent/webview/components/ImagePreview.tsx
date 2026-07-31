import { useEffect, useRef, useState } from "preact/hooks";

import { createPortal } from "preact/compat";

export interface PreviewImage {
  src: string;
  name?: string;
  mimeType?: string;
}

interface ImagePreviewProps {
  image: PreviewImage;
  alt: string;
  className: string;
  buttonClassName: string;
  loading?: "eager" | "lazy";
  showDownload?: boolean;
}

export function imageDownloadName(image: PreviewImage): string {
  if (image.name?.trim()) return image.name.trim();
  const extension = image.mimeType === "image/jpeg" ? "jpg" : "png";
  return `agentlink-image.${extension}`;
}

export function ImagePreview({
  image,
  alt,
  className,
  buttonClassName,
  loading,
  showDownload = false,
}: ImagePreviewProps) {
  const [expanded, setExpanded] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const label = image.name || alt;

  useEffect(() => {
    if (!expanded) return;
    const dialog = dialogRef.current;
    const focusable = dialog?.querySelectorAll<HTMLElement>("a[href], button");
    focusable?.[focusable.length - 1]?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setExpanded(false);
        return;
      }
      if (event.key !== "Tab" || !focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      triggerRef.current?.focus();
    };
  }, [expanded]);

  return (
    <>
      <button
        ref={triggerRef}
        class={buttonClassName}
        type="button"
        title={`Open ${label}`}
        aria-label={`Open ${label}`}
        onClick={() => setExpanded(true)}
      >
        <img class={className} src={image.src} alt={alt} loading={loading} />
      </button>
      {expanded &&
        createPortal(
          <div
            ref={dialogRef}
            class="user-image-lightbox"
            role="dialog"
            aria-modal="true"
            aria-label={label}
            onClick={() => setExpanded(false)}
          >
            <div
              class="user-image-lightbox-content"
              onClick={(event) => event.stopPropagation()}
            >
              <div class="user-image-lightbox-header">
                <span class="user-image-lightbox-title">{label}</span>
                {showDownload && (
                  <a
                    class="icon-button user-image-lightbox-download"
                    href={image.src}
                    download={imageDownloadName(image)}
                    rel="noopener"
                    title="Download image"
                    aria-label="Download image"
                  >
                    <i class="codicon codicon-save" />
                  </a>
                )}
                <button
                  class="icon-button user-image-lightbox-close"
                  type="button"
                  title="Close"
                  aria-label="Close image preview"
                  onClick={() => setExpanded(false)}
                >
                  <i class="codicon codicon-close" />
                </button>
              </div>
              <img
                class="user-image-lightbox-image"
                src={image.src}
                alt={alt}
                title="Click to close"
                onClick={() => setExpanded(false)}
              />
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
