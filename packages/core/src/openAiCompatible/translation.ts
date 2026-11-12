import type {
  CoreModelContentBlock,
  CoreModelMessage,
  CoreModelOutputFormat,
  CoreModelToolDefinition,
} from "../modelRuntime.js";
import type {
  OpenAiCompatibleChatRequest,
  OpenAiCompatibleProfileKind,
  OpenAiCompatibleReasoningEffortMode,
  OpenAiCompatibleRuntimeModel,
  OpenAiCompatibleWireContentPart,
  OpenAiCompatibleWireMessage,
  OpenAiCompatibleWireTool,
} from "./types.js";

import type { CoreJsonValue } from "@agentlink/protocol/provider-replay";
import type { CoreReasoningEffort } from "@agentlink/protocol/model-catalog";
import { registerOpenAiCompatibleInlineMedia } from "./requestBody.js";

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
  outputFormat?: CoreModelOutputFormat;
  store?: boolean;
  supportsStoreFalse?: boolean;
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
        supportsDocuments: args.model.capabilities.supportsDocuments === true,
      }),
    ],
    max_tokens: args.maxTokens,
    stream: true,
    ...(args.store === false && args.supportsStoreFalse
      ? { store: false }
      : {}),
    ...(args.outputFormat
      ? {
          response_format: {
            type: "json_schema",
            json_schema: {
              name: args.outputFormat.name,
              schema: args.outputFormat.schema,
              ...(args.outputFormat.strict !== undefined
                ? { strict: args.outputFormat.strict }
                : {}),
            },
          },
        }
      : {}),
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
  if (!effort || effort === "none") return {};
  // Provider adapters historically accept a generic host preference even when
  // this specific model cannot reason. The session engine validates that case;
  // direct provider callers retain the compatibility behavior of omitting it.
  if (!supportsThinking) return {};
  if (mode === "none") {
    throw new OpenAiCompatibleCapabilityError(
      "The OpenAI-compatible connection must configure reasoningEffortMode before using reasoning effort",
    );
  }
  if (mode === "reasoning_effort") return { reasoning_effort: effort };
  if (mode === "reasoning.effort") return { reasoning: { effort } };
  return { output_config: { effort } };
}

export function translateOpenAiCompatibleMessages(args: {
  providerId: string;
  messages: readonly CoreModelMessage[];
  supportsImages: boolean;
  /** PDF documents are sent as `file` parts; otherwise replaced by a note. */
  supportsDocuments?: boolean;
}): OpenAiCompatibleWireMessage[] {
  const support: MediaSupport = {
    images: args.supportsImages,
    documents: args.supportsDocuments === true,
  };
  const result: OpenAiCompatibleWireMessage[] = [];
  for (const message of args.messages) {
    const replay = readOpenAiCompatibleReplay(message, args.providerId);
    if (message.role === "assistant") {
      result.push(translateAssistantMessage(message, replay));
      continue;
    }
    translateUserMessage(message, support, result);
  }
  return result;
}

interface MediaSupport {
  images: boolean;
  documents: boolean;
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
  support: MediaSupport,
  result: OpenAiCompatibleWireMessage[],
): void {
  if (typeof message.content === "string") {
    result.push({ role: "user", content: message.content });
    return;
  }

  let userParts: OpenAiCompatibleWireContentPart[] = [];
  // Chat Completions only accepts text in `tool` messages, and every tool
  // message must directly follow the assistant tool call. Tool-result images
  // and PDFs are therefore deferred into the user message that follows the
  // tool group.
  let pendingToolMedia: OpenAiCompatibleWireContentPart[] = [];
  const movePendingToolMedia = () => {
    userParts.push(...pendingToolMedia);
    pendingToolMedia = [];
  };
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
      const media = collectToolResultMedia(block.content, support);
      result.push({
        role: "tool",
        tool_call_id: block.tool_use_id,
        content: flattenToolResult(block.content, support),
      });
      if (media.length > 0) {
        pendingToolMedia.push(
          {
            type: "text",
            text: `Media output of tool call ${block.tool_use_id}:`,
          },
          ...media,
        );
      }
      continue;
    }
    movePendingToolMedia();
    if (block.type === "text") {
      userParts.push({ type: "text", text: block.text });
    } else if (block.type === "image") {
      if (!support.images) {
        throw new OpenAiCompatibleCapabilityError(
          "The selected OpenAI-compatible model does not support image input",
        );
      }
      userParts.push(toImagePart(block));
    } else if (block.type === "document") {
      userParts.push(toDocumentPart(block, support.documents));
    }
  }
  movePendingToolMedia();
  flushUserParts();
}

