import { randomUUID } from "crypto";

import { agentLinkFetch } from "../../../../util/httpDispatcher.js";
import type { CoreNativeWebToolResult } from "@agentlink/core/native-web-tools";
import type {
  CoreWebAccessSettings,
  CoreWebSearchMode,
} from "@agentlink/protocol/web-access-policy";
import type {
  CoreWebCitation,
  CoreWebToolKind,
} from "@agentlink/protocol/web-activity";
import {
  CODEX_API_BASE_URL,
  getCodexEndpointConfig,
  type CodexResolvedAuthForClient,
} from "@agentlink/core/codex";

const CODEX_STANDALONE_WEB_PATH = "alpha/search";
const DEFAULT_SEARCH_RESULT_LIMIT = 10;
const MAX_SEARCH_RESULT_LIMIT = 20;
const MAX_STANDALONE_OUTPUT_TOKENS = 16_384;
const FETCH_CHARS_PER_TOKEN = 4;

interface CodexStandaloneWebResponse {
  output?: unknown;
  results?: unknown;
}

interface CodexStandaloneWebResultRecord {
  refId?: string;
  url?: string;
  title?: string;
  snippet?: string;
}

export interface CodexStandaloneWebRequest {
  auth: CodexResolvedAuthForClient;
  sessionId: string;
  model: string;
  operation: CoreWebToolKind;
  input: Record<string, unknown>;
  settings: CoreWebAccessSettings;
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
}

export function canUseCodexStandaloneWeb(
  auth: Pick<CodexResolvedAuthForClient, "method">,
): boolean {
  return auth.method === "oauth";
}

