import { shell } from "electron";
import { createKeychainSecretStorage } from "@agentlink/node-host";

import {
  CODEX_OAUTH_CREDENTIALS_STORAGE_KEY,
  CodexOAuthManager,
  type CodexOAuthAccountInfo,
} from "../../../src/agent/providers/codex/CodexOAuthManager.js";
import { KeychainSharedCredentialStore } from "./sharedCredentialStore.js";

export interface DesktopAuthStatus {
  hasOpenAiApiKey: boolean;
  oauthAccounts: CodexOAuthAccountInfo[];
}

export interface DesktopResolvedModelAuth {
  providerId: "openai-codex";
  method: "oauth" | "apiKey";
  bearerToken: string;
  accountId?: string;
  accountLabel: string;
  canRefresh: boolean;
}

export class DesktopAuthController {
  readonly apiKeys = new KeychainSharedCredentialStore();
  readonly oauth = new CodexOAuthManager((message) =>
    process.stderr.write(`[agentlink-desktop] ${message}\n`),
  );

  async initialize(): Promise<void> {
    this.oauth.initializeStorage(
      await createKeychainSecretStorage({
        account: CODEX_OAUTH_CREDENTIALS_STORAGE_KEY,
      }),
    );
  }

  async getStatus(): Promise<DesktopAuthStatus> {
    return {
      hasOpenAiApiKey: this.apiKeys.hasOpenAiApiKey(),
      oauthAccounts: await this.oauth.listAccounts(),
    };
  }

  async hasModelAuth(): Promise<boolean> {
    return (await this.oauth.hasAccounts()) || this.apiKeys.hasOpenAiApiKey();
  }

  async resolveModelAuth(): Promise<DesktopResolvedModelAuth | null> {
    const active = await this.oauth.getActiveAccount();
    if (active) {
      const bearerToken = await this.oauth.getAccessTokenByAccountId(active.id);
      const refreshed = bearerToken
        ? ((await this.oauth.getAccountById(active.id)) ?? active)
        : null;
      if (bearerToken && refreshed) {
        return {
          providerId: "openai-codex",
          method: "oauth",
          bearerToken,
          accountId: refreshed.chatgptAccountId,
          accountLabel: refreshed.label,
          canRefresh: true,
        };
      }
    }

    const apiKey = this.apiKeys.getOpenAiApiKey();
    return apiKey
      ? {
          providerId: "openai-codex",
          method: "apiKey",
          bearerToken: apiKey,
          accountId: "default",
          accountLabel: "OpenAI API key",
          canRefresh: false,
        }
      : null;
  }

  async signIn(): Promise<CodexOAuthAccountInfo> {
    const authorizationUrl = this.oauth.startAuthorizationFlow();
    const callback = this.oauth.waitForCallback();
    await shell.openExternal(authorizationUrl);
    const credentials = await callback;
    return (
      await this.oauth.saveOAuthAccount(credentials, { makeActive: true })
    ).account;
  }

  async setActiveAccount(accountId: string): Promise<CodexOAuthAccountInfo> {
    const account = await this.oauth.setActiveAccount(accountId, {
      notify: true,
    });
    if (!account) throw new Error("oauth_account_not_found");
    return account;
  }

  async removeAccount(accountId: string): Promise<boolean> {
    return await this.oauth.removeAccount(accountId);
  }

  setOpenAiApiKey(apiKey: string): void {
    this.apiKeys.setOpenAiApiKey(apiKey);
  }

  cancelSignIn(): void {
    this.oauth.cancelAuthorizationFlow();
  }
}
