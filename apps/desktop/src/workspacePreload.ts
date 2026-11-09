import { contextBridge, ipcRenderer } from "electron";

import type { DesktopWorkspaceBridge } from "../../../src/shared/desktopBridge.js";
import { isWorkspaceTabAction } from "../../../src/browser-gateway/webview/workspaceTabsBridge.js";

// The remote renderer gets tab messages only, never the shell's privileged API.
if (process.isMainFrame) {
  const bridge: DesktopWorkspaceBridge = {
    publishTabs: (groups) => ipcRenderer.send("agentlink:remote:tabs", groups),
    onHosted: (listener) => {
      const handler = (): void => listener();
      ipcRenderer.on("agentlink:remote:tabs-hosted", handler);
      return () =>
        ipcRenderer.removeListener("agentlink:remote:tabs-hosted", handler);
    },
    onAction: (listener) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        action: unknown,
      ): void => {
        if (isWorkspaceTabAction(action)) listener(action);
      };
      ipcRenderer.on("agentlink:remote:tab-action", handler);
      return () =>
        ipcRenderer.removeListener("agentlink:remote:tab-action", handler);
    },
  };
  contextBridge.exposeInMainWorld("agentlinkDesktopWorkspace", bridge);
}
