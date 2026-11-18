// Aggregates routing-eval reports and scored attempts into a comparison
// report: data.json, summary.md (tables plus vega-lite fences, which
// AgentLink's chat renders) and a standalone index.html with Vega-Lite charts.

import * as fs from "node:fs";
import * as path from "node:path";

export function loadRoutingReports(benchDir) {
  const dir = path.join(benchDir, "routing");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => {
      const report = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
      return { file, ...report };
    });
}

export function loadAttempts(benchDir) {
  const dir = path.join(benchDir, "attempts");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .map((name) => path.join(dir, name, "attempt.json"))
    .filter((file) => fs.existsSync(file))
    .map((file) => JSON.parse(fs.readFileSync(file, "utf8")))
    .sort((a, b) => String(a.scoredAt).localeCompare(String(b.scoredAt)));
}

/** Latest routing report per (label, prompt profile); older ones are history. */
export function summarizeRouting(reports) {
  const latest = new Map();
  for (const report of reports) {
    const label = report.label ?? report.model;
    const key = `${label}\0${report.promptProfile ?? "default"}`;
    latest.set(key, report);
  }
  const rows = [];
  const taskRows = [];
  for (const report of latest.values()) {
    const label = report.label ?? report.model;
    const results = report.results ?? [];
    const errors = results.filter((result) => result.error).length;
    const valid = results.length - errors;
    const passed = results.filter((result) => result.pass).length;
    rows.push({
      label,
      model: report.model,
      promptProfile: report.promptProfile ?? "default",
      transport: report.transport ?? "chat-completions",
      reasoningEffort: report.reasoningEffort ?? null,
      harnessRevision: report.harnessRevision ?? null,
      generatedAt: report.generatedAt ?? null,
      tasks: report.rows?.length ?? 0,
      responses: results.length,
      errors,
      passed,
      passRate: valid > 0 ? passed / valid : null,
      file: report.file,
    });
    for (const taskId of new Set(results.map((result) => result.taskId))) {
      const taskResults = results.filter(
        (result) => result.taskId === taskId && !result.error,
      );
      taskRows.push({
        label,
        promptProfile: report.promptProfile ?? "default",
        task: taskId,
        passed: taskResults.filter((result) => result.pass).length,
        valid: taskResults.length,
        passRate: taskResults.length
          ? taskResults.filter((result) => result.pass).length /
            taskResults.length
          : null,
      });
    }
  }
  return { rows, taskRows };
}

