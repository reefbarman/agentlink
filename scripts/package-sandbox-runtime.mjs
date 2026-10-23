import {
  APPLY_SECCOMP_TARGETS,
  applySeccompBuildPath,
} from "./build-apply-seccomp.mjs";
import { chmod, cp, mkdir, readdir, rm, stat } from "node:fs/promises";

import { fileURLToPath } from "node:url";
import path from "node:path";

const HELPER_FILES = [
  "sandbox-interactive-helper.mjs",
  "sandbox-linux-runtime.mjs",
  "sandbox-network-policy.mjs",
  "sandbox-network-proxy.mjs",
  "sandbox-process-reaper.mjs",
  "sandbox-protected-roots.mjs",
  "sandbox-runtime-helper.mjs",
];

const PACKAGE_ENTRIES = [
  {
    source: "node_modules/@anthropic-ai/sandbox-runtime/dist",
    destination: "node_modules/@anthropic-ai/sandbox-runtime/dist",
  },
  {
    source: "node_modules/@anthropic-ai/sandbox-runtime/LICENSE",
    destination: "node_modules/@anthropic-ai/sandbox-runtime/LICENSE",
  },
  {
    source: "node_modules/@anthropic-ai/sandbox-runtime/package.json",
    destination: "node_modules/@anthropic-ai/sandbox-runtime/package.json",
  },
  // npm may nest or hoist these depending on the rest of the tree, so look
  // them up the way Node would (nested first, then hoisted) and always stage
  // them nested so the packaged runtime resolves the right versions.
  {
    source: [
      "node_modules/@anthropic-ai/sandbox-runtime/node_modules/commander",
      "node_modules/commander",
    ],
    destination:
      "node_modules/@anthropic-ai/sandbox-runtime/node_modules/commander",
  },
  {
    source: [
      "node_modules/@anthropic-ai/sandbox-runtime/node_modules/zod",
      "node_modules/zod",
    ],
    destination: "node_modules/@anthropic-ai/sandbox-runtime/node_modules/zod",
  },
  {
    source: "node_modules/@pondwader/socks5-server/dist",
    destination: "node_modules/@pondwader/socks5-server/dist",
  },
  {
    source: "node_modules/@pondwader/socks5-server/LICENSE",
    destination: "node_modules/@pondwader/socks5-server/LICENSE",
  },
  {
    source: "node_modules/@pondwader/socks5-server/package.json",
    destination: "node_modules/@pondwader/socks5-server/package.json",
  },
  {
    source: "node_modules/node-forge/lib",
    destination: "node_modules/node-forge/lib",
  },
  {
    source: "node_modules/node-forge/LICENSE",
    destination: "node_modules/node-forge/LICENSE",
  },
  {
    source: "node_modules/node-forge/package.json",
    destination: "node_modules/node-forge/package.json",
  },
];

// node-pty backs the AgentLink terminal (macOS and glibc Linux) and sandbox PTY
// launches (macOS only). Each target gets only the prebuilds it can load: both
// Darwin architectures on macOS, the matching one on Linux, and none on Alpine
// or other targets, which keep the VS Code terminal.
const NODE_PTY_COMMON_ENTRIES = [
  {
    source: "node_modules/node-pty/lib",
    destination: "node_modules/node-pty/lib",
  },
  {
    source: "node_modules/node-pty/typings",
    destination: "node_modules/node-pty/typings",
  },
  {
    source: "node_modules/node-pty/LICENSE",
    destination: "node_modules/node-pty/LICENSE",
  },
  {
    source: "node_modules/node-pty/package.json",
    destination: "node_modules/node-pty/package.json",
  },
];

const DARWIN_NODE_PTY_PREBUILDS = ["darwin-arm64", "darwin-x64"];
const LINUX_NODE_PTY_PREBUILDS = ["linux-arm64", "linux-x64"];

