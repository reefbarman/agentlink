import {
  CODEX_OAUTH_CREDENTIALS_STORAGE_KEY,
  createKeychainSecretStorage,
  type CodexOAuthStateStorage,
} from "@agentlink/node-host";

/**
 * Environment variables checked, in order, for the OpenAI API key before the
 * OS credential store. They let a headless Linux server without a desktop
 * keyring use the CLI.
 */
export const OPENAI_API_KEY_ENV = [
  "AGENTLINK_OPENAI_API_KEY",
  "OPENAI_API_KEY",
] as const;

export const ENVIRONMENT_VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

export type ApiKeySource = "environment" | "credential-store";

export interface ApiKeyLookup {
  readonly value?: string;
  readonly source?: ApiKeySource;
  /** The variable that supplied the key, when `source` is `environment`. */
  readonly environmentVariable?: string;
  /** Set when the credential store could not be read at all. */
  readonly storeUnavailable?: Error;
}

/** True for a missing Linux Secret Service (no session bus or keyring). */
export function isCredentialStoreUnavailable(error: unknown): error is Error {
  return (
    error instanceof Error &&
    (error as { code?: unknown }).code === "linux_credential_store_unavailable"
  );
}

export function platformCredentialStoreName(
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "darwin") return "macOS Keychain";
  if (platform === "linux") return "your desktop keyring (Secret Service)";
  return "the OS credential store";
}

/**
 * Environment first, then the credential store. An unavailable store is
 * reported rather than thrown so status and startup keep working.
 */
export async function lookupApiKey(
  account: string,
  environmentVariables: readonly string[] = [],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ApiKeyLookup> {
  for (const name of environmentVariables) {
    const value = environment[name]?.trim();
    if (value)
      return { value, source: "environment", environmentVariable: name };
  }
  try {
    const storage = await createKeychainSecretStorage({ account });
    const value = (await storage.get())?.trim();
    return value ? { value, source: "credential-store" } : {};
  } catch (error) {
    if (isCredentialStoreUnavailable(error)) return { storeUnavailable: error };
    throw error;
  }
}

/**
 * The key a provider uses for a request. With no key in the environment and
 * no reachable store, the error names both so the fix is clear.
 */
export async function resolveApiKey(
  account: string,
  environmentVariables: readonly string[] = [],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const lookup = await lookupApiKey(account, environmentVariables, environment);
  if (lookup.value) return lookup.value;
  if (lookup.storeUnavailable) {
    throw new Error(
      `${lookup.storeUnavailable.message}${environmentHint(environmentVariables)}`,
      { cause: lookup.storeUnavailable },
    );
  }
  return undefined;
}

export async function storeApiKey(
  account: string,
  value: string,
  environmentVariables: readonly string[] = [],
): Promise<void> {
  const normalized = value.trim();
  if (!normalized) throw new Error("API key cannot be empty");
  try {
    const storage = await createKeychainSecretStorage({ account });
    await storage.store(normalized);
  } catch (error) {
    if (isCredentialStoreUnavailable(error)) {
      throw new Error(
        `${error.message}${environmentHint(environmentVariables)}`,
        { cause: error },
      );
    }
    throw error;
  }
}

/**
 * Fail before an interactive sign-in or key prompt when nothing could be
 * saved, instead of after the user has finished it.
 */
export async function assertCredentialStoreAvailable(
  account: string,
  environmentVariables: readonly string[] = [],
): Promise<void> {
  try {
    const storage = await createKeychainSecretStorage({ account });
    await storage.get();
  } catch (error) {
    if (isCredentialStoreUnavailable(error)) {
      throw new Error(
        `${error.message}${environmentHint(environmentVariables)}`,
        { cause: error },
      );
    }
    throw error;
  }
}

function environmentHint(names: readonly string[]): string {
  return names.length
    ? ` To use an API key without a credential store, set ${names.join(" or ")}.`
    : "";
}

/**
 * Codex sign-in state in the OS credential store. Without a reachable store
 * (a headless Linux server) reads find no accounts, so the CLI still starts
 * and API-key providers work; signing in reports the store error.
 */
export async function createCliCodexOAuthStorage(): Promise<CodexOAuthStateStorage> {
  const storage = await createKeychainSecretStorage({
    account: CODEX_OAUTH_CREDENTIALS_STORAGE_KEY,
  });
  return {
    get: async () => {
      try {
        return await storage.get();
      } catch (error) {
        if (isCredentialStoreUnavailable(error)) return undefined;
        throw error;
      }
    },
    store: (value) => storage.store(value),
    delete: () => storage.delete(),
    withMutationLock: (operation) => storage.withMutationLock(operation),
  };
}
