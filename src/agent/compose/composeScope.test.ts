import type {
  AgentToolCallTracker,
  AgentToolExecutionContext,
  AgentToolRuntime,
} from "../../core/tools/types.js";
import { describe, expect, it, vi } from "vitest";

import { ToolCallBudget } from "../../core/tools/toolCallBudget.js";
import type { ToolResult } from "../../shared/types.js";
import { createComposeExecutionScope } from "./composeScope.js";
import { createNativeToolDisclosureSnapshot } from "../../core/tools/nativeToolDisclosure.js";

function canonicalResult(data: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
    data,
    isError: false,
  };
}

function makeHarness(
  options: {
    available?: string[];
    limit?: number;
    execute?: AgentToolRuntime["executeTool"];
    composable?: string[];
    context?: Partial<AgentToolExecutionContext>;
  } = {},
) {
  const events: Array<Record<string, unknown>> = [];
  const completeAgentCall = vi.fn();
  const registerAgentCall = vi.fn(
    (...args: Parameters<AgentToolCallTracker["registerAgentCall"]>) => ({
      toolCallId: args[0],
    }),
  );
  const executeTool = vi.fn(
    options.execute ?? (async () => canonicalResult({ ok: true })),
  );
  const runtime: AgentToolRuntime = {
    listTools: () => [],
    isParallelSafe: () => true,
    executeTool,
    getToolCallTracker: () => ({ registerAgentCall, completeAgentCall }),
  };
  const context: AgentToolExecutionContext = {
    sessionId: "session-1",
    mode: "code",
    availableToolNames: new Set(options.available ?? ["read_file", "compose"]),
    toolCallBudget: new ToolCallBudget(options.limit ?? 4),
    toolCallId: "compose-parent",
    onNestedToolStart: (event) => events.push({ phase: "start", ...event }),
    onNestedToolComplete: (event) =>
      events.push({ phase: "complete", ...event }),
    ...options.context,
  };
  const composable = new Set(options.composable ?? ["read_file"]);
  const scope = createComposeExecutionScope({
    runtime,
    parentContext: context,
    isComposable: (name) => composable.has(name),
    createCallId: () => "child-1",
    now: (() => {
      let value = 100;
      return () => value++;
    })(),
  });
  return {
    scope,
    context,
    executeTool,
    registerAgentCall,
    completeAgentCall,
    events,
  };
}

