import * as path from "path";

// Per-path mutex to prevent concurrent edits to the same file.
const pathLocks = new Map<string, Promise<void>>();
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
  // Normalize the path to prevent different representations from getting separate locks.
  const lockKey = path.resolve(filePath);
  const existing = pathLocks.get(lockKey);

  // Create a deferred to control the lock. Insert it immediately so later
  // callers chain on this promise (linked-list lock).
  let releaseLock: () => void;
  const lockPromise = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  pathLocks.set(lockKey, lockPromise);

  if (existing) {
    const TIMED_OUT = Symbol("timeout");
    let timerId: ReturnType<typeof setTimeout>;
    const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
      timerId = setTimeout(() => resolve(TIMED_OUT), LOCK_TIMEOUT);
    });
    const result = await Promise.race([
      existing.then(() => undefined as void),
      timeout,
    ]);
    clearTimeout(timerId!);
    if (result === TIMED_OUT) {
      releaseLock!();
      if (pathLocks.get(lockKey) === lockPromise) {
        pathLocks.delete(lockKey);
      }
      throw new FileLockTimeoutError(filePath);
    }
  }

  try {
    return await fn();
  } finally {
    releaseLock!();
    if (pathLocks.get(lockKey) === lockPromise) {
      pathLocks.delete(lockKey);
    }
  }
}
