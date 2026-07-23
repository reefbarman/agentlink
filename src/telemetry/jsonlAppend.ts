import * as fs from "fs/promises";
import * as path from "path";

import { sleep } from "../util/sleep.js";

export interface JsonlAppendLockOptions {
  /** How long to wait for a contended lock before giving up. */
  lockTimeoutMs: number;
  /** Locks older than this are treated as leftovers from a dead process. */
  staleLockMs: number;
  /** Error message thrown when the lock cannot be acquired in time. */
  lockTimeoutError: string;
}

function isAlreadyExistsError(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === "object" &&
    "code" in err &&
    String((err as { code?: unknown }).code) === "EEXIST"
  );
}

/**
 * Append pre-serialized JSONL lines to a shared telemetry file, guarded by a
 * cross-process directory lock (multiple VS Code windows append to the same
 * file). Stale locks from dead extension hosts are reclaimed.
 */
export async function appendJsonlLinesWithLock(
  filePath: string,
  lines: string[],
  options: JsonlAppendLockOptions,
): Promise<void> {
  if (lines.length === 0) return;
  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + options.lockTimeoutMs;

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  while (true) {
    try {
      await fs.mkdir(lockPath);
      break;
    } catch (err) {
      if (!isAlreadyExistsError(err)) throw err;
      try {
        const stat = await fs.stat(lockPath);
        if (Date.now() - stat.mtimeMs > options.staleLockMs) {
          await fs.rm(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(options.lockTimeoutError);
      }
      await sleep(50);
    }
  }

  try {
    await fs.appendFile(filePath, lines.map((line) => line + "\n").join(""), {
      encoding: "utf-8",
      mode: 0o600,
    });
  } finally {
    await fs.rm(lockPath, { recursive: true, force: true });
  }
}
