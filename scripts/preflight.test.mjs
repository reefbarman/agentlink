import {
  nvmrcMajor,
  parsePrePushInput,
  selectTriggeredChecks,
  summarizeFailure,
} from "./preflight.mjs";

import assert from "node:assert/strict";
import test from "node:test";

test("selects the CLI bundle check for CLI, package, and lockfile changes", () => {
  for (const file of [
    "apps/cli/src/index.ts",
    "packages/node-host/src/keychainSecretStorage.ts",
    "package-lock.json",
    "apps/desktop/package.json",
    "scripts/verify-cli-bundle.mjs",
  ]) {
    assert.deepEqual(selectTriggeredChecks([file]), ["cli-bundle"], file);
  }
  assert.deepEqual(
    selectTriggeredChecks(["src/agent/AgentSession.ts", "README.md"]),
    [],
  );
  assert.deepEqual(selectTriggeredChecks([".github/workflows/ci.yml"]), [
    "actionlint",
  ]);
});

test("summarizes failing tests, type errors, and npm errors without ANSI codes", () => {
  const log = [
    " ✓ src/ok.test.ts (3 tests)",
    "\x1b[41m FAIL \x1b[49m src/broken.test.ts > suite > case",
    "AssertionError: expected 1 to be 2",
    "src/a.ts(1,2): error TS2322: Type 'string' is not assignable",
    "npm error code ERESOLVE",
    "npm error code ERESOLVE",
  ].join("\n");
  assert.deepEqual(summarizeFailure(log), [
    " FAIL  src/broken.test.ts > suite > case",
    "AssertionError: expected 1 to be 2",
    "src/a.ts(1,2): error TS2322: Type 'string' is not assignable",
    "npm error code ERESOLVE",
  ]);
});

test("falls back to the log tail when nothing recognisable failed", () => {
  const log = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
  const summary = summarizeFailure(log, { tailLines: 3 });
  assert.deepEqual(summary, ["line 47", "line 48", "line 49"]);
});

test("parses branch updates from pre-push input and skips deletions and tags", () => {
  const sha = "a".repeat(40);
  const zero = "0".repeat(40);
  const input = [
    `refs/heads/main ${sha} refs/heads/main ${zero}`,
    `(delete) ${zero} refs/heads/old ${sha}`,
    `refs/tags/v1 ${sha} refs/tags/v1 ${zero}`,
    "",
  ].join("\n");
  assert.deepEqual(parsePrePushInput(input), [
    {
      localRef: "refs/heads/main",
      localSha: sha,
      remoteRef: "refs/heads/main",
    },
  ]);
});

test("reads the major version from .nvmrc", () => {
  assert.equal(nvmrcMajor("22.19.0\n"), 22);
  assert.equal(nvmrcMajor("v24"), 24);
  assert.equal(nvmrcMajor("lts/*"), undefined);
});
