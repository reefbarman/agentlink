/**
 * Decision-point probes for the live TODO eval (`npm run eval:todos`).
 *
 * Each probe is a scripted conversation that stops at one TODO decision:
 * start a list or not, update it or not, finish through set_task_status. The
 * eval sends it to a live model and grades only the next reply. Scripted tool
 * calls and results are replayed as history; nothing is executed.
 *
 * The target policy, which the prompts should produce:
 * - Small, well-specified tasks (a known-file fix, a short rename, a question)
 *   get no TODO list.
 * - Investigations, multi-phase work, and requests with several deliverables
 *   start a list in the first reply.
 * - A todo_write always shares its reply with the next real action. A reply
 *   that only updates the list costs a full model request for bookkeeping.
 * - Mid-item progress does not touch the list; a real transition does.
 * - Finishing ticks the list off with set_task_status completeTodos: true,
 *   never a separate final todo_write.
 */
import type { CoreModelMessage } from "@agentlink/core/model-runtime";
import { effectiveToolName, type ObservedToolCall } from "./goldenTasks.js";

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoProbeExpectation {
  /** Whether this reply should call todo_write. */
  todo: "required" | "forbidden";
  /** A todo_write must share its reply with at least one other tool call. */
  batched?: boolean;
  /** Statuses the reply's last todo_write must give these item ids. */
  statuses?: Readonly<Record<string, TodoStatus>>;
  /** At least one call must be one of these tools. */
  anyOf?: readonly string[];
  /**
   * A set_task_status call must use status "completed" with completeTodos:
   * true. A final check (a diff, a search) before finishing is not a TODO
   * decision, so the probe does not require the call.
   */
  completeTodos?: boolean;
}

export interface TodoProbe {
  id: string;
  /** What the probe checks, shown in the report. */
  intent: string;
  mode: string;
  messages: CoreModelMessage[];
  expect: TodoProbeExpectation;
}

export interface TodoProbeGrade {
  pass: boolean;
  /** Effective tool names, with call_native_tool unwrapped to its target. */
  tools: string[];
  reasons: string[];
  todoCalls: number;
  /** The reply made tool calls and every one was todo_write. */
  todoOnly: boolean;
}

// ── Script builders ──

interface ScriptedCall {
  name: string;
  input: unknown;
  result: string;
}

type ScriptStep =
  | { user: string }
  | { assistant?: string; calls: readonly ScriptedCall[] };

/**
 * Builds a conversation in AgentLink's internal message format. A user step
 * after tool calls is appended to the tool-result message, as AgentLink
 * delivers a mid-turn interjection.
 */
export function script(steps: readonly ScriptStep[]): CoreModelMessage[] {
  const messages: CoreModelMessage[] = [];
  let nextId = 1;
  for (const step of steps) {
    if ("user" in step) {
      const previous = messages.at(-1);
      if (previous?.role === "user" && Array.isArray(previous.content)) {
        previous.content.push({ type: "text", text: step.user });
      } else {
        messages.push({ role: "user", content: step.user });
      }
      continue;
    }
    const ids = step.calls.map(() => `call_eval_${nextId++}`);
    messages.push({
      role: "assistant",
      content: [
        ...(step.assistant
          ? [{ type: "text" as const, text: step.assistant }]
          : []),
        ...step.calls.map((call, index) => ({
          type: "tool_use" as const,
          id: ids[index],
          name: call.name,
          input: call.input,
        })),
      ],
    } as CoreModelMessage);
    messages.push({
      role: "user",
      content: step.calls.map((call, index) => ({
        type: "tool_result" as const,
        tool_use_id: ids[index],
        content: call.result,
      })),
    });
  }
  return messages;
}

interface ScriptedTodo {
  id: string;
  content: string;
  activeForm: string;
  status: TodoStatus;
}

function todoCall(todos: readonly ScriptedTodo[]): ScriptedCall {
  const count = (status: TodoStatus) =>
    todos.filter((todo) => todo.status === status).length;
  return {
    name: "todo_write",
    input: { todos },
    result: `Updated: ${count("completed")}/${todos.length} complete, ${count("in_progress")} in progress, ${count("pending")} pending`,
  };
}

function jsonFlagTodos(
  statuses: readonly [TodoStatus, TodoStatus, TodoStatus, TodoStatus],
): ScriptedTodo[] {
  const items = [
    [
      "implement",
      "Add --json output to report-session-outcomes.mjs",
      "Adding --json output",
    ],
    ["test", "Add a test for --json output", "Adding a test for --json output"],
    ["docs", "Mention --json in the telemetry docs", "Documenting --json"],
    ["verify", "Run lint and tests", "Running lint and tests"],
  ] as const;
  return items.map(([id, content, activeForm], index) => ({
    id,
    content,
    activeForm,
    status: statuses[index],
  }));
}

