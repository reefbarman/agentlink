import {
  access,
  mkdtemp,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  applySeccompStagePath,
  resolveSandboxRuntimeTarget,
  stageSandboxRuntime,
} from "./package-sandbox-runtime.mjs";

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
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
    const staged = await stageSandboxRuntime({
      repoRoot,
      destinationRoot,
      target: "darwin-arm64",
    });

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

    for (const nonRuntimePath of [
      "node_modules/@anthropic-ai/sandbox-runtime/node_modules/zod/src",
      "node_modules/@anthropic-ai/sandbox-runtime/dist/index.js.map",
      "node_modules/@anthropic-ai/sandbox-runtime/dist/index.d.ts",
      "node_modules/@anthropic-ai/sandbox-runtime/node_modules/zod/index.d.cts",
    ]) {
      assert.equal(
        await exists(path.join(destinationRoot, nonRuntimePath)),
        false,
        nonRuntimePath,
      );
    }
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

for (const target of ["linux-x64", "linux-arm64"]) {
  test(`stages only the matching Linux node-pty prebuild for ${target}`, async () => {
    const temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "agentlink-runtime-stage-"),
    );
    const destinationRoot = path.join(temporaryRoot, "sandbox-runtime");
    try {
      const staged = await stageSandboxRuntime({
        repoRoot,
        destinationRoot,
        target,
      });

      assert.deepEqual(staged.spawnHelpers, []);
      assert.deepEqual(
        await readdir(
          path.join(destinationRoot, "node_modules/node-pty/prebuilds"),
        ),
        [target],
      );
      for (const runtimePath of [
        "node_modules/node-pty/lib/index.js",
        "node_modules/node-pty/package.json",
        `node_modules/node-pty/prebuilds/${target}/pty.node`,
      ]) {
        assert.equal(
          await exists(path.join(destinationRoot, runtimePath)),
          true,
          runtimePath,
        );
      }
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
}

test("stages apply-seccomp for Linux targets and requires it when asked", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "agentlink-runtime-stage-"),
  );
  try {
    const source = path.join(temporaryRoot, "apply-seccomp");
    await writeFile(source, "#!/bin/sh\n", { mode: 0o644 });
    const staged = await stageSandboxRuntime({
      repoRoot,
      destinationRoot: path.join(temporaryRoot, "linux"),
      target: "linux-arm64",
      includeNodePty: false,
      applySeccompSource: source,
    });
    assert.equal(
      staged.applySeccomp,
      path.join(temporaryRoot, "linux", applySeccompStagePath("linux-arm64")),
    );
    assert.equal(
      applySeccompStagePath("linux-arm64"),
      "vendor/seccomp/arm64/apply-seccomp",
    );
    assert.equal((await stat(staged.applySeccomp)).mode & 0o777, 0o755);

    const missing = path.join(temporaryRoot, "missing");
    const optional = await stageSandboxRuntime({
      repoRoot,
      destinationRoot: path.join(temporaryRoot, "optional"),
      target: "linux-x64",
      includeNodePty: false,
      applySeccompSource: missing,
      requireApplySeccomp: false,
    });
    assert.equal(optional.applySeccomp, undefined);
    await assert.rejects(
      stageSandboxRuntime({
        repoRoot,
        destinationRoot: path.join(temporaryRoot, "required"),
        target: "linux-x64",
        includeNodePty: false,
        applySeccompSource: missing,
        requireApplySeccomp: true,
      }),
      /apply-seccomp is required for linux-x64/,
    );

    const darwin = await stageSandboxRuntime({
      repoRoot,
      destinationRoot: path.join(temporaryRoot, "darwin"),
      target: "darwin-arm64",
      includeNodePty: false,
      requireApplySeccomp: true,
    });
    assert.equal(darwin.applySeccomp, undefined);
    assert.equal(applySeccompStagePath("alpine-x64"), undefined);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("does not stage node-pty when the Linux host only needs piped launches", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "agentlink-runtime-stage-"),
  );
  const destinationRoot = path.join(temporaryRoot, "sandbox-runtime");
  try {
    await stageSandboxRuntime({
      repoRoot,
      destinationRoot,
      target: "linux-x64",
      includeNodePty: false,
    });
    assert.equal(
      await exists(path.join(destinationRoot, "node_modules/node-pty")),
      false,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

for (const target of [
  "alpine-x64",
  "alpine-arm64",
  "linux-armhf",
  "win32-x64",
]) {
  test(`stages the sandbox runtime without node-pty for ${target}`, async () => {
    const temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "agentlink-runtime-stage-"),
    );
    const destinationRoot = path.join(temporaryRoot, "sandbox-runtime");
    try {
      const staged = await stageSandboxRuntime({
        repoRoot,
        destinationRoot,
        target,
      });

      assert.equal(staged.target, target);
      assert.deepEqual(staged.spawnHelpers, []);
      assert.equal(
        await exists(path.join(destinationRoot, "node_modules/node-pty")),
        false,
      );
      assert.equal(
        staged.staged.some((entry) => entry.path.includes("node-pty")),
        false,
      );
      for (const runtimePath of [
        "scripts/sandbox-interactive-helper.mjs",
        "node_modules/@anthropic-ai/sandbox-runtime/dist/index.js",
      ]) {
        assert.equal(
          await exists(path.join(destinationRoot, runtimePath)),
          true,
          runtimePath,
        );
      }
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
}

test("resolves the packaging target from AGENTLINK_VSCE_TARGET before the host", () => {
  assert.equal(
    resolveSandboxRuntimeTarget({
      target: "linux-x64",
      platform: "darwin",
      architecture: "arm64",
    }),
    "linux-x64",
  );
  assert.equal(
    resolveSandboxRuntimeTarget({
      target: undefined,
      platform: "darwin",
      architecture: "arm64",
    }),
    "darwin-arm64",
  );
});
