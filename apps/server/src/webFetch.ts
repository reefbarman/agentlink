import { promises as dns } from "node:dns";
import http from "node:http";
import https from "node:https";
import net, { type Socket } from "node:net";
import tls from "node:tls";
import zlib from "node:zlib";

import { isPublicAddress, normalizeHostname } from "./egressGateway.js";
import { networkPolicyAllows, type NetworkPolicy } from "./egressPolicy.js";

/**
 * `web_fetch` for the server: read one public HTTPS page under a project's
 * network policy. With an egress gateway the request is tunnelled through
 * it with the project's signed policy, so it gets exactly the checks
 * commands get (public addresses only, the preset, the extra sites).
 * Without one, the same checks run here: the host must be allowed and every
 * address it resolves to public, and the connection goes to the checked
 * address.
 *
 * Only HTTPS is fetched: `http://` URLs are upgraded, as the gateway never
 * forwards plain HTTP. Redirects are followed (each hop checked again), and
 * bodies are bounded.
 */

export interface WebConnector {
  /** A raw TCP connection to `hostname:443`, already policy-checked. */
  connect(request: {
    readonly hostname: string;
    readonly port: number;
    readonly policy: NetworkPolicy;
    readonly signal: AbortSignal;
  }): Promise<Socket>;
}

export class WebFetchError extends Error {}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_BYTES = 3 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const USER_AGENT =
  "AgentLink-Assistant/1 (+https://github.com/reefbarman/agentlink)";

/** Tunnel through the egress gateway's CONNECT proxy. */
export function gatewayConnector(options: {
  /** `http://host:port` of the gateway. */
  readonly proxy: string;
  /** `Proxy-Authorization` for a policy, or undefined (gateway default). */
  readonly authorization: (policy: NetworkPolicy) => string | undefined;
  readonly timeoutMs?: number;
}): WebConnector {
  const proxy = new URL(options.proxy);
  return {
    connect: ({ hostname, port, policy, signal }) =>
      new Promise<Socket>((resolve, reject) => {
        const authorization = options.authorization(policy);
        const target = `${hostname}:${port}`;
        const request = http.request({
          host: proxy.hostname,
          port: Number(proxy.port),
          method: "CONNECT",
          path: target,
          agent: false,
          signal,
          timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          headers: {
            host: target,
            ...(authorization ? { "proxy-authorization": authorization } : {}),
          },
        });
        request.once("connect", (response, socket) => {
          if (response.statusCode === 200) {
            resolve(socket);
            return;
          }
          socket.destroy();
          reject(
            new WebFetchError(
              response.statusMessage ||
                `The egress gateway refused ${hostname} (${response.statusCode})`,
            ),
          );
        });
        request.once("timeout", () => {
          request.destroy(
            new WebFetchError(`Timed out connecting to ${hostname}`),
          );
        });
        request.once("error", (error) =>
          reject(
            error instanceof WebFetchError
              ? error
              : new WebFetchError(
                  `Could not reach the egress gateway: ${error.message}`,
                ),
          ),
        );
        request.end();
      }),
  };
}

/** Connect directly, after the checks the gateway would make. */
export function directConnector(
  options: {
    readonly lookup?: (hostname: string) => Promise<readonly string[]>;
    readonly connect?: (address: string, port: number) => Socket;
    readonly timeoutMs?: number;
  } = {},
): WebConnector {
  const lookup =
    options.lookup ??
    (async (hostname: string) =>
      (await dns.lookup(hostname, { all: true, family: 4 })).map(
        (entry) => entry.address,
      ));
  const open =
    options.connect ??
    ((address: string, port: number) => net.connect({ host: address, port }));
  return {
    async connect({ hostname, port, policy, signal }) {
      const decision = networkPolicyAllows(policy, hostname);
      if (!decision.allowed) {
        throw new WebFetchError(`Blocked ${hostname}: ${decision.reason}`);
      }
      const addresses = await lookup(hostname).catch(() => []);
      if (addresses.length === 0) {
        throw new WebFetchError(`${hostname} could not be resolved`);
      }
      if (addresses.some((address) => !isPublicAddress(address))) {
        throw new WebFetchError(
          `Blocked ${hostname}: it resolves to a non-public address`,
        );
      }
      const socket = open(addresses[0]!, port);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          socket.destroy();
          reject(new WebFetchError(`Timed out connecting to ${hostname}`));
        }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
        const abort = () => {
          socket.destroy();
          reject(new WebFetchError("Cancelled"));
        };
        signal.addEventListener("abort", abort, { once: true });
        socket.once("connect", () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
          resolve();
        });
        socket.once("error", (error) => {
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
          reject(
            new WebFetchError(
              `Could not connect to ${hostname}: ${error.message}`,
            ),
          );
        });
      });
      return socket;
    },
  };
}