/** The node-pty prebuild directories staged for a VSIX target. */
export function nodePtyPrebuildsFor(target) {
  if (target.startsWith("darwin-")) return DARWIN_NODE_PTY_PREBUILDS;
  if (LINUX_NODE_PTY_PREBUILDS.includes(target)) return [target];
  return [];
}

/**
 * The VSIX target being packaged: AGENTLINK_VSCE_TARGET when set (for example
 * `linux-x64` built on a Mac), otherwise the current host.
 */
export function resolveSandboxRuntimeTarget({
  target = process.env.AGENTLINK_VSCE_TARGET,
  platform = process.platform,
  architecture = process.arch,
} = {}) {
  return target || `${platform}-${architecture}`;
}

/**
 * Where the Linux sandbox helper finds `apply-seccomp`, relative to the staged
 * runtime root. Returns undefined for targets that do not get one.
 */
export function applySeccompStagePath(target) {
  const entry = APPLY_SECCOMP_TARGETS[target];
  return entry ? `vendor/seccomp/${entry.arch}/apply-seccomp` : undefined;
}

export function includesNodePty(target) {
  return nodePtyPrebuildsFor(target).length > 0;
}

export function sandboxRuntimeStagePaths(
  target = resolveSandboxRuntimeTarget(),
  withNodePty = includesNodePty(target),
) {
  return [
    ...HELPER_FILES.map((file) => `scripts/${file}`),
    ...packageEntriesFor(target, withNodePty).map((entry) => entry.destination),
  ];
}

/** Stage paths for a macOS target, the superset staged for any target. */
export const SANDBOX_RUNTIME_STAGE_PATHS =
  sandboxRuntimeStagePaths("darwin-arm64");

function packageEntriesFor(target, withNodePty) {
  if (!withNodePty) return PACKAGE_ENTRIES;
  return [
    ...PACKAGE_ENTRIES,
    ...NODE_PTY_COMMON_ENTRIES,
    ...nodePtyPrebuildsFor(target).map((prebuild) => ({
      source: `node_modules/node-pty/prebuilds/${prebuild}`,
      destination: `node_modules/node-pty/prebuilds/${prebuild}`,
    })),
  ];
}

function isNonRuntimeArtifact(fileName) {
  return (
    fileName.endsWith(".map") ||
    fileName.endsWith(".d.ts") ||
    fileName.endsWith(".d.cts") ||
    fileName.endsWith(".d.mts")
  );
}

async function pruneNonRuntimeArtifacts(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) await pruneNonRuntimeArtifacts(entryPath);
    else if (entry.isFile() && isNonRuntimeArtifact(entry.name)) {
      await rm(entryPath);
    }
  }
}

async function pruneNonRuntimeFiles(destinationRoot, withNodePty) {
  await pruneNonRuntimeArtifacts(destinationRoot);
  await rm(
    path.join(
      destinationRoot,
      "node_modules/@anthropic-ai/sandbox-runtime/node_modules/zod/src",
    ),
    { recursive: true, force: true },
  );
  if (!withNodePty) return;

  const nodePtyLib = path.join(destinationRoot, "node_modules/node-pty/lib");
  let nodePtyLibMetadata;
  try {
    nodePtyLibMetadata = await stat(nodePtyLib);
  } catch (error) {
    throw new Error(
      `staged node-pty runtime directory is missing: ${nodePtyLib}`,
      {
        cause: error,
      },
    );
  }
  if (!nodePtyLibMetadata.isDirectory()) {
    throw new Error(
      `staged node-pty runtime path is not a directory: ${nodePtyLib}`,
    );
  }
  for (const entry of await readdir(nodePtyLib)) {
    if (entry.endsWith(".test.js") || entry.endsWith(".test.js.map")) {
      await rm(path.join(nodePtyLib, entry), { force: true });
    }
  }
}

