import type {
  CoreModelContentBlock,
  CoreModelMessage,
  CoreModelStopReason,
} from "./modelRuntime.js";

/**
 * Surface-neutral driver for the "agentic tool loop": repeatedly call a model,
 * run any tools it requests, and feed the results back until the model returns
 * a final response (no more tool calls) or a tool signals the turn is done.
 *
 * Intentionally minimal. This captures the loop *shape* shared by lightweight,
 * single-model-client surfaces (e.g. the browser-gateway Ask Agent). It is NOT
 * meant to host the full VS Code project agent loop, which interleaves
 * condensation, credential refresh, queued-message interjection, and
 * parallel/approval-gated tool dispatch into the same loop and streams an event
 * union rather than returning a value — concerns that don't fit this contract.
 *
 * There is deliberately no iteration cap: the loop runs until the model
 * finishes or a tool stops it. Callers bound long turns by aborting the signal
 * threaded through their `callModel`/`runTool` implementations, which throws out
 * of the loop into the caller's own error handling.
 */

export interface AgentToolLoopCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AgentToolLoopModelResult {
  /** The model's text for this turn (empty when it only requested tools). */
  text: string;
  toolCalls: AgentToolLoopCall[];
  /** Exact assistant response for replay. Older callers may omit this. */
  assistantMessage?: CoreModelMessage;
  stopReason?: CoreModelStopReason;
}

export interface AgentToolLoopToolResult<TOutcome extends string = string> {
  /** Result message to feed back to the model on the next iteration. */
  toolMessage?: CoreModelMessage;
  /** When true, end the turn now instead of looping back to the model. */
  stop: boolean;
  /** Fallback final text when stopping with no streamed assistant text. */
  content: string;
  /** Optional outcome label to attach to the finished turn. */
  outcome?: TOutcome;
}

export interface AgentToolLoopHandlers<
  TResult,
  TOutcome extends string = string,
> {
  /**
   * Tool results that should be fed to the first model call. Used when a
   * surface resumes a previously-paused turn after an out-of-band tool result
   * (for example, a browser user submitting ask_user answers).
   */
  initialToolMessages?: readonly CoreModelMessage[];
  /**
   * Run one model call. Stream incremental text through `onText` (the driver
   * uses it to assemble the turn's assistant text); side effects such as UI
   * updates belong inside the implementation.
   */
  callModel(args: {
    /** Ordered assistant responses and user tool results since the base transcript. */
    iterationMessages: CoreModelMessage[];
    /** @deprecated Compatibility view containing only tool-result messages. */
    toolMessages: CoreModelMessage[];
    onText: (delta: string) => void;
  }): Promise<AgentToolLoopModelResult>;
  /** Execute a single requested tool. */
  runTool(call: AgentToolLoopCall): Promise<AgentToolLoopToolResult<TOutcome>>;
  /** Observe the exact private iteration sequence before the loop returns. */
  onIterationMessagesComplete?(messages: readonly CoreModelMessage[]): void;
  /** Finalize a turn that produced assistant text. */
  finishSuccess(text: string, outcome?: TOutcome): TResult;
  /** Finalize a turn where the model finished without any text. */
  finishEmpty(): TResult;
}

export async function runAgentToolLoop<
  TResult,
  TOutcome extends string = string,
>(handlers: AgentToolLoopHandlers<TResult, TOutcome>): Promise<TResult> {
  const toolMessages: CoreModelMessage[] = [
    ...(handlers.initialToolMessages ?? []),
  ];
  const iterationMessages: CoreModelMessage[] = [...toolMessages];
  let assistantText = "";

  for (;;) {
    const result = await handlers.callModel({
      iterationMessages,
      toolMessages,
      onText: (delta) => {
        assistantText += delta;
      },
    });
    if (!assistantText && result.text) {
      assistantText = result.text;
    }

    if (result.stopReason === "pause_turn") {
      iterationMessages.push(toAssistantMessage(result));
      continue;
    }

    if (result.toolCalls.length === 0) {
      iterationMessages.push(toAssistantMessage(result));
      handlers.onIterationMessagesComplete?.(iterationMessages);
      const finalText = result.text || assistantText;
      return finalText
        ? handlers.finishSuccess(finalText)
        : handlers.finishEmpty();
    }

    iterationMessages.push(toAssistantMessage(result));
    for (const call of result.toolCalls) {
      const executed = await handlers.runTool(call);
      if (executed.toolMessage) {
        const toolMessage = normalizeToolResultMessage(executed.toolMessage);
        toolMessages.push(toolMessage);
        iterationMessages.push(toolMessage);
      }
      if (executed.stop) {
        handlers.onIterationMessagesComplete?.(iterationMessages);
        return handlers.finishSuccess(
          assistantText || executed.content,
          executed.outcome,
        );
      }
    }
  }
}

function toAssistantMessage(
  result: AgentToolLoopModelResult,
): CoreModelMessage {
  if (result.assistantMessage) return result.assistantMessage;
  const blocks: CoreModelContentBlock[] = [];
  if (result.text) blocks.push({ type: "text", text: result.text });
  blocks.push(
    ...result.toolCalls.map((call) => ({
      type: "tool_use" as const,
      id: call.id,
      name: call.name,
      input: call.input,
    })),
  );
  return { role: "assistant", content: blocks };
}

function normalizeToolResultMessage(
  message: CoreModelMessage,
): CoreModelMessage {
  if (message.role === "user") return message;
  if (!Array.isArray(message.content)) {
    return { role: "user", content: message.content };
  }
  const resultBlocks = message.content.filter(
    (block) => block.type === "tool_result",
  );
  return {
    role: "user",
    content: resultBlocks.length > 0 ? resultBlocks : message.content,
  };
}
