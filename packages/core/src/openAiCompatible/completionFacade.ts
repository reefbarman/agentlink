import type {
  CoreModelCompleteRequest,
  CoreModelCompleteResult,
  CoreModelContentBlock,
  CoreModelMessage,
  CoreModelStopReason,
  CoreModelStreamEvent,
  CoreModelStreamRequest,
  CoreModelUsage,
} from "../modelRuntime.js";
import {
  OpenAiCompatibleAbortError,
  OpenAiCompatibleRequestError,
  OpenAiCompatibleTimeoutError,
  createOpenAiCompatibleHttpError,
  isOpenAiCompatibleRetryableError,
  toOpenAiCompatibleRequestError,
} from "./errors.js";
import type {
  OpenAiCompatibleChatChunk,
  OpenAiCompatibleFacadeRequest,
  OpenAiCompatibleFetch,
  OpenAiCompatibleRuntimeModel,
  OpenAiCompatibleRuntimeProfile,
} from "./types.js";
import {
  OpenAiCompatibleStreamError,
  estimateOpenAiCompatibleInputTokens,
  parseOpenAiCompatibleStreamEvents,
} from "./streamParser.js";

import { buildOpenAiCompatibleChatRequest } from "./translation.js";
import { parseOpenAiCompatibleSse } from "./sse.js";

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 250;

export interface OpenAiCompatibleCompletionToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface OpenAiCompatibleCompletionResult extends CoreModelCompleteResult {
  toolCalls: OpenAiCompatibleCompletionToolCall[];
  assistantMessage: CoreModelMessage;
  stopReason: CoreModelStopReason;
}

export async function* streamOpenAiCompatibleCompletion(
  args: OpenAiCompatibleFacadeRequest,
): AsyncGenerator<CoreModelStreamEvent> {
  const model = resolveRuntimeModel(args.profile, args.request.model);
  const body = buildOpenAiCompatibleChatRequest({
    providerId: args.profile.providerId,
    profile: args.profile.profile,
    reasoningEffortMode: args.profile.reasoningEffortMode,
    model,
    systemPrompt: args.request.systemPrompt,
    messages: args.request.messages,
    maxTokens: args.request.maxTokens,
    reasoningEffort: args.request.reasoningEffort,
    tools: args.request.tools,
    temperature: args.temperature,
  });
  const estimatedInputTokens = estimateOpenAiCompatibleInputTokens(body);
  const fetchImpl = args.fetch ?? globalThis.fetch;
  const maxRetries = Math.max(0, args.maxRetries ?? DEFAULT_MAX_RETRIES);
  const retryDelay = args.retryDelay ?? defaultRetryDelay;
  const state = { outputStarted: false };
  const abort = createRequestAbort(args.request.signal, args.profile.timeoutMs);

  try {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const response = await executeFetch({
          profile: args.profile,
          apiKey: args.apiKey,
          body,
          fetch: fetchImpl,
          signal: abort.signal,
          onProviderRequestAttempt: () =>
            args.request.onProviderRequestAttempt?.({ model: model.model }),
          onHeaders: () =>
            args.request.onTransportActivity?.({
              kind: "headers",
              at: args.now?.() ?? Date.now(),
            }),
        });
        if (isRedirect(response.status)) {
          throw new OpenAiCompatibleRequestError({
            message: `OpenAI-compatible endpoint returned forbidden redirect HTTP ${response.status}`,
            status: response.status,
            retryable: false,
            authentication: false,
          });
        }
        if (!response.ok) {
          throw await createOpenAiCompatibleHttpError(response, {
            now: args.now,
            sensitiveValues: args.apiKey ? [args.apiKey] : undefined,
          });
        }
        if (!response.body) {
          throw new OpenAiCompatibleRequestError({
            message: "OpenAI-compatible response did not include a stream body",
            status: response.status,
            retryable: true,
            authentication: false,
          });
        }

        const chunks = decodeOpenAiCompatibleResponse(
          response.body,
          args.request.onTransportActivity,
          args.now,
        );
        yield* parseOpenAiCompatibleStreamEvents(chunks, {
          providerId: args.profile.providerId,
          estimatedInputTokens,
          state,
          sensitiveValues: args.apiKey ? [args.apiKey] : undefined,
          availableToolNames: args.request.tools?.map((tool) => tool.name),
        });
        return;
      } catch (error) {
        const normalized = normalizeFacadeError(
          error,
          abort,
          args.profile.timeoutMs,
          args.apiKey ? [args.apiKey] : undefined,
        );
        if (
          state.outputStarted ||
          normalized instanceof OpenAiCompatibleTimeoutError ||
          attempt >= maxRetries ||
          !isOpenAiCompatibleRetryableError(normalized)
        ) {
          throw normalized;
        }
        const retryAfterMs =
          normalized instanceof OpenAiCompatibleRequestError
            ? normalized.retryAfterMs
            : undefined;
        try {
          await retryDelay(
            retryAfterMs ?? DEFAULT_RETRY_DELAY_MS * 2 ** attempt,
            abort.signal,
          );
        } catch (delayError) {
          throw normalizeFacadeError(
            delayError,
            abort,
            args.profile.timeoutMs,
            args.apiKey ? [args.apiKey] : undefined,
          );
        }
      }
    }
  } finally {
    abort.dispose();
  }
}

