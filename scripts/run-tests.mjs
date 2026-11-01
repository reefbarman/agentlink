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
// Stages run one at a time on purpose. Running them in parallel was measured
// to be slower on a busy 18-core machine and tripped test timeouts: the root
// suite alone keeps several cores busy, and every vitest process starts a
// worker per core.

const repoRoot = path.resolve(import.meta.dirname, "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

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

export function testStages(root = repoRoot) {
  return [
    {
      name: "root vitest",
      command: process.execPath,
      args: [path.join(root, "node_modules/vitest/vitest.mjs"), "run"],
    },
    ...workspaceStages(root),
    { name: "scripts", command: npm, args: ["run", "test:scripts"] },
  ];
}

function formatDuration(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

function runStage(stage) {
  process.stdout.write(`\n━━━ ${stage.name} ━━━\n`);
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(stage.command, stage.args, {
      cwd: repoRoot,
      stdio: "inherit",
    });
    const finish = (code, error) => {
      const result = {
        name: stage.name,
        passed: code === 0 && !error,
        ms: Date.now() - started,
      };
      if (error) process.stdout.write(`${error.message}\n`);
      process.stdout.write(
        `━━━ ${result.name}: ${result.passed ? "passed" : "FAILED"} (${formatDuration(result.ms)}) ━━━\n`,
      );
      resolve(result);
    };
    child.once("error", (error) => finish(null, error));
    child.once("close", (code) => finish(code));
  });
}

async function main() {
  const started = Date.now();
  const build = await runStage({
    name: "build:workspaces",
    command: npm,
    args: ["run", "build:workspaces"],
  });
  if (!build.passed) return 1;

  const results = [build];
  for (const stage of testStages()) results.push(await runStage(stage));

  const failed = results.filter((result) => !result.passed);
  process.stdout.write("\nTest stages:\n");
  for (const result of results) {
    process.stdout.write(
      `  ${result.passed ? "ok    " : "FAILED"} ${result.name} (${formatDuration(result.ms)})\n`,
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
