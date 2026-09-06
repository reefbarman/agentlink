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
  private readonly openAiApiKey = new Entry(
    KEYCHAIN_SERVICE,
    OPENAI_API_KEY_ACCOUNT,
  );

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
