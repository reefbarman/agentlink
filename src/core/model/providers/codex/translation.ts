import type * as OpenAIResponses from "openai/resources/responses/responses";

import type {
  CoreModelMessage,
  CoreModelToolDefinition,
} from "../../../modelRuntime.js";

import type { CoreReasoningEffort } from "../../../modelCatalog.js";
import type { Reasoning } from "openai/resources/shared";
import {
  CODEX_DEFAULT_MODEL,
  getEndpointCaps,
  resolveCodexEffectiveModel,
  type CodexAuthMethod,
  type ResponsesCaps,
} from "./models.js";

const OPENAI_CALL_ID_MAX_LENGTH = 64;

type UserInputContent = OpenAIResponses.ResponseInputMessageContentList[number];

export type CodexRequestBody = OpenAIResponses.ResponseCreateParamsStreaming;
export type CodexInputItem = OpenAIResponses.ResponseInputItem;
export type CodexTool = OpenAIResponses.Tool;
export type CodexPromptCacheRetention = "in_memory" | "24h";

export interface CodexInputSummary {
  contentPartCount: number;
  imageCount: number;
  imageUrlPreviews: string[];
}

export function summarizeCodexInput(
  input: CodexInputItem[],
): CodexInputSummary {
  let contentPartCount = 0;
  let imageCount = 0;
  const imageUrlPreviews: string[] = [];

  for (const item of input) {
    if (!("content" in item) || !Array.isArray(item.content)) {
      continue;
    }

    for (const content of item.content as Array<{
      type?: string;
      image_url?: string;
    }>) {
      contentPartCount++;
      if (content.type === "input_image") {
        imageCount++;
        imageUrlPreviews.push(
          content.image_url
            ? `${content.image_url.slice(0, 30)}...(${content.image_url.length} chars)`
            : "MISSING",
        );
      }
    }
  }

  return { contentPartCount, imageCount, imageUrlPreviews };
}

export function summarizeCodexRequestInput(
  input: CodexRequestBody["input"],
): string {
  return Array.isArray(input) ? `${input.length} items` : "string";
}

/**
 * Sanitize and truncate a tool call ID for OpenAI's Responses API.
 * IDs must be ≤64 chars and match `^[a-zA-Z0-9_-]+$`.
 */
export function sanitizeCodexCallId(id: string): string {
  const sanitized = id.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (sanitized.length <= OPENAI_CALL_ID_MAX_LENGTH) return sanitized;

  const hash = stableShortHash(id);
  const prefix = sanitized.slice(0, OPENAI_CALL_ID_MAX_LENGTH - 1 - 8);
  return `${prefix}_${hash}`;
}

/**
 * Translate core model messages into Codex Responses API `input[]`.
 * Tool calls and results become top-level items (not nested in messages).
 * Thinking blocks are stripped — Codex uses its own reasoning system.
 */
