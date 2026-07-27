import {
  getRetrievalNativePackage,
  resolveRetrievalRuntimeTarget,
  stageRetrievalRuntime,
} from "./package-retrieval-runtime.mjs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

async function writePackage(root, name, manifest, files = {}) {
  const packageRoot = path.join(root, "node_modules", name);
  await mkdir(packageRoot, { recursive: true });
  await writeFile(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify({ name, version: "1.0.0", ...manifest }, null, 2)}\n`,
  );
  for (const [relativePath, content] of Object.entries(files)) {
    const destination = path.join(packageRoot, relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, content);
  }
}

test("maps host and VSCE targets to one native package", () => {
  assert.equal(
    resolveRetrievalRuntimeTarget({
      platform: "darwin",
      architecture: "arm64",
    }),
    "darwin-arm64",
  );
  assert.equal(
    resolveRetrievalRuntimeTarget({
      platform: "linux",
      architecture: "x64",
      runtimeReport: { header: { glibcVersionRuntime: "2.39" } },
    }),
    "linux-x64",
  );
  assert.equal(
    resolveRetrievalRuntimeTarget({
      platform: "linux",
      architecture: "arm64",
      runtimeReport: { header: {} },
    }),
    "alpine-arm64",
  );
  assert.equal(
    resolveRetrievalRuntimeTarget({
      target: "linux-arm64",
      platform: "linux",
      architecture: "arm64",
      runtimeReport: { header: {} },
    }),
    "linux-arm64",
  );
  assert.equal(
    getRetrievalNativePackage("linux-x64"),
    "@lancedb/lancedb-linux-x64-gnu",
  );
  assert.equal(
    getRetrievalNativePackage("alpine-arm64"),
    "@lancedb/lancedb-linux-arm64-musl",
  );
  assert.throws(
    () => resolveRetrievalRuntimeTarget({ target: "web" }),
    /Unsupported retrieval runtime target/,
  );
});

test("stages the recursive runtime closure and exactly one selected addon", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "retrieval-runtime-stage-"),
  );
  try {
    await writePackage(
      root,
      "@lancedb/lancedb",
      { dependencies: { "reflect-metadata": "1.0.0" } },
      { "dist/index.js": "module.exports = {};\n" },
    );
    await writePackage(
      root,
      "apache-arrow",
      {
        dependencies: {
          "@types/node": "1.0.0",
          flatbuffers: "1.0.0",
        },
      },
      {
        "Arrow.node.js": "module.exports = {};\n",
        "node_modules/@types/node/package.json": JSON.stringify({
          name: "@types/node",
          version: "1.0.0",
        }),
      },
    );
    await writePackage(root, "reflect-metadata", {}, { "index.js": "" });
    await writePackage(root, "flatbuffers", {}, { "index.js": "" });
    await writePackage(
      root,
      "@lancedb/lancedb-darwin-arm64",
      {},
      { "lancedb.darwin-arm64.node": "native" },
    );
    await writePackage(
      root,
      "@lancedb/lancedb-linux-x64-gnu",
      {},
      { "lancedb.linux-x64-gnu.node": "other-native" },
    );

    const destinationRoot = path.join(root, "dist", "node_modules");
    const result = await stageRetrievalRuntime({
      repoRoot: root,
      destinationRoot,
      target: "darwin-arm64",
    });

    assert.equal(result.nativePackage, "@lancedb/lancedb-darwin-arm64");
    assert.deepEqual(
      result.packages.map((entry) => entry.name),
      [
        "@lancedb/lancedb",
        "@lancedb/lancedb-darwin-arm64",
        "apache-arrow",
        "flatbuffers",
        "reflect-metadata",
      ],
    );
    assert.equal(
      await readFile(
        path.join(
          destinationRoot,
          "@lancedb/lancedb-darwin-arm64/lancedb.darwin-arm64.node",
        ),
        "utf8",
      ),
      "native",
    );
    await assert.rejects(
      readFile(
        path.join(
          destinationRoot,
          "@lancedb/lancedb-linux-x64-gnu/lancedb.linux-x64-gnu.node",
        ),
      ),
      { code: "ENOENT" },
    );
    await assert.rejects(
      readFile(path.join(destinationRoot, "@types/node/package.json")),
      { code: "ENOENT" },
    );
    await assert.rejects(
      readFile(
        path.join(
          destinationRoot,
          "apache-arrow/node_modules/@types/node/package.json",
        ),
      ),
      { code: "ENOENT" },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails closed when the requested native addon is unavailable", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "retrieval-runtime-missing-"),
  );
  try {
    await writePackage(root, "@lancedb/lancedb", {});
    await writePackage(root, "apache-arrow", {});
    await assert.rejects(
      stageRetrievalRuntime({ repoRoot: root, target: "win32-x64" }),
      /Required retrieval runtime package is not installed/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
