#!/usr/bin/env node
// Publishes one component GitHub Release from a directory of verified files.
//
//   node scripts/release-publish.mjs --tag cli-v0.3.0 --target <sha> \
//     --title "AgentLink CLI 0.3.0" --notes-file notes.md --dir dist \
//     [--prerelease] [--latest]
//
// - Adds SHA256SUMS for every asset.
// - Never moves or reuses a tag that points at a different commit.
// - Uploads to a draft, verifies names and sizes, then publishes. A partial
//   draft from an earlier attempt is replaced as a whole; a published
//   release is immutable and a matching retry is a no-op.

import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";

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

function writeChecksums(dir) {
  const files = readdirSync(dir)
    .filter(
      (name) =>
        name !== "SHA256SUMS" && statSync(path.join(dir, name)).isFile(),
    )
    .sort();
  if (files.length === 0) throw new Error(`No release assets in ${dir}`);
  const lines = files.map(
    (name) =>
      `${createHash("sha256")
        .update(readFileSync(path.join(dir, name)))
        .digest("hex")}  ${name}`,
  );
  writeFileSync(path.join(dir, "SHA256SUMS"), `${lines.join("\n")}\n`);
  return [...files, "SHA256SUMS"];
}

function releaseState(tag) {
  const output = tryGh("release", "view", tag, "--json", "isDraft,assets");
  return output ? JSON.parse(output) : undefined;
}

function assertAssets(tag, dir, names) {
  const assets = new Map(
    releaseState(tag).assets.map((asset) => [asset.name, asset.size]),
  );
  for (const name of names) {
    if (assets.get(name) !== statSync(path.join(dir, name)).size) {
      throw new Error(`Release ${tag} is missing or has a different ${name}`);
    }
  }
}

const options = parseArgs(process.argv.slice(2));
const { tag, target, dir } = options;
assertTag(tag, target);

const existing = releaseState(tag);
if (existing && !existing.isDraft) {
  const published = new Set(existing.assets.map((asset) => asset.name));
  const missing = [
    ...readdirSync(dir).filter((name) => name !== "SHA256SUMS"),
    "SHA256SUMS",
  ].filter((name) => !published.has(name));
  if (missing.length > 0) {
    throw new Error(
      `${tag} is already published without ${missing.join(", ")}; published releases are immutable, recover manually`,
    );
  }
  console.log(`${tag} is already published with the expected assets.`);
  process.exit(0);
}
if (existing?.isDraft) {
  console.log(`Replacing incomplete draft for ${tag}.`);
  gh("release", "delete", tag, "--yes");
}

const names = writeChecksums(dir);
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
assertAssets(tag, dir, names);
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
