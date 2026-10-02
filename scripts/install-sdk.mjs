#!/usr/bin/env node
// Vendors a published AgentLink SDK release into a Node project.
//
//   curl -fsSL https://raw.githubusercontent.com/reefbarman/agentlink/main/scripts/install-sdk.mjs \
//     | node --input-type=module - [--version 0.3.0] [--dir .] [--install] [--dry-run]
//
// Downloads the matched @agentlink/protocol, core, and node-host archives from
// the sdk-vX.Y.Z GitHub Release into <dir>/vendor/agentlink, verifies each one
// against SHA256SUMS and the SDK manifest, then prints (or runs with
// --install) the npm install command. The SDK is not published to npm yet.

import { mkdir, rename, writeFile } from "node:fs/promises";

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const REPO = "reefbarman/agentlink";
const DOWNLOAD_BASE = `https://github.com/${REPO}/releases/download`;
const MANIFEST = "agentlink-sdk-artifacts.json";
const SDK_PACKAGES = [
  "@agentlink/core",
  "@agentlink/node-host",
  "@agentlink/protocol",
];
const ARCHIVE_NAME =
  /^agentlink-(protocol|core|node-host)-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?-[a-f0-9]{64}\.tgz$/u;

export function parseArgs(argv) {
  const options = { dir: process.cwd(), install: false, dryRun: false };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--version") {
      options.version = argv[++index]?.replace(/^v/u, "");
      if (!/^\d+\.\d+\.\d+$/u.test(options.version ?? "")) {
        throw new Error("--version must look like 1.2.3");
      }
    } else if (argument === "--dir") {
      const value = argv[++index];
      if (!value) throw new Error("--dir requires a path");
      options.dir = path.resolve(value);
    } else if (argument === "--install") options.install = true;
    else if (argument === "--dry-run") options.dryRun = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

/** Newest published sdk-vX.Y.Z release (or the requested version) with a manifest. */
export function selectSdkRelease(releases, version) {
  const pattern = version
    ? new RegExp(`^sdk-v${version.replaceAll(".", "\\.")}$`, "u")
    : /^sdk-v\d+\.\d+\.\d+$/u;
  for (const release of releases) {
    if (release.draft || !pattern.test(release.tag_name)) continue;
    const assets = new Map(
      release.assets.map((asset) => [asset.name, asset.browser_download_url]),
    );
    if (!assets.has(MANIFEST) || !assets.has("SHA256SUMS")) continue;
    for (const [name, url] of assets) {
      if (url !== `${DOWNLOAD_BASE}/${release.tag_name}/${name}`) {
        throw new Error(
          `Release asset ${name} has an unexpected download URL.`,
        );
      }
    }
    return { tag: release.tag_name, assets };
  }
  return undefined;
}

export function parseChecksums(text) {
  const sums = new Map();
  for (const line of text.split("\n")) {
    const match = /^([a-f0-9]{64}) [ *](.+)$/u.exec(line.trim());
    if (match) sums.set(match[2], match[1]);
  }
  return sums;
}

/** Validates the manifest and returns the archive entries to download. */
export function sdkArchives(manifest, sums, tag) {
  const names = (manifest?.packages ?? []).map((entry) => entry.name).sort();
  if (JSON.stringify(names) !== JSON.stringify(SDK_PACKAGES)) {
    throw new Error(`Unexpected SDK package set: ${names.join(", ")}`);
  }
  const version = tag.slice("sdk-v".length);
  return manifest.packages.map((entry) => {
    if (entry.version !== version) {
      throw new Error(`${entry.name} is ${entry.version}, expected ${version}`);
    }
    if (!ARCHIVE_NAME.test(entry.filename)) {
      throw new Error(`Unsafe SDK archive name: ${entry.filename}`);
    }
    if (sums.get(entry.filename) !== entry.sha256) {
      throw new Error(`${entry.filename} does not match SHA256SUMS`);
    }
    return entry;
  });
}

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

async function fetchBuffer(url) {
  const response = await fetch(url, {
    headers: { Accept: "application/octet-stream" },
  });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function findRelease(version) {
  for (let page = 1; page <= 10; page++) {
    const response = await fetch(
      `https://api.github.com/repos/${REPO}/releases?per_page=100&page=${page}`,
      { headers: { Accept: "application/vnd.github+json" } },
    );
    if (!response.ok) {
      throw new Error(`GitHub releases: HTTP ${response.status}`);
    }
    const releases = await response.json();
    const selected = selectSdkRelease(releases, version);
    if (selected) return selected;
    if (releases.length < 100) break;
  }
  throw new Error(
    version
      ? `No published sdk-v${version} release was found.`
      : "No published SDK release was found.",
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(
      "Usage: install-sdk.mjs [--version X.Y.Z] [--dir <project>] [--install] [--dry-run]",
    );
    return;
  }
  const release = await findRelease(options.version);
  console.log(`Selected ${release.tag}`);
  const sums = parseChecksums(
    (await fetchBuffer(release.assets.get("SHA256SUMS"))).toString("utf8"),
  );
  const manifestBuffer = await fetchBuffer(release.assets.get(MANIFEST));
  if (sums.get(MANIFEST) !== sha256(manifestBuffer)) {
    throw new Error(`${MANIFEST} does not match SHA256SUMS`);
  }
  const manifest = JSON.parse(manifestBuffer.toString("utf8"));
  const archives = sdkArchives(manifest, sums, release.tag);

  const vendor = path.join(options.dir, "vendor", "agentlink");
  const specs = archives.map((entry) => `./vendor/agentlink/${entry.filename}`);
  const peers = Object.entries(manifest.requiredPeerDependencies ?? {}).map(
    ([name, range]) => `${name}@${range}`,
  );
  const installArgs = ["install", ...specs, ...peers];
  if (options.dryRun) {
    console.log(
      `Dry run: would vendor ${archives.length} archives into ${vendor}`,
    );
    console.log(`Then: npm ${installArgs.join(" ")}`);
    return;
  }

  await mkdir(vendor, { recursive: true });
  for (const entry of archives) {
    const buffer = await fetchBuffer(release.assets.get(entry.filename));
    if (sha256(buffer) !== entry.sha256) {
      throw new Error(`${entry.filename} checksum mismatch`);
    }
    const target = path.join(vendor, entry.filename);
    await writeFile(`${target}.tmp`, buffer);
    await rename(`${target}.tmp`, target);
    console.log(`Verified ${entry.filename}`);
  }
  await writeFile(path.join(vendor, MANIFEST), manifestBuffer);

  if (options.install) {
    if (!existsSync(path.join(options.dir, "package.json"))) {
      throw new Error(`--install needs a package.json in ${options.dir}`);
    }
    execFileSync("npm", installArgs, { cwd: options.dir, stdio: "inherit" });
    console.log(`Installed AgentLink SDK ${release.tag.slice(5)}.`);
  } else {
    console.log(`\nVendored into ${vendor}. Add them to your project with:`);
    console.log(`  npm ${installArgs.join(" ")}`);
  }
  console.log(
    "Commit vendor/agentlink so installs stay reproducible. Older archives there can be deleted once nothing references them.",
  );
}

const entry = process.argv[1];
if (
  entry === undefined ||
  entry === "-" ||
  path.resolve(entry) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  });
}
