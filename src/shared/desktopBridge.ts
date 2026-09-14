export const AGENTLINK_DESKTOP_OWNER_ID = "agentlink-desktop";
export const AGENTLINK_DESKTOP_OWNER_ARGUMENT_PREFIX =
  "--agentlink-desktop-owner-id=";

export type DesktopMode = "ask" | "vscode";

export interface DesktopRemoteLayout {
  mode: DesktopMode;
  bounds: { x: number; y: number; width: number; height: number };
}

export interface DesktopRemoteState {
  status: "idle" | "connecting" | "ready" | "unavailable";
}

/** Narrow shell-only API. The remote workspace renderer never receives this bridge. */
export interface DesktopBridge {
  readonly askAgentOwnerId: string;
  onAskAgentOwnerIdChanged(listener: (ownerId: string) => void): () => void;
  setRemoteLayout(layout: DesktopRemoteLayout): void;
  retryRemote(): void;
  onRemoteState(listener: (state: DesktopRemoteState) => void): () => void;
}

declare global {
  interface Window {
    agentlinkDesktopShell?: DesktopBridge;
  }
}