// ── Shared scripted context ──

const SMALL_FIX_PROMPT =
  "In src/shared/randomId.ts, the 256-entry hex lookup table is rebuilt on every randomId() call. Hoist it to a module-level constant built once, then run src/shared/randomId.test.ts.";

const SMALL_FIX_READ: ScriptedCall = {
  name: "read_file",
  input: { path: "src/shared/randomId.ts" },
  result:
    '{"total_lines":66,"content":"16 | export function randomId(): string {\\n...\\n30 |     const hex: string[] = [];\\n31 |     for (let i = 0; i < 256; i++) {\\n32 |       hex.push((i + 0x100).toString(16).slice(1));\\n33 |     }\\n..."}',
};

const JSON_FLAG_PROMPT =
  "Add a --json option to the telemetry:sessions report (scripts/report-session-outcomes.mjs) that prints the report data as JSON instead of tables. Include a test and mention the flag in the telemetry docs.";

const JSON_FLAG_READ: ScriptedCall = {
  name: "read_file",
  input: { path: "scripts/report-session-outcomes.mjs", view: "context" },
  result:
    '{"total_lines":412,"content":"1 | #!/usr/bin/env node\\n...\\n38 | function parseArgs(argv) {\\n39 |   const args = { since: undefined, top: 20 };\\n...\\n371 | function main() {\\n372 |   const args = parseArgs(process.argv.slice(2));\\n373 |   const report = buildReport(loadEvents(args), args);\\n374 |   printTables(report);\\n375 | }\\n..."}',
};

const JSON_FLAG_EDIT_ARGS: ScriptedCall = {
  name: "apply_diff",
  input: {
    path: "scripts/report-session-outcomes.mjs",
    diff: "<<<<<<< SEARCH\n  const args = { since: undefined, top: 20 };\n======= DIVIDER =======\n  const args = { since: undefined, top: 20, json: false };\n>>>>>>> REPLACE",
  },
  result: '{"status":"accepted","path":"scripts/report-session-outcomes.mjs"}',
};

const JSON_FLAG_EDIT_MAIN: ScriptedCall = {
  name: "apply_diff",
  input: {
    path: "scripts/report-session-outcomes.mjs",
    diff: "<<<<<<< SEARCH\n  printTables(report);\n======= DIVIDER =======\n  if (args.json) {\n    console.log(JSON.stringify(report, null, 2));\n  } else {\n    printTables(report);\n  }\n>>>>>>> REPLACE",
  },
  result: '{"status":"accepted","path":"scripts/report-session-outcomes.mjs"}',
};

const JSON_FLAG_ARGV_EDIT: ScriptedCall = {
  name: "apply_diff",
  input: {
    path: "scripts/report-session-outcomes.mjs",
    diff: '<<<<<<< SEARCH\n    if (arg === "--top") {\n======= DIVIDER =======\n    if (arg === "--json") {\n      args.json = true;\n      continue;\n    }\n    if (arg === "--top") {\n>>>>>>> REPLACE',
  },
  result: '{"status":"accepted","path":"scripts/report-session-outcomes.mjs"}',
};

const JSON_FLAG_TEST = `import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

const run = (...args) =>
  execFileSync("node", ["scripts/report-session-outcomes.mjs", ...args], {
    encoding: "utf8",
    env: { ...process.env, AGENTLINK_TELEMETRY_FILE: "scripts/fixtures/session-outcomes.jsonl" },
  });

test("--json prints the report data as JSON", () => {
  const report = JSON.parse(run("--json"));
  assert.equal(typeof report.generatedAt, "string");
  assert.ok(Array.isArray(report.sessions));
});

test("tables stay the default output", () => {
  assert.throws(() => JSON.parse(run()));
});
`;

const JSON_FLAG_RUN: ScriptedCall = {
  name: "execute_command",
  input: { command: "node scripts/report-session-outcomes.mjs --json --top 2" },
  result:
    '{"exit_code":0,"output":"{\\n  \\"generatedAt\\": \\"2026-11-18T06:02:11.000Z\\",\\n  \\"turns\\": 2,\\n  \\"sessions\\": [ ... ]\\n}\\n"}',
};

// ── Probes ──

