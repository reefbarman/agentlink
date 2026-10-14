function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Class of the placeholder that StreamingText turns into a MarkdownImage. */
export const MARKDOWN_IMAGE_PLACEHOLDER_CLASS = "markdown-image-slot";

/**
 * Markdown `![alt](source)` renders as an inert placeholder. The transcript
 * never puts `source` in an `<img src>`: StreamingText mounts a MarkdownImage
 * there, which asks the host to resolve the source (web URL, session image ID
 * or local file) and shows the result with the shared image viewer.
 */
export function renderMarkdownImagePlaceholder({
  href,
  title,
  text,
}: {
  href: string;
  title?: string | null;
  text: string;
}): string {
  const titleAttr = title
    ? ` data-markdown-image-title="${escapeHtml(title)}"`
    : "";
  return `<span class="${MARKDOWN_IMAGE_PLACEHOLDER_CLASS}" data-markdown-image-src="${escapeHtml(href)}" data-markdown-image-alt="${escapeHtml(text)}"${titleAttr}>${escapeHtml(text.trim() || "image")}</span>`;
}
