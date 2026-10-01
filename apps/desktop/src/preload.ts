import { contextBridge, ipcRenderer } from "electron";

export interface QuickAskShortcutStatus {
  shortcut: string | null;
  registered: boolean;
  defaultShortcut: string;
}

export interface OpenAtLoginStatus {
  available: boolean;
  enabled: boolean;
  requiresApproval: boolean;
}

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
  openAiCompatibleCredentialCount?: number;
  hasUsableOpenAiCompatibleModel?: boolean;
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
  quickAskShortcut: (): Promise<QuickAskShortcutStatus> =>
    ipcRenderer.invoke("agentlink:quick-ask:shortcut:get"),
  setQuickAskShortcut: (
    accelerator: string | null,
  ): Promise<QuickAskShortcutStatus> =>
    ipcRenderer.invoke("agentlink:quick-ask:shortcut:set", accelerator),
  openAtLogin: (): Promise<OpenAtLoginStatus> =>
    ipcRenderer.invoke("agentlink:open-at-login:get"),
  setOpenAtLogin: (enabled: boolean): Promise<OpenAtLoginStatus> =>
    ipcRenderer.invoke("agentlink:open-at-login:set", enabled),
});
