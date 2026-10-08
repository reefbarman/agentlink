import { contextBridge, ipcRenderer } from "electron";

import type { ReleaseInstallState } from "../../../src/updates/releaseInstall.js";
import type { ReleaseUpdateState } from "../../../src/updates/releaseUpdateTypes.js";

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
  getReleaseInstallState: (): Promise<ReleaseInstallState> =>
    ipcRenderer.invoke("agentlink:release-update:install-state"),
  installReleaseUpdate: (): Promise<ReleaseInstallState> =>
    ipcRenderer.invoke("agentlink:release-update:install"),
  restartForReleaseUpdate: (): Promise<ReleaseInstallState> =>
    ipcRenderer.invoke("agentlink:release-update:restart"),
  onReleaseInstallState: (listener: (state: ReleaseInstallState) => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      state: ReleaseInstallState,
    ): void => listener(state);
    ipcRenderer.on("agentlink:release-update:install-state", handler);
    return () =>
      ipcRenderer.removeListener(
        "agentlink:release-update:install-state",
        handler,
      );
  },
  getReleaseUpdateState: (): Promise<ReleaseUpdateState> =>
    ipcRenderer.invoke("agentlink:release-update:get"),
  onReleaseUpdateState: (listener: (state: ReleaseUpdateState) => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      state: ReleaseUpdateState,
    ): void => listener(state);
    ipcRenderer.on("agentlink:release-update:state", handler);
    return () =>
      ipcRenderer.removeListener("agentlink:release-update:state", handler);
  },
  checkForReleaseUpdate: (): Promise<ReleaseUpdateState> =>
    ipcRenderer.invoke("agentlink:release-update:check"),
  dismissReleaseUpdate: (): Promise<ReleaseUpdateState> =>
    ipcRenderer.invoke("agentlink:release-update:dismiss"),
  setAutomaticUpdateChecks: (value: boolean): Promise<ReleaseUpdateState> =>
    ipcRenderer.invoke("agentlink:release-update:automatic", value),
  openReleaseUpdateLink: (url: string): Promise<{ ok: true }> =>
    ipcRenderer.invoke("agentlink:release-update:open-link", url),
});
