import { cp, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";

import { fileURLToPath } from "node:url";
import path from "node:path";

export const VOICE_RUNTIME_PACKAGE = "@picovoice/pvrecorder-node";

/**
 * VSIX target -> pvrecorder native library directory. Linux arm64 is omitted
 * because pvrecorder only ships Raspberry Pi CPU builds for it; voice input
 * reports itself unavailable there.
 */
export const VOICE_NATIVE_LIBRARY_DIRS = {
  "darwin-arm64": "lib/mac/arm64",
  "darwin-x64": "lib/mac/x86_64",
  "linux-x64": "lib/linux/x86_64",
  "win32-x64": "lib/windows/amd64",
  "win32-arm64": "lib/windows/arm64",
};

export function resolveVoiceRuntimeTarget({
  target = process.env.AGENTLINK_VSCE_TARGET,
  platform = process.platform,
  architecture = process.arch,
} = {}) {
  const resolved = target ?? `${platform}-${architecture}`;
  return resolved in VOICE_NATIVE_LIBRARY_DIRS ? resolved : null;
}

async function pathExists(candidate) {
  try {
    await stat(candidate);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Stages the pvrecorder JavaScript wrapper plus only the target's native
 * library into dist/node_modules. Source maps, type declarations, sources,
 * tests, and other platforms' binaries are excluded.
 */
export async function stageVoiceRuntime({
  repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  destinationRoot = path.join(repoRoot, "dist", "node_modules"),
  target = resolveVoiceRuntimeTarget(),
} = {}) {
  if (!target) return { target: null, files: [] };
  const libraryDir = VOICE_NATIVE_LIBRARY_DIRS[target];
  const sourceRoot = path.join(repoRoot, "node_modules", VOICE_RUNTIME_PACKAGE);
  if (!(await pathExists(path.join(sourceRoot, "package.json")))) {
    throw new Error(
      `Required voice runtime package is not installed: ${VOICE_RUNTIME_PACKAGE}`,
    );
  }
  const nativeLibrary = path.join(libraryDir, "pv_recorder.node");
  if (!(await pathExists(path.join(sourceRoot, nativeLibrary)))) {
    throw new Error(
      `Voice runtime native library is missing for ${target}: ${nativeLibrary}`,
    );
  }

  const destination = path.join(destinationRoot, VOICE_RUNTIME_PACKAGE);
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });

  const files = ["package.json", nativeLibrary];
  for (const entry of await readdir(sourceRoot)) {
    if (/^licen[cs]e/iu.test(entry)) files.push(entry);
  }
  for (const entry of await readdir(path.join(sourceRoot, "dist"))) {
    if (entry.endsWith(".js")) files.push(path.join("dist", entry));
  }

  for (const relative of files) {
    const target = path.join(destination, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(path.join(sourceRoot, relative), target, {
      force: true,
      preserveTimestamps: true,
    });
  }

  const manifest = JSON.parse(
    await readFile(path.join(sourceRoot, "package.json"), "utf8"),
  );
  return {
    target,
    version: manifest.version,
    files: files.map((file) => file.split(path.sep).join("/")).sort(),
  };
}

const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  process.stdout.write(
    `${JSON.stringify(await stageVoiceRuntime(), null, 2)}\n`,
  );
}
