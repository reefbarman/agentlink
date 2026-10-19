import type {
  DesktopAssistantChrome,
  DesktopEmbedBridge,
} from "../../../src/shared/desktopBridge.js";
import { contextBridge, ipcRenderer } from "electron";

/**
 * The embedded Assistant page's only bridge: draw the desktop's sidebar and
 * ask for another view. It carries no credentials, files, or shell access.
 */
if (process.isMainFrame) {
  const bridge: DesktopEmbedBridge = {
    ready: () => ipcRenderer.send("agentlink:assistant-embed:ready"),
    showView: (mode) => {
      if (mode === "ask" || mode === "vscode") {
        ipcRenderer.send("agentlink:assistant-embed:show-view", mode);
      }
    },
    onChrome: (listener) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        chrome: DesktopAssistantChrome,
      ): void => {
        listener({
          sidebarOpen: chrome?.sidebarOpen === true,
          ...(typeof chrome?.sidebarWidth === "number" &&
          Number.isFinite(chrome.sidebarWidth)
            ? { sidebarWidth: chrome.sidebarWidth }
            : {}),
        });
      };
      ipcRenderer.on("agentlink:assistant-embed:chrome", handler);
      return () =>
        ipcRenderer.removeListener("agentlink:assistant-embed:chrome", handler);
    },
  };
  contextBridge.exposeInMainWorld("agentlinkDesktopEmbed", bridge);
}
