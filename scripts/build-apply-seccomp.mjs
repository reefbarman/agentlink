// Builds the sandbox runtime's `apply-seccomp` helper for a Linux VSIX target.
//
// The helper installs a seccomp filter that stops sandboxed commands from
// creating unix sockets. Without it, a bubblewrap sandbox still lets a command
// connect to host socket files such as /run/docker.sock, so AgentLink refuses
// to sandbox on Linux when it is missing. The npm package ships neither the
// binary nor its source, so this reproduces upstream's vendor/seccomp/build.ts
// from the release tarball pinned below.
//
// Linux only. Needs gcc and libseccomp-dev (static libseccomp) for the host
// architecture, plus a cross gcc for the other one:
//   sudo apt-get install -y gcc libseccomp-dev gcc-aarch64-linux-gnu
// Usage: node scripts/build-apply-seccomp.mjs [--target linux-x64|linux-arm64]

import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";

import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/** Upstream source for the runtime version AgentLink depends on. */
export const APPLY_SECCOMP_SOURCE = Object.freeze({
  runtimeVersion: "0.0.79",
  url: "https://codeload.github.com/anthropics/sandbox-runtime/tar.gz/refs/tags/v0.0.79",
  sha256: "9396273452badf14042ad1f79f00675fc77271838bd1db5a9e1a30866d2fe1b5",
  directory: "sandbox-runtime-0.0.79",
});

export const APPLY_SECCOMP_TARGETS = Object.freeze({
  "linux-x64": Object.freeze({ arch: "x64", crossPrefix: "x86_64-linux-gnu-" }),
  "linux-arm64": Object.freeze({
    arch: "arm64",
    crossPrefix: "aarch64-linux-gnu-",
  }),
});

const CFLAGS = ["-static", "-O2", "-Wall", "-Wextra"];

/** Where the build leaves the helper for `stageSandboxRuntime` to pick up. */
export function applySeccompBuildPath(target, repoRoot = REPO_ROOT) {
  assertTarget(target);
  return path.join(
    repoRoot,
    "native-builds",
    "apply-seccomp",
    target,
    "apply-seccomp",
  );
}

function assertTarget(target) {
  if (!Object.hasOwn(APPLY_SECCOMP_TARGETS, target)) {
    throw new Error(
      `apply-seccomp is built only for ${Object.keys(APPLY_SECCOMP_TARGETS).join(", ")}; received ${target}`,
    );
  }
}

/**
 * The compiler and strip for `target`: the plain toolchain on a matching host,
 * the GNU cross toolchain otherwise. CC/STRIP override both.
 */
export function toolchainFor(target, hostArch = process.arch, env = {}) {
  assertTarget(target);
  const { arch, crossPrefix } = APPLY_SECCOMP_TARGETS[target];
  const prefix = arch === hostArch ? "" : crossPrefix;
  return {
    cc: env.CC || `${prefix}gcc`,
    strip: env.STRIP || `${prefix}strip`,
  };
}

/** Fails when the installed runtime no longer matches the pinned source. */
export async function assertRuntimeVersionPinned(repoRoot = REPO_ROOT) {
  const manifest = JSON.parse(
    await readFile(
      path.join(
        repoRoot,
        "node_modules/@anthropic-ai/sandbox-runtime/package.json",
      ),
      "utf8",
    ),
  );
  if (manifest.version !== APPLY_SECCOMP_SOURCE.runtimeVersion) {
    throw new Error(
      `@anthropic-ai/sandbox-runtime is ${manifest.version} but apply-seccomp is pinned to ${APPLY_SECCOMP_SOURCE.runtimeVersion}; update APPLY_SECCOMP_SOURCE in scripts/build-apply-seccomp.mjs`,
    );
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) {
    throw new Error(`${command} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} exited ${result.status ?? result.signal}`,
    );
  }
}

