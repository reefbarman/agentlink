import {
  defineTool,
  normalizeCoreWebAccessSettings,
  type HostTool,
  type HostToolExecutionContext,
  type HostToolResolver,
  type HostToolResult,
} from "@agentlink/core";
import type { CodexResolvedAuthForClient } from "@agentlink/core/codex";
import type { CoreNativeWebToolResult } from "@agentlink/core/native-web-tools";

import {
  canUseCodexStandaloneWeb,
  executeCodexStandaloneWeb,
  type CodexStandaloneWebRequest,
} from "../../../src/core/model/providers/codex/standaloneWeb.js";
import type { NetworkPolicy } from "./egressPolicy.js";
import {
  fetchWebPage,
  WebFetchError,
  type FetchedPage,
  type WebConnector,
} from "./webFetch.js";

/**
 * Web tools for assistant chats, governed by the project's network preset:
 *
 * - `off`: no web tools.
 * - `dependencies`: `web_fetch` only, limited to the dependency hosts and
 *   the project's extra sites (the same rules its commands get).
 * - `open`: `web_fetch` for any public site, and `web_search`.
 *
 * `web_search` uses Codex's hosted search for Codex (ChatGPT sign-in)
 * models, and SearXNG for every other model when one is configured. Search
 * is only offered on the open preset: a query leaves the server whatever
 * the project allows.
 */

export const WEB_FETCH_DEFAULT_LENGTH = 20_000;
export const WEB_FETCH_MAX_LENGTH = 60_000;
const SEARCH_DEFAULT_RESULTS = 8;
const SEARCH_MAX_RESULTS = 20;
const SEARXNG_TIMEOUT_MS = 15_000;
const MAX_SEARXNG_RESPONSE_BYTES = 2 * 1024 * 1024;

export interface WebToolsOptions {
  /** The project's current policy, read every turn and every call. */
  readonly policy: () => NetworkPolicy;
  readonly connector: WebConnector;
  /** Codex hosted search, for models of these providers. */
  readonly codex?: {
    readonly providerIds: ReadonlySet<string>;
    readonly resolveAuth: () => Promise<CodexResolvedAuthForClient | null>;
    /** Test seam. */
    readonly search?: (
      request: CodexStandaloneWebRequest,
    ) => Promise<CoreNativeWebToolResult>;
  };
  /** SearXNG base URL, for every other model. */
  readonly searxngUrl?: string;
  /** Test seams. */
  readonly fetchPage?: typeof fetchWebPage;
  readonly fetch?: typeof globalThis.fetch;
}

export function createWebTools(options: WebToolsOptions): HostToolResolver {
  const webFetch = webFetchTool(options);
  const webSearch =
    options.codex || options.searxngUrl ? webSearchTool(options) : undefined;
  return () => {
    const { preset } = options.policy();
    if (preset === "off") return [];
    if (preset === "dependencies" || !webSearch) return [webFetch];
    return [webFetch, webSearch];
  };
}

function webFetchTool(options: WebToolsOptions): HostTool {
  const fetchPage = options.fetchPage ?? fetchWebPage;
  return defineTool({
    name: "web_fetch",
    description:
      "Read a public web page (HTTPS, port 443) as text. HTML is converted to readable text with links kept as `text (url)`. Long pages are returned in parts: pass `start_index` from the previous result to continue. The project's network settings decide which sites can be read.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        url: {
          type: "string",
          description: "Absolute http(s) URL to read (http is upgraded)",
        },
        max_length: {
          type: "integer",
          minimum: 1,
          maximum: WEB_FETCH_MAX_LENGTH,
          description: `Maximum characters to return (default ${WEB_FETCH_DEFAULT_LENGTH})`,
        },
        start_index: {
          type: "integer",
          minimum: 0,
          description: "Character offset to start from, to continue a page",
        },
      },
      required: ["url"],
    },
    effect: "read",
    parallelSafe: true,
    presentation: { title: "Read web page" },
    handler: async (input, context) => {
      const url = String(input.url);
      try {
        const page = await fetchPage({
          url,
          policy: options.policy(),
          connector: options.connector,
          ...(context.signal ? { signal: context.signal } : {}),
        });
        return formatPage(
          page,
          typeof input.start_index === "number" ? input.start_index : 0,
          typeof input.max_length === "number"
            ? input.max_length
            : WEB_FETCH_DEFAULT_LENGTH,
        );
      } catch (error) {
        return failure(
          error instanceof WebFetchError
            ? error.message
            : `Fetching ${url} failed`,
        );
      }
    },
  });
}

/** One window of a page, with a pointer to the next one. */
export function formatPage(
  page: FetchedPage,
  startIndex: number,
  maxLength: number,
): HostToolResult {
  const length = Math.min(Math.max(1, maxLength), WEB_FETCH_MAX_LENGTH);
  const start = Math.min(Math.max(0, startIndex), page.text.length);
  const end = Math.min(page.text.length, start + length);
  const header = [
    `URL: ${page.url}`,
    ...(page.title ? [`Title: ${page.title}`] : []),
    `Status: ${page.status} (${page.contentType})`,
  ];
  if (start > 0 || end < page.text.length) {
    header.push(
      `Showing characters ${start}-${end} of ${page.text.length}${page.bodyTruncated ? " (the page was cut at the size limit)" : ""}`,
    );
  } else if (page.bodyTruncated) {
    header.push("The page was cut at the size limit.");
  }
  const body = page.text.slice(start, end) || "(no readable text)";
  const footer =
    end < page.text.length
      ? `\n\n[More content: call web_fetch again with start_index ${end}]`
      : "";
  return {
    modelContent: `${header.join("\n")}\n\n${body}${footer}`,
    displayContent: {
      url: page.url,
      ...(page.title ? { title: page.title } : {}),
      status: page.status,
    },
    ...(page.status >= 400 ? { isError: true } : {}),
  };
}

