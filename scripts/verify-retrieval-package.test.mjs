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
    "resources/builtin-skills/documentation/references/capabilities.md",
    "resources/builtin-skills/documentation/references/getting-started.md",
    "resources/builtin-skills/documentation/references/embedding-agentlink.md",
    "resources/builtin-skills/documentation/references/tools.md",
    "resources/builtin-skills/documentation/references/troubleshooting.md",
    "resources/builtin-skills/documentation/references/complete-reference.md",
    "resources/builtin-skills/documentation/references/package-contract.md",
    "resources/builtin-skills/documentation/references/release-notes.md",
    "resources/agent-plugins/1.0.0/plugin.schema.json",
    "resources/agent-plugins/1.0.0/mcp.schema.json",
    "resources/agent-plugins/1.0.0/README.md",
    "resources/agent-plugins/1.0.0/LICENSE.md",
    "resources/agent-plugins/1.0.0/LICENSES/Apache-2.0.txt",
    "resources/agent-plugins/1.0.0/LICENSES/CC-BY-4.0.txt",
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

test("accepts VSIX archive paths with a lowercased extension readme", () => {
  const result = verifyRetrievalPackageFiles(
    inventory(
      "dist/node_modules/@lancedb/lancedb-darwin-arm64/package.json",
      "dist/node_modules/@lancedb/lancedb-darwin-arm64/lancedb.darwin-arm64.node",
    ).replace("README.md\n", "extension/readme.md\n"),
    "darwin-arm64",
  );

  assert.equal(result.target, "darwin-arm64");
});

test("rejects an inventory without the focused getting-started guide", () => {
  assert.throws(
    () =>
      verifyRetrievalPackageFiles(
        inventory(
          "dist/node_modules/@lancedb/lancedb-darwin-arm64/package.json",
          "dist/node_modules/@lancedb/lancedb-darwin-arm64/lancedb.darwin-arm64.node",
        ).replace(
          "resources/builtin-skills/documentation/references/getting-started.md\n",
          "",
        ),
        "darwin-arm64",
      ),
    /missing required paths: resources\/builtin-skills\/documentation\/references\/getting-started\.md/u,
  );
});

test("rejects an inventory without the embedding guide", () => {
  assert.throws(
    () =>
      verifyRetrievalPackageFiles(
        inventory(
          "dist/node_modules/@lancedb/lancedb-darwin-arm64/package.json",
          "dist/node_modules/@lancedb/lancedb-darwin-arm64/lancedb.darwin-arm64.node",
        ).replace(
          "resources/builtin-skills/documentation/references/embedding-agentlink.md\n",
          "",
        ),
        "darwin-arm64",
      ),
    /missing required paths: resources\/builtin-skills\/documentation\/references\/embedding-agentlink\.md/u,
  );
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

test("rejects an inventory without an Agent Plugins schema", () => {
  assert.throws(
    () =>
      verifyRetrievalPackageFiles(
        inventory(
          "dist/node_modules/@lancedb/lancedb-darwin-arm64/package.json",
          "dist/node_modules/@lancedb/lancedb-darwin-arm64/lancedb.darwin-arm64.node",
        ).replace("resources/agent-plugins/1.0.0/mcp.schema.json\n", ""),
        "darwin-arm64",
      ),
    /missing required paths: resources\/agent-plugins\/1\.0\.0\/mcp\.schema\.json/u,
  );
});

test("rejects an inventory without Agent Plugins attribution", () => {
  assert.throws(
    () =>
      verifyRetrievalPackageFiles(
        inventory(
          "dist/node_modules/@lancedb/lancedb-darwin-arm64/package.json",
          "dist/node_modules/@lancedb/lancedb-darwin-arm64/lancedb.darwin-arm64.node",
        ).replace("resources/agent-plugins/1.0.0/LICENSE.md\n", ""),
        "darwin-arm64",
      ),
    /missing required paths: resources\/agent-plugins\/1\.0\.0\/LICENSE\.md/u,
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
