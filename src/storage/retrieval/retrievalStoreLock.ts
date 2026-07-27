import * as fs from "node:fs/promises";
import * as path from "node:path";

import { randomUUID } from "node:crypto";
import { sleep } from "../../util/sleep.js";

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_STALE_MS = 10_000;
const RETRY_MS = 50;

export interface RetrievalStoreLockOptions {
  timeoutMs?: number;
  staleMs?: number;
}

export async function withRetrievalStoreLock<T>(
  root: string,
  operation: () => Promise<T>,
  options: RetrievalStoreLockOptions = {},
): Promise<T> {
  const lockDirectory = `${root}.lock`;
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const ownerToken = randomUUID();
  const ownerPath = path.join(lockDirectory, ownerToken);

  await fs.mkdir(path.dirname(root), { recursive: true });
  while (true) {
    try {
      await fs.mkdir(lockDirectory);
      await fs.writeFile(ownerPath, `${process.pid}\n`, { mode: 0o600 });
      break;
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error;
      try {
        const stat = await staleReferenceStat(lockDirectory);
        if (Date.now() - stat.mtimeMs > staleMs) {
          await fs.rm(lockDirectory, { recursive: true, force: true });
          continue;
        }
      } catch {
        // The lock disappeared between attempts.
      }
      if (Date.now() >= deadline) {
        throw new Error("retrieval_store_lock_timeout");
      }
      await sleep(RETRY_MS);
    }
  }

  const heartbeat = setInterval(
    () => {
      const now = new Date();
      void fs.utimes(ownerPath, now, now).catch(() => undefined);
    },
    Math.max(100, Math.floor(staleMs / 3)),
  );
  heartbeat.unref();
  try {
    return await operation();
  } finally {
    clearInterval(heartbeat);
    try {
      await fs.stat(ownerPath);
      await fs.rm(lockDirectory, { recursive: true, force: true });
    } catch {
      // A stale-lock recovery already replaced this owner's directory.
    }
  }
}

async function staleReferenceStat(lockDirectory: string) {
  const owners = await fs.readdir(lockDirectory);
  const owner = owners.sort()[0];
  return fs.stat(owner ? path.join(lockDirectory, owner) : lockDirectory);
}

function isAlreadyExistsError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    String((error as { code?: unknown }).code) === "EEXIST"
  );
}
