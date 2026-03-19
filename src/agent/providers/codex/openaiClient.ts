import * as os from "os";

import OpenAI from "openai";

import type { OpenAiCodexResolvedAuth } from "./OpenAiCodexAuthManager.js";
import { getEndpointCaps, type ResponsesCaps } from "./models.js";

export const CODEX_API_BASE_URL = "https://chatgpt.com/backend-api/codex";
export const OPENAI_API_BASE_URL = "https://api.openai.com/v1";

export interface CodexEndpointConfig {
  baseURL: string;
  defaultHeaders: Record<string, string>;
  caps: ResponsesCaps;
  canRefresh: boolean;
}

export function getCodexEndpointConfig(
  auth: OpenAiCodexResolvedAuth,
  sessionId: string,
): CodexEndpointConfig {
  const defaultHeaders: Record<string, string> = {
    "User-Agent": `agentlink/1.0 (${os.platform()} ${os.release()}; ${os.arch()}) node/${process.version.slice(1)}`,
  };

  if (auth.method === "oauth") {
    defaultHeaders.originator = "agentlink";
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

export function createOpenAiResponsesClient(
  auth: OpenAiCodexResolvedAuth,
  endpoint: CodexEndpointConfig,
): OpenAI {
  return new OpenAI({
    apiKey: auth.bearerToken,
    baseURL: endpoint.baseURL,
    defaultHeaders: endpoint.defaultHeaders,
    maxRetries: 0,
  });
}
