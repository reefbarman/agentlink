import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import {
  parseChecksums,
  sdkArchives,
  selectSdkRelease,
} from "./install-sdk.mjs";

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { tmpdir } from "node:os";

const INSTALL_SH = fileURLToPath(new URL("./install.sh", import.meta.url));
const BASE = "https://github.com/reefbarman/agentlink/releases/download";

function release(tag, names, draft = false) {
  return {
    tag_name: tag,
    draft,
    assets: names.map((name) => ({
      name,
      browser_download_url: `${BASE}/${tag}/${name}`,
    })),
  };
}

// Newest first, like the GitHub releases API.
const RELEASES = [
  release("sdk-v0.3.0", ["agentlink-sdk-artifacts.json", "SHA256SUMS"]),
  release("cli-v0.3.0", [
    "agentlink-cli-darwin-arm64-v0.3.0.tar.gz",
    "SHA256SUMS",
  ]),
  release("v1.24.0", [
    "agentlink-1.24.0-darwin-arm64.vsix",
    "agentlink-1.24.0-linux-x64.vsix",
    "SHA256SUMS",
  ]),
  release("desktop-v0.2.0", ["AgentLink-Desktop-0.2.0-mac-arm64.dmg"]),
  release("cli-v0.1.0", [
    "agentlink-cli-darwin-arm64-v0.1.0.tar.gz",
    "agentlink-cli-darwin-arm64-v0.1.0.tar.gz.sha256",
  ]),
  release("v1.23.0", ["agentlink-1.23.0-linux-x64.vsix"]),
];

function runInstaller(args, env = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "agentlink-install-test-"));
  try {
    const fixture = path.join(dir, "releases.json");
    writeFileSync(fixture, JSON.stringify(RELEASES, null, 2));
    const result = spawnSync("bash", [INSTALL_SH, "--dry-run", ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        AGENTLINK_RELEASES_FILE: fixture,
        AGENTLINK_INSTALL_OS: "Darwin",
        AGENTLINK_INSTALL_ARCH: "arm64",
        ...env,
      },
    });
    assert.equal(result.error, undefined);
    return result;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("install.sh selects each surface by its own tag series", () => {
  const vscode = runInstaller([], { AGENTLINK_VSCE_TARGET: "linux-x64" });
  assert.equal(vscode.status, 0, vscode.stderr);
  assert.match(
    vscode.stdout,
    /Selected v1\.24\.0: agentlink-1\.24\.0-linux-x64\.vsix/,
  );
  assert.match(vscode.stdout, /Checksum: SHA256SUMS/);

  const cli = runInstaller(["--surface", "cli"]);
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /Selected cli-v0\.3\.0/);

  const desktop = runInstaller(["--surface", "desktop", "--arch", "arm64"]);
  assert.equal(desktop.status, 0, desktop.stderr);
  assert.match(desktop.stdout, /AgentLink-Desktop-0\.2\.0-mac-arm64\.dmg/);
  assert.match(desktop.stdout, /skipping verification/);
});

test("install.sh honours --version and legacy per-file checksums", () => {
  const cli = runInstaller(["--surface", "cli", "--version", "0.1.0"]);
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /Selected cli-v0\.1\.0/);
  assert.match(cli.stdout, /Checksum: agentlink-cli-.*\.tar\.gz\.sha256/);

  const vscode = runInstaller(["--version", "v1.23.0"], {
    AGENTLINK_VSCE_TARGET: "darwin-arm64",
  });
  assert.notEqual(vscode.status, 0);
  assert.match(vscode.stderr, /No published v1\.23\.0 release/);
});

test("install.sh refuses unsupported platforms and arguments", () => {
  const intelCli = runInstaller(["--surface", "cli"], {
    AGENTLINK_INSTALL_ARCH: "x64",
  });
  assert.notEqual(intelCli.status, 0);
  assert.match(intelCli.stderr, /Apple Silicon only/);

  const intelDesktop = runInstaller(["--surface", "desktop", "--arch", "x64"]);
  assert.notEqual(intelDesktop.status, 0);
  assert.match(intelDesktop.stderr, /no longer supports Intel Macs/);
  const intelVscode = runInstaller([], { AGENTLINK_VSCE_TARGET: "darwin-x64" });
  assert.notEqual(intelVscode.status, 0);
  assert.match(intelVscode.stderr, /no longer supports Intel Macs/);

  const linuxDesktop = runInstaller(["--surface", "desktop"], {
    AGENTLINK_INSTALL_OS: "Linux",
  });
  assert.notEqual(linuxDesktop.status, 0);

  const badVersion = runInstaller(["--version", "latest"]);
  assert.notEqual(badVersion.status, 0);
  assert.match(badVersion.stderr, /--version must look like/);
});

const digest = (char) => char.repeat(64);
const MANIFEST = {
  packages: [
    ["protocol", "a"],
    ["core", "b"],
    ["node-host", "c"],
  ].map(([leaf, char]) => ({
    name: `@agentlink/${leaf}`,
    version: "0.3.0",
    filename: `agentlink-${leaf}-0.3.0-${digest(char)}.tgz`,
    sha256: digest(char),
  })),
};
const SUMS = new Map(
  MANIFEST.packages.map((entry) => [entry.filename, entry.sha256]),
);

test("install-sdk selects the newest published SDK release", () => {
  assert.equal(selectSdkRelease(RELEASES)?.tag, "sdk-v0.3.0");
  assert.equal(selectSdkRelease(RELEASES, "0.2.0"), undefined);
  const tampered = release("sdk-v0.4.0", [
    "agentlink-sdk-artifacts.json",
    "SHA256SUMS",
  ]);
  tampered.assets[0].browser_download_url = "https://example.com/x.json";
  assert.throws(() => selectSdkRelease([tampered]), /unexpected download URL/);
});

test("install-sdk validates the archive set against SHA256SUMS", () => {
  const text = MANIFEST.packages
    .map((entry) => `${entry.sha256}  ${entry.filename}`)
    .join("\n");
  assert.deepEqual(parseChecksums(text), SUMS);
  assert.equal(sdkArchives(MANIFEST, SUMS, "sdk-v0.3.0").length, 3);

  assert.throws(
    () => sdkArchives(MANIFEST, SUMS, "sdk-v0.4.0"),
    /expected 0\.4\.0/,
  );
  const mismatched = new Map(SUMS);
  mismatched.set(MANIFEST.packages[0].filename, digest("f"));
  assert.throws(
    () => sdkArchives(MANIFEST, mismatched, "sdk-v0.3.0"),
    /does not match SHA256SUMS/,
  );
  const unsafe = structuredClone(MANIFEST);
  unsafe.packages[0].filename = "../evil.tgz";
  assert.throws(
    () => sdkArchives(unsafe, SUMS, "sdk-v0.3.0"),
    /Unsafe SDK archive name/,
  );
  const partial = { packages: MANIFEST.packages.slice(0, 2) };
  assert.throws(
    () => sdkArchives(partial, SUMS, "sdk-v0.3.0"),
    /Unexpected SDK package set/,
  );
});
