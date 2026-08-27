import { canonicalizePath } from "./canonicalPath.js";

interface LockWaiter {
  grant(): void;
  timer: ReturnType<typeof setTimeout>;
}

interface PathLock {
  active: boolean;
  waiters: LockWaiter[];
}

// Per-path mutex to prevent concurrent edits to the same canonical file.
const pathLocks = new Map<string, PathLock>();
const LOCK_TIMEOUT = 60_000;

export class FileLockTimeoutError extends Error {
  readonly code = "pending_edit_lock";

  constructor(filePath: string) {
    super(`Lock timeout: another edit to ${filePath} is pending`);
    this.name = "FileLockTimeoutError";
  }
}

export async function withFileLock<T>(
  filePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const lockKey = canonicalizePath(filePath);
  let lock = pathLocks.get(lockKey);
  if (!lock) {
    lock = { active: false, waiters: [] };
    pathLocks.set(lockKey, lock);
  }

  if (lock.active) {
    await new Promise<void>((resolve, reject) => {
      const waiter: LockWaiter = {
        grant: resolve,
        timer: setTimeout(() => {
          const index = lock!.waiters.indexOf(waiter);
          if (index >= 0) lock!.waiters.splice(index, 1);
          reject(new FileLockTimeoutError(filePath));
        }, LOCK_TIMEOUT),
      };
      lock!.waiters.push(waiter);
    });
  } else {
    lock.active = true;
  }

  try {
    return await fn();
  } finally {
    const next = lock.waiters.shift();
    if (next) {
      clearTimeout(next.timer);
      next.grant();
    } else {
      lock.active = false;
      if (pathLocks.get(lockKey) === lock) {
        pathLocks.delete(lockKey);
      }
    }
  }
}

/** Acquire multiple file locks in stable order to avoid cross-edit deadlocks. */
export async function withFileLocks<T>(
  filePaths: readonly string[],
  fn: () => Promise<T>,
): Promise<T> {
  const paths = [
    ...new Set(filePaths.map((filePath) => canonicalizePath(filePath))),
  ].sort();
  const acquire = async (index: number): Promise<T> => {
    if (index >= paths.length) return fn();
    return withFileLock(paths[index]!, () => acquire(index + 1));
  };
  return acquire(0);
}
