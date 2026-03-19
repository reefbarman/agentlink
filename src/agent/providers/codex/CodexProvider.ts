/**
 * CodexProvider — implements ModelProvider for the OpenAI/Codex Responses API.
 *
 * Supports two auth paths behind one provider surface:
 * - OAuth (ChatGPT/Codex subscription) via `chatgpt.com/backend-api/codex/responses`
 * - OpenAI API key via `api.openai.com/v1/responses`
 *
 * Uses the OpenAI SDK Responses API with endpoint-specific configuration for
 * OAuth-backed Codex and API-key-backed OpenAI requests.
 */

import * as crypto from "crypto";
import { randomUUID } from "crypto";

import OpenAI, { APIError } from "openai";
import type * as OpenAIResponses from "openai/resources/responses/responses";
import type { Reasoning } from "openai/resources/shared";
import type {
  ModelProvider,
  StreamRequest,
  CompleteRequest,
  CompleteResult,
  ProviderStreamEvent,
  ModelCapabilities,
  ModelInfo,
  ContentBlock,
  MessageParam,
  ToolDefinition,
  ThinkingBlock,
} from "../types.js";
import {
  openAiCodexAuthManager,
  type OpenAiCodexAuthManager,
  type OpenAiCodexResolvedAuth,
} from "./OpenAiCodexAuthManager.js";
import {
  CODEX_CONDENSE_MODEL,
  CODEX_MODEL_MAP,
  getCodexModelCapabilities,
  getEndpointCaps,
  listCodexModels,
} from "./models.js";
import {
  createOpenAiResponsesClient,
  getCodexEndpointConfig,
} from "./openaiClient.js";

// ── Constants ──

const OPENAI_CALL_ID_MAX_LENGTH = 64;

// ── Tool call ID sanitization ──

/**
 * Sanitize and truncate a tool call ID for OpenAI's Responses API.
 * IDs must be ≤64 chars and match `^[a-zA-Z0-9_-]+$`.
 */
function sanitizeCallId(id: string): string {
  const sanitized = id.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (sanitized.length <= OPENAI_CALL_ID_MAX_LENGTH) return sanitized;

  // Use 8-char hash suffix for uniqueness
  const hash = crypto.createHash("md5").update(id).digest("hex").slice(0, 8);
  const prefix = sanitized.slice(
    0,
    OPENAI_CALL_ID_MAX_LENGTH - 1 - 8, // 1 for separator
  );
  return `${prefix}_${hash}`;
}

// ── Message translation ──

type CodexRequestBody = OpenAIResponses.ResponseCreateParamsStreaming;
type CodexInputItem = OpenAIResponses.ResponseInputItem;
type UserInputContent = OpenAIResponses.ResponseInputMessageContentList[number];
type PromptCacheRetention = "24h" | "in-memory";

/**
 * Translate our provider-agnostic messages into Codex Responses API `input[]`.
 * Tool calls and results become top-level items (not nested in messages).
 * ThinkingBlocks are stripped — Codex uses its own reasoning system.
 */
function translateMessages(messages: MessageParam[]): CodexInputItem[] {
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

    // Array content — split into message content vs tool items
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
            call_id: sanitizeCallId(block.id),
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
            call_id: sanitizeCallId(block.tool_use_id),
            output,
          });
          break;
        }

        case "thinking":
          // Strip thinking blocks — Codex doesn't accept Anthropic thinking signatures
          break;
      }
    }

    // Emit message content first, then tool items (order matters for Codex)
    if (msg.role === "user" && userContent.length > 0) {
      input.push({ role: "user", content: userContent });
    }
    if (msg.role === "assistant" && assistantContent.length > 0) {
      input.push({
        role: "assistant",
        content: assistantContent,
      } as unknown as CodexInputItem);
    }
    // Tool calls come from assistant messages
    input.push(...toolCalls);
    // Tool results come from user messages
    input.push(...toolResults);
  }

  return input;
}

/**
 * Translate our ToolDefinition[] into Codex Responses API tools.
 * Uses non-strict mode to support free-form object schemas (e.g. MCP tools).
 */