export async function completeOpenAiCompatibleCompletion(args: {
  profile: OpenAiCompatibleRuntimeProfile;
  apiKey?: string;
  request: CoreModelCompleteRequest;
  fetch?: OpenAiCompatibleFetch;
  maxRetries?: number;
  retryDelay?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}): Promise<OpenAiCompatibleCompletionResult> {
  const request: CoreModelStreamRequest = {
    ...args.request,
    tools: undefined,
  };
  return collectOpenAiCompatibleCompletion(
    streamOpenAiCompatibleCompletion({
      ...args,
      request,
      temperature: args.request.temperature,
    }),
  );
}

export async function collectOpenAiCompatibleCompletion(
  events: AsyncIterable<CoreModelStreamEvent>,
): Promise<OpenAiCompatibleCompletionResult> {
  let text = "";
  let usage: CoreModelUsage | undefined;
  let providerResponseId: string | undefined;
  let assistantMessage: CoreModelMessage | undefined;
  let stopReason: CoreModelStopReason | undefined;
  let contentBlocks: CoreModelContentBlock[] | undefined;
  const toolCalls: OpenAiCompatibleCompletionToolCall[] = [];

  for await (const event of events) {
    if (event.type === "text_delta") text += event.text;
    else if (event.type === "tool_done") {
      toolCalls.push({
        id: event.toolCallId,
        name: event.toolName,
        input: isRecord(event.input) ? event.input : {},
      });
    } else if (event.type === "usage") {
      usage = {
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        ...(event.cacheReadTokens !== undefined
          ? { cacheReadTokens: event.cacheReadTokens }
          : {}),
        ...(event.cacheCreationTokens !== undefined
          ? { cacheCreationTokens: event.cacheCreationTokens }
          : {}),
        ...(event.inputTokenBreakdownReported !== undefined
          ? {
              inputTokenBreakdownReported: event.inputTokenBreakdownReported,
            }
          : {}),
        ...(event.serverToolUsage
          ? { serverToolUsage: event.serverToolUsage }
          : {}),
        ...(event.estimated ? { estimated: true } : {}),
      };
      providerResponseId = event.providerResponseId;
    } else if (event.type === "content_blocks") {
      contentBlocks = event.blocks;
    } else if (event.type === "model_stop") {
      assistantMessage = event.assistantMessage;
      stopReason = event.reason;
    }
  }

  const fallbackMessage: CoreModelMessage = {
    role: "assistant",
    content: contentBlocks ?? [
      ...(text ? [{ type: "text" as const, text }] : []),
      ...toolCalls.map((call) => ({
        type: "tool_use" as const,
        id: call.id,
        name: call.name,
        input: call.input,
      })),
    ],
  };
  return {
    text,
    toolCalls,
    usage,
    providerResponseId,
    assistantMessage: assistantMessage ?? fallbackMessage,
    stopReason: stopReason ?? (toolCalls.length > 0 ? "tool_use" : "end_turn"),
  };
}