function webSearchTool(options: WebToolsOptions): HostTool {
  return defineTool({
    name: "web_search",
    description:
      "Search the public web. Returns titles, URLs and snippets; read a result with web_fetch.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string", minLength: 1, description: "Search query" },
        max_results: {
          type: "integer",
          minimum: 1,
          maximum: SEARCH_MAX_RESULTS,
          description: `Maximum results (default ${SEARCH_DEFAULT_RESULTS})`,
        },
        time_range: {
          type: "string",
          enum: ["day", "week", "month", "year"],
          description: "Only results from this recent period",
        },
        language: {
          type: "string",
          description: "Language code such as en or fr",
        },
      },
      required: ["query"],
    },
    effect: "read",
    parallelSafe: true,
    presentation: { title: "Search the web" },
    handler: async (input, context) => {
      if (options.policy().preset !== "open") {
        return failure("Web search is only available on the Open web preset");
      }
      const providerId = context.model.model.providerId;
      if (options.codex?.providerIds.has(providerId)) {
        return await codexSearch(options.codex, input, context);
      }
      if (options.searxngUrl) {
        return await searxngSearch(
          options.searxngUrl,
          options.fetch ?? globalThis.fetch,
          input,
          context.signal,
        );
      }
      return failure(
        "Web search is not available for this model: it needs a Codex model, or a SearXNG server set in the assistant's web.searxngUrl",
      );
    },
  });
}

async function codexSearch(
  codex: NonNullable<WebToolsOptions["codex"]>,
  input: Record<string, unknown>,
  context: HostToolExecutionContext,
): Promise<HostToolResult> {
  const auth = await codex.resolveAuth().catch(() => null);
  if (!auth || !canUseCodexStandaloneWeb(auth)) {
    return failure(
      "Codex web search needs a ChatGPT sign-in (run `agentlink-server codex-login`)",
    );
  }
  try {
    const result = await (codex.search ?? executeCodexStandaloneWeb)({
      auth,
      sessionId: context.sessionId,
      model: context.model.model.modelId,
      operation: "search",
      input: {
        query: input.query,
        max_results: input.max_results ?? SEARCH_DEFAULT_RESULTS,
        ...(input.time_range ? { time_range: input.time_range } : {}),
        ...(input.language ? { language: input.language } : {}),
      },
      settings: normalizeCoreWebAccessSettings({ nativeSearchMode: "live" }),
      ...(context.signal ? { signal: context.signal } : {}),
    });
    return {
      modelContent: result.content,
      displayContent: {
        backend: "codex",
        results: result.citations.length,
      },
    };
  } catch {
    return failure("Codex web search failed; try again or rephrase");
  }
}

interface SearxngResult {
  readonly title: string;
  readonly url: string;
  readonly content: string;
}

export async function searxngSearch(
  baseUrl: string,
  fetchImpl: typeof globalThis.fetch,
  input: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<HostToolResult> {
  const query = String(input.query).trim();
  const limit = Math.min(
    SEARCH_MAX_RESULTS,
    Math.max(
      1,
      typeof input.max_results === "number"
        ? input.max_results
        : SEARCH_DEFAULT_RESULTS,
    ),
  );
  const url = new URL(`${baseUrl}/search`);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  if (typeof input.time_range === "string") {
    url.searchParams.set("time_range", input.time_range);
  }
  if (typeof input.language === "string" && input.language.trim()) {
    url.searchParams.set("language", input.language.trim());
  }
  const timeout = AbortSignal.timeout(SEARXNG_TIMEOUT_MS);
  let payload: unknown;
  try {
    const response = await fetchImpl(url, {
      headers: { accept: "application/json" },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) {
      return failure(
        response.status === 403
          ? "SearXNG refused the request: enable the json format in its settings.yml (search.formats)"
          : `SearXNG answered ${response.status}`,
      );
    }
    const text = await response.text();
    if (text.length > MAX_SEARXNG_RESPONSE_BYTES) {
      return failure("SearXNG returned too much data");
    }
    payload = JSON.parse(text);
  } catch {
    return failure("Could not reach SearXNG, or it returned invalid JSON");
  }
  const results = searxngResults(payload).slice(0, limit);
  if (results.length === 0) {
    return { modelContent: `No results for "${query}".` };
  }
  return {
    modelContent: [
      `Search results for "${query}":`,
      ...results.map((result, index) =>
        [
          `${index + 1}. ${result.title || result.url}`,
          `   ${result.url}`,
          ...(result.content ? [`   ${result.content}`] : []),
        ].join("\n"),
      ),
    ].join("\n\n"),
    displayContent: { backend: "searxng", results: results.length },
  };
}

function searxngResults(payload: unknown): SearxngResult[] {
  const raw =
    payload && typeof payload === "object"
      ? (payload as { results?: unknown }).results
      : undefined;
  if (!Array.isArray(raw)) return [];
  const results: SearxngResult[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const { title, url, content } = item as Record<string, unknown>;
    if (typeof url !== "string" || !/^https?:\/\//iu.test(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    results.push({
      title: typeof title === "string" ? oneLine(title, 200) : "",
      url,
      content: typeof content === "string" ? oneLine(content, 400) : "",
    });
  }
  return results;
}

function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/gu, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function failure(message: string): HostToolResult {
  return { modelContent: message, isError: true };
}
