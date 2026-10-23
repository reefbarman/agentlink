import {
  OPENAI_API_KEY_ACCOUNT,
  apiKeyEnvironmentVariables,
  compatibleCredentialAccount,
  parseCliConfig,
  setApiKey,
} from "./config.js";
import {
  OPENAI_API_KEY_ENV,
  assertCredentialStoreAvailable,
  createCliCodexOAuthStorage,
  lookupApiKey,
  resolveApiKey,
} from "./credentials.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const keychain = vi.hoisted(() => ({
  values: new Map<string, string>(),
  unavailable: false,
  stores: [] as Array<[string, string]>,
}));

vi.mock("@agentlink/node-host", () => {
  const unavailable = () =>
    Object.assign(new Error("No D-Bus session is available."), {
      code: "linux_credential_store_unavailable",
    });
  return {
    AGENTLINK_SHARED_KEYCHAIN_SERVICE: "AgentLink",
    CODEX_OAUTH_CREDENTIALS_STORAGE_KEY: "codex-oauth",
    createKeychainSecretStorage: async ({ account }: { account: string }) => ({
      get: async () => {
        if (keychain.unavailable) throw unavailable();
        return keychain.values.get(account);
      },
      store: async (value: string) => {
        if (keychain.unavailable) throw unavailable();
        keychain.stores.push([account, value]);
        keychain.values.set(account, value);
      },
      delete: async () => {
        keychain.values.delete(account);
      },
      getRevision: async () => null,
      withMutationLock: async <T>(operation: () => Promise<T>) =>
        await operation(),
    }),
  };
});

beforeEach(() => {
  keychain.values.clear();
  keychain.stores.length = 0;
  keychain.unavailable = false;
});

describe("CLI API keys", () => {
  it("prefers AGENTLINK_OPENAI_API_KEY, then OPENAI_API_KEY, then the store", async () => {
    keychain.values.set(OPENAI_API_KEY_ACCOUNT, "stored");
    expect(
      await lookupApiKey(OPENAI_API_KEY_ACCOUNT, OPENAI_API_KEY_ENV, {
        AGENTLINK_OPENAI_API_KEY: " agentlink ",
        OPENAI_API_KEY: "generic",
      }),
    ).toEqual({
      value: "agentlink",
      source: "environment",
      environmentVariable: "AGENTLINK_OPENAI_API_KEY",
    });
    expect(
      await lookupApiKey(OPENAI_API_KEY_ACCOUNT, OPENAI_API_KEY_ENV, {
        OPENAI_API_KEY: "generic",
      }),
    ).toMatchObject({
      value: "generic",
      environmentVariable: "OPENAI_API_KEY",
    });
    expect(
      await lookupApiKey(OPENAI_API_KEY_ACCOUNT, OPENAI_API_KEY_ENV, {}),
    ).toEqual({ value: "stored", source: "credential-store" });
  });

  it("works on a headless host with only an environment key", async () => {
    keychain.unavailable = true;
    expect(
      await resolveApiKey(OPENAI_API_KEY_ACCOUNT, OPENAI_API_KEY_ENV, {
        OPENAI_API_KEY: "from-env",
      }),
    ).toBe("from-env");
    const lookup = await lookupApiKey(
      OPENAI_API_KEY_ACCOUNT,
      OPENAI_API_KEY_ENV,
      {},
    );
    expect(lookup.value).toBeUndefined();
    expect(lookup.storeUnavailable?.message).toContain("D-Bus");
    await expect(
      resolveApiKey(OPENAI_API_KEY_ACCOUNT, OPENAI_API_KEY_ENV, {}),
    ).rejects.toThrow(/D-Bus.*set AGENTLINK_OPENAI_API_KEY or OPENAI_API_KEY/u);
  });

  it("explains the environment option when a key cannot be stored", async () => {
    keychain.unavailable = true;
    await expect(setApiKey(OPENAI_API_KEY_ACCOUNT, "secret")).rejects.toThrow(
      /set AGENTLINK_OPENAI_API_KEY or OPENAI_API_KEY/u,
    );
    // Checked before prompting, so nobody types a key that cannot be saved.
    await expect(
      assertCredentialStoreAvailable(
        OPENAI_API_KEY_ACCOUNT,
        OPENAI_API_KEY_ENV,
      ),
    ).rejects.toThrow(/D-Bus.*set AGENTLINK_OPENAI_API_KEY/u);
    keychain.unavailable = false;
    await expect(
      assertCredentialStoreAvailable(OPENAI_API_KEY_ACCOUNT),
    ).resolves.toBeUndefined();
  });

  it("reads a compatible provider's key from its configured apiKeyEnv", async () => {
    const config = parseCliConfig({
      schemaVersion: 1,
      defaultModel: { providerId: "codex", modelId: "gpt-5.6-sol" },
      openAiModels: [],
      codexModels: [],
      compatibleProviders: [
        {
          id: "openrouter",
          baseURL: "https://openrouter.ai/api/v1",
          apiKeyEnv: "OPENROUTER_API_KEY",
          models: [{ id: "m", contextWindow: 100, maxOutputTokens: 10 }],
        },
      ],
    });
    const account = compatibleCredentialAccount(config.compatibleProviders[0]!);
    expect(apiKeyEnvironmentVariables(account, config)).toEqual([
      "OPENROUTER_API_KEY",
    ]);
    expect(apiKeyEnvironmentVariables("unknown", config)).toEqual([]);
    expect(() =>
      parseCliConfig({
        ...config,
        compatibleProviders: [
          { ...config.compatibleProviders[0], apiKeyEnv: "NOT VALID" },
        ],
      }),
    ).toThrow("apiKeyEnv must be an environment variable name");
  });
});

describe("Codex sign-in storage", () => {
  it("reads as signed out without a credential store but still reports writes", async () => {
    keychain.unavailable = true;
    const storage = await createCliCodexOAuthStorage();
    await expect(storage.get()).resolves.toBeUndefined();
    await expect(storage.store("state")).rejects.toThrow("D-Bus");
  });

  it("passes through to the store when it is available", async () => {
    const storage = await createCliCodexOAuthStorage();
    await storage.store("state");
    await expect(storage.get()).resolves.toBe("state");
    expect(keychain.stores).toEqual([["codex-oauth", "state"]]);
  });
});
