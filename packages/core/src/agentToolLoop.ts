import type {
  CoreModelContentBlock,
  CoreModelMessage,
  CoreModelStopReason,
} from "./modelRuntime.js";
import {
  TurnExecutionCancelledError,
  TurnExecutionLimitError,
  TurnExecutionTracker,
  type TurnExecutionOptions,
  utf8ByteLength,
} from "./turnExecution.js";

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
 * Execution is unbounded by default for backward compatibility. Callers may
 * provide neutral model/tool/time/result-byte limits and cancellation through
 * `execution` without introducing surface-specific policy into this driver.
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
  /** Keep this call's durable execution reservation open across suspension. */
  preserveReservation?: boolean;
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
  /** Exact assistant/tool sequence restored before an out-of-band continuation. */
  initialIterationMessages?: readonly CoreModelMessage[];
  /** Pending calls from the restored assistant tool turn, in original order. */
  initialToolCalls?: readonly AgentToolLoopCall[];
  /** True when initialToolCalls already hold durable execution reservations. */
  initialToolCallsReserved?: boolean;
  /**
   * Optional run-scoped limits, cancellation, clock, and execution events.
   * Elapsed time and cancellation are checked between calls; handlers remain
   * responsible for interrupting an in-flight model or tool operation.
   */
  execution?: TurnExecutionOptions;
  /**
   * The loop always reserves the first model call before dispatch. Provider
   * runtimes with physical retry hooks may select `handler`; their first
   * `onModelCallAttempt` confirms that reservation and later attempts reserve
   * additional calls. Hook-ignoring backends therefore remain bounded.
   */
  modelCallAccounting?: "loop" | "handler";
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
    onModelCallAttempt: () => void;
    signal?: AbortSignal;
  }): Promise<AgentToolLoopModelResult>;
  /** Execute a single requested tool. */
  runTool(
    call: AgentToolLoopCall,
    context: {
      signal?: AbortSignal;
      /** Exact private sequence through this call's assistant tool turn. */
      iterationMessages: readonly CoreModelMessage[];
      /** This call and all subsequent calls from the same assistant turn. */
      pendingToolCalls: readonly AgentToolLoopCall[];
      /** Calls reserved together in the current execution batch. */
      reservedToolCalls: readonly AgentToolLoopCall[];
    },
  ): Promise<AgentToolLoopToolResult<TOutcome>>;
  /**
   * Classify calls that may overlap with adjacent safe calls. Calls for which
   * this returns false are ordered barriers. The default is fully sequential.
   */
  isParallelSafe?(call: AgentToolLoopCall): boolean;
  /**
   * Observe the exact private iteration sequence before the loop returns or
   * bounded execution terminates with a limit/cancellation error.
   */
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
  const iterationMessages: CoreModelMessage[] = [
    ...(handlers.initialIterationMessages ?? []),
    ...toolMessages,
  ];
  let assistantText = "";
  const execution = new TurnExecutionTracker(handlers.execution);
  let pendingToolCalls: readonly AgentToolLoopCall[] | undefined =
    handlers.initialToolCalls;

  try {
    for (;;) {
      let result: AgentToolLoopModelResult;
      if (pendingToolCalls) {
        result = { text: "", toolCalls: [...pendingToolCalls] };
        pendingToolCalls = undefined;
      } else {
        execution.beginModelCall();
        let reportedModelAttempts = 0;
        result = await handlers.callModel({
          iterationMessages,
          toolMessages,
          onText: (delta) => {
            assistantText += delta;
          },
          onModelCallAttempt: () => {
            reportedModelAttempts += 1;
            if (
              handlers.modelCallAccounting === "handler" &&
              reportedModelAttempts > 1
            ) {
              execution.beginModelCall();
            }
          },
          signal: handlers.execution?.signal,
        });
        if (!assistantText && result.text) {
          assistantText = result.text;
        }
        iterationMessages.push(toAssistantMessage(result));
        execution.completeModelCall();

        if (result.stopReason === "pause_turn") continue;
      }

      if (result.toolCalls.length === 0) {
        handlers.onIterationMessagesComplete?.(iterationMessages);
        const finalText = result.text || assistantText;
        return finalText
          ? handlers.finishSuccess(finalText)
          : handlers.finishEmpty();
      }

      let nextCallIndex = 0;
      while (nextCallIndex < result.toolCalls.length) {
        const batchStartIndex = nextCallIndex;
        const firstCall = result.toolCalls[nextCallIndex];
        const parallelSafe = handlers.isParallelSafe?.(firstCall) ?? false;
        const batch: AgentToolLoopCall[] = [firstCall];
        nextCallIndex += 1;

        if (parallelSafe) {
          while (nextCallIndex < result.toolCalls.length) {
            const candidate = result.toolCalls[nextCallIndex];
            if (!(handlers.isParallelSafe?.(candidate) ?? false)) break;
            batch.push(candidate);
            nextCallIndex += 1;
          }
        }

        const executionCalls = batch.map((call) => ({
          callId: call.id,
          toolName: call.name,
        }));
        if (handlers.initialToolCallsReserved) {
          execution.resumeToolCalls(executionCalls);
          handlers.initialToolCallsReserved = false;
        } else {
          execution.beginToolCalls(executionCalls);
        }
        const executedBatch = parallelSafe
          ? await Promise.all(
              batch.map((call) =>
                handlers.runTool(call, {
                  signal: handlers.execution?.signal,
                  iterationMessages: [...iterationMessages],
                  pendingToolCalls: result.toolCalls.slice(batchStartIndex),
                  reservedToolCalls: batch,
                }),
              ),
            )
          : [
              await handlers.runTool(firstCall, {
                signal: handlers.execution?.signal,
                iterationMessages: [...iterationMessages],
                pendingToolCalls: result.toolCalls.slice(batchStartIndex),
                reservedToolCalls: batch,
              }),
            ];
        const completedBatch = executedBatch.map((executed, index) => ({
          call: batch[index],
          executed,
          toolMessage: executed.toolMessage
            ? normalizeToolResultMessage(executed.toolMessage)
            : undefined,
        }));
        for (const completed of completedBatch) {
          if (completed.toolMessage) {
            toolMessages.push(completed.toolMessage);
            iterationMessages.push(completed.toolMessage);
          }
        }
        const measureToolResultBytes =
          execution.limits.maxToolResultBytes > 0 ||
          handlers.execution?.onEvent !== undefined;
        const stopped = completedBatch.find(
          (completed) => completed.executed.stop,
        )?.executed;
        const completedForAccounting = completedBatch.filter(
          (completed) => !completed.executed.preserveReservation,
        );
        if (completedForAccounting.length > 0) {
          execution.completeToolCalls(
            completedForAccounting.map((completed) => ({
              callId: completed.call.id,
              toolName: completed.call.name,
              resultBytes:
                measureToolResultBytes && completed.toolMessage
                  ? toolResultByteLength(completed.toolMessage)
                  : 0,
            })),
            { checkLimits: !stopped },
          );
        }
        if (stopped) {
          handlers.onIterationMessagesComplete?.(iterationMessages);
          return handlers.finishSuccess(
            assistantText || stopped.content,
            stopped.outcome,
          );
        }
      }
    }
  } catch (error) {
    if (
      error instanceof TurnExecutionLimitError ||
      error instanceof TurnExecutionCancelledError
    ) {
      handlers.onIterationMessagesComplete?.(iterationMessages);
    }
    throw error;
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

function toolResultByteLength(message: CoreModelMessage): number {
  return utf8ByteLength(JSON.stringify(message));
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
