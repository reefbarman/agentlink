import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";

import { KEYCHAIN_NATIVE_PACKAGES } from "../../scripts/package-keychain-runtime.mjs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { stageKeychainRuntime } from "../../scripts/package-keychain-runtime.mjs";
import { stageRetrievalRuntime } from "../../scripts/package-retrieval-runtime.mjs";
import { verifyDesktopRuntimeFiles } from "../../scripts/verify-desktop-package.mjs";

const desktopRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(desktopRoot, "../..");
const stageRoot = path.join(desktopRoot, "package-stage");
const runtimeRoot = path.join(stageRoot, "runtime");
const target = resolveTarget(process.argv.slice(2));
const arch = target.slice("darwin-".length);
const desktopManifest = JSON.parse(
  await readFile(path.join(desktopRoot, "package.json"), "utf8"),
);
const outputDir = path.join(repoRoot, "desktop-releases");

await rm(stageRoot, { recursive: true, force: true });
await cleanCurrentTargetArtifacts();
await Promise.all([
  mkdir(path.join(stageRoot, "dist"), { recursive: true }),
  mkdir(path.join(stageRoot, "node_modules"), { recursive: true }),
  mkdir(path.join(runtimeRoot, "dist"), { recursive: true }),
  mkdir(path.join(runtimeRoot, "media"), { recursive: true }),
]);

await copyDesktopShell();
await copySharedRuntime();
await stageNativeRuntime();
await verifyStagedRuntime();

execFileSync(
  process.execPath,
  [
    path.join(repoRoot, "node_modules", "electron-builder", "cli.js"),
    "--projectDir",
    stageRoot,
    "--config",
    path.join(desktopRoot, "electron-builder.yml"),
    `--config.electronVersion=${desktopManifest.devDependencies.electron}`,
    "--mac",
    `--${arch}`,
    "--publish",
    "never",
  ],
  {
    cwd: desktopRoot,
    env: {
      ...process.env,
      CSC_IDENTITY_AUTO_DISCOVERY: "false",
    },
    stdio: "inherit",
  },
);

const unpackedOutputDir = path.join(
  outputDir,
  arch === "arm64" ? "mac-arm64" : "mac",
);
const appPath = await findPackagedApp(unpackedOutputDir);
execFileSync(
  process.execPath,
  [
    path.join(repoRoot, "scripts", "verify-desktop-package.mjs"),
    "--app",
    appPath,
    "--target",
    target,
  ],
  { cwd: repoRoot, stdio: "inherit" },
);

async function copyDesktopShell() {
  await cp(path.join(desktopRoot, "dist"), path.join(stageRoot, "dist"), {
    recursive: true,
    filter: (source) => !source.endsWith(".map"),
  });
  await writeFile(
    path.join(stageRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "agentlink-desktop",
        productName: "AgentLink",
        version: desktopManifest.version,
        description: desktopManifest.description,
        license: "MIT",
        main: "dist/main.cjs",
        dependencies: {
          "@napi-rs/keyring": desktopManifest.dependencies["@napi-rs/keyring"],
        },
      },
      null,
      2,
    )}\n`,
  );
}

async function copySharedRuntime() {
  const runtimeDist = path.join(runtimeRoot, "dist");
  const files = [
    "browser-gateway-helper.js",
    "browser-gateway.js",
    "browser-gateway.css",
    "browser-gateway-monaco.js",
    "browser-gateway-monaco.css",
    "browser-gateway-notifications.js",
    "monaco-editor.worker.js",
    "monaco-json.worker.js",
    "monaco-css.worker.js",
    "monaco-html.worker.js",
    "monaco-ts.worker.js",
    "codicon.css",
    "codicon.ttf",
  ];
  await Promise.all(
    files.map((file) =>
      cp(path.join(repoRoot, "dist", file), path.join(runtimeDist, file)),
    ),
  );
  await cp(
    path.join(repoRoot, "dist", "browser-gateway-chunks"),
    path.join(runtimeDist, "browser-gateway-chunks"),
    {
      recursive: true,
      filter: (source) => !source.endsWith(".map"),
    },
  );
  await cp(
    path.join(repoRoot, "resources", "builtin-skills"),
    path.join(runtimeRoot, "resources", "builtin-skills"),
    { recursive: true },
  );
  await Promise.all([
    cp(
      path.join(repoRoot, "media", "icon.png"),
      path.join(runtimeRoot, "media", "icon.png"),
    ),
    cp(
      path.join(repoRoot, "media", "agentlink-terminal.svg"),
      path.join(runtimeRoot, "media", "agentlink-terminal.svg"),
    ),
  ]);
}

async function stageNativeRuntime() {
  await stageRetrievalRuntime({
    repoRoot,
    destinationRoot: path.join(runtimeRoot, "dist", "node_modules"),
    target,
  });
  await stageKeychainRuntime({
    repoRoot,
    destinationRoot: path.join(stageRoot, "node_modules"),
    target,
  });
}

async function verifyStagedRuntime() {
  const listing = await listFiles(runtimeRoot);
  const keychainRoot = path.join(stageRoot, "node_modules");
  const keychainListing = await listFiles(keychainRoot);
  verifyDesktopRuntimeFiles(
    `${listing}\n${keychainListing
      .split("\n")
      .filter(Boolean)
      .map((file) => `node_modules/${file}`)
      .join("\n")}`,
    target,
  );
}

async function cleanCurrentTargetArtifacts() {
  await mkdir(outputDir, { recursive: true });
  const unpackedDirectory = arch === "arm64" ? "mac-arm64" : "mac";
  await rm(path.join(outputDir, unpackedDirectory), {
    recursive: true,
    force: true,
  });
  const artifactMarker = `-mac-${arch}.`;
  await Promise.all(
    (await readdir(outputDir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.includes(artifactMarker))
      .map((entry) => rm(path.join(outputDir, entry.name), { force: true })),
  );
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

async function findPackagedApp(root) {
  const matches = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory() && entry.name === "AgentLink.app") {
        matches.push(absolute);
      } else if (entry.isDirectory()) {
        await visit(absolute);
      }
    }
  }
  await visit(root);
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one unpacked AgentLink.app, found ${matches.length}`,
    );
  }
  return matches[0];
}

function resolveTarget(argv) {
  const targetIndex = argv.indexOf("--target");
  const requested = targetIndex >= 0 ? argv[targetIndex + 1] : undefined;
  const target = requested ?? `darwin-${process.arch}`;
  if (!(target in KEYCHAIN_NATIVE_PACKAGES)) {
    throw new Error(`Unsupported desktop target: ${target}`);
  }
  return target;
}
