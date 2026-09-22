import { execFileSync, spawnSync } from "node:child_process";
import {
  verifyVsixExcludesDesktop,
  verifyVsixManifestExcludesDesktop,
} from "./verify-vsix-boundary.mjs";

import { fileURLToPath } from "node:url";
import { filterVsceFileCountWarning } from "./package-vsix-output.mjs";
import path from "node:path";
import process from "node:process";
import { readFileSync } from "node:fs";
import { resolveRetrievalRuntimeTarget } from "./package-retrieval-runtime.mjs";
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
