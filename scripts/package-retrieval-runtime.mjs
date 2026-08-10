import { cp, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";

import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT_PACKAGES = ["@lancedb/lancedb", "apache-arrow"];
export const LANCEDB_NATIVE_PACKAGES = {
  "darwin-arm64": "@lancedb/lancedb-darwin-arm64",
  "darwin-x64": "@lancedb/lancedb-darwin-x64",
  "linux-arm64": "@lancedb/lancedb-linux-arm64-gnu",
  "linux-x64": "@lancedb/lancedb-linux-x64-gnu",
  "alpine-arm64": "@lancedb/lancedb-linux-arm64-musl",
  "alpine-x64": "@lancedb/lancedb-linux-x64-musl",
  "win32-arm64": "@lancedb/lancedb-win32-arm64-msvc",
  "win32-x64": "@lancedb/lancedb-win32-x64-msvc",
};

export function resolveRetrievalRuntimeTarget({
  target = process.env.AGENTLINK_VSCE_TARGET,
  platform = process.platform,
  architecture = process.arch,
  runtimeReport = process.report?.getReport(),
} = {}) {
  if (target) {
    if (!(target in LANCEDB_NATIVE_PACKAGES)) {
      throw new Error(`Unsupported retrieval runtime target: ${target}`);
    }
    return target;
  }
  const hostPlatform =
    platform === "linux" &&
    runtimeReport !== undefined &&
    !runtimeReport.header?.glibcVersionRuntime
      ? "alpine"
      : platform;
  const hostTarget = `${hostPlatform}-${architecture}`;
  if (!(hostTarget in LANCEDB_NATIVE_PACKAGES)) {
    throw new Error(
      `Unsupported retrieval runtime host: ${platform}-${architecture}; set AGENTLINK_VSCE_TARGET`,
    );
  }
  return hostTarget;
}

export function getRetrievalNativePackage(target) {
  const packageName = LANCEDB_NATIVE_PACKAGES[target];
  if (!packageName) {
    throw new Error(`Unsupported retrieval runtime target: ${target}`);
  }
  return packageName;
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

async function resolveInstalledPackage(repoRoot, packageName, fromDirectory) {
  let directory = fromDirectory;
  while (true) {
    const candidate = path.join(directory, "node_modules", packageName);
    if (await pathExists(path.join(candidate, "package.json")))
      return candidate;
    if (directory === repoRoot) break;
    const parent = path.dirname(directory);
    if (parent === directory || !parent.startsWith(repoRoot)) break;
    directory = parent;
  }
  const candidate = path.join(repoRoot, "node_modules", packageName);
  if (await pathExists(path.join(candidate, "package.json"))) return candidate;
  throw new Error(
    `Required retrieval runtime package is not installed: ${packageName}`,
  );
}

async function readPackageManifest(packageRoot) {
  return JSON.parse(
    await readFile(path.join(packageRoot, "package.json"), "utf8"),
  );
}

async function collectRuntimePackages(repoRoot, nativePackage) {
  const packages = new Map();
  const pending = ROOT_PACKAGES.map((packageName) => ({
    packageName,
    fromDirectory: repoRoot,
  }));
  pending.push({ packageName: nativePackage, fromDirectory: repoRoot });

  while (pending.length > 0) {
    const { packageName, fromDirectory } = pending.pop();
    if (packages.has(packageName)) continue;
    if (packageName.startsWith("@types/")) continue;
    const packageRoot = await resolveInstalledPackage(
      repoRoot,
      packageName,
      fromDirectory,
    );
    const manifest = await readPackageManifest(packageRoot);
    packages.set(packageName, { packageRoot, version: manifest.version });
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      if (!dependency.startsWith("@types/")) {
        pending.push({ packageName: dependency, fromDirectory: packageRoot });
      }
    }
  }
  return packages;
}

function isNonRuntimeArtifact(source) {
  return (
    source.endsWith(".map") ||
    source.endsWith(".d.ts") ||
    source.endsWith(".d.cts") ||
    source.endsWith(".d.mts")
  );
}

async function findFiles(root, suffix) {
  const matches = [];
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(candidate);
      else if (entry.isFile() && entry.name.endsWith(suffix))
        matches.push(candidate);
    }
  };
  await visit(root);
  return matches;
}

export async function stageRetrievalRuntime({
  repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  destinationRoot = path.join(repoRoot, "dist", "node_modules"),
  target = resolveRetrievalRuntimeTarget(),
} = {}) {
  const nativePackage = getRetrievalNativePackage(target);
  const packages = await collectRuntimePackages(repoRoot, nativePackage);
  await rm(destinationRoot, { recursive: true, force: true });
  await mkdir(destinationRoot, { recursive: true });

  for (const [packageName, entry] of packages) {
    const destination = path.join(destinationRoot, packageName);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(entry.packageRoot, destination, {
      recursive: true,
      force: true,
      preserveTimestamps: true,
      filter: (source) =>
        !isNonRuntimeArtifact(source) &&
        !path
          .relative(entry.packageRoot, source)
          .split(path.sep)
          .includes("node_modules"),
    });
  }

  const nativeAddons = await findFiles(destinationRoot, ".node");
  if (nativeAddons.length !== 1) {
    throw new Error(
      `Expected exactly one staged LanceDB native addon for ${target}, found ${nativeAddons.length}`,
    );
  }
  const expectedNativeRoot = path.join(destinationRoot, nativePackage);
  if (!nativeAddons[0].startsWith(expectedNativeRoot + path.sep)) {
    throw new Error(
      `Staged native addon does not belong to ${nativePackage}: ${nativeAddons[0]}`,
    );
  }

  return {
    destinationRoot,
    target,
    nativePackage,
    nativeAddon: nativeAddons[0],
    packages: [...packages.entries()]
      .map(([name, entry]) => ({ name, version: entry.version }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  };
}

const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  if (process.argv.includes("--print-target")) {
    process.stdout.write(`${resolveRetrievalRuntimeTarget()}\n`);
  } else if (process.argv.includes("--print-native-package")) {
    process.stdout.write(
      `${getRetrievalNativePackage(resolveRetrievalRuntimeTarget())}\n`,
    );
  } else {
    const result = await stageRetrievalRuntime();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
}
