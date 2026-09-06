import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import {
  resolveKeychainRuntimeTarget,
  stageKeychainRuntime,
} from "./package-keychain-runtime.mjs";

import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

async function writePackage(root, packageName, files) {
  const packageRoot = path.join(root, "node_modules", packageName);
  await mkdir(packageRoot, { recursive: true });
  await writeFile(
    path.join(packageRoot, "package.json"),
    JSON.stringify({ name: packageName, version: "1.0.0" }),
  );
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(packageRoot, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content);
  }
}

test("selects only supported macOS Keychain targets", () => {
  assert.equal(
    resolveKeychainRuntimeTarget({ target: "darwin-arm64" }),
    "darwin-arm64",
  );
  assert.equal(
    resolveKeychainRuntimeTarget({ target: "darwin-x64" }),
    "darwin-x64",
  );
  assert.equal(resolveKeychainRuntimeTarget({ target: "linux-x64" }), null);
});

test("stages the wrapper and matching macOS native package", async (t) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "agentlink-keychain-stage-"),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  await writePackage(root, "@napi-rs/keyring", {
    "index.js": "module.exports = {};\n",
    "index.js.map": "ignored",
  });
  await writePackage(root, "@napi-rs/keyring-darwin-arm64", {
    "keyring.darwin-arm64.node": "native",
  });
  const destinationRoot = path.join(root, "dist", "node_modules");

  const result = await stageKeychainRuntime({
    repoRoot: root,
    destinationRoot,
    target: "darwin-arm64",
  });

  assert.equal(result.nativePackage, "@napi-rs/keyring-darwin-arm64");
  assert.equal(
    await readFile(
      path.join(
        destinationRoot,
        "@napi-rs/keyring-darwin-arm64/keyring.darwin-arm64.node",
      ),
      "utf8",
    ),
    "native",
  );
  await assert.rejects(
    readFile(path.join(destinationRoot, "@napi-rs/keyring/index.js.map")),
    { code: "ENOENT" },
  );
});

test("does not stage Keychain packages for unsupported targets", async (t) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "agentlink-keychain-none-"),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const destinationRoot = path.join(root, "dist", "node_modules");

  const result = await stageKeychainRuntime({
    repoRoot: root,
    destinationRoot,
    target: null,
  });

  assert.deepEqual(result, { target: null, packages: [] });
});
