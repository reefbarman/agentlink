import { readFile, readdir } from "node:fs/promises";

import path from "node:path";
import { spawn } from "node:child_process";

const testMode = process.argv.includes("--test");
const repoRoot = path.resolve(import.meta.dirname, "..");
const children = [];
let stopping = false;

async function workspaceDirectories() {
  const manifests = [];
  for (const parentName of ["packages", "apps"]) {
    const parent = path.join(repoRoot, parentName);
    let entries;
    try {
      entries = await readdir(parent, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const directory = path.join(parent, entry.name);
      try {
        const manifest = JSON.parse(
          await readFile(path.join(directory, "package.json"), "utf8"),
        );
        if (manifest.scripts?.watch) manifests.push(directory);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  }
  return manifests.sort();
}

function terminateChildren(except, signal = "SIGTERM") {
  const running = children.filter(
    (child) => child !== except && child.exitCode === null,
  );
  for (const child of running) child.kill(signal);
  if (signal === "SIGKILL" || running.length === 0) return;

  const forceKill = setTimeout(() => {
    terminateChildren(except, "SIGKILL");
  }, 2_000);
  forceKill.unref();
}

function start(command, args, cwd = repoRoot) {
  const child = spawn(command, args, {
    cwd,
    env: process.env,
    stdio: "inherit",
  });
  children.push(child);
  child.once("exit", (code, signal) => {
    if (stopping) return;
    stopping = true;
    terminateChildren(child);
    process.exitCode = signal ? 128 : (code ?? 1);
  });
}

for (const directory of await workspaceDirectories()) {
  start("npm", ["run", "watch"], directory);
}

if (testMode) start("npx", ["vitest"]);
else start(process.execPath, ["esbuild.mjs", "--watch"]);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    stopping = true;
    terminateChildren(undefined, signal);
    process.exitCode = signal === "SIGINT" ? 130 : 143;
  });
}