export interface FetchedPage {
  /** The URL that answered, after redirects. */
  readonly url: string;
  readonly status: number;
  readonly contentType: string;
  readonly title?: string;
  /** Readable text: HTML converted, other text as is. */
  readonly text: string;
  /** The body was cut at the byte limit. */
  readonly bodyTruncated: boolean;
  /** The body as received (decoded), when `keepRaw` was asked for. */
  readonly raw?: string;
  /** Validators for the next conditional request. */
  readonly etag?: string;
  readonly lastModified?: string;
  /** `304 Not Modified`: unchanged since the validators sent. No body. */
  readonly notModified?: true;
}

/** Validators from an earlier response, for a conditional request. */
export interface ConditionalRequest {
  readonly etag?: string;
  readonly lastModified?: string;
}

/**
 * TLS over the policy-checked connection. Tests replace it to talk plain
 * HTTP to a local server; production always uses `tls.connect`.
 */
export type SecureSocket = (raw: Socket, hostname: string) => Promise<Socket>;

/** Validate a URL for fetching; `http:` becomes `https:`. */
export function webFetchTarget(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new WebFetchError("The URL must be an absolute http(s) URL");
  }
  if (url.protocol === "http:") {
    url.protocol = "https:";
    if (url.port === "80") url.port = "";
  }
  if (url.protocol !== "https:") {
    throw new WebFetchError("Only http and https URLs can be fetched");
  }
  if (url.username || url.password) {
    throw new WebFetchError("URLs with credentials cannot be fetched");
  }
  if (url.port && url.port !== "443") {
    throw new WebFetchError(
      "Only the standard HTTPS port (443) can be fetched",
    );
  }
  const hostname = normalizeHostname(url.hostname);
  if (!hostname) {
    throw new WebFetchError(
      `Cannot fetch ${url.hostname}: IP addresses and single-label names are not allowed`,
    );
  }
  url.hash = "";
  return url;
}

export async function fetchWebPage(options: {
  readonly url: string;
  readonly policy: NetworkPolicy;
  readonly connector: WebConnector;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  /** Send `If-None-Match` / `If-Modified-Since`; a `304` returns no body. */
  readonly conditional?: ConditionalRequest;
  /** Also return the body as received (for feeds and selectors). */
  readonly keepRaw?: boolean;
  readonly secureSocket?: SecureSocket;
}): Promise<FetchedPage> {
  if (options.policy.preset === "off") {
    throw new WebFetchError("Network access is off for this project");
  }
  const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeout])
    : timeout;
  let url = webFetchTarget(options.url);
  for (let hop = 0; ; hop += 1) {
    const response = await requestOnce(url, options, signal);
    const location = response.headers.location;
    if (
      response.statusCode &&
      [301, 302, 303, 307, 308].includes(response.statusCode) &&
      location
    ) {
      response.destroy();
      if (hop >= MAX_REDIRECTS) {
        throw new WebFetchError("Too many redirects");
      }
      url = webFetchTarget(new URL(location, url).href);
      continue;
    }
    const validators = {
      ...(header(response, "etag") ? { etag: header(response, "etag") } : {}),
      ...(header(response, "last-modified")
        ? { lastModified: header(response, "last-modified") }
        : {}),
    };
    if (response.statusCode === 304) {
      response.destroy();
      return {
        url: url.href,
        status: 304,
        contentType: "",
        text: "",
        bodyTruncated: false,
        notModified: true,
        ...validators,
      };
    }
    const page = await readPage(
      url,
      response,
      options.maxBytes ?? DEFAULT_MAX_BYTES,
      options.keepRaw === true,
    );
    return { ...page, ...validators };
  }
}

