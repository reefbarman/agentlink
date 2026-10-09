import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import {
  resolveSigningPolicy,
  signMacBinary,
} from "../../scripts/macos-signing.mjs";

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { stageKeychainRuntime } from "../../scripts/package-keychain-runtime.mjs";
import { verifyCliBundle } from "../../scripts/verify-cli-bundle.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const cliRoot = path.join(repoRoot, "apps/cli");
const releaseRoot = path.join(repoRoot, "cli-releases");
const bundleName = "agentlink-cli-darwin-arm64";
const nodeVersion = "22.23.3";
const nodeArchive = `node-v${nodeVersion}-darwin-arm64.tar.gz`;
const nodeArchiveSha256 =
  "23b25245dcfb9af7262f8ff142e9e2e0af025368117329e7a7458a51e5922f53";
const assetPaths = {
  node: "node/bin/node",
  addon:
    "dist/node_modules/@napi-rs/keyring-darwin-arm64/keyring.darwin-arm64.node",
  ripgrep: "dist/rg",
};

async function sha256(file) {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
}

async function pinnedNodeArchive() {
  const cache = path.join(repoRoot, "tmp", "cli-node", nodeArchive);
  await mkdir(path.dirname(cache), { recursive: true });
  try {
    if ((await sha256(cache)) === nodeArchiveSha256) return cache;
    throw new Error(
      `Cached Node archive has an invalid SHA-256: ${cache}. Remove it before retrying.`,
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const download = `${cache}.${randomUUID()}.download`;
  try {
    execFileSync(
      "curl",
      [
        "--fail",
        "--location",
        "--show-error",
        "--silent",
        "--output",
        download,
        `https://nodejs.org/dist/v${nodeVersion}/${nodeArchive}`,
      ],
      { stdio: "inherit" },
    );
    const actual = await sha256(download);
    if (actual !== nodeArchiveSha256) {
      throw new Error(
        `Node archive SHA-256 mismatch: expected ${nodeArchiveSha256}, found ${actual}`,
      );
    }
    await rename(download, cache);
  } finally {
    await rm(download, { force: true });
  }
  return cache;
}

export async function bundleCli() {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("Standalone CLI packaging supports macOS ARM64 only.");
  }
  const policy = resolveSigningPolicy();
  const sourceManifest = JSON.parse(
    await readFile(path.join(cliRoot, "dist/runtime-manifest.json"), "utf8"),
  );
  if (
    sourceManifest.platform !== "darwin-arm64" ||
    sourceManifest.bundle !== "agentlink.js" ||
    sourceManifest.assets?.ripgrep?.path !== "rg" ||
    sourceManifest.runtimeDependencies?.["@napi-rs/keyring"] !== "2.1.0"
  ) {
    throw new Error(
      "Run node apps/cli/esbuild.mjs --package before bundling the CLI.",
    );
  }
  if (
    (await sha256(path.join(cliRoot, "dist/rg"))) !==
    sourceManifest.assets.ripgrep.sha256
  ) {
    throw new Error("Packaged ripgrep does not match the pinned source asset.");
  }
  const version = JSON.parse(
    await readFile(path.join(cliRoot, "package.json"), "utf8"),
  ).version;
  const archive = await pinnedNodeArchive();
  await mkdir(releaseRoot, { recursive: true });
  const staging = path.join(releaseRoot, `.${bundleName}-${randomUUID()}`);
  const destination = path.join(releaseRoot, bundleName);
  const tarball = path.join(releaseRoot, `${bundleName}-v${version}.tar.gz`);
  await mkdir(path.join(staging, "bin"), { recursive: true });
  try {
    await mkdir(path.join(staging, "dist"), { recursive: true });
    for (const name of ["agentlink.js", "rg", "runtime-manifest.json"]) {
      await copyFile(
        path.join(cliRoot, "dist", name),
        path.join(staging, "dist", name),
      );
    }
    for (const name of ["LICENSE", "README.md", "THIRD_PARTY_NOTICES.md"]) {
      await copyFile(path.join(cliRoot, name), path.join(staging, name));
    }
    await writeFile(
      path.join(staging, "package.json"),
      `${JSON.stringify({ name: "@agentlink/cli-standalone", version, private: true, type: "module" }, null, 2)}\n`,
    );
    await stageKeychainRuntime({
      repoRoot,
      destinationRoot: path.join(staging, "dist/node_modules"),
      target: "darwin-arm64",
    });
    execFileSync("tar", [
      "-xzf",
      archive,
      "-C",
      staging,
      `node-v${nodeVersion}-darwin-arm64/bin/node`,
      `node-v${nodeVersion}-darwin-arm64/LICENSE`,
    ]);
    const extracted = path.join(staging, `node-v${nodeVersion}-darwin-arm64`);
    await mkdir(path.join(staging, "node/bin"), { recursive: true });
    await rename(
      path.join(extracted, "bin/node"),
      path.join(staging, assetPaths.node),
    );
    await rename(
      path.join(extracted, "LICENSE"),
      path.join(staging, "node/LICENSE"),
    );
    await rm(extracted, { recursive: true });
    const launcher = path.join(staging, "bin/agentlink");
    await writeFile(
      launcher,
      '#!/bin/sh\nset -eu\n# Resolve the entrypoint symlink without relying on PATH or changing the caller environment.\nentry=$0\nwhile [ -L "$entry" ]; do\n  base=$(cd -P "$(dirname "$entry")" && pwd)\n  entry=$(readlink "$entry")\n  case "$entry" in /*) ;; *) entry=$base/$entry ;; esac\ndone\nroot=$(cd -P "$(dirname "$entry")/.." && pwd)\nexec "$root/node/bin/node" "$root/dist/agentlink.js" "$@"\n',
      { mode: 0o755 },
    );
    await chmod(launcher, 0o755);
    const upstreamSha256 = {};
    for (const [name, relative] of Object.entries(assetPaths))
      upstreamSha256[name] = await sha256(path.join(staging, relative));
    if (upstreamSha256.ripgrep !== sourceManifest.assets.ripgrep.sha256)
      throw new Error("Staged ripgrep checksum changed.");
    if (policy.mode === "development") {
      for (const [name, identifier] of Object.entries({
        addon: "com.agentlink.cli.keyring",
        ripgrep: "com.agentlink.cli.rg",
        node: "com.agentlink.cli.node",
      })) {
        signMacBinary(path.join(staging, assetPaths[name]), {
          identity: policy.identity,
          identifier,
        });
      }
    }
    const postSignSha256 = {};
    for (const [name, relative] of Object.entries(assetPaths))
      postSignSha256[name] = await sha256(path.join(staging, relative));
    const files = {};
    for (const relative of [
      "bin/agentlink",
      "node/bin/node",
      "node/LICENSE",
      "dist/agentlink.js",
      "dist/rg",
      "dist/runtime-manifest.json",
      "LICENSE",
      "README.md",
      "THIRD_PARTY_NOTICES.md",
      "package.json",
      ...(await keychainFiles(staging)),
    ]) {
      files[relative] = await sha256(path.join(staging, relative));
    }
    await writeFile(
      path.join(staging, "bundle-manifest.json"),
      `${JSON.stringify({ schemaVersion: 1, version, platform: "darwin-arm64", signing: policy.mode, node: { version: nodeVersion, archiveSha256: nodeArchiveSha256 }, upstreamSha256, postSignSha256, files }, null, 2)}\n`,
    );
    await verifyCliBundle(staging, {
      allowUnsigned: policy.mode === "unsigned",
    });
    const oldBundle = path.join(
      releaseRoot,
      `.${bundleName}-previous-${randomUUID()}`,
    );
    const archiveStage = `${tarball}.${randomUUID()}.tmp`;
    const hadBundle = await exists(destination);
    if (hadBundle) await rename(destination, oldBundle);
    try {
      await rename(staging, destination);
      execFileSync("tar", [
        "-czf",
        archiveStage,
        "-C",
        releaseRoot,
        bundleName,
      ]);
      await rename(archiveStage, tarball);
      if (hadBundle)
        await rm(oldBundle, { recursive: true, force: true }).catch(() => {
          console.warn(
            `Packaged successfully; remove obsolete build backup manually: ${oldBundle}`,
          );
        });
      return {
        destination,
        tarball,
        signing: policy.mode,
      };
    } catch (error) {
      await rm(destination, { recursive: true, force: true });
      if (hadBundle) await rename(oldBundle, destination);
      throw error;
    } finally {
      await rm(archiveStage, { force: true });
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function keychainFiles(root) {
  const paths = [];
  async function visit(dir) {
    for (const item of await readdir(path.join(root, dir), {
      withFileTypes: true,
    })) {
      const relative = path.posix.join(dir, item.name);
      if (item.isDirectory()) await visit(relative);
      else if (item.isFile()) paths.push(relative);
      else throw new Error(`Unexpected Keychain asset type: ${relative}`);
    }
  }
  await visit("dist/node_modules");
  return paths.sort();
}

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const result = await bundleCli();
  console.log(`${result.destination}\n${result.tarball} (${result.signing})`);
}
