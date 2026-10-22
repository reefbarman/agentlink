import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { createHash, randomUUID } from "node:crypto";
import {
  AGENTLINK_SHARED_KEYCHAIN_SERVICE,
  createKeychainSecretStorage,
  type KeychainSecretStorageOptions,
} from "./keychainSecretStorage.js";

export const OPENAI_COMPATIBLE_API_KEY_ACCOUNT_PREFIX =
  "openai-compatible-api-key:";
// Kept only to read the old non-secret migration marker once when a current
// API key is absent. New state is stored as a private local file, not as a
// second Keychain item that asks for another macOS password.
const OPENAI_COMPATIBLE_API_KEY_STATE_ACCOUNT_PREFIX =
  "openai-compatible-api-key-state:";
const MAX_AUTH_KEY_LENGTH = 256;

type CredentialState =
  | "managed"
  | "migrated"
  | "migrated-shared-v1"
  | "deleted";

export interface SharedOpenAiCompatibleCredentialStore {
  get(authKey: string): Promise<string | undefined>;
  store(authKey: string, value: string): Promise<void>;
  delete(authKey: string): Promise<void>;
  migrateLegacyIfAbsent(
    authKey: string,
    readLegacy: () => PromiseLike<string | undefined>,
  ): Promise<boolean>;
}

export interface CreateSharedOpenAiCompatibleCredentialStoreOptions {
  keychain?: Omit<KeychainSecretStorageOptions, "account" | "service">;
  /** Private non-secret migration markers. Defaults under ~/.agentlink. */
  stateRoot?: string;
}

export function openAiCompatibleApiKeyAccount(authKey: string): string {
  return `${OPENAI_COMPATIBLE_API_KEY_ACCOUNT_PREFIX}${authKeyHash(authKey)}`;
}

function openAiCompatibleApiKeyStateAccount(authKey: string): string {
  return `${OPENAI_COMPATIBLE_API_KEY_STATE_ACCOUNT_PREFIX}${authKeyHash(authKey)}`;
}

function legacyOpenAiCompatibleApiKeyAccount(
  authKey: string,
): string | undefined {
  const normalized = authKey.trim();
  const maxLength = 200 - OPENAI_COMPATIBLE_API_KEY_ACCOUNT_PREFIX.length;
  return normalized.length <= maxLength &&
    /^[a-z0-9][a-z0-9._-]*$/u.test(normalized)
    ? `${OPENAI_COMPATIBLE_API_KEY_ACCOUNT_PREFIX}${normalized}`
    : undefined;
}

