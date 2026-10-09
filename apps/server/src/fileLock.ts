import { promises as fs, readFileSync } from "node:fs";

import os from "node:os";
import { randomUUID } from "node:crypto";

/** Another live process (or this one) already holds the lock. */
export class FileLockHeldError extends Error {
  constructor(readonly lockPath: string) {
    super(`Lock is held by another process: ${lockPath}`);
    this.name = "FileLockHeldError";
  }
}

interface LockHolder {
  readonly token: string;
  readonly pid: number;
  /** Linux process start time (clock ticks since boot); absent elsewhere. */
  readonly start?: string;
  /** Hostname of the holder: the machine, or the container it ran in. */
  readonly host?: string;
}

/**
 * Held locks are touched this often, so another host or container (which
 * cannot check the holder's PID) can tell a live holder from a dead one.
 */
export const LOCK_HEARTBEAT_MS = 15_000;
/** A lock from another host or container is stale once untouched this long. */
export const LOCK_LEASE_MS = 60_000;
/** A reclaim marker left by a crash mid-reclaim is ignored after this. */
const RECLAIM_STALE_MS = 10_000;

const heartbeats = new Map<string, NodeJS.Timeout>();

/**
 * Create the lock file exclusively and return its token. A lock left by a
 * holder that is gone is replaced; a live holder (including this process)
 * is refused with `FileLockHeldError`.
 *
 * Liveness: a holder on this host (same hostname) is alive while its PID
 * exists and, on Linux, still has the recorded start time. PIDs repeat
 * across container restarts (the server is often the same low PID each
 * time), so the start time is what tells them apart. A holder elsewhere,
 * such as another container sharing the directory, cannot be checked by
 * PID; it is alive until its heartbeat is older than `LOCK_LEASE_MS`.
 *
 * Replacing a stale lock happens under an exclusive `<lock>.reclaim`
 * marker and only if the lock still has the token that was judged stale,
 * so two contenders cannot both take it.
 */
export async function acquireFileLock(lockPath: string): Promise<string> {
  const token = randomUUID();
  const start = processStartTime(process.pid);
  const content = `${JSON.stringify({
    pid: process.pid,
    token,
    ...(start ? { start } : {}),
    host: os.hostname(),
  })}\n`;
  // Up to: clear a crashed reclaim marker, reclaim the stale lock, create.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await createExclusive(lockPath, content)) {
      startHeartbeat(lockPath, token);
      return token;
    }
    const observed = await readLockHolder(lockPath);
    if (observed === "missing") continue;
    if (
      observed === undefined
        ? await recentlyModified(lockPath, RECLAIM_STALE_MS)
        : await holderAlive(lockPath, observed)
    ) {
      // An unreadable lock may be one being written right now.
      throw new FileLockHeldError(lockPath);
    }
    await reclaimStaleLock(lockPath, observed?.token);
  }
  throw new FileLockHeldError(lockPath);
}

/**
 * Wait for the lock (polling) up to `timeoutMs`, run `operation`, and
 * release it. For short critical sections shared by the service and local
 * commands.
 */
export async function withFileLock<T>(
  lockPath: string,
  operation: () => Promise<T>,
  options: { readonly timeoutMs: number; readonly pollMs?: number },
): Promise<T> {
  const deadline = Date.now() + options.timeoutMs;
  let token: string;
  for (;;) {
    try {
      token = await acquireFileLock(lockPath);
      break;
    } catch (error) {
      if (!(error instanceof FileLockHeldError) || Date.now() >= deadline) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 50));
    }
  }
  try {
    return await operation();
  } finally {
    await releaseFileLock(lockPath, token);
  }
}

/** Release a lock this holder acquired. Idempotent. */
export async function releaseFileLock(
  lockPath: string,
  token: string,
): Promise<void> {
  const timer = heartbeats.get(token);
  if (timer) clearInterval(timer);
  heartbeats.delete(token);
  try {
    const parsed = JSON.parse(await fs.readFile(lockPath, "utf8")) as {
      token?: unknown;
    };
    if (parsed.token === token) await fs.unlink(lockPath);
  } catch {
    // Already released or replaced; nothing to do.
  }
}

