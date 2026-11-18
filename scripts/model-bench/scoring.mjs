// Independent verifier for the agent-eval fixture tasks.
//
// A verdict never trusts the workspace's own tests or package scripts: the
// scorer copies the finished workspace into a disposable directory, restores
// the pristine tests and package.json, runs held-out behaviour checks plus the
// public test, and adds static checks for things tests cannot see (old names
// left behind, missing docs). Bump VERIFIER_VERSION whenever a check changes so
// scorecards from different verifiers are never compared.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

export const VERIFIER_VERSION = "1";

const BENCH_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(BENCH_DIR, "..", "..");
export const FIXTURE_ROOT = path.join(
  REPO_ROOT,
  "fixtures",
  "agent-eval-workspace",
);
export const WORK_DIR = path.join(FIXTURE_ROOT, "work");
const HOLDOUT_DIR = path.join(BENCH_DIR, "holdout");
const CONTROLS_DIR = path.join(BENCH_DIR, "controls");
const RESULT_MARKER = "__MODEL_BENCH_RESULTS__";
const RUN_TIMEOUT_MS = 20_000;
const IGNORED_ENTRIES = new Set(["node_modules", ".git", ".DS_Store"]);

/** Scored coding tasks. architect-plan needs a human rubric and is excluded. */
export const SCORED_TASK_IDS = [
  "multi-file-refactor",
  "small-ts-bugfix",
  "tool-contract-docs",
];

/** Every control must produce this verdict, or the task is not calibrated. */
export const CONTROL_EXPECTATIONS = {
  "no-change": false,
  partial: false,
  reference: true,
};

const STATIC_CHECKS = {
  "multi-file-refactor": (dir) => {
    const offenders = listFiles(dir)
      .filter((file) => file.startsWith("src/") && file.endsWith(".js"))
      .filter((file) =>
        /\b(formatCents|addCents)\b/.test(readText(dir, file) ?? ""),
      );
    return [
      {
        id: "no-old-references",
        pass: offenders.length === 0,
        ...(offenders.length
          ? { detail: `old helper names remain in ${offenders.join(", ")}` }
          : {}),
      },
    ];
  },
  "tool-contract-docs": (dir) => {
    const rows = markdownTableRows(readText(dir, "docs/tools.md") ?? "");
    const row = (name) =>
      rows.find((cells) => cells.some((cell) => cell.includes(name)));
    const tags = row("includeTags");
    const tagsDocumented =
      tags !== undefined &&
      tags.some((cell) => /^boolean$/i.test(cell)) &&
      tags.some((cell) => /^(no|false|optional)$/i.test(cell));
    const missing = ["noteId", "maxWords"].filter((name) => !row(name));
    return [
      {
        id: "docs-include-tags-row",
        pass: tagsDocumented,
        ...(tagsDocumented
          ? {}
          : {
              detail: tags
                ? "includeTags row does not say boolean and optional"
                : "docs/tools.md has no includeTags table row",
            }),
      },
      {
        id: "docs-existing-rows-preserved",
        pass: missing.length === 0,
        ...(missing.length
          ? { detail: `missing rows: ${missing.join(", ")}` }
          : {}),
      },
    ];
  },
};

export function loadTask(taskId) {
  if (!SCORED_TASK_IDS.includes(taskId)) {
    throw new Error(
      `Unknown or unscored task "${taskId}". Scored tasks: ${SCORED_TASK_IDS.join(", ")}`,
    );
  }
  const definition = JSON.parse(
    fs.readFileSync(path.join(FIXTURE_ROOT, "tasks", `${taskId}.json`), "utf8"),
  );
  return {
    ...definition,
    pristineDir: path.resolve(REPO_ROOT, definition.pristine),
  };
}

export function fixtureDigest(dir) {
  const hash = crypto.createHash("sha256");
  for (const file of listFiles(dir)) {
    hash.update(file);
    hash.update("\0");
    hash.update(fs.readFileSync(path.join(dir, file)));
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}

/**
 * Score a finished workspace. Never mutates `workDir`.
 * @returns {{taskId: string, verifierVersion: string, solved: boolean,
 *   checks: Array<{id: string, pass: boolean, detail?: string}>,
 *   integrity: {protectedFilesChanged: string[], outOfScopeChanges: string[]},
 *   changedFiles: string[]}}
 */
export function scoreWorkspace(taskId, workDir) {
  const task = loadTask(taskId);
  if (!fs.existsSync(workDir)) {
    throw new Error(`Workspace not found: ${workDir}`);
  }
  const changedFiles = diffTrees(task.pristineDir, workDir);
  const protectedFilesChanged = changedFiles.filter(isProtectedFile);
  const expected = new Set(task.expectedFiles ?? []);
  const outOfScopeChanges = changedFiles.filter(
    (file) => !isProtectedFile(file) && !expected.has(file),
  );

  const verifyDir = fs.mkdtempSync(path.join(os.tmpdir(), "model-bench-"));
  try {
    copyDir(workDir, verifyDir);
    restoreProtectedFiles(task.pristineDir, verifyDir);
    const checks = [
      ...runHoldout(taskId, verifyDir),
      runPublicTest(task.pristineDir, verifyDir),
      ...(STATIC_CHECKS[taskId]?.(verifyDir) ?? []),
    ];
    return {
      taskId,
      verifierVersion: VERIFIER_VERSION,
      solved: checks.length > 0 && checks.every((check) => check.pass),
      checks,
      integrity: { protectedFilesChanged, outOfScopeChanges },
      changedFiles,
    };
  } finally {
    fs.rmSync(verifyDir, { recursive: true, force: true });
  }
}

/** Score the no-change, partial and reference controls for each task. */
export function calibrate(taskIds = SCORED_TASK_IDS) {
  const rows = [];
  for (const taskId of taskIds) {
    const task = loadTask(taskId);
    for (const [control, expectedSolved] of Object.entries(
      CONTROL_EXPECTATIONS,
    )) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "model-bench-ctl-"));
      try {
        copyDir(task.pristineDir, dir);
        if (control !== "no-change") {
          const overlay = path.join(CONTROLS_DIR, taskId, control);
          if (!fs.existsSync(overlay)) {
            throw new Error(`Missing control ${overlay}`);
          }
          copyDir(overlay, dir);
        }
        const verdict = scoreWorkspace(taskId, dir);
        rows.push({
          taskId,
          control,
          expectedSolved,
          solved: verdict.solved,
          ok: verdict.solved === expectedSolved,
          failedChecks: verdict.checks
            .filter((check) => !check.pass)
            .map((check) => check.id),
        });
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  }
  return rows;
}

