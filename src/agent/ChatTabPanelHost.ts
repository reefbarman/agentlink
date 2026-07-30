import * as vscode from "vscode";

import { renderChatWebviewShell } from "../adapters/vscode/chatWebviewShell.js";
import {
  ChatPaneAuthorityController,
  type ChatPaneLease,
} from "./ChatPaneAuthorityController.js";
import { ChatPaneConnection } from "./ChatPaneConnection.js";
import {
  CHAT_PANEL_VIEW_TYPE,
  createChatPaneAddress,
  parseSerializedChatPanelState,
  type ChatPaneAddress,
} from "./chatPaneProtocol.js";
import type { ChatTabController } from "./ChatTabController.js";
import {
  ChatTabPanelRegistry,
  type ChatTabPanelHandle,
} from "./ChatTabPanelRegistry.js";

export interface ChatTabPanelHostOptions {
  extensionUri: vscode.Uri;
  tabs: ChatTabController;
  hydrateEditor(
    tabId: string,
    connection: ChatPaneConnection,
  ): void | Promise<void>;
  hydrateSidebar(tabId: string, lease: ChatPaneLease): void | Promise<void>;
  onEditorMessage(
    message: Record<string, unknown>,
    connection: ChatPaneConnection,
  ): void | Promise<void>;
  onLayoutChanged(): void;
  log?: (message: string) => void;
}

type EditorPaneSource = "pop" | "fallback" | "serialized";

interface EditorPaneRegistration {
  panel: vscode.WebviewPanel;
  connection: ChatPaneConnection;
  lease: ChatPaneLease;
  transition: number;
  source: EditorPaneSource;
}

