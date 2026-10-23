import {
  CLI_TARGETS,
  cliBundleName,
  fetchPinnedNpmPackage,
  resolveCliTarget,
} from "./cli-targets.mjs";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("resolves --target, then AGENTLINK_CLI_TARGET, then the host", () => {
  assert.equal(
    resolveCliTarget({
      argv: ["node", "x", "--target", "linux-arm64"],
      env: { AGENTLINK_CLI_TARGET: "linux-x64" },
    }).id,
    "linux-arm64",
  );
  assert.equal(
    resolveCliTarget({
      argv: [],
      env: { AGENTLINK_CLI_TARGET: "linux-x64" },
    }).id,
    "linux-x64",
  );
  assert.equal(
    resolveCliTarget({ argv: [], env: {}, platform: "linux", arch: "arm64" })
      .id,
    "linux-arm64",
  );
  assert.throws(
    () =>
      resolveCliTarget({ argv: [], env: {}, platform: "darwin", arch: "x64" }),
    /No CLI target for this host \(darwin-x64\)/u,
  );
  assert.throws(
    () => resolveCliTarget({ argv: ["--target", "win32-x64"], env: {} }),
    /Unsupported CLI target: win32-x64/u,
  );
  assert.equal(cliBundleName("linux-x64"), "agentlink-cli-linux-x64");
});

test("every non-host Linux asset is pinned by hash", () => {
  for (const target of Object.values(CLI_TARGETS)) {
    assert.match(target.nodeArchiveSha256, /^[a-f0-9]{64}$/u);
    assert.match(target.ripgrep.sha256, /^[a-f0-9]{64}$/u);
    if (target.platform === "linux") {
      assert.equal(target.signable, false);
      assert.match(target.ripgrep.integrity, /^sha512-/u);
      assert.match(target.keyring.integrity, /^sha512-/u);
      assert.match(target.keyring.package, /-gnu$/u);
    }
  }
});

function packedFixture(directory, name, version) {
  const source = path.join(directory, "source");
  mkdirSync(path.join(source, "package"), { recursive: true });
  writeFileSync(
    path.join(source, "package", "package.json"),
    JSON.stringify({ name, version }),
  );
  writeFileSync(path.join(source, "package", "addon.node"), "binary");
  const tarball = path.join(directory, "fixture.tgz");
  execFileSync("tar", ["-czf", tarball, "-C", source, "package"]);
  const integrity = `sha512-${createHash("sha512").update(readFileSync(tarball)).digest("base64")}`;
  return { tarball, integrity };
}

test("fetches, verifies and caches a pinned npm tarball", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agentlink-cli-npm-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { tarball, integrity } = await packedFixture(
    directory,
    "@napi-rs/keyring-linux-x64-gnu",
    "2.1.1",
  );
  const urls = [];
  const download = (url, destination) => {
    urls.push(url);
    copyFileSync(tarball, destination);
  };
  const cacheRoot = path.join(directory, "cache");
  const options = {
    packageName: "@napi-rs/keyring-linux-x64-gnu",
    version: "2.1.1",
    integrity,
    cacheRoot,
    download,
  };
  const root = await fetchPinnedNpmPackage(options);
  assert.equal(await readFile(path.join(root, "addon.node"), "utf8"), "binary");
  assert.deepEqual(urls, [
    "https://registry.npmjs.org/@napi-rs/keyring-linux-x64-gnu/-/keyring-linux-x64-gnu-2.1.1.tgz",
  ]);
  assert.equal(await fetchPinnedNpmPackage(options), root);
  assert.equal(urls.length, 1, "the second call uses the cache");
});

test("rejects a tarball that does not match its pin", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agentlink-cli-npm-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { tarball } = await packedFixture(
    directory,
    "@vscode/ripgrep-linux-x64",
    "1.18.0",
  );
  await assert.rejects(
    fetchPinnedNpmPackage({
      packageName: "@vscode/ripgrep-linux-x64",
      version: "1.18.0",
      integrity: CLI_TARGETS["linux-x64"].ripgrep.integrity,
      cacheRoot: path.join(directory, "cache"),
      download: (_url, destination) => copyFileSync(tarball, destination),
    }),
    /integrity mismatch/u,
  );
  await assert.rejects(
    fetchPinnedNpmPackage({
      packageName: "@vscode/ripgrep-darwin-arm64",
      version: "1.18.0",
      integrity: undefined,
      cacheRoot: path.join(directory, "cache"),
    }),
    /must come from node_modules/u,
  );
});
