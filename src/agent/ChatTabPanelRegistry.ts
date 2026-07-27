import {
  type ChatPaneLease,
  ChatPaneAuthorityController,
} from "./ChatPaneAuthorityController.js";

export interface ChatTabPanelHandle {
  reveal(): void;
  dispose(): void;
  onDidDispose(listener: () => void): { dispose(): void };
}

export type ChatTabPanelRegistrationResult =
  | { status: "attached"; lease: ChatPaneLease }
  | { status: "duplicate"; lease: ChatPaneLease }
  | { status: "rejected"; reason: "unknown_tab" | "handoff_in_progress" };

export interface ChatTabPanelRegistryOptions {
  authority: ChatPaneAuthorityController;
  onPanelUserClose(tabId: string, lease: ChatPaneLease): void | Promise<void>;
  log?: (message: string) => void;
}

interface PanelRegistration {
  panel: ChatTabPanelHandle;
  lease: ChatPaneLease;
  disposeListener: { dispose(): void };
}

export class ChatTabPanelRegistry {
  private readonly panels = new Map<string, PanelRegistration>();
  private disposing = false;

  constructor(private readonly options: ChatTabPanelRegistryOptions) {}

  registerPanel(
    tabId: string,
    panel: ChatTabPanelHandle,
  ): ChatTabPanelRegistrationResult {
    const existing = this.panels.get(tabId);
    if (existing) {
      existing.panel.reveal();
      panel.dispose();
      return { status: "duplicate", lease: cloneLease(existing.lease) };
    }

    const prepared = this.options.authority.prepare(tabId, "editor");
    if (!prepared.ok) {
      panel.dispose();
      return { status: "rejected", reason: prepared.reason };
    }
    const registration: PanelRegistration = {
      panel,
      lease: prepared.lease,
      disposeListener: { dispose() {} },
    };
    registration.disposeListener = panel.onDidDispose(() => {
      this.handlePanelDisposed(tabId, registration);
    });
    this.panels.set(tabId, registration);
    return { status: "attached", lease: cloneLease(prepared.lease) };
  }

  activatePanel(
    tabId: string,
    lease: ChatPaneLease,
  ): {
    ok: boolean;
    previous: ChatPaneLease | null;
  } {
    const registration = this.panels.get(tabId);
    if (!registration || !sameLease(registration.lease, lease)) {
      return { ok: false, previous: null };
    }
    return this.options.authority.activate(lease);
  }

  cancelPanelHandoff(tabId: string, lease: ChatPaneLease): boolean {
    const registration = this.panels.get(tabId);
    if (!registration || !sameLease(registration.lease, lease)) return false;
    if (!this.options.authority.cancel(lease)) return false;
    this.removePanel(tabId, registration);
    registration.panel.dispose();
    return true;
  }

  getPanel(tabId: string): ChatTabPanelHandle | undefined {
    return this.panels.get(tabId)?.panel;
  }

  disposePanel(tabId: string): boolean {
    const registration = this.panels.get(tabId);
    if (!registration) return false;
    this.removePanel(tabId, registration);
    this.options.authority.revoke(registration.lease);
    registration.panel.dispose();
    return true;
  }

  releaseTab(tabId: string): void {
    const registration = this.panels.get(tabId);
    if (registration) {
      this.removePanel(tabId, registration);
      this.options.authority.revoke(registration.lease);
      registration.panel.dispose();
    }
    this.options.authority.releaseTab(tabId);
  }

  dispose(): void {
    if (this.disposing) return;
    this.disposing = true;
    for (const [tabId, registration] of this.panels) {
      this.removePanel(tabId, registration);
      this.options.authority.revoke(registration.lease);
      registration.panel.dispose();
    }
  }

  private handlePanelDisposed(
    tabId: string,
    registration: PanelRegistration,
  ): void {
    if (this.panels.get(tabId) !== registration) return;
    this.removePanel(tabId, registration);
    this.options.authority.revoke(registration.lease);
    if (this.disposing) return;
    try {
      void Promise.resolve(
        this.options.onPanelUserClose(tabId, cloneLease(registration.lease)),
      ).catch((error) => {
        this.options.log?.(
          `[chat-tabs] Failed to dock user-closed panel ${tabId}: ${String(error)}`,
        );
      });
    } catch (error) {
      this.options.log?.(
        `[chat-tabs] Failed to dock user-closed panel ${tabId}: ${String(error)}`,
      );
    }
  }

  private removePanel(tabId: string, registration: PanelRegistration): void {
    if (this.panels.get(tabId) !== registration) return;
    this.panels.delete(tabId);
    registration.disposeListener.dispose();
  }
}

function sameLease(left: ChatPaneLease, right: ChatPaneLease): boolean {
  return (
    left.tabId === right.tabId &&
    left.surface === right.surface &&
    left.epoch === right.epoch
  );
}

function cloneLease(lease: ChatPaneLease): ChatPaneLease {
  return { ...lease };
}
