import { Entry } from "@napi-rs/keyring";

const KEYCHAIN_SERVICE = "com.agentlink.shared-credentials.v1";
const OPENAI_API_KEY_ACCOUNT = "openai-api-key:default";

export interface SharedCredentialStore {
  hasOpenAiApiKey(): boolean;
  getOpenAiApiKey(): string | null;
  setOpenAiApiKey(apiKey: string): void;
  deleteOpenAiApiKey(): boolean;
}

export class KeychainSharedCredentialStore implements SharedCredentialStore {
  private entry: Entry | undefined;

  constructor(
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly createEntry: (
      service: string,
      account: string,
      options?: ConstructorParameters<typeof Entry>[2],
    ) => Entry = (service, account, options) =>
      new Entry(service, account, options),
  ) {}

  /**
   * Created on first use: on Linux the constructor connects to D-Bus, and a
   * missing keyring should fail the credential call, not app startup. Linux
   * pins Secret Service so the key never lands in the non-persistent kernel
   * keyring, matching the rest of AgentLink's OS credential storage.
   */
  private get openAiApiKey(): Entry {
    this.entry ??= this.createEntry(
      KEYCHAIN_SERVICE,
      OPENAI_API_KEY_ACCOUNT,
      this.platform === "linux"
        ? { linux: { store: "secret-service" } }
        : undefined,
    );
    return this.entry;
  }

  hasOpenAiApiKey(): boolean {
    return this.getOpenAiApiKey() !== null;
  }

  getOpenAiApiKey(): string | null {
    try {
      const value = this.openAiApiKey.getPassword();
      return value?.trim() || null;
    } catch (error) {
      if (isMissingCredentialError(error)) return null;
      throw error;
    }
  }

  setOpenAiApiKey(apiKey: string): void {
    const normalized = apiKey.trim();
    if (!normalized) throw new Error("api_key_required");
    this.openAiApiKey.setPassword(normalized);
  }

  deleteOpenAiApiKey(): boolean {
    try {
      this.openAiApiKey.deletePassword();
      return true;
    } catch (error) {
      if (isMissingCredentialError(error)) return false;
      throw error;
    }
  }
}

function isMissingCredentialError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no entry|not found|not exist|item not found|could not be found/i.test(
    message,
  );
}
