import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * Code index stores live under generation-suffixed directories
 * (`code-indexes`, `code-indexes-v3`, `code-indexes-v4`, ...). A generation
 * bump abandons the previous directory wholesale — nothing ever reads it
 * again — but until now nothing deleted it either, so superseded generations
 * accumulated tens of gigabytes of dead Lance stores on disk.
 */
const GENERATION_DIRECTORY_PATTERN = /^code-indexes(?:-v(\d+))?$/;

/**
 * Another VS Code window running an older extension build may still be
 * writing into a superseded generation. Lease renewals and lock heartbeats
 * touch files at the generation root (or inside `*.lock` directories), so a
 * quiet window this long means no live writer remains.
 */
const RECENT_ACTIVITY_WINDOW_MS = 48 * 60 * 60 * 1000;

export interface SupersededGenerationCleanupResult {
  removed: string[];
  skippedActive: string[];
}

export async function cleanupSupersededCodeIndexGenerations(
  globalStoragePath: string,
  currentGeneration: number,
  options: { now?: number } = {},
): Promise<SupersededGenerationCleanupResult> {
  const now = options.now ?? Date.now();
  const removed: string[] = [];
  const skippedActive: string[] = [];
  let entries: string[];
  try {
    entries = await fs.readdir(globalStoragePath);
  } catch {
    return { removed, skippedActive };
  }
  for (const entry of entries) {
    const match = GENERATION_DIRECTORY_PATTERN.exec(entry);
    if (!match) continue;
    const generation = match[1] ? Number(match[1]) : 1;
    if (!Number.isFinite(generation) || generation >= currentGeneration) {
      continue;
    }
    const target = path.join(globalStoragePath, entry);
    const stats = await fs.stat(target).catch(() => undefined);
    if (!stats?.isDirectory()) continue;
    if (await hasRecentActivity(target, now)) {
      skippedActive.push(entry);
      continue;
    }
    await fs.rm(target, { recursive: true, force: true });
    removed.push(entry);
  }
  return { removed, skippedActive };
}

async function hasRecentActivity(root: string, now: number): Promise<boolean> {
  const dirents = await fs
    .readdir(root, { withFileTypes: true })
    .catch(() => []);
  for (const dirent of dirents) {
    const entryPath = path.join(root, dirent.name);
    const stats = await fs.stat(entryPath).catch(() => undefined);
    if (stats && now - stats.mtimeMs < RECENT_ACTIVITY_WINDOW_MS) return true;
    if (dirent.isDirectory() && dirent.name.endsWith(".lock")) {
      const lockEntries = await fs.readdir(entryPath).catch(() => []);
      for (const lockEntry of lockEntries) {
        const lockStats = await fs
          .stat(path.join(entryPath, lockEntry))
          .catch(() => undefined);
        if (lockStats && now - lockStats.mtimeMs < RECENT_ACTIVITY_WINDOW_MS) {
          return true;
        }
      }
    }
  }
  return false;
}
