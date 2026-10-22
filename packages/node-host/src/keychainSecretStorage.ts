import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  CredentialsHelperUnavailableError,
  createCredentialsHelperEntry,
  describeSharedCredential,
  resolveCredentialsHelperPath,
} from "./credentialsHelperClient.js";

import { randomUUID } from "node:crypto";

export const AGENTLINK_SHARED_KEYCHAIN_SERVICE =
  "com.agentlink.shared-credentials.v1";

/** Linux credential stores supported by `@napi-rs/keyring`. */
export type KeychainLinuxStore = "secret-service" | "keyutils";

export interface KeychainSecretStorageOptions {
  service?: string;
  account: string;
  /**
   * Require a specific Linux credential store. When omitted, the native
   * library's default applies: Secret Service, silently falling back to the
   * kernel keyring, which does not survive a reboot. When set, an unavailable
   * store fails instead of falling back. Ignored on other platforms.
   */
  linuxStore?: KeychainLinuxStore;
  /**
   * macOS: the "AgentLink Credentials" helper to use. Defaults to the
   * process-wide path from `setCredentialsHelperPath` or the
   * AGENTLINK_CREDENTIALS_HELPER environment variable. Null forces direct
   * Keychain access.
   */
  credentialsHelperPath?: string | null;
  /** Keychain label shown in macOS prompts; derived from the account if omitted. */
  label?: string;
  lockRoot?: string;
  lockTimeoutMs?: number;
  staleLockMs?: number;
  retryDelayMs?: number;
}

export interface KeychainSecretStorage {
  get(): Promise<string | undefined>;
  store(value: string): Promise<void>;
  delete(): Promise<void>;
  /** Non-secret revision used to detect writes from another host process. */
  getRevision(): Promise<string | null>;
  withMutationLock<T>(operation: () => Promise<T>): Promise<T>;
}

export async function createKeychainSecretStorage(
  options: KeychainSecretStorageOptions,
): Promise<KeychainSecretStorage> {
  const service = options.service ?? AGENTLINK_SHARED_KEYCHAIN_SERVICE;
  const account = requireSegment(options.account, "account");
  const { AsyncEntry } = await import("@napi-rs/keyring");
  const nativeEntry = options.linuxStore
    ? new AsyncEntry(service, account, {
        linux: { store: options.linuxStore },
      })
    : new AsyncEntry(service, account);
  const helperPath =
    options.credentialsHelperPath === null
      ? undefined
      : (options.credentialsHelperPath ?? resolveCredentialsHelperPath());
  const lockRoot =
    options.lockRoot ??
    path.join(os.homedir(), ".agentlink", "credential-locks");
  const helperEntry = helperPath
    ? serializeHelperAccess(
        createCredentialsHelperEntry({
          helperPath,
          service,
          account,
          label: options.label ?? describeSharedCredential(account),
        }),
        path.join(lockRoot, "credentials-helper.lock"),
        options,
      )
    : undefined;
  const entry: KeychainEntry = helperEntry
    ? withDirectFallback(helperEntry, nativeEntry)
    : nativeEntry;
  const storageStem = `${safeLockSegment(service)}--${safeLockSegment(account)}`;
  const lockPath = path.join(lockRoot, `${storageStem}.lock`);
  const revisionPath = path.join(lockRoot, `${storageStem}.revision`);
  let cacheInitialized = false;
  let cachedValue: string | undefined;
  let cachedRevision: string | null = null;
  // @napi-rs/keyring 2.1+ reports a missing entry as null; earlier versions
  // used undefined. Normalize so callers only ever see undefined.
  const readPassword = async (): Promise<string | undefined> =>
    (await entry.getPassword()) ?? undefined;

  const storage: KeychainSecretStorage = {
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

        const value = await readPassword();
        const revisionAfter = await readRevision(revisionPath);
        if (revisionBefore !== revisionAfter) continue;
        if (!isPendingRevision(revisionAfter)) {
          cacheInitialized = true;
          cachedValue = value;
          cachedRevision = revisionAfter;
        }
        return value;
      }
      return await readPassword();
    },
    async store(value) {
      // On macOS a rewrite resets the item's trusted-team list to the
      // writer's team, so the other surfaces (VS Code is signed by Microsoft,
      // the CLI and Desktop by AgentLink) must ask for Keychain access again.
      // Skip writes that would not change the stored value.
      if ((await storage.get()) === value) return;
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
    async getRevision() {
      return await readRevision(revisionPath);
    },
    async withMutationLock(operation) {
      return await withDirectoryLock(lockPath, operation, options);
    },
  };
  return storage;
}

