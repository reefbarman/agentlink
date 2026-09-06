import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { randomUUID } from "node:crypto";

export const AGENTLINK_SHARED_KEYCHAIN_SERVICE =
  "com.agentlink.shared-credentials.v1";

export interface KeychainSecretStorageOptions {
  service?: string;
  account: string;
  lockRoot?: string;
  lockTimeoutMs?: number;
  staleLockMs?: number;
  retryDelayMs?: number;
}

export interface KeychainSecretStorage {
  get(): Promise<string | undefined>;
  store(value: string): Promise<void>;
  delete(): Promise<void>;
  withMutationLock<T>(operation: () => Promise<T>): Promise<T>;
}

export async function createKeychainSecretStorage(
  options: KeychainSecretStorageOptions,
): Promise<KeychainSecretStorage> {
  const service = options.service ?? AGENTLINK_SHARED_KEYCHAIN_SERVICE;
  const account = requireSegment(options.account, "account");
  const { AsyncEntry } = await import("@napi-rs/keyring");
  const entry = new AsyncEntry(service, account);
  const lockRoot =
    options.lockRoot ??
    path.join(os.homedir(), ".agentlink", "credential-locks");
  const storageStem = `${safeLockSegment(service)}--${safeLockSegment(account)}`;
  const lockPath = path.join(lockRoot, `${storageStem}.lock`);
  const revisionPath = path.join(lockRoot, `${storageStem}.revision`);
  let cacheInitialized = false;
  let cachedValue: string | undefined;
  let cachedRevision: string | null = null;

  return {
    async get() {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const revisionBefore = await readRevision(revisionPath);
        if (
          cacheInitialized &&
          revisionBefore === cachedRevision &&
          !isPendingRevision(revisionBefore)
        ) {
          return cachedValue;
        }

        const value = await entry.getPassword();
        const revisionAfter = await readRevision(revisionPath);
        if (revisionBefore !== revisionAfter) continue;
        if (!isPendingRevision(revisionAfter)) {
          cacheInitialized = true;
          cachedValue = value;
          cachedRevision = revisionAfter;
        }
        return value;
      }
      return await entry.getPassword();
    },
    async store(value) {
      const revision = randomUUID();
      await writeRevision(revisionPath, `${revision}:pending`);
      try {
        await entry.setPassword(value);
      } catch (error) {
        await writeRevision(revisionPath, `${revision}:failed`);
        throw error;
      }
      await writeRevision(revisionPath, revision);
      cacheInitialized = true;
      cachedValue = value;
      cachedRevision = revision;
    },
    async delete() {
      const revision = randomUUID();
      await writeRevision(revisionPath, `${revision}:pending`);
      try {
        await entry.deletePassword();
      } catch (error) {
        await writeRevision(revisionPath, `${revision}:failed`);
        throw error;
      }
      await writeRevision(revisionPath, revision);
      cacheInitialized = true;
      cachedValue = undefined;
      cachedRevision = revision;
    },
    async withMutationLock(operation) {
      return await withDirectoryLock(lockPath, operation, options);
    },
  };
}

async function readRevision(revisionPath: string): Promise<string | null> {
  try {
    return (await fs.readFile(revisionPath, "utf-8")).trim() || null;
  } catch (error) {
    if (isMissingError(error)) return null;
    throw error;
  }
}

async function writeRevision(
  revisionPath: string,
  revision: string,
): Promise<void> {
  await fs.mkdir(path.dirname(revisionPath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${revisionPath}.tmp.${process.pid}.${randomUUID()}`;
  try {
    await fs.writeFile(temporaryPath, revision, {
      encoding: "utf-8",
      mode: 0o600,
    });
    await fs.rename(temporaryPath, revisionPath);
  } finally {
    await fs.rm(temporaryPath, { force: true });
  }
}

function isPendingRevision(revision: string | null): boolean {
  return revision?.endsWith(":pending") === true;
}

function requireSegment(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 200) {
    throw new Error(`invalid_keychain_${label}`);
  }
  return normalized;
}

function safeLockSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 200);
}

async function withDirectoryLock<T>(
  lockPath: string,
  operation: () => Promise<T>,
  options: KeychainSecretStorageOptions,
): Promise<T> {
  const lockTimeoutMs = options.lockTimeoutMs ?? 60_000;
  const staleLockMs = options.staleLockMs ?? 5 * 60_000;
  const retryDelayMs = options.retryDelayMs ?? 50;
  const deadline = Date.now() + lockTimeoutMs;
  await fs.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const ownerToken = `${process.pid}:${randomUUID()}`;
  const ownerPath = path.join(lockPath, "owner");

  while (true) {
    try {
      await fs.mkdir(lockPath, { mode: 0o700 });
      await fs.writeFile(ownerPath, ownerToken, {
        encoding: "utf-8",
        mode: 0o600,
      });
      break;
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error;
      try {
        const stats = await fs.stat(lockPath);
        if (Date.now() - stats.mtimeMs > staleLockMs) {
          await fs.rm(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch (statError) {
        if (!isMissingError(statError)) throw statError;
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error("agentlink_keychain_mutation_lock_timeout");
      }
      await sleep(retryDelayMs);
    }
  }

  try {
    return await operation();
  } finally {
    const currentOwner = await fs
      .readFile(ownerPath, "utf-8")
      .catch(() => null);
    if (currentOwner === ownerToken) {
      await fs.rm(lockPath, { recursive: true, force: true });
    }
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return errorCode(error) === "EEXIST";
}

function isMissingError(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function sleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}
