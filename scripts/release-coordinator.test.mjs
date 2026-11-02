import {
  holdUnclassifiedUnits,
  promoteUnreleased,
  pruneDecisions,
  readDecisionsCache,
} from "./release-coordinator.mjs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";

import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("holds only units that would release commits the AI never classified", () => {
  const release = (commits) => ({
    status: "release",
    version: "1.2.0",
    effectiveBump: "minor",
    breaking: false,
    usedReservation: false,
    consumedIntent: false,
    commits,
  });
  const planned = {
    vscode: release(["aaaaaaaa1", "bbbbbbbb2"]),
    cli: release(["aaaaaaaa1"]),
    sdk: release(["cccccccc3"]),
    desktop: { status: "skip", commits: ["bbbbbbbb2"] },
  };
  holdUnclassifiedUnits(planned, {
    candidateShas: ["aaaaaaaa1", "bbbbbbbb2", "cccccccc3"],
    decisions: { aaaaaaaa1: { bump: "patch" } },
    // Over the run budget: keeps the existing floor-only behaviour.
    omitted: ["cccccccc3"],
    reason: "HTTP 403",
  });
  assert.equal(planned.vscode.status, "hold");
  assert.equal(planned.vscode.version, undefined);
  assert.match(planned.vscode.reason, /unavailable.*bbbbbbbb/u);
  assert.equal(planned.vscode.classifierError, "HTTP 403");
  assert.equal(planned.cli.status, "release");
  assert.equal(planned.sdk.status, "release");
  assert.equal(planned.desktop.status, "skip");
});

test("decision cache tolerates missing or corrupt files and prunes released commits", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "release-cache-"));
  try {
    const file = path.join(dir, "decisions.json");
    assert.deepEqual(readDecisionsCache(file), {});
    assert.deepEqual(readDecisionsCache(undefined), {});
    writeFileSync(file, "{not json");
    assert.deepEqual(readDecisionsCache(file), {});
    writeFileSync(
      file,
      JSON.stringify({ schemaVersion: 1, decisions: { a: { bump: "patch" } } }),
    );
    assert.deepEqual(readDecisionsCache(file), { a: { bump: "patch" } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.deepEqual(pruneDecisions({ a: 1, b: 2 }, ["b", "c"]), { b: 2 });
});

test("moves Unreleased entries under the new version heading", () => {
  const changelog =
    "# Changelog\n\n## Unreleased\n\n- Added X.\n\n## 1.23.0\n\n- Old.\n";
  assert.equal(
    promoteUnreleased(changelog, "## 1.24.0", "- generated"),
    "# Changelog\n\n## Unreleased\n\n## 1.24.0\n\n- Added X.\n\n## 1.23.0\n\n- Old.\n",
  );
});

test("uses generated notes when Unreleased is empty", () => {
  assert.equal(
    promoteUnreleased(
      "# Changelog\n\n## Unreleased\n\n## 0.1.0\n",
      "## 0.2.0",
      "- Fixes Y.",
    ),
    "# Changelog\n\n## Unreleased\n\n## 0.2.0\n\n- Fixes Y.\n\n## 0.1.0\n",
  );
});

test("re-applying an unpublished preparation keeps one version section", () => {
  const prepared = promoteUnreleased(
    "# Changelog\n\n## Unreleased\n\n- Added X.\n\n## 1.23.0\n\n- Old.\n",
    "## 1.24.0",
    "- generated",
  );
  // A failed package job leaves the pushed preparation; the replan re-applies.
  assert.equal(
    promoteUnreleased(prepared, "## 1.24.0", "- generated"),
    prepared,
  );
  assert.equal(
    promoteUnreleased(
      prepared.replace("## Unreleased\n\n", "## Unreleased\n\n- Added Z.\n\n"),
      "## 1.24.0",
      "- generated",
    ),
    "# Changelog\n\n## Unreleased\n\n## 1.24.0\n\n- Added Z.\n- Added X.\n\n## 1.23.0\n\n- Old.\n",
  );
  const sdk = promoteUnreleased(
    "# Changelog\n\n## Unreleased\n\n## 0.3.0 — 2026-10-01\n\n- Core.\n",
    "## 0.3.0 — 2026-10-05",
    "- generated",
  );
  assert.equal(sdk.match(/^## 0\.3\.0/gmu).length, 1);
});

test("requires an Unreleased section", () => {
  assert.throws(
    () => promoteUnreleased("# Changelog\n", "## 1.0.0", "- x"),
    /Unreleased/u,
  );
});