describe("createComposeExecutionScope", () => {
  it("dispatches an admitted child through the runtime with frozen authority", async () => {
    const harness = makeHarness();

    await expect(
      harness.scope.executeChild("read_file", { path: "src/index.ts" }),
    ).resolves.toMatchObject({ data: { ok: true }, isError: false });

    expect(harness.context.toolCallBudget?.snapshot()).toEqual({
      limit: 4,
      used: 1,
      remaining: 3,
    });
    expect(harness.registerAgentCall).toHaveBeenCalledWith(
      "compose-parent:child:child-1",
      "read_file",
      "",
      "session-1",
      expect.any(Function),
      JSON.stringify({ path: "src/index.ts" }, null, 2),
      "compose-parent",
    );
    expect(harness.executeTool).toHaveBeenCalledWith({
      name: "read_file",
      input: { path: "src/index.ts" },
      context: expect.objectContaining({
        toolCallId: "compose-parent:child:child-1",
        parentCallId: "compose-parent",
        interactionPolicy: "deny",
      }),
    });
    const childContext = harness.executeTool.mock.calls[0]![0].context;
    expect(childContext).not.toHaveProperty("providerToolName");
    expect(childContext).not.toHaveProperty("providerToolInput");
    expect(harness.events).toEqual([
      expect.objectContaining({
        phase: "start",
        parentCallId: "compose-parent",
        toolName: "read_file",
      }),
      expect.objectContaining({
        phase: "complete",
        durationMs: 1,
        parentCallId: "compose-parent",
        toolName: "read_file",
      }),
    ]);
    expect(harness.completeAgentCall).toHaveBeenCalledWith(
      "compose-parent:child:child-1",
    );
  });

  it("dispatches a deferred child with child-owned bridge identity", async () => {
    const nativeToolDisclosure = createNativeToolDisclosureSnapshot([
      {
        name: "get_diagnostics",
        description: "Get diagnostics",
        input_schema: { type: "object", properties: {} },
      },
    ]);
    const inheritedCallback = vi.fn();
    const skillAuthority = Object.freeze({
      schemaVersion: 1 as const,
      sources: Object.freeze([]),
      allowedTools: Object.freeze(["get_diagnostics"]),
    });
    const harness = makeHarness({
      available: ["call_native_tool", "compose"],
      composable: ["get_diagnostics"],
      context: {
        modeAllowedToolNames: new Set(["get_diagnostics"]),
        nativeToolDisclosure,
        providerToolName: "call_native_tool",
        providerToolInput: { name: "compose", input: { script: "..." } },
        skillAuthority,
        getSessionTranscript: inheritedCallback,
      },
    });

    expect(harness.scope.canExecuteChild("get_diagnostics")).toBe(true);
    await harness.scope.executeChild("get_diagnostics", { path: "src" });

    expect(harness.executeTool).toHaveBeenCalledOnce();
    const request = harness.executeTool.mock.calls[0]![0];
    expect(request).toMatchObject({
      name: "get_diagnostics",
      input: { path: "src" },
      context: {
        providerToolName: "call_native_tool",
        providerToolInput: {
          name: "get_diagnostics",
          input: { path: "src" },
        },
        interactionPolicy: "deny",
      },
    });
    expect(request.context.skillAuthority).toBe(skillAuthority);
    expect(request.context.getSessionTranscript).toBe(inheritedCallback);
    expect(request.context.toolCallBudget).toBe(harness.context.toolCallBudget);
    expect(request.context.nativeToolDisclosure).toBe(nativeToolDisclosure);
  });

  it("strips a deferred parent identity from an inline child", async () => {
    const harness = makeHarness({
      context: {
        providerToolName: "call_native_tool",
        providerToolInput: { name: "compose", input: { script: "..." } },
      },
    });

    await harness.scope.executeChild("read_file", { path: "src/index.ts" });

    const childContext = harness.executeTool.mock.calls[0]![0].context;
    expect(childContext).not.toHaveProperty("providerToolName");
    expect(childContext).not.toHaveProperty("providerToolInput");
  });

  it("rejects hidden, non-composable, and recursive tools before reservation", async () => {
    const harness = makeHarness({
      available: ["read_file", "compose", "open_file"],
    });

    await expect(
      harness.scope.executeChild("write_file", { path: "x" }),
    ).rejects.toMatchObject({
      kind: "authorization",
      code: "tool_not_in_request",
    });
    await expect(
      harness.scope.executeChild("open_file", { path: "x" }),
    ).rejects.toMatchObject({
      kind: "tool_not_composable",
    });
    await expect(
      harness.scope.executeChild("compose", { script: "return 1" }),
    ).rejects.toMatchObject({
      kind: "recursive_compose",
    });

    expect(harness.context.toolCallBudget?.snapshot().used).toBe(0);
    expect(harness.executeTool).not.toHaveBeenCalled();
    expect(harness.registerAgentCall).not.toHaveBeenCalled();
  });

  it("rejects forged and mode-denied deferred children before reservation", async () => {
    const nativeToolDisclosure = createNativeToolDisclosureSnapshot([
      {
        name: "get_diagnostics",
        description: "Get diagnostics",
        input_schema: { type: "object", properties: {} },
      },
    ]);
    const harness = makeHarness({
      available: ["call_native_tool", "compose"],
      composable: ["get_diagnostics", "get_hover"],
      context: {
        mode: "ask",
        modeAllowedToolNames: new Set(["read_file"]),
        nativeToolDisclosure,
      },
    });

    expect(harness.scope.canExecuteChild("get_hover")).toBe(false);
    await expect(
      harness.scope.executeChild("get_hover", { path: "x" }),
    ).rejects.toMatchObject({
      kind: "authorization",
      code: "tool_not_in_request",
    });
    await expect(
      harness.scope.executeChild("get_diagnostics", { path: "x" }),
    ).rejects.toMatchObject({
      kind: "authorization",
      code: "tool_not_in_mode",
    });
    expect(harness.context.toolCallBudget?.snapshot().used).toBe(0);
    expect(harness.executeTool).not.toHaveBeenCalled();
    expect(harness.registerAgentCall).not.toHaveBeenCalled();
  });

  it("preserves structured authorization and handler failure codes", async () => {
    for (const [result, expected] of [
      [
        {
          ...canonicalResult({
            status: "rejected",
            reason: "interaction_denied",
          }),
          isError: true,
          error: { kind: "rejected", message: "Path denied" },
        },
        { kind: "authorization", code: "interaction_denied" },
      ],
      [
        {
          ...canonicalResult({ status: "error" }),
          isError: true,
          error: { kind: "handler_error", message: "Missing file" },
        },
        {
          kind: "child_handler_failed",
          code: "child_handler_failed",
        },
      ],
    ] as const) {
      const harness = makeHarness({ execute: async () => result });
      await expect(
        harness.scope.executeChild("read_file", { path: "x" }),
      ).rejects.toMatchObject(expected);
    }
  });

  it("rejects semantic variants before reservation or dispatch", async () => {
    for (const [toolName, input] of [
      ["list_files", { path: ".", query: "authentication" }],
      ["search_files", { path: ".", regex: "auth", semantic: true }],
    ] as const) {
      const harness = makeHarness({ available: [toolName, "compose"] });
      const scope = createComposeExecutionScope({
        runtime: {
          listTools: () => [],
          isParallelSafe: () => true,
          executeTool: harness.executeTool,
          getToolCallTracker: () => ({
            registerAgentCall: harness.registerAgentCall,
            completeAgentCall: harness.completeAgentCall,
          }),
        },
        parentContext: harness.context,
        isComposable: (name) => name === toolName,
      });

      await expect(scope.executeChild(toolName, input)).rejects.toMatchObject({
        kind: "tool_input_not_composable",
      });
      expect(harness.context.toolCallBudget?.snapshot().used).toBe(0);
      expect(harness.executeTool).not.toHaveBeenCalled();
      expect(harness.registerAgentCall).not.toHaveBeenCalled();
    }
  });

  it("rejects exhausted budget before tracker registration or dispatch", async () => {
    const harness = makeHarness({ limit: 1 });
    harness.context.toolCallBudget?.tryReserve();

    await expect(
      harness.scope.executeChild("read_file", { path: "x" }),
    ).rejects.toMatchObject({
      kind: "budget_exhausted",
    });
    expect(harness.executeTool).not.toHaveBeenCalled();
    expect(harness.registerAgentCall).not.toHaveBeenCalled();
  });

  it("rejects a legacy result without canonical data", async () => {
    const harness = makeHarness({
      execute: async () => ({ content: [{ type: "text", text: "legacy" }] }),
    });

    await expect(
      harness.scope.executeChild("read_file", { path: "x" }),
    ).rejects.toMatchObject({
      kind: "canonical_result_required",
    });
    expect(harness.events.at(-1)).toMatchObject({
      phase: "complete",
      result: {
        isError: true,
        error: { kind: "canonical_result_required" },
      },
    });
  });

  it("aborts even when a child ignores its abort signal", async () => {
    const controller = new AbortController();
    const harness = makeHarness({
      execute: async () => new Promise<ToolResult>(() => undefined),
    });
    harness.context.toolAbortSignal = controller.signal;

    const execution = harness.scope.executeChild("read_file", { path: "x" });
    controller.abort();

    await expect(execution).rejects.toMatchObject({
      kind: "aborted",
    });
    expect(harness.completeAgentCall).toHaveBeenCalledTimes(1);
    expect(harness.events.at(-1)).toMatchObject({
      phase: "complete",
      result: { isError: true, error: { kind: "aborted" } },
    });
  });
});
