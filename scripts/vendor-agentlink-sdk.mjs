import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { promisify } from "node:util";
import { tmpdir } from "node:os";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CORE_PACKAGES = ["protocol", "core"];
const SDK_PACKAGE_LEAVES = new Set([...CORE_PACKAGES, "node-host"]);

export function parseArguments(argv) {
  const options = {
    destination: undefined,
    includeNodeHost: false,
    prune: false,
    verify: true,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--destination") {
      const value = argv[++index];
      if (!value) throw new Error("--destination requires a path");
      options.destination = path.resolve(value);
    } else if (argument === "--include-node-host") {
      options.includeNodeHost = true;
    } else if (argument === "--prune") {
      options.prune = true;
    } else if (argument === "--skip-verify") {
      options.verify = false;
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (!options.help && !options.destination) {
    throw new Error("--destination is required");
  }
  return options;
}

export function contentAddressedFilename(packageName, version, sha256) {
  const leafName = packageName.slice("@agentlink/".length);
  if (!/^[a-z0-9-]+$/.test(leafName)) throw new Error("Invalid package name");
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Invalid package version: ${version}`);
  }
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("Invalid SHA-256 digest");
  return `agentlink-${leafName}-${version}-${sha256}.tgz`;
}

export function selectSupersededArtifactFilenames(previousManifest, entries) {
  if (previousManifest === undefined) return [];
  if (
    !previousManifest ||
    typeof previousManifest !== "object" ||
    !Array.isArray(previousManifest.packages)
  ) {
    throw new Error("Cannot prune from an invalid previous SDK manifest");
  }
  const current = new Set(entries.map((entry) => entry.filename));
  const superseded = new Set();
  const candidates = [
    ...previousManifest.packages.map((entry) => entry?.filename),
    ...(Array.isArray(previousManifest.pendingPrune)
      ? previousManifest.pendingPrune
      : []),
  ];
  for (const filename of candidates) {
    const match =
      typeof filename === "string"
        ? filename.match(
            /^agentlink-([a-z0-9-]+)-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?-[a-f0-9]{64}\.tgz$/,
          )
        : null;
    if (
      !match ||
      path.basename(filename) !== filename ||
      !SDK_PACKAGE_LEAVES.has(match[1])
    ) {
      throw new Error(
        "Previous SDK manifest contains an unsafe artifact filename",
      );
    }
    if (!current.has(filename)) superseded.add(filename);
  }
  return [...superseded].sort();
}

export function mergeRequiredPeerDependencies(packages) {
  const merged = {};
  for (const entry of packages) {
    for (const [name, range] of Object.entries(entry.peerDependencies ?? {})) {
      if (merged[name] !== undefined && merged[name] !== range) {
        throw new Error(
          `Conflicting required peer dependency ${name}: ${merged[name]} vs ${range}`,
        );
      }
      merged[name] = range;
    }
  }
  return merged;
}

export function validatePackageSet(packages, includeNodeHost) {
  const byName = new Map(packages.map((entry) => [entry.name, entry]));
  const protocol = byName.get("@agentlink/protocol");
  const core = byName.get("@agentlink/core");
  if (!protocol || !core)
    throw new Error("The SDK bundle requires protocol and core");
  if (core.dependencies?.["@agentlink/protocol"] !== protocol.version) {
    throw new Error("Core must depend on the exact vendored protocol version");
  }
  const nodeHost = byName.get("@agentlink/node-host");
  if (includeNodeHost && !nodeHost) {
    throw new Error("The requested SDK bundle requires node-host");
  }
  if (nodeHost) {
    if (
      nodeHost.dependencies?.["@agentlink/core"] !== core.version ||
      nodeHost.dependencies?.["@agentlink/protocol"] !== protocol.version
    ) {
      throw new Error(
        "Node-host must depend on the exact vendored core and protocol versions",
      );
    }
  }
}

async function run(command, args, options = {}) {
  try {
    return await execFileAsync(command, args, {
      cwd: options.cwd ?? ROOT,
      env: { ...process.env, ...options.env },
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (error) {
    const detail = [error.stdout, error.stderr].filter(Boolean).join("\n");
    throw new Error(`Command failed: ${command} ${args.join(" ")}\n${detail}`, {
      cause: error,
    });
  }
}

async function packWorkspace(packageName, packDirectory, cacheDirectory) {
  const { stdout } = await run(
    "npm",
    [
      "pack",
      "--workspace",
      packageName,
      "--json",
      "--pack-destination",
      packDirectory,
    ],
    { env: { npm_config_cache: cacheDirectory } },
  );
  const packed = JSON.parse(stdout)[0];
  if (!packed?.filename)
    throw new Error(`npm pack returned no ${packageName} artifact`);
  const manifest = JSON.parse(
    await readFile(
      path.join(
        ROOT,
        "packages",
        packageName.slice("@agentlink/".length),
        "package.json",
      ),
      "utf8",
    ),
  );
  return {
    name: manifest.name,
    version: manifest.version,
    dependencies: manifest.dependencies ?? {},
    peerDependencies: manifest.peerDependencies ?? {},
    source: path.join(packDirectory, packed.filename),
  };
}

async function readPreviousManifest(manifestPath) {
  try {
    return JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    if (error instanceof SyntaxError) {
      throw new Error("Cannot prune from an invalid previous SDK manifest", {
        cause: error,
      });
    }
    throw error;
  }
}

async function sha256File(filePath) {
  return createHash("sha256")
    .update(await readFile(filePath))
    .digest("hex");
}

async function copyAtomically(source, destination) {
  const temporary = `${destination}.${process.pid}.tmp`;
  try {
    await copyFile(source, temporary);
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function verifyCleanInstall(
  entries,
  requiredPeerDependencies,
  cacheDirectory,
) {
  const directory = await mkdtemp(
    path.join(tmpdir(), "agentlink-sdk-vendor-check-"),
  );
  try {
    const dependencies = {
      ...requiredPeerDependencies,
      ...Object.fromEntries(
        entries.map((entry) => [entry.name, `file:${entry.absolutePath}`]),
      ),
    };
    await writeFile(
      path.join(directory, "package.json"),
      `${JSON.stringify(
        {
          name: "agentlink-sdk-vendor-check",
          private: true,
          type: "module",
          dependencies,
        },
        null,
        2,
      )}\n`,
    );
    await run(
      "npm",
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--prefer-offline",
      ],
      { cwd: directory, env: { npm_config_cache: cacheDirectory } },
    );
    await run(
      "node",
      [
        "--input-type=module",
        "--eval",
        'await import("@agentlink/protocol"); await import("@agentlink/core");',
      ],
      { cwd: directory },
    );
    if (entries.some((entry) => entry.name === "@agentlink/node-host")) {
      await run(
        "node",
        [
          "--input-type=module",
          "--eval",
          'await import("@agentlink/node-host");',
        ],
        { cwd: directory },
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function vendorAgentLinkSdk(options) {
  const destination = path.resolve(options.destination);
  const packageNames = [
    ...CORE_PACKAGES.map((name) => `@agentlink/${name}`),
    ...(options.includeNodeHost ? ["@agentlink/node-host"] : []),
  ];
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "agentlink-sdk-pack-"),
  );
  try {
    await mkdir(destination, { recursive: true });
    const manifestPath = path.join(destination, "agentlink-sdk-artifacts.json");
    const previousManifest = options.prune
      ? await readPreviousManifest(manifestPath)
      : undefined;
    const cacheDirectory = path.join(temporaryRoot, "npm-cache");
    await mkdir(cacheDirectory, { recursive: true });
    const packed = [];
    for (const packageName of packageNames) {
      packed.push(
        await packWorkspace(packageName, temporaryRoot, cacheDirectory),
      );
    }
    validatePackageSet(packed, options.includeNodeHost);

    const entries = [];
    for (const artifact of packed) {
      const sha256 = await sha256File(artifact.source);
      const filename = contentAddressedFilename(
        artifact.name,
        artifact.version,
        sha256,
      );
      const absolutePath = path.join(destination, filename);
      await copyAtomically(artifact.source, absolutePath);
      entries.push({
        name: artifact.name,
        version: artifact.version,
        filename,
        sha256,
        absolutePath,
      });
    }
    const requiredPeerDependencies = mergeRequiredPeerDependencies(packed);
    if (options.verify !== false) {
      await verifyCleanInstall(
        entries,
        requiredPeerDependencies,
        cacheDirectory,
      );
    }

    const manifest = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      options: {
        includeNodeHost: options.includeNodeHost === true,
        prune: options.prune === true,
        verifyCleanInstall: options.verify !== false,
      },
      requiredPeerDependencies,
      verifiedCleanInstall: options.verify !== false,
      packages: entries.map(
        ({ absolutePath: _absolutePath, ...entry }) => entry,
      ),
      packageJsonDependencies: Object.fromEntries(
        entries.map((entry) => [
          entry.name,
          `file:vendor/agentlink/${entry.filename}`,
        ]),
      ),
    };
    const superseded = options.prune
      ? selectSupersededArtifactFilenames(previousManifest, entries)
      : [];
    const temporaryManifest = `${manifestPath}.${process.pid}.tmp`;
    const publishManifest = async (value) => {
      await writeFile(temporaryManifest, `${JSON.stringify(value, null, 2)}\n`);
      await rename(temporaryManifest, manifestPath);
    };
    if (superseded.length > 0) {
      await publishManifest({ ...manifest, pendingPrune: superseded });
      for (const filename of superseded) {
        await rm(path.join(destination, filename), { force: true });
      }
    }
    await publishManifest(manifest);
    return { destination, manifestPath, manifest, pruned: superseded };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

function printHelp() {
  console.log(`Usage: npm run vendor:core-sdk -- --destination <directory> [options]

Options:
  --include-node-host  Include @agentlink/node-host and its local package pair
  --prune              Remove only superseded artifacts named by the previous manifest
  --skip-verify        Skip the default isolated clean-install/import check
  -h, --help           Show this help`);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  const result = await vendorAgentLinkSdk(options);
  console.log(`Vendored AgentLink SDK to ${result.destination}`);
  for (const entry of result.manifest.packages) {
    console.log(`${entry.name} ${entry.version} sha256:${entry.sha256}`);
  }
  if (result.pruned.length > 0) {
    console.log(`Pruned: ${result.pruned.join(", ")}`);
  }
  console.log(`Manifest: ${result.manifestPath}`);
}

const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) await main();