export class ChatTabPanelHost
  implements vscode.Disposable, vscode.WebviewPanelSerializer
{
  static readonly viewType = CHAT_PANEL_VIEW_TYPE;

  private readonly authority: ChatPaneAuthorityController;
  private readonly registry: ChatTabPanelRegistry;
  private readonly editorPanes = new Map<string, EditorPaneRegistration>();
  private readonly transitions = new Map<string, number>();
  private runtimeReady = false;
  private resolveRuntimeReady!: () => void;
  private readonly runtimeReadyPromise: Promise<void>;
  private disposed = false;

  constructor(private readonly options: ChatTabPanelHostOptions) {
    this.runtimeReadyPromise = new Promise<void>((resolve) => {
      this.resolveRuntimeReady = resolve;
    });
    this.authority = new ChatPaneAuthorityController({
      isKnownTab: (tabId) => Boolean(options.tabs.getTab(tabId)),
    });
    this.registry = new ChatTabPanelRegistry({
      authority: this.authority,
      onPanelUserClose: (tabId, lease) =>
        this.handlePanelUserClose(tabId, lease),
      log: options.log,
    });
    this.reconcileSidebarAuthority();
  }

  markRuntimeReady(): void {
    if (this.runtimeReady || this.disposed) return;
    this.runtimeReady = true;
    this.resolveRuntimeReady();
  }

  getSidebarAddress(tabId: string): ChatPaneAddress | undefined {
    const tab = this.options.tabs.getTab(tabId);
    const lease = this.authority.getAuthority(tabId).active;
    if (!tab || lease?.surface !== "sidebar") return undefined;
    return createChatPaneAddress(
      this.options.tabs.getWorkspaceSnapshot().controllerEpoch,
      tab.sessionId,
      lease,
    );
  }

  getEditorConnection(tabId: string): ChatPaneConnection | undefined {
    const registration = this.editorPanes.get(tabId);
    return registration && this.authority.isAuthoritative(registration.lease)
      ? registration.connection
      : undefined;
  }

  focusPanel(tabId: string): boolean {
    const registration = this.editorPanes.get(tabId);
    if (!registration || !this.authority.isAuthoritative(registration.lease)) {
      return false;
    }
    registration.panel.reveal(undefined, false);
    return true;
  }

  isRegisteredConnection(
    tabId: string,
    connection: ChatPaneConnection,
  ): boolean {
    return this.editorPanes.get(tabId)?.connection === connection;
  }

  postMessage(
    message: unknown,
    accepts: (address: ChatPaneAddress) => boolean = () => true,
  ): void {
    for (const registration of this.editorPanes.values()) {
      if (!this.authority.isAuthoritative(registration.lease)) continue;
      if (!accepts(registration.connection.getAddress())) continue;
      registration.connection.postMessage(message);
    }
  }

  isAuthoritativeAddress(address: ChatPaneAddress): boolean {
    if (
      address.controllerEpoch !==
      this.options.tabs.getWorkspaceSnapshot().controllerEpoch
    ) {
      return false;
    }
    const tab = this.options.tabs.getTab(address.tabId);
    if (!tab || tab.sessionId !== address.sessionId) return false;
    return this.authority.isAuthoritative({
      tabId: address.tabId,
      surface: address.surface,
      epoch: address.paneEpoch,
    });
  }

  async popOut(tabId: string): Promise<boolean> {
    if (this.disposed) return false;
    const existing = this.registry.getPanel(tabId);
    if (existing) {
      existing.reveal();
      return true;
    }
    const placement = this.options.tabs.canSetPlacement(
      tabId,
      "docked",
      "popped",
    );
    if (!placement.ok) return false;
    const panel = vscode.window.createWebviewPanel(
      ChatTabPanelHost.viewType,
      this.getPanelTitle(tabId),
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.options.extensionUri, "dist"),
        ],
      },
    );
    panel.iconPath = vscode.Uri.joinPath(
      this.options.extensionUri,
      "media",
      "agentlink-terminal.svg",
    );
    return this.attachPanel(tabId, panel, "docked", "pop");
  }

  async dock(tabId: string): Promise<boolean> {
    if (this.disposed) return false;
    const tab = this.options.tabs.getTab(tabId);
    const registration = this.editorPanes.get(tabId);
    if (!tab || tab.placement !== "popped" || !registration) return false;

    const prepared = this.authority.prepare(tabId, "sidebar");
    if (!prepared.ok) return false;
    const transition = this.beginTransition(tabId);
    let previousAuthority: ChatPaneLease | null | undefined;
    try {
      await this.options.hydrateSidebar(tabId, prepared.lease);
      if (
        !this.isCurrentTransition(tabId, transition) ||
        this.editorPanes.get(tabId) !== registration ||
        this.options.tabs.getTab(tabId)?.placement !== "popped"
      ) {
        throw new Error("docking handoff was superseded");
      }
      const activated = this.authority.activate(prepared.lease);
      if (!activated.ok)
        throw new Error("sidebar pane activation was rejected");
      previousAuthority = activated.previous;
      const placement = await this.options.tabs.setPlacement(
        tabId,
        "popped",
        "docked",
      );
      if (!placement.ok) {
        throw new Error(`docking placement failed: ${placement.reason}`);
      }
      if (
        !this.isCurrentTransition(tabId, transition) ||
        this.editorPanes.get(tabId) !== registration ||
        this.options.tabs.getTab(tabId)?.placement !== "docked"
      ) {
        throw new Error("docking handoff was superseded");
      }
      this.registry.disposePanel(tabId);
      this.options.onLayoutChanged();
      return true;
    } catch (error) {
      if (this.isCurrentTransition(tabId, transition)) {
        if (previousAuthority === undefined) {
          this.authority.cancel(prepared.lease);
        } else {
          this.authority.rollbackActivation(prepared.lease, previousAuthority);
        }
      }
      this.options.log?.(
        `[chat-tabs] Failed to dock editor panel ${tabId}: ${String(error)}`,
      );
      return false;
    }
  }

  async deserializeWebviewPanel(
    webviewPanel: vscode.WebviewPanel,
    state: unknown,
  ): Promise<void> {
    const serialized = parseSerializedChatPanelState(state);
    if (!serialized) {
      webviewPanel.dispose();
      return;
    }
    await this.runtimeReadyPromise;
    if (this.disposed) {
      webviewPanel.dispose();
      return;
    }
    const tab = this.options.tabs.getTab(serialized.tabId);
    if (!tab || tab.placement !== "popped") {
      webviewPanel.dispose();
      return;
    }
    this.attachPanel(serialized.tabId, webviewPanel, "popped", "serialized");
  }

  async restoreMissingPanels(): Promise<void> {
    await this.runtimeReadyPromise;
    if (this.disposed) return;
    for (const tab of this.options.tabs.getLayout().tabs) {
      if (tab.placement !== "popped" || this.registry.getPanel(tab.id))
        continue;
      const panel = vscode.window.createWebviewPanel(
        ChatTabPanelHost.viewType,
        this.getPanelTitle(tab.id),
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [
            vscode.Uri.joinPath(this.options.extensionUri, "dist"),
          ],
        },
      );
      panel.iconPath = vscode.Uri.joinPath(
        this.options.extensionUri,
        "media",
        "agentlink-terminal.svg",
      );
      this.attachPanel(tab.id, panel, "popped", "fallback");
    }
  }

  releaseTab(tabId: string): void {
    this.beginTransition(tabId);
    this.editorPanes.get(tabId)?.connection.dispose();
    this.editorPanes.delete(tabId);
    this.registry.releaseTab(tabId);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.resolveRuntimeReady();
    for (const registration of this.editorPanes.values()) {
      registration.connection.dispose();
    }
    this.editorPanes.clear();
    this.registry.dispose();
    this.authority.dispose();
  }

  private attachPanel(
    tabId: string,
    panel: vscode.WebviewPanel,
    expectedPlacement: "docked" | "popped",
    source: EditorPaneSource,
  ): boolean {
    const existing = this.editorPanes.get(tabId);
    if (source === "serialized" && existing?.source === "fallback") {
      existing.connection.dispose();
      this.editorPanes.delete(tabId);
      this.registry.disposePanel(tabId);
    }
    const result = this.registry.registerPanel(
      tabId,
      this.asPanelHandle(panel),
    );
    if (result.status !== "attached") return result.status === "duplicate";

    const tab = this.options.tabs.getTab(tabId);
    if (!tab) {
      this.registry.cancelPanelHandoff(tabId, result.lease);
      return false;
    }
    const address = createChatPaneAddress(
      this.options.tabs.getWorkspaceSnapshot().controllerEpoch,
      tab.sessionId,
      result.lease,
    );
    panel.title = this.getPanelTitle(tabId);
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.options.extensionUri, "dist"),
      ],
    };
    const connection = new ChatPaneConnection({
      address,
      webview: panel.webview,
      onReady: (readyConnection) =>
        this.handleEditorReady(
          tabId,
          result.lease,
          expectedPlacement,
          readyConnection,
          transition,
        ),
      onMessage: (...args) => this.options.onEditorMessage(...args),
      log: this.options.log,
    });
    connection.freeze();
    const transition = this.beginTransition(tabId);
    const registration = {
      panel,
      connection,
      lease: result.lease,
      transition,
      source,
    };
    this.editorPanes.set(tabId, registration);
    panel.onDidDispose(() => {
      if (this.editorPanes.get(tabId) !== registration) return;
      connection.dispose();
      this.editorPanes.delete(tabId);
    });
    panel.webview.html = renderChatWebviewShell(
      panel.webview,
      this.options.extensionUri,
      { surface: "editor", address },
    );
    return true;
  }

  private async handleEditorReady(
    tabId: string,
    lease: ChatPaneLease,
    expectedPlacement: "docked" | "popped",
    connection: ChatPaneConnection,
    transition: number,
  ): Promise<void> {
    if (!this.isLiveEditorTransition(tabId, connection, transition)) {
      return;
    }
    try {
      await this.options.hydrateEditor(tabId, connection);
      if (!this.isLiveEditorTransition(tabId, connection, transition)) {
        throw new Error("editor pane handoff was superseded during hydration");
      }
      const tab = this.options.tabs.getTab(tabId);
      const address = connection.getAddress();
      if (
        !tab ||
        address.controllerEpoch !==
          this.options.tabs.getWorkspaceSnapshot().controllerEpoch ||
        address.sessionId !== tab.sessionId
      ) {
        throw new Error("editor pane binding changed during hydration");
      }
      const activated = this.registry.activatePanel(tabId, lease);
      if (!activated.ok) throw new Error("editor pane activation was rejected");
      const placement = await this.options.tabs.setPlacement(
        tabId,
        expectedPlacement,
        "popped",
      );
      if (!placement.ok) {
        throw new Error(`pop-out placement failed: ${placement.reason}`);
      }
      if (
        !this.isLiveEditorTransition(tabId, connection, transition) ||
        this.options.tabs.getTab(tabId)?.placement !== "popped"
      ) {
        throw new Error(
          "editor pane handoff was superseded during persistence",
        );
      }
      connection.resume();
      this.options.onLayoutChanged();
    } catch (error) {
      this.options.log?.(
        `[chat-tabs] Failed to activate editor panel ${tabId}: ${String(error)}`,
      );
      if (!this.isCurrentTransition(tabId, transition)) return;
      if (!this.registry.cancelPanelHandoff(tabId, lease)) {
        this.registry.disposePanel(tabId);
        const adopted = this.authority.adoptSidebar(tabId);
        if (adopted.ok) {
          await Promise.resolve(
            this.options.hydrateSidebar(tabId, adopted.lease),
          ).catch(() => undefined);
        }
      }
    }
  }

  private async handlePanelUserClose(
    tabId: string,
    closedLease: ChatPaneLease,
  ): Promise<void> {
    const transition = this.beginTransition(tabId);
    const registration = this.editorPanes.get(tabId);
    if (
      registration &&
      registration.lease.epoch === closedLease.epoch &&
      registration.lease.surface === closedLease.surface
    ) {
      registration.connection.dispose();
      this.editorPanes.delete(tabId);
    }
    const tab = this.options.tabs.getTab(tabId);
    if (!tab) return;
    if (tab.placement !== "popped") {
      const adopted = this.authority.adoptSidebar(tabId);
      if (adopted.ok) {
        await this.options.hydrateSidebar(tabId, adopted.lease);
      }
      return;
    }

    const prepared = this.authority.prepare(tabId, "sidebar");
    if (!prepared.ok) return;
    try {
      await this.options.hydrateSidebar(tabId, prepared.lease);
      if (
        !this.isCurrentTransition(tabId, transition) ||
        this.options.tabs.getTab(tabId)?.placement !== "popped"
      ) {
        throw new Error("close-to-dock handoff was superseded");
      }
      const activated = this.authority.activate(prepared.lease);
      if (!activated.ok)
        throw new Error("sidebar pane activation was rejected");
      const placement = await this.options.tabs.setPlacement(
        tabId,
        "popped",
        "docked",
      );
      if (!placement.ok) {
        throw new Error(`close-to-dock placement failed: ${placement.reason}`);
      }
      if (
        !this.isCurrentTransition(tabId, transition) ||
        this.options.tabs.getTab(tabId)?.placement !== "docked"
      ) {
        throw new Error("close-to-dock handoff was superseded");
      }
      this.options.onLayoutChanged();
    } catch (error) {
      if (!this.isCurrentTransition(tabId, transition)) return;
      if (!this.authority.isAuthoritative(prepared.lease)) {
        this.authority.cancel(prepared.lease);
      } else if (!this.registry.getPanel(tabId)) {
        const panel = vscode.window.createWebviewPanel(
          ChatTabPanelHost.viewType,
          this.getPanelTitle(tabId),
          { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
          {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [
              vscode.Uri.joinPath(this.options.extensionUri, "dist"),
            ],
          },
        );
        panel.iconPath = vscode.Uri.joinPath(
          this.options.extensionUri,
          "media",
          "agentlink-terminal.svg",
        );
        this.attachPanel(tabId, panel, "popped", "fallback");
      }
      this.options.log?.(
        `[chat-tabs] Failed to dock closed panel ${tabId}: ${String(error)}`,
      );
    }
  }

  private beginTransition(tabId: string): number {
    const transition = (this.transitions.get(tabId) ?? 0) + 1;
    this.transitions.set(tabId, transition);
    return transition;
  }

  private isCurrentTransition(tabId: string, transition: number): boolean {
    return !this.disposed && this.transitions.get(tabId) === transition;
  }

  private isLiveEditorTransition(
    tabId: string,
    connection: ChatPaneConnection,
    transition: number,
  ): boolean {
    const registration = this.editorPanes.get(tabId);
    return (
      this.isCurrentTransition(tabId, transition) &&
      registration?.connection === connection &&
      registration.transition === transition &&
      this.registry.getPanel(tabId) !== undefined
    );
  }

  private reconcileSidebarAuthority(): void {
    for (const tab of this.options.tabs.getLayout().tabs) {
      if (tab.placement === "docked") this.authority.adoptSidebar(tab.id);
    }
  }

  private asPanelHandle(panel: vscode.WebviewPanel): ChatTabPanelHandle {
    return {
      reveal: () => panel.reveal(undefined, true),
      dispose: () => panel.dispose(),
      onDidDispose: (listener) => panel.onDidDispose(listener),
    };
  }

  private getPanelTitle(tabId: string): string {
    const tab = this.options.tabs.getTab(tabId);
    return tab ? `T${tab.displayNumber} · AgentLink` : "AgentLink Chat";
  }
}
