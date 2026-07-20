import { access, mkdtemp, readdir, rm, stat } from "node:fs/promises";

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { stageSandboxRuntime } from "./package-sandbox-runtime.mjs";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..");

async function exists(entryPath) {
  try {
    await access(entryPath);
    return true;
  } catch {
    return false;
  }
}

test("stages runtime dependencies and Darwin node-pty prebuilds without source or test payloads", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "agentlink-runtime-stage-"),
  );
  const destinationRoot = path.join(temporaryRoot, "sandbox-runtime");
  try {
    const staged = await stageSandboxRuntime({ repoRoot, destinationRoot });

    for (const runtimePath of [
      "scripts/sandbox-interactive-helper.mjs",
      "node_modules/@anthropic-ai/sandbox-runtime/dist/index.js",
      "node_modules/@anthropic-ai/sandbox-runtime/node_modules/zod/index.js",
      "node_modules/@anthropic-ai/sandbox-runtime/node_modules/zod/index.cjs",
      "node_modules/@anthropic-ai/sandbox-runtime/node_modules/commander/index.js",
      "node_modules/node-pty/lib/index.js",
      "node_modules/node-pty/prebuilds/darwin-arm64/pty.node",
      "node_modules/node-pty/prebuilds/darwin-x64/pty.node",
    ]) {
      assert.equal(
        await exists(path.join(destinationRoot, runtimePath)),
        true,
        runtimePath,
      );
    }

    assert.equal(
      await exists(
        path.join(
          destinationRoot,
          "node_modules/@anthropic-ai/sandbox-runtime/node_modules/zod/src",
        ),
      ),
      false,
    );
    const nodePtyLibEntries = await readdir(
      path.join(destinationRoot, "node_modules/node-pty/lib"),
    );
    assert.deepEqual(
      nodePtyLibEntries.filter(
        (entry) => entry.endsWith(".test.js") || entry.endsWith(".test.js.map"),
      ),
      [],
    );

    assert.equal(staged.spawnHelpers.length, 2);
    for (const spawnHelper of staged.spawnHelpers) {
      assert.equal((await stat(spawnHelper)).mode & 0o777, 0o755);
    }

    if (process.platform === "darwin") {
      const require = createRequire(
        path.join(destinationRoot, "runtime-smoke.cjs"),
      );
      const nodePty = require(
        path.join(destinationRoot, "node_modules/node-pty"),
      );
      const terminal = nodePty.spawn("/usr/bin/true", [], {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        cwd: temporaryRoot,
        env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "en_US.UTF-8" },
      });
      const exit = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          terminal.kill();
          reject(new Error("staged node-pty smoke timed out"));
        }, 5_000);
        terminal.onExit((event) => {
          clearTimeout(timeout);
          resolve(event);
        });
      });
      assert.deepEqual(exit, { exitCode: 0, signal: 0 });
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
