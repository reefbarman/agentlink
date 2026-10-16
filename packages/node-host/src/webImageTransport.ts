import type { Transform } from "node:stream";
import * as zlib from "node:zlib";
import { isIP, type LookupFunction } from "node:net";
import { Agent, request, type Dispatcher } from "undici";
import {
  createPublicOnlyLookup,
  isLocalHostname,
  NonPublicDestinationError,
} from "./webImagePublicAddress.js";
import { WebImageError } from "./webImageErrors.js";

const USER_AGENT =
  "Mozilla/5.0 (compatible; AgentLink image preview; +https://github.com/reefbarman/agentlink)";
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface PublicFetchRequest {
  url: URL;
  accept: string;
  /** Hard cap on decoded body bytes. */
  maxBytes: number;
  /**
   * When true, keep the first maxBytes decoded bytes and stop reading instead
   * of failing. Used for HTML, where the useful metadata is near the top.
   */
  truncateAtLimit?: boolean;
  maxRedirects: number;
  deadlineMs: number;
  signal?: AbortSignal;
  /**
   * Called before every connection, including each redirect hop. Throw a
   * WebImageError to refuse the destination; no connection is made.
   */
  authorize(url: URL, hop: number): Promise<void>;
}

export interface PublicFetchResult {
  requestedUrl: URL;
  finalUrl: URL;
  status: number;
  contentType: string | undefined;
  body: Buffer;
  /** True when truncateAtLimit cut the body short. */
  truncated?: boolean;
}

export type PublicWebFetcher = (
  request: PublicFetchRequest,
) => Promise<PublicFetchResult>;

const PROXY_ENV_KEYS = [
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "ALL_PROXY",
  "all_proxy",
] as const;

export function hasProxyRequirement(env: NodeJS.ProcessEnv): boolean {
  return PROXY_ENV_KEYS.some((key) => Boolean(env[key]?.trim()));
}

/**
 * Static URL validation before any connection: public HTTP(S), default
 * ports, no credentials, no IP literals, no local hostnames.
 */
export function assertPublicHttpUrl(url: URL): void {
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new WebImageError(
      "unsupported_url",
      `Only http(s) URLs are supported, got ${url.protocol}`,
    );
  }
  if (url.username || url.password) {
    throw new WebImageError(
      "unsupported_url",
      "URLs containing credentials are not supported",
    );
  }
  if (url.port !== "") {
    throw new WebImageError(
      "blocked_destination",
      "Only default HTTP(S) ports are supported",
    );
  }
  const hostname = url.hostname.replace(/^\[|\]$/gu, "");
  if (isIP(hostname) !== 0 || isLocalHostname(hostname)) {
    throw new WebImageError(
      "blocked_destination",
      "IP-address, local and intranet hosts are blocked; use a public hostname",
    );
  }
}

/**
 * A fetcher whose only network route is a dedicated undici Agent with a
 * public-only connection-time lookup. It never uses globalThis.fetch, the
 * process-global dispatcher, DNS caching interceptors or model-traffic pools,
 * and it refuses to run (rather than bypass) when a proxy is required.
 */
