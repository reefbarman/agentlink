import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  SCORED_TASK_IDS,
  calibrate,
  copyDir,
  loadTask,
  scoreWorkspace,
} from "./scoring.mjs";
import { afterEach, test } from "node:test";
import {
  attemptRequestStats,
  attemptRows,
  backfillRequestStats,
  compareRuns,
  renderComparison,
} from "./compare.mjs";
import {
  buildCharts,
  checkScore,
  median,
  renderMarkdown,
  summarizeAttempts,
  summarizeRouting,
  writeReport,
} from "./report.mjs";
import { buildSchedule, resolveLimits, runAttempt } from "./runner.mjs";
import {
  findTaskSessions,
  listSessions,
  requestStats,
  todoMetrics,
} from "./sessions.mjs";

import assert from "node:assert/strict";
import { parseArgs } from "./bench.mjs";

test("schedule rotates model order so each model takes each slot", () => {
  const schedule = buildSchedule(
    [{ label: "a" }, { label: "b" }, { label: "c" }],
    ["t1", "t2", "t3"],
    2,
  );
  assert.equal(schedule.length, 18);
  const firstRound = schedule.filter((item) => item.round === 1);
  for (const label of ["a", "b", "c"]) {
    const slots = ["t1", "t2", "t3"].map((taskId) =>
      firstRound
        .filter((item) => item.taskId === taskId)
        .findIndex((item) => item.model.label === label),
    );
    assert.deepEqual(
      [...slots].sort(),
      [0, 1, 2],
      `${label} slots ${slots.join(",")}`,
    );
  }
});

/**
 * Fake gateway: a foreground chat plus one new tab whose status follows
 * `script`, one entry per poll after send.
 */
function fakeGateway({ script, resolvedModel }) {
  const calls = [];
  const tabs = [
    {
      tabId: "fg-tab",
      sessionId: "fg-session",
      status: "streaming",
      busy: true,
      model: "claude-opus-5-5",
    },
  ];
  let polls = -1;
  let sent = false;
  const state = () => {
    if (sent) {
      polls++;
      const step = script[Math.min(polls, script.length - 1)];
      Object.assign(tabs[1], step);
    }
    return {
      session: {
        chatWorkspace: {
          controllerEpoch: "epoch",
          focusedTabId: "fg-tab",
          tabs: tabs.map((tab) => ({ ...tab })),
        },
      },
    };
  };
  const client = {
    calls,
    getState: async () => state(),
    newTab: async (selection) => {
      calls.push(["newTab", selection]);
      tabs.push({
        tabId: "bench-tab",
        sessionId: "bench-session",
        status: "idle",
        busy: false,
        model: "default-model",
      });
      return {
        ok: true,
        tabId: "bench-tab",
        sessionId: "bench-session",
        controllerEpoch: "epoch",
      };
    },
    setModel: async (sessionId, model) => {
      calls.push(["setModel", sessionId, model]);
      tabs[1].model = resolvedModel ?? model;
    },
    setReasoningEffort: async (sessionId, effort) =>
      calls.push(["setReasoningEffort", sessionId, effort]),
    send: async (sessionId, text, mode) => {
      calls.push(["send", sessionId, text, mode]);
      sent = true;
    },
    stop: async (sessionId) => {
      calls.push(["stop", sessionId]);
      tabs[1].busy = false;
      tabs[1].status = "idle";
      script.length = 0;
      script.push({ busy: false, status: "idle" });
    },
    closeTab: async (selection) => calls.push(["closeTab", selection]),
  };
  return client;
}

async function runFake(client, overrides = {}) {
  let clock = 0;
  const recorded = [];
  const result = await runAttempt({
    client,
    entry: {
      label: "gpt-6.2-sol",
      model: "gpt-6.2-sol",
      reasoningEffort: "high",
    },
    task: { id: "small-ts-bugfix", prompt: "Fix the cart." },
    prepare: () => {},
    readTrace: () => ({ apiCalls: 3 }),
    record: (attempt) => {
      recorded.push(attempt);
      return { verdict: { solved: true } };
    },
    limits: { maxMs: 60_000, maxRequests: 20 },
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    pollMs: 1_000,
    ...overrides,
  });
  return { result, recorded };
}

