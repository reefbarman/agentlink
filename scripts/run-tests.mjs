import { readFileSync, readdirSync } from "node:fs";

import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

// Runs the full `npm test` suite: builds workspace packages once, then runs
// the root vitest suite, every workspace's `test` script (in its own folder, as
// `npm run test --workspaces` does) and the `scripts/*.test.mjs` suites.
//
// Every stage runs even when an earlier one fails, so one run reports every
// failing stage instead of hiding the rest, then prints per-stage timings. The
// exit code is non-zero when any stage failed.
//
// Root vitest runs alone: it keeps most cores busy, and running everything in
// parallel was measured to be slower on an 18-core machine and tripped test
// timeouts. `apps/server` is different: its tests mostly wait on child
// processes and timers, so the small stages (packages, cli, desktop, scripts)
// run one after another beside it. Overlapped stages print their output as a
// block when they finish. `npm test -- --serial` runs one stage at a time.
//
// The storage tests (real LanceDB stores and forked indexer workers) are the
// most CPU-hungry part of the root suite and only matter when that code
// changes, so a local `npm test` leaves them out:
//   npm test                 everything except the storage tests
//   npm run test:storage     only the storage tests
//   npm test -- --all        everything
// CI (any run with `CI` set) runs everything. AGENTLINK_STORAGE_TESTS=1 or 0
// overrides both; preflight uses it to follow the changed paths.

const repoRoot = path.resolve(import.meta.dirname, "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

/** The storage tests, as vitest file filters and as exclude globs. */
export const STORAGE_TESTS = Object.freeze({
  filters: ["src/storage/retrieval/", "src/indexer/workerFixture"],
  excludes: [
    "src/storage/retrieval/**/*.test.ts",
    "src/indexer/workerFixture*.test.ts",
  ],
});

/** Whether a run should `skip`, `include`, or run `only` the storage tests. */
export function storageTestMode(argv = [], env = {}) {
  if (argv.includes("--storage")) return "only";
  if (argv.includes("--all")) return "include";
  if (env.AGENTLINK_STORAGE_TESTS === "1") return "include";
  if (env.AGENTLINK_STORAGE_TESTS === "0") return "skip";
  return env.CI ? "include" : "skip";
}

export function workspaceStages(root = repoRoot) {
  const rootManifest = JSON.parse(
    readFileSync(path.join(root, "package.json"), "utf8"),
  );
  const stages = [];
  for (const pattern of rootManifest.workspaces ?? []) {
    if (!pattern.endsWith("/*")) {
      throw new Error(`Unsupported workspace pattern: ${pattern}`);
    }
    const parent = pattern.slice(0, -2);
    const entries = readdirSync(path.join(root, parent), {
      withFileTypes: true,
    });
    const workspaces = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const workspace = `${parent}/${entry.name}`;
      let manifest;
      try {
        manifest = JSON.parse(
          readFileSync(path.join(root, workspace, "package.json"), "utf8"),
        );
      } catch (error) {
        if (error?.code === "ENOENT") continue;
        throw error;
      }
      if (manifest.scripts?.test) workspaces.push(workspace);
    }
    for (const workspace of workspaces.sort()) {
      stages.push({
        name: workspace,
        command: npm,
        args: ["run", "test", "--workspace", workspace],
      });
    }
  }
  return stages;
}

export function testStages(root = repoRoot, { storage = "include" } = {}) {
  const vitest = [path.join(root, "node_modules/vitest/vitest.mjs"), "run"];
  if (storage === "only") {
    return [
      {
        name: "storage tests",
        command: process.execPath,
        args: [...vitest, ...STORAGE_TESTS.filters],
      },
    ];
  }
  return [
    {
      name: "root vitest",
      command: process.execPath,
      args:
        storage === "skip"
          ? [
              ...vitest,
              ...STORAGE_TESTS.excludes.flatMap((glob) => ["--exclude", glob]),
            ]
          : vitest,
    },
    ...workspaceStages(root),
    { name: "scripts", command: npm, args: ["run", "test:scripts"] },
  ];
}

