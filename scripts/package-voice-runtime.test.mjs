import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import {
  resolveVoiceRuntimeTarget,
  stageVoiceRuntime,
} from "./package-voice-runtime.mjs";

import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const PACKAGE = "@picovoice/pvrecorder-node";

async function writeRecorderPackage(root) {
  const packageRoot = path.join(root, "node_modules", PACKAGE);
  const files = {
    "package.json": JSON.stringify({ name: PACKAGE, version: "9.9.9" }),
    LICENSE: "Apache-2.0",
    "README.md": "readme",
    "dist/index.js": "module.exports = {};\n",
    "dist/index.js.map": "map",
    "dist/types/index.d.ts": "export {};\n",
    "src/index.ts": "export {};\n",
    "lib/mac/arm64/pv_recorder.node": "mac-arm64",
    "lib/linux/x86_64/pv_recorder.node": "linux-x64",
    "lib/windows/amd64/pv_recorder.node": "win-x64",
  };
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(packageRoot, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content);
  }
}

test("maps VSIX targets to pvrecorder native libraries", () => {
  assert.equal(
    resolveVoiceRuntimeTarget({ target: "darwin-arm64" }),
    "darwin-arm64",
  );
  assert.equal(resolveVoiceRuntimeTarget({ target: "linux-x64" }), "linux-x64");
  assert.equal(resolveVoiceRuntimeTarget({ target: "win32-x64" }), "win32-x64");
  assert.equal(resolveVoiceRuntimeTarget({ target: "linux-arm64" }), null);
});

test("stages only the wrapper JavaScript and the target native library", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentlink-voice-stage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeRecorderPackage(root);
  const destinationRoot = path.join(root, "dist", "node_modules");

  const result = await stageVoiceRuntime({
    repoRoot: root,
    destinationRoot,
    target: "linux-x64",
  });

  assert.deepEqual(result, {
    target: "linux-x64",
    version: "9.9.9",
    files: [
      "LICENSE",
      "dist/index.js",
      "lib/linux/x86_64/pv_recorder.node",
      "package.json",
    ],
  });
  const staged = path.join(destinationRoot, PACKAGE);
  assert.equal(
    await readFile(
      path.join(staged, "lib/linux/x86_64/pv_recorder.node"),
      "utf8",
    ),
    "linux-x64",
  );
  for (const excluded of [
    "lib/mac/arm64/pv_recorder.node",
    "dist/index.js.map",
    "dist/types/index.d.ts",
    "src/index.ts",
    "README.md",
  ]) {
    await assert.rejects(readFile(path.join(staged, excluded)), {
      code: "ENOENT",
    });
  }
});

test("fails closed when the target native library is missing", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentlink-voice-miss-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeRecorderPackage(root);

  await assert.rejects(
    stageVoiceRuntime({
      repoRoot: root,
      destinationRoot: path.join(root, "dist", "node_modules"),
      target: "win32-arm64",
    }),
    /native library is missing for win32-arm64/,
  );
});

test("skips staging for unsupported targets", async () => {
  assert.deepEqual(await stageVoiceRuntime({ target: null }), {
    target: null,
    files: [],
  });
});
