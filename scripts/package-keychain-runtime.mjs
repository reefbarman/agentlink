import { cp, mkdir, readFile, rm, stat } from "node:fs/promises";

import { fileURLToPath } from "node:url";
import path from "node:path";

export const KEYCHAIN_NATIVE_PACKAGES = {
  "darwin-arm64": "@napi-rs/keyring-darwin-arm64",
  "darwin-x64": "@napi-rs/keyring-darwin-x64",
};

export function resolveKeychainRuntimeTarget({
  target = process.env.AGENTLINK_VSCE_TARGET,
  platform = process.platform,
  architecture = process.arch,
} = {}) {
  const resolved = target ?? `${platform}-${architecture}`;
  return resolved in KEYCHAIN_NATIVE_PACKAGES ? resolved : null;
}

async function pathExists(candidate) {
  try {
    await stat(candidate);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function readPackage(repoRoot, packageName) {
  const root = path.join(repoRoot, "node_modules", packageName);
  if (!(await pathExists(path.join(root, "package.json")))) {
    throw new Error(
      `Required Keychain runtime package is not installed: ${packageName}`,
    );
  }
  const manifest = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8"),
  );
  return { root, version: manifest.version };
}

export async function stageKeychainRuntime({
  repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  destinationRoot = path.join(repoRoot, "dist", "node_modules"),
  target = resolveKeychainRuntimeTarget(),
} = {}) {
  if (!target) return { target: null, packages: [] };
  const nativePackage = KEYCHAIN_NATIVE_PACKAGES[target];
  const packages = ["@napi-rs/keyring", nativePackage];

  for (const packageName of packages) {
    const source = await readPackage(repoRoot, packageName);
    const destination = path.join(destinationRoot, packageName);
    await rm(destination, { recursive: true, force: true });
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(source.root, destination, {
      recursive: true,
      force: true,
      preserveTimestamps: true,
      filter: (candidate) => !candidate.endsWith(".map"),
    });
  }

  return { target, nativePackage, packages };
}

const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  process.stdout.write(
    `${JSON.stringify(await stageKeychainRuntime(), null, 2)}\n`,
  );
}
