import type {
  DesktopBridge,
  DesktopRemoteState,
} from "../../../src/shared/desktopBridge.js";
import { contextBridge, ipcRenderer } from "electron";

if (process.isMainFrame) {
  const bridge: DesktopBridge = {
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
