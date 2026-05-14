import * as vscode from "vscode";

export interface OpenAiCompatibleEndpoint {
  baseUrl: string;
  model: string;
  apiKey: string;
  timeoutMs: number;
}

/**
 * Reads `agentlink.openaiCompatible.*` for the shared endpoint used by
 * helper-model features (question detection, bg summarization, future
 * summarizers). Falls back to the legacy `agentlink.questionDetection.*`
 * keys for one release so users who set them before the rename don't break.
 */
export function getOpenAiCompatibleEndpoint(): OpenAiCompatibleEndpoint {
  const cfg = vscode.workspace.getConfiguration("agentlink");

  const legacyBaseUrl = cfg.get<string>("questionDetection.baseUrl", "");
  const legacyModel = cfg.get<string>("questionDetection.model", "");
  const legacyApiKey = cfg.get<string>("questionDetection.apiKey", "");
  const legacyTimeoutMs = cfg.get<number | undefined>(
    "questionDetection.timeoutMs",
    undefined as unknown as number,
  );

  const baseUrl = (
    cfg.get<string>("openaiCompatible.baseUrl", "") ||
    legacyBaseUrl ||
    "http://127.0.0.1:1234/v1"
  ).replace(/\/+$/, "");

  const model = (
    cfg.get<string>("openaiCompatible.model", "") || legacyModel
  ).trim();

  const apiKey = (
    cfg.get<string>("openaiCompatible.apiKey", "") || legacyApiKey
  ).trim();

  const timeoutCandidate = cfg.get<number>("openaiCompatible.timeoutMs", 0);
  const timeoutMs =
    timeoutCandidate > 0
      ? timeoutCandidate
      : typeof legacyTimeoutMs === "number" && legacyTimeoutMs > 0
        ? legacyTimeoutMs
        : 5000;

  return { baseUrl, model, apiKey, timeoutMs };
}

export interface ChatJsonSchema {
  name: string;
  strict?: boolean;
  schema: Record<string, unknown>;
}

export interface OpenAiCompatibleChatRequest {
  endpoint: OpenAiCompatibleEndpoint;
  systemPrompt: string;
  userContent: string;
  jsonSchema?: ChatJsonSchema;
  maxTokens?: number;
  temperature?: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export interface OpenAiCompatibleChatResult {
  content: string;
}

export async function callOpenAiCompatibleChat(
  request: OpenAiCompatibleChatRequest,
): Promise<OpenAiCompatibleChatResult> {
  const {
    endpoint,
    systemPrompt,
    userContent,
    jsonSchema,
    maxTokens,
    temperature,
    fetchImpl = fetch,
    signal,
  } = request;

  const controller = new AbortController();
  const abortOuter = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", abortOuter, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), endpoint.timeoutMs);

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (endpoint.apiKey) {
      headers.Authorization = `Bearer ${endpoint.apiKey}`;
    }

    const body: Record<string, unknown> = {
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
      temperature: temperature ?? 0,
    };
    if (endpoint.model) body.model = endpoint.model;
    if (typeof maxTokens === "number") body.max_tokens = maxTokens;
    if (jsonSchema) {
      body.response_format = {
        type: "json_schema",
        json_schema: jsonSchema,
      };
    }

    const response = await fetchImpl(`${endpoint.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`http ${response.status}: ${text.slice(0, 200)}`);
    }

    const json = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      throw new Error("empty response");
    }

    return { content };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", abortOuter);
  }
}
