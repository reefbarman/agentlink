import type {
  CoreModelContentBlock,
  CoreModelMessage,
  CoreModelToolDefinition,
} from "../../../modelRuntime.js";
import type {
  OpenAiCompatibleChatRequest,
  OpenAiCompatibleProfileKind,
  OpenAiCompatibleReasoningEffortMode,
  OpenAiCompatibleRuntimeModel,
  OpenAiCompatibleWireContentPart,
  OpenAiCompatibleWireMessage,
  OpenAiCompatibleWireTool,
} from "./types.js";

import type { CoreJsonValue } from "../../../webAccess.js";
import type { CoreReasoningEffort } from "../../../modelCatalog.js";

export class OpenAiCompatibleCapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenAiCompatibleCapabilityError";
  }
}

export function buildOpenAiCompatibleChatRequest(args: {
  providerId: string;
  profile: OpenAiCompatibleProfileKind;
  reasoningEffortMode: OpenAiCompatibleReasoningEffortMode;
  model: OpenAiCompatibleRuntimeModel;
  systemPrompt: string;
  messages: readonly CoreModelMessage[];
  maxTokens: number;
  reasoningEffort?: CoreReasoningEffort;
  tools?: readonly CoreModelToolDefinition[];
  temperature?: number;
}): OpenAiCompatibleChatRequest {
  const tools = args.model.capabilities.supportsToolUse
    ? translateOpenAiCompatibleTools(args.tools)
    : undefined;
  return {
    model: args.model.model,
    messages: [
      { role: "system", content: args.systemPrompt },
      ...translateOpenAiCompatibleMessages({
        providerId: args.providerId,
        messages: args.messages,
        supportsImages: args.model.capabilities.supportsImages,
      }),
    ],
    max_tokens: args.maxTokens,
    stream: true,
    ...(tools ? { tools, tool_choice: "auto" } : {}),
    ...reasoningEffortRequest(
      args.reasoningEffortMode,
      args.reasoningEffort,
      args.model.capabilities.supportsThinking,
    ),
    ...(args.profile === "openrouter" && tools
      ? { parallel_tool_calls: true }
      : {}),
    ...(args.temperature !== undefined
      ? { temperature: args.temperature }
      : {}),
  };
}

function reasoningEffortRequest(
  mode: OpenAiCompatibleReasoningEffortMode,
  effort: CoreReasoningEffort | undefined,
  supportsThinking: boolean,
): Pick<
  OpenAiCompatibleChatRequest,
  "reasoning_effort" | "reasoning" | "output_config"
> {
  if (!effort || effort === "none" || !supportsThinking || mode === "none") {
    return {};
  }
  if (mode === "reasoning_effort") return { reasoning_effort: effort };
  if (mode === "reasoning.effort") return { reasoning: { effort } };
  return { output_config: { effort } };
}

export function translateOpenAiCompatibleMessages(args: {
  providerId: string;
  messages: readonly CoreModelMessage[];
  supportsImages: boolean;
}): OpenAiCompatibleWireMessage[] {
  const result: OpenAiCompatibleWireMessage[] = [];
  for (const message of args.messages) {
    const replay = readOpenAiCompatibleReplay(message, args.providerId);
    if (message.role === "assistant") {
      result.push(translateAssistantMessage(message, replay));
      continue;
    }
    translateUserMessage(message, args.supportsImages, result);
  }
  return result;
}

export function translateOpenAiCompatibleTools(
  tools: readonly CoreModelToolDefinition[] = [],
): OpenAiCompatibleWireTool[] | undefined {
  if (tools.length === 0) return undefined;
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  }));
}

function translateAssistantMessage(
  message: CoreModelMessage,
  replay: OpenAiCompatibleAssistantReplay | undefined,
): OpenAiCompatibleWireMessage {
  const blocks = toBlocks(message.content);
  const text = blocks
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  const thinking = blocks
    .filter((block) => block.type === "thinking")
    .map((block) => block.thinking)
    .join("");
  const toolCalls = blocks
    .filter((block) => block.type === "tool_use")
    .map((block) => ({
      id: block.id,
      type: "function" as const,
      function: { name: block.name, arguments: JSON.stringify(block.input) },
    }));
  return {
    role: "assistant",
    content: text || null,
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    ...(replay?.reasoning !== undefined
      ? { reasoning: replay.reasoning }
      : replay?.reasoning_content !== undefined
        ? { reasoning_content: replay.reasoning_content }
        : thinking
          ? { reasoning_content: thinking }
          : {}),
    ...(replay?.reasoning_details !== undefined
      ? { reasoning_details: replay.reasoning_details }
      : {}),
  };
}

