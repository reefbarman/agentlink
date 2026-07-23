import type {
  CoreModelContentBlock,
  CoreModelMessage,
  CoreModelStopReason,
  CoreModelStreamEvent,
  CoreModelUsage,
} from "../../../modelRuntime.js";
import {
  CORE_WEB_ACCESS_DEFAULT_MAX_REPLAY_BYTES_PER_TURN,
  createCoreProviderReplayEnvelope,
  type CoreJsonValue,
} from "../../../webAccess.js";
import { createOpenAiCompatibleInBandError } from "./errors.js";
import type {
  OpenAiCompatibleChatChunk,
  OpenAiCompatibleStreamOptions,
  OpenAiCompatibleUsage,
} from "./types.js";

interface ChoiceBuffer {
  text: string;
  reasoning: string;
  reasoningContent: string;
  visibleReasoning: string;
  reasoningDetails: CoreJsonValue[];
  thinkingId?: string;
  thinkingStarted: boolean;
  finishReason?: string;
}

interface ToolCallBuffer {
  choiceIndex: number;
  toolIndex: number;
  id: string;
  name: string;
  arguments: string;
  started: boolean;
  emittedArgumentLength: number;
}

export class OpenAiCompatibleStreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenAiCompatibleStreamError";
  }
}

export async function* parseOpenAiCompatibleStreamEvents(
  chunks: AsyncIterable<OpenAiCompatibleChatChunk>,
  options: OpenAiCompatibleStreamOptions,
): AsyncGenerator<CoreModelStreamEvent> {
  const choices = new Map<number, ChoiceBuffer>();
  const toolCalls = new Map<string, ToolCallBuffer>();
  let providerResponseId: string | undefined;
  let reportedUsage: OpenAiCompatibleUsage | undefined;
  let sawChunk = false;

  for await (const chunk of chunks) {
    sawChunk = true;
    if (chunk.error !== undefined) {
      throw createOpenAiCompatibleInBandError(
        { error: chunk.error },
        { sensitiveValues: options.sensitiveValues },
      );
    }
    if (typeof chunk.id === "string") providerResponseId = chunk.id;
    if (chunk.usage) reportedUsage = chunk.usage;

    for (const rawChoice of chunk.choices ?? []) {
      const choiceIndex = positiveIntegerOrZero(rawChoice.index);
      const choice = getChoice(choices, choiceIndex);
      const delta = rawChoice.delta;
      if (delta) {
        const content = typeof delta.content === "string" ? delta.content : "";
        if (content) {
          choice.text += content;
          markOutputStarted(options);
          yield { type: "text_delta", text: content };
        }

        const reasoning =
          typeof delta.reasoning === "string" ? delta.reasoning : "";
        const reasoningContent =
          typeof delta.reasoning_content === "string"
            ? delta.reasoning_content
            : "";
        const visibleReasoning = `${reasoning}${reasoningContent}`;
        if (reasoning) choice.reasoning += reasoning;
        if (reasoningContent) choice.reasoningContent += reasoningContent;
        choice.visibleReasoning += visibleReasoning;
        if (visibleReasoning) {
          if (!choice.thinkingStarted) {
            choice.thinkingStarted = true;
            choice.thinkingId =
              options.createThinkingId?.(choiceIndex) ??
              `openai-compatible-thinking-${choiceIndex}`;
            markOutputStarted(options);
            yield {
              type: "thinking_start",
              thinkingId: choice.thinkingId,
            };
          }
          yield {
            type: "thinking_delta",
            thinkingId: choice.thinkingId!,
            text: visibleReasoning,
          };
        }
        if (Array.isArray(delta.reasoning_details)) {
          choice.reasoningDetails.push(...delta.reasoning_details);
        } else if (delta.reasoning_details !== undefined) {
          choice.reasoningDetails.push(delta.reasoning_details);
        }

        for (const deltaCall of delta.tool_calls ?? []) {
          markOutputStarted(options);
          const toolIndex = positiveIntegerOrZero(deltaCall.index);
          const key = `${choiceIndex}:${toolIndex}`;
          const call =
            toolCalls.get(key) ??
            ({
              choiceIndex,
              toolIndex,
              id: "",
              name: "",
              arguments: "",
              started: false,
              emittedArgumentLength: 0,
            } satisfies ToolCallBuffer);
          if (typeof deltaCall.id === "string") {
            call.id = mergeStreamedField(call.id, deltaCall.id);
          }
          if (typeof deltaCall.function?.name === "string") {
            call.name = mergeStreamedField(call.name, deltaCall.function.name);
          }
          if (typeof deltaCall.function?.arguments === "string") {
            call.arguments += deltaCall.function.arguments;
          }
          toolCalls.set(key, call);
          if (!call.started && call.id && call.name) {
            call.started = true;
            markOutputStarted(options);
            yield {
              type: "tool_start",
              toolCallId: call.id,
              toolName: call.name,
            };
          }
          if (
            call.started &&
            call.arguments.length > call.emittedArgumentLength
          ) {
            const partialJson = call.arguments.slice(
              call.emittedArgumentLength,
            );
            call.emittedArgumentLength = call.arguments.length;
            yield {
              type: "tool_input_delta",
              toolCallId: call.id,
              partialJson,
            };
          }
        }
      }
      if (typeof rawChoice.finish_reason === "string") {
        choice.finishReason = rawChoice.finish_reason;
      }
    }
  }

  if (!sawChunk) {
    throw new OpenAiCompatibleStreamError(
      "OpenAI-compatible stream ended before any provider event",
    );
  }

  for (const [, choice] of sortedChoices(choices)) {
    if (choice.thinkingStarted) {
      yield { type: "thinking_end", thinkingId: choice.thinkingId! };
    }
  }

  const publicBlocks: CoreModelContentBlock[] = [];
  const replayChoices: Array<Record<string, CoreJsonValue>> = [];
  let outputCharacters = 0;
  for (const [choiceIndex, choice] of sortedChoices(choices)) {
    if (choice.visibleReasoning) {
      publicBlocks.push({
        type: "thinking",
        thinking: choice.visibleReasoning,
        signature: "",
      });
      outputCharacters += choice.visibleReasoning.length;
    }
    if (choice.text) {
      publicBlocks.push({ type: "text", text: choice.text });
      outputCharacters += choice.text.length;
    }
    const replay: Record<string, CoreJsonValue> = { index: choiceIndex };
    if (choice.reasoning) replay.reasoning = choice.reasoning;
    if (choice.reasoningContent)
      replay.reasoning_content = choice.reasoningContent;
    if (choice.reasoningDetails.length === 1) {
      replay.reasoning_details = choice.reasoningDetails[0];
    } else if (choice.reasoningDetails.length > 1) {
      replay.reasoning_details = choice.reasoningDetails;
    }
    if (Object.keys(replay).length > 1) replayChoices.push(replay);
  }

  const completedTools = [...toolCalls.values()].sort(
    (left, right) =>
      left.choiceIndex - right.choiceIndex || left.toolIndex - right.toolIndex,
  );
  for (const call of completedTools) {
    if (!call.id || !call.name) {
      throw new OpenAiCompatibleStreamError(
        `OpenAI-compatible tool call ${call.choiceIndex}:${call.toolIndex} is missing a final ID or function name`,
      );
    }
    const input = parseToolArguments(call.arguments, call.id);
    publicBlocks.push({
      type: "tool_use",
      id: call.id,
      name: call.name,
      input,
    });
    outputCharacters += call.arguments.length;
    yield {
      type: "tool_done",
      toolCallId: call.id,
      toolName: call.name,
      input,
    };
  }

  const replay =
    replayChoices.length > 0
      ? createCoreProviderReplayEnvelope({
          providerId: options.providerId,
          codecVersion: 1,
          payload:
            replayChoices.length === 1
              ? replayChoices[0]
              : { choices: replayChoices },
          maxBytes:
            options.maxReplayBytes ??
            CORE_WEB_ACCESS_DEFAULT_MAX_REPLAY_BYTES_PER_TURN,
        })
      : undefined;
  const assistantMessage: CoreModelMessage = {
    role: "assistant",
    content: publicBlocks,
    ...(replay ? { providerReplay: replay } : {}),
  };
  const stopReason = normalizeStopReason(
    [...sortedChoices(choices)].map(([, choice]) => choice.finishReason),
    completedTools.length > 0,
  );
  const reportedInputTokens = nonNegativeInteger(reportedUsage?.prompt_tokens);
  const reportedOutputTokens = nonNegativeInteger(
    reportedUsage?.completion_tokens,
  );
  const finalUsage: CoreModelUsage = {
    inputTokens: reportedInputTokens ?? options.estimatedInputTokens,
    outputTokens: reportedOutputTokens ?? estimateTokens(outputCharacters),
    ...(reportedInputTokens === undefined || reportedOutputTokens === undefined
      ? { estimated: true }
      : {}),
  };

  yield {
    type: "usage",
    inputTokens: finalUsage.inputTokens,
    outputTokens: finalUsage.outputTokens,
    ...(finalUsage.estimated ? { estimated: true } : {}),
    ...(providerResponseId ? { providerResponseId } : {}),
  };
  yield { type: "content_blocks", blocks: publicBlocks };
  yield {
    type: "model_stop",
    reason: stopReason,
    assistantMessage,
  };
  yield { type: "done" };
}

