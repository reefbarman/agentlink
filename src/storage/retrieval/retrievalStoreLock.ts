import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { sleep } from "../../util/sleep.js";

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_WAIT_MS = 20_000;
const DEFAULT_OPERATION_TIMEOUT_MS = 300_000;
const DEFAULT_STALE_MS = 10_000;
const RETRY_MS = 50;
const execFileAsync = promisify(execFile);
let bootIdentityPromise: Promise<string | undefined> | undefined;

export interface RetrievalStoreLockOptions {
  timeoutMs?: number;
  maxWaitMs?: number;
  operationTimeoutMs?: number;
  staleMs?: number;
}

export async function withRetrievalStoreLock<T>(
  root: string,
  operation: () => Promise<T>,
  options: RetrievalStoreLockOptions = {},
): Promise<T> {
  const lockDirectory = `${root}.lock`;
  const timeoutMs = positiveDuration(
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    "timeoutMs",
  );
  const maxWaitMs = positiveDuration(
    options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS,
    "maxWaitMs",
  );
  const operationTimeoutMs = positiveDuration(
    options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS,
    "operationTimeoutMs",
  );
  const hardDeadline = Date.now() + maxWaitMs;
  let progressDeadline = Date.now() + timeoutMs;
  let observedOwner: { token: string; mtimeMs: number } | undefined;
  const staleMs = positiveDuration(
    options.staleMs ?? DEFAULT_STALE_MS,
    "staleMs",
  );
  const ownerToken = randomUUID();
  const ownerPath = path.join(lockDirectory, ownerToken);
  const bootId = await getBootIdentity();

  await fs.mkdir(path.dirname(root), { recursive: true });
  while (true) {
    try {
      await fs.mkdir(lockDirectory);
      await fs.writeFile(
        ownerPath,
        `${JSON.stringify({ pid: process.pid, ...(bootId ? { bootId } : {}) })}\n`,
        { mode: 0o600 },
      );
      break;
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error;
      try {
        const owner = await staleReferenceStat(lockDirectory);
        if (
          Date.now() - owner.mtimeMs > staleMs &&
          !(await isLockOwnerAlive(owner.pid, owner.bootId, bootId))
        ) {
          await fs.rm(lockDirectory, { recursive: true, force: true });
          observedOwner = undefined;
          progressDeadline = Math.min(Date.now() + timeoutMs, hardDeadline);
          continue;
        }
        if (
          !observedOwner ||
          observedOwner.token !== owner.token ||
          observedOwner.mtimeMs !== owner.mtimeMs
        ) {
          observedOwner = owner;
          progressDeadline = Math.min(Date.now() + timeoutMs, hardDeadline);
        }
      } catch {
        // The lock disappeared between attempts.
      }
      const now = Date.now();
      if (now >= hardDeadline) {
        throw new Error("retrieval_store_lock_busy");
      }
      if (now >= progressDeadline) {
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

  let cleanedUp = false;
  const cleanup = async (): Promise<void> => {
    if (cleanedUp) return;
    cleanedUp = true;
    clearInterval(heartbeat);
    try {
      await fs.stat(ownerPath);
      await fs.rm(lockDirectory, { recursive: true, force: true });
    } catch {
      // A stale-lock recovery already replaced this owner's directory.
    }
  };
  const operationPromise = Promise.resolve().then(operation);
  let operationTimeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    operationTimeout = setTimeout(
      () => reject(new Error("retrieval_store_operation_timeout")),
      operationTimeoutMs,
    );
    operationTimeout.unref();
  });

  try {
    const result = await Promise.race([operationPromise, timeoutPromise]);
    await cleanup();
    return result;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "retrieval_store_operation_timeout"
    ) {
      void operationPromise.then(cleanup, cleanup);
      throw error;
    }
    await cleanup();
    throw error;
  } finally {
    if (operationTimeout) clearTimeout(operationTimeout);
  }
}

function positiveDuration(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite duration`);
  }
  return value;
}

async function staleReferenceStat(lockDirectory: string): Promise<{
  token: string;
  mtimeMs: number;
  pid?: number;
  bootId?: string;
}> {
  const owners = await fs.readdir(lockDirectory);
  const token = owners.sort()[0] ?? "";
  const ownerPath = token ? path.join(lockDirectory, token) : lockDirectory;
  const stat = await fs.stat(ownerPath);
  let pid: number | undefined;
  let bootId: string | undefined;
  if (token) {
    const content = (await fs.readFile(ownerPath, "utf8")).trim();
    try {
      const owner = JSON.parse(content) as { pid?: unknown; bootId?: unknown };
      if (Number.isSafeInteger(owner.pid) && Number(owner.pid) > 0) {
        pid = Number(owner.pid);
      }
      if (typeof owner.bootId === "string" && owner.bootId) {
        bootId = owner.bootId;
      }
    } catch {
      const value = Number.parseInt(content, 10);
      if (Number.isSafeInteger(value) && value > 0) pid = value;
    }
  }
  return { token, mtimeMs: stat.mtimeMs, pid, bootId };
}

async function isLockOwnerAlive(
  pid: number | undefined,
  ownerBootId: string | undefined,
  currentBootId: string | undefined,
): Promise<boolean> {
  if (pid === undefined) return false;
  if (
    ownerBootId !== undefined &&
    currentBootId !== undefined &&
    ownerBootId !== currentBootId
  ) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      String((error as { code?: unknown }).code) === "EPERM"
    );
  }
}

function getBootIdentity(): Promise<string | undefined> {
  bootIdentityPromise ??= resolveBootIdentity();
  return bootIdentityPromise;
}

async function resolveBootIdentity(): Promise<string | undefined> {
  if (process.platform === "linux") {
    try {
      return `linux:${(await fs.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim()}`;
    } catch {
      // Fall back to the portable approximation below.
    }
  }
  if (process.platform === "darwin") {
    try {
      const { stdout } = await execFileAsync("/usr/sbin/sysctl", [
        "-n",
        "kern.boottime",
      ]);
      return `darwin:${stdout.trim()}`;
    } catch {
      // Fall back to the portable approximation below.
    }
  }
  try {
    const bootTimeMinutes = Math.round(
      (Date.now() - os.uptime() * 1_000) / 60_000,
    );
    return `${process.platform}:${bootTimeMinutes}`;
  } catch {
    return undefined;
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    String((error as { code?: unknown }).code) === "EEXIST"
  );
}
