import type { AgentSession } from "./AgentSession.js";
import {
  type ChatTab,
  type ChatTabActionAddress,
  ChatTabController,
} from "./ChatTabController.js";
import {
  isChatTabSessionBusy,
  type ChatTabDestructiveAction,
} from "./chatTabProtocol.js";
import type { SessionInfo } from "./types.js";

export type ChatTabHostActionResult =
  | { ok: true; tab: ChatTab; session?: AgentSession }
  | {
      ok: false;
      reason: "confirmation_required";
      action: ChatTabDestructiveAction;
      tab: ChatTab;
      targetSessionId?: string;
    }
  | {
      ok: false;
      reason:
        | "invalid_address"
        | "stale_controller"
        | "not_found"
        | "stale_session"
        | "close_blocked"
        | "session_not_found"
        | "binding_conflict"
        | "invalid_order";
    };

interface ChatTabHostSessionManager {
  getSession(sessionId: string): AgentSession | undefined;
  getSessionInfos(): SessionInfo[];
  createSession(
    mode: string,
    opts?: {
      activeFilePath?: string;
      projectId?: string;
      foreground?: boolean;
    },
  ): Promise<AgentSession>;
  hydratePersistedSession(sessionId: string): Promise<AgentSession | null>;
  loadPersistedSession(sessionId: string): Promise<AgentSession | null>;
  stopSessionAndWait(sessionId: string): Promise<string[]>;
  switchTo(sessionId: string): void;
}

export class ChatTabHostCoordinator {
  constructor(
    private readonly tabs: ChatTabController,
    private readonly sessions: ChatTabHostSessionManager,
  ) {}

  async focus(address: ChatTabActionAddress): Promise<ChatTabHostActionResult> {
    const validated = this.tabs.validateAction(address);
    if (!validated.ok) return validated;
    if (!(await this.tabs.focusTab(address.tabId))) {
      return { ok: false, reason: "not_found" };
    }
    if (!validated.tab.sessionId) return { ok: true, tab: validated.tab };
    const session = await this.selectSession(validated.tab.sessionId);
    if (!session) return { ok: false, reason: "session_not_found" };
    return { ok: true, tab: validated.tab, session };
  }

  async newTab(
    address: ChatTabActionAddress,
    mode: string,
    projectId?: string,
  ): Promise<ChatTabHostActionResult> {
    const validated = this.tabs.validateAction(address);
    if (!validated.ok) return validated;

    const tab = await this.tabs.createTab();
    const session = await this.sessions.createSession(mode, {
      projectId,
      foreground: false,
    });
    const bound = await this.ensureBinding(tab.id, null, session.id);
    if (!bound) return { ok: false, reason: "binding_conflict" };
    if (this.tabs.getFocusedTabId() === tab.id) {
      this.sessions.switchTo(session.id);
    }
    return { ok: true, tab: bound, session };
  }

  async newChat(
    address: ChatTabActionAddress,
    mode: string,
    options: {
      projectId?: string;
      stopRunning?: boolean;
      focus?: boolean;
    } = {},
  ): Promise<ChatTabHostActionResult> {
    const validated = this.tabs.validateAction(address);
    if (!validated.ok) return validated;
    if (this.isBusy(validated.tab) && options.stopRunning !== true) {
      return {
        ok: false,
        reason: "confirmation_required",
        action: "new_chat",
        tab: validated.tab,
      };
    }

    if (options.focus !== false) {
      const focused = await this.focus(address);
      if (!focused.ok) return focused;
    }
    await this.stopForReplacement(validated.tab, options.stopRunning === true);

    const session = await this.sessions.createSession(mode, {
      projectId: options.projectId,
      foreground: false,
    });
    const bound = await this.ensureBinding(
      validated.tab.id,
      validated.tab.sessionId,
      session.id,
    );
    if (!bound) return { ok: false, reason: "binding_conflict" };
    if (
      options.focus !== false &&
      this.tabs.getFocusedTabId() === validated.tab.id
    ) {
      this.sessions.switchTo(session.id);
    }
    return { ok: true, tab: bound, session };
  }