export function summarizeAttempts(attempts) {
  const groups = new Map();
  for (const attempt of attempts) {
    const key = `${attempt.label}\0${attempt.taskId}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(attempt);
  }
  const rows = [];
  for (const all of groups.values()) {
    // Harness or gateway failures say nothing about the model; report them
    // separately instead of counting them as unsolved.
    const group = all.filter((attempt) => attempt.terminalReason !== "infra");
    const unassisted = group.filter((attempt) => !attempt.intervened);
    const solved = unassisted.filter((attempt) => attempt.verdict.solved);
    rows.push({
      label: all[0].label,
      task: all[0].taskId,
      attempts: group.length,
      unassistedSolved: solved.length,
      solveRate: group.length ? solved.length / group.length : null,
      interventions: group.length - unassisted.length,
      stopped: group.filter(
        (attempt) =>
          attempt.terminalReason && attempt.terminalReason !== "completed",
      ).length,
      infraFailures: all.length - group.length,
      integrityFlags: group.filter(hasIntegrityFlag).length,
      medianApiCalls: median(group.map((attempt) => attempt.trace?.apiCalls)),
      medianToolCalls: median(group.map((attempt) => attempt.trace?.toolCalls)),
      medianInputTokens: median(
        group.map((attempt) => attempt.trace?.inputTokens),
      ),
      medianOutputTokens: median(
        group.map((attempt) => attempt.trace?.outputTokens),
      ),
      medianElapsedSec: median(
        group.map((attempt) =>
          attempt.elapsedMs == null ? null : attempt.elapsedMs / 1000,
        ),
      ),
      verifierVersions: [
        ...new Set(group.map((attempt) => attempt.verdict.verifierVersion)),
      ],
    });
  }
  return rows.sort(
    (a, b) => a.task.localeCompare(b.task) || a.label.localeCompare(b.label),
  );
}

function hasIntegrityFlag(attempt) {
  const integrity = attempt.verdict.integrity ?? {};
  return (
    (integrity.protectedFilesChanged?.length ?? 0) > 0 ||
    (integrity.outOfScopeChanges?.length ?? 0) > 0
  );
}

export function median(values) {
  const numbers = values
    .filter((value) => typeof value === "number" && Number.isFinite(value))
    .sort((a, b) => a - b);
  if (numbers.length === 0) return null;
  const middle = Math.floor(numbers.length / 2);
  return numbers.length % 2
    ? numbers[middle]
    : (numbers[middle - 1] + numbers[middle]) / 2;
}

export function buildCharts(routing, endToEnd) {
  const charts = [];
  if (routing.rows.length) {
    charts.push({
      title: "First-turn routing pass rate",
      spec: {
        $schema: "https://vega.github.io/schema/vega-lite/v5.json",
        data: { values: routing.rows },
        mark: "bar",
        encoding: {
          y: { field: "label", type: "nominal", title: null },
          yOffset: { field: "promptProfile" },
          x: {
            field: "passRate",
            type: "quantitative",
            title: "Pass rate (valid responses)",
            scale: { domain: [0, 1] },
            axis: { format: "%" },
          },
          color: { field: "promptProfile", title: "Prompt profile" },
          tooltip: [
            "label",
            "model",
            "promptProfile",
            "passed",
            "responses",
            "errors",
            "harnessRevision",
          ],
        },
      },
    });
    charts.push({
      title: "Routing pass rate by probe",
      spec: {
        $schema: "https://vega.github.io/schema/vega-lite/v5.json",
        data: {
          values: routing.taskRows.map((row) => ({
            ...row,
            series: `${row.label} (${row.promptProfile})`,
          })),
        },
        mark: "rect",
        encoding: {
          x: { field: "series", type: "nominal", title: null },
          y: { field: "task", type: "nominal", title: null },
          color: {
            field: "passRate",
            type: "quantitative",
            scale: { domain: [0, 1], scheme: "redyellowgreen" },
            title: "Pass rate",
          },
          tooltip: ["series", "task", "passed", "valid"],
        },
      },
    });
  }
  if (endToEnd.length) {
    charts.push({
      title: "End-to-end verified solve rate (unassisted)",
      spec: {
        $schema: "https://vega.github.io/schema/vega-lite/v5.json",
        data: { values: endToEnd },
        mark: "bar",
        encoding: {
          x: { field: "task", type: "nominal", title: null },
          xOffset: { field: "label" },
          y: {
            field: "solveRate",
            type: "quantitative",
            title: "Solved / attempts",
            scale: { domain: [0, 1] },
            axis: { format: "%" },
          },
          color: { field: "label", title: "Model" },
          tooltip: [
            "label",
            "task",
            "unassistedSolved",
            "attempts",
            "interventions",
            "integrityFlags",
          ],
        },
      },
    });
    charts.push({
      title: "Median model requests per attempt",
      spec: {
        $schema: "https://vega.github.io/schema/vega-lite/v5.json",
        data: { values: endToEnd.filter((row) => row.medianApiCalls != null) },
        mark: "bar",
        encoding: {
          x: { field: "task", type: "nominal", title: null },
          xOffset: { field: "label" },
          y: {
            field: "medianApiCalls",
            type: "quantitative",
            title: "Model requests",
          },
          color: { field: "label", title: "Model" },
          tooltip: [
            "label",
            "task",
            "medianApiCalls",
            "medianToolCalls",
            "medianInputTokens",
            "medianOutputTokens",
            "medianElapsedSec",
          ],
        },
      },
    });
  }
  return charts;
}

export function renderMarkdown({ generatedAt, routing, endToEnd, charts }) {
  const lines = [
    `# AgentLink model bench`,
    ``,
    `Generated ${generatedAt}.`,
    ``,
  ];
  lines.push(`## First-turn routing`, ``);
  if (routing.rows.length) {
    lines.push(
      table(
        [
          "Model",
          "Profile",
          "Transport",
          "Pass rate",
          "Passed",
          "Responses",
          "Errors",
          "Revision",
        ],
        routing.rows.map((row) => [
          row.label,
          row.promptProfile,
          transportLabel(row),
          percent(row.passRate),
          row.passed,
          row.responses,
          row.errors,
          row.harnessRevision ?? "unknown",
        ]),
      ),
      ``,
      `Latest report per model and profile. Errors are excluded from the pass rate.`,
      ``,
    );
  } else {
    lines.push(`No routing reports yet. Run \`mise run bench:routing\`.`, ``);
  }
  lines.push(`## End-to-end fixture tasks`, ``);
  if (endToEnd.length) {
    lines.push(
      table(
        [
          "Task",
          "Model",
          "Solved",
          "Interventions",
          "Stopped",
          "Infra failures",
          "Integrity flags",
          "Median requests",
          "Median tool calls",
          "Median elapsed (s)",
        ],
        endToEnd.map((row) => [
          row.task,
          row.label,
          `${row.unassistedSolved}/${row.attempts}`,
          row.interventions,
          row.stopped,
          row.infraFailures,
          row.integrityFlags,
          row.medianApiCalls ?? "n/a",
          row.medianToolCalls ?? "n/a",
          row.medianElapsedSec == null
            ? "n/a"
            : Math.round(row.medianElapsedSec),
        ]),
      ),
      ``,
      `Solved means every held-out, public and static check passed without intervention. Stopped counts attempts ended by a time or request cap, a question the model needed answered, or a chat error. Infra failures (harness or gateway problems) are excluded from the attempt count. Integrity flags count attempts that changed tests, package.json or files outside the task's expected set.`,
      ``,
    );
  } else {
    lines.push(
      `No scored attempts yet. Run \`mise run bench:run\`, or \`mise run bench:prepare <task>\` and \`mise run bench:score\` by hand.`,
      ``,
    );
  }
  for (const chart of charts) {
    lines.push(
      `### ${chart.title}`,
      ``,
      "```vega-lite",
      JSON.stringify(chart.spec, null, 2),
      "```",
      ``,
    );
  }
  return lines.join("\n");
}

