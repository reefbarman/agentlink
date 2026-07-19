import type {
  AgentToolExecutionContext,
  AgentToolRuntime,
} from "../../core/tools/types.js";

import { COMPOSABLE_TOOLS } from "../../core/tools/toolCapabilities.js";
import type { ToolResult } from "../../shared/types.js";
import { randomUUID } from "crypto";

export type ComposeScopeErrorKind =
  | "aborted"
  | "budget_exhausted"
  | "canonical_result_required"
  | "child_failed"
  | "recursive_compose"
  | "tool_input_not_composable"
  | "tool_not_composable"
  | "tool_not_in_request";

export class ComposeScopeError extends Error {
  constructor(
    readonly kind: ComposeScopeErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "ComposeScopeError";
  }
}

export interface ComposeExecutionScope {
  canExecuteChild(toolName: string): boolean;
  executeChild(
    toolName: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolResult>;
}

interface ComposeScopeOptions {
  runtime: AgentToolRuntime;
  parentContext: AgentToolExecutionContext;
  isComposable?: (toolName: string) => boolean;
  createCallId?: () => string;
  now?: () => number;
}

function cancellationResult(toolName: string): ToolResult {
  const data = {
    status: "cancelled",
    tool: toolName,
    error: "Compose child was cancelled",
  };
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
    data,
    isError: true,
    error: { kind: "aborted", message: "Compose child was cancelled" },
  };
}

function assertComposableInput(
  toolName: string,
  input: Record<string, unknown>,
): void {
  if (
    (toolName === "list_files" && typeof input.query === "string") ||
    (toolName === "search_files" && input.semantic === true)
  ) {
    throw new ComposeScopeError(
      "tool_input_not_composable",
      `Tool '${toolName}' supports composition only in its native non-semantic mode`,
    );
  }
}

function requireParentContext(
  context: AgentToolExecutionContext,
): asserts context is AgentToolExecutionContext & {
  availableToolNames: ReadonlySet<string>;
  toolCallBudget: NonNullable<AgentToolExecutionContext["toolCallBudget"]>;
  toolCallId: string;
} {
  if (!context.availableToolNames) {
    throw new Error(
      "Compose requires the frozen provider-request tool catalog",
    );
  }
  if (!context.toolCallBudget) {
    throw new Error("Compose requires a run-scoped tool-call budget");
  }
  if (!context.toolCallId) {
    throw new Error("Compose requires its parent tool-call identity");
  }
}

export function createComposeExecutionScope(
  options: ComposeScopeOptions,
): ComposeExecutionScope {
  const {
    runtime,
    parentContext,
    isComposable = (toolName) => COMPOSABLE_TOOLS.has(toolName),
    createCallId = randomUUID,
    now = Date.now,
  } = options;
  requireParentContext(parentContext);

  const canExecuteChild = (toolName: string): boolean =>
    toolName !== "compose" &&
    parentContext.availableToolNames.has(toolName) &&
    isComposable(toolName);

  return {
    canExecuteChild,
    async executeChild(toolName, input, callSignal) {
      if (parentContext.toolAbortSignal?.aborted || callSignal?.aborted) {
        throw new ComposeScopeError("aborted", "Compose execution was aborted");
      }
      if (toolName === "compose") {
        throw new ComposeScopeError(
          "recursive_compose",
          "Nested compose calls are not supported",
        );
      }
      if (!parentContext.availableToolNames.has(toolName)) {
        throw new ComposeScopeError(
          "tool_not_in_request",
          `Tool '${toolName}' was not available in the provider request that invoked compose`,
        );
      }
      if (!isComposable(toolName)) {
        throw new ComposeScopeError(
          "tool_not_composable",
          `Tool '${toolName}' is not composable; call it directly instead`,
        );
      }
      assertComposableInput(toolName, input);

      const reservation = parentContext.toolCallBudget.tryReserve();
      if (!reservation.ok) {
        throw new ComposeScopeError(
          "budget_exhausted",
          `Tool call budget exhausted after ${reservation.snapshot.used} calls (limit ${reservation.snapshot.limit}). Reduce, filter, paginate, or memoize inside the compose script.`,
        );
      }

      const childCallId = `${parentContext.toolCallId}:child:${createCallId()}`;
      const childController = new AbortController();
      const parentSignal = parentContext.toolAbortSignal;
      const abortSignals = [parentSignal, callSignal].filter(
        (signal): signal is AbortSignal => Boolean(signal),
      );
      let rejectAbort!: (error: ComposeScopeError) => void;
      const abortPromise = new Promise<never>((_, reject) => {
        rejectAbort = reject;
      });
      const abortChild = () => {
        childController.abort();
        rejectAbort(
          new ComposeScopeError("aborted", "Compose execution was aborted"),
        );
      };
      if (abortSignals.some((signal) => signal.aborted)) abortChild();
      else {
        for (const signal of abortSignals) {
          signal.addEventListener("abort", abortChild, { once: true });
        }
      }

      const tracker = runtime.getToolCallTracker?.();
      let forceResolve!: (result: ToolResult) => void;
      const forcePromise = new Promise<ToolResult>((resolve) => {
        forceResolve = resolve;
      });
      const trackerContext = tracker?.registerAgentCall(
        childCallId,
        toolName,
        "",
        parentContext.sessionId,
        (result) => {
          childController.abort();
          forceResolve(result);
        },
        JSON.stringify(input, null, 2),
        parentContext.toolCallId,
      );

      const startedAt = now();
      parentContext.onNestedToolStart?.({
        toolCallId: childCallId,
        parentCallId: parentContext.toolCallId,
        toolName,
        input,
      });

      try {
        const result = await Promise.race([
          runtime.executeTool({
            name: toolName,
            input,
            context: {
              ...parentContext,
              trackerCtx: trackerContext,
              toolAbortSignal: childController.signal,
              toolCallId: childCallId,
              parentCallId: parentContext.toolCallId,
              interactionPolicy: "deny",
            },
          }),
          forcePromise,
          abortPromise,
        ]);
        if (result.isError) {
          throw new ComposeScopeError(
            "child_failed",
            result.error?.message ?? `Tool '${toolName}' failed`,
          );
        }
        if (!("data" in result)) {
          throw new ComposeScopeError(
            "canonical_result_required",
            `Tool '${toolName}' did not return canonical structured data`,
          );
        }
        parentContext.onNestedToolComplete?.({
          toolCallId: childCallId,
          parentCallId: parentContext.toolCallId,
          toolName,
          input,
          result,
          durationMs: now() - startedAt,
        });
        return result;
      } catch (error) {
        const scopedError =
          error instanceof ComposeScopeError
            ? error
            : new ComposeScopeError(
                "child_failed",
                error instanceof Error ? error.message : String(error),
              );
        const result =
          scopedError.kind === "aborted"
            ? cancellationResult(toolName)
            : {
                content: [
                  {
                    type: "text" as const,
                    text: JSON.stringify({ error: scopedError.message }),
                  },
                ],
                data: { error: scopedError.message },
                isError: true,
                error: {
                  kind: scopedError.kind,
                  message: scopedError.message,
                },
              };
        parentContext.onNestedToolComplete?.({
          toolCallId: childCallId,
          parentCallId: parentContext.toolCallId,
          toolName,
          input,
          result,
          durationMs: now() - startedAt,
        });
        throw scopedError;
      } finally {
        for (const signal of abortSignals) {
          signal.removeEventListener("abort", abortChild);
        }
        childController.abort();
        tracker?.completeAgentCall(childCallId);
      }
    },
  };
}
