import { CLI_NODE_VERSION, CLI_TARGETS } from "./cli-targets.mjs";
import { lstat, readFile, readdir } from "node:fs/promises";

import { builtinModules } from "node:module";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { verifyMacSignature } from "./macos-signing.mjs";

const runtimePath = "node/bin/AgentLink CLI";
// Built and signed only in development signing mode; see
// scripts/build-credentials-helper.mjs.
const credentialsHelperPath = "dist/AgentLink Credentials (CLI)";
const credentialsHelperIdentifier = "com.agentlink.credentials";
const identifiers = {
  node: "com.agentlink.cli.node",
  addon: "com.agentlink.cli.keyring",
  ripgrep: "com.agentlink.cli.rg",
};
function nativePathsFor(target) {
  return {
    node: runtimePath,
    addon: `dist/node_modules/${target.keyring.package}/${target.keyring.addon}`,
    ripgrep: "dist/rg",
  };
}
function requiredFor(target) {
  return [
    "bin/agentlink",
    runtimePath,
    "node/LICENSE",
    "dist/agentlink.js",
    "dist/rg",
    "dist/runtime-manifest.json",
    "LICENSE",
    "README.md",
    "THIRD_PARTY_NOTICES.md",
    "package.json",
    "dist/node_modules/@napi-rs/keyring/package.json",
    `dist/node_modules/${target.keyring.package}/package.json`,
    nativePathsFor(target).addon,
  ];
}
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

// The CLI manifest pins the Keychain runtime exactly; derive the expected
// version from it so dependency bumps do not need matching verifier edits.
export const EXPECTED_KEYRING_VERSION = JSON.parse(
  await readFile(new URL("../apps/cli/package.json", import.meta.url), "utf8"),
).dependencies["@napi-rs/keyring"];

