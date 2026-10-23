import {
  DESKTOP_TARGETS,
  verifyDesktopRuntimeFiles,
  verifyLinuxDesktopArtifacts,
} from "../../scripts/verify-desktop-package.mjs";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import {
  resolveSigningPolicy,
  verifyMacSignature,
} from "../../scripts/macos-signing.mjs";

import { DESKTOP_KEYCHAIN_NATIVE_PACKAGES } from "../../scripts/package-keychain-runtime.mjs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { stageKeychainRuntime } from "../../scripts/package-keychain-runtime.mjs";
import { stageRetrievalRuntime } from "../../scripts/package-retrieval-runtime.mjs";
import { stageSandboxRuntime } from "../../scripts/package-sandbox-runtime.mjs";

const desktopRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(desktopRoot, "../..");
const stageRoot = path.join(desktopRoot, "package-stage");
const runtimeRoot = path.join(stageRoot, "runtime");
const target = resolveTarget(process.argv.slice(2));
const [platform, arch] = target.split("-");
const linux = platform === "linux";
// Linux AppImages are unsigned; macOS signing applies only to mac targets.
const signing = linux ? { mode: "unsigned" } : resolveSigningPolicy();
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
    ...(signing.mode === "development"
      ? [`--config.afterPack=${path.join(desktopRoot, "sign.mjs")}`]
      : []),
    // electron-builder's ${arch} is per format on x64 (AppImage "x86_64",
    // deb "amd64"), so pin Linux names to our target's arch.
    ...(linux
      ? [
          `--config.linux.artifactName=AgentLink-Desktop-\${version}-linux-${arch}.\${ext}`,
        ]
      : []),
    linux ? "--linux" : "--mac",
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

const unpackedOutputDir = path.join(outputDir, unpackedDirectoryName());
const appPath = linux
  ? unpackedOutputDir
  : await findPackagedApp(unpackedOutputDir);
if (signing.mode === "development") {
  verifyMacSignature(appPath, {
    identifier: "com.agentlink.desktop",
    deep: true,
  });
}
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
if (linux) {
  process.stdout.write(
    `${JSON.stringify(
      await verifyLinuxDesktopArtifacts({
        outputDir,
        unpackedDir: unpackedOutputDir,
        version: desktopManifest.version,
        arch,
      }),
      null,
      2,
    )}\n`,
  );
}

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
        // Required by the Linux deb metadata.
        homepage: "https://github.com/reefbarman/agentlink",
        // Linux window association with the AppImage's desktop entry.
        desktopName: "agentlink.desktop",
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
    nativePackages: DESKTOP_KEYCHAIN_NATIVE_PACKAGES,
  });
  // The Ask Agent helper runs commands in the sandbox on pipes only, so
  // node-pty (and its unsigned native prebuilds) stays out of the app. Linux
  // targets also get apply-seccomp, which the verifier then requires.
  await stageSandboxRuntime({
    repoRoot,
    destinationRoot: path.join(runtimeRoot, "dist", "sandbox-runtime"),
    target,
    includeNodePty: false,
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

/** electron-builder's unpacked output directory for this target. */
function unpackedDirectoryName() {
  const prefix = linux ? "linux" : "mac";
  if (linux)
    return arch === "x64" ? "linux-unpacked" : `linux-${arch}-unpacked`;
  return arch === "arm64" ? `${prefix}-arm64` : prefix;
}

async function cleanCurrentTargetArtifacts() {
  await mkdir(outputDir, { recursive: true });
  await rm(path.join(outputDir, unpackedDirectoryName()), {
    recursive: true,
    force: true,
  });
  const artifactMarker = `-${linux ? "linux" : "mac"}-${arch}.`;
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
  const target = requested ?? `${process.platform}-${process.arch}`;
  if (!DESKTOP_TARGETS.includes(target)) {
    throw new Error(
      `Unsupported desktop target: ${target}. Expected one of ${DESKTOP_TARGETS.join(", ")}.`,
    );
  }
  // LanceDB and the keyring are taken from this checkout's node_modules, which
  // only holds the host's native packages. Build Linux AppImages on a Linux
  // host of the same architecture (as the Linux VSIX jobs do).
  if (
    target.startsWith("linux-") &&
    target !== `${process.platform}-${process.arch}`
  ) {
    throw new Error(
      `Build the ${target} AppImage on a ${target} host; this host is ${process.platform}-${process.arch}.`,
    );
  }
  return target;
}
