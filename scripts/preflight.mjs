#!/usr/bin/env node
// Answers "will this commit pass CI?" before it is pushed.
//
// Checks out the exact commit (HEAD by default) into a temporary git worktree,
// so uncommitted files, including other agents' work in a shared checkout,
// cannot hide a missing change. Then runs what the CI `verify` job runs
// (npm ci, lint, build, test, packed SDK consumer), plus extra checks chosen
// from the files changed since the base ref. A pass is recorded against the
// commit's tree so the opt-in pre-push hook (.githooks/pre-push) can check it.
//
// Usage:
//   npm run preflight                  check HEAD against origin/main
//   npm run preflight -- --linux       also run lint/build/test in a Linux container
//   npm run preflight -- --base <ref>  choose the ref used to select extra checks
//   npm run preflight -- --force       rerun even if this tree already passed
//   npm run preflight -- --keep        keep the temporary worktree for debugging
//   node scripts/preflight.mjs --check-push   (pre-push hook; reads git's stdin)

import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ZERO_SHA = /^0+$/;

/** Extra checks keyed by the changed paths that make them worth running. */
export const PATH_TRIGGERED_CHECKS = Object.freeze([
  {
    id: "cli-bundle",
    reason:
      "CLI, shared packages, dependencies, or CLI packaging scripts changed",
    matches: (file) =>
      /^(apps\/cli\/|apps\/desktop\/package\.json$|packages\/|package(-lock)?\.json$|scripts\/(verify-cli|cli-|package-keychain|macos-signing|workspace-bundle))/.test(
        file,
      ),
  },
  {
    id: "actionlint",
    reason: "GitHub workflows changed",
    matches: (file) => file.startsWith(".github/workflows/"),
  },
]);

/** The extra check ids triggered by a list of changed files. */
export function selectTriggeredChecks(changedFiles) {
  return PATH_TRIGGERED_CHECKS.filter((check) =>
    changedFiles.some((file) => check.matches(file)),
  ).map((check) => check.id);
}

const SUMMARY_PATTERNS = [
  /^\s*FAIL\s/,
  /error TS\d+/,
  /Format issues found/,
  /^npm error /,
  /^not ok \d+/,
  /AssertionError/,
  /^\s*(Error|TypeError|ReferenceError):/,
  /^\s*[×✗]\s/,
  /out of date|drift/i,
];

const stripAnsi = (line) => line.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

/**
 * The lines worth showing from a failed step's log: failing tests, type and
 * format errors, npm errors. Falls back to the log's tail.
 */
export function summarizeFailure(log, { maxLines = 40, tailLines = 30 } = {}) {
  const lines = log.split(/\r?\n/).map(stripAnsi);
  const seen = new Set();
  const picked = [];
  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (!trimmed || seen.has(trimmed)) continue;
    if (SUMMARY_PATTERNS.some((pattern) => pattern.test(trimmed))) {
      seen.add(trimmed);
      picked.push(trimmed.slice(0, 300));
      if (picked.length >= maxLines) break;
    }
  }
  if (picked.length > 0) return picked;
  return lines
    .filter((line) => line.trim())
    .slice(-tailLines)
    .map((line) => line.slice(0, 300));
}

/**
 * Branch updates from git's pre-push stdin: `<local ref> <local sha> <remote
 * ref> <remote sha>` per line. Deletions and non-branch refs are skipped.
 */
export function parsePrePushInput(input) {
  return input
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .filter(
      ([localRef, localSha, remoteRef]) =>
        localRef &&
        localSha &&
        !ZERO_SHA.test(localSha) &&
        remoteRef?.startsWith("refs/heads/"),
    )
    .map(([localRef, localSha, remoteRef]) => ({
      localRef,
      localSha,
      remoteRef,
    }));
}

/** Major Node version from an .nvmrc value such as `22.19.0` or `v22`. */
export function nvmrcMajor(value) {
  const match = /^v?(\d+)/.exec(value.trim());
  return match ? Number(match[1]) : undefined;
}

