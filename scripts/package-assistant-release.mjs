#!/usr/bin/env node

import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";

import { fileURLToPath } from "node:url";
import path from "node:path";
import { writeAssistantDeploymentMetadata } from "./assistant-deployment-assets.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIGEST_TARGETS = {
  assistant: ["ASSISTANT_IMAGE", "agentlink-assistant"],
  "command-worker": ["COMMAND_WORKER_IMAGE", "agentlink-command-worker"],
  publisher: ["PUBLISHER_IMAGE", "agentlink-publisher"],
  backup: ["BACKUP_IMAGE", "agentlink-backup"],
  editor: ["EDITOR_IMAGE", "agentlink-editor"],
  browser: ["BROWSER_IMAGE", "agentlink-browser"],
  updater: ["UPDATER_IMAGE", "agentlink-updater"],
};
const DEPLOY = "apps/server/deploy";
const CONTAINER = `${DEPLOY}/container`;

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (
      !["--version", "--commit", "--digests", "--out", "--channel"].includes(
        key,
      )
    ) {
      throw new Error(`Unexpected argument: ${key}`);
    }
    if (!value || value.startsWith("--"))
      throw new Error(`Missing value for ${key}`);
    if (args[key]) throw new Error(`Duplicate argument: ${key}`);
    args[key] = value;
  }
  for (const key of ["--version", "--commit", "--digests", "--out"]) {
    if (!args[key]) throw new Error(`${key} is required`);
  }
  return args;
}

function validate({ version, commit, digests }) {
  if (
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version) ||
    !version.split(".").map(Number).every(Number.isSafeInteger)
  ) {
    throw new Error(`Invalid release version: ${version}`);
  }
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error(`Invalid release commit: ${commit}`);
  }
  if (!digests || typeof digests !== "object" || Array.isArray(digests)) {
    throw new Error(
      "Digests must be a JSON object mapping every image target to a digest",
    );
  }
  const expected = Object.keys(DIGEST_TARGETS).sort();
  const actual = Object.keys(digests).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Digest targets must be exactly: ${expected.join(", ")}`);
  }
  for (const target of expected) {
    if (
      typeof digests[target] !== "string" ||
      !/^sha256:[0-9a-f]{64}$/.test(digests[target])
    ) {
      throw new Error(`Invalid sha256 digest for ${target}`);
    }
  }
}

export function packageAssistantRelease({
  version,
  commit,
  digests,
  out,
  channel = "preview",
  root = ROOT,
}) {
  validate({ version, commit, digests });
  if (channel !== "stable" && channel !== "preview") {
    throw new Error(`Invalid release channel: ${channel}`);
  }
  const output = path.resolve(root, out);
  const lines = [`RELEASE_VERSION=${version}`, `RELEASE_COMMIT=${commit}`];
  for (const [target, [key, image]] of Object.entries(DIGEST_TARGETS)) {
    lines.push(`${key}=ghcr.io/reefbarman/${image}@${digests[target]}`);
  }
  mkdirSync(output, { recursive: true });
  writeFileSync(
    path.join(output, "assistant-release.env"),
    `${lines.join("\n")}\n`,
  );

  const containerPath = path.join(root, CONTAINER);
  const composeFiles = readdirSync(containerPath)
    .filter((name) => name.endsWith(".yaml"))
    .sort();
  for (const name of composeFiles) {
    copyFileSync(path.join(containerPath, name), path.join(output, name));
  }
  copyFileSync(
    path.join(containerPath, "witness/compose.yaml"),
    path.join(output, "compose.witness.yaml"),
  );
  for (const name of ["server.example.json", "searxng.settings.example.yml"]) {
    copyFileSync(path.join(containerPath, name), path.join(output, name));
  }
  for (const name of ["install.sh", "upgrade.sh"]) {
    copyFileSync(path.join(root, DEPLOY, name), path.join(output, name));
  }
  writeAssistantDeploymentMetadata({ out: output, version, commit });
  writeFileSync(
    path.join(output, "agentlink-update.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        product: "assistant",
        version,
        tag: `assistant-v${version}`,
        channel,
        targets: {
          "linux-x64": "assistant-release.env",
          "linux-arm64": "assistant-release.env",
        },
        engines: {},
      },
      null,
      2,
    )}\n`,
  );
  return output;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const digests = JSON.parse(readFileSync(args["--digests"], "utf8"));
    const output = packageAssistantRelease({
      version: args["--version"],
      commit: args["--commit"],
      digests,
      out: args["--out"],
      channel: args["--channel"] ?? "preview",
    });
    console.log(`Packaged Assistant release assets in ${output}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
