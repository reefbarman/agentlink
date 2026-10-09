import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";

/** Another live process (or this one) already holds the lock. */
export class FileLockHeldError extends Error {
  constructor(readonly lockPath: string) {
    super(`Lock is held by another process: ${lockPath}`);
    this.name = "FileLockHeldError";
  }
}

/**
 * Create the lock file exclusively and return its token. A lock left by a
 * process that no longer exists is replaced; a live holder (including this
 * process) is refused with `FileLockHeldError`.
 */
export async function acquireFileLock(lockPath: string): Promise<string> {
  const token = randomUUID();
  const content = `${JSON.stringify({ pid: process.pid, token })}\n`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fs.open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(content, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      return token;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const holder = await readLockHolder(lockPath);
    if (holder !== undefined && processExists(holder)) {
      throw new FileLockHeldError(lockPath);
    }
    await fs.unlink(lockPath).catch(() => undefined);
  }
  throw new FileLockHeldError(lockPath);
}

/** Release a lock this holder acquired. Idempotent. */
export async function releaseFileLock(
  lockPath: string,
  token: string,
): Promise<void> {
  try {
    const parsed = JSON.parse(await fs.readFile(lockPath, "utf8")) as {
      token?: unknown;
    };
    if (parsed.token === token) await fs.unlink(lockPath);
  } catch {
    // Already released or replaced; nothing to do.
  }
}

async function readLockHolder(lockPath: string): Promise<number | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(lockPath, "utf8")) as {
      pid?: unknown;
    };
    return typeof parsed.pid === "number" && Number.isInteger(parsed.pid)
      ? parsed.pid
      : undefined;
  } catch {
    return undefined;
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