function header(
  response: http.IncomingMessage,
  name: string,
): string | undefined {
  const value = response.headers[name];
  const text = Array.isArray(value) ? value[0] : value;
  // Echoed back in a request header: printable ASCII only.
  return text && text.length <= 256 && /^[\x20-\x7e]+$/u.test(text)
    ? text
    : undefined;
}

const tlsSocket: SecureSocket = (raw, hostname) =>
  new Promise<Socket>((resolve, reject) => {
    const socket = tls.connect({
      socket: raw,
      servername: hostname,
      ALPNProtocols: ["http/1.1"],
    });
    socket.once("secureConnect", () => resolve(socket));
    socket.once("error", (error) => {
      raw.destroy();
      reject(
        new WebFetchError(`TLS with ${hostname} failed: ${error.message}`),
      );
    });
  });

async function requestOnce(
  url: URL,
  options: {
    readonly policy: NetworkPolicy;
    readonly connector: WebConnector;
    readonly conditional?: ConditionalRequest;
    readonly secureSocket?: SecureSocket;
  },
  signal: AbortSignal,
): Promise<http.IncomingMessage> {
  const hostname = url.hostname.toLowerCase();
  const raw = await options.connector.connect({
    hostname,
    port: 443,
    policy: options.policy,
    signal,
  });
  const secure = await (options.secureSocket ?? tlsSocket)(raw, hostname);
  const conditional = options.conditional;
  return await new Promise<http.IncomingMessage>((resolve, reject) => {
    const request = https.request({
      hostname,
      path: `${url.pathname}${url.search}`,
      method: "GET",
      // No `agent`: with `agent: false` Node ignores `createConnection` and
      // resolves and connects by itself, bypassing the checked connection.
      signal,
      createConnection: () => secure,
      headers: {
        "user-agent": USER_AGENT,
        accept:
          "text/html,application/xhtml+xml,text/plain,text/markdown,application/json,application/xml;q=0.9,*/*;q=0.5",
        "accept-encoding": "gzip, deflate, br",
        "accept-language": "en;q=0.9, *;q=0.5",
        ...(conditional?.etag ? { "if-none-match": conditional.etag } : {}),
        ...(conditional?.lastModified
          ? { "if-modified-since": conditional.lastModified }
          : {}),
      },
    });
    request.once("response", resolve);
    request.once("error", (error) => {
      secure.destroy();
      reject(
        error instanceof WebFetchError
          ? error
          : new WebFetchError(
              signal.aborted
                ? `Timed out or cancelled fetching ${url.href}`
                : `Fetching ${url.href} failed: ${error.message}`,
            ),
      );
    });
    request.end();
  });
}

const TEXT_TYPES =
  /^(?:text\/[a-z0-9.+-]+|application\/(?:[a-z0-9.-]+\+)?(?:json|xml)|application\/(?:javascript|x-yaml|yaml|toml))$/u;