function translateTools(tools: ToolDefinition[]): OpenAIResponses.Tool[] {
  return tools.map((t) => ({
    type: "function" as const,
    name: t.name,
    description: t.description,
    parameters: sanitizeSchemaForCodex(
      t.input_schema as Record<string, unknown>,
    ),
    strict: false,
  })) as OpenAIResponses.Tool[];
}

function buildReasoning(effort: string): Reasoning {
  return {
    effort: effort as Reasoning["effort"],
    summary: "detailed",
  };
}

function buildStreamRequestBody(args: {
  model: string;
  input: CodexInputItem[];
  instructions: string;
  store: boolean;
  reasoning?: Reasoning;
  previousResponseId?: string;
  tools?: OpenAIResponses.Tool[];
  promptCacheKey?: string;
  promptCacheRetention?: PromptCacheRetention;
}): CodexRequestBody {
  return {
    model: args.model,
    input: args.input,
    instructions: args.instructions,
    stream: true,
    store: args.store,
    ...(args.reasoning ? { reasoning: args.reasoning } : {}),
    ...(args.previousResponseId
      ? { previous_response_id: args.previousResponseId }
      : {}),
    ...(args.tools && args.tools.length > 0 ? { tools: args.tools } : {}),
    ...(args.promptCacheKey ? { prompt_cache_key: args.promptCacheKey } : {}),
    ...(args.promptCacheRetention
      ? { prompt_cache_retention: args.promptCacheRetention }
      : {}),
  };
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
function sanitizeSchemaForCodex(
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

// ── Provider ──

type CodexSdkError = Error & { status?: number };

function isAuthError(error: unknown): boolean {
  if (error && typeof error === "object" && "status" in error) {
    const status = (error as { status?: unknown }).status;
    if (status === 401) {
      return true;
    }
  }

  const msg = error instanceof Error ? error.message : String(error);
  return /unauthorized|invalid token|401|authentication/i.test(msg);
}

export class CodexProvider implements ModelProvider {
  readonly id = "codex";
  readonly displayName = "OpenAI Codex";
  readonly condenseModel = CODEX_CONDENSE_MODEL;

  private authManager: OpenAiCodexAuthManager;
  private sessionId: string;
  private log: (msg: string) => void;
  private clients = new Map<string, OpenAI>();

  constructor(
    authManager?: OpenAiCodexAuthManager,
    log?: (msg: string) => void,
  ) {
    this.authManager = authManager ?? openAiCodexAuthManager;
    this.sessionId = randomUUID();
    this.log = log ?? (() => {});
  }

  async isAuthenticated(): Promise<boolean> {
    return this.authManager.isAuthenticated();
  }

  getCapabilities(model: string): ModelCapabilities {
    return getCodexModelCapabilities(model);
  }

  listModels(): ModelInfo[] {
    return listCodexModels(this.id);
  }

  async *stream(request: StreamRequest): AsyncGenerator<ProviderStreamEvent> {
    const {
      model,
      systemPrompt,
      messages,
      tools,
      maxTokens: _maxTokens,
      thinking,
      cache,
      state,
      signal,
    } = request;

    const codexInput = translateMessages(messages);
    const codexTools = tools ? translateTools(tools) : undefined;

    const modelDef = CODEX_MODEL_MAP.get(model);
    const reasoningEffort = thinking
      ? "high"
      : (modelDef?.defaultReasoningEffort ?? "medium");

    for (let attempt = 0; attempt < 2; attempt++) {
      const auth =
        attempt === 0
          ? await this.getModelAuthOrThrow()
          : await this.authManager.forceRefreshModelAuth("oauth");
      if (!auth) {
        throw new Error(
          "OpenAI/Codex authentication is required. Sign in with ChatGPT/Codex or configure an OpenAI API key to use models, semantic search, and indexing.",
        );
      }

      const caps = getEndpointCaps(auth);
      const requestBody = buildStreamRequestBody({
        model,
        input: codexInput,
        instructions: systemPrompt,
        store: state?.store ?? false,
        reasoning: buildReasoning(reasoningEffort),
        previousResponseId: caps.supportsPreviousResponseId
          ? state?.previousResponseId
          : undefined,
        tools: codexTools,
        promptCacheKey: caps.supportsPromptCacheKey ? cache?.key : undefined,
        promptCacheRetention:
          cache?.retention === "24h" && caps.supportsPromptCacheRetention
            ? "24h"
            : undefined,
      });

      try {
        yield* this.executeStream(requestBody, auth, model, signal);
        return;
      } catch (err) {
        if (attempt === 0 && isAuthError(err) && auth.canRefresh) {
          this.log("[codex] Auth failure, attempting token refresh...");
          continue;
        }
        throw err;
      }
    }

    throw new Error("Codex stream() failed unexpectedly");
  }

  async complete(request: CompleteRequest): Promise<CompleteResult> {
    const {
      model,
      systemPrompt,
      messages,
      maxTokens: _maxTokens,
      temperature: _temperature,
      cache,
      state,
    } = request;
    const codexInput = translateMessages(messages);

    // Keep complete() intentionally minimal. The OAuth-backed Codex endpoint
    // requires SSE even for non-interactive calls, and we aggregate the stream.
    for (let attempt = 0; attempt < 2; attempt++) {
      const auth =
        attempt === 0
          ? await this.getModelAuthOrThrow()
          : await this.authManager.forceRefreshModelAuth("oauth");
      if (!auth) {
        throw new Error(
          "OpenAI/Codex authentication is required. Sign in with ChatGPT/Codex or configure an OpenAI API key to use models, semantic search, and indexing.",
        );
      }

      const caps = getEndpointCaps(auth);
      const requestBody = buildStreamRequestBody({
        model,
        input: codexInput,
        instructions: systemPrompt,
        store: state?.store ?? false,
        previousResponseId: caps.supportsPreviousResponseId
          ? state?.previousResponseId
          : undefined,
        promptCacheKey: caps.supportsPromptCacheKey ? cache?.key : undefined,
        promptCacheRetention:
          cache?.retention === "24h" && caps.supportsPromptCacheRetention
            ? "24h"
            : undefined,
      });

      let text = "";
      let inputTokens = 0;
      let outputTokens = 0;
      let providerResponseId: string | undefined;

      try {
        for await (const event of this.executeStream(
          requestBody,
          auth,
          model,
        )) {
          if (event.type === "text_delta") {
            text += event.text;
          } else if (event.type === "usage") {
            inputTokens = event.inputTokens;
            outputTokens = event.outputTokens;
            providerResponseId = event.providerResponseId;
          }
        }

        return {
          text,
          usage: { inputTokens, outputTokens },
          providerResponseId,
        };
      } catch (err) {
        if (attempt === 0 && isAuthError(err) && auth.canRefresh) {
          this.log(
            "[codex] complete() auth failure, attempting token refresh...",
          );
          continue;
        }
        throw err;
      }
    }

    throw new Error("Codex complete() failed unexpectedly");
  }

  // ── Internal ──

  private async getModelAuthOrThrow(): Promise<OpenAiCodexResolvedAuth> {
    const auth = await this.authManager.resolveModelAuth();
    if (!auth) {
      throw new Error(
        "OpenAI/Codex authentication is required. Sign in with ChatGPT/Codex or configure an OpenAI API key to use models, semantic search, and indexing.",
      );
    }
    return auth;
  }

  private getClient(auth: OpenAiCodexResolvedAuth): OpenAI {
    const endpoint = getCodexEndpointConfig(auth, this.sessionId);
    const key = `${auth.method}:${auth.accountId ?? ""}:${endpoint.baseURL}`;

    const client = createOpenAiResponsesClient(auth, endpoint);
    this.clients.set(key, client);
    return client;
  }

  private normalizeSdkError(error: unknown): CodexSdkError {
    if (error instanceof APIError) {
      const status = error.status;
      const message = error.message || "Unknown OpenAI error";
      const normalized = new Error(
        `Codex API error ${status ?? "unknown"}: ${message}`,
      ) as CodexSdkError;
      normalized.status = status;
      return normalized;
    }
    if (error instanceof Error) {
      return error as CodexSdkError;
    }
    return new Error(String(error)) as CodexSdkError;
  }

  private async *processResponseStreamEvents(
    events: AsyncIterable<Record<string, unknown>>,
  ): AsyncGenerator<ProviderStreamEvent> {
    const contentBlocks: ContentBlock[] = [];
    let currentText = "";
    let currentThinking = "";
    let thinkingId: string | null = null;

    const pendingToolCalls = new Map<
      string,
      { name: string; arguments: string }
    >();

    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let providerResponseId: string | undefined;

    for await (const event of events) {
      const eventType = event.type as string | undefined;
      if (!eventType) continue;

      // ── Text deltas ──
      if (
        eventType === "response.output_text.delta" ||
        eventType === "response.text.delta"
      ) {
        const delta = event.delta as string | undefined;
        if (delta) {
          currentText += delta;
          yield { type: "text_delta", text: delta };
        }
        continue;
      }

      // ── Reasoning / thinking deltas ──
      if (
        eventType === "response.reasoning_summary.delta" ||
        eventType === "response.reasoning_summary_text.delta" ||
        eventType === "response.reasoning.delta" ||
        eventType === "response.reasoning_text.delta"
      ) {
        const delta = event.delta as string | undefined;
        if (delta) {
          if (!thinkingId) {
            thinkingId = randomUUID();
            yield { type: "thinking_start", thinkingId };
          }
          currentThinking += delta;
          yield { type: "thinking_delta", thinkingId, text: delta };
        }
        continue;
      }

      // ── Refusal ──
      if (eventType === "response.refusal.delta") {
        const delta = event.delta as string | undefined;
        if (delta) {
          const refusalText = `[Refusal] ${delta}`;
          currentText += refusalText;
          yield { type: "text_delta", text: refusalText };
        }
        continue;
      }

      // ── Tool call argument deltas ──
      if (
        eventType === "response.function_call_arguments.delta" ||
        eventType === "response.tool_call_arguments.delta"
      ) {
        const callId = (event.call_id ?? event.tool_call_id ?? event.id) as
          | string
          | undefined;
        const delta = (event.delta ?? event.arguments) as string | undefined;
        if (callId && delta) {
          const pending = pendingToolCalls.get(callId);
          if (pending) {
            pending.arguments += delta;
            yield {
              type: "tool_input_delta",
              toolCallId: callId,
              partialJson: delta,
            };
          }
        }
        continue;
      }

      // ── Output item added — track tool call identity ──
      if (eventType === "response.output_item.added") {
        const item = event.item as Record<string, unknown> | undefined;
        if (
          item &&
          (item.type === "function_call" || item.type === "tool_call")
        ) {
          const callId = (item.call_id ??
            item.tool_call_id ??
            item.id) as string;
          const name = (item.name ??
            (item.function as Record<string, unknown> | undefined)
              ?.name) as string;
          if (callId && name) {
            pendingToolCalls.set(callId, { name, arguments: "" });
            yield { type: "tool_start", toolCallId: callId, toolName: name };
          }
        }
        continue;
      }

      // ── Output item done — finalize tool call ──
      if (eventType === "response.output_item.done") {
        const item = event.item as Record<string, unknown> | undefined;
        if (
          item &&
          (item.type === "function_call" || item.type === "tool_call")
        ) {
          const callId = (item.call_id ??
            item.tool_call_id ??
            item.id) as string;
          const name = (item.name ??
            (item.function as Record<string, unknown> | undefined)
              ?.name) as string;
          const argsRaw = item.arguments ?? item.input;
          const argsStr =
            typeof argsRaw === "string"
              ? argsRaw
              : argsRaw && typeof argsRaw === "object"
                ? JSON.stringify(argsRaw)
                : "";

          // Use accumulated args from deltas if available, fall back to done-event args
          const pending = pendingToolCalls.get(callId);
          const finalArgs = pending?.arguments || argsStr;
          const finalName = pending?.name ?? name;

          if (callId && finalName) {
            let parsed: unknown;
            try {
              parsed = finalArgs ? JSON.parse(finalArgs) : {};
            } catch {
              parsed = {};
            }

            contentBlocks.push({
              type: "tool_use",
              id: callId,
              name: finalName,
              input: parsed as Record<string, unknown>,
            });

            yield {
              type: "tool_done",
              toolCallId: callId,
              toolName: finalName,
              input: parsed,
            };
            pendingToolCalls.delete(callId);
          }
        }
        continue;
      }

      // ── Error events ──
      if (eventType === "response.error" || eventType === "error") {
        const errObj = event.error as Record<string, unknown> | undefined;
        const msg =
          (errObj?.message as string) ??
          (event.message as string) ??
          "Unknown Codex API error";
        throw new Error(`Codex API error: ${msg}`);
      }
      if (eventType === "response.failed") {
        const errObj = event.error as Record<string, unknown> | undefined;
        const msg =
          (errObj?.message as string) ??
          (event.message as string) ??
          "Request failed";
        throw new Error(`Codex request failed: ${msg}`);
      }

      // ── Response done — extract usage and finalize ──
      if (eventType === "response.done" || eventType === "response.completed") {
        const resp = event.response as Record<string, unknown> | undefined;
        providerResponseId =
          (resp?.id as string | undefined) ??
          (event.response_id as string | undefined) ??
          providerResponseId;
        const usage = (resp?.usage ?? event.usage) as
          | Record<string, unknown>
          | undefined;
        if (usage) {
          const totalInputTokens =
            (usage.input_tokens as number) ??
            (usage.prompt_tokens as number) ??
            0;
          outputTokens =
            (usage.output_tokens as number) ??
            (usage.completion_tokens as number) ??
            0;

          const inputDetails = usage.input_tokens_details as
            | Record<string, unknown>
            | undefined;
          const promptDetails = usage.prompt_tokens_details as
            | Record<string, unknown>
            | undefined;
          cacheReadTokens =
            (inputDetails?.cached_tokens as number) ??
            (promptDetails?.cached_tokens as number) ??
            (usage.cache_read_input_tokens as number) ??
            0;

          // OpenAI reports input/prompt tokens as the total prompt size, with
          // cached tokens surfaced as a breakdown in input_tokens_details.
          // Normalize to our internal convention where inputTokens is the
          // uncached portion and cacheReadTokens is additive for total context.
          inputTokens = Math.max(0, totalInputTokens - cacheReadTokens);
        }

        // Extract any text from done response that wasn't streamed
        if (!currentText && Array.isArray(resp?.output)) {
          for (const item of resp.output as Array<Record<string, unknown>>) {
            if (item.type === "message" && Array.isArray(item.content)) {
              for (const c of item.content as Array<Record<string, unknown>>) {
                if (c.type === "output_text" && typeof c.text === "string") {
                  currentText += c.text;
                  yield { type: "text_delta", text: c.text as string };
                }
              }
            }
            // Extract reasoning summaries from done event — only if not already streamed via deltas
            if (
              item.type === "reasoning" &&
              Array.isArray(item.summary) &&
              !currentThinking
            ) {
              for (const s of item.summary as Array<Record<string, unknown>>) {
                if (s?.type === "summary_text" && typeof s.text === "string") {
                  if (!thinkingId) {
                    thinkingId = randomUUID();
                    yield { type: "thinking_start", thinkingId };
                  }
                  currentThinking += s.text;
                  yield {
                    type: "thinking_delta",
                    thinkingId,
                    text: s.text as string,
                  };
                }
              }
            }
          }
        }
        // Don't break — there might be more events in the stream
        continue;
      }
    }

    // ── Finalize ──

    // Close thinking block if open
    if (thinkingId) {
      yield { type: "thinking_end", thinkingId };
      contentBlocks.unshift({
        type: "thinking",
        thinking: currentThinking,
        signature: "", // Codex doesn't use signatures
      } satisfies ThinkingBlock);
    }

    // Add text block if any text was accumulated
    if (currentText) {
      contentBlocks.push({ type: "text", text: currentText });
    }

    yield {
      type: "usage",
      inputTokens,
      outputTokens,
      cacheReadTokens: cacheReadTokens || undefined,
      providerResponseId,
    };
    yield { type: "content_blocks", blocks: contentBlocks };
    yield { type: "done" };
  }

  private async *executeStream(
    requestBody: CodexRequestBody,
    auth: OpenAiCodexResolvedAuth,
    _model: string,
    signal?: AbortSignal,
  ): AsyncGenerator<ProviderStreamEvent> {
    try {
      const client = this.getClient(auth);
      const stream = await client.responses.create(requestBody, {
        signal,
        maxRetries: 0,
      });

      yield* this.processResponseStreamEvents(
        stream as AsyncIterable<Record<string, unknown>>,
      );
      return;
    } catch (error) {
      throw this.normalizeSdkError(error);
    }
  }
}
