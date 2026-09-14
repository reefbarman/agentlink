import type {
  SharedOpenAiCompatibleConfigStore,
  SharedOpenAiCompatibleCredentialStore,
} from "@agentlink/node-host";

import type { OpenAiCompatibleSecretStore } from "./openAiCompatibleCredentials.js";
import { getOpenAiCompatibleSecretKey } from "./openAiCompatibleSecrets.js";

export interface LegacyOpenAiCompatibleSecretStore {
  get(key: string): Thenable<string | undefined>;
}

export async function initializeSharedOpenAiCompatibleStorage(params: {
  configStore: SharedOpenAiCompatibleConfigStore;
  credentialStore: SharedOpenAiCompatibleCredentialStore;
  legacyConnections: unknown;
  legacySecrets: LegacyOpenAiCompatibleSecretStore;
  getConfiguredAuthKeys(connections: unknown): readonly string[];
  migrateLegacyCredentials?: boolean;
  log?: (message: string) => void;
}): Promise<{
  connections: unknown[];
  secrets: OpenAiCompatibleSecretStore;
}> {
  const legacyConnections = Array.isArray(params.legacyConnections)
    ? params.legacyConnections
    : [];
  let document = await params.configStore.read();
  if (!document && legacyConnections.length > 0) {
    const imported =
      await params.configStore.importLegacyIfAbsent(legacyConnections);
    if (imported) {
      params.log?.(
        `[openai-compatible] imported ${legacyConnections.length} legacy connection${legacyConnections.length === 1 ? "" : "s"} into ${params.configStore.configPath}`,
      );
    }
    document = await params.configStore.read();
  }
  const connections = [...(document?.connections ?? legacyConnections)];
  if (params.migrateLegacyCredentials !== false) {
    const authKeys = params.getConfiguredAuthKeys(connections);
    for (const authKey of authKeys) {
      const imported = await params.credentialStore.migrateLegacyIfAbsent(
        authKey,
        () => params.legacySecrets.get(getOpenAiCompatibleSecretKey(authKey)),
      );
      if (imported) {
        params.log?.(
          `[openai-compatible] imported legacy API key “${authKey}” into shared Keychain storage`,
        );
      }
    }
  }

  return {
    connections,
    secrets: {
      get: (key) => params.credentialStore.get(authKeyFromSecretKey(key)),
      store: (key, value) =>
        params.credentialStore.store(authKeyFromSecretKey(key), value),
      delete: (key) => params.credentialStore.delete(authKeyFromSecretKey(key)),
    },
  };
}

function authKeyFromSecretKey(key: string): string {
  const prefix = getOpenAiCompatibleSecretKey("");
  if (!key.startsWith(prefix)) {
    throw new Error("agentlink_openai_compatible_secret_key_invalid");
  }
  return key.slice(prefix.length);
}
