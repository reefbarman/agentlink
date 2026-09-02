import type {
  CoreModelContentBlock,
  CoreModelMessage,
  CoreModelStreamEvent,
  CoreModelThinkingBlock,
} from "@agentlink/core/model-runtime";
import {
  CORE_WEB_ACCESS_DEFAULT_MAX_REPLAY_BYTES_PER_TURN,
  createCoreProviderReplayEnvelope,
} from "../../../webAccess.js";
import type { CoreJsonValue } from "@agentlink/protocol/provider-replay";
import type {
  CoreWebActivity,
  CoreWebCitation,
} from "@agentlink/protocol/web-activity";

export interface CodexStreamParserState {
  outputStarted: boolean;
}

export interface CodexStreamParserOptions {
  createThinkingId?: () => string;
  maxReplayBytes?: number;
}

export class CodexStreamError extends Error {
  readonly rawMessage: string;
  readonly body: unknown;

  constructor(
    message: string,
    options: { rawMessage: string; body?: unknown },
  ) {
    super(message);
    this.name = "CodexStreamError";
    this.rawMessage = options.rawMessage;
    this.body = options.body;
  }
}

/** Parse OpenAI/Codex Responses stream events into core model stream events. */
export async function* parseCodexResponseStreamEvents(
  events: AsyncIterable<Record<string, unknown>>,
  state?: CodexStreamParserState,
  options: CodexStreamParserOptions = {},
): AsyncGenerator<CoreModelStreamEvent> {
  const contentBlocks: CoreModelContentBlock[] = [];
  let currentText = "";
  let currentThinking = "";
  let thinkingId: string | null = null;
  const createThinkingId = options.createThinkingId ?? defaultThinkingId;
  const maxReplayBytes =
    options.maxReplayBytes ?? CORE_WEB_ACCESS_DEFAULT_MAX_REPLAY_BYTES_PER_TURN;
  const webActivities = new Map<string, CoreWebActivity>();
  const startedWebActivities = new Set<string>();
  const completedOutputItems = new Map<number, Record<string, unknown>>();
  const citations: CoreWebCitation[] = [];
  let responseOutput: Array<Record<string, unknown>> | undefined;

  const pendingToolCalls = new Map<
    string,
    { name: string; arguments: string }
  >();

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let inputTokenBreakdownReported: boolean | undefined;
  let providerResponseId: string | undefined;

  for await (const event of events) {
    const eventType = event.type as string | undefined;
    if (!eventType) continue;

    if (
      eventType === "response.output_text.delta" ||
      eventType === "response.text.delta"
    ) {
      const delta = event.delta as string | undefined;
      if (delta) {
        currentText += delta;
        if (state) state.outputStarted = true;
        yield { type: "text_delta", text: delta };
      }
      continue;
    }

    if (
      eventType === "response.reasoning_summary.delta" ||
      eventType === "response.reasoning_summary_text.delta" ||
      eventType === "response.reasoning.delta" ||
      eventType === "response.reasoning_text.delta"
    ) {
      const delta = event.delta as string | undefined;
      if (delta) {
        if (!thinkingId) {
          thinkingId = createThinkingId();
          if (state) state.outputStarted = true;
          yield { type: "thinking_start", thinkingId };
        }
        currentThinking += delta;
        if (state) state.outputStarted = true;
        yield { type: "thinking_delta", thinkingId, text: delta };
      }
      continue;
    }

    if (eventType === "response.refusal.delta") {
      const delta = event.delta as string | undefined;
      if (delta) {
        const refusalText = `[Refusal] ${delta}`;
        currentText += refusalText;
        if (state) state.outputStarted = true;
        yield { type: "text_delta", text: refusalText };
      }
      continue;
    }

    if (
      eventType === "response.web_search_call.in_progress" ||
      eventType === "response.web_search_call.searching"
    ) {
      const id = event.item_id as string | undefined;
      if (id && !startedWebActivities.has(id)) {
        const activity: CoreWebActivity = {
          id,
          kind: "search",
          status: "started",
          backend: "provider",
        };
        startedWebActivities.add(id);
        webActivities.set(id, activity);
        if (state) state.outputStarted = true;
        yield { type: "web_activity", activity };
      }
      continue;
    }

    if (eventType === "response.web_search_call.completed") {
      const id = event.item_id as string | undefined;
      if (id) {
        const current = webActivities.get(id);
        const activity: CoreWebActivity = {
          id,
          kind: current?.kind ?? "search",
          status: "completed",
          backend: "provider",
          ...(current?.query ? { query: current.query } : {}),
          ...(current?.url ? { url: current.url } : {}),
        };
        startedWebActivities.add(id);
        webActivities.set(id, activity);
        if (state) state.outputStarted = true;
        yield { type: "web_activity", activity };
      }
      continue;
    }

    if (eventType === "response.output_text.annotation.added") {
      const citation = toCoreWebCitation(event.annotation, currentText);
      if (citation) addUniqueCitation(citations, citation);
      continue;
    }

    if (
      eventType === "response.function_call_arguments.delta" ||
      eventType === "response.tool_call_arguments.delta"
    ) {
      const callId = (event.call_id ?? event.tool_call_id ?? event.id) as
        | string
        | undefined;
      const delta = (event.delta ?? event.arguments) as string | undefined;
      if (callId && delta) {
        const pending = pendingToolCalls.get(callId);
        if (pending) {
          pending.arguments += delta;
          if (state) state.outputStarted = true;
          yield {
            type: "tool_input_delta",
            toolCallId: callId,
            partialJson: delta,
          };
        }
      }
      continue;
    }

    if (eventType === "response.output_item.added") {
      const item = event.item as Record<string, unknown> | undefined;
      if (item?.type === "web_search_call" && typeof item.id === "string") {
        const activity = toStartedWebActivity(item);
        const alreadyStarted = startedWebActivities.has(activity.id);
        startedWebActivities.add(activity.id);
        webActivities.set(activity.id, activity);
        if (state) state.outputStarted = true;
        if (!alreadyStarted) yield { type: "web_activity", activity };
        continue;
      }
      if (
        item &&
        (item.type === "function_call" || item.type === "tool_call")
      ) {
        const callId = (item.call_id ?? item.tool_call_id ?? item.id) as string;
        const name = (item.name ??
          (item.function as Record<string, unknown> | undefined)?.name) as
          | string
          | undefined;
        if (callId && name) {
          pendingToolCalls.set(callId, { name, arguments: "" });
          if (state) state.outputStarted = true;
          yield { type: "tool_start", toolCallId: callId, toolName: name };
        }
      }
      continue;
    }

    if (eventType === "response.output_item.done") {
      const item = event.item as Record<string, unknown> | undefined;
      const outputIndex = event.output_index;
      if (item && typeof outputIndex === "number") {
        completedOutputItems.set(outputIndex, item);
      }
      if (item?.type === "web_search_call") {
        const activity = toCoreWebActivity(item);
        if (activity) {
          webActivities.set(activity.id, activity);
          startedWebActivities.add(activity.id);
          if (state) state.outputStarted = true;
          yield { type: "web_activity", activity };
        }
        continue;
      }
      if (item?.type === "message" && Array.isArray(item.content)) {
        for (const content of item.content.filter(isRecord)) {
          collectOutputCitations(content, citations);
        }
      }
      if (
        item &&
        (item.type === "function_call" || item.type === "tool_call")
      ) {
        const callId = (item.call_id ?? item.tool_call_id ?? item.id) as string;
        const name = (item.name ??
          (item.function as Record<string, unknown> | undefined)?.name) as
          | string
          | undefined;
        const argsRaw = item.arguments ?? item.input;
        const argsStr =
          typeof argsRaw === "string"
            ? argsRaw
            : argsRaw && typeof argsRaw === "object"
              ? JSON.stringify(argsRaw)
              : "";

        const pending = pendingToolCalls.get(callId);
        const finalArgs = pending?.arguments || argsStr;
        const finalName = pending?.name ?? name;

        if (callId && finalName) {
          let parsed: unknown;
          try {
            parsed = finalArgs ? JSON.parse(finalArgs) : {};
          } catch {
            parsed = {};
          }

          contentBlocks.push({
            type: "tool_use",
            id: callId,
            name: finalName,
            input: parsed as Record<string, unknown>,
          });

          if (state) state.outputStarted = true;
          yield {
            type: "tool_done",
            toolCallId: callId,
            toolName: finalName,
            input: parsed,
          };
          pendingToolCalls.delete(callId);
        }
      }
      continue;
    }

    if (eventType === "response.error" || eventType === "error") {
      const errObj = event.error as Record<string, unknown> | undefined;
      const msg =
        (errObj?.message as string) ??
        (event.message as string) ??
        "Unknown Codex API error";
      for (const activity of failPendingWebActivities(webActivities, msg)) {
        yield { type: "web_activity", activity };
      }
      throw new CodexStreamError(`Codex API error: ${msg}`, {
        rawMessage: msg,
        body: errObj,
      });
    }

    if (eventType === "response.failed") {
      const response = event.response as Record<string, unknown> | undefined;
      const errObj = (event.error ?? response?.error) as
        | Record<string, unknown>
        | undefined;
      const msg =
        (errObj?.message as string) ??
        (event.message as string) ??
        "Request failed";
      for (const activity of failPendingWebActivities(webActivities, msg)) {
        yield { type: "web_activity", activity };
      }
      throw new CodexStreamError(`Codex request failed: ${msg}`, {
        rawMessage: msg,
        body: errObj,
      });
    }

    if (eventType === "response.done" || eventType === "response.completed") {
      const resp = event.response as Record<string, unknown> | undefined;
      if (Array.isArray(resp?.output)) {
        responseOutput = resp.output.filter(isRecord);
      }
      providerResponseId =
        (resp?.id as string | undefined) ??
        (event.response_id as string | undefined) ??
        providerResponseId;
      const usage = (resp?.usage ?? event.usage) as
        | Record<string, unknown>
        | undefined;
      if (usage) {
        const totalInputTokens =
          (usage.input_tokens as number) ??
          (usage.prompt_tokens as number) ??
          0;
        outputTokens =
          (usage.output_tokens as number) ??
          (usage.completion_tokens as number) ??
          0;

        const inputDetails = usage.input_tokens_details as
          | Record<string, unknown>
          | undefined;
        const promptDetails = usage.prompt_tokens_details as
          | Record<string, unknown>
          | undefined;
        const hasCacheBreakdown =
          (inputDetails !== undefined &&
            (Object.hasOwn(inputDetails, "cached_tokens") ||
              Object.hasOwn(inputDetails, "cache_creation_tokens") ||
              Object.hasOwn(inputDetails, "cache_write_tokens"))) ||
          (promptDetails !== undefined &&
            (Object.hasOwn(promptDetails, "cached_tokens") ||
              Object.hasOwn(promptDetails, "cache_creation_tokens") ||
              Object.hasOwn(promptDetails, "cache_write_tokens"))) ||
          Object.hasOwn(usage, "cache_read_input_tokens") ||
          Object.hasOwn(usage, "cache_creation_input_tokens") ||
          Object.hasOwn(usage, "cache_write_input_tokens") ||
          Object.hasOwn(usage, "cache_write_tokens");
        if (hasCacheBreakdown) inputTokenBreakdownReported = true;
        cacheReadTokens =
          (inputDetails?.cached_tokens as number) ??
          (promptDetails?.cached_tokens as number) ??
          (usage.cache_read_input_tokens as number) ??
          0;

        const detailedCacheCreationTokens =
          (inputDetails?.cache_creation_tokens as number) ??
          (inputDetails?.cache_write_tokens as number) ??
          (promptDetails?.cache_creation_tokens as number) ??
          (promptDetails?.cache_write_tokens as number);
        cacheCreationTokens =
          detailedCacheCreationTokens ??
          (usage.cache_creation_input_tokens as number) ??
          (usage.cache_write_input_tokens as number) ??
          (usage.cache_write_tokens as number) ??
          0;

        // OpenAI Responses detail fields partition input_tokens. The core usage
        // contract keeps uncached input separate so AgentSession can reconstruct
        // context occupancy without double-counting. Top-level compatibility
        // counters may be additive, so only subtract nested detail values here.
        inputTokens = Math.max(
          0,
          totalInputTokens -
            cacheReadTokens -
            (detailedCacheCreationTokens ?? 0),
        );
      }

      if (responseOutput) {
        const useCompletedText = !currentText;
        for (const item of responseOutput) {
          if (item.type === "web_search_call") {
            const activity = toCoreWebActivity(item);
            if (
              activity &&
              webActivities.get(activity.id)?.status !== activity.status
            ) {
              webActivities.set(activity.id, activity);
              startedWebActivities.add(activity.id);
              if (state) state.outputStarted = true;
              yield { type: "web_activity", activity };
            }
          }
          if (item.type === "message" && Array.isArray(item.content)) {
            for (const c of item.content.filter(isRecord)) {
              if (c.type === "output_text" && typeof c.text === "string") {
                collectOutputCitations(c, citations);
                if (useCompletedText) {
                  currentText += c.text;
                  if (state) state.outputStarted = true;
                  yield { type: "text_delta", text: c.text };
                }
              }
            }
          }
          if (
            item.type === "reasoning" &&
            Array.isArray(item.summary) &&
            !currentThinking
          ) {
            for (const s of item.summary as Array<Record<string, unknown>>) {
              if (s?.type === "summary_text" && typeof s.text === "string") {
                if (!thinkingId) {
                  thinkingId = createThinkingId();
                  if (state) state.outputStarted = true;
                  yield { type: "thinking_start", thinkingId };
                }
                currentThinking += s.text;
                if (state) state.outputStarted = true;
                yield {
                  type: "thinking_delta",
                  thinkingId,
                  text: s.text as string,
                };
              }
            }
          }
        }
      }
      continue;
    }
  }

  if (thinkingId) {
    yield { type: "thinking_end", thinkingId };
    contentBlocks.unshift({
      type: "thinking",
      thinking: currentThinking,
      signature: "",
    } satisfies CoreModelThinkingBlock);
  }

  const finalActivities = [...webActivities.values()];
  for (const activity of finalActivities) {
    contentBlocks.push({ type: "web_activity", activity });
  }
  if (currentText) {
    contentBlocks.push({
      type: "text",
      text: currentText,
      ...(citations.length > 0 ? { citations } : {}),
    });
  }

  const output =
    responseOutput ??
    [...completedOutputItems.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, item]) => item);
  const replay =
    output.length > 0
      ? createCoreProviderReplayEnvelope({
          providerId: "openai-codex",
          codecVersion: 1,
          payload: { output: output as CoreJsonValue[] },
          maxBytes: maxReplayBytes,
        })
      : undefined;
  const assistantMessage: CoreModelMessage = {
    role: "assistant",
    content: contentBlocks,
    ...(replay ? { providerReplay: replay } : {}),
  };
  const webSearchRequests = finalActivities.filter(
    (activity) => activity.kind === "search" && activity.status !== "failed",
  ).length;
  const webFetchRequests = finalActivities.filter(
    (activity) => activity.kind === "fetch" && activity.status !== "failed",
  ).length;
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
    cacheReadTokens:
      inputTokenBreakdownReported || cacheReadTokens > 0
        ? cacheReadTokens
        : undefined,
    cacheCreationTokens:
      inputTokenBreakdownReported || cacheCreationTokens > 0
        ? cacheCreationTokens
        : undefined,
    ...(inputTokenBreakdownReported !== undefined
      ? { inputTokenBreakdownReported }
      : {}),
    providerResponseId,
    ...(serverToolUsage ? { serverToolUsage } : {}),
  };
  yield { type: "content_blocks", blocks: contentBlocks };
  yield {
    type: "model_stop",
    reason: contentBlocks.some((block) => block.type === "tool_use")
      ? "tool_use"
      : "end_turn",
    assistantMessage,
  };
  yield { type: "done" };
}