test("runner drives a new tab to completion and never touches the foreground chat", async () => {
  const client = fakeGateway({
    script: [
      { busy: true, status: "streaming" },
      { busy: true, status: "streaming" },
      { busy: false, status: "completed" },
    ],
  });
  const { result, recorded } = await runFake(client);
  assert.equal(result.terminalReason, "completed");
  assert.equal(recorded[0].sessionId, "bench-session");
  assert.equal(recorded[0].label, "gpt-6.2-sol");
  assert.deepEqual(client.calls[0], [
    "newTab",
    { controllerEpoch: "epoch", tabId: "fg-tab", sessionId: "fg-session" },
  ]);
  for (const call of client.calls.slice(1, -1)) {
    assert.equal(
      call[1],
      "bench-session",
      `${call[0]} targeted the wrong chat`,
    );
  }
  assert.deepEqual(
    client.calls.map((call) => call[0]),
    ["newTab", "setModel", "setReasoningEffort", "send", "closeTab"],
  );
  assert.deepEqual(client.calls[3], [
    "send",
    "bench-session",
    "Fix the cart.",
    "code",
  ]);
});

test("runner stops at the time cap and records why", async () => {
  const client = fakeGateway({ script: [{ busy: true, status: "streaming" }] });
  const { result, recorded } = await runFake(client, {
    limits: { maxMs: 5_000, maxRequests: 20 },
  });
  assert.equal(result.terminalReason, "time_cap");
  assert.equal(recorded[0].terminalReason, "time_cap");
  assert.ok(client.calls.some((call) => call[0] === "stop"));
});

test("runner stops when the model needs input instead of waiting for a human", async () => {
  const client = fakeGateway({
    script: [
      { busy: true, status: "streaming" },
      { busy: true, status: "needs_input" },
    ],
  });
  const { result } = await runFake(client);
  assert.equal(result.terminalReason, "needs_input");
});

test("runner refuses to benchmark a fallback model", async () => {
  const client = fakeGateway({ script: [], resolvedModel: "gpt-5.6-luna" });
  const { result, recorded } = await runFake(client);
  assert.equal(result.terminalReason, "infra");
  assert.match(recorded[0].detail, /gpt-5\.6-luna/);
  assert.ok(!client.calls.some((call) => call[0] === "send"));
});

test("infra failures are reported separately from attempts", () => {
  const [row] = summarizeAttempts([
    attempt("a", "t", true, { terminalReason: "completed" }),
    attempt("a", "t", false, { terminalReason: "time_cap" }),
    attempt("a", "t", false, { terminalReason: "infra" }),
  ]);
  assert.equal(row.attempts, 2);
  assert.equal(row.unassistedSolved, 1);
  assert.equal(row.stopped, 1);
  assert.equal(row.infraFailures, 1);
});

function writeSession(historyDir, id, summary, firstMessage) {
  const dir = path.join(historyDir, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "metadata.json"),
    JSON.stringify({ summary: { id, ...summary } }),
  );
  fs.writeFileSync(
    path.join(dir, "messages.json"),
    JSON.stringify({
      schemaVersion: 1,
      messages: [{ role: "user", content: firstMessage }],
    }),
  );
}

test("finds the foreground chat started after prepare with the task prompt", () => {
  const history = makeTempDirectory();
  const prompt = "Rename formatCents to formatCurrency.";
  writeSession(history, "old", { createdAt: 100 }, prompt);
  writeSession(history, "bg", { createdAt: 300, background: true }, prompt);
  writeSession(history, "other", { createdAt: 300 }, "unrelated");
  writeSession(history, "match", { createdAt: 400, model: "gpt-6.2-sol" }, [
    { type: "text", text: `<mode>code</mode>\n\n${prompt}` },
  ]);
  const matches = findTaskSessions(history, prompt, 200);
  assert.deepEqual(
    matches.map((session) => session.id),
    ["match"],
  );
  assert.equal(matches[0].model, "gpt-6.2-sol");
  assert.deepEqual(
    listSessions(history, { limit: 2 }).map((session) => session.id),
    ["match", "other"],
  );
});

const tempDirectories = [];

function makeTempDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "model-bench-test-"));
  tempDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("every control gets its expected verdict and score range", () => {
  const rows = calibrate();
  assert.equal(rows.length, SCORED_TASK_IDS.length * 3);
  for (const row of rows) {
    assert.ok(
      row.ok,
      `${row.taskId}/${row.control}: solved=${row.solved} score=${row.score} failed: ${row.failedChecks.join(", ")}`,
    );
  }
  const partial = rows.find(
    (row) => row.taskId === "minesweeper-app" && row.control === "partial",
  );
  assert.ok(partial.score > 0.4 && partial.score < 0.85);
});

test("minesweeper verifier restores the provided rng and allows new src files", () => {
  const dir = makeTempDirectory();
  const task = loadTask("minesweeper-app");
  copyDir(task.pristineDir, dir);
  copyDir(
    path.join(
      path.dirname(new URL(import.meta.url).pathname),
      "controls",
      "minesweeper-app",
      "reference",
    ),
    dir,
  );
  // Rigging placeMines must not change the verdict, but is flagged.
  fs.writeFileSync(
    path.join(dir, "src", "rng.js"),
    "export const placeMines = () => [];\n",
  );
  fs.writeFileSync(path.join(dir, "src", "helpers.js"), "export {};\n");
  const verdict = scoreWorkspace("minesweeper-app", dir);
  assert.equal(verdict.solved, true);
  assert.equal(verdict.score, 1);
  assert.deepEqual(verdict.integrity.protectedFilesChanged, ["src/rng.js"]);
  assert.deepEqual(verdict.integrity.outOfScopeChanges, []);
});

test("per-task limits apply unless a flag overrides them", () => {
  const long = { limits: { maxMinutes: 30, maxRequests: 80 } };
  assert.deepEqual(resolveLimits(long), { maxMs: 1_800_000, maxRequests: 80 });
  assert.deepEqual(resolveLimits({}), { maxMs: 600_000, maxRequests: 20 });
  assert.deepEqual(resolveLimits(long, { "max-minutes": "5" }), {
    maxMs: 300_000,
    maxRequests: 80,
  });
  assert.deepEqual(resolveLimits(long, { "max-requests": true }), {
    maxMs: 1_800_000,
    maxRequests: 80,
  });
});

test("check score falls back to stored checks for older attempts", () => {
  assert.equal(checkScore({ verdict: { score: 0.5 } }), 0.5);
  assert.equal(
    checkScore({
      verdict: { checks: [{ pass: true }, { pass: false }, { pass: true }] },
    }),
    2 / 3,
  );
  assert.equal(checkScore({ verdict: {} }), null);
});

test("edited tests cannot award a pass and are flagged", () => {
  const dir = makeTempDirectory();
  copyDir(loadTask("small-ts-bugfix").pristineDir, dir);
  fs.writeFileSync(path.join(dir, "test", "cart.test.js"), "// gutted\n");
  const verdict = scoreWorkspace("small-ts-bugfix", dir);
  assert.equal(verdict.solved, false);
  assert.deepEqual(verdict.integrity.protectedFilesChanged, [
    "test/cart.test.js",
  ]);
});

test("out-of-scope edits are flagged without failing a correct fix", () => {
  const dir = makeTempDirectory();
  copyDir(loadTask("small-ts-bugfix").pristineDir, dir);
  const cart = path.join(dir, "src", "cart.js");
  fs.writeFileSync(
    cart,
    fs
      .readFileSync(cart, "utf8")
      .replace(
        "return taxedCents - discountCents;",
        "return Math.max(0, taxedCents - discountCents);",
      ),
  );
  fs.writeFileSync(path.join(dir, "NOTES.md"), "drive-by\n");
  const verdict = scoreWorkspace("small-ts-bugfix", dir);
  assert.equal(verdict.solved, true);
  assert.deepEqual(verdict.integrity.outOfScopeChanges, ["NOTES.md"]);
});

test("a hanging or crashing workspace fails rather than throwing", () => {
  const dir = makeTempDirectory();
  copyDir(loadTask("small-ts-bugfix").pristineDir, dir);
  fs.writeFileSync(path.join(dir, "src", "cart.js"), "export const = ;\n");
  const verdict = scoreWorkspace("small-ts-bugfix", dir);
  assert.equal(verdict.solved, false);
  assert.ok(verdict.checks.some((check) => !check.pass));
});

