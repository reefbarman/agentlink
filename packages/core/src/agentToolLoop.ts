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
 * condensation and credential refresh into the same loop and streams an event
 * union rather than returning a value — concerns that don't fit this contract.
 *
 * Queued user messages (interjections) are admitted the way the VS Code agent
 * admits them: drained oldest first once every result of an assistant turn is
 * in, and before the turn would end, each as its own user message.
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
  /**
   * The call set the turn's final status (VS Code's `set_task_status`).
   * Later calls in the same assistant response are answered as skipped,
   * then the turn ends with `content` as its fallback text, unless a queued
   * user message is admitted first, in which case the model answers it.
   */
  endTurn?: boolean;
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
    onTextReset: () => void;
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
  /**
   * Observe the iteration sequence when a model call fails with an error
   * other than a limit or cancellation. It is complete up to that call,
   * including user messages admitted for it that the model never answered.
   */
  onModelCallFailed?(messages: readonly CoreModelMessage[]): void;
  /**
   * User messages to admit now (queued input that steers the turn), oldest
   * first. Called once every result of an assistant turn is in, and before
   * the turn would end; returning any keeps the turn going so the model
   * answers them. Each is fed as its own user message. `iterationMessages`
   * is the exact private sequence so far, before the admitted messages.
   */
  takeInterjections?(context: {
    iterationMessages: readonly CoreModelMessage[];
  }): readonly CoreModelMessage[];
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
  const admitInterjections = (): boolean => {
    if (handlers.execution?.signal?.aborted) return false;
    const admitted =
      handlers.takeInterjections?.({
        iterationMessages: [...iterationMessages],
      }) ?? [];
    for (const message of admitted) iterationMessages.push(message);
    return admitted.length > 0;
  };

  try {
    for (;;) {
      let result: AgentToolLoopModelResult;
      if (pendingToolCalls) {
        result = { text: "", toolCalls: [...pendingToolCalls] };
        pendingToolCalls = undefined;
      } else {
        execution.beginModelCall();
        let reportedModelAttempts = 0;
        const textBeforeModelCall = assistantText;
        try {
          result = await handlers.callModel({
            iterationMessages,
            toolMessages,
            onText: (delta) => {
              assistantText += delta;
            },
            onTextReset: () => {
              assistantText = textBeforeModelCall;
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
        } catch (error) {
          if (
            !(error instanceof TurnExecutionLimitError) &&
            !(error instanceof TurnExecutionCancelledError)
          ) {
            handlers.onModelCallFailed?.(iterationMessages);
          }
          throw error;
        }
        if (!assistantText && result.text) {
          assistantText = result.text;
        }
        iterationMessages.push(toAssistantMessage(result));
        execution.completeModelCall();

        if (result.stopReason === "pause_turn") continue;
      }

      if (result.toolCalls.length === 0) {
        // A queued message takes priority over ending the turn.
        if (admitInterjections()) continue;
        handlers.onIterationMessagesComplete?.(iterationMessages);
        const finalText = result.text || assistantText;
        return finalText
          ? handlers.finishSuccess(finalText)
          : handlers.finishEmpty();
      }

      let nextCallIndex = 0;
      let ended:
        | {
            readonly call: AgentToolLoopCall;
            readonly executed: AgentToolLoopToolResult<TOutcome>;
          }
        | undefined;
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
        ended = completedBatch.find((completed) => completed.executed.endTurn);
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
            { checkLimits: !stopped && !ended },
          );
        }
        if (stopped) {
          handlers.onIterationMessagesComplete?.(iterationMessages);
          return handlers.finishSuccess(
            assistantText || stopped.content,
            stopped.outcome,
          );
        }
        if (ended) break;
      }
      if (ended) {
        // VS Code's barrier: every later call in this response is skipped.
        for (const call of result.toolCalls.slice(nextCallIndex)) {
          const skipped = skippedToolResultMessage(call, ended.call.name);
          toolMessages.push(skipped);
          iterationMessages.push(skipped);
        }
        // A queued message takes priority over ending the turn.
        if (admitInterjections()) continue;
        handlers.onIterationMessagesComplete?.(iterationMessages);
        return handlers.finishSuccess(
          assistantText || ended.executed.content,
          ended.executed.outcome,
        );
      }
      admitInterjections();
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

function skippedToolResultMessage(
  call: AgentToolLoopCall,
  skippedBy: string,
): CoreModelMessage {
  return {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: call.id,
        content: JSON.stringify({
          status: "skipped",
          skipped_by: skippedBy,
          reason: "Skipped because final task status was set for this turn.",
        }),
      },
    ],
  };
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