interface KeychainEntry {
  getPassword(): Promise<string | null | undefined>;
  setPassword(value: string): Promise<void>;
  deletePassword(): Promise<unknown>;
}

/**
 * Startup has several independent credential consumers, and multiple VS Code
 * windows add more. Without one queue, they can all ask the helper before the
 * first "Always Allow" updates an old item's ACL, leaving macOS with a stack
 * of already-queued prompts. Serialize every helper request across accounts,
 * consumers and processes. Direct Keychain access keeps its previous behaviour.
 */
function serializeHelperAccess(
  helper: KeychainEntry,
  lockPath: string,
  options: KeychainSecretStorageOptions,
): KeychainEntry {
  const run = <T>(operation: () => Promise<T>): Promise<T> =>
    withFileLock(lockPath, operation, {
      ...options,
      // A prompt can legitimately wait for the user. Other consumers should
      // keep waiting rather than time out and start independent requests.
      lockTimeoutMs: Math.max(options.lockTimeoutMs ?? 0, 5 * 60_000),
    });
  return {
    getPassword: () => run(() => helper.getPassword()),
    setPassword: (value) => run(() => helper.setPassword(value)),
    deletePassword: () => run(() => helper.deletePassword()),
  };
}

/**
 * Use the helper, but switch to direct Keychain access for good when it is
 * unavailable (missing, unrunnable, or this program is not an allowed
 * caller), which is the behaviour before the helper existed. Keychain errors
 * such as a denied prompt are not retried directly, to avoid a second prompt.
 */
function withDirectFallback(
  helper: KeychainEntry,
  direct: KeychainEntry,
): KeychainEntry {
  let active = helper;
  const run = async <T>(
    operation: (entry: KeychainEntry) => Promise<T>,
  ): Promise<T> => {
    try {
      return await operation(active);
    } catch (error) {
      if (
        active === direct ||
        !(error instanceof CredentialsHelperUnavailableError)
      )
        throw error;
      active = direct;
      return await operation(direct);
    }
  };
  return {
    getPassword: () => run((entry) => entry.getPassword()),
    setPassword: (value) => run((entry) => entry.setPassword(value)),
    deletePassword: () => run((entry) => entry.deletePassword()),
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

/** Atomically publish the helper queue as one owner-bearing file. */
async function withFileLock<T>(
  lockPath: string,
  operation: () => Promise<T>,
  options: KeychainSecretStorageOptions,
): Promise<T> {
  const lockTimeoutMs = options.lockTimeoutMs ?? 60_000;
  const retryDelayMs = options.retryDelayMs ?? 50;
  const deadline = Date.now() + lockTimeoutMs;
  await fs.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const ownerToken = `${process.pid}:${randomUUID()}`;
  let handle: fs.FileHandle;
  while (true) {
    try {
      const candidate = await fs.open(lockPath, "wx", 0o600);
      try {
        await candidate.writeFile(ownerToken, "utf-8");
      } catch (error) {
        await candidate.close();
        await fs.rm(lockPath, { force: true });
        throw error;
      }
      handle = candidate;
      break;
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error;
      if (Date.now() >= deadline) {
        throw new Error("agentlink_keychain_helper_lock_timeout");
      }
      await sleep(retryDelayMs);
    }
  }
  try {
    return await operation();
  } finally {
    await handle.close();
    const currentOwner = await fs.readFile(lockPath, "utf-8").catch(() => null);
    if (currentOwner === ownerToken) await fs.rm(lockPath, { force: true });
  }
}

async function withDirectoryLock<T>(
  lockPath: string,
  operation: () => Promise<T>,
  options: KeychainSecretStorageOptions,
): Promise<T> {
  const lockTimeoutMs = options.lockTimeoutMs ?? 60_000;

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
