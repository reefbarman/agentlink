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

interface TextToolCall {
  name: string;
  input: Record<string, unknown>;
}

interface ParsedTextDelta {
  visibleText: string;
  toolCalls: TextToolCall[];
}

const TEXT_TOOL_MARKER = /<(?:invoke\b|mcp__|\/?function_calls\b)/i;
const TEXT_TOOL_MARKER_PREFIXES = [
  "<invoke",
  "<mcp__",
  "<function_calls",
  "</function_calls",
] as const;

export class OpenAiCompatibleStreamError extends Error {
  readonly retryable?: boolean;
  readonly retryLayer?: "request" | "stream";

  constructor(
    message: string,
    options: { retryable?: boolean; retryLayer?: "request" | "stream" } = {},
  ) {
    super(message);
    this.name = "OpenAiCompatibleStreamError";
    this.retryable = options.retryable;
    this.retryLayer = options.retryLayer;
  }
}

export async function* parseOpenAiCompatibleStreamEvents(
  chunks: AsyncIterable<OpenAiCompatibleChatChunk>,
  options: OpenAiCompatibleStreamOptions,
): AsyncGenerator<CoreModelStreamEvent> {
  const choices = new Map<number, ChoiceBuffer>();
  const toolCalls = new Map<string, ToolCallBuffer>();
  const textToolParsers = new Map<number, TextToolCallParser>();
  const availableToolNames = new Set(options.availableToolNames ?? []);
  let textToolCallSequence = 0;
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
          markOutputStarted(options);
          const parsed =
            availableToolNames.size > 0
              ? getTextToolParser(
                  textToolParsers,
                  choiceIndex,
                  availableToolNames,
                ).push(content)
              : { visibleText: content, toolCalls: [] };
          choice.text += parsed.visibleText;
          if (parsed.visibleText) {
            yield { type: "text_delta", text: parsed.visibleText };
          }
          for (const parsedCall of parsed.toolCalls) {
            textToolCallSequence += 1;
            const id = `openai-compatible-text-tool-${globalThis.crypto.randomUUID()}`;
            const argumentsJson = JSON.stringify(parsedCall.input);
            toolCalls.set(`text:${choiceIndex}:${textToolCallSequence}`, {
              choiceIndex,
              toolIndex: Number.MAX_SAFE_INTEGER,
              id,
              name: parsedCall.name,
              arguments: argumentsJson,
              started: true,
              emittedArgumentLength: argumentsJson.length,
            });
            yield {
              type: "tool_start",
              toolCallId: id,
              toolName: parsedCall.name,
            };
            yield {
              type: "tool_input_delta",
              toolCallId: id,
              partialJson: argumentsJson,
            };
          }
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
      { retryable: true, retryLayer: "stream" },
    );
  }

  for (const [choiceIndex, choice] of sortedChoices(choices)) {
    const pendingText = textToolParsers.get(choiceIndex)?.finish() ?? "";
    if (pendingText) {
      choice.text += pendingText;
      yield { type: "text_delta", text: pendingText };
    }
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
  const inputDetails = reportedUsage?.input_tokens_details;
  const promptDetails = reportedUsage?.prompt_tokens_details;
  const inputTokenBreakdownReported = Boolean(
    (inputDetails &&
      (Object.hasOwn(inputDetails, "cached_tokens") ||
        Object.hasOwn(inputDetails, "cache_creation_tokens") ||
        Object.hasOwn(inputDetails, "cache_write_tokens"))) ||
    (promptDetails &&
      (Object.hasOwn(promptDetails, "cached_tokens") ||
        Object.hasOwn(promptDetails, "cache_creation_tokens") ||
        Object.hasOwn(promptDetails, "cache_write_tokens"))) ||
    (reportedUsage &&
      (Object.hasOwn(reportedUsage, "cache_read_input_tokens") ||
        Object.hasOwn(reportedUsage, "cache_creation_input_tokens") ||
        Object.hasOwn(reportedUsage, "cache_write_input_tokens") ||
        Object.hasOwn(reportedUsage, "cache_write_tokens"))),
  );
  const cacheReadTokens = inputTokenBreakdownReported
    ? (nonNegativeInteger(inputDetails?.cached_tokens) ??
      nonNegativeInteger(promptDetails?.cached_tokens) ??
      nonNegativeInteger(reportedUsage?.cache_read_input_tokens) ??
      0)
    : undefined;
  const detailedCacheCreationTokens =
    nonNegativeInteger(inputDetails?.cache_creation_tokens) ??
    nonNegativeInteger(inputDetails?.cache_write_tokens) ??
    nonNegativeInteger(promptDetails?.cache_creation_tokens) ??
    nonNegativeInteger(promptDetails?.cache_write_tokens);
  const cacheCreationTokens = inputTokenBreakdownReported
    ? (detailedCacheCreationTokens ??
      nonNegativeInteger(reportedUsage?.cache_creation_input_tokens) ??
      nonNegativeInteger(reportedUsage?.cache_write_input_tokens) ??
      nonNegativeInteger(reportedUsage?.cache_write_tokens) ??
      0)
    : undefined;
  const finalUsage: CoreModelUsage = {
    inputTokens:
      reportedInputTokens === undefined
        ? options.estimatedInputTokens
        : Math.max(
            0,
            reportedInputTokens -
              (cacheReadTokens ?? 0) -
              (detailedCacheCreationTokens ?? 0),
          ),
    outputTokens: reportedOutputTokens ?? estimateTokens(outputCharacters),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheCreationTokens !== undefined ? { cacheCreationTokens } : {}),
    ...(inputTokenBreakdownReported
      ? { inputTokenBreakdownReported: true }
      : {}),
    ...(reportedInputTokens === undefined || reportedOutputTokens === undefined
      ? { estimated: true }
      : {}),
  };

  yield {
    type: "usage",
    inputTokens: finalUsage.inputTokens,
    outputTokens: finalUsage.outputTokens,
    ...(finalUsage.cacheReadTokens !== undefined
      ? { cacheReadTokens: finalUsage.cacheReadTokens }
      : {}),
    ...(finalUsage.cacheCreationTokens !== undefined
      ? { cacheCreationTokens: finalUsage.cacheCreationTokens }
      : {}),
    ...(finalUsage.inputTokenBreakdownReported
      ? { inputTokenBreakdownReported: true }
      : {}),
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

class TextToolCallParser {
  private pending = "";

  constructor(private readonly availableToolNames: ReadonlySet<string>) {}

  push(text: string): ParsedTextDelta {
    this.pending += text;
    return this.drain(false);
  }

  finish(): string {
    return this.drain(true).visibleText;
  }

  private drain(final: boolean): ParsedTextDelta {
    let visibleText = "";
    const toolCalls: TextToolCall[] = [];

    while (this.pending) {
      const marker = TEXT_TOOL_MARKER.exec(this.pending);
      if (!marker) {
        if (final) {
          visibleText += this.pending;
          this.pending = "";
          break;
        }
        const heldPrefixIndex = getHeldTextToolPrefixIndex(this.pending);
        if (heldPrefixIndex < 0) {
          visibleText += this.pending;
          this.pending = "";
        } else {
          visibleText += this.pending.slice(0, heldPrefixIndex);
          this.pending = this.pending.slice(heldPrefixIndex);
        }
        break;
      }

      visibleText += this.pending.slice(0, marker.index);
      this.pending = this.pending.slice(marker.index);

      const wrapper = /^<function_calls\b[^>]*>/i.exec(this.pending);
      if (wrapper) {
        const wrapperEnd = /<\/function_calls\s*>/i.exec(
          this.pending.slice(wrapper[0].length),
        );
        if (!wrapperEnd) {
          if (final) {
            visibleText += this.pending;
            this.pending = "";
          }
          break;
        }
        const rawWrapper = this.pending.slice(
          0,
          wrapper[0].length + wrapperEnd.index + wrapperEnd[0].length,
        );
        const wrappedBody = this.pending.slice(
          wrapper[0].length,
          wrapper[0].length + wrapperEnd.index,
        );
        const parsedWrapper = this.parseWrappedCalls(wrappedBody);
        if (parsedWrapper) toolCalls.push(...parsedWrapper);
        else visibleText += rawWrapper;
        this.pending = this.pending.slice(rawWrapper.length);
        continue;
      }
      const closingWrapper = /^<\/function_calls\b[^>]*>/i.exec(this.pending);
      if (closingWrapper) {
        visibleText += closingWrapper[0];
        this.pending = this.pending.slice(closingWrapper[0].length);
        continue;
      }

      const openingEnd = this.pending.indexOf(">");
      if (openingEnd < 0) {
        if (final) {
          visibleText += this.pending;
          this.pending = "";
        }
        break;
      }
      const closingMatch = /<\/invoke\s*>/i.exec(
        this.pending.slice(openingEnd + 1),
      );
      if (!closingMatch) {
        if (final) {
          visibleText += this.pending;
          this.pending = "";
        }
        break;
      }

      const closingStart = openingEnd + 1 + closingMatch.index;
      const rawBlock = this.pending.slice(
        0,
        closingStart + closingMatch[0].length,
      );
      const opening = this.pending.slice(0, openingEnd + 1);
      const body = this.pending.slice(openingEnd + 1, closingStart);
      const parsedCall = this.parseCall(opening, body);
      if (parsedCall) toolCalls.push(parsedCall);
      else visibleText += rawBlock;
      this.pending = this.pending.slice(rawBlock.length);
    }

    return { visibleText, toolCalls };
  }

  private parseCall(opening: string, body: string): TextToolCall | null {
    const invokeMatch = /^<invoke\b([^>]*)>$/i.exec(opening);
    const taggedMatch = /^<([A-Za-z0-9_.:-]+)>$/.exec(opening);
    const rawName = invokeMatch
      ? readXmlAttribute(invokeMatch[1], "name")
      : taggedMatch?.[1];
    if (!rawName) return null;
    const name = resolveTextToolName(rawName, this.availableToolNames);
    if (!name) return null;

    const input: Record<string, unknown> = {};
    const parameterPattern =
      /<parameter\s+name\s*=\s*(["'])(.*?)\1\s*>([\s\S]*?)<\/parameter\s*>/gi;
    let unmatchedBody = "";
    let offset = 0;
    for (const match of body.matchAll(parameterPattern)) {
      unmatchedBody += body.slice(offset, match.index);
      input[decodeXmlText(match[2])] = parseTextToolParameter(
        decodeXmlText(match[3]),
      );
      offset = (match.index ?? 0) + match[0].length;
    }
    unmatchedBody += body.slice(offset);
    if (unmatchedBody.trim()) return null;
    return { name, input };
  }

  private parseWrappedCalls(body: string): TextToolCall[] | null {
    const calls: TextToolCall[] = [];
    const invokePattern = /<invoke\b[^>]*>[\s\S]*?<\/invoke\s*>/gi;
    let unmatchedBody = "";
    let offset = 0;
    for (const match of body.matchAll(invokePattern)) {
      unmatchedBody += body.slice(offset, match.index);
      const openingEnd = match[0].indexOf(">");
      const closingStart = match[0].search(/<\/invoke\s*>/i);
      const parsedCall = this.parseCall(
        match[0].slice(0, openingEnd + 1),
        match[0].slice(openingEnd + 1, closingStart),
      );
      if (!parsedCall) return null;
      calls.push(parsedCall);
      offset = (match.index ?? 0) + match[0].length;
    }
    unmatchedBody += body.slice(offset);
    return calls.length > 0 && !unmatchedBody.trim() ? calls : null;
  }
}

function getTextToolParser(
  parsers: Map<number, TextToolCallParser>,
  choiceIndex: number,
  availableToolNames: ReadonlySet<string>,
): TextToolCallParser {
  const existing = parsers.get(choiceIndex);
  if (existing) return existing;
  const created = new TextToolCallParser(availableToolNames);
  parsers.set(choiceIndex, created);
  return created;
}

function getHeldTextToolPrefixIndex(text: string): number {
  const lastOpening = text.lastIndexOf("<");
  if (lastOpening < 0) return -1;
  const suffix = text.slice(lastOpening).toLowerCase();
  return TEXT_TOOL_MARKER_PREFIXES.some((prefix) => prefix.startsWith(suffix))
    ? lastOpening
    : -1;
}

function readXmlAttribute(
  attributes: string,
  name: string,
): string | undefined {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, "i");
  const match = pattern.exec(attributes);
  return match ? decodeXmlText(match[2]) : undefined;
}

function resolveTextToolName(
  rawName: string,
  availableToolNames: ReadonlySet<string>,
): string | undefined {
  const aliases = [
    rawName,
    rawName.startsWith("mcp__") ? rawName.slice("mcp__".length) : undefined,
    /^mcp__[^_]+__(.+)$/.exec(rawName)?.[1],
    rawName.includes(".") ? rawName.split(".").at(-1) : undefined,
  ];
  return aliases.find(
    (alias): alias is string =>
      alias !== undefined && availableToolNames.has(alias),
  );
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_match, code: string) =>
      String.fromCodePoint(Number(code)),
    )
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    )
    .replace(/&amp;/gi, "&");
}

function parseTextToolParameter(value: string): unknown {
  const trimmed = value.trim();
  if (/^(?:true|false|null|-?\d+(?:\.\d+)?|[[{])/i.test(trimmed)) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // Ordinary string values may begin with punctuation that resembles JSON.
    }
  }
  return value;
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
