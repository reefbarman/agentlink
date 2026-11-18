/**
 * Live first-turn routing eval. Not part of `npm test`; run with
 * `npm run eval:routing` (see vitest.eval.config.mts).
 *
 * Builds AgentLink's real system prompt and inline tool catalog for this
 * repository, sends each golden task to the configured model, and grades the
 * first response's tool calls. Tools are never executed. Environment
 * variables are documented in ./evalModelClient.ts.
 *
 * When a reply contains only todo_write calls, the eval answers them with a
 * stub result and also grades the next reply: single-call models cannot open
 * the TODO list the prompt asks for and act in the same reply. Any Codex
 * Responses Lite request is single-call: the backend rejects
 * parallel_tool_calls=true with HTTP 400 (checked 2026-11-18). AgentLink now
 * sends gpt-6.x sol/astra on full Responses, so they are no longer affected.
 */
import { describe, expect, it } from "vitest";
import {
  evalConfig,
  evalPromptProfile,
  startEvalConversation,
  writeEvalReport,
} from "./evalModelClient.js";
import {
  GOLDEN_TASKS,
  gradeGoldenTask,
  isTodoOnlyReply,
  todoStubResult,
  type GoldenTask,
  type GoldenTaskGrade,
  type ObservedToolCall,
} from "./goldenTasks.js";

const { configured, runs, minPassRate, selectedIds, model } = evalConfig;

interface RunResult extends GoldenTaskGrade {
  taskId: string;
  run: number;
  text: string;
  /** First-response tool calls with inputs, for diagnosing failures. */
  calls: ObservedToolCall[];
  /** The first reply was only todo_write, so the next reply was graded too. */
  followUp?: boolean;
  durationMs: number;
  error?: string;
}

async function runTask(task: GoldenTask, run: number): Promise<RunResult> {
  const startedAt = Date.now();
  const base = { taskId: task.id, run, text: "", calls: [] };
  try {
    const first = await startEvalConversation(task.mode, [
      { role: "user", content: task.prompt },
    ]);
    // A reply that only opens the TODO list is following the prompt; grade
    // the first real action, which single-call models can't put in the same
    // reply.
    const followUp = isTodoOnlyReply(first.calls)
      ? await first.answer(
          first.calls.map((call) => todoStubResult(call.input)),
        )
      : undefined;
    const calls = [...first.calls, ...(followUp?.calls ?? [])];
    return {
      ...base,
      ...gradeGoldenTask(task, calls),
      calls,
      followUp: followUp !== undefined,
      text: [first.text, followUp?.text]
        .filter(Boolean)
        .join("\n")
        .slice(0, 300),
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      ...base,
      pass: false,
      tools: [],
      reasons: ["request failed"],
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

describe.skipIf(!configured)("first-turn routing eval", () => {
  it(
    "routes golden tasks to the expected tools",
    async () => {
      const tasks = GOLDEN_TASKS.filter(
        (task) => !selectedIds || selectedIds.includes(task.id),
      );
      const results = await Promise.all(
        tasks.flatMap((task) =>
          Array.from({ length: runs }, (_, run) => runTask(task, run + 1)),
        ),
      );

      const rows = tasks.map((task) => {
        const taskResults = results.filter((r) => r.taskId === task.id);
        const passed = taskResults.filter((r) => r.pass).length;
        return {
          task: task.id,
          pass: `${passed}/${taskResults.length}`,
          tools: taskResults.map((r) => r.tools.join("+") || "-").join(" | "),
          failures: [
            ...new Set(
              taskResults.flatMap((r) => (r.error ? [r.error] : r.reasons)),
            ),
          ].join("; "),
        };
      });
      console.table(rows);

      const passRate =
        results.filter((r) => r.pass).length / Math.max(1, results.length);
      const reportPath = await writeEvalReport("routing", {
        followUps: results.filter((r) => r.followUp).length,
        passRate,
        rows,
        results,
      });
      console.log(
        `Routing pass rate ${(passRate * 100).toFixed(1)}% (${model}, ${evalPromptProfile()} prompt); report: ${reportPath}`,
      );

      expect(passRate).toBeGreaterThanOrEqual(minPassRate);
    },
    10 * 60_000,
  );
});