export async function verifyCliBundle(root, { allowUnsigned = false } = {}) {
  const manifest = JSON.parse(
    await readFile(path.join(root, "bundle-manifest.json"), "utf8"),
  );
  const target = Object.hasOwn(CLI_TARGETS, manifest.platform)
    ? CLI_TARGETS[manifest.platform]
    : undefined;
  if (
    manifest.schemaVersion !== 1 ||
    !target ||
    !/^\d+\.\d+\.\d+$/u.test(manifest.version) ||
    manifest.node?.version !== CLI_NODE_VERSION ||
    manifest.node?.archiveSha256 !== target.nodeArchiveSha256
  ) {
    throw new Error("Invalid standalone CLI bundle manifest.");
  }
  // Linux bundles have nothing to sign, so unsigned is their only mode.
  if (
    target.signable
      ? manifest.signing !== "development" &&
        !(allowUnsigned && manifest.signing === "unsigned")
      : manifest.signing !== "unsigned"
  ) {
    throw new Error(
      target.signable
        ? "CLI bundle is not development signed; unsigned previews require explicit allowUnsigned."
        : `${target.id} CLI bundles must be unsigned.`,
    );
  }
  const nativePaths = nativePathsFor(target);
  const required = requiredFor(target);
  const files = {};
  async function walk(relative = "") {
    for (const item of await readdir(path.join(root, relative), {
      withFileTypes: true,
    })) {
      const name = path.posix.join(relative, item.name);
      if (item.isDirectory()) await walk(name);
      else if (item.isFile()) {
        if (name !== "bundle-manifest.json")
          files[name] = sha(await readFile(path.join(root, name)));
      } else throw new Error(`Unexpected bundle entry: ${name}`);
    }
  }
  await walk();
  const signed = manifest.signing === "development";
  const hasHelper = Object.hasOwn(files, credentialsHelperPath);
  if (
    required.some((name) => !(name in files)) ||
    signed !== hasHelper ||
    Object.keys(files).sort().join("\n") !==
      Object.keys(manifest.files ?? {})
        .sort()
        .join("\n")
  ) {
    throw new Error(
      "CLI bundle file inventory is missing files or contains unexpected entries.",
    );
  }
  for (const [name, hash] of Object.entries(files)) {
    if (manifest.files[name] !== hash)
      throw new Error(`CLI bundle SHA-256 mismatch: ${name}`);
  }
  for (const [name, relative] of Object.entries(nativePaths)) {
    if (
      !/^[a-f0-9]{64}$/u.test(manifest.upstreamSha256?.[name] ?? "") ||
      files[relative] !== manifest.postSignSha256?.[name] ||
      (manifest.signing === "unsigned" &&
        manifest.upstreamSha256[name] !== manifest.postSignSha256[name])
    ) {
      throw new Error(
        `Invalid upstream/post-sign native asset hash: ${relative}`,
      );
    }
  }
  const packageManifest = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8"),
  );
  if (
    packageManifest.name !== "@agentlink/cli-standalone" ||
    packageManifest.version !== manifest.version ||
    packageManifest.type !== "module"
  ) {
    throw new Error("Standalone CLI must declare its ESM package boundary.");
  }
  const runtime = JSON.parse(
    await readFile(path.join(root, "dist/runtime-manifest.json"), "utf8"),
  );
  if (
    runtime.platform !== target.id ||
    runtime.bundle !== "agentlink.js" ||
    runtime.assets?.ripgrep?.path !== "rg" ||
    runtime.assets.ripgrep.package !== target.ripgrep.package ||
    runtime.assets.ripgrep.sha256 !== manifest.upstreamSha256.ripgrep ||
    runtime.runtimeDependencies?.["@napi-rs/keyring"] !==
      EXPECTED_KEYRING_VERSION ||
    runtime.externalImports
      ?.filter((name) => !name.startsWith("node:") && !importBuiltin(name))
      .join(",") !== "@napi-rs/keyring"
  ) {
    throw new Error(
      "CLI source runtime manifest does not match the standalone bundle.",
    );
  }
  const keyring = JSON.parse(
    await readFile(
      path.join(root, "dist/node_modules/@napi-rs/keyring/package.json"),
      "utf8",
    ),
  );
  const addon = JSON.parse(
    await readFile(
      path.join(
        root,
        `dist/node_modules/${target.keyring.package}/package.json`,
      ),
      "utf8",
    ),
  );
  if (
    keyring.name !== "@napi-rs/keyring" ||
    keyring.version !== EXPECTED_KEYRING_VERSION ||
    addon.name !== target.keyring.package ||
    addon.version !== EXPECTED_KEYRING_VERSION
  ) {
    throw new Error("Unexpected Keychain runtime package versions.");
  }
  for (const name of [
    "bin/agentlink",
    nativePaths.node,
    nativePaths.ripgrep,
    ...(signed ? [credentialsHelperPath] : []),
  ]) {
    if (!((await lstat(path.join(root, name))).mode & 0o111))
      throw new Error(`Not executable: ${name}`);
  }
  const launcher = await readFile(path.join(root, "bin/agentlink"), "utf8");
  if (
    !launcher.includes(
      `exec "$root/${runtimePath}" "$root/dist/agentlink.js" "$@"`,
    ) ||
    !launcher.includes('while [ -L "$entry" ]')
  )
    throw new Error("Invalid bundle-relative CLI launcher.");
  if (signed) {
    for (const [name, relative] of Object.entries(nativePaths)) {
      verifyMacSignature(path.join(root, relative), {
        identifier: identifiers[name],
      });
    }
    verifyMacSignature(path.join(root, credentialsHelperPath), {
      identifier: credentialsHelperIdentifier,
    });
  }
  return manifest;
}

const importBuiltin = (name) => builtinModules.includes(name);

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const bundle = process.argv[2];
  if (!bundle)
    throw new Error(
      "Usage: node scripts/verify-cli-bundle.mjs <bundle> [--allow-unsigned]",
    );
  const manifest = await verifyCliBundle(bundle, {
    allowUnsigned: process.argv.includes("--allow-unsigned"),
  });
  console.log(`Verified CLI bundle ${manifest.version} (${manifest.signing})`);
}