export const TODO_PROBES: readonly TodoProbe[] = [
  {
    id: "small-fix-no-list",
    mode: "code",
    intent:
      "A small, well-specified fix in a named file starts work directly, without a TODO list.",
    messages: script([{ user: SMALL_FIX_PROMPT }]),
    expect: { todo: "forbidden" },
  },
  {
    id: "small-rename-no-list",
    mode: "code",
    intent: "A short rename across a couple of files needs no TODO list.",
    messages: script([
      {
        user: "Rename the exported helper isTodoOnlyReply in src/evals/goldenTasks.ts to isTodoOnlyTurn and update its callers.",
      },
    ]),
    expect: { todo: "forbidden" },
  },
  {
    id: "question-no-list",
    mode: "ask",
    intent: "A single-step question gets no TODO list.",
    messages: script([{ user: "What does src/shared/randomId.ts export?" }]),
    expect: { todo: "forbidden" },
  },
  {
    id: "investigation-starts-list",
    mode: "code",
    intent:
      "An open-ended investigation starts a TODO list in the same reply as its first action.",
    messages: script([
      {
        user: "I've noticed session restore feels slower recently. Can you look into why?",
      },
    ]),
    expect: { todo: "required", batched: true },
  },
  {
    id: "multi-deliverable-starts-list",
    mode: "code",
    intent:
      "A request with several deliverables starts a TODO list in the same reply as its first action.",
    messages: script([{ user: JSON_FLAG_PROMPT }]),
    expect: { todo: "required", batched: true },
  },
  {
    id: "mid-item-no-update",
    mode: "code",
    intent:
      "Progress inside the current item (one of several edits done) does not touch the list.",
    messages: script([
      { user: JSON_FLAG_PROMPT },
      {
        calls: [
          todoCall(
            jsonFlagTodos(["in_progress", "pending", "pending", "pending"]),
          ),
          JSON_FLAG_READ,
        ],
      },
      {
        assistant:
          "I'll add a json flag to the parsed args, handle --json in the argument loop, and switch main() between JSON and tables.",
        calls: [JSON_FLAG_EDIT_ARGS],
      },
    ]),
    expect: { todo: "forbidden" },
  },
  {
    id: "transition-batched",
    mode: "code",
    intent:
      "Finishing an item updates the list in the same reply as the first action on the next item.",
    messages: script([
      { user: JSON_FLAG_PROMPT },
      {
        calls: [
          todoCall(
            jsonFlagTodos(["in_progress", "pending", "pending", "pending"]),
          ),
          JSON_FLAG_READ,
        ],
      },
      {
        calls: [JSON_FLAG_EDIT_ARGS, JSON_FLAG_ARGV_EDIT, JSON_FLAG_EDIT_MAIN],
      },
      { calls: [JSON_FLAG_RUN] },
    ]),
    expect: {
      todo: "required",
      batched: true,
      statuses: { implement: "completed", test: "in_progress" },
    },
  },
  {
    id: "scope-change-updates-list",
    mode: "code",
    intent:
      "A mid-task request for extra work adds it to the list, alongside continuing the work.",
    messages: script([
      { user: JSON_FLAG_PROMPT },
      {
        calls: [
          todoCall(
            jsonFlagTodos(["in_progress", "pending", "pending", "pending"]),
          ),
          JSON_FLAG_READ,
        ],
      },
      { calls: [JSON_FLAG_EDIT_ARGS] },
      { user: "Also add a CHANGELOG entry for the new flag." },
    ]),
    expect: { todo: "required", batched: true },
  },
  {
    id: "finish-with-list",
    mode: "code",
    intent:
      "Finishing listed work ticks the list off through set_task_status completeTodos: true, never a separate final todo_write.",
    messages: script([
      { user: JSON_FLAG_PROMPT },
      {
        calls: [
          todoCall(
            jsonFlagTodos(["in_progress", "pending", "pending", "pending"]),
          ),
          JSON_FLAG_READ,
        ],
      },
      {
        calls: [JSON_FLAG_EDIT_ARGS, JSON_FLAG_ARGV_EDIT, JSON_FLAG_EDIT_MAIN],
      },
      {
        calls: [
          todoCall(
            jsonFlagTodos(["completed", "in_progress", "pending", "pending"]),
          ),
          {
            name: "write_file",
            input: {
              path: "scripts/report-session-outcomes.test.mjs",
              // A real test: a placeholder makes careful models reopen the
              // item, which tests the fixture instead of TODO behaviour.
              content: JSON_FLAG_TEST,
            },
            result:
              '{"status":"accepted","path":"scripts/report-session-outcomes.test.mjs"}',
          },
        ],
      },
      {
        calls: [
          todoCall(
            jsonFlagTodos(["completed", "completed", "in_progress", "pending"]),
          ),
          {
            name: "apply_diff",
            input: {
              path: "resources/builtin-skills/documentation/references/troubleshooting.md",
              diff: "<<<<<<< SEARCH\n`npm run telemetry:sessions`\n======= DIVIDER =======\n`npm run telemetry:sessions` (add `-- --json` for machine-readable output)\n>>>>>>> REPLACE",
            },
            result: '{"status":"accepted"}',
          },
        ],
      },
      {
        calls: [
          todoCall(
            jsonFlagTodos([
              "completed",
              "completed",
              "completed",
              "in_progress",
            ]),
          ),
          {
            name: "execute_command",
            input: {
              command:
                "node --test scripts/report-session-outcomes.test.mjs && npm run lint && npm test",
            },
            result:
              '{"exit_code":0,"output":"✔ --json prints the report data as JSON (61ms)\\n✔ tables stay the default output (58ms)\\nℹ pass 2\\n... lint passed ...\\nTest Files  812 passed (812)\\n     Tests  14260 passed (14260)\\n"}',
          },
        ],
      },
    ]),
    expect: { todo: "forbidden", completeTodos: true },
  },
  {
    id: "small-finish-no-list",
    mode: "code",
    intent:
      "A small task finished without a list does not start one at the end.",
    messages: script([
      { user: SMALL_FIX_PROMPT },
      { calls: [SMALL_FIX_READ] },
      {
        calls: [
          {
            name: "apply_diff",
            input: {
              path: "src/shared/randomId.ts",
              diff: "<<<<<<< SEARCH\n    const hex: string[] = [];\n    for (let i = 0; i < 256; i++) {\n      hex.push((i + 0x100).toString(16).slice(1));\n    }\n======= DIVIDER =======\n    const hex = HEX;\n>>>>>>> REPLACE\n<<<<<<< SEARCH\nexport function randomId(): string {\n======= DIVIDER =======\nconst HEX = Array.from({ length: 256 }, (_, i) =>\n  (i + 0x100).toString(16).slice(1),\n);\n\nexport function randomId(): string {\n>>>>>>> REPLACE",
            },
            result: '{"status":"accepted","path":"src/shared/randomId.ts"}',
          },
        ],
      },
      {
        calls: [
          {
            name: "execute_command",
            input: { command: "npx vitest run src/shared/randomId.test.ts" },
            result:
              '{"exit_code":0,"output":" ✓ src/shared/randomId.test.ts (4 tests) 6ms\\n\\n Test Files  1 passed (1)\\n      Tests  4 passed (4)\\n"}',
          },
        ],
      },
    ]),
    expect: { todo: "forbidden" },
  },
];