export function translateCodexMessages(
  messages: CoreModelMessage[],
): CodexInputItem[] {
  const input: CodexInputItem[] = [];

  for (const msg of messages) {
    if (typeof msg.content === "string") {
      if (msg.role === "user") {
        input.push({
          role: "user",
          content: [{ type: "input_text", text: msg.content }],
        } as CodexInputItem);
      } else {
        input.push({
          role: "assistant",
          content: [{ type: "output_text", text: msg.content }],
        } as CodexInputItem);
      }
      continue;
    }

    const userContent: UserInputContent[] = [];
    const assistantContent: Array<Record<string, unknown>> = [];
    const toolResults: CodexInputItem[] = [];
    const toolCalls: CodexInputItem[] = [];

    for (const block of msg.content) {
      switch (block.type) {
        case "text":
          if (msg.role === "user") {
            userContent.push({ type: "input_text", text: block.text });
          } else {
            assistantContent.push({ type: "output_text", text: block.text });
          }
          break;

        case "image":
          if (msg.role === "user") {
            const src = block.source;
            userContent.push({
              type: "input_image",
              image_url: `data:${src.media_type};base64,${src.data}`,
              detail: "auto",
            });
          }
          break;

        case "document":
          if (msg.role === "user") {
            const src = block.source;
            userContent.push({
              type: "input_file",
              filename: block.title ?? "document.pdf",
              file_data: `data:${src.media_type};base64,${src.data}`,
            });
          }
          break;

        case "tool_use":
          toolCalls.push({
            type: "function_call",
            call_id: sanitizeCodexCallId(block.id),
            name: block.name,
            arguments: JSON.stringify(block.input),
          });
          break;

        case "tool_result": {
          const output =
            typeof block.content === "string"
              ? block.content
              : Array.isArray(block.content)
                ? block.content
                    .filter(
                      (b): b is { type: "text"; text: string } =>
                        b.type === "text",
                    )
                    .map((b) => b.text)
                    .join("")
                : "";
          toolResults.push({
            type: "function_call_output",
            call_id: sanitizeCodexCallId(block.tool_use_id),
            output,
          });
          break;
        }

        case "thinking":
          break;
      }
    }

    if (msg.role === "user" && userContent.length > 0) {
      input.push({ role: "user", content: userContent });
    }
    if (msg.role === "assistant" && assistantContent.length > 0) {
      input.push({
        role: "assistant",
        content: assistantContent,
      } as unknown as CodexInputItem);
    }
    input.push(...toolCalls);
    input.push(...toolResults);
  }

  return input;
}

const codexToolCache = new WeakMap<CoreModelToolDefinition[], CodexTool[]>();

/**
 * Translate core tool definitions into Codex Responses API tools.
 * Uses non-strict mode to support free-form object schemas (e.g. MCP tools).
 */
export function translateCodexTools(
  tools: CoreModelToolDefinition[],
): CodexTool[] {
  const cached = codexToolCache.get(tools);
  if (cached) return cached;
  const translated = tools.map((tool) => ({
    type: "function" as const,
    name: tool.name,
    description: tool.description,
    parameters: sanitizeSchemaForCodex(
      tool.input_schema as Record<string, unknown>,
    ),
    strict: false,
  })) as CodexTool[];
  codexToolCache.set(tools, translated);
  return translated;
}

export function buildCodexReasoning(effort: CoreReasoningEffort): Reasoning {
  return {
    effort: effort as Reasoning["effort"],
    summary: "detailed",
  };
}

export interface CodexResolvedRequestBodyResult {
  configuredModel: string;
  model: string;
  remapped: boolean;
  body: CodexRequestBody;
}

export function buildCodexResolvedRequestBody(args: {
  authMethod: CodexAuthMethod;
  model?: string;
  input: CodexInputItem[];
  instructions: string;
  maxTokens?: number;
  state?: { store?: boolean; previousResponseId?: string };
  cache?: { key?: string; retention?: CodexPromptCacheRetention };
  reasoningEffort?: CoreReasoningEffort;
  tools?: CodexTool[];
}): CodexResolvedRequestBodyResult {
  const configuredModel = args.model?.trim() || CODEX_DEFAULT_MODEL;
  const modelResolution = resolveCodexEffectiveModel(
    configuredModel,
    args.authMethod,
  );
  const body = buildCodexEndpointRequestBody({
    model: modelResolution.model,
    input: args.input,
    instructions: args.instructions,
    maxTokens: args.maxTokens,
    state: args.state,
    cache: args.cache,
    reasoningEffort: args.reasoningEffort,
    tools: args.tools,
    caps: getEndpointCaps({ method: args.authMethod }),
  });

  return {
    configuredModel,
    model: modelResolution.model,
    remapped: modelResolution.remapped,
    body,
  };
}

