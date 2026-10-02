import assert from "node:assert/strict";
import { promoteUnreleased } from "./release-coordinator.mjs";
import test from "node:test";

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

test("requires an Unreleased section", () => {
  assert.throws(
    () => promoteUnreleased("# Changelog\n", "## 1.0.0", "- x"),
    /Unreleased/u,
  );
});
