import type {
  CoreModelContentBlock,
  CoreModelMessage,
  CoreModelStopReason,
  CoreModelStreamEvent,
  CoreModelThinkingBlock,
} from "../../../modelRuntime.js";
import {
  CORE_WEB_ACCESS_DEFAULT_MAX_REPLAY_BYTES_PER_TURN,
  createCoreProviderReplayEnvelope,
  type CoreJsonValue,
  type CoreWebActivity,
  type CoreWebCitation,
} from "../../../webAccess.js";
import type { AnthropicJsonObject } from "./translation.js";

export interface AnthropicStreamParserState {
  outputStarted: boolean;
}

export interface AnthropicStreamParserOptions {
  createThinkingId?: () => string;
  maxReplayBytes?: number;
}

type BlockBuffer = {
  type: string;
  id?: string;
  name?: string;
  text: string;
  signature?: string;
  thinkingId?: string;
  thinkingStarted?: boolean;
  citations: CoreWebCitation[];
};

export async function* parseAnthropicStreamEvents(
  events: AsyncIterable<Record<string, unknown>>,
  state?: AnthropicStreamParserState,
  options: AnthropicStreamParserOptions = {},
): AsyncGenerator<CoreModelStreamEvent> {
  const createThinkingId = options.createThinkingId ?? defaultThinkingId;
  const maxReplayBytes =
    options.maxReplayBytes ?? CORE_WEB_ACCESS_DEFAULT_MAX_REPLAY_BYTES_PER_TURN;
  const exactBlocks = new Map<number, AnthropicJsonObject>();
  const publicBlocks = new Map<number, CoreModelContentBlock>();
  const buffers = new Map<number, BlockBuffer>();
  const serverToolIndices = new Map<string, number>();
  const activities = new Map<string, CoreWebActivity>();
  const fetchedDocuments: Array<{ url: string; title?: string }> = [];

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let providerResponseId: string | undefined;
  let stopReason: CoreModelStopReason = "end_turn";
  let webSearchRequests = 0;
  let webFetchRequests = 0;

  for await (const event of events) {
    const eventType = event.type;
    if (eventType === "message_start") {
      const message = isRecord(event.message) ? event.message : undefined;
      const usage =
        message && isRecord(message.usage) ? message.usage : undefined;
      providerResponseId =
        typeof message?.id === "string" ? message.id : providerResponseId;
      if (usage) {
        inputTokens = numberOrZero(usage.input_tokens);
        outputTokens = numberOrZero(usage.output_tokens);
        cacheReadTokens = numberOrZero(usage.cache_read_input_tokens);
        cacheCreationTokens = numberOrZero(usage.cache_creation_input_tokens);
        ({ webSearchRequests, webFetchRequests } = readServerToolUsage(
          usage,
          webSearchRequests,
          webFetchRequests,
        ));
      }
      continue;
    }

    if (eventType === "content_block_start") {
      const index = event.index;
      const block = event.content_block;
      if (typeof index !== "number" || !isRecord(block)) continue;
      exactBlocks.set(index, block as AnthropicJsonObject);
      const type = typeof block.type === "string" ? block.type : "";
      const buffer: BlockBuffer = { type, text: "", citations: [] };

      if (type === "thinking") {
        buffer.thinkingId = createThinkingId();
        buffer.signature =
          typeof block.signature === "string" ? block.signature : "";
      } else if (type === "text") {
        buffer.text = typeof block.text === "string" ? block.text : "";
        buffer.citations = readCoreCitations(block.citations, fetchedDocuments);
      } else if (type === "tool_use" || type === "server_tool_use") {
        buffer.id = typeof block.id === "string" ? block.id : undefined;
        buffer.name = typeof block.name === "string" ? block.name : undefined;
        if (type === "tool_use" && buffer.id && buffer.name) {
          markOutputStarted(state);
          yield {
            type: "tool_start",
            toolCallId: buffer.id,
            toolName: buffer.name,
          };
        } else if (
          type === "server_tool_use" &&
          buffer.id &&
          (buffer.name === "web_search" || buffer.name === "web_fetch")
        ) {
          markOutputStarted(state);
          serverToolIndices.set(buffer.id, index);
          const activity = toStartedActivity(
            buffer.id,
            buffer.name,
            block.input,
          );
          activities.set(buffer.id, activity);
          publicBlocks.set(index, { type: "web_activity", activity });
          yield { type: "web_activity", activity };
        }
      } else if (
        type === "web_search_tool_result" ||
        type === "web_fetch_tool_result"
      ) {
        markOutputStarted(state);
        const completed = toCompletedActivity(block);
        if (completed) {
          const previous = activities.get(completed.id);
          const activity: CoreWebActivity = {
            ...completed,
            ...(previous?.query && !completed.query
              ? { query: previous.query }
              : {}),
            ...(previous?.url && !completed.url ? { url: previous.url } : {}),
          };
          activities.set(activity.id, activity);
          const serverIndex = serverToolIndices.get(activity.id) ?? index;
          publicBlocks.set(serverIndex, { type: "web_activity", activity });
          if (activity.kind === "fetch" && activity.url) {
            fetchedDocuments.push({
              url: activity.url,
              ...(activity.citations?.[0]?.title
                ? { title: activity.citations[0].title }
                : {}),
            });
          }
          yield { type: "web_activity", activity };
        }
      }
      buffers.set(index, buffer);
      continue;
    }

    if (eventType === "content_block_delta") {
      const index = event.index;
      const delta = event.delta;
      if (typeof index !== "number" || !isRecord(delta)) continue;
      const buffer = buffers.get(index);
      if (!buffer) continue;

      if (delta.type === "thinking_delta" && buffer.type === "thinking") {
        const text = typeof delta.thinking === "string" ? delta.thinking : "";
        if (!text) continue;
        buffer.text += text;
        if (!buffer.thinkingStarted) {
          buffer.thinkingStarted = true;
          markOutputStarted(state);
          yield {
            type: "thinking_start",
            thinkingId: buffer.thinkingId!,
          };
        }
        yield {
          type: "thinking_delta",
          thinkingId: buffer.thinkingId!,
          text,
        };
      } else if (
        delta.type === "signature_delta" &&
        buffer.type === "thinking"
      ) {
        buffer.signature =
          (buffer.signature ?? "") +
          (typeof delta.signature === "string" ? delta.signature : "");
      } else if (delta.type === "text_delta" && buffer.type === "text") {
        const text = typeof delta.text === "string" ? delta.text : "";
        if (!text) continue;
        buffer.text += text;
        markOutputStarted(state);
        yield { type: "text_delta", text };
      } else if (
        delta.type === "citations_delta" &&
        buffer.type === "text" &&
        isRecord(delta.citation)
      ) {
        const exact = exactBlocks.get(index);
        if (exact) {
          const exactCitations = Array.isArray(exact.citations)
            ? exact.citations
            : [];
          exactBlocks.set(index, {
            ...exact,
            citations: [
              ...exactCitations,
              delta.citation as AnthropicJsonObject,
            ],
          });
        }
        const citation = toCoreCitation(delta.citation, fetchedDocuments);
        if (citation) addUniqueCitation(buffer.citations, citation);
      } else if (
        delta.type === "input_json_delta" &&
        (buffer.type === "tool_use" || buffer.type === "server_tool_use")
      ) {
        const partialJson =
          typeof delta.partial_json === "string" ? delta.partial_json : "";
        if (!partialJson) continue;
        buffer.text += partialJson;
        if (buffer.type === "tool_use" && buffer.id) {
          yield {
            type: "tool_input_delta",
            toolCallId: buffer.id,
            partialJson,
          };
        }
      }
      continue;
    }

    if (eventType === "content_block_stop") {
      const index = event.index;
      if (typeof index !== "number") continue;
      const buffer = buffers.get(index);
      if (!buffer) continue;
      const exact = exactBlocks.get(index);

      if (buffer.type === "thinking") {
        if (buffer.thinkingStarted) {
          yield { type: "thinking_end", thinkingId: buffer.thinkingId! };
        }
        if (buffer.text.trim()) {
          publicBlocks.set(index, {
            type: "thinking",
            thinking: buffer.text,
            signature: buffer.signature ?? "",
          } satisfies CoreModelThinkingBlock);
        }
        if (exact) {
          exactBlocks.set(index, {
            ...exact,
            thinking: buffer.text,
            signature: buffer.signature ?? "",
          });
        }
      } else if (buffer.type === "text") {
        publicBlocks.set(index, {
          type: "text",
          text: buffer.text,
          ...(buffer.citations.length > 0
            ? { citations: buffer.citations }
            : {}),
        });
        if (exact) exactBlocks.set(index, { ...exact, text: buffer.text });
      } else if (
        buffer.type === "tool_use" ||
        buffer.type === "server_tool_use"
      ) {
        const input = parseInputJson(buffer.text, exact?.input);
        if (exact) exactBlocks.set(index, { ...exact, input });
        if (buffer.type === "tool_use" && buffer.id && buffer.name) {
          publicBlocks.set(index, {
            type: "tool_use",
            id: buffer.id,
            name: buffer.name,
            input,
          });
          yield {
            type: "tool_done",
            toolCallId: buffer.id,
            toolName: buffer.name,
            input,
          };
        } else if (buffer.id && buffer.name) {
          // Anthropic streams hosted-tool input after block start. Re-emit the same
          // activity ID at block stop so consumers can upsert the parsed query/URL
          // without delaying the initial liveness event.
          const activity = toStartedActivity(buffer.id, buffer.name, input);
          activities.set(buffer.id, activity);
          publicBlocks.set(index, { type: "web_activity", activity });
          yield { type: "web_activity", activity };
        }
      }
      buffers.delete(index);
      continue;
    }

    if (eventType === "message_delta") {
      const usage = isRecord(event.usage) ? event.usage : undefined;
      if (usage) {
        outputTokens = numberOrZero(usage.output_tokens);
        ({ webSearchRequests, webFetchRequests } = readServerToolUsage(
          usage,
          webSearchRequests,
          webFetchRequests,
        ));
      }
      const delta = isRecord(event.delta) ? event.delta : undefined;
      stopReason = normalizeStopReason(delta?.stop_reason);
    }
  }

  const exactContent = [...exactBlocks.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, block]) => block);
  const blocks = [...publicBlocks.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, block]) => block);
  const requiresExactReplay = exactContent.some(isAnthropicServerReplayBlock);
  const replay = requiresExactReplay
    ? createCoreProviderReplayEnvelope({
        providerId: "anthropic",
        codecVersion: 1,
        payload: { content: exactContent as CoreJsonValue[] },
        maxBytes: maxReplayBytes,
      })
    : undefined;
  const assistantMessage: CoreModelMessage = {
    role: "assistant",
    content: blocks,
    ...(replay ? { providerReplay: replay } : {}),
  };
  const serverToolUsage =
    webSearchRequests || webFetchRequests
      ? {
          ...(webSearchRequests ? { webSearchRequests } : {}),
          ...(webFetchRequests ? { webFetchRequests } : {}),
        }
      : undefined;

  yield {
    type: "usage",
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    ...(providerResponseId ? { providerResponseId } : {}),
    ...(serverToolUsage ? { serverToolUsage } : {}),
  };
  yield { type: "content_blocks", blocks };
  yield { type: "model_stop", reason: stopReason, assistantMessage };
  yield { type: "done" };
}