  async close(
    address: ChatTabActionAddress,
    stopRunning = false,
  ): Promise<ChatTabHostActionResult> {
    const validated = this.tabs.validateAction(address);
    if (!validated.ok) return validated;
    if (this.isBusy(validated.tab) && !stopRunning) {
      return {
        ok: false,
        reason: "confirmation_required",
        action: "close",
        tab: validated.tab,
      };
    }

    if (this.tabs.getFocusedTabId() === validated.tab.id) {
      const survivor = this.tabs
        .getLayout()
        .tabs.find(
          (candidate) =>
            candidate.id !== validated.tab.id &&
            candidate.placement === "docked",
        );
      if (!survivor) return { ok: false, reason: "close_blocked" };
      await this.tabs.focusTab(survivor.id);
      if (survivor.sessionId) {
        const session = await this.selectSession(survivor.sessionId);
        if (!session) return { ok: false, reason: "session_not_found" };
      }
    }

    await this.stopForReplacement(validated.tab, stopRunning);
    if (!(await this.tabs.closeTab(validated.tab.id))) {
      return { ok: false, reason: "close_blocked" };
    }
    return { ok: true, tab: validated.tab };
  }

  async loadSession(
    address: ChatTabActionAddress,
    targetSessionId: string,
    options: { stopRunning?: boolean; focus?: boolean } = {},
  ): Promise<ChatTabHostActionResult> {
    const validated = this.tabs.validateAction(address);
    if (!validated.ok) return validated;

    const existing = this.tabs.getTabForSession(targetSessionId);
    if (existing) {
      if (options.focus === false) {
        const session = this.sessions.getSession(targetSessionId);
        return session
          ? { ok: true, tab: existing, session }
          : { ok: false, reason: "session_not_found" };
      }
      const focused = await this.focus({
        controllerEpoch: address.controllerEpoch,
        tabId: existing.id,
        sessionId: existing.sessionId,
      });
      return focused;
    }

    if (this.isBusy(validated.tab) && options.stopRunning !== true) {
      return {
        ok: false,
        reason: "confirmation_required",
        action: "load_session",
        tab: validated.tab,
        targetSessionId,
      };
    }

    if (options.focus !== false) {
      const focused = await this.focus(address);
      if (!focused.ok) return focused;
    }
    await this.stopForReplacement(validated.tab, options.stopRunning === true);
    const session =
      options.focus === false
        ? await this.sessions.hydratePersistedSession(targetSessionId)
        : await this.sessions.loadPersistedSession(targetSessionId);
    if (!session) return { ok: false, reason: "session_not_found" };
    const bound = await this.ensureBinding(
      validated.tab.id,
      validated.tab.sessionId,
      session.id,
    );
    return bound
      ? { ok: true, tab: bound, session }
      : { ok: false, reason: "binding_conflict" };
  }

  async reorder(
    address: ChatTabActionAddress,
    tabIds: readonly string[],
  ): Promise<ChatTabHostActionResult> {
    const validated = this.tabs.validateAction(address);
    if (!validated.ok) return validated;
    if (!(await this.tabs.reorderTabs(tabIds))) {
      return { ok: false, reason: "invalid_order" };
    }
    return { ok: true, tab: validated.tab };
  }

  private async selectSession(sessionId: string): Promise<AgentSession | null> {
    const inMemory = this.sessions.getSession(sessionId);
    if (inMemory) {
      this.sessions.switchTo(sessionId);
      return inMemory;
    }
    return this.sessions.loadPersistedSession(sessionId);
  }

  private isBusy(tab: ChatTab): boolean {
    if (!tab.sessionId) return false;
    const info = this.sessions
      .getSessionInfos()
      .find((candidate) => candidate.id === tab.sessionId);
    return (
      isChatTabSessionBusy(info) ||
      this.sessions.getSession(tab.sessionId)?.hasQueuedUiMessages === true
    );
  }

  private async stopForReplacement(
    tab: ChatTab,
    confirmed: boolean,
  ): Promise<void> {
    if (!tab.sessionId || !confirmed) return;
    this.sessions
      .getSession(tab.sessionId)
      ?.setQueuedUiMessageCount("vscode", 0);
    await this.sessions.stopSessionAndWait(tab.sessionId);
  }

  private async ensureBinding(
    tabId: string,
    expectedSessionId: string | null,
    sessionId: string,
  ): Promise<ChatTab | null> {
    const current = this.tabs.getTab(tabId);
    if (!current) return null;
    if (current.sessionId === sessionId) return current;
    const result = await this.tabs.replaceSession(
      tabId,
      expectedSessionId,
      sessionId,
    );
    return result.ok ? result.tab : null;
  }
}
