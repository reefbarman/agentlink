import type { CoreReasoningEffort } from "@agentlink/protocol/model-catalog";
import type {
  CoreModelMessage,
  CoreModelProviderRequestAttempt,
  CoreModelStopReason,
  CoreModelStreamEvent,
  CoreModelToolDefinition,
  CoreModelTransportActivity,
} from "../../../modelRuntime.js";
import type { CoreHostedToolDefinition } from "@agentlink/protocol/web-access-policy";
import { parseAnthropicStreamEvents } from "./streamParser.js";
import {
  translateAnthropicMessages,
  translateAnthropicTools,
  type AnthropicJsonObject,
  type AnthropicTranslatedMessage,
} from "./translation.js";

export interface AnthropicMessagesStreamClient {
  messages: {
    stream(
      request: AnthropicStreamRequest,
      options?: { signal?: AbortSignal; maxRetries?: number },
    ): AsyncIterable<unknown>;
  };
}

export interface AnthropicStreamRequest {
  model: string;
  system: Array<{
    type: "text";
    text: string;
    cache_control: { type: "ephemeral" };
  }>;
  messages: AnthropicTranslatedMessage[];
  max_tokens: number;
  stream: true;
  tools?: AnthropicJsonObject[];
  thinking?:
    | { type: "adaptive"; display: "summarized" }
    | { type: "enabled"; budget_tokens: number; display: "summarized" }
    | { type: "disabled" };
  output_config?: { effort: CoreReasoningEffort };
}

export interface AnthropicCompletionToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AnthropicCompletionResult {
  text: string;
  toolCalls: AnthropicCompletionToolCall[];
  assistantMessage: CoreModelMessage;
  stopReason: CoreModelStopReason;
}

export function buildAnthropicStreamRequest(args: {
  model: string;
  systemPrompt: string;
  messages: readonly CoreModelMessage[];
  maxTokens: number;
  reasoningEffort?: CoreReasoningEffort;
  supportsAdaptiveThinking: boolean;
  /**
   * True for models that think when `thinking` is omitted (Claude Opus 5 /
   * Sonnet 5). For those, turning thinking off must be explicit.
   */
  requiresExplicitThinkingDisable?: boolean;
  thinking?: { budgetTokens: number };
  tools?: readonly CoreModelToolDefinition[];
  hostedTools?: readonly CoreHostedToolDefinition[];
}): AnthropicStreamRequest {
  const translatedMessages = translateAnthropicMessages(args.messages);
  const tools = translateAnthropicTools(args.tools, args.hostedTools);
  const request: AnthropicStreamRequest = {
    model: args.model,
    system: [
      {
        type: "text",
        text: args.systemPrompt,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: translatedMessages.messages,
    max_tokens: args.maxTokens,
    stream: true,
    ...(tools ? { tools } : {}),
  };
  const requestedEffort = args.reasoningEffort ?? "high";
  if (
    requestedEffort !== "none" &&
    !translatedMessages.strippedThinkingFromToolUse
  ) {
    if (args.supportsAdaptiveThinking) {
      request.thinking = { type: "adaptive", display: "summarized" };
      request.output_config = { effort: requestedEffort };
    } else if (args.thinking) {
      request.thinking = {
        type: "enabled",
        budget_tokens: args.thinking.budgetTokens,
        display: "summarized",
      };
    }
  } else if (args.requiresExplicitThinkingDisable) {
    // Omitting `thinking` runs adaptive thinking on these models, so the
    // "none" effort level (and the stripped-thinking replay path) must
    // disable it explicitly. No `output_config.effort` is sent here — an
    // explicit disable is rejected at xhigh/max on Claude Opus 5.
    request.thinking = { type: "disabled" };
  }
  return request;
}

export async function executeAnthropicResolvedCompletion(args: {
  client: AnthropicMessagesStreamClient;
  model: string;
  systemPrompt: string;
  messages: readonly CoreModelMessage[];
  maxTokens: number;
  reasoningEffort?: CoreReasoningEffort;
  supportsAdaptiveThinking: boolean;
  requiresExplicitThinkingDisable?: boolean;
  thinking?: { budgetTokens: number };
  tools?: readonly CoreModelToolDefinition[];
  hostedTools?: readonly CoreHostedToolDefinition[];
  signal?: AbortSignal;
  onTextDelta?: (delta: string) => void;
  onStreamEvent?: (event: CoreModelStreamEvent) => void;
  onProviderRequestAttempt?: (attempt: CoreModelProviderRequestAttempt) => void;
  onTransportActivity?: (activity: CoreModelTransportActivity) => void;
}): Promise<AnthropicCompletionResult> {
  const request = buildAnthropicStreamRequest(args);
  args.onProviderRequestAttempt?.({ model: args.model });
  const stream = args.client.messages.stream(request, {
    signal: args.signal,
    maxRetries: 0,
  });
  const rawEvents = (async function* () {
    for await (const event of stream) {
      args.onTransportActivity?.({ kind: "provider_event", at: Date.now() });
      if (isRecord(event)) yield event;
    }
  })();

  let text = "";
  const toolCalls: AnthropicCompletionToolCall[] = [];
  let assistantMessage: CoreModelMessage | undefined;
  let stopReason: CoreModelStopReason | undefined;
  for await (const event of parseAnthropicStreamEvents(rawEvents)) {
    args.onStreamEvent?.(event);
    if (event.type === "text_delta") {
      text += event.text;
      args.onTextDelta?.(event.text);
    } else if (event.type === "tool_done") {
      toolCalls.push({
        id: event.toolCallId,
        name: event.toolName,
        input: isRecord(event.input) ? event.input : {},
      });
    } else if (event.type === "model_stop") {
      assistantMessage = event.assistantMessage;
      stopReason = event.reason;
    }
  }

  return {
    text: text.trim(),
    toolCalls,
    assistantMessage:
      assistantMessage ?? buildFallbackAssistantMessage(text, toolCalls),
    stopReason: stopReason ?? (toolCalls.length > 0 ? "tool_use" : "end_turn"),
  };
}

function buildFallbackAssistantMessage(
  text: string,
  toolCalls: readonly AnthropicCompletionToolCall[],
): CoreModelMessage {
  return {
    role: "assistant",
    content: [
      ...(text ? [{ type: "text" as const, text }] : []),
      ...toolCalls.map((call) => ({
        type: "tool_use" as const,
        id: call.id,
        name: call.name,
        input: call.input,
      })),
    ],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
