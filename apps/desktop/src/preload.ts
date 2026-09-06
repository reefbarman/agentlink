import { contextBridge, ipcRenderer } from "electron";

export interface DesktopOAuthAccount {
  id: string;
  label: string;
  email?: string;
  isActive: boolean;
  createdAt: number;
  updatedAt: number;
  lastUsageLimitAt?: number;
}

export interface DesktopAuthStatus {
  hasOpenAiApiKey: boolean;
  oauthAccounts: DesktopOAuthAccount[];
}

contextBridge.exposeInMainWorld("agentlinkDesktop", {
  credentialStatus: (): Promise<DesktopAuthStatus> =>
    ipcRenderer.invoke("agentlink:credentials:status"),
  storeOpenAiApiKey: (apiKey: string): Promise<{ ok: true }> =>
    ipcRenderer.invoke("agentlink:credentials:store-openai-api-key", apiKey),
  signInOAuth: (): Promise<{
    account: DesktopOAuthAccount;
    status: DesktopAuthStatus;
  }> => ipcRenderer.invoke("agentlink:oauth:sign-in"),
  setActiveOAuthAccount: (accountId: string): Promise<DesktopAuthStatus> =>
    ipcRenderer.invoke("agentlink:oauth:set-active", accountId),
  removeOAuthAccount: (accountId: string): Promise<DesktopAuthStatus> =>
    ipcRenderer.invoke("agentlink:oauth:remove", accountId),
  continueToChat: (): Promise<{ ok: true }> =>
    ipcRenderer.invoke("agentlink:continue-to-chat"),
});
