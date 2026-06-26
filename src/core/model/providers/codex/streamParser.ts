import type {
  CoreModelContentBlock,
  CoreModelStreamEvent,
  CoreModelThinkingBlock,
} from "../../../modelRuntime.js";

export interface CodexStreamParserState {
  outputStarted: boolean;
}

export interface CodexStreamParserOptions {
  createThinkingId?: () => string;
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

  const pendingToolCalls = new Map<
    string,
    { name: string; arguments: string }
  >();

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
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
      throw new CodexStreamError(`Codex API error: ${msg}`, {
        rawMessage: msg,
        body: errObj,
      });
    }

    if (eventType === "response.failed") {
      const errObj = event.error as Record<string, unknown> | undefined;
      const msg =
        (errObj?.message as string) ??
        (event.message as string) ??
        "Request failed";
      throw new CodexStreamError(`Codex request failed: ${msg}`, {
        rawMessage: msg,
        body: errObj,
      });
    }

    if (eventType === "response.done" || eventType === "response.completed") {
      const resp = event.response as Record<string, unknown> | undefined;
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
        cacheReadTokens =
          (inputDetails?.cached_tokens as number) ??
          (promptDetails?.cached_tokens as number) ??
          (usage.cache_read_input_tokens as number) ??
          0;

        cacheCreationTokens =
          (inputDetails?.cache_creation_tokens as number) ??
          (inputDetails?.cache_write_tokens as number) ??
          (promptDetails?.cache_creation_tokens as number) ??
          (promptDetails?.cache_write_tokens as number) ??
          (usage.cache_creation_input_tokens as number) ??
          (usage.cache_write_input_tokens as number) ??
          (usage.cache_write_tokens as number) ??
          0;

        inputTokens = Math.max(0, totalInputTokens - cacheReadTokens);
      }

      if (!currentText && Array.isArray(resp?.output)) {
        for (const item of resp.output as Array<Record<string, unknown>>) {
          if (item.type === "message" && Array.isArray(item.content)) {
            for (const c of item.content as Array<Record<string, unknown>>) {
              if (c.type === "output_text" && typeof c.text === "string") {
                currentText += c.text;
                if (state) state.outputStarted = true;
                yield { type: "text_delta", text: c.text as string };
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

  if (currentText) {
    contentBlocks.push({ type: "text", text: currentText });
  }

  yield {
    type: "usage",
    inputTokens,
    outputTokens,
    cacheReadTokens: cacheReadTokens || undefined,
    cacheCreationTokens: cacheCreationTokens || undefined,
    providerResponseId,
  };
  yield { type: "content_blocks", blocks: contentBlocks };
  yield { type: "done" };
}

function defaultThinkingId(): string {
  return `thinking_${Math.random().toString(36).slice(2, 10)}`;
}
