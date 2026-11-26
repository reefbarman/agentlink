import {
  STORAGE_TESTS,
  stagePlan,
  storageTestMode,
  testStages,
  workspaceStages,
} from "./run-tests.mjs";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";

import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

function fixture(t, workspaces) {
  const root = mkdtempSync(path.join(os.tmpdir(), "run-tests-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ workspaces: ["packages/*", "apps/*"] }),
  );
  for (const [workspace, scripts] of Object.entries(workspaces)) {
    mkdirSync(path.join(root, workspace), { recursive: true });
    if (scripts === null) continue;
    writeFileSync(
      path.join(root, workspace, "package.json"),
      JSON.stringify({ scripts }),
    );
  }
  mkdirSync(path.join(root, "apps"), { recursive: true });
  return root;
}

test("runs every workspace with a test script, in npm --workspaces order", (t) => {
  const root = fixture(t, {
    "packages/zeta": { test: "vitest run" },
    "packages/alpha": { test: "vitest run" },
    "packages/no-tests": { build: "tsc" },
    "packages/not-a-package": null,
    "apps/server": { test: "vitest run" },
    "apps/cli": { test: "vitest run" },
  });

  assert.deepEqual(
    workspaceStages(root).map((stage) => [stage.name, stage.args]),
    [
      ["packages/alpha", ["run", "test", "--workspace", "packages/alpha"]],
      ["packages/zeta", ["run", "test", "--workspace", "packages/zeta"]],
      ["apps/cli", ["run", "test", "--workspace", "apps/cli"]],
      ["apps/server", ["run", "test", "--workspace", "apps/server"]],
    ],
  );
});

test("runs root vitest first and the script suites last", (t) => {
  const root = fixture(t, { "packages/core": { test: "vitest run" } });

  assert.deepEqual(
    testStages(root).map((stage) => stage.name),
    ["root vitest", "packages/core", "scripts"],
  );
});

test("leaves the storage tests out locally and includes them in CI", () => {
  assert.equal(storageTestMode([], {}), "skip");
  assert.equal(storageTestMode([], { CI: "true" }), "include");
  assert.equal(storageTestMode(["--all"], {}), "include");
  assert.equal(storageTestMode(["--storage"], { CI: "true" }), "only");
  // The explicit setting wins over CI, which preflight sets on every step.
  assert.equal(
    storageTestMode([], { CI: "true", AGENTLINK_STORAGE_TESTS: "0" }),
    "skip",
  );
  assert.equal(
    storageTestMode([], { AGENTLINK_STORAGE_TESTS: "1" }),
    "include",
  );
});

test("excludes or selects the storage tests in the root vitest stage", (t) => {
  const root = fixture(t, { "packages/core": { test: "vitest run" } });
  const vitestArgs = (storage) =>
    testStages(root, { storage })[0].args.slice(1);

  assert.deepEqual(vitestArgs("include"), ["run"]);
  assert.deepEqual(vitestArgs("skip"), [
    "run",
    ...STORAGE_TESTS.excludes.flatMap((glob) => ["--exclude", glob]),
  ]);
  assert.deepEqual(
    testStages(root, { storage: "only" }).map((stage) => [
      stage.name,
      stage.args.slice(1),
    ]),
    [["storage tests", ["run", ...STORAGE_TESTS.filters]]],
  );
});

test("runs root vitest alone, then apps/server beside the small stages", (t) => {
  const root = fixture(t, {
    "packages/core": { test: "vitest run" },
    "apps/cli": { test: "vitest run" },
    "apps/server": { test: "vitest run" },
  });
  const names = (plan) =>
    plan.map((step) => step.map((lane) => lane.map((stage) => stage.name)));

  assert.deepEqual(names(stagePlan(testStages(root))), [
    [["root vitest"]],
    [["apps/server"], ["packages/core", "apps/cli", "scripts"]],
  ]);
  assert.deepEqual(names(stagePlan(testStages(root), { serial: true })), [
    [["root vitest"]],
    [["packages/core"]],
    [["apps/cli"]],
    [["apps/server"]],
    [["scripts"]],
  ]);
  // Nothing to overlap: the storage tests alone, or no server workspace.
  assert.deepEqual(names(stagePlan(testStages(root, { storage: "only" }))), [
    [["storage tests"]],
  ]);
  const withoutServer = fixture(t, { "packages/core": { test: "vitest run" } });
  assert.deepEqual(names(stagePlan(testStages(withoutServer))), [
    [["root vitest"]],
    [["packages/core"]],
    [["scripts"]],
  ]);
});

test("covers every real workspace", () => {
  const names = testStages().map((stage) => stage.name);
  for (const workspace of ["packages/core", "apps/server", "apps/desktop"]) {
    assert.ok(names.includes(workspace), workspace);
  }
});