export function renderHtml({ generatedAt, routing, endToEnd, charts }) {
  const embed = (chart, index) =>
    `<section><h2>${escapeHtml(chart.title)}</h2><div id="chart-${index}"></div></section>`;
  const specs = JSON.stringify(
    charts.map((chart) => ({
      ...chart.spec,
      width: "container",
      height: chart.spec.mark === "rect" ? { step: 22 } : 280,
    })),
  ).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>AgentLink model bench</title>
<script src="https://cdn.jsdelivr.net/npm/vega@5"></script>
<script src="https://cdn.jsdelivr.net/npm/vega-lite@5"></script>
<script src="https://cdn.jsdelivr.net/npm/vega-embed@6"></script>
<style>
body { font: 14px system-ui, sans-serif; margin: 2rem auto; max-width: 1100px; color: #222; }
h1 { border-bottom: 3px solid #4EC9B0; padding-bottom: .3rem; }
section > div { width: 100%; }
table { border-collapse: collapse; margin: 1rem 0; }
th, td { border: 1px solid #ddd; padding: .3rem .6rem; text-align: left; }
th { background: #f4f4f4; }
.note { color: #666; }
</style>
</head>
<body>
<h1>AgentLink model bench</h1>
<p class="note">Generated ${escapeHtml(generatedAt)}. Routing uses the latest report per model and profile; end-to-end solves are verified by the bench scorer, never the agent's own claim.</p>
${htmlTable(
  "First-turn routing",
  [
    "Model",
    "Profile",
    "Transport",
    "Pass rate",
    "Passed",
    "Responses",
    "Errors",
    "Revision",
  ],
  routing.rows.map((row) => [
    row.label,
    row.promptProfile,
    transportLabel(row),
    percent(row.passRate),
    row.passed,
    row.responses,
    row.errors,
    row.harnessRevision ?? "unknown",
  ]),
)}
${htmlTable(
  "End-to-end fixture tasks",
  [
    "Task",
    "Model",
    "Solved",
    "Interventions",
    "Stopped",
    "Infra failures",
    "Integrity flags",
    "Median requests",
    "Median elapsed (s)",
  ],
  endToEnd.map((row) => [
    row.task,
    row.label,
    `${row.unassistedSolved}/${row.attempts}`,
    row.interventions,
    row.stopped,
    row.infraFailures,
    row.integrityFlags,
    row.medianApiCalls ?? "n/a",
    row.medianElapsedSec == null ? "n/a" : Math.round(row.medianElapsedSec),
  ]),
)}
${charts.map(embed).join("\n")}
<script>
const specs = ${specs};
specs.forEach((spec, index) => vegaEmbed("#chart-" + index, spec, { actions: false }));
</script>
</body>
</html>
`;
}

export function writeReport(benchDir, outDir = path.join(benchDir, "report")) {
  const routing = summarizeRouting(loadRoutingReports(benchDir));
  const attempts = loadAttempts(benchDir);
  const endToEnd = summarizeAttempts(attempts);
  const charts = buildCharts(routing, endToEnd);
  const generatedAt = new Date().toISOString();
  const model = { generatedAt, routing, endToEnd, charts };
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, "data.json"),
    JSON.stringify(
      { generatedAt, routing, endToEnd, attempts: attempts.length },
      null,
      2,
    ),
  );
  fs.writeFileSync(path.join(outDir, "summary.md"), renderMarkdown(model));
  fs.writeFileSync(path.join(outDir, "index.html"), renderHtml(model));
  return { outDir, routing, endToEnd };
}

function table(headers, rows) {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

function htmlTable(title, headers, rows) {
  if (!rows.length) {
    return `<h2>${escapeHtml(title)}</h2><p class="note">No data yet.</p>`;
  }
  return `<h2>${escapeHtml(title)}</h2><table><thead><tr>${headers
    .map((header) => `<th>${escapeHtml(header)}</th>`)
    .join("")}</tr></thead><tbody>${rows
    .map(
      (row) =>
        `<tr>${row.map((cell) => `<td>${escapeHtml(String(cell))}</td>`).join("")}</tr>`,
    )
    .join("")}</tbody></table>`;
}

function transportLabel(row) {
  return row.reasoningEffort
    ? `${row.transport} (${row.reasoningEffort})`
    : row.transport;
}

function percent(value) {
  return value == null ? "n/a" : `${Math.round(value * 1000) / 10}%`;
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
