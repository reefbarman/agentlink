import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { verifyCliPackage } from "../../scripts/verify-cli-package.mjs";

const root = import.meta.dirname;
const artifacts = path.join(root, "artifacts");
await rm(artifacts, { recursive: true, force: true });
await mkdir(artifacts, { recursive: true });
const json = JSON.parse(
  execFileSync("npm", ["pack", "--json", "--pack-destination", artifacts], {
    cwd: root,
    encoding: "utf8",
  }),
);
const packed = json[0];
const manifest = JSON.parse(
  await readFile(path.join(root, "package.json"), "utf8"),
);
const runtimeManifest = JSON.parse(
  await readFile(path.join(root, "dist", "runtime-manifest.json"), "utf8"),
);
verifyCliPackage(
  manifest,
  packed.files.map((file) => `package/${file.path}`),
  runtimeManifest,
);
const installRoot = await mkdtemp(
  path.join(os.tmpdir(), "agentlink-cli-install-"),
);
try {
  execFileSync(
    "npm",
    ["install", "--ignore-scripts", path.join(artifacts, packed.filename)],
    { cwd: installRoot, stdio: "pipe" },
  );
  const dependencyTree = JSON.parse(
    execFileSync("npm", ["ls", "--all", "--omit=dev", "--json"], {
      cwd: installRoot,
      encoding: "utf8",
    }),
  );
  const installedDependencies =
    collectInstalledDependencyNames(dependencyTree).sort();
  const expectedDependencies = [
    "@agentlink/cli",
    "@napi-rs/keyring",
    "@napi-rs/keyring-darwin-arm64",
  ];
  if (
    JSON.stringify(installedDependencies) !==
    JSON.stringify(expectedDependencies)
  ) {
    throw new Error(
      `Unexpected production dependency closure: ${installedDependencies.join(", ")}`,
    );
  }
  execFileSync(
    process.execPath,
    ["--input-type=module", "--eval", 'await import("@napi-rs/keyring")'],
    { cwd: installRoot, stdio: "pipe" },
  );
  const cliPackageRoot = path.join(
    installRoot,
    "node_modules",
    "@agentlink",
    "cli",
  );
  const thirdPartyNotices = await readFile(
    path.join(cliPackageRoot, "THIRD_PARTY_NOTICES.md"),
    "utf8",
  );
  for (const [inventoryName, version] of Object.entries({
    ...runtimeManifest.bundledDependencies,
    [runtimeManifest.assets.ripgrep.package]:
      runtimeManifest.assets.ripgrep.packageVersion,
  })) {
    const name = inventoryName.endsWith(`@${version}`)
      ? inventoryName.slice(0, -version.length - 1)
      : inventoryName;
    if (!thirdPartyNotices.includes(`## ${name} ${version}\n`)) {
      throw new Error(`Third-party notices omit ${name}@${version}`);
    }
  }
  const ripgrep = path.join(cliPackageRoot, "dist", "rg");
  const ripgrepBytes = await readFile(ripgrep);
  const ripgrepHash = createHash("sha256").update(ripgrepBytes).digest("hex");
  if (ripgrepHash !== runtimeManifest.assets.ripgrep.sha256) {
    throw new Error(
      "Installed ripgrep checksum does not match runtime manifest",
    );
  }
  const ripgrepVersion = execFileSync(ripgrep, ["--version"], {
    cwd: installRoot,
    encoding: "utf8",
  });
  if (!ripgrepVersion.startsWith("ripgrep 15.0.0")) {
    throw new Error(`Unexpected installed ripgrep version: ${ripgrepVersion}`);
  }
  const searchFixture = path.join(installRoot, "search-fixture.txt");
  await writeFile(searchFixture, "standalone-ripgrep-fixture\n", "utf8");
  const searchOutput = execFileSync(
    ripgrep,
    ["--fixed-strings", "standalone-ripgrep-fixture", searchFixture],
    { cwd: installRoot, encoding: "utf8" },
  );
  if (!searchOutput.includes("standalone-ripgrep-fixture")) {
    throw new Error("Installed ripgrep binary did not return fixture content");
  }
  const installedCli = path.join(
    installRoot,
    "node_modules",
    ".bin",
    "agentlink",
  );
  const output = execFileSync(installedCli, ["--help"], {
    cwd: installRoot,
    encoding: "utf8",
  });
  if (
    !output.includes("Usage: agentlink [options] [command]") ||
    !output.includes("auth") ||
    !output.includes("chat")
  ) {
    throw new Error("Installed CLI did not render command help");
  }
  const installedTuiSmoke = execFileSync(
    process.execPath,
    [path.join(root, "smoke-tui.mjs"), installedCli, "--no-color"],
    { cwd: installRoot, encoding: "utf8" },
  );
  if (!installedTuiSmoke.includes("TUI no-colour launch")) {
    throw new Error("Installed CLI did not pass the no-colour PTY smoke");
  }
  process.stdout.write(
    `${packed.filename}: ${packed.size} bytes, exact inventory/dependencies, native Keychain, ripgrep, help, and installed no-colour PTY passed\n`,
  );
} finally {
  await rm(installRoot, { recursive: true, force: true });
}

function collectInstalledDependencyNames(tree) {
  const names = [];
  function visit(dependencies) {
    for (const [name, dependency] of Object.entries(dependencies ?? {})) {
      // npm includes platform-incompatible optional dependencies as name-only
      // placeholders. Installed packages have a resolved version.
      if (typeof dependency.version !== "string") continue;
      names.push(name);
      visit(dependency.dependencies);
    }
  }
  visit(tree.dependencies);
  return [...new Set(names)];
}