function toStartedActivity(
  id: string,
  name: string,
  input: unknown,
): CoreWebActivity {
  const record = isRecord(input) ? input : undefined;
  return {
    id,
    kind: name === "web_fetch" ? "fetch" : "search",
    status: "started",
    backend: "provider",
    ...(typeof record?.query === "string" ? { query: record.query } : {}),
    ...(typeof record?.url === "string" ? { url: record.url } : {}),
  };
}

function toCompletedActivity(
  resultBlock: Record<string, unknown>,
): CoreWebActivity | null {
  const id = resultBlock.tool_use_id;
  const type = resultBlock.type;
  if (typeof id !== "string") return null;
  const kind = type === "web_fetch_tool_result" ? "fetch" : "search";
  const content = resultBlock.content;
  if (isRecord(content) && typeof content.error_code === "string") {
    return {
      id,
      kind,
      status: "failed",
      backend: "provider",
      error: content.error_code,
    };
  }
  if (kind === "search") {
    const citations = Array.isArray(content)
      ? content
          .map((item) => toResultCitation(item))
          .filter((item): item is CoreWebCitation => item !== null)
      : [];
    return {
      id,
      kind,
      status: "completed",
      backend: "provider",
      ...(citations.length > 0 ? { citations } : {}),
    };
  }
  const fetchResult = isRecord(content) ? content : null;
  const url =
    typeof fetchResult?.url === "string" ? fetchResult.url : undefined;
  const document = isRecord(fetchResult?.content)
    ? fetchResult.content
    : undefined;
  const title =
    typeof document?.title === "string" ? document.title : undefined;
  return {
    id,
    kind,
    status: "completed",
    backend: "provider",
    ...(url ? { url } : {}),
    ...(url ? { citations: [{ url, ...(title ? { title } : {}) }] } : {}),
  };
}

