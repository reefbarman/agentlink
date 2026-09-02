import {
  getRetrievalNativePackage,
  resolveRetrievalRuntimeTarget,
} from "./package-retrieval-runtime.mjs";

import { fileURLToPath } from "node:url";
import path from "node:path";
import { readFile } from "node:fs/promises";

const REQUIRED_PATHS = [
  "package.json",
  "README.md",
  "dist/extension.js",
  "dist/compose-runtime.mjs",
  "dist/indexer-worker.js",
  "dist/browser-gateway-helper.js",
  "dist/browser-gateway.js",
  "dist/browser-gateway-monaco.js",
  "dist/monaco-editor.worker.js",
  "dist/monaco-json.worker.js",
  "dist/monaco-css.worker.js",
  "dist/monaco-html.worker.js",
  "dist/monaco-ts.worker.js",
  "dist/node_modules/@lancedb/lancedb/package.json",
  "dist/node_modules/apache-arrow/package.json",
  "resources/builtin-skills/documentation/SKILL.md",
  "resources/builtin-skills/documentation/README.md",
  "resources/builtin-skills/documentation/references/capabilities.md",
  "resources/builtin-skills/documentation/references/getting-started.md",
  "resources/builtin-skills/documentation/references/embedding-agentlink.md",
  "resources/builtin-skills/documentation/references/tools.md",
  "resources/builtin-skills/documentation/references/troubleshooting.md",
  "resources/builtin-skills/documentation/references/complete-reference.md",
  "resources/builtin-skills/documentation/references/package-contract.md",
  "resources/builtin-skills/documentation/references/release-notes.md",
  "resources/agent-plugins/1.0.0/plugin.schema.json",
  "resources/agent-plugins/1.0.0/mcp.schema.json",
  "resources/agent-plugins/1.0.0/README.md",
  "resources/agent-plugins/1.0.0/LICENSE.md",
  "resources/agent-plugins/1.0.0/LICENSES/Apache-2.0.txt",
  "resources/agent-plugins/1.0.0/LICENSES/CC-BY-4.0.txt",
];

function normalizePackagePath(value) {
  const normalized = value
    .trim()
    .replaceAll("\\", "/")
    .replace(/^extension\//, "");
  return normalized === "readme.md" ? "README.md" : normalized;
}

export function verifyRetrievalPackageFiles(fileList, target) {
  const expectedTarget = resolveRetrievalRuntimeTarget({ target });
  const expectedNativePackage = getRetrievalNativePackage(expectedTarget);
  const files = new Set(
    fileList.split(/\r?\n/u).map(normalizePackagePath).filter(Boolean),
  );
  const requiredPaths = [
    ...REQUIRED_PATHS,
    `dist/node_modules/${expectedNativePackage}/package.json`,
  ];
  const missing = requiredPaths.filter((required) => !files.has(required));
  const browserChunks = [...files].filter((file) =>
    file.startsWith("dist/browser-gateway-chunks/"),
  );
  if (browserChunks.length === 0) {
    missing.push("dist/browser-gateway-chunks/*.js");
  }

  const nativePackages = new Set();
  const nativeAddons = [];
  for (const file of files) {
    const packageMatch = file.match(
      /^dist\/node_modules\/(@lancedb\/lancedb-[^/]+)\//u,
    );
    if (packageMatch) {
      nativePackages.add(packageMatch[1]);
      if (file.endsWith(".node")) nativeAddons.push(file);
    }
  }

  const expectedNativeRoot = `dist/node_modules/${expectedNativePackage}/`;
  const expectedNativeAddons = nativeAddons.filter((file) =>
    file.startsWith(expectedNativeRoot),
  );
  const unexpectedNativePackages = [...nativePackages].filter(
    (packageName) => packageName !== expectedNativePackage,
  );
  const unexpectedNativeAddons = nativeAddons.filter(
    (file) => !file.startsWith(expectedNativeRoot),
  );

  const errors = [];
  if (missing.length > 0) {
    errors.push(`missing required paths: ${missing.join(", ")}`);
  }
  if (!nativePackages.has(expectedNativePackage)) {
    errors.push(`missing native package: ${expectedNativePackage}`);
  }
  if (expectedNativeAddons.length !== 1) {
    errors.push(
      `expected exactly one ${expectedNativePackage} addon, found ${expectedNativeAddons.length}`,
    );
  }
  if (unexpectedNativePackages.length > 0) {
    errors.push(
      `unexpected LanceDB native packages: ${unexpectedNativePackages.join(", ")}`,
    );
  }
  if (unexpectedNativeAddons.length > 0) {
    errors.push(
      `unexpected native addons: ${unexpectedNativeAddons.join(", ")}`,
    );
  }
  if (errors.length > 0) {
    throw new Error(
      `Invalid ${expectedTarget} VSIX inventory: ${errors.join("; ")}`,
    );
  }

  return {
    target: expectedTarget,
    nativePackage: expectedNativePackage,
    nativeAddon: expectedNativeAddons[0],
    fileCount: files.size,
  };
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--target") options.target = argv[++index];
    else if (argument === "--list") options.listPath = argv[++index];
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!options.target) throw new Error("--target is required");
  return options;
}

async function readStandardInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const options = parseArguments(process.argv.slice(2));
  const fileList = options.listPath
    ? await readFile(options.listPath, "utf8")
    : await readStandardInput();
  if (!fileList.trim()) {
    throw new Error(
      "VSIX inventory is empty; pass --list or pipe vsce ls output",
    );
  }
  const result = verifyRetrievalPackageFiles(fileList, options.target);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