function runHoldout(taskId, verifyDir) {
  const benchDir = path.join(verifyDir, "__model_bench__");
  fs.mkdirSync(benchDir, { recursive: true });
  fs.copyFileSync(
    path.join(HOLDOUT_DIR, "check.mjs"),
    path.join(benchDir, "check.mjs"),
  );
  fs.copyFileSync(
    path.join(HOLDOUT_DIR, `${taskId}.mjs`),
    path.join(benchDir, "holdout.mjs"),
  );
  const result = runNode(verifyDir, [path.join(benchDir, "holdout.mjs")]);
  const line = result.stdout
    .split("\n")
    .find((entry) => entry.startsWith(RESULT_MARKER));
  if (!line) {
    return [
      {
        id: "holdout-run",
        pass: false,
        detail: `held-out checks did not report (exit ${result.status}): ${tail(result.stderr || result.stdout)}`,
      },
    ];
  }
  return JSON.parse(line.slice(RESULT_MARKER.length));
}

function runPublicTest(pristineDir, verifyDir) {
  const command = JSON.parse(
    fs.readFileSync(path.join(pristineDir, "package.json"), "utf8"),
  ).scripts?.test;
  const match = /^node\s+(\S+)$/.exec(command ?? "");
  if (!match) {
    return {
      id: "public-tests",
      pass: false,
      detail: `unsupported fixture test command: ${command}`,
    };
  }
  const result = runNode(verifyDir, [match[1]]);
  return result.status === 0
    ? { id: "public-tests", pass: true }
    : {
        id: "public-tests",
        pass: false,
        detail: tail(result.stderr || result.stdout),
      };
}

function runNode(cwd, args) {
  // Minimal environment: code under test never sees provider credentials.
  const result = spawnSync(process.execPath, args, {
    cwd,
    encoding: "utf8",
    timeout: RUN_TIMEOUT_MS,
    env: { PATH: process.env.PATH ?? "" },
  });
  return {
    status: result.error ? `error: ${result.error.message}` : result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function isProtectedFile(file) {
  return file === "package.json" || file.startsWith("test/");
}

function restoreProtectedFiles(pristineDir, verifyDir) {
  fs.rmSync(path.join(verifyDir, "test"), { recursive: true, force: true });
  for (const file of listFiles(pristineDir).filter(isProtectedFile)) {
    const target = path.join(verifyDir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(pristineDir, file), target);
  }
}

export function diffTrees(beforeDir, afterDir) {
  const before = new Set(listFiles(beforeDir));
  const after = new Set(listFiles(afterDir));
  const changed = [];
  for (const file of new Set([...before, ...after])) {
    if (!before.has(file) || !after.has(file)) {
      changed.push(file);
    } else if (
      !fs
        .readFileSync(path.join(beforeDir, file))
        .equals(fs.readFileSync(path.join(afterDir, file)))
    ) {
      changed.push(file);
    }
  }
  return changed.sort();
}

export function listFiles(dir, prefix = "") {
  if (!fs.existsSync(dir)) return [];
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORED_ENTRIES.has(entry.name)) continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...listFiles(path.join(dir, entry.name), relative));
    } else if (entry.isFile()) {
      files.push(relative);
    }
  }
  return files.sort();
}

export function copyDir(source, target) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (IGNORED_ENTRIES.has(entry.name)) continue;
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

function readText(dir, file) {
  const fullPath = path.join(dir, file);
  return fs.existsSync(fullPath)
    ? fs.readFileSync(fullPath, "utf8")
    : undefined;
}

function markdownTableRows(markdown) {
  return markdown
    .split("\n")
    .filter((line) => line.trim().startsWith("|"))
    .map((line) =>
      line
        .trim()
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((cell) => cell.trim().replace(/^`|`$/g, "")),
    );
}

function tail(text, max = 400) {
  const trimmed = text.trim();
  return trimmed.length > max ? `…${trimmed.slice(-max)}` : trimmed;
}
