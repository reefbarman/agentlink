import {
  CLI_NODE_VERSION,
  cliBundleName,
  cliNodeArchiveName,
  resolveCliTarget,
  resolveCliTargetPackage,
  sha256File as sha256,
} from "../../scripts/cli-targets.mjs";
import {
  EXPECTED_KEYRING_VERSION,
  verifyCliBundle,
} from "../../scripts/verify-cli-bundle.mjs";
import {
  buildCredentialsHelper,
  credentialsHelperName,
} from "../../scripts/build-credentials-helper.mjs";
import {
  chmod,
  copyFile,
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  resolveSigningPolicy,
  signMacBinary,
} from "../../scripts/macos-signing.mjs";

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { randomUUID } from "node:crypto";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const cliRoot = path.join(repoRoot, "apps/cli");
const releaseRoot = path.join(repoRoot, "cli-releases");
const nodeVersion = CLI_NODE_VERSION;
// macOS names this file in Keychain prompts, so it says "AgentLink CLI"
// rather than "node". The signing identifier stays com.agentlink.cli.node so
// existing Keychain approvals keep working. Linux uses the same path.
export const CLI_RUNTIME_PATH = "node/bin/AgentLink CLI";
export const CLI_CREDENTIALS_HELPER_PATH = `dist/${credentialsHelperName("CLI")}`;

export function cliBundleAssetPaths(target) {
  return {
    node: CLI_RUNTIME_PATH,
    addon: `dist/node_modules/${target.keyring.package}/${target.keyring.addon}`,
    ripgrep: "dist/rg",
  };
}

async function pinnedNodeArchive(target) {
  const nodeArchive = cliNodeArchiveName(target.id);
  const nodeArchiveSha256 = target.nodeArchiveSha256;
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

/** Copy the keyring loader and the target's native addon package. */
async function stageKeyringRuntime(target, destinationRoot) {
  const sources = [
    ["@napi-rs/keyring", path.join(repoRoot, "node_modules/@napi-rs/keyring")],
    [
      target.keyring.package,
      await resolveCliTargetPackage({
        repoRoot,
        target,
        asset: target.keyring,
        version: EXPECTED_KEYRING_VERSION,
      }),
    ],
  ];
  for (const [name, source] of sources) {
    const manifest = JSON.parse(
      await readFile(path.join(source, "package.json"), "utf8"),
    );
    if (manifest.name !== name || manifest.version !== EXPECTED_KEYRING_VERSION)
      throw new Error(
        `Expected ${name}@${EXPECTED_KEYRING_VERSION}, found ${manifest.name}@${manifest.version}`,
      );
    const destination = path.join(destinationRoot, name);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(source, destination, {
      recursive: true,
      force: true,
      preserveTimestamps: true,
      filter: (candidate) =>
        !candidate.endsWith(".map") && !candidate.endsWith(".integrity"),
    });
  }
}

export async function bundleCli({ target = resolveCliTarget() } = {}) {
  // Only macOS binaries are signed; Linux bundles are always unsigned and
  // have no credentials helper.
  const policy = target.signable
    ? resolveSigningPolicy()
    : { mode: "unsigned" };
  const bundleName = cliBundleName(target.id);
  const assetPaths = cliBundleAssetPaths(target);
  const sourceManifest = JSON.parse(
    await readFile(path.join(cliRoot, "dist/runtime-manifest.json"), "utf8"),
  );
  if (
    sourceManifest.platform !== target.id ||
    sourceManifest.bundle !== "agentlink.js" ||
    sourceManifest.assets?.ripgrep?.path !== "rg" ||
    sourceManifest.runtimeDependencies?.["@napi-rs/keyring"] !==
      EXPECTED_KEYRING_VERSION
  ) {
    throw new Error(
      `Run node apps/cli/esbuild.mjs --package --target ${target.id} before bundling the CLI.`,
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
  const archive = await pinnedNodeArchive(target);
  const nodeDirectory = `node-v${nodeVersion}-${target.id}`;
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
    await stageKeyringRuntime(target, path.join(staging, "dist/node_modules"));
    execFileSync("tar", [
      "-xzf",
      archive,
      "-C",
      staging,
      `${nodeDirectory}/bin/node`,
      `${nodeDirectory}/LICENSE`,
    ]);
    const extracted = path.join(staging, nodeDirectory);
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
      `#!/bin/sh\nset -eu\n# Resolve the entrypoint symlink without relying on PATH or changing the caller environment.\nentry=$0\nwhile [ -L "$entry" ]; do\n  base=$(cd -P "$(dirname "$entry")" && pwd)\n  entry=$(readlink "$entry")\n  case "$entry" in /*) ;; *) entry=$base/$entry ;; esac\ndone\nroot=$(cd -P "$(dirname "$entry")/.." && pwd)\nexec "$root/${CLI_RUNTIME_PATH}" "$root/dist/agentlink.js" "$@"\n`,
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
    // The helper is compiled here rather than downloaded, so it has no
    // upstream hash. Unsigned builds skip it and use direct Keychain access.
    const helper = target.signable
      ? await buildCredentialsHelper({
          outputPath: path.join(staging, CLI_CREDENTIALS_HELPER_PATH),
          policy,
        })
      : undefined;
    const postSignSha256 = {};
    for (const [name, relative] of Object.entries(assetPaths))
      postSignSha256[name] = await sha256(path.join(staging, relative));
    const files = {};
    for (const relative of [
      "bin/agentlink",
      CLI_RUNTIME_PATH,
      ...(helper ? [CLI_CREDENTIALS_HELPER_PATH] : []),
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
      `${JSON.stringify({ schemaVersion: 1, version, platform: target.id, signing: policy.mode, node: { version: nodeVersion, archiveSha256: target.nodeArchiveSha256 }, upstreamSha256, postSignSha256, files }, null, 2)}\n`,
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
      // macOS tar otherwise records xattrs (such as com.apple.provenance)
      // that GNU tar warns about on every file when extracting on Linux.
      execFileSync(
        "tar",
        ["--no-xattrs", "-czf", archiveStage, "-C", releaseRoot, bundleName],
        { env: { ...process.env, COPYFILE_DISABLE: "1" } },
      );
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
