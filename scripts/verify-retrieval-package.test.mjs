import assert from "node:assert/strict";
import test from "node:test";
import { verifyRetrievalPackageFiles } from "./verify-retrieval-package.mjs";

function inventory(...extraPaths) {
  return [
    "package.json",
    "README.md",
    "dist/extension.js",
    "dist/compose-runtime.mjs",
    "dist/indexer-worker.js",
    "dist/browser-gateway-helper.js",
    "dist/browser-gateway.js",
    "dist/browser-gateway-monaco.js",
    "dist/browser-gateway-chunks/shared-ABC123.js",
    "dist/monaco-editor.worker.js",
    "dist/monaco-json.worker.js",
    "dist/monaco-css.worker.js",
    "dist/monaco-html.worker.js",
    "dist/monaco-ts.worker.js",
    "dist/node_modules/@lancedb/lancedb/package.json",
    "dist/node_modules/apache-arrow/package.json",
    "resources/builtin-skills/documentation/SKILL.md",
    "resources/builtin-skills/documentation/README.md",
    "resources/builtin-skills/documentation/references/complete-reference.md",
    "resources/builtin-skills/documentation/references/package-contract.md",
    "resources/builtin-skills/documentation/references/release-notes.md",
    ...extraPaths,
  ].join("\n");
}

test("accepts the required assets and one matching LanceDB native addon", () => {
  const result = verifyRetrievalPackageFiles(
    inventory(
      "dist/node_modules/@lancedb/lancedb-darwin-arm64/package.json",
      "dist/node_modules/@lancedb/lancedb-darwin-arm64/lancedb.darwin-arm64.node",
    ),
    "darwin-arm64",
  );

  assert.equal(result.target, "darwin-arm64");
  assert.equal(result.nativePackage, "@lancedb/lancedb-darwin-arm64");
  assert.match(result.nativeAddon, /lancedb\.darwin-arm64\.node$/u);
});

test("rejects an inventory without the bundled package contract", () => {
  assert.throws(
    () =>
      verifyRetrievalPackageFiles(
        inventory(
          "dist/node_modules/@lancedb/lancedb-darwin-arm64/package.json",
          "dist/node_modules/@lancedb/lancedb-darwin-arm64/lancedb.darwin-arm64.node",
        ).replace(
          "resources/builtin-skills/documentation/references/package-contract.md\n",
          "",
        ),
        "darwin-arm64",
      ),
    /missing required paths: resources\/builtin-skills\/documentation\/references\/package-contract\.md/u,
  );
});

test("rejects an inventory without the selected native package manifest", () => {
  assert.throws(
    () =>
      verifyRetrievalPackageFiles(
        inventory(
          "dist/node_modules/@lancedb/lancedb-darwin-arm64/lancedb.darwin-arm64.node",
        ),
        "darwin-arm64",
      ),
    /missing required paths: dist\/node_modules\/@lancedb\/lancedb-darwin-arm64\/package\.json/u,
  );
});

test("rejects an inventory without browser chunks", () => {
  assert.throws(
    () =>
      verifyRetrievalPackageFiles(
        inventory(
          "dist/node_modules/@lancedb/lancedb-darwin-arm64/package.json",
          "dist/node_modules/@lancedb/lancedb-darwin-arm64/lancedb.darwin-arm64.node",
        ).replace("dist/browser-gateway-chunks/shared-ABC123.js\n", ""),
        "darwin-arm64",
      ),
    /missing required paths: dist\/browser-gateway-chunks\/\*\.js/u,
  );
});

test("rejects mixed-platform LanceDB native packages", () => {
  assert.throws(
    () =>
      verifyRetrievalPackageFiles(
        inventory(
          "dist/node_modules/@lancedb/lancedb-darwin-arm64/package.json",
          "dist/node_modules/@lancedb/lancedb-darwin-arm64/lancedb.darwin-arm64.node",
          "dist/node_modules/@lancedb/lancedb-linux-x64-gnu/package.json",
          "dist/node_modules/@lancedb/lancedb-linux-x64-gnu/lancedb.linux-x64-gnu.node",
        ),
        "darwin-arm64",
      ),
    /unexpected LanceDB native packages: @lancedb\/lancedb-linux-x64-gnu/u,
  );
});
