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

/**
 * AgentLink's Linux store when the caller doesn't choose one. The native
 * library's own default silently falls back to the kernel keyring, which
 * loses credentials on reboot, so AgentLink always asks for Secret Service.
 */
export const DEFAULT_KEYCHAIN_LINUX_STORE: KeychainLinuxStore =
  "secret-service";

export type LinuxCredentialStoreUnavailableReason =
  | "no_session_bus"
  | "secret_service_unavailable";

/**
 * Linux has no reachable Secret Service, typically a headless machine or SSH
 * session without a desktop keyring. AgentLink never falls back to plaintext
 * or to the reboot-volatile kernel keyring.
 */
export class LinuxCredentialStoreUnavailableError extends Error {
  readonly code = "linux_credential_store_unavailable";

  constructor(
    readonly reason: LinuxCredentialStoreUnavailableReason,
    options?: ErrorOptions,
  ) {
    super(
      reason === "no_session_bus"
        ? "No D-Bus session is available, so AgentLink cannot reach a Secret Service credential store (such as GNOME Keyring or KWallet). Sign in to a desktop session, or start a session bus and keyring for this user. AgentLink does not store credentials in plain text."
        : "No Secret Service credential store (such as GNOME Keyring or KWallet) is running or unlocked for this user. Start and unlock one, then retry. AgentLink does not store credentials in plain text.",
      options,
    );
    this.name = "LinuxCredentialStoreUnavailableError";
  }
}

export interface KeychainSecretStorageOptions {
  service?: string;
  account: string;
  /**
   * The Linux credential store to require. Defaults to
   * `DEFAULT_KEYCHAIN_LINUX_STORE` (Secret Service). An unavailable store
   * fails with `LinuxCredentialStoreUnavailableError` instead of falling
   * back. Pass `"keyutils"` to opt into the kernel keyring, which does not
   * survive a reboot. Ignored on other platforms.
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
  const linuxStore =
    process.platform === "linux"
      ? (options.linuxStore ?? DEFAULT_KEYCHAIN_LINUX_STORE)
      : options.linuxStore;
  const createEntry = (): KeychainEntry =>
    linuxStore
      ? new AsyncEntry(service, account, { linux: { store: linuxStore } })
      : new AsyncEntry(service, account);
  // On Linux the constructor already connects to D-Bus, so Secret Service
  // entries are created lazily inside the diagnostics wrapper.
  const nativeEntry: KeychainEntry =
    process.platform === "linux" && linuxStore === "secret-service"
      ? withSecretServiceDiagnostics(createEntry)
      : createEntry();
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

/**
 * Report a missing Secret Service as one typed, actionable error. Without a
 * session bus the native call can only fail, so skip it. Other native errors
 * that name the Secret Service or D-Bus, including ones thrown while creating
 * the entry, are wrapped with their cause kept.
 */
function withSecretServiceDiagnostics(
  createEntry: () => KeychainEntry,
): KeychainEntry {
  let entry: KeychainEntry | undefined;
  const run = async <T>(
    operation: (entry: KeychainEntry) => Promise<T>,
  ): Promise<T> => {
    if (!(await hasSessionBus())) {
      throw new LinuxCredentialStoreUnavailableError("no_session_bus");
    }
    try {
      entry ??= createEntry();
      return await operation(entry);
    } catch (error) {
      if (isSecretServiceUnavailable(error)) {
        throw new LinuxCredentialStoreUnavailableError(
          "secret_service_unavailable",
          { cause: error },
        );
      }
      throw error;
    }
  };
  return {
    getPassword: () => run((current) => current.getPassword()),
    setPassword: (value) => run((current) => current.setPassword(value)),
    deletePassword: () => run((current) => current.deletePassword()),
  };
}

async function hasSessionBus(): Promise<boolean> {
  if (process.env.DBUS_SESSION_BUS_ADDRESS?.trim()) return true;
  const runtimeDirectory =
    process.env.XDG_RUNTIME_DIR?.trim() ||
    (typeof process.getuid === "function"
      ? `/run/user/${process.getuid()}`
      : undefined);
  if (!runtimeDirectory) return false;
  try {
    return (await fs.stat(path.join(runtimeDirectory, "bus"))).isSocket();
  } catch {
    return false;
  }
}

const SECRET_SERVICE_UNAVAILABLE_PATTERN =
  /org\.freedesktop\.(secrets|DBus\.Error)|ServiceUnknown|secret service|D-?Bus|Couldn't access platform secure storage/i;

function isSecretServiceUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return SECRET_SERVICE_UNAVAILABLE_PATTERN.test(message);
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
