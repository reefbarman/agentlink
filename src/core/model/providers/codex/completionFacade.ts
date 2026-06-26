import type { CoreReasoningEffort } from "../../../modelCatalog.js";
import type {
  CoreModelStreamEvent,
  CoreModelToolDefinition,
  CoreModelUsage,
} from "../../../modelRuntime.js";
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
  request: CodexResolvedRequestBodyResult;
}

export async function collectCodexCompletionResult(
  events: AsyncIterable<CoreModelStreamEvent>,
  options: {
    trimText?: boolean;
    onTextDelta?: (delta: string) => void;
  } = {},
): Promise<Omit<CodexCompletionResult, "request">> {
  let text = "";
  let usage: CoreModelUsage | undefined;
  let providerResponseId: string | undefined;
  const toolCalls: CodexCompletionToolCall[] = [];

  for await (const event of events) {
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
    } else if (event.type === "usage") {
      usage = {
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        cacheReadTokens: event.cacheReadTokens,
        cacheCreationTokens: event.cacheCreationTokens,
      };
      providerResponseId = event.providerResponseId;
    }
  }

  return {
    text: options.trimText === false ? text : text.trim(),
    toolCalls,
    usage,
    providerResponseId,
  };
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
  signal?: AbortSignal;
  onTextDelta?: (delta: string) => void;
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
  });

  try {
    const result = await collectCodexCompletionResult(
      executeCodexResponsesStream({
        client: args.client,
        body: request.body,
        signal: args.signal,
      }),
      { trimText: args.trimText, onTextDelta: args.onTextDelta },
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