// ── Grading ──

function lastTodoList(
  calls: readonly ObservedToolCall[],
  tools: readonly string[],
): unknown[] | undefined {
  for (let index = calls.length - 1; index >= 0; index--) {
    if (tools[index] !== "todo_write") continue;
    const call = calls[index];
    const input = (
      call.name === "call_native_tool"
        ? (call.input as { input?: unknown } | null)?.input
        : call.input
    ) as { todos?: unknown } | null;
    return Array.isArray(input?.todos) ? input.todos : [];
  }
  return undefined;
}

export function gradeTodoProbe(
  probe: TodoProbe,
  calls: readonly ObservedToolCall[],
): TodoProbeGrade {
  const tools = calls.map(effectiveToolName);
  const reasons: string[] = [];
  const todoCalls = tools.filter((tool) => tool === "todo_write").length;
  const otherCalls = tools.length - todoCalls;
  const todoOnly = todoCalls > 0 && otherCalls === 0;
  const { todo, batched, statuses, anyOf, completeTodos } = probe.expect;

  if (todo === "required" && todoCalls === 0) {
    reasons.push("no todo_write; expected the list to be started or updated");
  }
  if (todo === "forbidden" && todoCalls > 0) {
    reasons.push(`called todo_write ${todoCalls}x; expected no list change`);
  }
  if (batched && todoOnly) {
    reasons.push(
      "todo_write was the only call; expected it batched with the next action",
    );
  }

  if (statuses && todoCalls > 0) {
    const items = lastTodoList(calls, tools) ?? [];
    for (const [id, status] of Object.entries(statuses)) {
      const item = items.find(
        (candidate) => (candidate as { id?: unknown } | null)?.id === id,
      ) as { status?: unknown } | undefined;
      if (item?.status !== status) {
        reasons.push(
          `todo "${id}" is ${item ? String(item.status) : "missing"}; expected ${status}`,
        );
      }
    }
  }

  if (anyOf?.length && !tools.some((tool) => anyOf.includes(tool))) {
    reasons.push(
      `called ${tools.join(", ") || "no tools"}; expected one of ${anyOf.join(", ")}`,
    );
  }

  if (completeTodos) {
    const status = calls.find((_, index) => tools[index] === "set_task_status")
      ?.input as { status?: unknown; completeTodos?: unknown } | undefined;
    if (
      status &&
      (status.status !== "completed" || status.completeTodos !== true)
    ) {
      reasons.push(
        `set_task_status ${JSON.stringify({ status: status.status, completeTodos: status.completeTodos })}; expected completed with completeTodos: true`,
      );
    }
  }

  return { pass: reasons.length === 0, tools, reasons, todoCalls, todoOnly };
}
