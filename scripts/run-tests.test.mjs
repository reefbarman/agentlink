import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { testStages, workspaceStages } from "./run-tests.mjs";

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

test("covers every real workspace", () => {
  const names = testStages().map((stage) => stage.name);
  for (const workspace of ["packages/core", "apps/server", "apps/desktop"]) {
    assert.ok(names.includes(workspace), workspace);
  }
});
