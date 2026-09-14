import {
  EXPECTED_BUNDLED_DEPENDENCIES,
  verifyCliPackage,
} from "./verify-cli-package.mjs";

import assert from "node:assert/strict";
import test from "node:test";

const files = [
  "package/LICENSE",
  "package/README.md",
  "package/THIRD_PARTY_NOTICES.md",
  "package/dist/agentlink.js",
  "package/dist/rg",
  "package/dist/runtime-manifest.json",
  "package/package.json",
];
const manifest = {
  bin: { agentlink: "dist/agentlink.js" },
  os: ["darwin"],
  cpu: ["arm64"],
  engines: { node: ">=22.19.0" },
  dependencies: { "@napi-rs/keyring": "2.0.0" },
};
const runtimeManifest = {
  schemaVersion: 1,
  platform: "darwin-arm64",
  bundle: "agentlink.js",
  externalImports: ["@napi-rs/keyring", "node:fs"],
  bundledDependencies: EXPECTED_BUNDLED_DEPENDENCIES,
  runtimeDependencies: { "@napi-rs/keyring": "2.0.0" },
  assets: {
    ripgrep: {
      path: "rg",
      package: "@vscode/ripgrep-darwin-arm64",
      packageVersion: "1.18.0",
      binaryVersion: "15.0.0",
      sha256:
        "6ef40346bf31fcce79d9614c7745c198542925a0c7d4911e1ffe794c53392ac1",
    },
  },
};

test("accepts the standalone CLI package boundary", () => {
  assert.deepEqual(verifyCliPackage(manifest, files, runtimeManifest), {
    runtimeDependencies: ["@napi-rs/keyring"],
    externalImports: ["@napi-rs/keyring"],
    bundledDependencies: runtimeManifest.bundledDependencies,
    fileCount: 7,
    ripgrep: runtimeManifest.assets.ripgrep,
  });
});

test("rejects unpublished or repository-relative runtime dependencies", () => {
  assert.throws(
    () =>
      verifyCliPackage(
        {
          ...manifest,
          dependencies: { "@agentlink/core": "file:../../packages/core" },
        },
        files,
        runtimeManifest,
      ),
    /private runtime dependency @agentlink\/core.*repository-relative runtime dependency @agentlink\/core/u,
  );
});

test("rejects unexpected files and external runtime imports", () => {
  assert.throws(
    () =>
      verifyCliPackage(manifest, [...files, "package/dist/unexpected.js"], {
        ...runtimeManifest,
        externalImports: ["@napi-rs/keyring", "electron"],
        bundledDependencies: {
          ...runtimeManifest.bundledDependencies,
          "unreviewed-package": "1.0.0",
        },
      }),
    /unexpected package files package\/dist\/unexpected\.js.*externalize only @napi-rs\/keyring.*bundled dependency inventory is invalid/u,
  );
});
