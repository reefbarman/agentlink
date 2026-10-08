import type {
  AgentToolExecutionContext,
  AgentToolRuntime,
} from "../../core/tools/types.js";
import {
  COMPOSABLE_TOOLS,
  getComposabilityPolicy,
  validateComposableToolInput,
  validateComposableToolOutputContent,
} from "../../core/tools/toolCapabilities.js";
import {
  getPermittedReadFileViews,
  resolveReadFileView,
} from "../../core/tools/readFileViews.js";

import type { ToolResult } from "@agentlink/protocol/tool-result";
import { randomUUID } from "crypto";

export type ComposeScopeErrorKind =
  | "aborted"
  | "authorization"
  | "budget_exhausted"
  | "canonical_result_required"
  | "child_handler_failed"
  | "recursive_compose"
  | "tool_input_not_composable"
  | "tool_not_composable"
  | "tool_output_not_composable";

export type ComposeChildRoute = "inline" | "deferred";

export class ComposeScopeError extends Error {
  constructor(
    readonly kind: ComposeScopeErrorKind,
    message: string,
    readonly code: string = kind,
  ) {
    super(message);
    this.name = "ComposeScopeError";
  }
}

export interface ComposeExecutionScope {
  canExecuteChild(toolName: string): boolean;
  preflightChild(toolName: string, input: Record<string, unknown>): void;
  reserveChildren(count: number): void;
  executeChild(
    toolName: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
    options?: { budgetReserved?: boolean },
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
  const violation = validateComposableToolInput(toolName, input);
  if (violation) {
    throw new ComposeScopeError(
      "tool_input_not_composable",
      `Tool '${toolName}' input is not composable: ${violation.message}`,
    );
  }
}

function assertComposableOutputContent(
  toolName: string,
  result: ToolResult,
): void {
  const violation = validateComposableToolOutputContent(
    toolName,
    result.content,
  );
  if (violation) {
    throw new ComposeScopeError(
      "tool_output_not_composable",
      `Tool '${toolName}' output is not composable: ${violation.message}`,
    );
  }
}

function mcpTarget(input: Record<string, unknown>): {
  server: string;
  tool: string;
} {
  return {
    server: typeof input.server === "string" ? input.server.trim() : "",
    tool: typeof input.tool === "string" ? input.tool.trim() : "",
  };
}

function assertRuntimeAdmission(
  toolName: string,
  input: Record<string, unknown>,
  runtime: AgentToolRuntime,
): void {
  if (getComposabilityPolicy(toolName)?.runtimeAdmission !== "mcp-read-only") {
    return;
  }
  const { server, tool } = mcpTarget(input);
  if (runtime.isMcpToolReadOnly?.(server, tool) !== true) {
    throw new ComposeScopeError(
      "tool_input_not_composable",
      `Tool '${toolName}' input is not composable: MCP tool '${server}__${tool}' is not marked read-only by its connected server. Call call_mcp_tool directly instead.`,
    );
  }
}

function parseMcpText(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/**
 * MCP results carry canonical data only when the server returns structured
 * content. Derive it from text blocks otherwise, and surface the bridge's
 * bare `{ error }` payloads as child failures so settled batches keep them
 * per child.
 */
function canonicalizeMcpChildResult(result: ToolResult): ToolResult {
  if (result.isError || ("data" in result && result.data !== undefined)) {
    return result;
  }
  const values = result.content.flatMap((item) =>
    item.type === "text" ? [parseMcpText(item.text)] : [],
  );
  const data = values.length === 1 ? values[0] : values;
  if (
    data &&
    typeof data === "object" &&
    !Array.isArray(data) &&
    Object.keys(data).length === 1 &&
    typeof (data as Record<string, unknown>).error === "string"
  ) {
    const message = (data as { error: string }).error;
    return {
      ...result,
      data,
      isError: true,
      error: { kind: "mcp_tool_error", message },
    };
  }
  return { ...result, data };
}

function getResultStatus(result: ToolResult): {
  status?: string;
  reason?: string;
} {
  if (!result.data || typeof result.data !== "object") return {};
  const data = result.data as Record<string, unknown>;
  return {
    ...(typeof data.status === "string" ? { status: data.status } : {}),
    ...(typeof data.reason === "string" ? { reason: data.reason } : {}),
  };
}

function childResultError(
  toolName: string,
  result: ToolResult,
): ComposeScopeError {
  const message = result.error?.message ?? `Tool '${toolName}' failed`;
  const { status, reason } = getResultStatus(result);
  const code = reason ?? status ?? result.error?.kind ?? "child_handler_failed";
  if (
    status === "tool_not_available" ||
    status === "tool_not_in_mode" ||
    status === "native_tool_not_available" ||
    status === "missing_native_catalog" ||
    status === "invalid_bridge_input" ||
    status === "invalid_native_tool_input" ||
    status === "invalid_resolved_native_tool" ||
    status === "native_tool_not_invocable" ||
    status === "read_view_not_permitted" ||
    reason === "interaction_denied"
  ) {
    return new ComposeScopeError("authorization", message, code);
  }
  if (result.error?.kind === "aborted" || status === "cancelled") {
    return new ComposeScopeError("aborted", message, code);
  }
  return new ComposeScopeError(
    "child_handler_failed",
    message,
    "child_handler_failed",
  );
}

function resolveChildRoute(
  toolName: string,
  parentContext: AgentToolExecutionContext & {
    availableToolNames: ReadonlySet<string>;
  },
  isComposable: (toolName: string) => boolean,
): ComposeChildRoute {
  if (toolName === "compose") {
    throw new ComposeScopeError(
      "recursive_compose",
      "Nested compose calls are not supported",
    );
  }

  const inline = parentContext.availableToolNames.has(toolName);
  const deferred =
    parentContext.availableToolNames.has("call_native_tool") &&
    parentContext.nativeToolDisclosure?.deferredTools.some(
      (tool) => tool.name === toolName,
    ) === true;
  if (!inline && !deferred) {
    throw new ComposeScopeError(
      "authorization",
      `Tool '${toolName}' was not available in the provider request that invoked compose`,
      "tool_not_in_request",
    );
  }
  if (!isComposable(toolName)) {
    throw new ComposeScopeError(
      "tool_not_composable",
      `Tool '${toolName}' is not composable; call it directly instead`,
    );
  }
  if (
    parentContext.modeAllowedToolNames &&
    !parentContext.modeAllowedToolNames.has(toolName)
  ) {
    throw new ComposeScopeError(
      "authorization",
      `Tool '${toolName}' is not available in ${parentContext.mode ?? "the current"} mode`,
      "tool_not_in_mode",
    );
  }
  const skillAllowedTools =
    parentContext.skillAuthority?.allowedTools ??
    parentContext.skillAllowedTools;
  // read_file views map to separate operations; the runtime enforces the
  // exact view, so either reader grant admits the public tool here.
  const skillGrantNames =
    toolName === "read_file" ? ["read_file", "get_context"] : [toolName];
  if (
    skillAllowedTools &&
    !skillGrantNames.some((name) => skillAllowedTools.includes(name))
  ) {
    throw new ComposeScopeError(
      "authorization",
      `Tool '${toolName}' is not available under the active skill policy`,
      "tool_not_in_skill",
    );
  }
  return inline ? "inline" : "deferred";
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
    isComposable: isComposableOverride,
    createCallId = randomUUID,
    now = Date.now,
  } = options;
  const isComposable = (toolName: string): boolean =>
    COMPOSABLE_TOOLS.has(toolName) &&
    (isComposableOverride?.(toolName) ?? true);
  requireParentContext(parentContext);

  const canExecuteChild = (toolName: string): boolean => {
    try {
      resolveChildRoute(toolName, parentContext, isComposable);
      return true;
    } catch {
      return false;
    }
  };

  const preflightChild = (
    toolName: string,
    input: Record<string, unknown>,
  ): ComposeChildRoute => {
    const route = resolveChildRoute(toolName, parentContext, isComposable);
    assertComposableInput(toolName, input);
    assertRuntimeAdmission(toolName, input, runtime);
    if (toolName === "read_file") {
      // Reject a view outside the skill grant before reserving budget; the
      // runtime still enforces profile authority and option validity.
      const skillAllowedTools =
        parentContext.skillAuthority?.allowedTools ??
        parentContext.skillAllowedTools;
      const view = resolveReadFileView(
        input,
        getPermittedReadFileViews(
          (operation) =>
            !skillAllowedTools || skillAllowedTools.includes(operation),
        ),
      );
      if (!view.ok && view.status === "read_view_not_permitted") {
        throw new ComposeScopeError(
          "authorization",
          view.message,
          "tool_not_in_skill",
        );
      }
    }
    return route;
  };

  const reserveChildren = (count: number): void => {
    if (count === 0) return;
    const reservation = parentContext.toolCallBudget.tryReserve(count);
    if (!reservation.ok) {
      throw new ComposeScopeError(
        "budget_exhausted",
        `Tool call budget exhausted after ${reservation.snapshot.used} calls (limit ${reservation.snapshot.limit}); could not reserve ${count} compose child calls. Reduce, filter, paginate, or memoize inside the compose script.`,
      );
    }
  };

  // Children whose target is not parallel-safe (an MCP server without a
  // read-only or server-wide concurrency opt-in) run one at a time per lane.
  const serialLanes = new Map<string, Promise<void>>();
  const getSerialLane = (
    toolName: string,
    input: Record<string, unknown>,
  ): string | undefined =>
    toolName === "call_mcp_tool" && !runtime.isParallelSafe(toolName, input)
      ? `mcp:${mcpTarget(input).server}`
      : undefined;
  const runInLane = async <T>(
    lane: string | undefined,
    signal: AbortSignal,
    run: () => Promise<T>,
  ): Promise<T> => {
    if (!lane) return run();
    const previous = serialLanes.get(lane) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => held);
    serialLanes.set(lane, tail);
    try {
      await previous;
      if (signal.aborted) {
        throw new ComposeScopeError("aborted", "Compose execution was aborted");
      }
      return await run();
    } finally {
      release();
      if (serialLanes.get(lane) === tail) serialLanes.delete(lane);
    }
  };

