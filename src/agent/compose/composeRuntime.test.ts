import {
  COMPOSE_MAX_BATCH_SIZE,
  COMPOSE_MAX_CHILD_BYTES,
  COMPOSE_MAX_CHILD_CALLS,
  COMPOSE_MAX_CONCURRENCY,
  COMPOSE_MAX_CUMULATIVE_CHILD_BYTES,
  COMPOSE_MAX_FINAL_BYTES,
  COMPOSE_MAX_RECOVERY_PREVIEW_BYTES,
  COMPOSE_MAX_SCRIPT_BYTES,
  COMPOSE_MAX_TRACE_BYTES,
  COMPOSE_MEMORY_LIMIT_BYTES,
  COMPOSE_TIMEOUT_MS,
  handleCompose,
} from "./composeRuntime.js";
import { describe, expect, it, vi } from "vitest";

import type { ComposeExecutionScope } from "./composeScope.js";
import type { ToolResult } from "../../shared/types.js";

const wasmPath =
  require.resolve("@jitl/quickjs-wasmfile-release-asyncify/wasm");

function success(data: unknown): ToolResult {
  return {
    data,
    content: [{ type: "text", text: JSON.stringify(data) }],
    isError: false,
  };
}

function fakeScope(
  execute: (
    name: string,
    input: Record<string, unknown>,
  ) => Promise<ToolResult> | ToolResult = (name, input) =>
    success({ name, input }),
  canExecute: (name: string) => boolean = () => true,
): ComposeExecutionScope {
  return {
    canExecuteChild: canExecute,
    executeChild: async (name, input) => execute(name, input),
  };
}

async function run(
  script: string,
  scope = fakeScope(),
  signal = new AbortController().signal,
) {
  return handleCompose({
    params: { script, description: "focused test" },
    scope,
    signal,
    wasmPath,
  });
}

function errorKind(
  result: Awaited<ReturnType<typeof run>>,
): string | undefined {
  return result.error?.kind;
}

