import { createHash } from "node:crypto";

import {
  AGENTLINK_SHARED_KEYCHAIN_SERVICE,
  createKeychainSecretStorage,
  type KeychainSecretStorageOptions,
} from "./keychainSecretStorage.js";

export const OPENAI_COMPATIBLE_API_KEY_ACCOUNT_PREFIX =
  "openai-compatible-api-key:";
const OPENAI_COMPATIBLE_API_KEY_STATE_ACCOUNT_PREFIX =
  "openai-compatible-api-key-state:";
const MAX_AUTH_KEY_LENGTH = 256;

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
  const storageForAccount = (account: string) =>
    createKeychainSecretStorage({
      ...options.keychain,
      service: AGENTLINK_SHARED_KEYCHAIN_SERVICE,
      account,
    });
  const storageFor = (authKey: string) =>
    storageForAccount(openAiCompatibleApiKeyAccount(authKey));
  const stateStorageFor = (authKey: string) =>
    storageForAccount(openAiCompatibleApiKeyStateAccount(authKey));

  return {
    async get(authKey) {
      const storage = await storageFor(authKey);
      const current = (await storage.get())?.trim();
      if (current) return current;
      const stateStorage = await stateStorageFor(authKey);
      if ((await stateStorage.get()) !== undefined) return undefined;
      const legacyAccount = legacyOpenAiCompatibleApiKeyAccount(authKey);
      if (!legacyAccount) return undefined;
      return await storage.withMutationLock(async () => {
        const afterLock = (await storage.get())?.trim();
        if (afterLock) return afterLock;
        if ((await stateStorage.get()) !== undefined) return undefined;
        const legacy = (
          await (await storageForAccount(legacyAccount)).get()
        )?.trim();
        if (!legacy) return undefined;
        await storage.store(legacy);
        await stateStorage.store("migrated-shared-v1");
        return legacy;
      });
    },
    async store(authKey, value) {
      const normalized = value.trim();
      if (!normalized) throw new Error("API key cannot be empty");
      const storage = await storageFor(authKey);
      await storage.withMutationLock(async () => {
        await storage.store(normalized);
        await (await stateStorageFor(authKey)).store("managed");
      });
    },
    async delete(authKey) {
      const storage = await storageFor(authKey);
      await storage.withMutationLock(async () => {
        await storage.delete();
        await (await stateStorageFor(authKey)).store("deleted");
      });
    },
    async migrateLegacyIfAbsent(authKey, readLegacy) {
      const storage = await storageFor(authKey);
      return await storage.withMutationLock(async () => {
        const stateStorage = await stateStorageFor(authKey);
        if ((await stateStorage.get()) !== undefined) return false;
        if ((await storage.get()) !== undefined) {
          await stateStorage.store("managed");
          return false;
        }
        const legacy = (await readLegacy())?.trim();
        if (!legacy) return false;
        await storage.store(legacy);
        await stateStorage.store("migrated");
        return true;
      });
    },
  };
}

function authKeyHash(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_AUTH_KEY_LENGTH) {
    throw new Error("agentlink_openai_compatible_auth_key_invalid");
  }
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}