type CoreModelImageBlock = Extract<CoreModelContentBlock, { type: "image" }>;
type CoreModelDocumentBlock = Extract<
  CoreModelContentBlock,
  { type: "document" }
>;

/**
 * Text-based documents are inlined as text for every model; only PDFs need
 * the `file` part, and only when the model is configured to accept it.
 * Unsupported PDFs become a note so one attachment cannot fail every later
 * request in the conversation.
 */
function toDocumentPart(
  document: CoreModelDocumentBlock,
  supportsDocuments: boolean,
): OpenAiCompatibleWireContentPart {
  if (document.source.media_type !== "application/pdf") {
    return { type: "text", text: inlineTextDocument(document) };
  }
  if (supportsDocuments) return toFilePart(document);
  return { type: "text", text: unsupportedPdfNote(document) };
}

function toFilePart(
  document: CoreModelDocumentBlock,
): OpenAiCompatibleWireContentPart {
  const filename = document.title ?? "document.pdf";
  const file = {
    filename,
    file_data: `data:${document.source.media_type};base64,${document.source.data}`,
  };
  registerOpenAiCompatibleInlineMedia(file, {
    leadingFields: { filename },
    dataUrlField: "file_data",
    mediaType: document.source.media_type,
    data: document.source.data,
  });
  return { type: "file", file };
}

function inlineTextDocument(document: CoreModelDocumentBlock): string {
  const title = document.title ?? "untitled";
  const text = decodeBase64Utf8(document.source.data);
  if (text === undefined) {
    return `[Document "${title}" omitted: its contents could not be decoded as text]`;
  }
  return `[Document: ${title}]\n${text}`;
}

function unsupportedPdfNote(document: CoreModelDocumentBlock): string {
  const title = document.title ?? "untitled";
  return `[PDF document "${title}" omitted: the selected model does not accept PDF input through this OpenAI-compatible connection]`;
}

function decodeBase64Utf8(data: string): string | undefined {
  try {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) {
      bytes[index] = binary.charCodeAt(index);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function toImagePart(
  image: CoreModelImageBlock,
): OpenAiCompatibleWireContentPart {
  const imageUrl = {
    url: `data:${image.source.media_type};base64,${image.source.data}`,
  };
  registerOpenAiCompatibleInlineMedia(imageUrl, {
    dataUrlField: "url",
    mediaType: image.source.media_type,
    data: image.source.data,
  });
  return { type: "image_url", image_url: imageUrl };
}

function collectToolResultMedia(
  content: string | CoreModelContentBlock[],
  support: MediaSupport,
): OpenAiCompatibleWireContentPart[] {
  if (typeof content === "string") return [];
  return content.flatMap((block) => {
    if (block.type === "image" && support.images) return [toImagePart(block)];
    if (
      block.type === "document" &&
      block.source.media_type === "application/pdf" &&
      support.documents
    ) {
      return [toFilePart(block)];
    }
    if (block.type === "tool_result")
      return collectToolResultMedia(block.content, support);
    return [];
  });
}

function flattenToolResult(
  content: string | CoreModelContentBlock[],
  support: MediaSupport,
): string {
  if (typeof content === "string") return content;
  return content
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "image")
        return support.images
          ? "[Image attached in the following user message]"
          : "[Image omitted from tool result]";
      if (block.type === "document") {
        if (block.source.media_type !== "application/pdf")
          return inlineTextDocument(block);
        return support.documents
          ? "[Document attached in the following user message]"
          : unsupportedPdfNote(block);
      }
      if (block.type === "thinking") return block.thinking;
      if (block.type === "tool_use")
        return `[Nested tool call ${block.name} omitted]`;
      if (block.type === "tool_result")
        return flattenToolResult(block.content, support);
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
