import type { CoreReasoningEffort } from "../../../modelCatalog.js";
import type {
  CoreModelContentBlock,
  CoreModelMessage,
  CoreModelProviderRequestAttempt,
  CoreModelStopReason,
  CoreModelStreamEvent,
  CoreModelToolDefinition,
  CoreModelUsage,
} from "../../../modelRuntime.js";
import type { CoreHostedToolDefinition } from "../../../webAccess.js";
import type { CodexAuthMethod } from "./models.js";
import { toCodexRequestError } from "./errors.js";
import {
  CodexResponsesAuthError,
  CodexResponsesStreamAbortedError,
  executeCodexResponsesStream,
  type CodexResponsesClient,
} from "./responsesStream.js";
import {
  buildCodexResolvedRequestBody,
  translateCodexTools,
  type CodexInputItem,
  type CodexPromptCacheRetention,
  type CodexResolvedRequestBodyResult,
} from "./translation.js";

export { CodexResponsesAuthError, CodexResponsesStreamAbortedError };

export interface CodexCompletionToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface CodexCompletionResult {
  text: string;
  toolCalls: CodexCompletionToolCall[];
  usage?: CoreModelUsage;
  providerResponseId?: string;
  assistantMessage: CoreModelMessage;
  stopReason: CoreModelStopReason;
  request: CodexResolvedRequestBodyResult;
}

export async function collectCodexCompletionResult(
  events: AsyncIterable<CoreModelStreamEvent>,
  options: {
    trimText?: boolean;
    onTextDelta?: (delta: string) => void;
    onStreamEvent?: (event: CoreModelStreamEvent) => void;
  } = {},
): Promise<Omit<CodexCompletionResult, "request">> {
  let text = "";
  let usage: CoreModelUsage | undefined;
  let providerResponseId: string | undefined;
  let assistantMessage: CoreModelMessage | undefined;
  let stopReason: CoreModelStopReason | undefined;
  let contentBlocks: CoreModelContentBlock[] | undefined;
  const toolCalls: CodexCompletionToolCall[] = [];

  for await (const event of events) {
    options.onStreamEvent?.(event);
    if (event.type === "text_delta") {
      text += event.text;
      options.onTextDelta?.(event.text);
    } else if (event.type === "tool_done") {
      toolCalls.push({
        id: event.toolCallId,
        name: event.toolName,
        input:
          event.input && typeof event.input === "object"
            ? (event.input as Record<string, unknown>)
            : {},
      });
    } else if (event.type === "content_blocks") {
      contentBlocks = event.blocks;
    } else if (event.type === "model_stop") {
      assistantMessage = event.assistantMessage;
      stopReason = event.reason;
    } else if (event.type === "usage") {
      usage = {
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        cacheReadTokens: event.cacheReadTokens,
        cacheCreationTokens: event.cacheCreationTokens,
        ...(event.serverToolUsage
          ? { serverToolUsage: event.serverToolUsage }
          : {}),
      };
      providerResponseId = event.providerResponseId;
    }
  }

  const finalText = options.trimText === false ? text : text.trim();
  return {
    text: finalText,
    toolCalls,
    usage,
    providerResponseId,
    assistantMessage:
      assistantMessage ??
      ({
        role: "assistant",
        content:
          contentBlocks ?? buildCodexAssistantBlocks(finalText, toolCalls),
      } satisfies CoreModelMessage),
    stopReason: stopReason ?? (toolCalls.length > 0 ? "tool_use" : "end_turn"),
  };
}

function buildCodexAssistantBlocks(
  text: string,
  toolCalls: readonly CodexCompletionToolCall[],
): CoreModelContentBlock[] {
  const blocks: CoreModelContentBlock[] = [];
  if (text) blocks.push({ type: "text", text });
  blocks.push(
    ...toolCalls.map((call) => ({
      type: "tool_use" as const,
      id: call.id,
      name: call.name,
      input: call.input,
    })),
  );
  return blocks;
}

export async function executeCodexResolvedCompletion(args: {
  client: CodexResponsesClient;
  authMethod: CodexAuthMethod;
  model?: string;
  instructions: string;
  input: CodexInputItem[];
  maxTokens?: number;
  state?: { store?: boolean; previousResponseId?: string };
  cache?: { key?: string; retention?: CodexPromptCacheRetention };
  reasoningEffort?: CoreReasoningEffort;
  tools?: readonly CoreModelToolDefinition[];
  hostedTools?: readonly CoreHostedToolDefinition[];
  signal?: AbortSignal;
  onTextDelta?: (delta: string) => void;
  onStreamEvent?: (event: CoreModelStreamEvent) => void;
  onProviderRequestAttempt?: (attempt: CoreModelProviderRequestAttempt) => void;
  trimText?: boolean;
}): Promise<CodexCompletionResult> {
  const request = buildCodexResolvedRequestBody({
    authMethod: args.authMethod,
    model: args.model,
    instructions: args.instructions,
    input: args.input,
    maxTokens: args.maxTokens,
    state: args.state,
    cache: args.cache,
    reasoningEffort: args.reasoningEffort,
    tools: args.tools ? translateCodexTools([...args.tools]) : undefined,
    hostedTools: args.hostedTools,
  });

  try {
    const result = await collectCodexCompletionResult(
      executeCodexResponsesStream({
        client: args.client,
        body: request.body,
        signal: args.signal,
        onProviderRequestAttempt: args.onProviderRequestAttempt,
      }),
      {
        trimText: args.trimText,
        onTextDelta: args.onTextDelta,
        onStreamEvent: args.onStreamEvent,
      },
    );

    return { ...result, request };
  } catch (error) {
    if (
      error instanceof CodexResponsesAuthError ||
      error instanceof CodexResponsesStreamAbortedError
    ) {
      throw error;
    }
    throw toCodexRequestError(error);
  }
}