function toStartedWebActivity(item: Record<string, unknown>): CoreWebActivity {
  const action = isRecord(item.action) ? item.action : undefined;
  const actionType = action?.type;
  const kind =
    actionType === "open_page" || actionType === "find_in_page"
      ? "fetch"
      : "search";
  return {
    id: item.id as string,
    kind,
    status: "started",
    backend: "provider",
    ...(typeof action?.query === "string"
      ? { query: action.query }
      : typeof action?.pattern === "string"
        ? { query: action.pattern }
        : {}),
    ...(typeof action?.url === "string" ? { url: action.url } : {}),
  };
}

function toCoreWebActivity(
  item: Record<string, unknown>,
): CoreWebActivity | null {
  const id = item.id;
  const action = isRecord(item.action) ? item.action : undefined;
  if (typeof id !== "string" || !action) return null;

  const actionType = action.type;
  const kind = actionType === "search" ? "search" : "fetch";
  if (
    actionType !== "search" &&
    actionType !== "open_page" &&
    actionType !== "find_in_page"
  ) {
    return null;
  }
  const status = item.status === "failed" ? "failed" : "completed";
  const sourceCitations = Array.isArray(action.sources)
    ? action.sources
        .filter(isRecord)
        .map((source) => toCoreWebCitation(source))
        .filter((citation): citation is CoreWebCitation => citation !== null)
    : [];
  const queries = Array.isArray(action.queries)
    ? action.queries.filter(
        (query): query is string => typeof query === "string",
      )
    : [];
  const query =
    queries.join("; ") ||
    (typeof action.query === "string" ? action.query : undefined) ||
    (typeof action.pattern === "string" ? action.pattern : undefined);

  return {
    id,
    kind,
    status,
    backend: "provider",
    ...(query ? { query } : {}),
    ...(typeof action.url === "string" ? { url: action.url } : {}),
    ...(sourceCitations.length > 0 ? { citations: sourceCitations } : {}),
    ...(status === "failed" ? { error: "OpenAI web action failed" } : {}),
  };
}

