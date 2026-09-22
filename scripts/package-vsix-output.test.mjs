import assert from "node:assert/strict";
import { filterVsceFileCountWarning } from "./package-vsix-output.mjs";
import test from "node:test";

test("filters only vsce's bundled-extension file-count warning", () => {
  const warning =
    " WARNING  This extension consists of 1704 files, out of which 676 are JavaScript files. For performance reasons, you should bundle your extension: https://aka.ms/vscode-bundle-extension. You should also exclude unnecessary files by adding them to your .vscodeignore: https://aka.ms/vscode-vscodeignore.\n\n";
  const otherWarning = " WARNING  A different packaging warning\n";
  assert.equal(
    filterVsceFileCountWarning(`${otherWarning}${warning}${otherWarning}`),
    `${otherWarning}${otherWarning}`,
  );
  assert.equal(
    filterVsceFileCountWarning("Error: packaging failed\n"),
    "Error: packaging failed\n",
  );
});