function toCArray(bytes) {
  const hex = Array.from(
    bytes,
    (byte) => `0x${byte.toString(16).padStart(2, "0")}`,
  );
  const lines = [];
  for (let index = 0; index < hex.length; index += 8) {
    lines.push(`    ${hex.slice(index, index + 8).join(", ")},`);
  }
  return lines.join("\n");
}

async function readPinnedSource(sourcePath) {
  const archive = sourcePath
    ? await readFile(sourcePath)
    : Buffer.from(
        await (async () => {
          const response = await fetch(APPLY_SECCOMP_SOURCE.url);
          if (!response.ok) {
            throw new Error(
              `downloading ${APPLY_SECCOMP_SOURCE.url} failed: HTTP ${response.status}`,
            );
          }
          return response.arrayBuffer();
        })(),
      );
  const digest = createHash("sha256").update(archive).digest("hex");
  if (digest !== APPLY_SECCOMP_SOURCE.sha256) {
    throw new Error(
      `sandbox-runtime source sha256 is ${digest}, expected ${APPLY_SECCOMP_SOURCE.sha256}`,
    );
  }
  return archive;
}

export async function buildApplySeccomp({
  target = `linux-${process.arch}`,
  sourcePath,
  repoRoot = REPO_ROOT,
  env = process.env,
} = {}) {
  if (process.platform !== "linux") {
    throw new Error("apply-seccomp can only be built on Linux");
  }
  assertTarget(target);
  await assertRuntimeVersionPinned(repoRoot);
  const { cc, strip } = toolchainFor(target, process.arch, env);
  const archive = await readPinnedSource(sourcePath);
  const work = await mkdtemp(path.join(os.tmpdir(), "agentlink-seccomp-"));
  try {
    const archivePath = path.join(work, "source.tgz");
    await writeFile(archivePath, archive);
    const sourceDirectory = `${APPLY_SECCOMP_SOURCE.directory}/vendor/seccomp-src`;
    run("tar", ["-xzf", archivePath, "-C", work, sourceDirectory]);
    const source = path.join(work, sourceDirectory);

    // The filter generator runs here, so it is always a host binary.
    const generator = path.join(work, "seccomp-unix-block");
    run("gcc", [
      ...CFLAGS,
      "-o",
      generator,
      path.join(source, "seccomp-unix-block.c"),
      "-lseccomp",
    ]);
    const filters = {};
    for (const architecture of ["x86_64", "aarch64"]) {
      const output = path.join(work, `${architecture}.bpf`);
      run(generator, [output, architecture]);
      filters[architecture] = await readFile(output);
    }
    await writeFile(
      path.join(work, "unix-block-bpf.h"),
      "#if defined(__x86_64__)\n" +
        "static const unsigned char unix_block_bpf[] = {\n" +
        toCArray(filters.x86_64) +
        "\n};\n" +
        "#elif defined(__aarch64__)\n" +
        "static const unsigned char unix_block_bpf[] = {\n" +
        toCArray(filters.aarch64) +
        "\n};\n" +
        "#else\n" +
        '#error "unsupported architecture for unix-block BPF filter"\n' +
        "#endif\n",
    );

    const output = applySeccompBuildPath(target, repoRoot);
    await mkdir(path.dirname(output), { recursive: true });
    run(cc, [
      ...CFLAGS,
      "-I",
      work,
      "-o",
      output,
      path.join(source, "apply-seccomp.c"),
    ]);
    run(strip, [output]);
    await chmod(output, 0o755);
    const binary = await readFile(output);
    const manifest = {
      target,
      runtimeVersion: APPLY_SECCOMP_SOURCE.runtimeVersion,
      sourceSha256: APPLY_SECCOMP_SOURCE.sha256,
      binarySha256: createHash("sha256").update(binary).digest("hex"),
    };
    await writeFile(
      path.join(path.dirname(output), "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    return { output, ...manifest };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--target") options.target = argv[++index];
    else if (argument === "--source") options.sourcePath = argv[++index];
    else throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}

const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const result = await buildApplySeccomp(parseArguments(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