export function buildCodexEndpointRequestBody(args: {
  model: string;
  input: CodexInputItem[];
  instructions: string;
  maxTokens?: number;
  state?: { store?: boolean; previousResponseId?: string };
  cache?: { key?: string; retention?: CodexPromptCacheRetention };
  reasoningEffort?: CoreReasoningEffort;
  tools?: CodexTool[];
  caps: ResponsesCaps;
}): CodexRequestBody {
  return buildCodexStreamRequestBody({
    model: args.model,
    input: args.input,
    instructions: args.instructions,
    store: args.state?.store ?? false,
    maxTokens: args.caps.supportsMaxOutputTokens ? args.maxTokens : undefined,
    reasoning: args.reasoningEffort
      ? buildCodexReasoning(args.reasoningEffort)
      : undefined,
    previousResponseId: args.caps.supportsPreviousResponseId
      ? args.state?.previousResponseId
      : undefined,
    tools: args.tools,
    promptCacheKey: args.caps.supportsPromptCacheKey
      ? args.cache?.key
      : undefined,
    promptCacheRetention:
      args.cache?.retention === "24h" && args.caps.supportsPromptCacheRetention
        ? "24h"
        : undefined,
  });
}

export function buildCodexStreamRequestBody(args: {
  model: string;
  input: CodexInputItem[];
  instructions: string;
  store: boolean;
  maxTokens?: number;
  reasoning?: Reasoning;
  previousResponseId?: string;
  tools?: CodexTool[];
  promptCacheKey?: string;
  promptCacheRetention?: CodexPromptCacheRetention;
}): CodexRequestBody {
  return {
    model: args.model,
    input: args.input,
    instructions: args.instructions,
    stream: true,
    store: args.store,
    ...(typeof args.maxTokens === "number"
      ? ({ max_output_tokens: args.maxTokens } as Record<string, unknown>)
      : {}),
    ...(args.reasoning ? { reasoning: args.reasoning } : {}),
    ...(args.previousResponseId
      ? { previous_response_id: args.previousResponseId }
      : {}),
    ...(args.tools && args.tools.length > 0 ? { tools: args.tools } : {}),
    ...(args.promptCacheKey ? { prompt_cache_key: args.promptCacheKey } : {}),
    ...(args.promptCacheRetention
      ? { prompt_cache_retention: args.promptCacheRetention }
      : {}),
  } as CodexRequestBody;
}

function sortObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortObjectKeys);
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, sortObjectKeys(child)]),
  );
}

/**
 * Recursively strip JSON Schema annotations unsupported by the Codex API
 * (e.g. `format: "uri"`) and canonicalize object key ordering so equivalent
 * schemas serialize identically across requests.
 * Does not enforce strict-mode constraints so that free-form object schemas
 * (MCP tools, open-ended params) remain valid.
 */
export function sanitizeSchemaForCodex(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  if (!schema || typeof schema !== "object") return schema;

  const entries = Object.entries(schema)
    .filter(([key]) => key !== "format")
    .sort(([a], [b]) => a.localeCompare(b));

  return Object.fromEntries(
    entries.map(([key, value]) => {
      if (key === "properties" && value && typeof value === "object") {
        const sanitizedProps = Object.fromEntries(
          Object.entries(value as Record<string, Record<string, unknown>>)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([propKey, propValue]) => [
              propKey,
              sanitizeSchemaForCodex(propValue),
            ]),
        );
        return [key, sanitizedProps];
      }

      if (key === "items") {
        if (Array.isArray(value)) {
          return [
            key,
            value.map((item) =>
              item && typeof item === "object"
                ? sanitizeSchemaForCodex(item as Record<string, unknown>)
                : item,
            ),
          ];
        }
        if (value && typeof value === "object") {
          return [
            key,
            sanitizeSchemaForCodex(value as Record<string, unknown>),
          ];
        }
      }

      return [key, sortObjectKeys(value)];
    }),
  ) as Record<string, unknown>;
}

function stableShortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0").slice(0, 8);
}
