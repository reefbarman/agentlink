import type {
  CoreHostedToolDefinition,
  CoreJsonValue,
} from "../../../webAccess.js";
import type {
  CoreModelContentBlock,
  CoreModelMessage,
  CoreModelToolDefinition,
} from "../../../modelRuntime.js";

export type AnthropicJsonObject = { [key: string]: CoreJsonValue };

export interface AnthropicTranslatedMessage {
  role: "user" | "assistant";
  content: string | AnthropicJsonObject[];
}

export interface AnthropicMessageTranslationResult {
  messages: AnthropicTranslatedMessage[];
  strippedThinking: boolean;
  strippedThinkingFromToolUse: boolean;
}

export function translateAnthropicMessages(
  messages: readonly CoreModelMessage[],
  options: { cacheBreakpoints?: boolean } = {},
): AnthropicMessageTranslationResult {
  const translated: AnthropicTranslatedMessage[] = [];
  let strippedThinking = false;
  let strippedThinkingFromToolUse = false;

  for (const message of messages) {
    const replayContent = getAnthropicReplayContent(message);
    if (replayContent) {
      translated.push({ role: message.role, content: replayContent });
      continue;
    }
    if (typeof message.content === "string") {
      translated.push({ role: message.role, content: message.content });
      continue;
    }

    const hadThinking = message.content.some(
      (block) => block.type === "thinking",
    );
    const hasToolUse = message.content.some(
      (block) => block.type === "tool_use",
    );
    const content = message.content
      .map(toAnthropicContentBlock)
      .filter((block): block is AnthropicJsonObject => block !== null);
    if (hadThinking) {
      strippedThinking = true;
      strippedThinkingFromToolUse ||=
        message.role === "assistant" && hasToolUse;
    }
    if (content.length > 0) {
      translated.push({ role: message.role, content });
    }
  }

  const merged = mergeConsecutiveAnthropicUserMessages(translated);
  return {
    messages:
      options.cacheBreakpoints === false
        ? merged
        : addAnthropicMessageCacheBreakpoints(merged),
    strippedThinking,
    strippedThinkingFromToolUse,
  };
}

export function translateAnthropicTools(
  tools: readonly CoreModelToolDefinition[] = [],
  hostedTools: readonly CoreHostedToolDefinition[] = [],
): AnthropicJsonObject[] | undefined {
  const translated = [
    ...tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.input_schema as AnthropicJsonObject,
    })),
    ...hostedTools.map(translateAnthropicHostedTool),
  ];
  if (translated.length === 0) return undefined;
  return translated.map((tool, index) =>
    index === translated.length - 1
      ? { ...tool, cache_control: { type: "ephemeral" } }
      : tool,
  );
}

export function translateAnthropicHostedTool(
  tool: CoreHostedToolDefinition,
): AnthropicJsonObject {
  if (tool.type === "web_search") {
    return {
      type: "web_search_20250305",
      name: "web_search",
      ...(tool.allowedDomains?.length
        ? { allowed_domains: tool.allowedDomains }
        : {}),
      ...(tool.blockedDomains?.length
        ? { blocked_domains: tool.blockedDomains }
        : {}),
      ...(tool.maxUses !== undefined ? { max_uses: tool.maxUses } : {}),
    };
  }
  return {
    type: "web_fetch_20250910",
    name: "web_fetch",
    ...(tool.allowedDomains?.length
      ? { allowed_domains: tool.allowedDomains }
      : {}),
    ...(tool.blockedDomains?.length
      ? { blocked_domains: tool.blockedDomains }
      : {}),
    ...(tool.maxUses !== undefined ? { max_uses: tool.maxUses } : {}),
    ...(tool.maxContentTokens !== undefined
      ? { max_content_tokens: tool.maxContentTokens }
      : {}),
    citations: { enabled: tool.citationsEnabled },
  };
}

function getAnthropicReplayContent(
  message: CoreModelMessage,
): AnthropicJsonObject[] | undefined {
  const replay = message.providerReplay;
  if (
    message.role !== "assistant" ||
    !replay ||
    replay.providerId !== "anthropic" ||
    replay.codecVersion !== 1 ||
    replay.degraded ||
    !isJsonObject(replay.payload) ||
    !Array.isArray(replay.payload.content) ||
    !replay.payload.content.every(isJsonObject) ||
    !replay.payload.content.some(isAnthropicServerReplayBlock)
  ) {
    return undefined;
  }
  return replay.payload.content;
}

function toAnthropicContentBlock(
  block: CoreModelContentBlock,
): AnthropicJsonObject | null {
  switch (block.type) {
    case "thinking":
    case "web_activity":
      return null;
    case "text":
      return {
        type: "text",
        text: block.text,
        ...(block.cache_control ? { cache_control: block.cache_control } : {}),
      };
    case "tool_use":
      return {
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: block.input as AnthropicJsonObject,
      };
    case "tool_result":
      return {
        type: "tool_result",
        tool_use_id: block.tool_use_id,
        content:
          typeof block.content === "string"
            ? block.content
            : block.content
                .map(toAnthropicContentBlock)
                .filter((item): item is AnthropicJsonObject => item !== null),
        ...(block.is_error !== undefined ? { is_error: block.is_error } : {}),
      };
    case "image":
    case "document":
      return block as unknown as AnthropicJsonObject;
  }
}

function mergeConsecutiveAnthropicUserMessages(
  messages: readonly AnthropicTranslatedMessage[],
): AnthropicTranslatedMessage[] {
  const result: AnthropicTranslatedMessage[] = [];
  for (const message of messages) {
    const last = result[result.length - 1];
    if (last?.role === "user" && message.role === "user") {
      last.content = [
        ...toAnthropicBlocks(last.content),
        ...toAnthropicBlocks(message.content),
      ];
    } else {
      result.push({ role: message.role, content: message.content });
    }
  }
  return result;
}

function addAnthropicMessageCacheBreakpoints(
  messages: readonly AnthropicTranslatedMessage[],
): AnthropicTranslatedMessage[] {
  const userIndices: number[] = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user") {
      userIndices.push(index);
      if (userIndices.length === 2) break;
    }
  }
  if (userIndices.length === 0) return [...messages];

  return messages.map((message, index) => {
    if (!userIndices.includes(index)) return message;
    const blocks = toAnthropicBlocks(message.content);
    if (blocks.length === 0) return message;
    return {
      role: message.role,
      content: [
        ...blocks
          .slice(0, -1)
          .map(({ cache_control: _cacheControl, ...block }) => block),
        {
          ...blocks[blocks.length - 1],
          cache_control: { type: "ephemeral" },
        },
      ],
    };
  });
}

function toAnthropicBlocks(
  content: AnthropicTranslatedMessage["content"],
): AnthropicJsonObject[] {
  return typeof content === "string"
    ? [{ type: "text", text: content }]
    : content;
}

function isAnthropicServerReplayBlock(value: AnthropicJsonObject): boolean {
  return (
    value.type === "server_tool_use" ||
    value.type === "web_search_tool_result" ||
    value.type === "web_fetch_tool_result"
  );
}

function isJsonObject(value: unknown): value is AnthropicJsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