test("parseArgs handles flags, inline values and positionals", () => {
  assert.deepEqual(
    parseArgs(["score", "--session", "abc", "--intervened", "--note=hi there"]),
    { _: ["score"], session: "abc", intervened: true, note: "hi there" },
  );
});

test("median ignores missing values", () => {
  assert.equal(median([3, null, 1, undefined, 2]), 2);
  assert.equal(median([4, 1]), 2.5);
  assert.equal(median([null]), null);
});

const routingReport = (label, profile, results, generatedAt) => ({
  label,
  model: `${label}-id`,
  promptProfile: profile,
  generatedAt,
  rows: [...new Set(results.map((result) => result.taskId))].map((task) => ({
    task,
  })),
  results,
});

test("routing summary keeps the latest report per model and profile and excludes errors", () => {
  const { rows, taskRows } = summarizeRouting([
    routingReport("a", "compatibility", [{ taskId: "t1", pass: false }], "1"),
    routingReport(
      "a",
      "compatibility",
      [
        { taskId: "t1", pass: true },
        { taskId: "t1", pass: false, error: "HTTP 500" },
        { taskId: "t2", pass: false },
      ],
      "2",
    ),
    routingReport("b", "reasoning", [{ taskId: "t1", pass: true }], "1"),
  ]);
  const a = rows.find((row) => row.label === "a");
  assert.equal(rows.length, 2);
  assert.equal(a.responses, 3);
  assert.equal(a.errors, 1);
  assert.equal(a.passRate, 0.5);
  assert.deepEqual(
    taskRows.find((row) => row.label === "a" && row.task === "t1"),
    {
      label: "a",
      promptProfile: "compatibility",
      task: "t1",
      passed: 1,
      valid: 1,
      passRate: 1,
    },
  );
});

const attempt = (label, taskId, solved, extra = {}) => ({
  label,
  taskId,
  scoredAt: "2026-11-18T00:00:00Z",
  intervened: false,
  elapsedMs: 60_000,
  trace: { apiCalls: 4, toolCalls: 6, inputTokens: 100, outputTokens: 10 },
  verdict: {
    solved,
    verifierVersion: "1",
    integrity: { protectedFilesChanged: [], outOfScopeChanges: [] },
  },
  ...extra,
});

test("assisted solves do not count as unassisted solves", () => {
  const [row] = summarizeAttempts([
    attempt("a", "t", true),
    attempt("a", "t", true, { intervened: true }),
    attempt("a", "t", false, {
      verdict: {
        solved: false,
        verifierVersion: "1",
        integrity: {
          protectedFilesChanged: ["test/x.js"],
          outOfScopeChanges: [],
        },
      },
    }),
  ]);
  assert.equal(row.attempts, 3);
  assert.equal(row.unassistedSolved, 1);
  assert.equal(row.interventions, 1);
  assert.equal(row.integrityFlags, 1);
  assert.equal(row.medianElapsedSec, 60);
});

