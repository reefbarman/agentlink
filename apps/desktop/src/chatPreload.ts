import {
  AGENTLINK_DESKTOP_OWNER_ARGUMENT_PREFIX,
  AGENTLINK_DESKTOP_OWNER_ID,
  type DesktopBridge,
  type DesktopQuickAskSubmission,
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
    openSettings: () => ipcRenderer.send("agentlink:open-settings"),
    submitQuickAsk: (submission) =>
      ipcRenderer.send("agentlink:quick-ask:submit", submission),
    dismissQuickAsk: () => ipcRenderer.send("agentlink:quick-ask:dismiss"),
    onQuickAskShown: (listener) => {
      const handler = (): void => listener();
      ipcRenderer.on("agentlink:quick-ask:shown", handler);
      return () =>
        ipcRenderer.removeListener("agentlink:quick-ask:shown", handler);
    },
    onQuickAskSubmission: (listener) => {
      let active = true;
      // Submissions queue in the main process, so a window that subscribes
      // after the hand-off (for example, one still loading) still drains them.
      const take = (): void => {
        void ipcRenderer
          .invoke("agentlink:quick-ask:take")
          .then((submissions: DesktopQuickAskSubmission[]) => {
            if (!active || !Array.isArray(submissions)) return;
            for (const submission of submissions) listener(submission);
          })
          .catch(() => undefined);
      };
      const handler = (): void => take();
      ipcRenderer.on("agentlink:quick-ask:available", handler);
      take();
      return () => {
        active = false;
        ipcRenderer.removeListener("agentlink:quick-ask:available", handler);
      };
    },
  };
  contextBridge.exposeInMainWorld("agentlinkDesktopShell", bridge);
}
