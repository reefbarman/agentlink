import {
  REQUIRED_PACKAGE_PATHS,
  classifyPackageListing,
} from "./sandbox-runtime-evidence.mjs";

import { SANDBOX_RUNTIME_STAGE_PATHS } from "./package-sandbox-runtime.mjs";
import assert from "node:assert/strict";
import test from "node:test";

const packageEntries = Object.values(REQUIRED_PACKAGE_PATHS).flat();

test("accepts the complete required sandbox runtime package inventory", () => {
  const result = classifyPackageListing(packageEntries);

  assert.equal(result.verdict, "pass");
  assert.deepEqual(result.missingRequiredPaths, []);
  assert.equal(result.assets.sandboxHelper.included, true);
});

test("fails when the production interactive helper is absent", () => {
  const interactiveHelper =
    "dist/sandbox-runtime/scripts/sandbox-interactive-helper.mjs";
  const result = classifyPackageListing(
    packageEntries.filter((entry) => entry !== interactiveHelper),
  );

  assert.equal(result.verdict, "fail");
  assert.equal(result.assets.sandboxHelper.included, false);
  assert.deepEqual(result.assets.sandboxHelper.missingPaths, [
    interactiveHelper,
  ]);
  assert.deepEqual(result.missingRequiredPaths, [interactiveHelper]);
});

test("keeps staged and required sandbox helper inventories in parity", () => {
  const stagedHelpers = SANDBOX_RUNTIME_STAGE_PATHS.filter((entry) =>
    entry.startsWith("scripts/"),
  )
    .map((entry) => `dist/sandbox-runtime/${entry}`)
    .sort();
  const requiredHelpers = [...REQUIRED_PACKAGE_PATHS.sandboxHelper].sort();

  assert.deepEqual(requiredHelpers, stagedHelpers);
});
