import type { ReleaseUpdateState } from "../updates/releaseUpdateTypes.js";

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

export interface DesktopQuickAskMedia {
  name: string;
  mimeType: string;
  base64: string;
  kind: "image" | "document";
}

/** A message composed in the quick-ask panel, handed to the main Ask Agent window. */
export interface DesktopQuickAskSubmission {
  text: string;
  displayText?: string;
  slashCommandLabel?: string;
  media?: DesktopQuickAskMedia[];
}

export interface DesktopMcpManagerOpenRequest {
  view: "status" | "config";
  action: "open" | "refresh";
}

/** Narrow shell-only API. The remote workspace renderer never receives this bridge. */
export interface DesktopBridge {
  readonly askAgentOwnerId: string;
  onAskAgentOwnerIdChanged(listener: (ownerId: string) => void): () => void;
  setRemoteLayout(layout: DesktopRemoteLayout): void;
  retryRemote(): void;
  onRemoteState(listener: (state: DesktopRemoteState) => void): () => void;
  /** Opens the desktop Settings window (shortcut, login item, accounts). */
  openSettings?(): void;
  /** Quick-ask panel: hand a composed message to the main window. */
  submitQuickAsk?(submission: DesktopQuickAskSubmission): void;
  /** Quick-ask panel: hide without sending. */
  dismissQuickAsk?(): void;
  /** Quick-ask panel: fires each time the panel is shown. */
  onQuickAskShown?(listener: () => void): () => void;
  /** Main window: receives quick-ask messages, including any queued before subscribing. */
  onQuickAskSubmission?(
    listener: (submission: DesktopQuickAskSubmission) => void,
  ): () => void;
  /** Open or focus the native MCP manager with a validated view/action. */
  openMcpManager?(request: DesktopMcpManagerOpenRequest): void;
  /** MCP window: receive later opens without reloading the active auth flow. */
  onMcpManagerOpen?(
    listener: (request: DesktopMcpManagerOpenRequest) => void,
  ): () => void;
  /** MCP window: open one fixed Ask Agent config file in the native editor. */
  openMcpConfig?(scope: "global" | "ask-agent-global"): Promise<void>;
  /** MCP window: register the operation that native close/crash must cancel. */
  setMcpOperation?(operationId: string | null): void;
  /** Local Desktop release status and deliberate update actions. */
  getReleaseUpdateState?(): Promise<ReleaseUpdateState>;
  onReleaseUpdateState?(
    listener: (state: ReleaseUpdateState) => void,
  ): () => void;
  checkForReleaseUpdate?(): Promise<ReleaseUpdateState>;
  dismissReleaseUpdate?(): Promise<ReleaseUpdateState>;
}

declare global {
  interface Window {
    agentlinkDesktopShell?: DesktopBridge;
  }
}