describe("compose runtime", () => {
  it("exports the plan's named hard limits", () => {
    expect({
      childCalls: COMPOSE_MAX_CHILD_CALLS,
      batchSize: COMPOSE_MAX_BATCH_SIZE,
      concurrency: COMPOSE_MAX_CONCURRENCY,
      memory: COMPOSE_MEMORY_LIMIT_BYTES,
      timeout: COMPOSE_TIMEOUT_MS,
      script: COMPOSE_MAX_SCRIPT_BYTES,
      child: COMPOSE_MAX_CHILD_BYTES,
      cumulative: COMPOSE_MAX_CUMULATIVE_CHILD_BYTES,
      final: COMPOSE_MAX_FINAL_BYTES,
      trace: COMPOSE_MAX_TRACE_BYTES,
    }).toEqual({
      childCalls: 64,
      batchSize: 16,
      concurrency: 4,
      memory: 32 * 1024 * 1024,
      timeout: 60_000,
      script: 64 * 1024,
      child: 1024 * 1024,
      cumulative: 8 * 1024 * 1024,
      final: 40 * 1024,
      trace: 32 * 1024,
    });
  });

  it("loads the supplied local WASM and supports top-level return", async () => {
    const result = await run('return { value: 42, text: "ok" };');

    expect(result.isError).toBe(false);
    expect(result.data).toEqual({ value: 42, text: "ok" });
    expect(result.uiMeta.composeTrace).toEqual({
      description: "focused test",
      status: "completed",
      children: [],
      totalChildren: 0,
      completedChildren: 0,
      toolAllBatchCount: 0,
      bridgedBytes: 0,
    });
  });

  it("runs dependent tool calls sequentially and returns canonical child data", async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const scope = fakeScope((name, input) => {
      calls.push([name, input]);
      return success({ value: Number(input.value) + 1 });
    });

    const result = await run(
      `const first = tool("increment", { value: 1 });
       const second = tool("increment", { value: first.value });
       return second;`,
      scope,
    );

    expect(result.data).toEqual({ value: 3 });
    expect(calls).toEqual([
      ["increment", { value: 1 }],
      ["increment", { value: 2 }],
    ]);
    expect(result.uiMeta.composeTrace.children).toHaveLength(2);
    expect(result.uiMeta.composeTrace.bridgedBytes).toBe(
      Buffer.byteLength('{"value":2}') + Buffer.byteLength('{"value":3}'),
    );
    expect(result.uiMeta.composeTrace.toolAllBatchCount).toBe(0);
    expect(result.uiMeta.composeTrace.children[0]).toMatchObject({
      id: "compose-child-1",
      name: "increment",
      status: "completed",
    });
  });

  it("runs toolAll with concurrency four and preserves descriptor order", async () => {
    let active = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const scope = fakeScope(async (_name, input) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return success(input.index);
    });
    const pending = run(
      `return toolAll(Array.from({ length: 6 }, (_, index) => ({
        name: "item",
        input: { index },
      })));`,
      scope,
    );

    await vi.waitFor(() => expect(releases).toHaveLength(4));
    releases.splice(0, 4).forEach((release) => release());
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases.splice(0, 2).forEach((release) => release());

    const result = await pending;
    expect(result.data).toEqual([0, 1, 2, 3, 4, 5]);
    expect(peak).toBe(COMPOSE_MAX_CONCURRENCY);
    expect(result.uiMeta.composeTrace.toolAllBatchCount).toBe(1);
    expect(result.uiMeta.composeTrace.bridgedBytes).toBe(6);
  });

  it("supports an empty toolAll batch without child dispatch", async () => {
    const execute = vi.fn(() => success(null));
    const result = await run("return toolAll([]);", fakeScope(execute));

    expect(result.data).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
    expect(result.uiMeta.composeTrace.toolAllBatchCount).toBe(1);
    expect(result.uiMeta.composeTrace.bridgedBytes).toBe(0);
  });

  it.each([
    ["missing descriptors", "return toolAll();", "validation"],
    [
      "malformed descriptor",
      'return toolAll([{ name: "read" }]);',
      "validation",
    ],
    [
      "batch overflow",
      `return toolAll(Array.from({ length: ${COMPOSE_MAX_BATCH_SIZE + 1} }, () => ({ name: "read", input: {} })));`,
      "validation",
    ],
  ])("rejects %s", async (_name, script, kind) => {
    const result = await run(script);

    expect(result.isError).toBe(true);
    expect(errorKind(result)).toBe(kind);
    expect(result.uiMeta.composeTrace.errorKind).toBe(kind);
    expect(result.uiMeta.composeTrace.toolAllBatchCount).toBe(1);
  });

  it("rejects child-call overflow before dispatching the over-limit child", async () => {
    const execute = vi.fn(() => success(null));
    const result = await run(
      `for (let index = 0; index <= ${COMPOSE_MAX_CHILD_CALLS}; index += 1) tool("read", { index });
       return null;`,
      fakeScope(execute),
    );

    expect(errorKind(result)).toBe("budget_exhausted");
    expect(execute).toHaveBeenCalledTimes(COMPOSE_MAX_CHILD_CALLS);
  });

  it("fails closed when the frozen scope denies a tool", async () => {
    const execute = vi.fn(() => success(null));
    const result = await run(
      'return tool("write_file", { path: "x" });',
      fakeScope(execute, () => false),
    );

    expect(errorKind(result)).toBe("policy");
    expect(execute).not.toHaveBeenCalled();
  });

  it("classifies canonical child failures and includes bounded trace metadata", async () => {
    const result = await run(
      'return tool("read", { path: "secret" });',
      fakeScope(() => ({
        data: { error: "denied" },
        content: [{ type: "text", text: "denied" }],
        isError: true,
        error: { kind: "path_denied", message: "Path denied by policy" },
      })),
    );

    expect(errorKind(result)).toBe("child_failed");
    expect(result.uiMeta.composeTrace.errorKind).toBe("child_failed");
    expect(result.uiMeta.composeTrace.bridgedBytes).toBe(0);
    expect(result.uiMeta.composeTrace.children).toEqual([
      expect.objectContaining({
        id: "compose-child-1",
        name: "read",
        status: "error",
        inputSummary: '{"path":"secret"}',
        errorSummary: "child_failed: Path denied by policy",
      }),
    ]);
  });

  it("rejects oversized per-child canonical data", async () => {
    const result = await run(
      'return tool("large", {});',
      fakeScope(() => success("x".repeat(COMPOSE_MAX_CHILD_BYTES))),
    );

    expect(errorKind(result)).toBe("serialization");
    expect(result.error?.message).toContain("per child");
  });

  it("rejects cumulative canonical child data overflow", async () => {
    const chunk = "x".repeat(950 * 1024);
    const result = await run(
      `for (let index = 0; index < 9; index += 1) tool("large", { index });
       return null;`,
      fakeScope(() => success(chunk)),
    );

    expect(errorKind(result)).toBe("serialization");
    expect(result.error?.message).toContain("cumulative limit");
  });

  it("returns bounded recovery evidence for oversized final data", async () => {
    const result = await run(
      `const value = tool("large", {});
       return { value, duplicate: value };`,
      fakeScope(() => success("x".repeat(COMPOSE_MAX_FINAL_BYTES / 2))),
    );

    expect(errorKind(result)).toBe("serialization");
    expect(result.error?.message).toContain("aggregate inside the script");
    expect(result.uiMeta.composeTrace).toMatchObject({
      status: "error",
      errorKind: "serialization",
      totalChildren: 1,
      completedChildren: 1,
    });
    const data = result.data as {
      recovery: {
        reason: string;
        actual_bytes: number;
        limit_bytes: number;
        preview: string;
        preview_bytes: number;
        preview_truncated: boolean;
        children: Array<{ name: string; status: string }>;
      };
    };
    expect(data.recovery).toMatchObject({
      reason: "final_result_too_large",
      limit_bytes: COMPOSE_MAX_FINAL_BYTES,
      preview_truncated: true,
      children: [{ name: "large", status: "completed" }],
    });
    expect(data.recovery.actual_bytes).toBeGreaterThan(COMPOSE_MAX_FINAL_BYTES);
    expect(data.recovery.preview_bytes).toBeLessThanOrEqual(
      COMPOSE_MAX_RECOVERY_PREVIEW_BYTES,
    );
    expect(Buffer.byteLength(data.recovery.preview)).toBe(
      data.recovery.preview_bytes,
    );
  });

  it("keeps oversized recovery previews on Unicode code-point boundaries", async () => {
    const result = await run(
      `return "x".repeat(8188) + "😀" + "y".repeat(${COMPOSE_MAX_FINAL_BYTES});`,
    );

    const recovery = (result.data as { recovery: { preview: string } })
      .recovery;
    const trailingCodeUnit = recovery.preview.charCodeAt(
      recovery.preview.length - 1,
    );
    expect(trailingCodeUnit).not.toBeGreaterThanOrEqual(0xd800);
    expect(Buffer.byteLength(recovery.preview)).toBeLessThanOrEqual(
      COMPOSE_MAX_RECOVERY_PREVIEW_BYTES,
    );
    expect(recovery.preview.endsWith("x")).toBe(true);
  });

  it.each([
    ["undefined", "return undefined;"],
    ["bigint", "return 1n;"],
    ["function", "return () => 1;"],
    ["non-finite number", "return Infinity;"],
    ["cyclic data", "const value = {}; value.self = value; return value;"],
  ])("rejects unsupported final %s", async (_name, script) => {
    const result = await run(script);

    expect(errorKind(result)).toBe("serialization");
    expect(result.error?.message.toLowerCase()).toContain(
      _name === "undefined" ? "unsupported undefined" : _name,
    );
  });

  it.each([
    ["eval", 'return typeof eval === "undefined";'],
    ["Function", 'return typeof Function === "undefined";'],
    ["module", 'return typeof module === "undefined";'],
    ["require", 'return typeof require === "undefined";'],
  ])("denies %s access", async (_name, script) => {
    const result = await run(script);

    expect(result.isError).toBe(false);
    expect(result.data).toBe(true);
  });

  it.each([
    ["ordinary", "return (function () {}).constructor;"],
    ["generator", "return (function* () {}).constructor;"],
    ["async", "return (async function () {}).constructor;"],
  ])("denies %s constructor access", async (_name, script) => {
    const result = await run(script);

    expect(errorKind(result)).toBe("policy");
    expect(result.error?.message).toContain("constructors");
  });

  it("rejects import syntax and preserves useful script diagnostics", async () => {
    const result = await run('import value from "blocked"; return value;');

    expect(errorKind(result)).toBe("script_error");
    expect(result.error?.message).toMatch(/SyntaxError|import/u);
    expect((result.data as { stack?: string }).stack).toContain(
      "compose-script.js",
    );
  });

  it("interrupts an infinite loop at the wall deadline", async () => {
    let calls = 0;
    const dateNow = vi
      .spyOn(Date, "now")
      .mockImplementation(() => (calls++ === 0 ? 0 : COMPOSE_TIMEOUT_MS + 1));
    try {
      const result = await run("while (true) {}", fakeScope());
      expect(errorKind(result)).toBe("timeout");
    } finally {
      dateNow.mockRestore();
    }
  });

  it("returns an aborted error before runtime creation", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await run("return 1;", fakeScope(), controller.signal);

    expect(errorKind(result)).toBe("aborted");
  });

  it("aborts while suspended in a child and ignores its late result", async () => {
    const controller = new AbortController();
    let release!: (result: ToolResult) => void;
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const child = new Promise<ToolResult>((resolve) => {
      release = resolve;
    });
    const scope = fakeScope(() => {
      resolveStarted();
      return child;
    });
    const pending = run('return tool("slow", {});', scope, controller.signal);

    await started;
    controller.abort();
    const result = await pending;
    release(success({ late: true }));

    expect(errorKind(result)).toBe("aborted");
    expect(result.uiMeta.composeTrace.children[0]?.status).toBe("cancelled");
  });

  it("stops scheduling a toolAll batch after its first failure", async () => {
    let calls = 0;
    const result = await run(
      `return toolAll(Array.from({ length: 10 }, (_, index) => ({
        name: "item",
        input: { index },
      })));`,
      fakeScope(async (_name, input) => {
        calls += 1;
        if (input.index === 0) throw new Error("first failed");
        await new Promise((resolve) => setTimeout(resolve, 10));
        return success(input.index);
      }),
    );

    expect(errorKind(result)).toBe("internal");
    expect(calls).toBeLessThanOrEqual(COMPOSE_MAX_CONCURRENCY);
  });

  it("allows guest recovery after a toolAll batch failure", async () => {
    const calls: string[] = [];
    const result = await run(
      `try {
         toolAll([
           { name: "fail", input: {} },
           { name: "cancelled", input: {} },
         ]);
       } catch {}
       return tool("recover", {});`,
      fakeScope(async (name) => {
        calls.push(name);
        if (name === "fail") throw new Error("batch failed");
        if (name === "cancelled") {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        return success({ name });
      }),
    );

    expect(result.isError).toBe(false);
    expect(result.data).toEqual({ name: "recover" });
    expect(calls).toContain("recover");
    expect(result.uiMeta.composeTrace.children).toHaveLength(3);
    expect(result.uiMeta.composeTrace.children.at(-1)).toMatchObject({
      name: "recover",
      status: "completed",
    });
  });

  it("bounds persisted trace bytes without retaining child payloads", async () => {
    const result = await run(
      `for (let index = 0; index < ${COMPOSE_MAX_CHILD_CALLS}; index += 1) {
         tool("read", { index, path: "x".repeat(500) });
       }
       return "done";`,
      fakeScope(() => success({ payload: "secret child payload" })),
    );
    const serialized = JSON.stringify(result.uiMeta.composeTrace);

    expect(result.data).toBe("done");
    expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(
      COMPOSE_MAX_TRACE_BYTES,
    );
    expect(serialized).not.toContain("secret child payload");
  });

  it("validates script and description byte limits before dispatch", async () => {
    const execute = vi.fn(() => success(null));
    const scope = fakeScope(execute);
    const scriptResult = await run(
      "x".repeat(COMPOSE_MAX_SCRIPT_BYTES + 1),
      scope,
    );
    const descriptionResult = await handleCompose({
      params: { script: "return null;", description: "two\nlines" },
      scope,
      signal: new AbortController().signal,
      wasmPath,
    });

    expect(errorKind(scriptResult)).toBe("validation");
    expect(errorKind(descriptionResult)).toBe("validation");
    expect(execute).not.toHaveBeenCalled();
  });
});
