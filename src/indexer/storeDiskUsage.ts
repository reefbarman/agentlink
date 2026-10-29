import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { Dirent } from "node:fs";

/**
 * Total size of regular files under `root`, without following symlinks.
 * Files that disappear while the tree is walked are skipped, and a missing
 * root measures as zero.
 */
export async function measureDirectoryBytes(root: string): Promise<number> {
  let bytes = 0;
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
      } else if (entry.isFile()) {
        try {
          bytes += (await fs.lstat(entryPath)).size;
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
      }
    }
  }
  return bytes;
}

/**
 * Runs `operation` and returns how many bytes the directory shrank by.
 * Lance's own prune statistics omit old version manifests, which are most of
 * a bloated store, so the on-disk difference is the honest figure. Growth
 * (for example, compaction output with nothing to prune) reports as zero.
 */
export async function measureReclaimedBytes(
  root: string,
  operation: () => Promise<void>,
): Promise<{ bytesReclaimed: number; bytesAfter: number }> {
  const bytesBefore = await measureDirectoryBytes(root);
  await operation();
  const bytesAfter = await measureDirectoryBytes(root);
  return {
    bytesReclaimed: Math.max(0, bytesBefore - bytesAfter),
    bytesAfter,
  };
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}
