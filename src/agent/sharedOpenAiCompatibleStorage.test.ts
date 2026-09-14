import { describe, expect, it, vi } from "vitest";

import type {
  SharedOpenAiCompatibleConfigStore,
  SharedOpenAiCompatibleCredentialStore,
} from "@agentlink/node-host";

import { getOpenAiCompatibleSecretKey } from "./openAiCompatibleSecrets.js";
import { initializeSharedOpenAiCompatibleStorage } from "./sharedOpenAiCompatibleStorage.js";

const connections = [{ id: "local", authKey: "local-key" }];

describe("initializeSharedOpenAiCompatibleStorage", () => {
  it("imports legacy connections and credentials without deleting them", async () => {
    let sharedDocument:
      | { schemaVersion: 1; connections: readonly unknown[] }
      | undefined;
    let sharedCredential: string | undefined;
    const configStore = {
      configPath: "/tmp/openai-compatible.json",
      read: vi.fn(async () => sharedDocument),
      importLegacyIfAbsent: vi.fn(async (value: readonly unknown[]) => {
        if (sharedDocument) return false;
        sharedDocument = { schemaVersion: 1, connections: [...value] };
        return true;
      }),
    } as unknown as SharedOpenAiCompatibleConfigStore;
    const credentialStore = {
      get: vi.fn(async () => sharedCredential),
      store: vi.fn(async (_authKey: string, value: string) => {
        sharedCredential = value;
      }),
      delete: vi.fn(),
      migrateLegacyIfAbsent: vi.fn(
        async (
          _authKey: string,
          readLegacy: () => PromiseLike<string | undefined>,
        ) => {
          if (sharedCredential) return false;
          sharedCredential = await readLegacy();
          return Boolean(sharedCredential);
        },
      ),
    } satisfies SharedOpenAiCompatibleCredentialStore;
    const legacySecrets = {
      get: vi.fn(async () => "legacy-secret"),
    };

    const result = await initializeSharedOpenAiCompatibleStorage({
      configStore,
      credentialStore,
      legacyConnections: connections,
      legacySecrets,
      getConfiguredAuthKeys: () => ["local-key"],
    });

    expect(result.connections).toEqual(connections);
    expect(configStore.importLegacyIfAbsent).toHaveBeenCalledWith(connections);
    expect(credentialStore.migrateLegacyIfAbsent).toHaveBeenCalledOnce();
    expect(legacySecrets.get).toHaveBeenCalledWith(
      getOpenAiCompatibleSecretKey("local-key"),
    );
    await expect(
      result.secrets.get(getOpenAiCompatibleSecretKey("local-key")),
    ).resolves.toBe("legacy-secret");
  });

  it("keeps existing shared configuration authoritative", async () => {
    const sharedConnections = [{ id: "shared", authKey: "shared-key" }];
    const configStore = {
      configPath: "/tmp/openai-compatible.json",
      read: vi.fn(async () => ({
        schemaVersion: 1 as const,
        connections: sharedConnections,
      })),
      importLegacyIfAbsent: vi.fn(),
    } as unknown as SharedOpenAiCompatibleConfigStore;
    const credentialStore = {
      get: vi.fn(),
      store: vi.fn(),
      delete: vi.fn(),
      migrateLegacyIfAbsent: vi.fn(async () => false),
    } satisfies SharedOpenAiCompatibleCredentialStore;

    const result = await initializeSharedOpenAiCompatibleStorage({
      configStore,
      credentialStore,
      legacyConnections: connections,
      legacySecrets: { get: vi.fn() },
      getConfiguredAuthKeys: () => ["shared-key"],
    });

    expect(result.connections).toEqual(sharedConnections);
    expect(configStore.importLegacyIfAbsent).not.toHaveBeenCalled();
  });
});
