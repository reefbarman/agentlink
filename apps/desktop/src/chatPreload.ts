import {
  AGENTLINK_DESKTOP_OWNER_ARGUMENT_PREFIX,
  AGENTLINK_DESKTOP_OWNER_ID,
  type DesktopBridge,
  type DesktopRemoteState,
} from "../../../src/shared/desktopBridge.js";
import { contextBridge, ipcRenderer } from "electron";

if (process.isMainFrame) {
  const askAgentOwnerId =
    process.argv
      .find((argument) =>
        argument.startsWith(AGENTLINK_DESKTOP_OWNER_ARGUMENT_PREFIX),
      )
      ?.slice(AGENTLINK_DESKTOP_OWNER_ARGUMENT_PREFIX.length)
      .trim() || AGENTLINK_DESKTOP_OWNER_ID;
  const bridge: DesktopBridge = {
    askAgentOwnerId,
    onAskAgentOwnerIdChanged: (listener) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        ownerId: unknown,
      ): void => {
        if (typeof ownerId === "string" && ownerId.trim()) {
          listener(ownerId.trim());
        }
      };
      ipcRenderer.on("agentlink:ask-agent-owner-id", handler);
      return () =>
        ipcRenderer.removeListener("agentlink:ask-agent-owner-id", handler);
    },
    setRemoteLayout: (layout) =>
      ipcRenderer.send("agentlink:remote:layout", layout),
    retryRemote: () => ipcRenderer.send("agentlink:remote:retry"),
    onRemoteState: (listener) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        state: DesktopRemoteState,
      ): void => {
        listener({ status: state.status });
      };
      ipcRenderer.on("agentlink:remote:state", handler);
      return () =>
        ipcRenderer.removeListener("agentlink:remote:state", handler);
    },
  };
  contextBridge.exposeInMainWorld("agentlinkDesktopShell", bridge);
}
