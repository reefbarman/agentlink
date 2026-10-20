import type { ReleaseInstallState } from "../updates/releaseInstall.js";
import type { ReleaseUpdateState } from "../updates/releaseUpdateTypes.js";

export const AGENTLINK_DESKTOP_OWNER_ID = "agentlink-desktop";
export const AGENTLINK_DESKTOP_OWNER_ARGUMENT_PREFIX =
  "--agentlink-desktop-owner-id=";

export type DesktopMode = "ask" | "vscode" | "assistant";

export interface DesktopRemoteLayout {
  mode: DesktopMode;
  bounds: { x: number; y: number; width: number; height: number };
}

export interface DesktopRemoteState {
  status: "idle" | "connecting" | "ready" | "unavailable";
}

/** The desktop's embedded AgentLink Assistant view. */
export interface DesktopAssistantState {
  status: DesktopRemoteState["status"];
  /** The Assistant's HTTPS origin, from desktop Settings. */
  origin: string;
  /** True when only certificates from the configured local CA are accepted. */
  pinned: boolean;
  /** Why the last load failed: an untrusted certificate, or anything else. */
  error?: "certificate" | "load";
  /**
   * True once the loaded Assistant page draws the desktop's sidebar itself
   * (it supports the embed bridge). Until then, and for pages such as
   * sign-in, the shell keeps its own sidebar beside the Assistant.
   */
  embedded?: boolean;
  /**
   * The loaded Assistant page's unread inbox count, as it last reported it.
   * Absent when zero, or before the page has loaded and reported.
   */
  unread?: number;
}

/** Shell layout the embedded Assistant mirrors so the two read as one app. */
export interface DesktopAssistantChrome {
  sidebarOpen: boolean;
  /** The user's dragged sidebar width, when they chose one. */
  sidebarWidth?: number;
  /**
   * CSS pixels the page pads above its layout, set by the desktop (not the
   * shell) so the page's sidebar lines up with the shell's when zoomed.
   */
  offsetTop?: number;
}

/**
 * The only API the embedded Assistant page receives. It can ask the desktop
 * to show another view and follow the shell's sidebar; nothing else.
 */
export interface DesktopEmbedBridge {
  /** The page draws the desktop chrome (sidebar and view navigation). */
  ready(): void;
  /** Switch the desktop to another view. */
  showView(mode: Exclude<DesktopMode, "assistant">): void;
  onChrome(listener: (chrome: DesktopAssistantChrome) => void): () => void;
  /**
   * Report the Assistant's unread inbox count so the desktop can badge its
   * Assistant tab. Optional: older desktop builds do not offer it.
   */
  setUnread?(count: number): void;
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
  /** Reload the Assistant view after a failure. */
  retryAssistant?(): void;
  onAssistantState?(
    listener: (state: DesktopAssistantState) => void,
  ): () => void;
  /** Mirror the shell's sidebar into the embedded Assistant. */
  setAssistantChrome?(chrome: DesktopAssistantChrome): void;
  /** The embedded Assistant asked to show another view. */
  onViewRequest?(
    listener: (mode: Exclude<DesktopMode, "assistant">) => void,
  ): () => void;
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
  getReleaseInstallState?(): Promise<ReleaseInstallState>;
  onReleaseInstallState?(
    listener: (state: ReleaseInstallState) => void,
  ): () => void;
  installReleaseUpdate?(): Promise<ReleaseInstallState>;
  restartForReleaseUpdate?(): Promise<ReleaseInstallState>;
}

declare global {
  interface Window {
    agentlinkDesktopShell?: DesktopBridge;
    agentlinkDesktopEmbed?: DesktopEmbedBridge;
  }
}
