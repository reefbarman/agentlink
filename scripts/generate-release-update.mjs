#!/usr/bin/env node

import { readFileSync, readdirSync, writeFileSync } from "node:fs";

import { fileURLToPath } from "node:url";
import path from "node:path";

const PRODUCTS = {
  vscode: {
    manifest: "package.json",
    tagPrefix: "v",
    channel: "stable",
    targets: [
      ["alpine-arm64", "alpine-arm64"],
      ["alpine-x64", "alpine-x64"],
      ["darwin-arm64", "darwin-arm64"],
      ["darwin-x64", "darwin-x64"],
      ["linux-arm64", "linux-arm64"],
      ["linux-x64", "linux-x64"],
      ["win32-arm64", "win32-arm64"],
      ["win32-x64", "win32-x64"],
    ],
  },
  desktop: {
    manifest: "apps/desktop/package.json",
    tagPrefix: "desktop-v",
    channel: "preview",
    targets: [
      ["darwin-arm64", "mac-arm64"],
      ["darwin-x64", "mac-x64"],
    ],
  },
  cli: {
    manifest: "apps/cli/package.json",
    tagPrefix: "cli-v",
    channel: "preview",
    targets: [["darwin-arm64", "darwin-arm64"]],
  },
};

function assetName(product, version, suffix) {
  if (product === "vscode") return `agentlink-${version}-${suffix}.vsix`;
  if (product === "desktop") {
    return `AgentLink-Desktop-${version}-${suffix}.dmg`;
  }
  return `agentlink-cli-${suffix}-v${version}.tar.gz`;
}

/** Builds release metadata from the manifest identity and files in the publish directory. */
export function generateReleaseUpdate({
  product,
  version,
  files,
  vscodeEngine,
}) {
  const config = PRODUCTS[product];
  if (!config) throw new Error(`Unsupported product: ${product}`);
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/u.test(version)) {
    throw new Error(`Invalid ${product} version: ${version}`);
  }
  if (!Array.isArray(files) || files.some((name) => typeof name !== "string")) {
    throw new Error("files must be an array of asset names");
  }

  const expected = config.targets.map(([target, suffix]) => [
    target,
    assetName(product, version, suffix),
  ]);
  const expectedNames = new Set(expected.map(([, name]) => name));
  const primaryPattern =
    product === "vscode"
      ? /\.vsix$/u
      : product === "desktop"
        ? /\.dmg$/u
        : /\.tar\.gz$/u;
  const primaryAssets = files.filter((name) => primaryPattern.test(name));
  const missing = expected
    .map(([, name]) => name)
    .filter((name) => !files.includes(name));
  const unexpected = primaryAssets.filter((name) => !expectedNames.has(name));
  if (missing.length || unexpected.length) {
    const problems = [
      ...(missing.length ? [`missing ${missing.join(", ")}`] : []),
      ...(unexpected.length ? [`unexpected ${unexpected.join(", ")}`] : []),
    ];
    throw new Error(`Invalid ${product} asset set: ${problems.join("; ")}`);
  }
  if (new Set(files).size !== files.length) {
    throw new Error("Release asset names must be unique");
  }
  if (
    product === "vscode" &&
    (typeof vscodeEngine !== "string" || !vscodeEngine)
  ) {
    throw new Error("VS Code manifest must declare engines.vscode");
  }

  const targets = Object.fromEntries(
    expected
      .map(([target, name]) => [target, name])
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  );
  return {
    schemaVersion: 1,
    product,
    version,
    tag: `${config.tagPrefix}${version}`,
    channel: config.channel,
    targets,
    engines: product === "vscode" ? { vscode: vscodeEngine } : {},
  };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    if (!["--product", "--dir", "--root"].includes(key)) {
      throw new Error(`Unknown argument: ${key}`);
    }
    const value = argv[++index];
    if (!value || value.startsWith("--"))
      throw new Error(`${key} requires a value`);
    options[key.slice(2)] = value;
  }
  if (!PRODUCTS[options.product]) {
    throw new Error("--product must be vscode, desktop, or cli");
  }
  if (!options.dir) throw new Error("--dir is required");
  return options;
}

function main(argv) {
  const options = parseArgs(argv);
  const root = path.resolve(options.root ?? process.cwd());
  const dir = path.resolve(root, options.dir);
  const manifest = JSON.parse(
    readFileSync(path.join(root, PRODUCTS[options.product].manifest), "utf8"),
  );
  const metadata = generateReleaseUpdate({
    product: options.product,
    version: manifest.version,
    vscodeEngine: manifest.engines?.vscode,
    files: readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name),
  });
  writeFileSync(
    path.join(dir, "agentlink-update.json"),
    `${JSON.stringify(metadata, null, 2)}\n`,
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