export async function executeCodexStandaloneWeb(
  request: CodexStandaloneWebRequest,
): Promise<CoreNativeWebToolResult> {
  if (!canUseCodexStandaloneWeb(request.auth)) {
    throw new Error("Codex standalone web requires ChatGPT/Codex OAuth.");
  }

  const endpoint = getCodexEndpointConfig(request.auth, request.sessionId);
  if (endpoint.baseURL !== CODEX_API_BASE_URL) {
    throw new Error("Codex standalone web is unavailable for this endpoint.");
  }

  const prepared = prepareCodexStandaloneWebRequest(request);
  const response = await (request.fetch ?? agentLinkFetch)(
    `${endpoint.baseURL}/${CODEX_STANDALONE_WEB_PATH}`,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${request.auth.bearerToken}`,
        "Content-Type": "application/json",
        ...endpoint.defaultHeaders,
      },
      body: JSON.stringify(prepared.body),
      signal: request.signal,
    },
  );
  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(
      `Codex standalone web request failed (${response.status}): ${summarizeErrorResponse(responseText)}`,
    );
  }

  let payload: CodexStandaloneWebResponse;
  try {
    payload = JSON.parse(responseText) as CodexStandaloneWebResponse;
  } catch {
    throw new Error("Codex standalone web returned invalid JSON.");
  }

  const records = normalizeResultRecords(payload.results).filter((record) =>
    isResultAllowed(record, request.settings),
  );
  const visibleRecords =
    request.operation === "search"
      ? records.slice(0, prepared.maxResults)
      : records;
  const citations = citationsFromRecords(visibleRecords);
  const rawOutput = typeof payload.output === "string" ? payload.output : "";
  const content =
    request.operation === "search" && visibleRecords.length > 0
      ? formatSearchRecords(visibleRecords)
      : truncateVisibleContent(rawOutput, prepared.maxContentCharacters);
  if (!content.trim()) {
    throw new Error(
      `Codex standalone web ${request.operation} returned no visible content.`,
    );
  }

  const activityId =
    visibleRecords[0]?.refId ??
    `codex-web-${request.operation}-${randomUUID()}`;
  return {
    backend: "provider",
    provider: "codex",
    operation: request.operation,
    input: structuredClone(request.input),
    activities: [
      {
        id: activityId,
        kind: request.operation,
        status: "completed",
        backend: "provider",
        ...(request.operation === "search"
          ? { query: prepared.query }
          : { url: prepared.url }),
        ...(citations.length > 0 ? { citations } : {}),
      },
    ],
    content,
    citations,
  };
}

export function prepareCodexStandaloneWebRequest(
  request: Pick<
    CodexStandaloneWebRequest,
    "input" | "model" | "operation" | "sessionId" | "settings"
  >,
): {
  body: Record<string, unknown>;
  maxContentCharacters: number;
  maxResults: number;
  query?: string;
  url?: string;
} {
  const mode = request.settings.nativeSearchMode;
  const maxResults = normalizeResultLimit(request.input.max_results);
  const maxContentCharacters = resolveMaxContentCharacters(
    request.input.max_length,
    request.settings.maxFetchContentTokens,
  );
  const filters = compactObject({
    allowed_domains:
      request.settings.allowedDomains.length > 0
        ? request.settings.allowedDomains
        : undefined,
    blocked_domains:
      request.settings.blockedDomains.length > 0
        ? request.settings.blockedDomains
        : undefined,
  });

  let commands: Record<string, unknown>;
  let prompt: string;
  let query: string | undefined;
  let url: string | undefined;
  if (request.operation === "search") {
    query = requiredString(request.input.query, "query");
    const recency = searchRecencyDays(request.input.time_range);
    commands = {
      search_query: [
        compactObject({
          q: query,
          recency,
          domains:
            request.settings.allowedDomains.length > 0
              ? request.settings.allowedDomains
              : undefined,
        }),
      ],
      response_length: "short",
    };
    prompt = buildSearchInputPrompt(query, request.input);
  } else {
    url = requiredAllowedHttpUrl(request.input.url, request.settings);
    const find = optionalString(request.input.find);
    commands = find
      ? {
          find: [{ ref_id: url, pattern: find }],
          response_length: "long",
        }
      : {
          open: [{ ref_id: url }],
          response_length: "long",
        };
    prompt = buildFetchInputPrompt(url, request.input);
  }

  const requestId = `${request.sessionId}:web:${request.operation}:${randomUUID()}`;
  return {
    body: {
      id: requestId,
      model: request.model,
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: prompt }],
        },
      ],
      commands,
      settings: {
        allowed_callers: ["direct"],
        external_web_access: externalWebAccess(mode),
        ...(Object.keys(filters).length > 0 ? { filters } : {}),
      },
      max_output_tokens:
        request.operation === "search"
          ? 4_096
          : Math.min(
              MAX_STANDALONE_OUTPUT_TOKENS,
              Math.max(
                4_096,
                Math.ceil(maxContentCharacters / FETCH_CHARS_PER_TOKEN),
              ),
            ),
    },
    maxContentCharacters,
    maxResults,
    ...(query ? { query } : {}),
    ...(url ? { url } : {}),
  };
}

function externalWebAccess(mode: CoreWebSearchMode): boolean | "indexed" {
  if (mode === "cached") return false;
  if (mode === "indexed") return "indexed";
  return true;
}

function buildSearchInputPrompt(
  query: string,
  input: Record<string, unknown>,
): string {
  const preferences = compactObject({
    language: optionalString(input.language),
    safe_search: optionalString(input.safe_search),
  });
  return [
    `Search the public web for: ${query}`,
    Object.keys(preferences).length > 0
      ? `Preferences: ${JSON.stringify(preferences)}`
      : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

function buildFetchInputPrompt(
  url: string,
  input: Record<string, unknown>,
): string {
  const preferences = compactObject({
    section: optionalString(input.section),
    find: optionalString(input.find),
  });
  return [
    `Open and read this exact URL: ${url}`,
    Object.keys(preferences).length > 0
      ? `Page-reading focus: ${JSON.stringify(preferences)}`
      : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

function searchRecencyDays(value: unknown): number | undefined {
  if (value === "day") return 1;
  if (value === "week") return 7;
  if (value === "month") return 30;
  if (value === "year") return 365;
  return undefined;
}

function normalizeResultLimit(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 1) {
    return DEFAULT_SEARCH_RESULT_LIMIT;
  }
  return Math.min(numeric, MAX_SEARCH_RESULT_LIMIT);
}

function resolveMaxContentCharacters(
  requested: unknown,
  maxFetchContentTokens: number,
): number {
  const policyLimit = maxFetchContentTokens * FETCH_CHARS_PER_TOKEN;
  const numeric = Number(requested);
  if (!Number.isInteger(numeric) || numeric < 1) return policyLimit;
  return Math.min(numeric, policyLimit);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`web tool ${field} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requiredAllowedHttpUrl(
  value: unknown,
  settings: CoreWebAccessSettings,
): string {
  const raw = requiredString(value, "url");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("web_fetch url must be an absolute HTTP or HTTPS URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("web_fetch url must use HTTP or HTTPS");
  }
  if (!isHostnameAllowed(parsed.hostname, settings)) {
    throw new Error(
      `web_fetch domain is blocked by web access policy: ${parsed.hostname}`,
    );
  }
  return parsed.toString();
}

function normalizeResultRecords(
  value: unknown,
): CodexStandaloneWebResultRecord[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    const url = optionalString(record.url);
    const title = optionalString(record.title);
    const snippet = optionalString(record.snippet);
    const refId = optionalString(record.ref_id);
    if (!url && !title && !snippet) return [];
    return [{ url, title, snippet, refId }];
  });
}

