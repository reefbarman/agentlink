import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSharedOpenAiCompatibleCredentialStore,
  openAiCompatibleApiKeyAccount,
} from "./sharedOpenAiCompatibleCredentials.js";

import { AGENTLINK_SHARED_KEYCHAIN_SERVICE } from "./keychainSecretStorage.js";

const values = new Map<string, string>();
const entries: Array<{ service: string; account: string }> = [];
const roots: string[] = [];

vi.mock("@napi-rs/keyring", () => ({
  AsyncEntry: class {
    constructor(
      private readonly service: string,
      private readonly account: string,
    ) {
      entries.push({ service, account });
    }

    async getPassword(): Promise<string | undefined> {
      return values.get(`${this.service}:${this.account}`);
    }

    async setPassword(value: string): Promise<void> {
      values.set(`${this.service}:${this.account}`, value);
    }

    async deletePassword(): Promise<boolean> {
      return values.delete(`${this.service}:${this.account}`);
    }
  },
}));

afterEach(async () => {
  values.clear();
  entries.splice(0);
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function createStore() {
  const lockRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "agentlink-compatible-keychain-"),
  );
  roots.push(lockRoot);
  return createSharedOpenAiCompatibleCredentialStore({
    keychain: { lockRoot },
  });
}

describe("shared OpenAI-compatible credentials", () => {
  it("round-trips named API keys in the shared Keychain service", async () => {
    const store = await createStore();

    await store.store(" openrouter-main ", " secret ");
    await expect(store.get("openrouter-main")).resolves.toBe("secret");
    await store.delete("openrouter-main");
    await expect(store.get("openrouter-main")).resolves.toBeUndefined();

    const account = openAiCompatibleApiKeyAccount(" openrouter-main ");
    expect(account).toMatch(/^openai-compatible-api-key:[a-f0-9]{64}$/u);
    expect(entries).toEqual(
      expect.arrayContaining([
        {
          service: AGENTLINK_SHARED_KEYCHAIN_SERVICE,
          account,
        },
      ]),
    );
  });

  it("accepts the full bounded config auth-key contract with safe hashed accounts", () => {
    const account = openAiCompatibleApiKeyAccount("Prod Key/with spaces");
    expect(account).toMatch(/^openai-compatible-api-key:[a-f0-9]{64}$/u);
    expect(() => openAiCompatibleApiKeyAccount(" ")).toThrow(
      "agentlink_openai_compatible_auth_key_invalid",
    );
  });

  it("migrates credentials from the earlier plain-name shared Keychain account", async () => {
    const store = await createStore();
    const legacyAccount = "openai-compatible-api-key:shared";
    values.set(
      `${AGENTLINK_SHARED_KEYCHAIN_SERVICE}:${legacyAccount}`,
      "shared-v1-secret",
    );

    await expect(store.get("shared")).resolves.toBe("shared-v1-secret");
    expect(
      values.get(
        `${AGENTLINK_SHARED_KEYCHAIN_SERVICE}:${openAiCompatibleApiKeyAccount("shared")}`,
      ),
    ).toBe("shared-v1-secret");

    await store.delete("shared");
    await expect(store.get("shared")).resolves.toBeUndefined();
  });

  it("copies a legacy value only when shared storage is absent and never deletes legacy", async () => {
    const store = await createStore();
    const account = openAiCompatibleApiKeyAccount("shared");
    const key = `${AGENTLINK_SHARED_KEYCHAIN_SERVICE}:${account}`;
    const readLegacy = vi.fn(async () => " legacy-secret ");

    await expect(
      store.migrateLegacyIfAbsent("shared", readLegacy),
    ).resolves.toBe(true);
    expect(values.get(key)).toBe("legacy-secret");
    expect(readLegacy).toHaveBeenCalledOnce();

    const secondLegacyRead = vi.fn(async () => "replacement");
    await expect(
      store.migrateLegacyIfAbsent("shared", secondLegacyRead),
    ).resolves.toBe(false);
    expect(secondLegacyRead).not.toHaveBeenCalled();
    expect(values.get(key)).toBe("legacy-secret");

    await store.delete("shared");
    await expect(
      store.migrateLegacyIfAbsent("shared", async () => "legacy-secret"),
    ).resolves.toBe(false);
    await expect(store.get("shared")).resolves.toBeUndefined();
  });
});
