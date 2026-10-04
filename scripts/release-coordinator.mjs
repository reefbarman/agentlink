#!/usr/bin/env node
// Release coordinator: plans independent VS Code, Desktop, CLI and SDK
// releases from Git history, optionally with AI advice, and prepares the
// version/changelog edits for a release commit. It never commits, tags,
// pushes, or publishes; the release workflow does that with exact SHAs.
//
//   node scripts/release-coordinator.mjs plan [--classify] [--out plan.json]
//        [--published-tags-file tags.json] [--github-output]
//   node scripts/release-coordinator.mjs apply --plan plan.json
//   node scripts/release-coordinator.mjs notes --unit vscode

import {
  DEFAULT_FALLBACK_MODEL,
  DEFAULT_MODEL,
  classifyCommits,
} from "./release-classify.mjs";
import {
  RELEASE_UNITS,
  UNIT_IDS,
  compareVersions,
  isVersionOnlyChange,
  latestPublishedVersion,
  planRelease,
  unitsForPath,
} from "./release-plan.mjs";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RELEASE_DIR = ".release";
const LAST_PLAN = `${RELEASE_DIR}/last-plan.json`;
const SDK_PACKAGES = ["protocol", "core", "node-host", "workspace-host"].map(
  (name) => `@agentlink/${name}`,
);

const git = (...args) =>
  execFileSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });

function tryGit(...args) {
  try {
    return git(...args);
  } catch {
    return undefined;
  }
}

const readText = (file) => readFileSync(path.join(ROOT, file), "utf8");
const readJson = (file) => JSON.parse(readText(file));
const readJsonIfExists = (file) =>
  existsSync(path.join(ROOT, file)) ? readJson(file) : undefined;
const writeJson = (file, value) =>
  writeFileSync(path.join(ROOT, file), `${JSON.stringify(value, null, 2)}\n`);

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { command };
  for (let index = 0; index < rest.length; index++) {
    const argument = rest[index];
    if (!argument.startsWith("--")) throw new Error(`Unexpected ${argument}`);
    const key = argument.slice(2);
    const next = rest[index + 1];
    if (next === undefined || next.startsWith("--")) options[key] = true;
    else {
      options[key] = next;
      index++;
    }
  }
  return options;
}

// ---------------------------------------------------------------------------
// Fact collection

const commitCache = new Map();

function describeCommit(sha) {
  const cached = commitCache.get(sha);
  if (cached) return cached;
  const [subject, body = ""] = git("log", "-1", "--format=%s%x00%b", sha).split(
    "\0",
  );
  const changed = git(
    "diff-tree",
    "--no-commit-id",
    "--name-only",
    "-r",
    "--no-renames",
    sha,
  )
    .split("\n")
    .filter(Boolean);
  const files = changed.filter(
    (file) =>
      !isVersionOnlyChange(
        file,
        tryGit("show", `${sha}^:${file}`),
        tryGit("show", `${sha}:${file}`),
      ),
  );
  const commit = { sha, subject: subject.trim(), body: body.trim(), files };
  commitCache.set(sha, commit);
  return commit;
}

function publishedTags(options) {
  if (options["published-tags-file"]) {
    return JSON.parse(readFileSync(options["published-tags-file"], "utf8"));
  }
  console.warn(
    "Using local Git tags as the published baseline. CI passes the GitHub release list instead.",
  );
  return git("tag", "--list").split("\n").filter(Boolean);
}

