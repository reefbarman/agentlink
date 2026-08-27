import { describe, expect, it, vi } from "vitest";

import type { HookProcessResult } from "./contracts";
import { HookRuntime } from "./HookRuntime";
import { parseHookSources } from "./hookConfig";

function configuration(hooks: Record<string, unknown>) {
  return parseHookSources([{ id: "test", content: JSON.stringify({ hooks }) }]);
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function processResult(stdout: string, exitCode = 0): HookProcessResult {
  return {
    exitCode,
    signal: null,
    stdout,
    stderr: exitCode === 2 ? "blocked" : "",
    timedOut: false,
    aborted: false,
    outputLimitExceeded: false,
    durationMs: 1,
  };
}

describe("HookRuntime", () => {
  it("runs matching synchronous handlers concurrently and returns declaration order", async () => {
    const releaseFirst = deferred<void>();
    const completed: string[] = [];
    const runtime = new HookRuntime({
      configuration: configuration({
        SessionStart: [
          {
            hooks: [
              { type: "command", command: "first" },
              { type: "command", command: "second" },
            ],
          },
        ],
      }),
      trust: () => true,
      processRunner: async ({ command }) => {
        if (command === "first") await releaseFirst.promise;
        else releaseFirst.resolve(undefined);
        completed.push(command);
        return processResult(
          JSON.stringify({
            hookSpecificOutput: { additionalContext: command },
          }),
        );
      },
    });

    const result = await runtime.sessionStart({ session_id: "s" });

    expect(completed).toEqual(["second", "first"]);
    expect(result.outputs.map((output) => output.stdout)).toEqual([
      JSON.stringify({ hookSpecificOutput: { additionalContext: "first" } }),
      JSON.stringify({ hookSpecificOutput: { additionalContext: "second" } }),
    ]);
    expect(result.additionalContext).toEqual(["first", "second"]);
  });

  it("uses the last completion for PreToolUse deny, rewrite, and context effects", async () => {
    const releaseFirst = deferred<void>();
    const runtime = new HookRuntime({
      configuration: configuration({
        PreToolUse: [
          {
            matcher: "Read",
            hooks: [
              { type: "command", command: "slow" },
              { type: "command", command: "fast" },
            ],
          },
        ],
      }),
      trust: () => true,
      processRunner: async ({ command }) => {
        if (command === "slow") {
          await releaseFirst.promise;
          return processResult(
            JSON.stringify({
              hookSpecificOutput: {
                permissionDecision: "deny",
                permissionDecisionReason: "late deny",
                updatedInput: { path: "rewritten" },
                additionalContext: "late context",
              },
            }),
          );
        }
        releaseFirst.resolve(undefined);
        return processResult(
          JSON.stringify({
            hookSpecificOutput: { permissionDecision: "allow" },
          }),
        );
      },
    });

    const result = await runtime.preToolUse({ tool_name: "Read" }, "Read");

    expect(result.preToolUse).toEqual({
      decision: "deny",
      reason: "late deny",
      updatedInput: { path: "rewritten" },
      additionalContext: "late context",
    });
    expect(result.outputs.map((output) => output.completionIndex)).toEqual([
      1, 0,
    ]);
  });

  it("collects PostToolUse feedback/context and Stop continuation semantics", async () => {
    const runner = vi
      .fn()
      .mockResolvedValueOnce(
        processResult(
          JSON.stringify({
            hookSpecificOutput: {
              feedback: "watch this",
              additionalContext: "remember this",
            },
          }),
        ),
      )
      .mockResolvedValueOnce(
        processResult(
          JSON.stringify({ decision: "block", reason: "continue" }),
        ),
      )
      .mockResolvedValueOnce(
        processResult(JSON.stringify({ continue: false, reason: "done" })),
      );
    const runtime = new HookRuntime({
      configuration: configuration({
        PostToolUse: [{ hooks: [{ type: "command", command: "post" }] }],
        Stop: [
          {
            hooks: [
              { type: "command", command: "continue" },
              { type: "command", command: "end" },
            ],
          },
        ],
      }),
      trust: () => true,
      processRunner: runner,
    });

    const post = await runtime.postToolUse({}, "Read");
    const stop = await runtime.stop({});

    expect(post.feedback).toEqual(["watch this"]);
    expect(post.additionalContext).toEqual(["remember this"]);
    expect(stop.stop).toEqual({ continue: false, reason: "done" });
  });

  it("limits async handlers to eight, gives them no control effects, and forces SessionEnd sync", async () => {
    const releases = Array.from({ length: 10 }, () => deferred<void>());
    let active = 0;
    let peak = 0;
    const asyncOutput = vi.fn();
    const runtime = new HookRuntime({
      configuration: configuration({
        SessionStart: [
          {
            hooks: Array.from({ length: 10 }, (_, index) => ({
              type: "command",
              command: String(index),
              async: true,
            })),
          },
        ],
        SessionEnd: [
          { hooks: [{ type: "command", command: "end", async: true }] },
        ],
      }),
      trust: () => true,
      onAsyncOutput: asyncOutput,
      processRunner: async ({ command }) => {
        if (command === "end") return processResult("finished");
        active += 1;
        peak = Math.max(peak, active);
        await releases[Number(command)]?.promise;
        active -= 1;
        return processResult(JSON.stringify({ continue: false }));
      },
    });

    const start = await runtime.sessionStart({});
    await vi.waitFor(() => expect(peak).toBe(8));
    releases.forEach((release) => release.resolve(undefined));
    await vi.waitFor(() => expect(asyncOutput).toHaveBeenCalledTimes(10));
    const end = await runtime.sessionEnd({});

    expect(start.asyncScheduled).toBe(10);
    expect(start.stop).toBeUndefined();
    expect(peak).toBe(8);
    expect(end.asyncScheduled).toBe(0);
    expect(end.outputs).toHaveLength(1);
  });

  it("applies prompt blocking but fails open on unsupported compact exit-two control", async () => {
    const runtime = new HookRuntime({
      configuration: configuration({
        UserPromptSubmit: [{ hooks: [{ type: "command", command: "prompt" }] }],
        PreCompact: [{ hooks: [{ type: "command", command: "compact" }] }],
      }),
      trust: () => true,
      processRunner: async ({ command }) =>
        command === "prompt"
          ? processResult(
              JSON.stringify({ decision: "block", reason: "no prompt" }),
            )
          : processResult("", 2),
    });

    await expect(runtime.userPromptSubmit({})).resolves.toEqual(
      expect.objectContaining({
        block: { blocked: true, reason: "no prompt" },
      }),
    );
    const compact = await runtime.preCompact({ trigger: "auto" });
    expect(compact).not.toHaveProperty("block");
    expect(compact.diagnostics).toEqual([
      expect.objectContaining({ code: "hook_handler_nonzero_exit" }),
    ]);
  });

  it("matches lifecycle values and compatibility aliases once per handler", async () => {
    const commands: string[] = [];
    const runner = vi.fn(async (request: { command: string }) => {
      commands.push(request.command);
      return processResult("");
    });
    const runtime = new HookRuntime({
      configuration: configuration({
        SessionStart: [
          {
            matcher: "resume",
            hooks: [{ type: "command", command: "resume" }],
          },
        ],
        PreToolUse: [
          {
            matcher: "apply_patch|Edit|Write",
            hooks: [{ type: "command", command: "edit" }],
          },
        ],
      }),
      trust: () => true,
      processRunner: runner,
    });

    await runtime.sessionStart({ source: "startup" });
    await runtime.sessionStart({ source: "resume" });
    await runtime.preToolUse({}, "apply_diff", undefined, [
      "apply_patch",
      "Edit",
      "Write",
    ]);

    expect(runner).toHaveBeenCalledTimes(2);
    expect(commands).toEqual(["resume", "edit"]);
  });

  it("fails open on trust and runner errors while reporting diagnostics", async () => {
    const onDiagnostic = vi.fn();
    const trust = vi
      .fn()
      .mockRejectedValueOnce(new Error("trust unavailable"))
      .mockResolvedValue(true);
    const runtime = new HookRuntime({
      configuration: configuration({
        Interrupt: [
          {
            matcher: "ignored",
            hooks: [
              { type: "command", command: "one" },
              { type: "command", command: "two" },
            ],
          },
        ],
      }),
      trust,
      processRunner: async () => {
        throw new Error("spawn failed");
      },
      onDiagnostic,
    });

    const result = await runtime.interrupt({});

    expect(result.outputs).toEqual([]);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "hook_trust_failed",
      "hook_handler_failed",
    ]);
    expect(onDiagnostic).toHaveBeenCalledTimes(2);
    expect(trust.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        sourceReviewed: false,
        key: expect.any(String),
        hash: expect.any(String),
      }),
    );
  });
});