function collectOutputCitations(
  content: Record<string, unknown>,
  target: CoreWebCitation[],
): void {
  if (!Array.isArray(content.annotations)) return;
  for (const annotation of content.annotations) {
    const citation = toCoreWebCitation(annotation, content.text);
    if (citation) addUniqueCitation(target, citation);
  }
}

function toCoreWebCitation(
  value: unknown,
  text?: unknown,
): CoreWebCitation | null {
  if (!isRecord(value) || typeof value.url !== "string") return null;
  if (
    typeof value.type === "string" &&
    value.type !== "url_citation" &&
    value.type !== "url"
  ) {
    return null;
  }
  const startIndex =
    typeof value.start_index === "number" ? value.start_index : undefined;
  const endIndex =
    typeof value.end_index === "number" ? value.end_index : undefined;
  const citedText =
    typeof text === "string" &&
    startIndex !== undefined &&
    endIndex !== undefined &&
    startIndex >= 0 &&
    endIndex >= startIndex &&
    endIndex <= text.length
      ? text.slice(startIndex, endIndex)
      : undefined;
  return {
    url: value.url,
    ...(typeof value.title === "string" ? { title: value.title } : {}),
    ...(citedText ? { citedText } : {}),
    ...(startIndex !== undefined ? { startIndex } : {}),
    ...(endIndex !== undefined ? { endIndex } : {}),
  };
}

function addUniqueCitation(
  citations: CoreWebCitation[],
  citation: CoreWebCitation,
): void {
  const existingIndex = citations.findIndex(
    (candidate) =>
      candidate.url === citation.url &&
      candidate.startIndex === citation.startIndex &&
      candidate.endIndex === citation.endIndex,
  );
  if (existingIndex < 0) {
    citations.push(citation);
    return;
  }
  citations[existingIndex] = { ...citations[existingIndex], ...citation };
}

function failPendingWebActivities(
  activities: Map<string, CoreWebActivity>,
  error: string,
): CoreWebActivity[] {
  const failed: CoreWebActivity[] = [];
  for (const [id, activity] of activities) {
    if (activity.status !== "started") continue;
    const next = { ...activity, status: "failed" as const, error };
    activities.set(id, next);
    failed.push(next);
  }
  return failed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function defaultThinkingId(): string {
  return `thinking_${Math.random().toString(36).slice(2, 10)}`;
}