async function readPage(
  url: URL,
  response: http.IncomingMessage,
  maxBytes: number,
  keepRaw: boolean,
): Promise<FetchedPage> {
  const contentType = (response.headers["content-type"] ?? "")
    .split(";")[0]!
    .trim()
    .toLowerCase();
  const isHtml =
    contentType === "text/html" || contentType === "application/xhtml+xml";
  if (contentType && !isHtml && !TEXT_TYPES.test(contentType)) {
    response.destroy();
    throw new WebFetchError(
      `${url.href} is ${contentType}, not a page that can be read as text`,
    );
  }
  const encoding = (response.headers["content-encoding"] ?? "").toLowerCase();
  const decoder =
    encoding === "gzip" || encoding === "x-gzip"
      ? zlib.createGunzip()
      : encoding === "deflate"
        ? zlib.createInflate()
        : encoding === "br"
          ? zlib.createBrotliDecompress()
          : undefined;
  const stream = decoder ? response.pipe(decoder) : response;
  const chunks: Buffer[] = [];
  let bytes = 0;
  let bodyTruncated = false;
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      const remaining = maxBytes - bytes;
      if (chunk.length >= remaining) {
        chunks.push(chunk.subarray(0, remaining));
        bodyTruncated = true;
        break;
      }
      chunks.push(chunk);
      bytes += chunk.length;
    }
  } catch (error) {
    throw new WebFetchError(
      `Reading ${url.href} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    response.destroy();
    decoder?.destroy();
  }
  const body = Buffer.concat(chunks).toString("utf8");
  const page = isHtml ? htmlToText(body, url) : { text: body.trim() };
  return {
    url: url.href,
    status: response.statusCode ?? 0,
    contentType: contentType || "unknown",
    ...(page.title ? { title: page.title } : {}),
    text: page.text,
    bodyTruncated,
    ...(keepRaw ? { raw: body } : {}),
  };
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  copy: "©",
  reg: "®",
  trade: "™",
  middot: "·",
  bull: "•",
};

export function decodeEntities(text: string): string {
  return text.replace(
    /&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);/giu,
    (match, entity: string) => {
      if (entity[0] === "#") {
        const code =
          entity[1] === "x" || entity[1] === "X"
            ? Number.parseInt(entity.slice(2), 16)
            : Number.parseInt(entity.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : match;
      }
      return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
    },
  );
}

/**
 * Readable text from HTML: scripts, styles and page chrome dropped, block
 * elements on their own lines, headings and list items marked, links kept
 * as `text (url)`. Not a full HTML parser, but enough to read a page.
 */
export function htmlToText(
  html: string,
  base: URL,
): { readonly title?: string; readonly text: string } {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/iu.exec(html);
  const title = titleMatch
    ? decodeEntities(titleMatch[1]!.replace(/\s+/gu, " ").trim()) || undefined
    : undefined;
  let body = html
    .replace(/<!--[\s\S]*?-->/gu, "")
    .replace(
      /<(script|style|noscript|svg|template|iframe|head|nav|footer|form)\b[\s\S]*?<\/\1\s*>/giu,
      " ",
    );
  const main = /<(main|article)\b[^>]*>([\s\S]*?)<\/\1\s*>/iu.exec(body);
  if (main && main[2]!.replace(/<[^>]+>/gu, "").trim().length > 200) {
    body = main[2]!;
  }
  body = body
    .replace(
      /<h([1-6])\b[^>]*>/giu,
      (_match, level: string) => `\n\n${"#".repeat(Number(level))} `,
    )
    .replace(/<\/h[1-6]\s*>/giu, "\n\n")
    .replace(/<li\b[^>]*>/giu, "\n- ")
    .replace(/<br\s*\/?>/giu, "\n")
    .replace(
      /<\/?(p|div|section|article|main|header|aside|ul|ol|table|tr|blockquote|pre|figure|figcaption|dl|dt|dd)\b[^>]*>/giu,
      "\n",
    )
    .replace(/<\/t[dh]\s*>/giu, " | ")
    .replace(
      /<a\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a\s*>/giu,
      (_match, dq?: string, sq?: string, bare?: string, inner = "") => {
        const label = inner.replace(/<[^>]+>/gu, "").trim();
        const href = decodeEntities(dq ?? sq ?? bare ?? "").trim();
        let absolute: string | undefined;
        try {
          const resolved = new URL(href, base);
          if (resolved.protocol === "http:" || resolved.protocol === "https:") {
            absolute = resolved.href;
          }
        } catch {
          absolute = undefined;
        }
        if (!label) return "";
        return absolute && absolute !== label
          ? `${label} (${absolute})`
          : label;
      },
    )
    .replace(/<[^>]+>/gu, "");
  const text = decodeEntities(body)
    .replace(/[ \t\f\v\u00a0]+/gu, " ")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  return { ...(title ? { title } : {}), text };
}
