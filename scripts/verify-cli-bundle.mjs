import { lstat, readFile, readdir } from "node:fs/promises";

import { builtinModules } from "node:module";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { verifyMacSignature } from "./macos-signing.mjs";

const nativePaths = {
  node: "node/bin/node",
  addon:
    "dist/node_modules/@napi-rs/keyring-darwin-arm64/keyring.darwin-arm64.node",
  ripgrep: "dist/rg",
};
const identifiers = {
  node: "com.agentlink.cli.node",
  addon: "com.agentlink.cli.keyring",
  ripgrep: "com.agentlink.cli.rg",
};
const required = [
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
  "dist/node_modules/@napi-rs/keyring/package.json",
  "dist/node_modules/@napi-rs/keyring-darwin-arm64/package.json",
  nativePaths.addon,
];
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function verifyCliBundle(root, { allowUnsigned = false } = {}) {
  const manifest = JSON.parse(
    await readFile(path.join(root, "bundle-manifest.json"), "utf8"),
  );
  if (
    manifest.schemaVersion !== 1 ||
    manifest.platform !== "darwin-arm64" ||
    !/^\d+\.\d+\.\d+$/u.test(manifest.version) ||
    manifest.node?.version !== "22.23.3" ||
    manifest.node?.archiveSha256 !==
      "23b25245dcfb9af7262f8ff142e9e2e0af025368117329e7a7458a51e5922f53"
  ) {
    throw new Error("Invalid standalone CLI bundle manifest.");
  }
  if (
    manifest.signing !== "development" &&
    !(allowUnsigned && manifest.signing === "unsigned")
  ) {
    throw new Error(
      "CLI bundle is not development signed; unsigned previews require explicit allowUnsigned.",
    );
  }
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
  if (
    required.some((name) => !(name in files)) ||
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
    runtime.platform !== "darwin-arm64" ||
    runtime.bundle !== "agentlink.js" ||
    runtime.assets?.ripgrep?.path !== "rg" ||
    runtime.assets.ripgrep.sha256 !== manifest.upstreamSha256.ripgrep ||
    runtime.runtimeDependencies?.["@napi-rs/keyring"] !== "2.1.0" ||
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
        "dist/node_modules/@napi-rs/keyring-darwin-arm64/package.json",
      ),
      "utf8",
    ),
  );
  if (
    keyring.name !== "@napi-rs/keyring" ||
    keyring.version !== "2.1.0" ||
    addon.name !== "@napi-rs/keyring-darwin-arm64" ||
    addon.version !== "2.1.0"
  ) {
    throw new Error("Unexpected Keychain runtime package versions.");
  }
  for (const name of ["bin/agentlink", nativePaths.node, nativePaths.ripgrep]) {
    if (!((await lstat(path.join(root, name))).mode & 0o111))
      throw new Error(`Not executable: ${name}`);
  }
  const launcher = await readFile(path.join(root, "bin/agentlink"), "utf8");
  if (
    !launcher.includes(
      'exec "$root/node/bin/node" "$root/dist/agentlink.js" "$@"',
    ) ||
    !launcher.includes('while [ -L "$entry" ]')
  )
    throw new Error("Invalid bundle-relative CLI launcher.");
  if (manifest.signing === "development") {
    for (const [name, relative] of Object.entries(nativePaths)) {
      verifyMacSignature(path.join(root, relative), {
        identifier: identifiers[name],
      });
    }
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