export function createPublicWebFetcher(
  options: {
    lookup?: LookupFunction;
    env?: NodeJS.ProcessEnv;
    dispatcher?: Dispatcher;
  } = {},
): PublicWebFetcher & { dispose(): Promise<void> } {
  const env = options.env ?? process.env;
  const dispatcher =
    options.dispatcher ??
    new Agent({
      connect: {
        lookup: createPublicOnlyLookup(options.lookup),
        // Certificate and hostname verification stay at Node defaults.
        rejectUnauthorized: true,
      },
      keepAliveTimeout: 10_000,
      connections: 2,
      headersTimeout: 15_000,
      bodyTimeout: 15_000,
    });

  const fetcher = async (
    req: PublicFetchRequest,
  ): Promise<PublicFetchResult> => {
    if (hasProxyRequirement(env)) {
      throw new WebImageError(
        "image_retrieval_proxy_unsupported",
        "A network proxy is configured. Direct image retrieval is not supported through proxies yet, so it was not attempted.",
      );
    }
    const visited = new Set<string>();
    let current = req.url;
    for (let hop = 0; ; hop++) {
      assertPublicHttpUrl(current);
      if (visited.has(current.href)) {
        throw new WebImageError("too_many_redirects", "Redirect loop detected");
      }
      visited.add(current.href);
      // Consent waits happen before the network deadline starts.
      await req.authorize(current, hop);
      if (req.signal?.aborted) {
        throw new WebImageError("cancelled", "Retrieval was cancelled");
      }
      const deadline = AbortSignal.timeout(req.deadlineMs);
      const signal = req.signal
        ? AbortSignal.any([req.signal, deadline])
        : deadline;

      let response: Dispatcher.ResponseData;
      try {
        response = await request(current, {
          method: "GET",
          dispatcher,
          signal,
          headers: {
            accept: req.accept,
            "accept-encoding": "gzip, deflate, br",
            "user-agent": USER_AGENT,
          },
        });
      } catch (error) {
        throw translateTransportError(error, req.signal, deadline);
      }

      if (REDIRECT_STATUSES.has(response.statusCode)) {
        await response.body.dump().catch(() => undefined);
        const location = headerValue(response.headers.location);
        if (!location) {
          throw new WebImageError(
            "fetch_failed",
            `Redirect status ${response.statusCode} without a location`,
          );
        }
        if (hop >= req.maxRedirects) {
          throw new WebImageError(
            "too_many_redirects",
            `More than ${req.maxRedirects} redirects`,
          );
        }
        let next: URL;
        try {
          next = new URL(location, current);
        } catch {
          throw new WebImageError("fetch_failed", "Invalid redirect location");
        }
        if (current.protocol === "https:" && next.protocol === "http:") {
          throw new WebImageError(
            "blocked_destination",
            "Refused HTTPS to HTTP redirect downgrade",
          );
        }
        current = next;
        continue;
      }

      if (response.statusCode === 429) {
        await response.body.dump().catch(() => undefined);
        throw new WebImageError(
          "rate_limited",
          "The website rate-limited this request (HTTP 429)",
        );
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        await response.body.dump().catch(() => undefined);
        throw new WebImageError(
          "fetch_failed",
          `The website returned HTTP ${response.statusCode}`,
        );
      }

      const encoding = headerValue(response.headers["content-encoding"])
        ?.trim()
        .toLowerCase();
      const { body, truncated } = await readDecodedBounded(
        response.body,
        encoding,
        req.maxBytes,
        req.truncateAtLimit === true,
        signal,
        req.signal,
        deadline,
      );
      return {
        requestedUrl: req.url,
        finalUrl: current,
        status: response.statusCode,
        contentType: headerValue(response.headers["content-type"]),
        body,
        ...(truncated ? { truncated } : {}),
      };
    }
  };

  return Object.assign(fetcher, {
    dispose: async () => {
      if (!options.dispatcher) await dispatcher.close();
    },
  });
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function createDecoder(encoding: string | undefined): Transform | undefined {
  switch (encoding) {
    case undefined:
    case "":
    case "identity":
      return undefined;
    case "gzip":
    case "x-gzip":
      return zlib.createGunzip();
    case "deflate":
      return zlib.createInflate();
    case "br":
      return zlib.createBrotliDecompress();
    default:
      throw new WebImageError(
        "fetch_failed",
        `Unsupported content encoding: ${encoding}`,
      );
  }
}

/**
 * Decode while streaming so the decoded-size cap is enforced without first
 * buffering the whole compressed body. With `truncate`, the first maxBytes
 * decoded bytes are kept and the connection is closed early.
 */
async function readDecodedBounded(
  body: Dispatcher.ResponseData["body"],
  encoding: string | undefined,
  maxBytes: number,
  truncate: boolean,
  signal: AbortSignal,
  callerSignal: AbortSignal | undefined,
  deadline: AbortSignal,
): Promise<{ body: Buffer; truncated: boolean }> {
  let decoder: Transform | undefined;
  try {
    decoder = createDecoder(encoding);
  } catch (error) {
    body.destroy();
    throw error;
  }
  let decodeFailed = false;
  if (decoder) {
    const target = decoder;
    target.on("error", () => {
      decodeFailed = true;
    });
    body.on("error", (error) => target.destroy(error));
  }
  const source: AsyncIterable<Buffer | Uint8Array> = decoder
    ? body.pipe(decoder)
    : body;
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;
  const close = () => {
    body.destroy();
    decoder?.destroy();
  };
  try {
    for await (const chunk of source) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (total + buffer.byteLength > maxBytes) {
        if (!truncate) {
          close();
          throw new WebImageError(
            "byte_limit",
            `Response exceeds the ${formatBytes(maxBytes)} limit`,
          );
        }
        chunks.push(buffer.subarray(0, maxBytes - total));
        total = maxBytes;
        truncated = true;
        close();
        break;
      }
      total += buffer.byteLength;
      chunks.push(buffer);
    }
  } catch (error) {
    close();
    if (error instanceof WebImageError) throw error;
    if (signal.aborted) throw abortError(callerSignal, deadline);
    throw new WebImageError(
      "fetch_failed",
      decodeFailed
        ? "Decoding the response failed"
        : "Reading the response failed",
    );
  }
  return { body: Buffer.concat(chunks, total), truncated };
}

function abortError(
  callerSignal: AbortSignal | undefined,
  deadline: AbortSignal,
): WebImageError {
  if (callerSignal?.aborted) {
    return new WebImageError("cancelled", "Retrieval was cancelled");
  }
  if (deadline.aborted) {
    return new WebImageError("timeout", "The website did not respond in time");
  }
  return new WebImageError("cancelled", "Retrieval was cancelled");
}

function translateTransportError(
  error: unknown,
  callerSignal: AbortSignal | undefined,
  deadline: AbortSignal,
): WebImageError {
  if (error instanceof WebImageError) return error;
  if (callerSignal?.aborted || deadline.aborted) {
    return abortError(callerSignal, deadline);
  }
  if (hasCause(error, NonPublicDestinationError)) {
    return new WebImageError(
      "blocked_destination",
      "The hostname resolves to a private, local or reserved address",
    );
  }
  const code = (error as { code?: unknown } | undefined)?.code;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return new WebImageError(
      "fetch_failed",
      "The hostname could not be resolved",
    );
  }
  if (typeof code === "string" && code.startsWith("ERR_TLS")) {
    return new WebImageError("fetch_failed", "TLS verification failed");
  }
  if (
    typeof code === "string" &&
    (code.includes("CERT") || code.includes("SELF_SIGNED"))
  ) {
    return new WebImageError("fetch_failed", "TLS verification failed");
  }
  return new WebImageError("fetch_failed", "Could not connect to the website");
}

function hasCause(
  error: unknown,
  type: new (...args: never[]) => Error,
): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth++) {
    if (current instanceof type) return true;
    if (
      (current as { message?: unknown }).message ===
      "web_image_destination_not_public"
    ) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(bytes % (1024 * 1024) === 0 ? 0 : 1)} MiB`
    : `${Math.ceil(bytes / 1024)} KiB`;
}