async function createExclusive(
  filePath: string,
  content: string,
): Promise<boolean> {
  let handle;
  try {
    handle = await fs.open(filePath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  return true;
}

function startHeartbeat(lockPath: string, token: string): void {
  const timer = setInterval(() => {
    void (async () => {
      try {
        const parsed = JSON.parse(await fs.readFile(lockPath, "utf8")) as {
          token?: unknown;
        };
        if (parsed.token !== token) return;
        const now = new Date();
        await fs.utimes(lockPath, now, now);
      } catch {
        // Released or replaced; the next acquire decides.
      }
    })();
  }, LOCK_HEARTBEAT_MS);
  timer.unref();
  heartbeats.set(token, timer);
}

/**
 * Remove a lock judged stale, but only while holding the reclaim marker
 * and only if it still carries `staleToken` (undefined: unreadable).
 */
async function reclaimStaleLock(
  lockPath: string,
  staleToken: string | undefined,
): Promise<void> {
  const markerPath = `${lockPath}.reclaim`;
  const markerToken = randomUUID();
  if (
    !(await createExclusive(
      markerPath,
      `${JSON.stringify({ token: markerToken })}\n`,
    ))
  ) {
    // Someone else is reclaiming. Clear a marker left by a crash and let
    // the next attempt start over.
    // Read the token before the age, so a marker replaced in between is
    // either seen as fresh or fails the token check.
    const staleMarker = await readToken(markerPath);
    if (await recentlyModified(markerPath, RECLAIM_STALE_MS)) {
      throw new FileLockHeldError(lockPath);
    }
    await removeIfToken(markerPath, staleMarker);
    return;
  }
  try {
    if ((await removeIfToken(lockPath, staleToken)) === "changed") {
      // Replaced since it was judged stale: it belongs to someone live.
      throw new FileLockHeldError(lockPath);
    }
  } finally {
    await removeIfToken(markerPath, markerToken);
  }
}

/**
 * Remove `filePath` only if it still carries `expectedToken`. The file is
 * moved aside first and checked there, so a replacement written after the
 * caller's check is put back instead of deleted. (Plain files cannot make
 * this fully atomic: a contender could create a new file in the instant
 * the replacement is aside. That needs a live holder to have been judged
 * dead, which only a stalled heartbeat across containers can cause.)
 */
async function removeIfToken(
  filePath: string,
  expectedToken: string | undefined,
): Promise<"removed" | "changed" | "missing"> {
  // Cheap, non-destructive check first: only a file that still looks
  // stale is ever moved.
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
  if (parseToken(raw) !== expectedToken) return "changed";
  const aside = `${filePath}.${randomUUID()}.aside`;
  try {
    await fs.rename(filePath, aside);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
  if ((await readToken(aside)) === expectedToken) {
    await fs.unlink(aside).catch(() => undefined);
    return "removed";
  }
  // Restore unless something new already took the name.
  await fs.link(aside, filePath).catch(() => undefined);
  await fs.unlink(aside).catch(() => undefined);
  return "changed";
}

async function readToken(filePath: string): Promise<string | undefined> {
  try {
    return parseToken(await fs.readFile(filePath, "utf8"));
  } catch {
    return undefined;
  }
}

function parseToken(raw: string): string | undefined {
  try {
    const parsed = JSON.parse(raw) as { token?: unknown };
    return typeof parsed.token === "string" ? parsed.token : undefined;
  } catch {
    return undefined;
  }
}

async function readLockHolder(
  lockPath: string,
): Promise<LockHolder | "missing" | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(lockPath, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? "missing"
      : undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (
      typeof parsed.pid !== "number" ||
      !Number.isInteger(parsed.pid) ||
      typeof parsed.token !== "string"
    ) {
      return undefined;
    }
    return {
      token: parsed.token,
      pid: parsed.pid,
      ...(typeof parsed.start === "string" ? { start: parsed.start } : {}),
      ...(typeof parsed.host === "string" ? { host: parsed.host } : {}),
    };
  } catch {
    return undefined;
  }
}

async function recentlyModified(
  filePath: string,
  withinMs: number,
): Promise<boolean> {
  const stat = await fs.stat(filePath).catch(() => undefined);
  return stat !== undefined && Date.now() - stat.mtimeMs < withinMs;
}

async function holderAlive(
  lockPath: string,
  holder: LockHolder,
): Promise<boolean> {
  if (holder.host !== undefined && holder.host !== os.hostname()) {
    return await recentlyModified(lockPath, LOCK_LEASE_MS);
  }
  try {
    process.kill(holder.pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  if (holder.start === undefined) return true;
  const current = processStartTime(holder.pid);
  // Unknown (for example /proc hidden): keep the conservative answer.
  return current === undefined || current === holder.start;
}

/** Field 22 of /proc/<pid>/stat on Linux; undefined elsewhere. */
export function processStartTime(pid: number): string | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // The command name (field 2) is parenthesised and may contain spaces.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const start = fields[19];
    return start && /^\d+$/u.test(start) ? start : undefined;
  } catch {
    return undefined;
  }
}
