import {
  getRetrievalNativePackage,
  resolveRetrievalRuntimeTarget,
} from "./package-retrieval-runtime.mjs";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";

import { KEYCHAIN_NATIVE_PACKAGES } from "./package-keychain-runtime.mjs";
import { extractAll } from "@electron/asar";
import { fileURLToPath } from "node:url";
import path from "node:path";

const REQUIRED_RUNTIME_PATHS = [
  "dist/browser-gateway-helper.js",
  "dist/browser-gateway.js",
  "dist/browser-gateway.css",
  "dist/browser-gateway-monaco.js",
  "dist/browser-gateway-monaco.css",
  "dist/browser-gateway-notifications.js",
  "dist/monaco-editor.worker.js",
  "dist/monaco-json.worker.js",
  "dist/monaco-css.worker.js",
  "dist/monaco-html.worker.js",
  "dist/monaco-ts.worker.js",
  "dist/codicon.css",
  "dist/codicon.ttf",
  "resources/builtin-skills/documentation/SKILL.md",
  "media/icon.png",
  "media/agentlink-terminal.svg",
];

function normalizePath(value) {
  return value
    .trim()
    .replaceAll("\\", "/")
    .replace(/^extension\//u, "");
}

export function verifyDesktopRuntimeFiles(fileList, target) {
  const resolvedTarget = resolveRetrievalRuntimeTarget({ target });
  if (!resolvedTarget.startsWith("darwin-")) {
    throw new Error(`Unsupported desktop target: ${resolvedTarget}`);
  }
  const files = new Set(
    fileList.split(/\r?\n/u).map(normalizePath).filter(Boolean),
  );
  const nativePackage = getRetrievalNativePackage(resolvedTarget);
  const keychainPackage = KEYCHAIN_NATIVE_PACKAGES[resolvedTarget];
  if (!keychainPackage) {
    throw new Error(`Unsupported desktop Keychain target: ${resolvedTarget}`);
  }
  const required = [
    ...REQUIRED_RUNTIME_PATHS,
    "dist/node_modules/@lancedb/lancedb/package.json",
    "dist/node_modules/apache-arrow/package.json",
    `dist/node_modules/${nativePackage}/package.json`,
    "node_modules/@napi-rs/keyring/package.json",
    `node_modules/${keychainPackage}/package.json`,
  ];
  const missing = required.filter((entry) => !files.has(entry));
  if (
    ![...files].some(
      (file) =>
        file.startsWith("dist/browser-gateway-chunks/") && file.endsWith(".js"),
    )
  ) {
    missing.push("dist/browser-gateway-chunks/*.js");
  }
  const nativeAddons = [...files].filter((file) => file.endsWith(".node"));
  const expectedLancePrefix = `dist/node_modules/${nativePackage}/`;
  const expectedKeychainPrefix = `node_modules/${keychainPackage}/`;
  const lancedbAddons = nativeAddons.filter((file) =>
    file.startsWith(expectedLancePrefix),
  );
  const keychainAddons = nativeAddons.filter((file) =>
    file.startsWith(expectedKeychainPrefix),
  );
  const unexpectedNativeAddons = nativeAddons.filter(
    (file) =>
      !file.startsWith(expectedLancePrefix) &&
      !file.startsWith(expectedKeychainPrefix),
  );
  if (lancedbAddons.length !== 1) {
    missing.push(`exactly one ${nativePackage} addon`);
  }
  if (keychainAddons.length !== 1) {
    missing.push(`exactly one ${keychainPackage} addon`);
  }
  if (missing.length > 0 || unexpectedNativeAddons.length > 0) {
    throw new Error(
      `Invalid ${resolvedTarget} desktop runtime: ${[
        missing.length > 0 ? `missing ${missing.join(", ")}` : "",
        unexpectedNativeAddons.length > 0
          ? `unexpected native addons ${unexpectedNativeAddons.join(", ")}`
          : "",
      ]
        .filter(Boolean)
        .join("; ")}`,
    );
  }
  return {
    target: resolvedTarget,
    nativePackage,
    nativeAddon: lancedbAddons[0],
    keychainPackage,
    keychainAddon: keychainAddons[0],
    fileCount: files.size,
  };
}

async function listFiles(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) files.push(path.relative(root, absolute));
    }
  }
  await visit(root);
  return files.sort().join("\n");
}

async function verifyPackagedApp(appPath, target) {
  const resourcesPath = path.join(appPath, "Contents", "Resources");
  const runtimePath = path.join(resourcesPath, "runtime");
  const appAsar = path.join(resourcesPath, "app.asar");
  const appAsarStat = await stat(appAsar);
  if (!appAsarStat.isFile() || appAsarStat.size === 0) {
    throw new Error(`Desktop app.asar is missing or empty: ${appAsar}`);
  }
  const extractedApp = await mkdtemp(
    path.join(
      process.env.RUNNER_TEMP ?? process.env.TMPDIR ?? "/tmp",
      "agentlink-app-",
    ),
  );
  try {
    extractAll(appAsar, extractedApp);
    const runtimeListing = await listFiles(runtimePath);
    const appListing = await listFiles(extractedApp);
    const unpackedRoot = path.join(resourcesPath, "app.asar.unpacked");
    const unpackedListing = await listFiles(unpackedRoot).catch(() => "");
    const nativeListing = `${appListing}\n${unpackedListing}`
      .split("\n")
      .filter(Boolean)
      .map((file) => `node_modules/${file.replace(/^node_modules\//u, "")}`)
      .join("\n");
    const runtime = verifyDesktopRuntimeFiles(
      `${runtimeListing}\n${nativeListing}`,
      target,
    );
    return { ...runtime, appPath, appAsarBytes: appAsarStat.size };
  } finally {
    await rm(extractedApp, { recursive: true, force: true });
  }
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--app") options.appPath = argv[++index];
    else if (argument === "--target") options.target = argv[++index];
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (options.appPath) {
    if (!options.target) throw new Error("--target is required with --app");
    return options;
  }
  throw new Error("Pass --app <path> --target <target>");
}

const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const options = parseArguments(process.argv.slice(2));
  const result = await verifyPackagedApp(options.appPath, options.target);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
