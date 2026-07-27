import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
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
const { version } = JSON.parse(
  readFileSync(path.join(repoRoot, "package.json"), "utf8"),
);
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
run(process.execPath, [
  npmCli,
  "exec",
  "--yes",
  "--package=@vscode/vsce@3.9.2",
  "--",
  "vsce",
  "package",
  "--no-dependencies",
  "--allow-star-activation",
  "--target",
  target,
  "--out",
  outputPath,
]);
const inventory = run(
  process.execPath,
  [
    npmCli,
    "exec",
    "--yes",
    "--package=@vscode/vsce@3.9.2",
    "--",
    "vsce",
    "ls",
    "--no-dependencies",
  ],
  { capture: true },
);
const verification = verifyRetrievalPackageFiles(inventory, target);
process.stdout.write(`${JSON.stringify(verification, null, 2)}\n`);
process.stdout.write(`Built and verified ${outputPath}\n`);
