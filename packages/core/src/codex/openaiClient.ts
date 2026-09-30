import OpenAI from "openai";

import { getCodexOriginator, getCodexUserAgent } from "./clientIdentity.js";
import {
  getEndpointCaps,
  type CodexAuthMethod,
  type ResponsesCaps,
} from "./models.js";

export const CODEX_API_BASE_URL = "https://chatgpt.com/backend-api/codex";
export const OPENAI_API_BASE_URL = "https://api.openai.com/v1";

export interface CodexResolvedAuthForClient {
  method: CodexAuthMethod;
  bearerToken: string;
  accountId?: string;
  canRefresh: boolean;
}

export interface CodexEndpointConfig {
  baseURL: string;
  defaultHeaders: Record<string, string>;
  caps: ResponsesCaps;
  canRefresh: boolean;
}

export interface CodexClientCacheKeyParts {
  method: CodexAuthMethod;
  accountId?: string;
  baseURL: string;
  bearerToken: string;
}

export type CodexFetch = typeof globalThis.fetch;

export interface CreateOpenAiResponsesClientOptions {
  readonly fetch?: CodexFetch;
}

export interface CodexResponsesRequestOptions {
  readonly signal?: AbortSignal;
  readonly maxRetries?: number;
  readonly headers?: Record<string, string>;
}

export function getCodexEndpointConfig(
  auth: CodexResolvedAuthForClient,
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): CodexEndpointConfig {
  const defaultHeaders: Record<string, string> = {
    "User-Agent": getCodexUserAgent(env),
  };

  if (auth.method === "oauth") {
    defaultHeaders.originator = getCodexOriginator(env);
    defaultHeaders.session_id = sessionId;
    if (auth.accountId) {
      defaultHeaders["ChatGPT-Account-Id"] = auth.accountId;
    }
  }

  return {
    baseURL: auth.method === "oauth" ? CODEX_API_BASE_URL : OPENAI_API_BASE_URL,
    defaultHeaders,
    caps: getEndpointCaps(auth),
    canRefresh: auth.canRefresh,
  };
}

export function getCodexWebSocketConfig(
  auth: CodexResolvedAuthForClient,
  endpoint: CodexEndpointConfig,
  requestHeaders: Record<string, string>,
): { url: string; headers: Record<string, string>; identity: string } {
  if (
    endpoint.baseURL !== CODEX_API_BASE_URL &&
    endpoint.baseURL !== OPENAI_API_BASE_URL
  ) {
    throw new Error("Responses WebSockets require a first-party endpoint");
  }
  const url = `${endpoint.baseURL.replace(/^https:/, "wss:")}/responses`;
  const headers = {
    ...endpoint.defaultHeaders,
    ...requestHeaders,
    Authorization: `Bearer ${auth.bearerToken}`,
    ...(auth.method === "oauth"
      ? { "OpenAI-Beta": "responses_websockets=2026-02-06" }
      : {}),
  };
  return {
    url,
    headers,
    // Private in-process identity only, never a diagnostic or serialized field.
    identity: JSON.stringify([auth.method, auth.accountId, url, headers]),
  };
}

export function buildCodexClientCacheKey(
  parts: CodexClientCacheKeyParts,
  fingerprintToken: (bearerToken: string) => string,
): string {
  const tokenFingerprint = fingerprintToken(parts.bearerToken);
  return `${parts.method}:${parts.accountId ?? ""}:${parts.baseURL}:${tokenFingerprint}`;
}

export function createOpenAiResponsesClient(
  auth: CodexResolvedAuthForClient,
  endpoint: CodexEndpointConfig,
  options: CreateOpenAiResponsesClientOptions = {},
): OpenAI {
  return new OpenAI({
    apiKey: auth.bearerToken,
    baseURL: endpoint.baseURL,
    defaultHeaders: endpoint.defaultHeaders,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    maxRetries: 0,
  });
}
