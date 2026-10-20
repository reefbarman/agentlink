import {
  AGENTLINK_DESKTOP_OWNER_ARGUMENT_PREFIX,
  AGENTLINK_DESKTOP_OWNER_ID,
  type DesktopAssistantState,
  type DesktopBridge,
  type DesktopQuickAskSubmission,
  type DesktopRemoteState,
  type DesktopMcpManagerOpenRequest,
} from "../../../src/shared/desktopBridge.js";
import { contextBridge, ipcRenderer } from "electron";
import type { ReleaseUpdateState } from "../../../src/updates/releaseUpdateTypes.js";
import type { ReleaseInstallState } from "../../../src/updates/releaseInstall.js";

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
    retryAssistant: () => ipcRenderer.send("agentlink:assistant:retry"),
    onAssistantState: (listener) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        state: DesktopAssistantState,
      ): void => {
        listener({
          status: state.status,
          origin: state.origin,
          pinned: state.pinned === true,
          ...(state.error === "certificate" || state.error === "load"
            ? { error: state.error }
            : {}),
          ...(state.embedded === true ? { embedded: true } : {}),
          ...(Number.isSafeInteger(state.unread) && (state.unread ?? 0) > 0
            ? { unread: state.unread }
            : {}),
        });
      };
      ipcRenderer.on("agentlink:assistant:state", handler);
      return () =>
        ipcRenderer.removeListener("agentlink:assistant:state", handler);
    },
    setAssistantChrome: (chrome) =>
      ipcRenderer.send("agentlink:assistant:chrome", {
        sidebarOpen: chrome.sidebarOpen === true,
        ...(typeof chrome.sidebarWidth === "number"
          ? { sidebarWidth: chrome.sidebarWidth }
          : {}),
      }),
    onViewRequest: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, mode: unknown) => {
        if (mode === "ask" || mode === "vscode") listener(mode);
      };
      ipcRenderer.on("agentlink:assistant:show-view", handler);
      return () =>
        ipcRenderer.removeListener("agentlink:assistant:show-view", handler);
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
    openMcpManager: (request) => {
      ipcRenderer.send("agentlink:mcp-manager:open", request);
    },
    onMcpManagerOpen: (listener) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        request: unknown,
      ): void => {
        if (
          request &&
          typeof request === "object" &&
          ((request as DesktopMcpManagerOpenRequest).view === "status" ||
            (request as DesktopMcpManagerOpenRequest).view === "config") &&
          ((request as DesktopMcpManagerOpenRequest).action === "open" ||
            (request as DesktopMcpManagerOpenRequest).action === "refresh")
        ) {
          listener(request as DesktopMcpManagerOpenRequest);
        }
      };
      ipcRenderer.on("agentlink:mcp-manager:open", handler);
      return () =>
        ipcRenderer.removeListener("agentlink:mcp-manager:open", handler);
    },
    openMcpConfig: (scope) =>
      ipcRenderer.invoke("agentlink:mcp-manager:open-config", scope),
    setMcpOperation: (operationId) =>
      ipcRenderer.send("agentlink:mcp-manager:operation", operationId),
    getReleaseInstallState: (): Promise<ReleaseInstallState> =>
      ipcRenderer.invoke("agentlink:release-update:install-state"),
    installReleaseUpdate: (): Promise<ReleaseInstallState> =>
      ipcRenderer.invoke("agentlink:release-update:install"),
    restartForReleaseUpdate: (): Promise<ReleaseInstallState> =>
      ipcRenderer.invoke("agentlink:release-update:restart"),
    onReleaseInstallState: (listener) => {
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
    onReleaseUpdateState: (listener) => {
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