function toResultCitation(value: unknown): CoreWebCitation | null {
  if (!isRecord(value) || typeof value.url !== "string") return null;
  return {
    url: value.url,
    ...(typeof value.title === "string" ? { title: value.title } : {}),
  };
}

function readCoreCitations(
  value: unknown,
  fetchedDocuments: ReadonlyArray<{ url: string; title?: string }>,
): CoreWebCitation[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((citation) => toCoreCitation(citation, fetchedDocuments))
    .filter((citation): citation is CoreWebCitation => citation !== null);
}

function toCoreCitation(
  value: unknown,
  fetchedDocuments: ReadonlyArray<{ url: string; title?: string }>,
): CoreWebCitation | null {
  if (!isRecord(value)) return null;
  const document =
    typeof value.document_index === "number"
      ? fetchedDocuments[value.document_index]
      : undefined;
  const url = typeof value.url === "string" ? value.url : document?.url;
  if (!url) return null;
  const title =
    typeof value.document_title === "string"
      ? value.document_title
      : typeof value.title === "string"
        ? value.title
        : document?.title;
  return {
    url,
    ...(title ? { title } : {}),
    ...(typeof value.cited_text === "string"
      ? { citedText: value.cited_text }
      : {}),
  };
}

function addUniqueCitation(
  target: CoreWebCitation[],
  citation: CoreWebCitation,
): void {
  if (
    !target.some(
      (item) =>
        item.url === citation.url && item.citedText === citation.citedText,
    )
  ) {
    target.push(citation);
  }
}

