import { getOpenAiCompatibleSecretKey } from "./openAiCompatibleSecrets.js";

export const OPENAI_COMPATIBLE_KEY_INDEX_STATE =
  "openaiCompatible.authKeyNames.v1";

export interface OpenAiCompatibleSecretStore {
  get(key: string): Thenable<string | undefined>;
  store(key: string, value: string): Thenable<void>;
  delete(key: string): Thenable<void>;
}

export interface OpenAiCompatibleKeyNameState {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<void>;
}

export interface OpenAiCompatibleCredentialServiceDependencies {
  secrets: OpenAiCompatibleSecretStore;
  state: OpenAiCompatibleKeyNameState;
  getConfiguredApiKeyNames(): readonly string[];
}

export interface OpenAiCompatibleCredentialStatus {
  apiKeyName: string;
  status: "stored" | "missing";
}

/**
 * In-process handle for a secret retained only in memory. The handle cannot be
 * serialized or reconstructed; keep the original object for later operations.
 */
export interface StagedOpenAiCompatibleCredential {
  readonly apiKeyName: string;
}

/**
 * In-process, single-use rollback receipt. It is consumed by the first
 * deleteCredentialIfUnchanged call, including when a replacement is detected.
 */
export interface StoredOpenAiCompatibleCredential {
  readonly apiKeyName: string;
}

export type StoreStagedOpenAiCompatibleCredentialResult =
  | {
      status: "stored";
      credential: StoredOpenAiCompatibleCredential;
    }
  | { status: "already_stored" };

const stagedCredentialValues = new WeakMap<
  StagedOpenAiCompatibleCredential,
  string
>();
const storedCredentialValues = new WeakMap<
  StoredOpenAiCompatibleCredential,
  string
>();

// Shared by every service instance so commands and the wizard cannot lose an
// index update when each composes its own service around the same global state.
let indexMutationQueue: Promise<void> = Promise.resolve();
const secretMutationQueues = new Map<string, Promise<void>>();

function settledMutation<T>(result: Promise<T>): Promise<void> {
  return result.then(
    () => undefined,
    () => undefined,
  );
}

function serializeIndexMutation<T>(mutation: () => Promise<T>): Promise<T> {
  const result = indexMutationQueue.then(mutation, mutation);
  indexMutationQueue = settledMutation(result);
  return result;
}

function serializeSecretMutation<T>(
  apiKeyName: string,
  mutation: () => Promise<T>,
): Promise<T> {
  const currentQueue =
    secretMutationQueues.get(apiKeyName) ?? Promise.resolve();
  const result = currentQueue.then(mutation, mutation);
  const settled = settledMutation(result);
  secretMutationQueues.set(apiKeyName, settled);
  void settled.finally(() => {
    if (secretMutationQueues.get(apiKeyName) === settled) {
      secretMutationQueues.delete(apiKeyName);
    }
  });
  return result;
}

export function normalizeOpenAiCompatibleApiKeyName(
  value: string,
): string | undefined {
  const normalized = value.trim();
  return /^[a-z0-9][a-z0-9._-]*$/.test(normalized) ? normalized : undefined;
}

export function isValidOpenAiCompatibleApiKeyName(value: string): boolean {
  return normalizeOpenAiCompatibleApiKeyName(value) === value;
}

function requireApiKeyName(value: string): string {
  const normalized = normalizeOpenAiCompatibleApiKeyName(value);
  if (!normalized) {
    throw new Error(
      "API key name must use lowercase letters, digits, dots, underscores, or hyphens.",
    );
  }
  return normalized;
}

function requireApiKeyValue(value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error("API key cannot be empty.");
  return normalized;
}

function readIndexedApiKeyNames(state: OpenAiCompatibleKeyNameState): string[] {
  const stored = state.get<unknown>(OPENAI_COMPATIBLE_KEY_INDEX_STATE, []);
  if (!Array.isArray(stored)) return [];
  return stored.flatMap((value) =>
    typeof value === "string" && isValidOpenAiCompatibleApiKeyName(value)
      ? [value]
      : [],
  );
}

export class OpenAiCompatibleCredentialService {
  constructor(
    private readonly dependencies: OpenAiCompatibleCredentialServiceDependencies,
  ) {}