async function resolveEntrySource(repoRoot, source) {
  const candidates = Array.isArray(source) ? source : [source];
  for (const candidate of candidates) {
    const absolute = path.join(repoRoot, candidate);
    try {
      await stat(absolute);
      return absolute;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  throw new Error(
    `sandbox runtime dependency is missing; looked in: ${candidates.join(", ")}`,
  );
}

async function copyEntry(source, destination) {
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(source, destination, {
    recursive: true,
    force: true,
    preserveTimestamps: true,
  });
}

export async function stageSandboxRuntime({
  repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  destinationRoot = path.join(repoRoot, "dist", "sandbox-runtime"),
  target = resolveSandboxRuntimeTarget(),
  // Hosts that only make piped sandbox launches (the Desktop Ask Agent
  // helper) leave node-pty out; it is loaded only for PTY launches.
  includeNodePty = includesNodePty(target),
  // Built by scripts/build-apply-seccomp.mjs. CI sets
  // AGENTLINK_APPLY_SECCOMP_REQUIRED so a Linux package cannot ship without
  // it; local builds stage it when present and the sandbox refuses otherwise.
  applySeccompSource = APPLY_SECCOMP_TARGETS[target]
    ? applySeccompBuildPath(target, repoRoot)
    : undefined,
  requireApplySeccomp = process.env.AGENTLINK_APPLY_SECCOMP_REQUIRED === "1",
} = {}) {
  const withNodePty = includeNodePty && includesNodePty(target);
  await rm(destinationRoot, { recursive: true, force: true });
  await mkdir(destinationRoot, { recursive: true });

  for (const file of HELPER_FILES) {
    await copyEntry(
      path.join(repoRoot, "scripts", file),
      path.join(destinationRoot, "scripts", file),
    );
  }
  for (const entry of packageEntriesFor(target, withNodePty)) {
    await copyEntry(
      await resolveEntrySource(repoRoot, entry.source),
      path.join(destinationRoot, entry.destination),
    );
  }
  await pruneNonRuntimeFiles(destinationRoot, withNodePty);

  // Linux node-pty forks directly; only the Darwin prebuilds ship a helper.
  const spawnHelpers = (
    withNodePty
      ? nodePtyPrebuildsFor(target).filter((prebuild) =>
          prebuild.startsWith("darwin-"),
        )
      : []
  ).map((architecture) =>
    path.join(
      destinationRoot,
      "node_modules/node-pty/prebuilds",
      architecture,
      "spawn-helper",
    ),
  );
  for (const spawnHelper of spawnHelpers) {
    await chmod(spawnHelper, 0o755);
  }

  let applySeccomp;
  const applySeccompRelative = applySeccompStagePath(target);
  if (applySeccompRelative && applySeccompSource) {
    let sourceMetadata;
    try {
      sourceMetadata = await stat(applySeccompSource);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (sourceMetadata?.isFile()) {
      applySeccomp = path.join(destinationRoot, applySeccompRelative);
      await copyEntry(applySeccompSource, applySeccomp);
      await chmod(applySeccomp, 0o755);
    } else if (requireApplySeccomp) {
      throw new Error(
        `apply-seccomp is required for ${target} but missing at ${applySeccompSource}; run node scripts/build-apply-seccomp.mjs --target ${target}`,
      );
    }
  }

  const staged = [];
  for (const relativePath of sandboxRuntimeStagePaths(target, withNodePty)) {
    const metadata = await stat(path.join(destinationRoot, relativePath));
    staged.push({
      path: relativePath,
      kind: metadata.isDirectory() ? "directory" : "file",
      mode: metadata.mode & 0o777,
    });
  }
  for (const spawnHelper of spawnHelpers) {
    const metadata = await stat(spawnHelper);
    if ((metadata.mode & 0o111) === 0) {
      throw new Error(`staged spawn-helper is not executable: ${spawnHelper}`);
    }
  }

  return { target, destinationRoot, staged, spawnHelpers, applySeccomp };
}

const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const result = await stageSandboxRuntime();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