test("report renders tables, vega-lite charts and HTML from bench output", () => {
  const benchDir = makeTempDirectory();
  fs.mkdirSync(path.join(benchDir, "routing"));
  fs.writeFileSync(
    path.join(benchDir, "routing", "routing-1.json"),
    JSON.stringify(
      routingReport("a", "compatibility", [{ taskId: "t1", pass: true }], "1"),
    ),
  );
  const attemptDir = path.join(benchDir, "attempts", "one");
  fs.mkdirSync(attemptDir, { recursive: true });
  fs.writeFileSync(
    path.join(attemptDir, "attempt.json"),
    JSON.stringify(attempt("a", "small-ts-bugfix", true)),
  );

  const { outDir, routing, endToEnd } = writeReport(benchDir);
  assert.equal(routing.rows.length, 1);
  assert.equal(endToEnd.length, 1);
  assert.equal(buildCharts(routing, endToEnd).length, 4);
  const markdown = fs.readFileSync(path.join(outDir, "summary.md"), "utf8");
  assert.match(markdown, /\| small-ts-bugfix \| a \| 1\/1 \|/);
  assert.equal(markdown.match(/```vega-lite/g)?.length, 4);
  const html = fs.readFileSync(path.join(outDir, "index.html"), "utf8");
  assert.match(html, /vegaEmbed\(/);
  // Three CDN scripts plus the inline one: embedded data cannot close a tag.
  assert.equal(html.match(/<\/script>/g)?.length, 4);
});

test("empty bench dir still produces a report with next steps", () => {
  const markdown = renderMarkdown({
    generatedAt: "now",
    routing: { rows: [], taskRows: [] },
    endToEnd: [],
    charts: [],
  });
  assert.match(markdown, /bench:routing/);
  assert.match(markdown, /bench:todos/);
  assert.match(markdown, /bench:prepare/);
});

test("todo metrics count TODO-only requests and completeTodos finishes", () => {
  const dir = makeTempDirectory();
  const use = (name, input = {}) => ({ type: "tool_use", name, input });
  fs.writeFileSync(
    path.join(dir, "messages.json"),
    JSON.stringify([
      { role: "user", content: "task" },
      { role: "assistant", content: [use("todo_write")] },
      {
        role: "assistant",
        content: [use("read_file"), use("todo_write"), use("list_files")],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "updating" },
          use("call_native_tool", { name: "todo_write", input: {} }),
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
      {
        role: "assistant",
        content: [use("set_task_status", { completeTodos: true })],
      },
    ]),
  );
  assert.deepEqual(todoMetrics(dir), {
    calls: 3,
    todoOnlyRequests: 2,
    listStarted: true,
    completedViaStatus: true,
  });
  assert.equal(todoMetrics(makeTempDirectory()), null);
});

test("report shows TODO eval results and per-attempt TODO counts", () => {
  const benchDir = makeTempDirectory();
  fs.mkdirSync(path.join(benchDir, "todos"));
  fs.writeFileSync(
    path.join(benchDir, "todos", "todos-1.json"),
    JSON.stringify({
      ...routingReport("a", "reasoning", [{ taskId: "p1", pass: true }], "1"),
      todoOnlyReplies: 3,
    }),
  );
  const attemptDir = path.join(benchDir, "attempts", "one");
  fs.mkdirSync(attemptDir, { recursive: true });
  fs.writeFileSync(
    path.join(attemptDir, "attempt.json"),
    JSON.stringify(
      attempt("a", "small-ts-bugfix", true, {
        todo: { calls: 3, todoOnlyRequests: 3, listStarted: true },
      }),
    ),
  );

  const { outDir, todos, endToEnd } = writeReport(benchDir);
  assert.equal(todos.rows[0].todoOnlyReplies, 3);
  assert.equal(endToEnd[0].medianTodoOnlyRequests, 3);
  assert.equal(endToEnd[0].listsStarted, 1);
  const markdown = fs.readFileSync(path.join(outDir, "summary.md"), "utf8");
  assert.match(markdown, /## TODO decision points/);
  assert.match(
    markdown,
    /\| a \| reasoning \| chat-completions \| 100% \| 1 \| 1 \| 3 \|/,
  );
  assert.match(markdown, /\| 3 \| 3 \| 1\/1 \|/);
  assert.match(markdown, /TODO decision pass rate by probe/);
});

function writeTrace(sessionDir, events) {
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionDir, "activity-trace.jsonl"),
    events.map((event) => JSON.stringify(event)).join("\n") + "\n",
  );
}

const request = (inputTokens, cacheReadTokens, outputTokens = 5) => ({
  kind: "api_request",
  payload: { inputTokens, cacheReadTokens, outputTokens },
});
const toolStart = (toolName) => ({ kind: "tool_start", payload: { toolName } });

test("request stats count replies, TODO-only and multi-tool replies, and cache split", () => {
  const dir = makeTempDirectory();
  writeTrace(dir, [
    request(1000, 0),
    toolStart("todo_write"),
    request(1200, 1000),
    toolStart("read_file"),
    toolStart("todo_write"),
    request(1500, 1200),
    toolStart("todo_write"),
    toolStart("todo_write"),
    request(1600, 1500),
  ]);
  assert.deepEqual(requestStats(dir), {
    requests: 4,
    todoOnlyReplies: 2,
    multiToolReplies: 2,
    inputTokens: 5300,
    cachedInputTokens: 3700,
    uncachedInputTokens: 1600,
    outputTokens: 20,
  });
  assert.equal(requestStats(makeTempDirectory()), null);
});

test("attempt stats prefer attempt.json, then session history, then run totals", () => {
  const history = makeTempDirectory();
  writeTrace(path.join(history, "s1"), [request(100, 40)]);
  const stored = { requests: 9, inputTokens: 1 };
  assert.equal(
    attemptRequestStats(attempt("a", "t", true, { requests: stored }), history)
      .source,
    "attempt",
  );
  const rebuilt = attemptRequestStats(
    attempt("a", "t", true, { sessionId: "s1" }),
    history,
  );
  assert.equal(rebuilt.source, "history");
  assert.equal(rebuilt.uncachedInputTokens, 60);
  const totals = attemptRequestStats(
    attempt("a", "t", true, { sessionId: "gone" }),
    history,
  );
  assert.equal(totals.source, "totals");
  assert.equal(totals.requests, 4);
  assert.equal(totals.multiToolReplies, null);
});

test("compare averages per attempt, skips infra and flags effort changes", () => {
  const stats = (requests, input, cached) => ({
    requests,
    todoOnlyReplies: 0,
    multiToolReplies: 1,
    inputTokens: input,
    cachedInputTokens: cached,
    uncachedInputTokens: input - cached,
    outputTokens: 10,
  });
  const before = attemptRows(
    [
      attempt("m", "t1", true, {
        reasoningEffort: "medium",
        requests: stats(10, 1000, 500),
      }),
      attempt("m", "t1", false, {
        reasoningEffort: "medium",
        terminalReason: "infra",
        requests: stats(99, 1, 0),
      }),
    ],
    undefined,
  );
  const after = attemptRows(
    [
      attempt("m", "t1", true, {
        reasoningEffort: "high",
        requests: stats(6, 800, 600),
      }),
      attempt("m", "t1", true, {
        reasoningEffort: "high",
        requests: stats(4, 1200, 1000),
      }),
      attempt("n", "t1", true, { requests: stats(5, 100, 50) }),
    ],
    undefined,
  );
  const comparison = compareRuns(before, after);
  const model = comparison.models.find((entry) => entry.key === "m");
  assert.equal(model.before.attempts, 1);
  assert.equal(model.before.requests, 10);
  assert.equal(model.after.requests, 5);
  assert.equal(model.before.cachedShare, 0.5);
  assert.equal(model.after.cachedShare, 0.8);
  assert.equal(
    comparison.models.find((entry) => entry.key === "n").before,
    null,
  );
  assert.equal(comparison.tasks[0].key, "m / t1");

  const markdown = renderComparison({
    beforeName: "old",
    afterName: "new",
    comparison,
  });
  assert.match(markdown, /## Per model\n/);
  assert.match(markdown, /## Per model and task/);
  assert.match(
    markdown,
    /\| m \| 1\/1, medium → 2\/2, high \| 10\.0 → 5\.0 \(-50%\)/,
  );
  assert.match(markdown, /50% → 80% \(\+30 pts\)/);
  assert.match(markdown, /Reasoning effort differs for m/);
  assert.match(markdown, /\| n \| none → 1\/1, default \|/);
});

test("backfill stores rebuilt request stats only where they are missing", () => {
  const history = makeTempDirectory();
  writeTrace(path.join(history, "s1"), [request(100, 40)]);
  const benchDir = makeTempDirectory();
  const write = (name, value) => {
    const dir = path.join(benchDir, "attempts", name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "attempt.json"), JSON.stringify(value));
  };
  write("old", attempt("a", "t", true, { sessionId: "s1" }));
  write(
    "new",
    attempt("a", "t", true, { sessionId: "s1", requests: { requests: 7 } }),
  );
  write("gone", attempt("a", "t", true, { sessionId: "missing" }));

  assert.equal(backfillRequestStats(benchDir, history), 1);
  const read = (name) =>
    JSON.parse(
      fs.readFileSync(
        path.join(benchDir, "attempts", name, "attempt.json"),
        "utf8",
      ),
    );
  assert.equal(read("old").requests.requests, 1);
  assert.equal(read("new").requests.requests, 7);
  assert.equal(read("gone").requests, undefined);
});