  getApiKeyNames(): string[] {
    return [
      ...new Set([
        ...this.dependencies.getConfiguredApiKeyNames().flatMap((value) => {
          const normalized = normalizeOpenAiCompatibleApiKeyName(value);
          return normalized ? [normalized] : [];
        }),
        ...readIndexedApiKeyNames(this.dependencies.state),
      ]),
    ].sort((left, right) => left.localeCompare(right));
  }

  async getCredentialValue(apiKeyName: string): Promise<string | undefined> {
    const normalized = requireApiKeyName(apiKeyName);
    const stored = await this.dependencies.secrets.get(
      getOpenAiCompatibleSecretKey(normalized),
    );
    return stored?.trim() || undefined;
  }

  async getCredentialStatus(
    apiKeyName: string,
  ): Promise<OpenAiCompatibleCredentialStatus> {
    const normalized = requireApiKeyName(apiKeyName);
    const stored = await this.getCredentialValue(normalized);
    return {
      apiKeyName: normalized,
      status: stored === undefined ? "missing" : "stored",
    };
  }

  async getCredentialStatuses(): Promise<OpenAiCompatibleCredentialStatus[]> {
    return Promise.all(
      this.getApiKeyNames().map((apiKeyName) =>
        this.getCredentialStatus(apiKeyName),
      ),
    );
  }

  stageCredential(
    apiKeyName: string,
    value: string,
  ): StagedOpenAiCompatibleCredential {
    const staged = Object.freeze({
      apiKeyName: requireApiKeyName(apiKeyName),
    });
    stagedCredentialValues.set(staged, requireApiKeyValue(value));
    return staged;
  }

  getStagedCredentialValue(
    credential: StagedOpenAiCompatibleCredential,
  ): string {
    const value = stagedCredentialValues.get(credential);
    if (value === undefined) throw new Error("Unknown staged API key.");
    return value;
  }

  async storeCredential(apiKeyName: string, value: string): Promise<void> {
    const normalizedName = requireApiKeyName(apiKeyName);
    const normalizedValue = requireApiKeyValue(value);
    await serializeSecretMutation(normalizedName, async () => {
      await this.dependencies.secrets.store(
        getOpenAiCompatibleSecretKey(normalizedName),
        normalizedValue,
      );
    });
  }

  async deleteCredential(apiKeyName: string): Promise<void> {
    const normalizedName = requireApiKeyName(apiKeyName);
    await serializeSecretMutation(normalizedName, async () => {
      await this.dependencies.secrets.delete(
        getOpenAiCompatibleSecretKey(normalizedName),
      );
    });
  }

  async storeStagedCredentialIfMissing(
    staged: StagedOpenAiCompatibleCredential,
  ): Promise<StoreStagedOpenAiCompatibleCredentialResult> {
    const value = this.getStagedCredentialValue(staged);
    return serializeSecretMutation(staged.apiKeyName, async () => {
      const secretKey = getOpenAiCompatibleSecretKey(staged.apiKeyName);
      if ((await this.dependencies.secrets.get(secretKey)) !== undefined) {
        return { status: "already_stored" };
      }
      await this.dependencies.secrets.store(secretKey, value);
      const credential = Object.freeze({ apiKeyName: staged.apiKeyName });
      storedCredentialValues.set(credential, value);
      return { status: "stored", credential };
    });
  }

  async deleteCredentialIfUnchanged(
    credential: StoredOpenAiCompatibleCredential,
  ): Promise<boolean> {
    return serializeSecretMutation(credential.apiKeyName, async () => {
      const expectedValue = storedCredentialValues.get(credential);
      if (expectedValue === undefined) {
        throw new Error("Unknown or already used stored API key receipt.");
      }
      storedCredentialValues.delete(credential);
      const secretKey = getOpenAiCompatibleSecretKey(credential.apiKeyName);
      if ((await this.dependencies.secrets.get(secretKey)) !== expectedValue) {
        return false;
      }
      await this.dependencies.secrets.delete(secretKey);
      return true;
    });
  }

  async setCredentialIndexed(
    apiKeyName: string,
    present: boolean,
  ): Promise<void> {
    const normalizedName = requireApiKeyName(apiKeyName);
    await serializeIndexMutation(async () => {
      const names = new Set(readIndexedApiKeyNames(this.dependencies.state));
      if (present) names.add(normalizedName);
      else names.delete(normalizedName);
      await this.dependencies.state.update(
        OPENAI_COMPATIBLE_KEY_INDEX_STATE,
        [...names].sort((left, right) => left.localeCompare(right)),
      );
    });
  }
}
