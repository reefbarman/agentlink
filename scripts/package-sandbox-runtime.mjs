import { chmod, cp, mkdir, rm, stat } from "node:fs/promises";

import { fileURLToPath } from "node:url";
import path from "node:path";

const HELPER_FILES = [
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
  {
    source: "node_modules/@anthropic-ai/sandbox-runtime/node_modules/commander",
    destination:
      "node_modules/@anthropic-ai/sandbox-runtime/node_modules/commander",
  },
  {
    source: "node_modules/@anthropic-ai/sandbox-runtime/node_modules/zod",
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
  {
    source: "node_modules/node-pty/prebuilds/darwin-arm64",
    destination: "node_modules/node-pty/prebuilds/darwin-arm64",
  },
  {
    source: "node_modules/node-pty/prebuilds/darwin-x64",
    destination: "node_modules/node-pty/prebuilds/darwin-x64",
  },
];

export const SANDBOX_RUNTIME_STAGE_PATHS = [
  ...HELPER_FILES.map((file) => `scripts/${file}`),
  ...PACKAGE_ENTRIES.map((entry) => entry.destination),
];

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
} = {}) {
  await rm(destinationRoot, { recursive: true, force: true });
  await mkdir(destinationRoot, { recursive: true });

  for (const file of HELPER_FILES) {
    await copyEntry(
      path.join(repoRoot, "scripts", file),
      path.join(destinationRoot, "scripts", file),
    );
  }
  for (const entry of PACKAGE_ENTRIES) {
    await copyEntry(
      path.join(repoRoot, entry.source),
      path.join(destinationRoot, entry.destination),
    );
  }

  const spawnHelpers = ["darwin-arm64", "darwin-x64"].map((architecture) =>
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

  const staged = [];
  for (const relativePath of SANDBOX_RUNTIME_STAGE_PATHS) {
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

  return { destinationRoot, staged, spawnHelpers };
}

const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const result = await stageSandboxRuntime();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
