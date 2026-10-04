#!/usr/bin/env node
// Publishes one component GitHub Release from a directory of verified files.
//
//   node scripts/release-publish.mjs --tag cli-v0.3.0 --target <sha> \
//     --title "AgentLink CLI 0.3.0" --notes-file notes.md --dir dist \
//     [--prerelease] [--latest]
//
// - Adds SHA256SUMS for every asset.
// - Never moves or reuses a tag that points at a different commit.
// - Uploads to a draft, verifies the exact asset set and every SHA-256 digest,
//   then publishes. A partial draft from an earlier attempt is replaced as a
//   whole; a published release is immutable and a retry succeeds only when
//   its assets and prerelease flag already match exactly.
// Callers serialize runs per unit (workflow concurrency), so a draft found
// here is stale rather than another run's upload in progress.

import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { tmpdir } from "node:os";

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index].replace(/^--/u, "");
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) options[key] = true;
    else {
      options[key] = next;
      index++;
    }
  }
  for (const required of ["tag", "target", "title", "notes-file", "dir"]) {
    if (typeof options[required] !== "string") {
      throw new Error(`--${required} is required`);
    }
  }
  if (!/^[0-9a-f]{40}$/u.test(options.target)) {
    throw new Error("--target must be a full commit SHA");
  }
  return options;
}

const gh = (...args) =>
  execFileSync("gh", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

function tryGh(...args) {
  try {
    return gh(...args);
  } catch {
    return undefined;
  }
}

function remoteTagCommit(tag) {
  const output = execFileSync(
    "git",
    [
      "ls-remote",
      "--tags",
      "origin",
      `refs/tags/${tag}`,
      `refs/tags/${tag}^{}`,
    ],
    { encoding: "utf8" },
  );
  const refs = Object.fromEntries(
    output
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("\t").reverse()),
  );
  return refs[`refs/tags/${tag}^{}`] ?? refs[`refs/tags/${tag}`];
}

function assertTag(tag, target) {
  const commit = remoteTagCommit(tag);
  if (commit && commit !== target) {
    throw new Error(`Tag ${tag} points at ${commit}, not ${target}`);
  }
  return commit;
}

const sha256 = (file) =>
  createHash("sha256").update(readFileSync(file)).digest("hex");

/** Writes SHA256SUMS and returns the expected digest of every asset. */
function writeChecksums(dir) {
  const files = readdirSync(dir)
    .filter(
      (name) =>
        name !== "SHA256SUMS" && statSync(path.join(dir, name)).isFile(),
    )
    .sort();
  if (files.length === 0) throw new Error(`No release assets in ${dir}`);
  const expected = new Map(
    files.map((name) => [name, sha256(path.join(dir, name))]),
  );
  const lines = [...expected].map(([name, digest]) => `${digest}  ${name}`);
  writeFileSync(path.join(dir, "SHA256SUMS"), `${lines.join("\n")}\n`);
  expected.set("SHA256SUMS", sha256(path.join(dir, "SHA256SUMS")));
  return expected;
}

function releaseState(tag) {
  const output = tryGh(
    "release",
    "view",
    tag,
    "--json",
    "databaseId,isDraft,isPrerelease",
  );
  if (!output) return undefined;
  const view = JSON.parse(output);
  // The REST API reports each asset's server-computed `sha256:` digest.
  const release = JSON.parse(
    gh("api", `repos/{owner}/{repo}/releases/${view.databaseId}`),
  );
  return { ...view, assets: release.assets };
}

function assetDigest(tag, asset) {
  if (/^sha256:[0-9a-f]{64}$/u.test(asset.digest ?? "")) {
    return asset.digest.slice("sha256:".length);
  }
  const scratch = mkdtempSync(path.join(tmpdir(), "release-asset-"));
  try {
    gh("release", "download", tag, "--pattern", asset.name, "--dir", scratch);
    return sha256(path.join(scratch, asset.name));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Throws unless the release holds exactly the expected assets and bytes. */
function assertAssets(tag, state, expected) {
  const actual = new Map(state.assets.map((asset) => [asset.name, asset]));
  const names = [...new Set([...actual.keys(), ...expected.keys()])].sort();
  const problems = names.flatMap((name) => {
    if (!expected.has(name)) return [`unexpected ${name}`];
    if (!actual.has(name)) return [`missing ${name}`];
    return assetDigest(tag, actual.get(name)) === expected.get(name)
      ? []
      : [`different ${name}`];
  });
  if (problems.length > 0) {
    throw new Error(
      `Release ${tag} assets do not match: ${problems.join(", ")}`,
    );
  }
}

const options = parseArgs(process.argv.slice(2));
const { tag, target, dir } = options;
assertTag(tag, target);
const expected = writeChecksums(dir);

const existing = releaseState(tag);
if (existing && !existing.isDraft) {
  try {
    assertAssets(tag, existing, expected);
    if (existing.isPrerelease !== Boolean(options.prerelease)) {
      throw new Error(`Release ${tag} has a different prerelease flag`);
    }
  } catch (error) {
    throw new Error(
      `${error.message}. ${tag} is already published and immutable; recover manually.`,
    );
  }
  console.log(`${tag} is already published with the expected assets.`);
  process.exit(0);
}
if (existing?.isDraft) {
  console.log(`Replacing incomplete draft for ${tag}.`);
  gh("release", "delete", tag, "--yes");
}

const names = [...expected.keys()];
gh(
  "release",
  "create",
  tag,
  ...names.map((name) => path.join(dir, name)),
  "--draft",
  "--target",
  target,
  "--title",
  options.title,
  "--notes-file",
  options["notes-file"],
  ...(options.prerelease ? ["--prerelease"] : []),
);
assertAssets(tag, releaseState(tag), expected);
gh(
  "release",
  "edit",
  tag,
  "--draft=false",
  options.latest ? "--latest" : "--latest=false",
);
if (assertTag(tag, target) !== target) {
  throw new Error(
    `Published ${tag}, but its tag does not resolve to ${target}`,
  );
}
console.log(`Published ${tag} at ${target}.`);
