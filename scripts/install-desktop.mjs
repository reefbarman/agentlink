import { cp, lstat, mkdtemp, rename, rm } from "node:fs/promises";

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { verifyMacSignature } from "./macos-signing.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const destination = "/Applications/AgentLink.app";
const identifier = "com.agentlink.desktop";
const DESKTOP_PROCESS =
  /(?:^|\s|\/)AgentLink\.app\/Contents\/(?:MacOS|Frameworks)\//u;
const DESKTOP_APP_PROCESS =
  /AgentLink\.app\/Contents\/MacOS\/AgentLink(?:\s+-\S+)*\s*$/u;
const QUIT_TIMEOUT_MS = 20_000;

function readProcesses() {
  return execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
}

export function findDesktopProcesses(processes, currentPid = process.pid) {
  return processes.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(.+)$/u.exec(line);
    if (!match) return [];
    const pid = Number(match[1]);
    const command = match[2];
    if (pid === currentPid || !DESKTOP_PROCESS.test(command)) return [];
    return [{ pid, command, app: DESKTOP_APP_PROCESS.test(command) }];
  });
}

export function assertDesktopStopped(processes, currentPid = process.pid) {
  const running = findDesktopProcesses(processes, currentPid);
  if (running.length) {
    throw new Error(
      `Quit AgentLink and its desktop helper before installing (running: ${formatProcesses(running)}).`,
    );
  }
}

// SIGTERM makes Electron run its normal quit path (before-quit shutdown),
// so helpers are released the same way as choosing Quit from the menu.
export async function quitRunningDesktop({
  listProcesses = readProcesses,
  signal = (pid) => process.kill(pid, "SIGTERM"),
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  timeoutMs = QUIT_TIMEOUT_MS,
  pollMs = 250,
} = {}) {
  const apps = findDesktopProcesses(listProcesses()).filter((p) => p.app);
  if (!apps.length) return false;
  process.stdout.write(
    `Quitting running AgentLink (pid ${apps.map((p) => p.pid).join(", ")})...\n`,
  );
  for (const { pid } of apps) {
    try {
      signal(pid);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
  let running = [];
  for (let waited = 0; waited <= timeoutMs; waited += pollMs) {
    running = findDesktopProcesses(listProcesses());
    if (!running.length) return true;
    await wait(pollMs);
  }
  throw new Error(
    `AgentLink did not exit within ${timeoutMs / 1000}s of a quit request (running: ${formatProcesses(running)}). Quit it manually and retry.`,
  );
}

function formatProcesses(processes) {
  return processes.map(({ pid, command }) => `${pid} ${command}`).join(", ");
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
  await quitRunningDesktop();
  assertDesktopStopped(readProcesses());
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
    assertDesktopStopped(readProcesses());
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