function parseInputJson(
  partialJson: string,
  initialInput: CoreJsonValue | undefined,
): AnthropicJsonObject {
  if (partialJson) {
    const parsed: unknown = JSON.parse(partialJson);
    if (!isRecord(parsed))
      throw new Error("Anthropic tool input must be an object");
    return parsed as AnthropicJsonObject;
  }
  return isRecord(initialInput)
    ? (initialInput as AnthropicJsonObject)
    : ({} as AnthropicJsonObject);
}

function readServerToolUsage(
  usage: Record<string, unknown>,
  currentSearch: number,
  currentFetch: number,
): { webSearchRequests: number; webFetchRequests: number } {
  const server = isRecord(usage.server_tool_use)
    ? usage.server_tool_use
    : undefined;
  return {
    webSearchRequests:
      typeof server?.web_search_requests === "number"
        ? server.web_search_requests
        : currentSearch,
    webFetchRequests:
      typeof server?.web_fetch_requests === "number"
        ? server.web_fetch_requests
        : currentFetch,
  };
}

function normalizeStopReason(value: unknown): CoreModelStopReason {
  return value === "tool_use" || value === "pause_turn" ? value : "end_turn";
}

function isAnthropicServerReplayBlock(block: AnthropicJsonObject): boolean {
  return (
    block.type === "server_tool_use" ||
    block.type === "web_search_tool_result" ||
    block.type === "web_fetch_tool_result"
  );
}

function markOutputStarted(state?: AnthropicStreamParserState): void {
  if (state) state.outputStarted = true;
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defaultThinkingId(): string {
  return `anthropic-thinking-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
