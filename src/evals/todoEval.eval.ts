/**
 * Live TODO decision-point eval. Not part of `npm test`; run with
 * `npm run eval:todos` (see vitest.eval.config.mts and ./todoTasks.ts for the
 * target policy). Environment variables are documented in
 * ./evalModelClient.ts.
 *
 * Each probe replays a scripted conversation that stops at one TODO decision
 * and grades only the model's next reply. A TODO-only reply is never given a
 * follow-up turn here: spending a request on bookkeeping alone is one of the
 * behaviours this eval measures.
 */
import { describe, expect, it } from "vitest";
import {
  evalConfig,
  evalPromptProfile,
  startEvalConversation,
  writeEvalReport,
} from "./evalModelClient.js";
import type { ObservedToolCall } from "./goldenTasks.js";
import {
  TODO_PROBES,
  gradeTodoProbe,
  type TodoProbe,
  type TodoProbeGrade,
} from "./todoTasks.js";

const { configured, runs, minPassRate, selectedIds, model } = evalConfig;

interface RunResult extends TodoProbeGrade {
  taskId: string;
  run: number;
  text: string;
  calls: ObservedToolCall[];
  durationMs: number;
  error?: string;
}

async function runProbe(probe: TodoProbe, run: number): Promise<RunResult> {
  const startedAt = Date.now();
  const base = { taskId: probe.id, run, text: "", calls: [] };
  try {
    const reply = await startEvalConversation(probe.mode, probe.messages);
    return {
      ...base,
      ...gradeTodoProbe(probe, reply.calls),
      calls: reply.calls,
      text: reply.text.slice(0, 300),
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      ...base,
      pass: false,
      tools: [],
      reasons: ["request failed"],
      todoCalls: 0,
      todoOnly: false,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

describe.skipIf(!configured)("TODO decision-point eval", () => {
  it(
    "starts, updates and finishes TODO lists in proportion to the task",
    async () => {
      const probes = TODO_PROBES.filter(
        (probe) => !selectedIds || selectedIds.includes(probe.id),
      );
      const results = await Promise.all(
        probes.flatMap((probe) =>
          Array.from({ length: runs }, (_, run) => runProbe(probe, run + 1)),
        ),
      );

      const rows = probes.map((probe) => {
        const probeResults = results.filter((r) => r.taskId === probe.id);
        const passed = probeResults.filter((r) => r.pass).length;
        return {
          task: probe.id,
          expects: `${probe.expect.todo}${probe.expect.batched ? ", batched" : ""}`,
          pass: `${passed}/${probeResults.length}`,
          tools: probeResults.map((r) => r.tools.join("+") || "-").join(" | "),
          failures: [
            ...new Set(
              probeResults.flatMap((r) => (r.error ? [r.error] : r.reasons)),
            ),
          ].join("; "),
        };
      });
      console.table(rows);

      const valid = results.filter((r) => !r.error);
      const passRate =
        valid.filter((r) => r.pass).length / Math.max(1, valid.length);
      const todoOnlyReplies = valid.filter((r) => r.todoOnly).length;
      const reportPath = await writeEvalReport("todos", {
        passRate,
        todoOnlyReplies,
        todoCalls: valid.reduce((sum, r) => sum + r.todoCalls, 0),
        rows,
        results,
      });
      console.log(
        `TODO pass rate ${(passRate * 100).toFixed(1)}%, ${todoOnlyReplies} TODO-only replies (${model}, ${evalPromptProfile()} prompt); report: ${reportPath}`,
      );

      expect(passRate).toBeGreaterThanOrEqual(minPassRate);
    },
    10 * 60_000,
  );
});