  return {
    canExecuteChild,
    preflightChild(toolName, input) {
      preflightChild(toolName, input);
    },
    reserveChildren,
    async executeChild(toolName, input, callSignal, executionOptions) {
      if (parentContext.toolAbortSignal?.aborted || callSignal?.aborted) {
        throw new ComposeScopeError("aborted", "Compose execution was aborted");
      }
      const route = preflightChild(toolName, input);
      if (!executionOptions?.budgetReserved) reserveChildren(1);

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
        const {
          providerToolName: _parentProviderToolName,
          providerToolInput: _parentProviderToolInput,
          ...inheritedContext
        } = parentContext;
        const rawResult = await Promise.race([
          runInLane(
            getSerialLane(toolName, input),
            childController.signal,
            () =>
              runtime.executeTool({
                name: toolName,
                input,
                context: {
                  ...inheritedContext,
                  ...(route === "deferred"
                    ? {
                        providerToolName: "call_native_tool",
                        providerToolInput: { name: toolName, input },
                      }
                    : {}),
                  trackerCtx: trackerContext,
                  toolAbortSignal: childController.signal,
                  toolCallId: childCallId,
                  parentCallId: parentContext.toolCallId,
                  interactionPolicy: "deny",
                },
              }),
          ),
          forcePromise,
          abortPromise,
        ]);
        const result =
          toolName === "call_mcp_tool"
            ? canonicalizeMcpChildResult(rawResult)
            : rawResult;
        if (result.isError) throw childResultError(toolName, result);
        assertComposableOutputContent(toolName, result);
        if (!("data" in result)) {
          throw new ComposeScopeError(
            "canonical_result_required",
            `Tool '${toolName}' did not return canonical structured data`,
          );
        }
        if (toolName === "read_file" && typeof input.path === "string") {
          parentContext.onComposeFileRead?.(input.path);
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
                "child_handler_failed",
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
                  code: scopedError.code,
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
