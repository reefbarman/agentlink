import type * as OpenAIResponses from "openai/resources/responses/responses";
import * as os from "os";

import {
  CODEX_API_BASE_URL,
  OPENAI_API_BASE_URL,
} from "../../core/model/providers/codex/openaiClient.js";
import type {
  ChatMessage,
  ReasoningEffort,
} from "../../agent/webview/types.js";
import {
  CodexResponsesAuthError,
  CodexResponsesStreamAbortedError,
  executeCodexResolvedCompletion,
} from "../../core/model/providers/codex/completionFacade.js";

import type { BrowserGatewayModelCredentialRecord } from "../browserGatewayModelCredentialCache.js";
import OpenAI from "openai";
import { agentLinkFetch } from "../../util/httpDispatcher.js";

const ASK_AGENT_MEMORY_SUMMARIZER_PROMPT = `You summarize AgentLink Browser Ask Agent conversations for a local derived memory index.
Return only valid JSON. Do not wrap it in Markdown.
Omit credentials, secrets, tokens, private keys, or sensitive personal data; if the transcript appears to hinge on a secret, summarize only the non-sensitive task context.
Ordinary user-provided names, preferred names, nicknames, and how the user wants to be addressed are allowed when relevant for later recall; do not replace them with vague phrases such as "shared a name".
Use concise phrases that will be useful for later retrieval.
Schema:
{
  "title": "short conversation title",
  "summary": "rolling summary of the conversation so far",
  "topics": ["topic keywords"],
  "decisions": ["decisions or stable preferences from this chat only"],
  "openQuestions": ["unresolved questions or follow-ups"],
  "durableCandidateHints": ["possible approval-gated durable memory candidates"],
  "latestTurn": {
    "summary": "summary of the latest completed user/assistant turn",
    "keywords": ["search terms"],
    "entities": ["named tools, projects, files, technologies, people, services"]
  }
}`;

export interface BrowserGatewayAskAgentSummaryResult {
  title: string;
  summary: string;
  topics: string[];
  decisions: string[];
  openQuestions: string[];
  durableCandidateHints: string[];
  latestTurn: {
    summary: string;
    keywords: string[];
    entities: string[];
  };
}

export interface BrowserGatewayAskAgentSummarizer {
  summarize(params: {
    credential: BrowserGatewayModelCredentialRecord;
    model?: string;
    reasoningEffort?: ReasoningEffort;
    messages: readonly ChatMessage[];
    existingSessionSummary?: string;
    signal?: AbortSignal;
  }): Promise<BrowserGatewayAskAgentSummaryResult>;
}

export interface BrowserGatewayAskAgentSummarySecretFinding {
  field: string;
  pattern: string;
}

export interface BrowserGatewayAskAgentRedactionResult {
  text: string;
  redacted: boolean;
}

export interface BrowserGatewayAskAgentModelSummarizerOptions {
  sessionId: string;
  createClient?: (params: {
    credential: BrowserGatewayModelCredentialRecord;
    baseURL: string;
    defaultHeaders: Record<string, string>;
  }) => Pick<OpenAI, "responses">;
}

const SECRET_LIKE_MEMORY_PATTERNS: Array<{ id: string; pattern: RegExp }> = [
  {
    id: "private_key_block",
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/gi,
  },
  {
    id: "openai_api_key",
    pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    id: "github_token",
    pattern: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
  },
  {
    id: "aws_access_key",
    pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  },
  {
    id: "slack_token",
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g,
  },
  {
    id: "jwt",
    pattern:
      /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  },
  {
    id: "secret_assignment",
    pattern:
      /\b(?:api[_-]?key|secret|token|password|bearer)\b\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{16,}/gi,
  },
];

const REDACTED_SECRET_PLACEHOLDER = "[REDACTED_SECRET]";

function sanitizeString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function sanitizeStringArray(value: unknown, limit = 12): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter(Boolean),
    ),
  ].slice(0, limit);
}

function extractJsonObject(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced?.[1]) return fenced[1].trim();

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) return text.slice(start, end + 1);
  return text.trim();
}

function* iterateSummaryStrings(
  summary: BrowserGatewayAskAgentSummaryResult,
): Iterable<{ field: string; value: string }> {
  yield { field: "title", value: summary.title };
  yield { field: "summary", value: summary.summary };
  for (const [index, value] of summary.topics.entries()) {
    yield { field: `topics[${index}]`, value };
  }
  for (const [index, value] of summary.decisions.entries()) {
    yield { field: `decisions[${index}]`, value };
  }
  for (const [index, value] of summary.openQuestions.entries()) {
    yield { field: `openQuestions[${index}]`, value };
  }
  for (const [index, value] of summary.durableCandidateHints.entries()) {
    yield { field: `durableCandidateHints[${index}]`, value };
  }
  yield { field: "latestTurn.summary", value: summary.latestTurn.summary };
  for (const [index, value] of summary.latestTurn.keywords.entries()) {
    yield { field: `latestTurn.keywords[${index}]`, value };
  }
  for (const [index, value] of summary.latestTurn.entities.entries()) {
    yield { field: `latestTurn.entities[${index}]`, value };
  }
}

function resetSecretPattern(pattern: RegExp): RegExp {
  pattern.lastIndex = 0;
  return pattern;
}

