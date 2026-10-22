import {
  buildCredentialsHelper,
  credentialsHelperName,
} from "./build-credentials-helper.mjs";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import {
  verifyVsixExcludesDesktop,
  verifyVsixManifestExcludesDesktop,
} from "./verify-vsix-boundary.mjs";

import { fileURLToPath } from "node:url";
import { filterVsceFileCountWarning } from "./package-vsix-output.mjs";
import path from "node:path";
import process from "node:process";
import { resolveRetrievalRuntimeTarget } from "./package-retrieval-runtime.mjs";
import { resolveSigningPolicy } from "./macos-signing.mjs";
import { verifyRetrievalPackageFiles } from "./verify-retrieval-package.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const target = resolveRetrievalRuntimeTarget();
const manifest = JSON.parse(
  readFileSync(path.join(repoRoot, "package.json"), "utf8"),
);
const { version } = manifest;
const outputPath = process.argv[2] ?? `agentlink-${version}-${target}.vsix`;
const commandEnvironment = {
  ...process.env,
  AGENTLINK_VSCE_TARGET: target,
};
const npmCli = process.env.npm_execpath;
if (!npmCli) {
  throw new Error("npm_execpath is required; run this script through npm");
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: repoRoot,
    env: commandEnvironment,
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "inherit"] : "inherit",
  });
}

run(process.execPath, [npmCli, "run", "build"]);
await packageCredentialsHelper();

/**
 * Ship the signed Keychain helper in macOS VSIXs built where an Apple
 * Development identity is available. Other builds leave it out and VS Code
 * uses the Keychain directly, as before.
 */
async function packageCredentialsHelper() {
  const helperPath = path.join(
    repoRoot,
    "dist",
    credentialsHelperName("VS Code"),
  );
  rmSync(helperPath, { force: true });
  if (process.platform !== "darwin" || !target.startsWith("darwin-")) return;
  if (process.env.AGENTLINK_MAC_SIGNING === "unsigned") return;
  let policy;
  try {
    policy = resolveSigningPolicy();
  } catch (error) {
    process.stderr.write(
      `Skipping the AgentLink Credentials helper: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return;
  }
  await buildCredentialsHelper({
    outputPath: helperPath,
    policy,
    arch: target === "darwin-x64" ? "x64" : "arm64",
  });
}
const packaging = spawnSync(
  process.execPath,
  [
    npmCli,
    "exec",
    "--yes",
    "--package=@vscode/vsce@4.0.0",
    "--",
    "vsce",
    "package",
    "--no-dependencies",
    "--allow-star-activation",
    "--target",
    target,
    "--out",
    outputPath,
  ],
  {
    cwd: repoRoot,
    env: { ...commandEnvironment, FORCE_COLOR: "0" },
    encoding: "utf8",
    stdio: ["inherit", "inherit", "pipe"],
    maxBuffer: 10 * 1024 * 1024,
  },
);
process.stderr.write(
  packaging.status === 0
    ? filterVsceFileCountWarning(packaging.stderr)
    : packaging.stderr,
);
if (packaging.error) throw packaging.error;
if (packaging.status !== 0) process.exit(packaging.status ?? 1);
const inventory = run(
  process.execPath,
  [
    npmCli,
    "exec",
    "--yes",
    "--package=@vscode/vsce@4.0.0",
    "--",
    "vsce",
    "ls",
    "--no-dependencies",
  ],
  { capture: true },
);
const verification = verifyRetrievalPackageFiles(inventory, target);
const desktopBoundary = {
  ...verifyVsixExcludesDesktop(inventory),
  ...verifyVsixManifestExcludesDesktop(manifest),
};
process.stdout.write(
  `${JSON.stringify({ ...verification, desktopBoundary }, null, 2)}\n`,
);
process.stdout.write(`Built and verified ${outputPath}\n`);