function unitFacts(id, tags) {
  const unit = RELEASE_UNITS[id];
  const latest = latestPublishedVersion(tags, unit.tagPrefix);
  let published = latest;
  let baselineRef = latest && `${unit.tagPrefix}${latest}`;
  let bootstrap = false;
  if (!latest) {
    const record = readJsonIfExists(`${RELEASE_DIR}/${id}-bootstrap.json`);
    if (!record) {
      throw new Error(`No published ${id} release and no bootstrap record`);
    }
    published = record.version;
    baselineRef = record.commit;
    bootstrap = true;
  }
  if (!tryGit("rev-parse", "--verify", `${baselineRef}^{commit}`)) {
    throw new Error(
      `Baseline ${baselineRef} for ${id} is not available locally; fetch tags and full history`,
    );
  }
  const versions = new Set(
    unit.manifests.map((manifest) => readJson(manifest).version),
  );
  if (versions.size !== 1) {
    throw new Error(
      `${id} manifests disagree on version: ${[...versions].join(", ")}`,
    );
  }
  const commits = git(
    "rev-list",
    "--no-merges",
    "--reverse",
    `${baselineRef}..HEAD`,
  )
    .split("\n")
    .filter(Boolean)
    .map(describeCommit);
  return {
    published,
    baselineRef,
    bootstrap,
    reserved: [...versions][0],
    intent: readJsonIfExists(`${RELEASE_DIR}/intents/${id}.json`)?.version,
    commits,
  };
}

function commitUnits(commit) {
  return [
    ...new Set(commit.files.flatMap((file) => unitsForPath(file).units)),
  ].sort((a, b) => UNIT_IDS.indexOf(a) - UNIT_IDS.indexOf(b));
}

function commitDiff(commit) {
  const files = commit.files.filter(
    (file) =>
      file !== "package-lock.json" && unitsForPath(file).units.length > 0,
  );
  if (files.length === 0) return "";
  return git(
    "show",
    "--format=",
    "--no-color",
    "--no-ext-diff",
    commit.sha,
    "--",
    ...files,
  );
}

// ---------------------------------------------------------------------------
// plan

async function plan(options) {
  const tags = publishedTags(options);
  const units = {};
  for (const id of UNIT_IDS) units[id] = unitFacts(id, tags);

  const previous = readJsonIfExists(LAST_PLAN);
  const classifierEnabled = Boolean(options.classify);
  let decisions = {};
  let omitted = [];
  const model = process.env.RELEASE_AI_MODEL || DEFAULT_MODEL;
  const fallbackModel =
    process.env.RELEASE_AI_FALLBACK_MODEL || DEFAULT_FALLBACK_MODEL;
  if (classifierEnabled) {
    const candidates = [...commitCache.values()]
      .map((commit) => ({ ...commit, units: commitUnits(commit) }))
      .filter((commit) => commit.units.length > 0);
    ({ decisions, omitted } = await classifyCommits(
      candidates.map((commit) => ({ ...commit, diff: commitDiff(commit) })),
      {
        apiKey: process.env.OPENROUTER_API_KEY,
        model,
        fallbackModel,
        cache: previous?.decisions ?? {},
      },
    ));
  }

  const planned = planRelease({ units, decisions });
  for (const [id, result] of Object.entries(planned)) {
    const tag =
      result.version && `${RELEASE_UNITS[id].tagPrefix}${result.version}`;
    if (
      result.status === "release" &&
      tryGit("rev-parse", "--verify", `refs/tags/${tag}`)
    ) {
      Object.assign(result, {
        status: "hold",
        reason: `tag ${tag} already exists without a complete published release; recover it explicitly`,
      });
    }
    result.tag = result.status === "release" ? tag : undefined;
    result.intentFile = units[id].intent
      ? `${RELEASE_DIR}/intents/${id}.json`
      : undefined;
    result.notes = result.commits.map((sha) => ({
      sha,
      subject: commitCache.get(sha).subject,
      summary: decisions[sha]?.summary,
      breaking: result.breakingCommits.includes(sha),
    }));
  }

  const record = {
    schemaVersion: 1,
    sourceSha: git("rev-parse", "HEAD").trim(),
    createdAt: new Date().toISOString(),
    classifier: classifierEnabled
      ? { model, fallbackModel, omitted }
      : { enabled: false },
    units: planned,
    decisions,
  };
  if (options.out)
    writeFileSync(options.out, `${JSON.stringify(record, null, 2)}\n`);
  const summary = renderSummary(record);
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) {
    writeFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`, {
      flag: "a",
    });
  }
  if (options["github-output"] && process.env.GITHUB_OUTPUT) {
    const releasing = UNIT_IDS.filter(
      (id) => planned[id]?.status === "release",
    );
    const lines = [`units=${releasing.join(",")}`];
    for (const id of releasing)
      lines.push(`${id}_version=${planned[id].version}`);
    writeFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`, {
      flag: "a",
    });
  }
}

