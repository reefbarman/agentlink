import { WebImageError } from "./webImageErrors.js";
import {
  createPublicWebFetcher,
  type PublicWebFetcher,
} from "./webImageTransport.js";
import {
  htmlToText,
  isHtmlContentType,
  READABLE_TEXT_CONTENT_TYPES,
} from "./webPageText.js";

/** One web page read as text. */
export interface PublicWebPage {
  /** The URL that answered, after redirects. */
  readonly url: string;
  readonly status: number;
  readonly contentType: string;
  readonly title?: string;
  /** Readable text: HTML converted, other text as is. */
  readonly text: string;
  /** The body was cut at the byte limit. */
  readonly bodyTruncated: boolean;
}

export interface PublicWebPageFetcher {
  fetchPage(request: {
    readonly url: string;
    readonly signal?: AbortSignal;
  }): Promise<PublicWebPage>;
  dispose(): Promise<void>;
}

export interface CreatePublicWebPageFetcherOptions {
  /** Test seam: replaces the public-only transport. */
  readonly fetcher?: PublicWebFetcher;
  readonly env?: NodeJS.ProcessEnv;
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
}

const DEFAULT_MAX_BYTES = 3 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 5;
const ACCEPT =
  "text/html,application/xhtml+xml,text/plain,text/markdown,application/json,application/xml;q=0.9,*/*;q=0.5";

/**
 * `web_fetch` pages for a host on this machine. Uses the same public-only
 * transport as web image retrieval: public hostnames on default ports, no
 * credentials or IP literals, every resolved address and redirect checked
 * at connection time. A configured proxy makes it refuse rather than
 * bypass the proxy. Errors are {@link WebImageError}s with safe messages.
 */
export function createPublicWebPageFetcher(
  options: CreatePublicWebPageFetcherOptions = {},
): PublicWebPageFetcher {
  const owned = options.fetcher
    ? undefined
    : createPublicWebFetcher(options.env ? { env: options.env } : {});
  const fetcher = options.fetcher ?? owned!;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  return {
    async fetchPage(request) {
      let url: URL;
      try {
        url = new URL(request.url.trim());
      } catch {
        throw new WebImageError(
          "unsupported_url",
          "The URL must be an absolute http(s) URL",
        );
      }
      url.hash = "";
      const result = await fetcher({
        url,
        accept: ACCEPT,
        maxBytes,
        truncateAtLimit: true,
        maxRedirects: MAX_REDIRECTS,
        deadlineMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        ...(request.signal ? { signal: request.signal } : {}),
        // Public-only checks run inside the transport for every hop.
        authorize: async () => undefined,
      });
      const contentType = (result.contentType ?? "")
        .split(";")[0]!
        .trim()
        .toLowerCase();
      const html = isHtmlContentType(contentType);
      if (
        contentType &&
        !html &&
        !READABLE_TEXT_CONTENT_TYPES.test(contentType)
      ) {
        throw new WebImageError(
          "fetch_failed",
          `${result.finalUrl.href} is ${contentType}, not a page that can be read as text`,
        );
      }
      const body = result.body.toString("utf8");
      const page = html
        ? htmlToText(body, result.finalUrl)
        : { text: body.trim() };
      return {
        url: result.finalUrl.href,
        status: result.status,
        contentType: contentType || "unknown",
        ...(page.title ? { title: page.title } : {}),
        text: page.text,
        bodyTruncated: result.truncated === true,
      };
    },
    dispose: async () => {
      await owned?.dispose();
    },
  };
}
