import {
  EXPECTED_KEYRING_VERSION,
  verifyCliBundle,
} from "./verify-cli-bundle.mjs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";

import { CLI_TARGETS } from "./cli-targets.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const launcher =
  '#!/bin/sh\nset -eu\nentry=$0\nwhile [ -L "$entry" ]; do\n  base=$(cd -P "$(dirname "$entry")" && pwd)\n  entry=$(readlink "$entry")\n  case "$entry" in /*) ;; *) entry=$base/$entry ;; esac\ndone\nroot=$(cd -P "$(dirname "$entry")/.." && pwd)\nexec "$root/node/bin/AgentLink CLI" "$root/dist/agentlink.js" "$@"\n';

async function fixture(root, targetId = "darwin-arm64") {
  const target = CLI_TARGETS[targetId];
  const addonPath = `dist/node_modules/${target.keyring.package}/${target.keyring.addon}`;
  const contents = {
    "bin/agentlink": launcher,
    "node/bin/AgentLink CLI":
      '#!/bin/sh\nprintf "node=%s\\nscript=%s\\narg=%s\\nPATH=%s\\n" "$0" "$1" "$2" "$PATH"\n',
    "node/LICENSE": "node license",
    "dist/agentlink.js": "script",
    "dist/rg": "ripgrep",
    "dist/runtime-manifest.json": JSON.stringify({
      platform: target.id,
      bundle: "agentlink.js",
      assets: {
        ripgrep: {
          path: "rg",
          package: target.ripgrep.package,
          sha256: digest("ripgrep"),
        },
      },
      runtimeDependencies: { "@napi-rs/keyring": EXPECTED_KEYRING_VERSION },
      externalImports: ["@napi-rs/keyring"],
    }),
    LICENSE: "agentlink license",
    "README.md": "readme",
    "THIRD_PARTY_NOTICES.md": "notices",
    "package.json": JSON.stringify({
      name: "@agentlink/cli-standalone",
      version: "0.1.0",
      type: "module",
    }),
    "dist/node_modules/@napi-rs/keyring/package.json": JSON.stringify({
      name: "@napi-rs/keyring",
      version: EXPECTED_KEYRING_VERSION,
    }),
    [`dist/node_modules/${target.keyring.package}/package.json`]:
      JSON.stringify({
        name: target.keyring.package,
        version: EXPECTED_KEYRING_VERSION,
      }),
    [addonPath]: "addon",
  };
  const files = {};
  for (const [name, contentsValue] of Object.entries(contents)) {
    const target = path.join(root, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contentsValue);
    files[name] = digest(contentsValue);
  }
  for (const name of ["bin/agentlink", "node/bin/AgentLink CLI", "dist/rg"])
    await chmod(path.join(root, name), 0o755);
  const upstreamSha256 = {
    node: files["node/bin/AgentLink CLI"],
    addon: files[addonPath],
    ripgrep: files["dist/rg"],
  };
  const manifest = {
    schemaVersion: 1,
    version: "0.1.0",
    platform: target.id,
    signing: "unsigned",
    node: {
      version: "22.23.3",
      archiveSha256: target.nodeArchiveSha256,
    },
    upstreamSha256,
    postSignSha256: upstreamSha256,
    files,
  };
  await writeFile(
    path.join(root, "bundle-manifest.json"),
    JSON.stringify(manifest),
  );
  return manifest;
}

test("unsigned preview requires explicit verification opt-in; inventory and hashes reject tampering", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentlink-cli-bundle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await fixture(root);
  await assert.rejects(
    verifyCliBundle(root),
    /unsigned previews require explicit/u,
  );
  await verifyCliBundle(root, { allowUnsigned: true });
  await writeFile(path.join(root, "dist/agentlink.js"), "tampered");
  await assert.rejects(
    verifyCliBundle(root, { allowUnsigned: true }),
    /SHA-256 mismatch/u,
  );
  await writeFile(path.join(root, "dist/agentlink.js"), "script");
  await rm(path.join(root, "node/LICENSE"));
  await assert.rejects(
    verifyCliBundle(root, { allowUnsigned: true }),
    /inventory/u,
  );
  await writeFile(path.join(root, "node/LICENSE"), "node license");
  await writeFile(path.join(root, "extra"), "not inventoried");
  await assert.rejects(
    verifyCliBundle(root, { allowUnsigned: true }),
    /inventory/u,
  );
});

test("Linux bundles are always unsigned and carry the target's keyring addon", async (t) => {
  for (const targetId of ["linux-x64", "linux-arm64"]) {
    const root = await mkdtemp(path.join(os.tmpdir(), "agentlink-cli-linux-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const manifest = await fixture(root, targetId);
    // Nothing to sign, so no explicit unsigned opt-in is needed.
    await verifyCliBundle(root);

    await writeFile(
      path.join(root, "bundle-manifest.json"),
      JSON.stringify({ ...manifest, signing: "development" }),
    );
    await assert.rejects(verifyCliBundle(root), /must be unsigned/u);

    await writeFile(
      path.join(root, "bundle-manifest.json"),
      JSON.stringify({
        ...manifest,
        node: {
          ...manifest.node,
          archiveSha256: CLI_TARGETS["darwin-arm64"].nodeArchiveSha256,
        },
      }),
    );
    await assert.rejects(verifyCliBundle(root), /Invalid standalone CLI/u);
  }
});

test("rejects bundles for unknown targets", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentlink-cli-target-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = await fixture(root);
  await writeFile(
    path.join(root, "bundle-manifest.json"),
    JSON.stringify({ ...manifest, platform: "linux-riscv64" }),
  );
  await assert.rejects(
    verifyCliBundle(root, { allowUnsigned: true }),
    /Invalid standalone CLI/u,
  );
});

test("unsigned bundles must not carry the credentials helper", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentlink-cli-helper-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = await fixture(root);
  const helper = "dist/AgentLink Credentials (CLI)";
  await writeFile(path.join(root, helper), "helper");
  manifest.files[helper] = digest("helper");
  await writeFile(
    path.join(root, "bundle-manifest.json"),
    JSON.stringify(manifest),
  );
  await assert.rejects(
    verifyCliBundle(root, { allowUnsigned: true }),
    /inventory/u,
  );
});

test("installed symlink launcher resolves its own runtime and leaves user PATH unchanged", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentlink-cli-launcher-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundle = path.join(root, "lib/agentlink/cli");
  await mkdir(bundle, { recursive: true });
  await fixture(bundle);
  const bin = path.join(root, "bin");
  await mkdir(bin);
  await symlink(
    path.join(bundle, "bin/agentlink"),
    path.join(bin, "agentlink"),
  );
  const output = execFileSync(path.join(bin, "agentlink"), ["one"], {
    encoding: "utf8",
    env: { ...process.env, PATH: "/usr/bin:/bin" },
  });
  assert.match(output, /script=.*\/lib\/agentlink\/cli\/dist\/agentlink\.js/u);
  assert.match(output, /arg=one/u);
  assert.match(output, /PATH=\/usr\/bin:\/bin/u);
  assert.match(
    output,
    /node=.*\/lib\/agentlink\/cli\/node\/bin\/AgentLink CLI/u,
  );
  assert.equal(
    await readFile(path.join(bundle, "bin/agentlink"), "utf8"),
    launcher,
  );
});
