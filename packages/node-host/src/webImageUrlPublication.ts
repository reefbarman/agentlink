const MAX_PUBLISHED_URL_LENGTH = 4096;
// Long opaque segments are typically signatures, tokens or session IDs.
const TOKEN_LIKE_SEGMENT = /^[A-Za-z0-9_\-=.~%+]{48,}$/u;

export interface PublishedUrl {
  /** Safe-to-persist URL, or undefined when no safe identifying form exists. */
  url?: string;
  /** True when query, fragment or path content was removed. */
  sanitized: boolean;
}

/**
 * The single URL publication rule for generated tool text, persisted image
 * attribution, UI and diagnostics. Exact request URLs (which may carry CDN
 * signatures) stay in transient host state only.
 */
export function publishUrl(input: string | URL): PublishedUrl {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { sanitized: true };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { sanitized: true };
  }
  if (url.username || url.password) return { sanitized: true };
  let sanitized = false;
  if (url.search) {
    url.search = "";
    sanitized = true;
  }
  if (url.hash) {
    url.hash = "";
    sanitized = true;
  }
  const segments = url.pathname.split("/");
  if (segments.some((segment) => TOKEN_LIKE_SEGMENT.test(segment))) {
    return { url: url.origin + "/", sanitized: true };
  }
  const href = url.href;
  if (href.length > MAX_PUBLISHED_URL_LENGTH) {
    return { url: url.origin + "/", sanitized: true };
  }
  return { url: href, sanitized };
}

/** Strip control characters and bound free text from untrusted pages. */
export function boundedText(
  value: unknown,
  maxLength: number,
): string | undefined {
  if (typeof value !== "string") return undefined;
  // oxlint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f\u007f-\u009f]+/gu, " ");
  const collapsed = cleaned.replace(/\s+/gu, " ").trim();
  if (!collapsed) return undefined;
  return collapsed.length > maxLength
    ? `${collapsed.slice(0, maxLength - 1)}…`
    : collapsed;
}
