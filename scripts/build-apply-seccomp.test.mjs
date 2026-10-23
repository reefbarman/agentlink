import {
  APPLY_SECCOMP_SOURCE,
  applySeccompBuildPath,
  assertRuntimeVersionPinned,
  toolchainFor,
} from "./build-apply-seccomp.mjs";

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..");

test("pins the source to the installed sandbox runtime version", async () => {
  await assertRuntimeVersionPinned(repoRoot);
  assert.match(APPLY_SECCOMP_SOURCE.sha256, /^[a-f0-9]{64}$/);
  assert.ok(
    APPLY_SECCOMP_SOURCE.url.endsWith(
      `v${APPLY_SECCOMP_SOURCE.runtimeVersion}`,
    ),
  );
});

test("uses the native toolchain on a matching host and cross gcc otherwise", () => {
  assert.deepEqual(toolchainFor("linux-x64", "x64"), {
    cc: "gcc",
    strip: "strip",
  });
  assert.deepEqual(toolchainFor("linux-arm64", "x64"), {
    cc: "aarch64-linux-gnu-gcc",
    strip: "aarch64-linux-gnu-strip",
  });
  assert.deepEqual(toolchainFor("linux-x64", "arm64"), {
    cc: "x86_64-linux-gnu-gcc",
    strip: "x86_64-linux-gnu-strip",
  });
  assert.deepEqual(
    toolchainFor("linux-arm64", "x64", { CC: "clang", STRIP: "llvm-strip" }),
    { cc: "clang", strip: "llvm-strip" },
  );
});

test("builds only for glibc Linux x64 and arm64", () => {
  assert.equal(
    applySeccompBuildPath("linux-arm64", "/repo"),
    "/repo/native-builds/apply-seccomp/linux-arm64/apply-seccomp",
  );
  for (const target of ["alpine-x64", "darwin-arm64", "linux-armhf"]) {
    assert.throws(() => applySeccompBuildPath(target, "/repo"), /built only/);
    assert.throws(() => toolchainFor(target), /built only/);
  }
});