function renderSummary(record) {
  const rows = UNIT_IDS.map((id) => {
    const unit = record.units[id];
    const result =
      unit.status === "release"
        ? `**${unit.version}**${unit.breaking ? " (breaking, 0.x minor)" : ""}`
        : unit.status === "hold"
          ? `held: ${unit.reason}`
          : "no release";
    return `| ${id} | ${unit.published} (${unit.baselineRef.slice(0, 20)}) | ${unit.reserved} | ${unit.commits.length} | ${unit.bump ?? "-"} | ${result} |`;
  });
  const unknown = UNIT_IDS.flatMap((id) => record.units[id].unknownPaths);
  const notes = [];
  if (unknown.length > 0) {
    notes.push(
      `Unmapped paths attributed to all apps: ${[...new Set(unknown)].join(", ")}`,
    );
  }
  if (record.classifier.omitted?.length > 0) {
    notes.push(
      `Commits over the AI budget (deterministic floor only): ${record.classifier.omitted.map((sha) => sha.slice(0, 8)).join(", ")}`,
    );
  }
  notes.push(
    record.classifier.enabled === false
      ? "AI classification: off (Conventional Commit floors only)"
      : `AI classification: ${record.classifier.model} (fallback ${record.classifier.fallbackModel})`,
  );
  return [
    `### Release plan for ${record.sourceSha.slice(0, 12)}`,
    "",
    "| Unit | Published baseline | Manifest | Commits | Bump | Result |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
    ...notes.map((note) => `- ${note}`),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// apply

function manifestPaths() {
  const workspaces = ["apps", "packages"].flatMap((dir) =>
    git("ls-files", `${dir}/*/package.json`).split("\n").filter(Boolean),
  );
  return ["package.json", ...workspaces];
}

function setVersion(file, version) {
  const manifest = readJson(file);
  manifest.version = version;
  writeJson(file, manifest);
}

function pinSdkDependencies(version) {
  for (const file of manifestPaths()) {
    const manifest = readJson(file);
    let changed = false;
    for (const field of [
      "dependencies",
      "devDependencies",
      "peerDependencies",
    ]) {
      for (const name of SDK_PACKAGES) {
        if (manifest[field]?.[name] !== undefined) {
          manifest[field][name] = version;
          changed = true;
        }
      }
    }
    if (changed) writeJson(file, manifest);
  }
}

function fallbackNotes(unit) {
  return unit.notes
    .map(
      (note) =>
        `- ${note.breaking ? "**Breaking:** " : ""}${note.summary || note.subject}`,
    )
    .join("\n");
}

export function promoteUnreleased(changelog, heading, generated) {
  const marker = /^## Unreleased[ \t]*\n/mu;
  const match = marker.exec(changelog);
  if (!match) throw new Error("Changelog has no '## Unreleased' section");
  const start = match.index + match[0].length;
  const nextHeading = changelog.slice(start).search(/^## /mu);
  const body = changelog.slice(
    start,
    nextHeading === -1 ? undefined : start + nextHeading,
  );
  const rest = nextHeading === -1 ? "" : changelog.slice(start + nextHeading);
  const head = `${changelog.slice(0, match.index)}## Unreleased\n\n`;
  const pending = body.trim() ? body.replace(/^\n+/u, "") : "";

  // Re-applying a pushed but unpublished preparation (e.g. after a failed
  // package job): keep the existing section and add only newer entries.
  const version = /^## (\d+\.\d+\.\d+)/u.exec(heading)?.[1];
  const existing =
    version &&
    new RegExp(
      `^## ${version.replaceAll(".", "\\.")}(?:[ \\t][^\\n]*)?\\n\\n?`,
      "mu",
    ).exec(rest);
  if (existing) {
    const at = existing.index + existing[0].length;
    return `${head}${rest.slice(0, at)}${pending.replace(/\n+$/u, "\n")}${rest.slice(at)}`;
  }
  return `${head}${heading}\n\n${pending || `${generated}\n\n`}${rest}`;
}

/**
 * Intent files stay until their version is published, so a preparation that
 * was pushed but failed to publish still replans with its intent. Later
 * preparations remove intents that are no longer above the published version.
 */
function removePublishedIntents(record) {
  for (const id of UNIT_IDS) {
    const file = `${RELEASE_DIR}/intents/${id}.json`;
    const intent = readJsonIfExists(file)?.version;
    const published = record.units[id]?.published;
    if (intent && published && compareVersions(intent, published) <= 0) {
      rmSync(path.join(ROOT, file), { force: true });
    }
  }
}

function apply(options) {
  if (!options.plan) throw new Error("--plan is required");
  const record = JSON.parse(readFileSync(options.plan, "utf8"));
  const head = git("rev-parse", "HEAD").trim();
  if (record.sourceSha !== head) {
    throw new Error(
      `Plan was made for ${record.sourceSha}, but HEAD is ${head}; replan`,
    );
  }
  const releasing = UNIT_IDS.filter(
    (id) => record.units[id]?.status === "release",
  );
  if (releasing.length === 0) {
    console.log("Nothing to release.");
    return;
  }
  const date = record.createdAt.slice(0, 10);
  for (const id of releasing) {
    const unit = record.units[id];
    const config = RELEASE_UNITS[id];
    for (const manifest of config.manifests) setVersion(manifest, unit.version);
    if (id === "sdk") pinSdkDependencies(unit.version);
    if (config.changelog) {
      const heading =
        id === "sdk" ? `## ${unit.version} — ${date}` : `## ${unit.version}`;
      writeFileSync(
        path.join(ROOT, config.changelog),
        promoteUnreleased(
          readText(config.changelog),
          heading,
          fallbackNotes(unit),
        ),
      );
    }
  }
  removePublishedIntents(record);
  execFileSync(
    "npm",
    [
      "install",
      "--package-lock-only",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ],
    { cwd: ROOT, stdio: "inherit" },
  );
  execFileSync("npm", ["run", "docs:generate"], {
    cwd: ROOT,
    stdio: "inherit",
  });
  writeJson(LAST_PLAN, record);
  console.log(
    `Prepared ${releasing.map((id) => record.units[id].tag).join(", ")}`,
  );
}

// ---------------------------------------------------------------------------
// notes

function changelogSection(file, version) {
  const text = readText(file);
  const start = text.search(
    new RegExp(`^## ${version.replaceAll(".", "\\.")}(?:\\s|$)`, "mu"),
  );
  if (start === -1) return undefined;
  const afterHeading = text.indexOf("\n", start) + 1;
  const end = text.slice(afterHeading).search(/^## /mu);
  return text
    .slice(afterHeading, end === -1 ? undefined : afterHeading + end)
    .trim();
}

function notes(options) {
  const id = options.unit;
  const record = readJsonIfExists(LAST_PLAN);
  const unit = record?.units?.[id];
  if (
    !unit ||
    unit.status !== "release" ||
    (options.version && unit.version !== options.version)
  ) {
    throw new Error(
      `${LAST_PLAN} has no ${id} ${options.version ?? ""} release`.trim(),
    );
  }
  const config = RELEASE_UNITS[id];
  const body =
    (config.changelog && changelogSection(config.changelog, unit.version)) ||
    fallbackNotes(unit);
  const breaking = unit.notes.filter((note) => note.breaking);
  const parts = [body];
  if (breaking.length > 0 && config.changelog) {
    parts.push(
      `### Breaking changes\n\n${breaking.map((note) => `- ${note.summary || note.subject}`).join("\n")}`,
    );
  }
  parts.push(
    `Built from ${record.sourceSha.slice(0, 12)}. Previous release: ${unit.baselineRef}. Verify downloads against \`SHA256SUMS\`.`,
  );
  console.log(parts.join("\n\n"));
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === "plan") await plan(options);
  else if (options.command === "apply") apply(options);
  else if (options.command === "notes") notes(options);
  else {
    console.error("Usage: release-coordinator.mjs plan|apply|notes [options]");
    process.exit(1);
  }
}