function git(args, options = {}) {
  const result = spawnSync("git", args, { encoding: "utf8", ...options });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`,
    );
  }
  return result.stdout.trim();
}

function tryGit(args, options) {
  try {
    return git(args, options);
  } catch {
    return undefined;
  }
}

function stampDirectory(repoRoot) {
  const commonDir = path.resolve(
    repoRoot,
    git(["rev-parse", "--git-common-dir"], { cwd: repoRoot }),
  );
  return path.join(commonDir, "agentlink-preflight");
}

function readStamp(directory, tree) {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(directory, `${tree}.json`), "utf8"),
    );
  } catch {
    return undefined;
  }
}

function formatDuration(ms) {
  const seconds = Math.round(ms / 1000);
  return seconds >= 60
    ? `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`
    : `${seconds}s`;
}

function parseArgs(argv) {
  const options = {
    base: "origin/main",
    linux: false,
    force: false,
    keep: false,
    checkPush: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--base") options.base = argv[++index];
    else if (arg === "--linux") options.linux = true;
    else if (arg === "--force") options.force = true;
    else if (arg === "--keep") options.keep = true;
    else if (arg === "--check-push") options.checkPush = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    // git passes the remote name and URL to pre-push hooks; ignore them.
    else if (!options.checkPush) throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

/** The pre-push hook: every pushed branch tip needs a passing preflight. */
function checkPush(repoRoot) {
  const updates = parsePrePushInput(fs.readFileSync(0, "utf8"));
  const directory = stampDirectory(repoRoot);
  const missing = [];
  for (const update of updates) {
    const tree = tryGit(["rev-parse", `${update.localSha}^{tree}`], {
      cwd: repoRoot,
    });
    const stamp = tree && readStamp(directory, tree);
    if (!stamp?.passed)
      missing.push({ ...update, failed: stamp?.passed === false });
  }
  if (missing.length === 0) return 0;
  console.error("pre-push: no passing preflight for:");
  for (const { localSha, remoteRef, failed } of missing) {
    console.error(
      `  ${localSha.slice(0, 10)} -> ${remoteRef}${failed ? " (last preflight FAILED)" : ""}`,
    );
  }
  console.error(
    "\nRun `npm run preflight` on that commit, then push again.\n" +
      "Skip once with `git push --no-verify` or AGENTLINK_SKIP_PREFLIGHT=1.",
  );
  return 1;
}

function runStep(step, { cwd, logDirectory, env }) {
  const logPath = path.join(logDirectory, `${step.id}.log`);
  const fd = fs.openSync(logPath, "w");
  const started = Date.now();
  process.stdout.write(`- ${step.label} ... `);
  let status;
  try {
    const result = spawnSync("bash", ["-o", "pipefail", "-c", step.command], {
      cwd,
      env: { ...process.env, ...env, ...step.env },
      stdio: ["ignore", fd, fd],
    });
    status = result.status ?? 1;
  } finally {
    fs.closeSync(fd);
  }
  const ms = Date.now() - started;
  const passed = status === 0;
  console.log(`${passed ? "ok" : "FAILED"} (${formatDuration(ms)})`);
  return { id: step.id, label: step.label, passed, ms, log: logPath };
}

function buildSteps({ worktree, triggered, linux, nodeMajor, hasActionlint }) {
  const steps = [
    { id: "npm-ci", label: "npm ci", command: "npm ci", blocking: true },
    { id: "lint", label: "npm run lint", command: "npm run lint" },
    { id: "build", label: "npm run build", command: "npm run build" },
    { id: "test", label: "npm test", command: "npm test" },
    {
      id: "core-sdk-consumer",
      label: "npm run test:core-sdk-consumer",
      command: "npm run test:core-sdk-consumer",
    },
  ];
  if (triggered.includes("cli-bundle")) {
    steps.push({
      id: "cli-bundle",
      label: "npm run cli:bundle + packaged CLI smoke",
      command: [
        "npm run cli:bundle",
        "bundle=cli-releases/$(node -e 'import(\"./scripts/cli-targets.mjs\").then(m => process.stdout.write(m.cliBundleName(m.resolveCliTarget().id)))')",
        '"$bundle/bin/agentlink" --help',
        'node apps/cli/smoke-tui.mjs "$bundle/bin/agentlink" --executable --no-color',
      ].join(" && "),
      env: { AGENTLINK_MAC_SIGNING: "unsigned" },
    });
  }
  if (triggered.includes("actionlint") && hasActionlint) {
    steps.push({
      id: "actionlint",
      label: "actionlint",
      command: "actionlint",
    });
  }
  if (linux) {
    // git archive streams exactly the committed tree into the container, so
    // host node_modules and native binaries never leak in.
    const inner = [
      "set -e",
      // Read the archive from stdin first, before anything else can consume it.
      "mkdir /work && cd /work && tar -x",
      "apt-get update -qq </dev/null",
      "apt-get install -y -qq --no-install-recommends zsh </dev/null >/dev/null",
      "git init -q && git add -A && git -c user.name=preflight -c user.email=preflight@localhost commit -qm preflight",
      "npm ci",
      "e=0",
      "npm run lint || e=1",
      "npm run build || e=1",
      "npm test || e=1",
      "exit $e",
    ].join("\n");
    steps.push({
      id: "linux",
      label: `Linux container (node:${nodeMajor}): lint, build, test`,
      command: `git archive --format=tar HEAD | docker run --rm -i -e CI=true -v agentlink-preflight-npm:/root/.npm node:${nodeMajor}-bookworm bash -c ${shellQuote(inner)}`,
    });
  }
  return steps.map((step) => ({ ...step, cwd: worktree }));
}

function shellQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function hasCommand(command) {
  return spawnSync("bash", ["-c", `command -v ${command}`]).status === 0;
}

async function preflight(repoRoot, options) {
  const head = git(["rev-parse", "HEAD"], { cwd: repoRoot });
  const tree = git(["rev-parse", "HEAD^{tree}"], { cwd: repoRoot });
  const directory = stampDirectory(repoRoot);
  const existing = readStamp(directory, tree);
  if (
    existing?.passed &&
    !options.force &&
    (!options.linux || existing.linux)
  ) {
    console.log(
      `preflight: tree ${tree.slice(0, 10)} (HEAD ${head.slice(0, 10)}) already passed at ${existing.finishedAt}. Use --force to rerun.`,
    );
    return 0;
  }

  const warnings = [];
  const dirty = git(["status", "--porcelain", "--untracked-files=no"], {
    cwd: repoRoot,
  });
  if (dirty) {
    warnings.push(
      "Uncommitted tracked changes are NOT included. Preflight checks the committed HEAD only.",
    );
  }
  const nvmrc = fs.readFileSync(path.join(repoRoot, ".nvmrc"), "utf8");
  const nodeMajor = nvmrcMajor(nvmrc) ?? 22;
  const localMajor = Number(process.versions.node.split(".")[0]);
  if (localMajor !== nodeMajor) {
    warnings.push(
      `Local Node ${process.versions.node} differs from .nvmrc (${nvmrc.trim()}), which CI uses. npm resolution and runtime behaviour can differ; use --linux to check on Node ${nodeMajor}.`,
    );
  }

  const mergeBase = tryGit(["merge-base", options.base, "HEAD"], {
    cwd: repoRoot,
  });
  let changedFiles = [];
  if (mergeBase) {
    changedFiles = git(["diff", "--name-only", mergeBase, "HEAD"], {
      cwd: repoRoot,
    })
      .split("\n")
      .filter(Boolean);
  } else {
    warnings.push(
      `Could not find a merge base with ${options.base}; running every path-triggered check.`,
    );
  }
  const triggered = mergeBase
    ? selectTriggeredChecks(changedFiles)
    : PATH_TRIGGERED_CHECKS.map((check) => check.id);
  const hasActionlint = hasCommand("actionlint");
  if (triggered.includes("actionlint") && !hasActionlint) {
    warnings.push(
      "Workflows changed but actionlint is not installed (brew install actionlint); skipped.",
    );
  }
  if (options.linux && !hasCommand("docker")) {
    throw new Error("--linux needs docker (for example, Colima) on PATH.");
  }

  const logDirectory = path.join(directory, tree);
  fs.rmSync(logDirectory, { recursive: true, force: true });
  fs.mkdirSync(logDirectory, { recursive: true });
  // Not under os.tmpdir(): sandbox and path tests treat a workspace inside the
  // temporary root as an escape. Kept short because some sandbox tests size
  // environment budgets from paths under the checkout; this stays close to
  // the length of CI's /home/runner/work/agentlink/agentlink.
  const worktreeRoot = path.join(os.homedir(), ".cache", "alpf");
  fs.mkdirSync(worktreeRoot, { recursive: true });
  const worktree = fs.mkdtempSync(path.join(worktreeRoot, "w-"));

  console.log(
    `preflight: HEAD ${head.slice(0, 10)}, ${changedFiles.length} file(s) changed since ${options.base}`,
  );
  for (const warning of warnings) console.log(`  warning: ${warning}`);
  if (triggered.length) console.log(`  extra checks: ${triggered.join(", ")}`);

  const started = Date.now();
  const results = [];
  const cleanup = () => {
    if (options.keep) return;
    tryGit(["worktree", "remove", "--force", worktree], { cwd: repoRoot });
    fs.rmSync(worktree, { recursive: true, force: true });
    tryGit(["worktree", "prune"], { cwd: repoRoot });
  };
  const onSignal = () => {
    cleanup();
    process.exit(130);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    git(["worktree", "add", "--detach", "--quiet", worktree, head], {
      cwd: repoRoot,
    });
    const steps = buildSteps({
      worktree,
      triggered,
      linux: options.linux,
      nodeMajor,
      hasActionlint,
    });
    for (const step of steps) {
      const result = runStep(step, {
        cwd: step.cwd,
        logDirectory,
        env: { CI: "true", NO_COLOR: "1", FORCE_COLOR: "0" },
      });
      results.push(result);
      // Nothing else can run without dependencies.
      if (!result.passed && step.blocking) break;
    }
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    cleanup();
  }

  const passed = results.every((result) => result.passed);
  const stamp = {
    head,
    tree,
    passed,
    linux: options.linux && passed,
    node: process.versions.node,
    base: options.base,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    steps: results,
  };
  fs.writeFileSync(
    path.join(directory, `${tree}.json`),
    `${JSON.stringify(stamp, null, 2)}\n`,
  );

  console.log(
    `\npreflight ${passed ? "PASSED" : "FAILED"} in ${formatDuration(stamp.durationMs)}`,
  );
  for (const result of results.filter((result) => !result.passed)) {
    console.log(`\n== ${result.label} failed. Full log: ${result.log}`);
    const summary = summarizeFailure(fs.readFileSync(result.log, "utf8"));
    for (const line of summary) console.log(`  ${line}`);
  }
  if (options.keep) console.log(`\nWorktree kept at ${worktree}`);
  return passed ? 0 : 1;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    const source = fs.readFileSync(fileURLToPath(import.meta.url), "utf8");
    console.log(
      source
        .split("\n")
        .slice(1)
        .filter((line) => line.startsWith("//"))
        .map((line) => line.replace(/^\/\/ ?/, ""))
        .join("\n"),
    );
    return 0;
  }
  const repoRoot = git(["rev-parse", "--show-toplevel"]);
  if (options.checkPush) return checkPush(repoRoot);
  return preflight(repoRoot, options);
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(`preflight: ${error.message}`);
      process.exit(2);
    },
  );
}