/** The stage whose tests mostly wait, so other stages can run beside it. */
const WAITING_STAGE = "apps/server";

/**
 * Groups stages into steps that run in order. A step is a list of lanes that
 * run at the same time; the stages in one lane run one after another.
 */
export function stagePlan(stages, { serial = false } = {}) {
  const alone = (stage) => [[stage]];
  const waiting = stages.find((stage) => stage.name === WAITING_STAGE);
  const [first, ...rest] = stages;
  const beside = rest.filter((stage) => stage !== waiting);
  if (serial || !waiting || waiting === first || beside.length === 0) {
    return stages.map(alone);
  }
  return [alone(first), [[waiting], beside]];
}

function formatDuration(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

function runStage(stage, { buffered = false } = {}) {
  const header = `\n━━━ ${stage.name} ━━━\n`;
  if (!buffered) process.stdout.write(header);
  const started = Date.now();
  return new Promise((resolve) => {
    const chunks = [];
    const child = spawn(stage.command, stage.args, {
      cwd: repoRoot,
      stdio: buffered ? ["ignore", "pipe", "pipe"] : "inherit",
      // A piped child drops colour; keep it when the terminal would show it.
      env:
        buffered && process.stdout.isTTY && !process.env.NO_COLOR
          ? { FORCE_COLOR: "1", ...process.env }
          : process.env,
    });
    child.stdout?.on("data", (chunk) => chunks.push(chunk));
    child.stderr?.on("data", (chunk) => chunks.push(chunk));
    const finish = (code, error) => {
      const result = {
        name: stage.name,
        passed: code === 0 && !error,
        ms: Date.now() - started,
      };
      // One write per stage, so two stages' output never interleaves.
      process.stdout.write(
        [
          buffered ? header : "",
          Buffer.concat(chunks).toString("utf8"),
          error ? `${error.message}\n` : "",
          `━━━ ${result.name}: ${result.passed ? "passed" : "FAILED"} (${formatDuration(result.ms)}) ━━━\n`,
        ].join(""),
      );
      resolve(result);
    };
    child.once("error", (error) => finish(null, error));
    child.once("close", (code) => finish(code));
  });
}

async function runLane(lane, options) {
  const results = [];
  for (const stage of lane) results.push(await runStage(stage, options));
  return results;
}

async function main() {
  const started = Date.now();
  const build = await runStage({
    name: "build:workspaces",
    command: npm,
    args: ["run", "build:workspaces"],
  });
  if (!build.passed) return 1;

  const argv = process.argv.slice(2);
  const storage = storageTestMode(argv, process.env);
  const stages = testStages(repoRoot, { storage });
  const byName = new Map();
  for (const step of stagePlan(stages, { serial: argv.includes("--serial") })) {
    const buffered = step.length > 1;
    if (buffered) {
      process.stdout.write(
        `\nRunning together: ${step.map((lane) => lane.map((stage) => stage.name).join(", ")).join(" | ")}\n`,
      );
    }
    const lanes = await Promise.all(
      step.map((lane) => runLane(lane, { buffered })),
    );
    for (const result of lanes.flat()) byName.set(result.name, result);
  }
  // Report in the stages' usual order, whatever order they finished in.
  const results = [build, ...stages.map((stage) => byName.get(stage.name))];

  const failed = results.filter((result) => !result.passed);
  process.stdout.write("\nTest stages:\n");
  for (const result of results) {
    process.stdout.write(
      `  ${result.passed ? "ok    " : "FAILED"} ${result.name} (${formatDuration(result.ms)})\n`,
    );
  }
  if (storage === "skip") {
    process.stdout.write(
      "  skipped storage tests (LanceDB stores, indexer workers): run `npm run test:storage` after changing that code, or `npm test -- --all`\n",
    );
  }
  process.stdout.write(
    `${failed.length === 0 ? "All test stages passed" : `${failed.length} test stage(s) failed: ${failed.map((result) => result.name).join(", ")}`} in ${formatDuration(Date.now() - started)}\n`,
  );
  return failed.length > 0 ? 1 : 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  process.exitCode = await main();
}