export function estimateOpenAiCompatibleInputTokens(value: unknown): number {
  return estimateTokens(JSON.stringify(value).length);
}

function estimateTokens(characters: number): number {
  return characters <= 0 ? 0 : Math.ceil(characters / 4);
}

function getChoice(
  choices: Map<number, ChoiceBuffer>,
  index: number,
): ChoiceBuffer {
  const existing = choices.get(index);
  if (existing) return existing;
  const created: ChoiceBuffer = {
    text: "",
    reasoning: "",
    reasoningContent: "",
    visibleReasoning: "",
    reasoningDetails: [],
    thinkingStarted: false,
  };
  choices.set(index, created);
  return created;
}

function sortedChoices(
  choices: Map<number, ChoiceBuffer>,
): Array<[number, ChoiceBuffer]> {
  return [...choices.entries()].sort(([left], [right]) => left - right);
}

function mergeStreamedField(existing: string, incoming: string): string {
  if (!incoming) return existing;
  if (!existing || incoming.startsWith(existing)) return incoming;
  if (existing.startsWith(incoming) || existing.endsWith(incoming))
    return existing;
  return existing + incoming;
}

function parseToolArguments(
  rawArguments: string,
  toolCallId: string,
): Record<string, unknown> {
  if (!rawArguments.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawArguments);
  } catch {
    throw new OpenAiCompatibleStreamError(
      `OpenAI-compatible tool call ${toolCallId} returned malformed JSON arguments`,
    );
  }
  if (!isRecord(parsed)) {
    throw new OpenAiCompatibleStreamError(
      `OpenAI-compatible tool call ${toolCallId} arguments must be a JSON object`,
    );
  }
  return parsed;
}

function normalizeStopReason(
  reasons: Array<string | undefined>,
  hasTools: boolean,
): CoreModelStopReason {
  if (reasons.includes("length")) return "max_tokens";
  if (reasons.includes("tool_calls") || hasTools) return "tool_use";
  return "end_turn";
}

function markOutputStarted(options: OpenAiCompatibleStreamOptions): void {
  if (options.state) options.state.outputStarted = true;
}

function positiveIntegerOrZero(value: unknown): number {
  return nonNegativeInteger(value) ?? 0;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