function translateUserMessage(
  message: CoreModelMessage,
  supportsImages: boolean,
  result: OpenAiCompatibleWireMessage[],
): void {
  if (typeof message.content === "string") {
    result.push({ role: "user", content: message.content });
    return;
  }

  let userParts: OpenAiCompatibleWireContentPart[] = [];
  const flushUserParts = () => {
    if (userParts.length === 0) return;
    result.push({
      role: "user",
      content:
        userParts.length === 1 && userParts[0].type === "text"
          ? userParts[0].text
          : userParts,
    });
    userParts = [];
  };

  for (const block of message.content) {
    if (block.type === "tool_result") {
      flushUserParts();
      result.push({
        role: "tool",
        tool_call_id: block.tool_use_id,
        content: flattenToolResult(block.content),
      });
    } else if (block.type === "text") {
      userParts.push({ type: "text", text: block.text });
    } else if (block.type === "image") {
      if (!supportsImages) {
        throw new OpenAiCompatibleCapabilityError(
          "The selected OpenAI-compatible model does not support image input",
        );
      }
      userParts.push({
        type: "image_url",
        image_url: {
          url: `data:${block.source.media_type};base64,${block.source.data}`,
        },
      });
    } else if (block.type === "document") {
      throw new OpenAiCompatibleCapabilityError(
        "OpenAI-compatible Chat Completions does not support document input",
      );
    }
  }
  flushUserParts();
}

function flattenToolResult(content: string | CoreModelContentBlock[]): string {
  if (typeof content === "string") return content;
  return content
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "image") return "[Image omitted from tool result]";
      if (block.type === "document")
        return "[Document omitted from tool result]";
      if (block.type === "thinking") return block.thinking;
      if (block.type === "tool_use")
        return `[Nested tool call ${block.name} omitted]`;
      if (block.type === "tool_result") return flattenToolResult(block.content);
      return "[Provider activity omitted from tool result]";
    })
    .join("\n");
}

interface OpenAiCompatibleAssistantReplay {
  reasoning?: string;
  reasoning_content?: string;
  reasoning_details?: CoreJsonValue;
}

function readOpenAiCompatibleReplay(
  message: CoreModelMessage,
  providerId: string,
): OpenAiCompatibleAssistantReplay | undefined {
  const replay = message.providerReplay;
  if (
    message.role !== "assistant" ||
    !replay ||
    replay.providerId !== providerId ||
    replay.codecVersion !== 1 ||
    replay.degraded ||
    !isRecord(replay.payload)
  ) {
    return undefined;
  }
  const payload = replay.payload;
  const matchedChoice = Array.isArray(payload.choices)
    ? payload.choices.find((value) => isRecord(value) && value.index === 0)
    : payload;
  const choice = isRecord(matchedChoice) ? matchedChoice : payload;
  return {
    ...(typeof choice.reasoning === "string"
      ? { reasoning: choice.reasoning }
      : {}),
    ...(typeof choice.reasoning_content === "string"
      ? { reasoning_content: choice.reasoning_content }
      : {}),
    ...(isCoreJsonValue(choice.reasoning_details)
      ? { reasoning_details: choice.reasoning_details }
      : {}),
  };
}

function toBlocks(
  content: CoreModelMessage["content"],
): CoreModelContentBlock[] {
  return typeof content === "string"
    ? [{ type: "text", text: content }]
    : content;
}

function isCoreJsonValue(value: unknown): value is CoreJsonValue {
  if (value === null) return true;
  if (["string", "number", "boolean"].includes(typeof value)) return true;
  if (Array.isArray(value)) return value.every(isCoreJsonValue);
  return isRecord(value) && Object.values(value).every(isCoreJsonValue);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
