import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { generateReleaseUpdate } from "./generate-release-update.mjs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { tmpdir } from "node:os";

const SCRIPT = fileURLToPath(
  new URL("./generate-release-update.mjs", import.meta.url),
);
const vscodeFiles = [
  "agentlink-1.2.3-alpine-arm64.vsix",
  "agentlink-1.2.3-alpine-x64.vsix",
  "agentlink-1.2.3-darwin-arm64.vsix",
  "agentlink-1.2.3-linux-arm64.vsix",
  "agentlink-1.2.3-linux-x64.vsix",
  "agentlink-1.2.3-win32-arm64.vsix",
  "agentlink-1.2.3-win32-x64.vsix",
];

function runCli(root, product, dir) {
  return spawnSync(
    process.execPath,
    [SCRIPT, "--product", product, "--dir", dir, "--root", root],
    { encoding: "utf8" },
  );
}

test("generates stable VS Code metadata with sorted targets", () => {
  const metadata = generateReleaseUpdate({
    product: "vscode",
    version: "1.2.3",
    vscodeEngine: "^1.90.0",
    files: [...vscodeFiles, "SHA256SUMS"],
  });
  assert.deepEqual(metadata, {
    schemaVersion: 1,
    product: "vscode",
    version: "1.2.3",
    tag: "v1.2.3",
    channel: "stable",
    targets: {
      "alpine-arm64": "agentlink-1.2.3-alpine-arm64.vsix",
      "alpine-x64": "agentlink-1.2.3-alpine-x64.vsix",
      "darwin-arm64": "agentlink-1.2.3-darwin-arm64.vsix",
      "linux-arm64": "agentlink-1.2.3-linux-arm64.vsix",
      "linux-x64": "agentlink-1.2.3-linux-x64.vsix",
      "win32-arm64": "agentlink-1.2.3-win32-arm64.vsix",
      "win32-x64": "agentlink-1.2.3-win32-x64.vsix",
    },
    engines: { vscode: "^1.90.0" },
  });
});

test("advertises Desktop DMGs as primary assets, not ZIPs or blockmaps", () => {
  const metadata = generateReleaseUpdate({
    product: "desktop",
    version: "0.4.0",
    files: [
      "AgentLink-Desktop-0.4.0-mac-arm64.dmg",
      "AgentLink-Desktop-0.4.0-mac-arm64.dmg.blockmap",
      "AgentLink-Desktop-0.4.0-mac-arm64.zip",
      "SHA256SUMS",
    ],
  });
  assert.deepEqual(metadata.targets, {
    "darwin-arm64": "AgentLink-Desktop-0.4.0-mac-arm64.dmg",
  });
  assert.deepEqual(metadata.engines, {});
  assert.equal(metadata.channel, "preview");
});

test("generates CLI metadata for its versioned archive", () => {
  const metadata = generateReleaseUpdate({
    product: "cli",
    version: "0.3.0",
    files: [
      "agentlink-cli-darwin-arm64-v0.3.0.tar.gz",
      "agentlink-cli-darwin-arm64-v0.3.0.tar.gz.sha256",
    ],
  });
  assert.deepEqual(metadata.targets, {
    "darwin-arm64": "agentlink-cli-darwin-arm64-v0.3.0.tar.gz",
  });
  assert.equal(metadata.tag, "cli-v0.3.0");
  assert.deepEqual(metadata.engines, {});
});

test("rejects missing, unexpected, or invalid product assets and manifests", () => {
  assert.throws(
    () =>
      generateReleaseUpdate({
        product: "vscode",
        version: "1.2.3",
        vscodeEngine: "^1.90.0",
        files: vscodeFiles.slice(1),
      }),
    /missing agentlink-1\.2\.3-alpine-arm64\.vsix/u,
  );
  assert.throws(
    () =>
      generateReleaseUpdate({
        product: "cli",
        version: "0.3.0",
        files: ["agentlink-cli-darwin-x64-v0.3.0.tar.gz"],
      }),
    /missing agentlink-cli-darwin-arm64-v0\.3\.0\.tar\.gz/u,
  );
  assert.throws(
    () =>
      generateReleaseUpdate({
        product: "desktop",
        version: "0.4.0",
        files: [
          "AgentLink-Desktop-0.4.0-mac-arm64.dmg",
          "AgentLink-Desktop-0.3.0-mac-x64.dmg",
        ],
      }),
    /unexpected AgentLink-Desktop-0\.3\.0-mac-x64\.dmg/u,
  );
  assert.throws(
    () =>
      generateReleaseUpdate({
        product: "vscode",
        version: "latest",
        vscodeEngine: "^1.90.0",
        files: vscodeFiles,
      }),
    /Invalid vscode version/u,
  );
  assert.throws(
    () =>
      generateReleaseUpdate({
        product: "vscode",
        version: "1.2.3",
        files: vscodeFiles,
      }),
    /engines\.vscode/u,
  );
});

test("CLI derives identity from the requested product manifest and reruns identically", () => {
  const root = mkdtempSync(path.join(tmpdir(), "agentlink-release-update-"));
  try {
    mkdirSync(path.join(root, "apps", "desktop"), { recursive: true });
    const manifest = path.join(root, "apps", "desktop", "package.json");
    writeFileSync(manifest, JSON.stringify({ version: "0.4.0" }));
    const dir = path.join(root, "dist");
    mkdirSync(dir);
    for (const name of [
      "AgentLink-Desktop-0.4.0-mac-arm64.dmg",
      "AgentLink-Desktop-0.4.0-mac-arm64.zip",
    ]) {
      writeFileSync(path.join(dir, name), "fixture");
    }

    const first = runCli(root, "desktop", "dist");
    assert.equal(first.status, 0, first.stderr);
    const output = path.join(dir, "agentlink-update.json");
    const firstContent = readFileSync(output, "utf8");
    const second = runCli(root, "desktop", "dist");
    assert.equal(second.status, 0, second.stderr);
    assert.equal(readFileSync(output, "utf8"), firstContent);
    assert.equal(JSON.parse(firstContent).tag, "desktop-v0.4.0");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