async function executeFetch(args: {
  profile: OpenAiCompatibleRuntimeProfile;
  apiKey?: string;
  body: unknown;
  fetch: OpenAiCompatibleFetch;
  signal: AbortSignal;
  onProviderRequestAttempt: () => void;
  onHeaders: () => void;
}): Promise<Response> {
  if (args.profile.authRequired && !args.apiKey) {
    throw new OpenAiCompatibleRequestError({
      message: "OpenAI-compatible API key is required for this connection",
      providerCode: "auth_required",
      retryable: false,
      authentication: true,
    });
  }
  const headers = new Headers(args.profile.headers);
  headers.set("Accept", "text/event-stream");
  headers.set("Content-Type", "application/json");
  if (args.apiKey) headers.set("Authorization", `Bearer ${args.apiKey}`);
  if (args.profile.profile === "openrouter") {
    headers.set("X-OpenRouter-Title", "AgentLink");
    headers.set("X-OpenRouter-Categories", "ide-extension");
  }
  args.onProviderRequestAttempt();
  const response = await args.fetch(
    `${args.profile.baseUrl.replace(/\/$/, "")}/chat/completions`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(args.body),
      signal: args.signal,
      redirect: "manual",
    },
  );
  args.onHeaders();
  return response;
}

async function* decodeOpenAiCompatibleResponse(
  body: ReadableStream<Uint8Array>,
  onTransportActivity?: CoreModelStreamRequest["onTransportActivity"],
  now?: () => number,
): AsyncGenerator<OpenAiCompatibleChatChunk> {
  let done = false;
  let sawFinishReason = false;
  const bytes = observeBody(body, onTransportActivity, now);
  for await (const frame of parseOpenAiCompatibleSse(bytes)) {
    onTransportActivity?.({
      kind: "provider_event",
      at: now?.() ?? Date.now(),
    });
    if (frame.data.trim() === "[DONE]") {
      done = true;
      break;
    }
    let value: unknown;
    try {
      value = JSON.parse(frame.data);
    } catch {
      throw new OpenAiCompatibleStreamError(
        "OpenAI-compatible SSE frame contained invalid JSON",
      );
    }
    if (!isRecord(value)) {
      throw new OpenAiCompatibleStreamError(
        "OpenAI-compatible SSE frame must contain a JSON object",
      );
    }
    const chunk = value as OpenAiCompatibleChatChunk;
    sawFinishReason ||=
      Array.isArray(chunk.choices) &&
      chunk.choices.some((choice) => typeof choice.finish_reason === "string");
    yield chunk;
  }
  if (!done && !sawFinishReason) {
    throw new OpenAiCompatibleStreamError(
      "OpenAI-compatible SSE stream ended before a finish reason or [DONE]",
    );
  }
}

async function* observeBody(
  body: ReadableStream<Uint8Array>,
  onTransportActivity?: CoreModelStreamRequest["onTransportActivity"],
  now?: () => number,
): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) return;
      onTransportActivity?.({
        kind: "body",
        at: now?.() ?? Date.now(),
        bytes: result.value.byteLength,
      });
      yield result.value;
    }
  } finally {
    reader.releaseLock();
  }
}

function resolveRuntimeModel(
  profile: OpenAiCompatibleRuntimeProfile,
  modelId: string,
): OpenAiCompatibleRuntimeModel {
  const model = profile.models[modelId];
  if (!model) {
    throw new OpenAiCompatibleRequestError({
      message: `OpenAI-compatible connection does not define model ${modelId}`,
      providerCode: "model_not_found",
      retryable: false,
      authentication: false,
    });
  }
  return model;
}

function createRequestAbort(
  sourceSignal: AbortSignal | undefined,
  timeoutMs: number,
): {
  signal: AbortSignal;
  timedOut: () => boolean;
  dispose: () => void;
} {
  const controller = new AbortController();
  let timeoutTriggered = false;
  const onSourceAbort = () => controller.abort(sourceSignal?.reason);
  if (sourceSignal?.aborted) onSourceAbort();
  else sourceSignal?.addEventListener("abort", onSourceAbort, { once: true });
  const timer = setTimeout(() => {
    timeoutTriggered = true;
    controller.abort(new Error("OpenAI-compatible request timeout"));
  }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => timeoutTriggered,
    dispose: () => {
      clearTimeout(timer);
      sourceSignal?.removeEventListener("abort", onSourceAbort);
    },
  };
}

function normalizeFacadeError(
  error: unknown,
  abort: { timedOut: () => boolean },
  timeoutMs: number,
  sensitiveValues?: readonly string[],
): OpenAiCompatibleRequestError | OpenAiCompatibleAbortError {
  if (abort.timedOut()) return new OpenAiCompatibleTimeoutError(timeoutMs);
  return toOpenAiCompatibleRequestError(error, { sensitiveValues });
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

function defaultRetryDelay(
  delayMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) return Promise.reject(new OpenAiCompatibleAbortError());
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new OpenAiCompatibleAbortError());
    };
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
