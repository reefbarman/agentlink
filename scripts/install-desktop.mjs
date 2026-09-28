import { cp, lstat, mkdtemp, rename, rm } from "node:fs/promises";

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { verifyMacSignature } from "./macos-signing.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const destination = "/Applications/AgentLink.app";
const identifier = "com.agentlink.desktop";

export function assertDesktopStopped(processes, currentPid = process.pid) {
  const running = processes.split("\n").filter((line) => {
    const match = /^\s*(\d+)\s+(.+)$/u.exec(line);
    if (!match || Number(match[1]) === currentPid) return false;
    const command = match[2];
    return /(?:^|\s|\/)AgentLink\.app\/Contents\/(?:MacOS|Frameworks)\//u.test(
      command,
    );
  });
  if (running.length) {
    throw new Error(
      `Quit AgentLink and its desktop helper before installing (running: ${running.join(", ")}). No processes were stopped.`,
    );
  }
}

export async function installDesktop(source) {
  if (process.platform !== "darwin")
    throw new Error("Desktop install requires macOS.");
  if (path.resolve(source) === destination) {
    throw new Error("Source and destination app must differ.");
  }
  const sourceStat = await lstat(source);
  if (!sourceStat.isDirectory())
    throw new Error(`Expected a packaged app directory: ${source}`);
  verifyMacSignature(source, { identifier, deep: true });
  assertDesktopStopped(
    execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" }),
  );
  const existing = await lstat(destination).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing && !existing.isDirectory()) {
    throw new Error(`Refusing to replace a non-directory at ${destination}.`);
  }

  const staging = await mkdtemp("/Applications/.agentlink-install-");
  const candidate = path.join(staging, "AgentLink.app");
  const backup = path.join(staging, "previous.app");
  let replaced = false;
  let installed = false;
  try {
    await cp(source, candidate, { recursive: true, verbatimSymlinks: true });
    verifyMacSignature(candidate, { identifier, deep: true });
    assertDesktopStopped(
      execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" }),
    );
    if (existing) {
      await rename(destination, backup);
      replaced = true;
    }
    await rename(candidate, destination);
    installed = true;
    verifyMacSignature(destination, { identifier, deep: true });
  } catch (error) {
    try {
      if (installed)
        await rename(destination, path.join(staging, "failed.app"));
      if (replaced) await rename(backup, destination);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        `Install failed and rollback failed; recover the previous app from ${backup}.`,
      );
    }
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  await rm(staging, { recursive: true, force: true }).catch(() => {
    process.stderr.write(
      `Installed AgentLink, but could not remove the previous app at ${backup}.\n`,
    );
  });
  process.stdout.write(`Installed signed AgentLink at ${destination}\n`);
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  if (args.length > 1 || args[0] === "--help") {
    throw new Error(
      "Usage: node scripts/install-desktop.mjs [path/to/AgentLink.app]",
    );
  }
  await installDesktop(
    path.resolve(
      args[0] ?? path.join(root, "desktop-releases/mac-arm64/AgentLink.app"),
    ),
  );
}
