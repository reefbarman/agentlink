import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
} from "node:fs/promises";

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { verifyCliBundle } from "./verify-cli-bundle.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const defaultBundle = path.join(
  repoRoot,
  "cli-releases/agentlink-cli-darwin-arm64",
);

async function entryType(file) {
  try {
    return await lstat(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function recognisedEntrypoint(file, installedLauncher) {
  const entry = await entryType(file);
  if (!entry) return true;
  if (entry.isSymbolicLink()) {
    const target = await readlink(file);
    const resolved = path.resolve(path.dirname(file), target);
    return (
      resolved === installedLauncher ||
      /\/node_modules\/@agentlink\/cli\/dist\/agentlink\.js$/u.test(resolved)
    );
  }
  if (!entry.isFile()) return false;
  const content = await readFile(file, "utf8");
  return (
    content.startsWith("#!/bin/sh\n") &&
    content.includes("@agentlink/cli/dist/agentlink.js") &&
    content.includes("basedir=")
  );
}

export async function installCli({
  bundle = defaultBundle,
  home = os.homedir(),
} = {}) {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("Standalone CLI installation supports macOS ARM64 only.");
  }
  const source = path.resolve(bundle);
  await verifyCliBundle(source); // Unsigned CI previews cannot be installed by this command.
  const lib = path.join(home, ".local/lib/agentlink");
  const bin = path.join(home, ".local/bin");
  const installed = path.join(lib, "cli");
  const entrypoint = path.join(bin, "agentlink");
  if (
    !(await recognisedEntrypoint(
      entrypoint,
      path.join(installed, "bin/agentlink"),
    ))
  ) {
    throw new Error(
      `Refusing to replace unrelated CLI entrypoint: ${entrypoint}`,
    );
  }
  const previous = await entryType(installed);
  if (previous && (!previous.isDirectory() || previous.isSymbolicLink())) {
    throw new Error(
      `Refusing to replace non-directory CLI installation: ${installed}`,
    );
  }
  const processes = execFileSync("ps", ["-axo", "command="], {
    encoding: "utf8",
  });
  if (
    processes
      .split("\n")
      .some(
        (command) =>
          command.includes(`${lib}/`) && command.includes("/node/bin/node"),
      )
  ) {
    throw new Error(
      "Quit active standalone CLI sessions before installing. No processes were stopped.",
    );
  }
  await mkdir(lib, { recursive: true });
  await mkdir(bin, { recursive: true });
  const id = randomUUID();
  const stage = path.join(lib, `.cli-stage-${id}`);
  const backup = path.join(lib, `cli-backup-${id}`);
  const linkStage = path.join(bin, `.agentlink-stage-${id}`);
  const previousLink = path.join(bin, `.agentlink-backup-${id}`);
  let movedOld = false;
  let movedLink = false;
  let activated = false;
  let linked = false;
  try {
    await cp(source, stage, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    await verifyCliBundle(stage);
    await symlink(path.join(installed, "bin/agentlink"), linkStage);
    if (previous) {
      await rename(installed, backup);
      movedOld = true;
    }
    await rename(stage, installed);
    activated = true;
    if (await entryType(entrypoint)) {
      await rename(entrypoint, previousLink);
      movedLink = true;
    }
    await rename(linkStage, entrypoint);
    linked = true;
    await verifyCliBundle(installed);
  } catch (error) {
    try {
      if (activated) await rm(installed, { recursive: true, force: true });
      if (movedOld) await rename(backup, installed);
      if (movedLink) {
        await rm(entrypoint, { force: true });
        await rename(previousLink, entrypoint);
      } else if (linked) {
        await rm(entrypoint, { force: true });
      }
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        `CLI installation and rollback failed. Recover the previous bundle from ${backup} and entrypoint from ${previousLink}.`,
      );
    }
    throw error;
  } finally {
    await rm(stage, { recursive: true, force: true });
    await rm(linkStage, { force: true });
  }
  // Retain one recoverable installation, not an unbounded collection of runtimes.
  try {
    if (movedLink) await rm(previousLink);
    for (const entry of await readdir(lib, { withFileTypes: true })) {
      if (
        entry.isDirectory() &&
        /^cli-backup-[0-9a-f-]{36}$/u.test(entry.name) &&
        path.join(lib, entry.name) !== backup
      ) {
        await rm(path.join(lib, entry.name), { recursive: true });
      }
    }
  } catch (error) {
    console.warn(
      `CLI installed, but old backup cleanup failed: ${error.message}`,
    );
  }
  return { installed, entrypoint, previous: movedOld ? backup : null };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const result = await installCli({ bundle: process.argv[2] });
  console.log(
    `Installed ${result.entrypoint}${result.previous ? ` (previous bundle preserved at ${result.previous})` : ""}`,
  );
}