export function createSharedOpenAiCompatibleCredentialStore(
  options: CreateSharedOpenAiCompatibleCredentialStoreOptions = {},
): SharedOpenAiCompatibleCredentialStore {
  const stateRoot =
    options.stateRoot ??
    path.join(
      os.homedir(),
      ".agentlink",
      "credential-state",
      "openai-compatible",
    );
  const storageForAccount = (account: string) =>
    createKeychainSecretStorage({
      ...options.keychain,
      service: AGENTLINK_SHARED_KEYCHAIN_SERVICE,
      account,
    });
  const storageFor = (authKey: string) =>
    storageForAccount(openAiCompatibleApiKeyAccount(authKey));
  const legacyStateStorageFor = (authKey: string) =>
    storageForAccount(openAiCompatibleApiKeyStateAccount(authKey));
  const statePathFor = (authKey: string) =>
    path.join(stateRoot, `${authKeyHash(authKey)}.state`);
  const readState = async (authKey: string) =>
    await readCredentialState(statePathFor(authKey));
  const writeState = async (authKey: string, state: CredentialState) =>
    await writeCredentialState(statePathFor(authKey), state);
  // Older AgentLink surfaces only understand the Keychain marker. Keep it as
  // a write-only compatibility mirror so mixed VS Code/Desktop versions cannot
  // resurrect a deleted legacy key. New reads use the local marker first and
  // never open this second item while a current API key exists.
  const writeStateWithCompatibility = async (
    authKey: string,
    state: CredentialState,
  ) => {
    await writeState(authKey, state);
    await (await legacyStateStorageFor(authKey)).store(state);
  };

  /**
   * Old releases put a non-secret migration marker in a second Keychain item.
   * Read it only when no API key and no local marker exist, then copy it out.
   * The common existing-key path therefore needs one Keychain approval, not two.
   */
  const migrateLegacyState = async (
    authKey: string,
  ): Promise<CredentialState | undefined> => {
    const stored = await (await legacyStateStorageFor(authKey)).get();
    if (stored === undefined) return undefined;
    const oldState = stored.trim();
    if (!isCredentialState(oldState)) {
      throw new Error("agentlink_openai_compatible_credential_state_invalid");
    }
    await writeState(authKey, oldState);
    return oldState;
  };

  return {
    async get(authKey) {
      const storage = await storageFor(authKey);
      const current = (await storage.get())?.trim();
      if (current) {
        if ((await readState(authKey).catch(() => undefined)) === undefined) {
          // Best effort: the key remains usable if local non-secret state cannot
          // be written, and the old Keychain marker remains a later fallback.
          await writeState(authKey, "managed").catch(() => undefined);
        }
        return current;
      }
      if ((await readState(authKey)) !== undefined) return undefined;
      const legacyAccount = legacyOpenAiCompatibleApiKeyAccount(authKey);
      if (!legacyAccount) return undefined;
      return await storage.withMutationLock(async () => {
        const afterLock = (await storage.get())?.trim();
        if (afterLock) {
          await writeState(authKey, "managed").catch(() => undefined);
          return afterLock;
        }
        if ((await readState(authKey)) !== undefined) return undefined;
        if ((await migrateLegacyState(authKey)) !== undefined) return undefined;
        const legacy = (
          await (await storageForAccount(legacyAccount)).get()
        )?.trim();
        if (!legacy) return undefined;
        await storage.store(legacy);
        await writeStateWithCompatibility(authKey, "migrated-shared-v1");
        return legacy;
      });
    },
    async store(authKey, value) {
      const normalized = value.trim();
      if (!normalized) throw new Error("API key cannot be empty");
      const storage = await storageFor(authKey);
      await storage.withMutationLock(async () => {
        await storage.store(normalized);
        await writeStateWithCompatibility(authKey, "managed");
      });
    },
    async delete(authKey) {
      const storage = await storageFor(authKey);
      await storage.withMutationLock(async () => {
        // Persist the anti-resurrection barrier first. If this fails, keep the
        // current key rather than deleting it while a retained legacy source
        // could still be imported later.
        await writeStateWithCompatibility(authKey, "deleted");
        await storage.delete();
      });
    },
    async migrateLegacyIfAbsent(authKey, readLegacy) {
      const storage = await storageFor(authKey);
      return await storage.withMutationLock(async () => {
        if ((await readState(authKey)) !== undefined) return false;
        if ((await storage.get()) !== undefined) {
          await writeState(authKey, "managed");
          return false;
        }
        if ((await migrateLegacyState(authKey)) !== undefined) return false;
        const legacy = (await readLegacy())?.trim();
        if (!legacy) return false;
        await storage.store(legacy);
        await writeStateWithCompatibility(authKey, "migrated");
        return true;
      });
    },
  };
}

async function readCredentialState(
  statePath: string,
): Promise<CredentialState | undefined> {
  try {
    const value = (await fs.readFile(statePath, "utf-8")).trim();
    if (!isCredentialState(value)) {
      throw new Error("agentlink_openai_compatible_credential_state_invalid");
    }
    return value;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

async function writeCredentialState(
  statePath: string,
  state: CredentialState,
): Promise<void> {
  const directory = path.dirname(statePath);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = `${statePath}.tmp.${process.pid}.${randomUUID()}`;
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(temporaryPath, "wx", 0o600);
    await handle.chmod(0o600);
    await handle.writeFile(`${state}\n`, "utf-8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporaryPath, statePath);
    await fs.chmod(statePath, 0o600);
    await syncDirectory(directory);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    throw error;
  } finally {
    await fs.rm(temporaryPath, { force: true });
  }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(directory, "r");
    await handle.sync();
  } catch (error) {
    // Windows does not support opening/fsyncing directories. The marker file
    // itself was fsynced before rename, which is the strongest available path.
    if (
      process.platform !== "win32" ||
      !["EACCES", "EINVAL", "EPERM"].includes(errorCode(error) ?? "")
    ) {
      throw error;
    }
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function isCredentialState(
  value: string | undefined,
): value is CredentialState {
  return ["managed", "migrated", "migrated-shared-v1", "deleted"].includes(
    value ?? "",
  );
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function authKeyHash(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_AUTH_KEY_LENGTH) {
    throw new Error("agentlink_openai_compatible_auth_key_invalid");
  }
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}
