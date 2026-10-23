import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";

import { execFileSync } from "node:child_process";
import path from "node:path";

/**
 * Standalone CLI release targets. Every downloaded asset is pinned by hash so
 * a target can be packaged from any build host: assets for the host come from
 * the installed node_modules, and assets for other targets are fetched from
 * npm or nodejs.org and checked against these pins.
 */
export const CLI_NODE_VERSION = "22.23.3";
export const CLI_RIPGREP_PACKAGE_VERSION = "1.18.0";
export const CLI_RIPGREP_BINARY_VERSION = "15.0.0";

export const CLI_TARGETS = Object.freeze({
  "darwin-arm64": Object.freeze({
    id: "darwin-arm64",
    platform: "darwin",
    arch: "arm64",
    label: "macOS Apple Silicon",
    signable: true,
    nodeArchiveSha256:
      "23b25245dcfb9af7262f8ff142e9e2e0af025368117329e7a7458a51e5922f53",
    ripgrep: Object.freeze({
      package: "@vscode/ripgrep-darwin-arm64",
      sha256:
        "6ef40346bf31fcce79d9614c7745c198542925a0c7d4911e1ffe794c53392ac1",
      integrity: undefined,
    }),
    keyring: Object.freeze({
      package: "@napi-rs/keyring-darwin-arm64",
      addon: "keyring.darwin-arm64.node",
      integrity: undefined,
    }),
  }),
  "linux-x64": Object.freeze({
    id: "linux-x64",
    platform: "linux",
    arch: "x64",
    label: "Linux x64 (glibc)",
    signable: false,
    nodeArchiveSha256:
      "1084aa36196bba4c3a5e69a1ee388a6e4ff729dad09445fbcd434b28fe3c24af",
    ripgrep: Object.freeze({
      package: "@vscode/ripgrep-linux-x64",
      sha256:
        "193906679498de4d939345b937fa24e0e69a03c244bd70c859f5e41232713f21",
      integrity:
        "sha512-mQ3bVrUpnD2vs7QT0vX90Lt0cnUq467uFtEktIdsJJmW296RoSULRGqWgzG1AKxyBpNDD6l4ZO4qKf6SgyC23Q==",
    }),
    keyring: Object.freeze({
      package: "@napi-rs/keyring-linux-x64-gnu",
      addon: "keyring.linux-x64-gnu.node",
      integrity:
        "sha512-NHfMyYyu6laqRBzgfsB0zN12l+z5gz6xQqmLDT8ijevMMOc9ICcVo2GUJCPSX5WvRBgzui91D4R4QG0tahMurw==",
    }),
  }),
  "linux-arm64": Object.freeze({
    id: "linux-arm64",
    platform: "linux",
    arch: "arm64",
    label: "Linux arm64 (glibc)",
    signable: false,
    nodeArchiveSha256:
      "5ced2d48d1d7198739b7f86804de0171aefb6823b684b12341d3321afc3cb0b2",
    ripgrep: Object.freeze({
      package: "@vscode/ripgrep-linux-arm64",
      sha256:
        "e152ea689d6e8420357e592f0d8253b96476c164118ca3e6e13074fa1705ddda",
      integrity:
        "sha512-lQ/5zTG++U0E3IhVgS4EPTTn/U4okncaRMM5GOFfOYZywS4nuD31GhkHbNYlDk5CuDC68+hYJ0/eQeyCKJDA+g==",
    }),
    keyring: Object.freeze({
      package: "@napi-rs/keyring-linux-arm64-gnu",
      addon: "keyring.linux-arm64-gnu.node",
      integrity:
        "sha512-AcMk+ZDP8H20Ml5vaTuSh/Ibh5vU4lrAavS2tjoJ7EJJBLDYssONINWrvVgy43SfzntgQVDBcU5GlMI+z5IMFA==",
    }),
  }),
});

export const CLI_TARGET_IDS = Object.freeze(Object.keys(CLI_TARGETS));

/** Bundle directory name inside a release archive. */
export function cliBundleName(targetId) {
  return `agentlink-cli-${requireCliTarget(targetId).id}`;
}

export function cliNodeArchiveName(targetId) {
  return `node-v${CLI_NODE_VERSION}-${requireCliTarget(targetId).id}.tar.gz`;
}

