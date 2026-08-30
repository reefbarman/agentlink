import * as fs from "node:fs/promises";
import * as path from "node:path";

import { randomUUID } from "node:crypto";

import { getSharedMemoryMigrationDirectory } from "./sharedMemoryStorePaths.js";

const SHARED_MEMORY_MIGRATION_STALE_MS = 24 * 60 * 60_000;

interface SharedMemoryMigrationOwner {
  pid: number;
  startedAt: string;
}

export interface SharedMemoryMigrationLease {
  dispose(): Promise<void>;
}

export async function beginSharedMemoryMigration(
  homeDir?: string,
): Promise<SharedMemoryMigrationLease> {
  const directory = getSharedMemoryMigrationDirectory(homeDir);
  await fs.mkdir(directory, { recursive: true });
  const markerPath = path.join(
    directory,
    `${process.pid}-${randomUUID()}.json`,
  );
  await fs.writeFile(
    markerPath,
    `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() } satisfies SharedMemoryMigrationOwner)}\n`,
    { mode: 0o600 },
  );
  let disposed = false;
  return {
    async dispose() {
      if (disposed) return;
      disposed = true;
      await fs.rm(markerPath, { force: true });
    },
  };
}

export async function isSharedMemoryMigrationPending(
  homeDir?: string,
): Promise<boolean> {
  const directory = getSharedMemoryMigrationDirectory(homeDir);
  let names: string[];
  try {
    names = await fs.readdir(directory);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return false;
    return true;
  }
  let pending = false;
  for (const name of names) {
    const markerPath = path.join(directory, name);
    try {
      const owner = JSON.parse(
        await fs.readFile(markerPath, "utf8"),
      ) as Partial<SharedMemoryMigrationOwner>;
      const startedAt = Date.parse(owner.startedAt ?? "");
      if (!Number.isFinite(startedAt)) {
        pending = true;
        continue;
      }
      if (Date.now() - startedAt >= SHARED_MEMORY_MIGRATION_STALE_MS) {
        await fs.rm(markerPath, { force: true });
        continue;
      }
      if (!Number.isSafeInteger(owner.pid) || Number(owner.pid) <= 0) {
        pending = true;
        continue;
      }
      if (isProcessAlive(Number(owner.pid))) {
        pending = true;
        continue;
      }
      await fs.rm(markerPath, { force: true });
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT")) pending = true;
    }
  }
  return pending;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return hasErrorCode(error, "EPERM");
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    String((error as { code?: unknown }).code) === code
  );
}