export function redactAskAgentSummaryInputText(
  text: string,
): BrowserGatewayAskAgentRedactionResult {
  let redactedText = text;
  let redacted = false;
  for (const { pattern } of SECRET_LIKE_MEMORY_PATTERNS) {
    resetSecretPattern(pattern);
    redactedText = redactedText.replace(pattern, () => {
      redacted = true;
      return REDACTED_SECRET_PLACEHOLDER;
    });
  }
  return { text: redactedText, redacted };
}

export function findAskAgentSummarySecretLikeContent(
  summary: BrowserGatewayAskAgentSummaryResult,
): BrowserGatewayAskAgentSummarySecretFinding | null {
  for (const { field, value } of iterateSummaryStrings(summary)) {
    for (const { id, pattern } of SECRET_LIKE_MEMORY_PATTERNS) {
      if (resetSecretPattern(pattern).test(value)) {
        return { field, pattern: id };
      }
    }
  }
  return null;
}

export function parseAskAgentSummaryJson(
  text: string,
): BrowserGatewayAskAgentSummaryResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonObject(text));
  } catch (err) {
    throw new Error(
      `browser_gateway_ask_agent_memory_invalid_json:${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("browser_gateway_ask_agent_memory_invalid_json:root");
  }
  const candidate = parsed as Record<string, unknown>;
  const latestTurnCandidate =
    candidate.latestTurn &&
    typeof candidate.latestTurn === "object" &&
    !Array.isArray(candidate.latestTurn)
      ? (candidate.latestTurn as Record<string, unknown>)
      : {};
  const summary = sanitizeString(candidate.summary);
  const latestTurnSummary = sanitizeString(latestTurnCandidate.summary);
  if (!summary || !latestTurnSummary) {
    throw new Error("browser_gateway_ask_agent_memory_invalid_json:summary");
  }

  return {
    title: sanitizeString(candidate.title, "Ask Agent") || "Ask Agent",
    summary,
    topics: sanitizeStringArray(candidate.topics),
    decisions: sanitizeStringArray(candidate.decisions),
    openQuestions: sanitizeStringArray(candidate.openQuestions),
    durableCandidateHints: sanitizeStringArray(candidate.durableCandidateHints),
    latestTurn: {
      summary: latestTurnSummary,
      keywords: sanitizeStringArray(latestTurnCandidate.keywords),
      entities: sanitizeStringArray(latestTurnCandidate.entities),
    },
  };
}

function toSummarizerInput(params: {
  messages: readonly ChatMessage[];
  existingSessionSummary?: string;
}): OpenAIResponses.ResponseInputItem[] {
  const transcript = params.messages
    .filter(
      (message) => message.role === "user" || message.role === "assistant",
    )
    .map((message, index) => ({
      index,
      id: message.id,
      role: message.role,
      content: redactAskAgentSummaryInputText(message.content).text,
      error: message.error
        ? {
            code: message.error.code,
            retryable: message.error.retryable,
          }
        : undefined,
    }));

  return [
    {
      role: "user",
      content: [
        {
          type: "input_text",
          text: JSON.stringify({
            existingSessionSummary: params.existingSessionSummary ?? "",
            transcript,
          }),
        },
      ],
    } as OpenAIResponses.ResponseInputItem,
  ];
}

export class BrowserGatewayAskAgentModelSummarizer implements BrowserGatewayAskAgentSummarizer {
  constructor(
    private readonly options: BrowserGatewayAskAgentModelSummarizerOptions,
  ) {}

  async summarize(params: {
    credential: BrowserGatewayModelCredentialRecord;
    model?: string;
    reasoningEffort?: ReasoningEffort;
    messages: readonly ChatMessage[];
    existingSessionSummary?: string;
    signal?: AbortSignal;
  }): Promise<BrowserGatewayAskAgentSummaryResult> {
    const defaultHeaders: Record<string, string> = {
      "User-Agent": `agentlink/1.0 (${os.platform()} ${os.release()}; ${os.arch()}) node/${process.version.slice(1)}`,
    };
    if (params.credential.method === "oauth") {
      defaultHeaders.originator = "agentlink";
      defaultHeaders.session_id = this.options.sessionId;
      if (params.credential.accountId) {
        defaultHeaders["ChatGPT-Account-Id"] = params.credential.accountId;
      }
    }
    const baseURL =
      params.credential.method === "oauth"
        ? CODEX_API_BASE_URL
        : OPENAI_API_BASE_URL;
    const client = this.options.createClient
      ? this.options.createClient({
          credential: params.credential,
          baseURL,
          defaultHeaders,
        })
      : new OpenAI({
          apiKey: params.credential.bearerToken,
          baseURL,
          defaultHeaders,
          fetch: agentLinkFetch,
          maxRetries: 0,
        });

    try {
      const result = await executeCodexResolvedCompletion({
        client,
        authMethod: params.credential.method,
        model: params.model,
        instructions: ASK_AGENT_MEMORY_SUMMARIZER_PROMPT,
        input: toSummarizerInput({
          messages: params.messages,
          existingSessionSummary: params.existingSessionSummary,
        }),
        maxTokens: 1200,
        state: { store: false },
        reasoningEffort: params.reasoningEffort ?? "low",
        signal: params.signal,
      });
      return parseAskAgentSummaryJson(result.text);
    } catch (err) {
      if (err instanceof CodexResponsesAuthError) {
        throw new Error("browser_gateway_ask_agent_memory_auth_failed");
      }
      if (err instanceof CodexResponsesStreamAbortedError) {
        throw new Error("browser_gateway_ask_agent_memory_aborted");
      }
      throw err;
    }
  }
}