export function requireCliTarget(targetId) {
  const target = CLI_TARGETS[targetId];
  if (!target) {
    throw new Error(
      `Unsupported CLI target: ${targetId}. Expected one of ${CLI_TARGET_IDS.join(", ")}.`,
    );
  }
  return target;
}

/**
 * `--target <id>` from argv, else AGENTLINK_CLI_TARGET, else the host when it
 * is a supported target.
 */
export function resolveCliTarget({
  argv = process.argv,
  env = process.env,
  platform = process.platform,
  arch = process.arch,
} = {}) {
  const flag = argv.indexOf("--target");
  const requested =
    flag >= 0 ? argv[flag + 1] : env.AGENTLINK_CLI_TARGET || undefined;
  if (requested) return requireCliTarget(requested);
  const host = `${platform}-${arch}`;
  if (CLI_TARGETS[host]) return CLI_TARGETS[host];
  throw new Error(
    `No CLI target for this host (${host}). Pass --target with one of ${CLI_TARGET_IDS.join(", ")}.`,
  );
}

export function isHostCliTarget(
  target,
  { platform = process.platform, arch = process.arch } = {},
) {
  return target.platform === platform && target.arch === arch;
}

export async function sha256File(file) {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
}

function sriSha512(bytes) {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function npmTarballUrl(packageName, version) {
  const base = packageName.split("/").pop();
  return `https://registry.npmjs.org/${packageName}/-/${base}-${version}.tgz`;
}

/**
 * Download a pinned npm package tarball, check its SRI integrity, and extract
 * it once into `cacheRoot`. Returns the extracted package root.
 */
export async function fetchPinnedNpmPackage({
  packageName,
  version,
  integrity,
  cacheRoot,
  download = (url, destination) =>
    execFileSync(
      "curl",
      [
        "--fail",
        "--location",
        "--show-error",
        "--silent",
        "--output",
        destination,
        url,
      ],
      { stdio: "inherit" },
    ),
}) {
  if (!integrity) {
    throw new Error(
      `${packageName}@${version} has no pinned integrity and must come from node_modules.`,
    );
  }
  const slug = `${packageName.replace(/[@/]/gu, "_")}-${version}`;
  const extracted = path.join(cacheRoot, slug);
  const tarball = `${extracted}.tgz`;
  const marker = path.join(extracted, ".integrity");
  if (
    (await exists(marker)) &&
    (await readFile(marker, "utf8")).trim() === integrity
  ) {
    return path.join(extracted, "package");
  }
  await mkdir(cacheRoot, { recursive: true });
  if (
    !(await exists(tarball)) ||
    sriSha512(await readFile(tarball)) !== integrity
  ) {
    const partial = `${tarball}.${randomUUID()}.download`;
    try {
      download(npmTarballUrl(packageName, version), partial);
      const actual = sriSha512(await readFile(partial));
      if (actual !== integrity) {
        throw new Error(
          `${packageName}@${version} integrity mismatch: expected ${integrity}, found ${actual}`,
        );
      }
      await rename(partial, tarball);
    } finally {
      await rm(partial, { force: true });
    }
  }
  const staging = `${extracted}.${randomUUID()}.tmp`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  try {
    execFileSync("tar", ["-xzf", tarball, "-C", staging, "--no-same-owner"]);
    const manifest = JSON.parse(
      await readFile(path.join(staging, "package", "package.json"), "utf8"),
    );
    if (manifest.name !== packageName || manifest.version !== version) {
      throw new Error(
        `Fetched ${manifest.name}@${manifest.version}, expected ${packageName}@${version}.`,
      );
    }
    await writeFile(path.join(staging, ".integrity"), `${integrity}\n`);
    await rm(extracted, { recursive: true, force: true });
    await rename(staging, extracted);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return path.join(extracted, "package");
}

/**
 * Root of a target's native package: node_modules on a matching host,
 * otherwise a pinned download. `fetchOptions` is forwarded for tests.
 */
export async function resolveCliTargetPackage({
  repoRoot,
  target,
  asset,
  version,
  fetchOptions = {},
}) {
  const installed = path.join(repoRoot, "node_modules", asset.package);
  if (
    isHostCliTarget(target) &&
    (await exists(path.join(installed, "package.json")))
  ) {
    return installed;
  }
  return await fetchPinnedNpmPackage({
    packageName: asset.package,
    version,
    integrity: asset.integrity,
    cacheRoot: path.join(repoRoot, "tmp", "cli-npm"),
    ...fetchOptions,
  });
}