function isResultAllowed(
  record: CodexStandaloneWebResultRecord,
  settings: CoreWebAccessSettings,
): boolean {
  if (!record.url) return true;
  try {
    return isHostnameAllowed(new URL(record.url).hostname, settings);
  } catch {
    return false;
  }
}

function isHostnameAllowed(
  hostname: string,
  settings: CoreWebAccessSettings,
): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  const matches = (domain: string) =>
    normalized === domain || normalized.endsWith(`.${domain}`);
  if (
    settings.allowedDomains.length > 0 &&
    !settings.allowedDomains.some(matches)
  ) {
    return false;
  }
  return !settings.blockedDomains.some(matches);
}

function citationsFromRecords(
  records: readonly CodexStandaloneWebResultRecord[],
): CoreWebCitation[] {
  const seen = new Set<string>();
  return records.flatMap((record) => {
    if (!record.url || seen.has(record.url)) return [];
    seen.add(record.url);
    return [
      {
        url: record.url,
        ...(record.title ? { title: record.title } : {}),
        ...(record.snippet ? { citedText: record.snippet } : {}),
      },
    ];
  });
}

function formatSearchRecords(
  records: readonly CodexStandaloneWebResultRecord[],
): string {
  return records
    .map((record, index) =>
      [
        `${index + 1}. ${record.title ?? record.url ?? "Search result"}`,
        record.url ? `URL: ${record.url}` : undefined,
        record.snippet ? `Snippet: ${record.snippet}` : undefined,
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n\n");
}

function truncateVisibleContent(
  content: string,
  maxCharacters: number,
): string {
  const trimmed = content.trim();
  if (trimmed.length <= maxCharacters) return trimmed;
  return `${trimmed.slice(0, maxCharacters).trimEnd()}\n\n[Content truncated by AgentLink]`;
}

function compactObject(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  );
}

function summarizeErrorResponse(responseText: string): string {
  try {
    const parsed = JSON.parse(responseText) as {
      error?: { message?: unknown } | string;
      message?: unknown;
    };
    const message =
      typeof parsed.error === "string"
        ? parsed.error
        : typeof parsed.error?.message === "string"
          ? parsed.error.message
          : typeof parsed.message === "string"
            ? parsed.message
            : undefined;
    return message?.slice(0, 500) ?? "unknown error";
  } catch {
    return responseText.trim().slice(0, 500) || "unknown error";
  }
}
