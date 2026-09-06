import {
  verifyVsixExcludesDesktop,
  verifyVsixManifestExcludesDesktop,
} from "./verify-vsix-boundary.mjs";

import assert from "node:assert/strict";
import test from "node:test";
import { verifyDesktopRuntimeFiles } from "./verify-desktop-package.mjs";

function desktopInventory(...extra) {
  return [
    "dist/browser-gateway-helper.js",
    "dist/browser-gateway.js",
    "dist/browser-gateway.css",
    "dist/browser-gateway-monaco.js",
    "dist/browser-gateway-monaco.css",
    "dist/browser-gateway-notifications.js",
    "dist/browser-gateway-chunks/shared-ABC123.js",
    "dist/monaco-editor.worker.js",
    "dist/monaco-json.worker.js",
    "dist/monaco-css.worker.js",
    "dist/monaco-html.worker.js",
    "dist/monaco-ts.worker.js",
    "dist/codicon.css",
    "dist/codicon.ttf",
    "dist/node_modules/@lancedb/lancedb/package.json",
    "dist/node_modules/apache-arrow/package.json",
    "dist/node_modules/@lancedb/lancedb-darwin-arm64/package.json",
    "dist/node_modules/@lancedb/lancedb-darwin-arm64/lancedb.darwin-arm64.node",
    "node_modules/@napi-rs/keyring/package.json",
    "node_modules/@napi-rs/keyring-darwin-arm64/package.json",
    "node_modules/@napi-rs/keyring-darwin-arm64/keyring.darwin-arm64.node",
    "resources/builtin-skills/documentation/SKILL.md",
    "media/icon.png",
    "media/agentlink-terminal.svg",
    ...extra,
  ].join("\n");
}

test("accepts a complete standalone macOS desktop runtime", () => {
  const result = verifyDesktopRuntimeFiles(desktopInventory(), "darwin-arm64");

  assert.equal(result.target, "darwin-arm64");
  assert.equal(result.nativePackage, "@lancedb/lancedb-darwin-arm64");
  assert.equal(result.keychainPackage, "@napi-rs/keyring-darwin-arm64");
});

test("rejects a desktop runtime without the shared browser UI", () => {
  assert.throws(
    () =>
      verifyDesktopRuntimeFiles(
        desktopInventory().replace("dist/browser-gateway.js\n", ""),
        "darwin-arm64",
      ),
    /missing dist\/browser-gateway\.js/u,
  );
});

test("rejects desktop runtimes with unrelated native addons", () => {
  assert.throws(
    () =>
      verifyDesktopRuntimeFiles(
        desktopInventory("node_modules/other/native.node"),
        "darwin-arm64",
      ),
    /unexpected native addons node_modules\/other\/native\.node/u,
  );
});

test("accepts a VSIX inventory without standalone desktop payloads", () => {
  const result = verifyVsixExcludesDesktop(
    [
      "extension/package.json",
      "extension/dist/extension.js",
      "extension/dist/browser-gateway.js",
      "extension/dist/browser-gateway-helper.js",
    ].join("\n"),
  );

  assert.deepEqual(result.forbiddenDesktopPaths, []);
});

test("rejects desktop application files in the VSIX", () => {
  assert.throws(
    () =>
      verifyVsixExcludesDesktop(
        ["extension/package.json", "extension/apps/desktop/dist/main.cjs"].join(
          "\n",
        ),
      ),
    /VSIX contains standalone desktop payloads/u,
  );
});

test("rejects a production dependency on the desktop workspace", () => {
  assert.throws(
    () =>
      verifyVsixManifestExcludesDesktop({
        dependencies: { "@agentlink/desktop": "0.1.0" },
      }),
    /must not declare @agentlink\/desktop/u,
  );
  assert.deepEqual(
    verifyVsixManifestExcludesDesktop({
      devDependencies: { "@agentlink/desktop": "0.1.0" },
    }),
    { productionDesktopDependency: false },
  );
});
