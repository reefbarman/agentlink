import { randomUUID } from "crypto";

export const CHAT_TAB_LAYOUT_WORKSPACE_KEY = "agentLink.chatTabs.v1";
export const CHAT_TAB_LAYOUT_VERSION = 1;

export type ChatTabPlacement = "docked" | "popped";

export interface ChatTab {
  id: string;
  displayNumber: number;
  sessionId: string | null;
  placement: ChatTabPlacement;
  terminalGeneration: number;
}

export interface ChatTabLayout {
  version: typeof CHAT_TAB_LAYOUT_VERSION;
  tabs: ChatTab[];
  nextDisplayNumber: number;
}

export interface ChatTabWorkspaceState {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

export interface ChatTabControllerOptions {
  createId?: () => string;
  log?: (message: string) => void;
}

export type ReplaceChatTabSessionResult =
  | { ok: true; tab: ChatTab }
  | { ok: false; reason: "not_found" | "conflict" | "already_open" };

export class ChatTabController {
  private layout: ChatTabLayout;
  private focusedTabId: string;
  private readonly listeners = new Set<(layout: ChatTabLayout) => void>();
  private saveQueue: Promise<void> = Promise.resolve();
  private readonly createId: () => string;
  private readonly log?: (message: string) => void;
  private needsInitialPersist: boolean;

  constructor(
    private readonly workspaceState: ChatTabWorkspaceState,
    options: ChatTabControllerOptions = {},
  ) {
    this.createId = options.createId ?? randomUUID;
    this.log = options.log;
    const restored = this.restoreLayout(
      workspaceState.get<unknown>(CHAT_TAB_LAYOUT_WORKSPACE_KEY),
    );
    this.layout = restored.layout;
    this.needsInitialPersist = restored.repaired;
    this.focusedTabId = this.firstDockedTab(this.layout).id;
  }

  async initialize(): Promise<void> {
    if (!this.needsInitialPersist) return;
    this.needsInitialPersist = false;
    await this.persist();
  }

  dispose(): void {
    this.listeners.clear();
  }

  onDidChange(listener: (layout: ChatTabLayout) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  getLayout(): ChatTabLayout {
    return structuredClone(this.layout);
  }

  getFocusedTabId(): string {
    return this.focusedTabId;
  }

  getFocusedTab(): ChatTab {
    return structuredClone(this.requireTab(this.focusedTabId));
  }

  getTab(tabId: string): ChatTab | undefined {
    const tab = this.layout.tabs.find((candidate) => candidate.id === tabId);
    return tab ? structuredClone(tab) : undefined;
  }

  getTabForSession(sessionId: string): ChatTab | undefined {
    const tab = this.layout.tabs.find(
      (candidate) => candidate.sessionId === sessionId,
    );
    return tab ? structuredClone(tab) : undefined;
  }

  async focusTab(tabId: string): Promise<boolean> {
    const tab = this.layout.tabs.find((candidate) => candidate.id === tabId);
    if (!tab || tab.placement !== "docked") return false;
    this.focusedTabId = tabId;
    return true;
  }

  async createTab(sessionId: string | null = null): Promise<ChatTab> {
    if (sessionId) {
      const existing = this.getTabForSession(sessionId);
      if (existing) {
        if (existing.placement === "docked") this.focusedTabId = existing.id;
        return existing;
      }
    }
    const tab: ChatTab = {
      id: this.createUniqueId(),
      displayNumber: this.layout.nextDisplayNumber,
      sessionId,
      placement: "docked",
      terminalGeneration: 1,
    };
    this.layout = {
      ...this.layout,
      tabs: [...this.layout.tabs, tab],
      nextDisplayNumber: tab.displayNumber + 1,
    };
    this.focusedTabId = tab.id;
    await this.commit();
    return structuredClone(tab);
  }

  async bindFocusedSession(sessionId: string): Promise<ChatTab> {
    const existing = this.layout.tabs.find(
      (candidate) => candidate.sessionId === sessionId,
    );
    if (existing) {
      if (existing.placement === "docked") this.focusedTabId = existing.id;
      return structuredClone(existing);
    }
    const focused = this.requireTab(this.focusedTabId);
    if (focused.sessionId === sessionId) return structuredClone(focused);
    const next = { ...focused, sessionId };
    this.replaceTab(next);
    await this.commit();
    return structuredClone(next);
  }

  async replaceSession(
    tabId: string,
    expectedSessionId: string | null,
    sessionId: string | null,
  ): Promise<ReplaceChatTabSessionResult> {
    const tab = this.layout.tabs.find((candidate) => candidate.id === tabId);
    if (!tab) return { ok: false, reason: "not_found" };
    if (tab.sessionId !== expectedSessionId) {
      return { ok: false, reason: "conflict" };
    }
    if (
      sessionId !== null &&
      this.layout.tabs.some(
        (candidate) =>
          candidate.id !== tabId && candidate.sessionId === sessionId,
      )
    ) {
      return { ok: false, reason: "already_open" };
    }
    if (sessionId === tab.sessionId) {
      return { ok: true, tab: structuredClone(tab) };
    }
    const next = {
      ...tab,
      sessionId,
      terminalGeneration: tab.terminalGeneration + 1,
    };
    this.replaceTab(next);
    await this.commit();
    return { ok: true, tab: structuredClone(next) };
  }

  async reorderTabs(tabIds: readonly string[]): Promise<boolean> {
    if (
      tabIds.length !== this.layout.tabs.length ||
      new Set(tabIds).size !== this.layout.tabs.length
    ) {
      return false;
    }
    const byId = new Map(this.layout.tabs.map((tab) => [tab.id, tab]));
    const tabs = tabIds.map((id) => byId.get(id));
    if (tabs.some((tab) => !tab)) return false;
    this.layout = { ...this.layout, tabs: tabs as ChatTab[] };
    await this.commit();
    return true;
  }

  async setPlacement(
    tabId: string,
    placement: ChatTabPlacement,
  ): Promise<boolean> {
    const tab = this.layout.tabs.find((candidate) => candidate.id === tabId);
    if (!tab) return false;
    if (tab.placement === placement) return true;
    if (
      placement === "popped" &&
      this.layout.tabs.filter((candidate) => candidate.placement === "docked")
        .length === 1
    ) {
      return false;
    }
    const next = { ...tab, placement };
    this.replaceTab(next);
    if (this.focusedTabId === tabId && placement === "popped") {
      this.focusedTabId = this.firstDockedTab(this.layout).id;
    }
    await this.commit();
    return true;
  }

  async closeTab(tabId: string): Promise<boolean> {
    const tab = this.layout.tabs.find((candidate) => candidate.id === tabId);
    if (!tab || this.layout.tabs.length === 1) return false;
    if (
      tab.placement === "docked" &&
      this.layout.tabs.filter((candidate) => candidate.placement === "docked")
        .length === 1
    ) {
      return false;
    }
    this.layout = {
      ...this.layout,
      tabs: this.layout.tabs.filter((candidate) => candidate.id !== tabId),
    };
    if (this.focusedTabId === tabId) {
      this.focusedTabId = this.firstDockedTab(this.layout).id;
    }
    await this.commit();
    return true;
  }

  private replaceTab(tab: ChatTab): void {
    this.layout = {
      ...this.layout,
      tabs: this.layout.tabs.map((candidate) =>
        candidate.id === tab.id ? tab : candidate,
      ),
    };
  }

  private async commit(): Promise<void> {
    const snapshot = this.getLayout();
    await this.persist(snapshot);
    for (const listener of this.listeners) listener(structuredClone(snapshot));
  }

  private persist(snapshot = this.getLayout()): Promise<void> {
    const write = this.saveQueue
      .catch(() => undefined)
      .then(() =>
        Promise.resolve(
          this.workspaceState.update(CHAT_TAB_LAYOUT_WORKSPACE_KEY, snapshot),
        ),
      );
    this.saveQueue = write;
    return write.catch((error) => {
      this.log?.(`[chat-tabs] Failed to persist tab layout: ${String(error)}`);
      throw error;
    });
  }

  private restoreLayout(raw: unknown): {
    layout: ChatTabLayout;
    repaired: boolean;
  } {
    if (!raw || typeof raw !== "object") {
      return { layout: this.createDefaultLayout(), repaired: true };
    }
    const candidate = raw as Partial<ChatTabLayout>;
    if (
      candidate.version !== CHAT_TAB_LAYOUT_VERSION ||
      !Array.isArray(candidate.tabs)
    ) {
      return { layout: this.createDefaultLayout(), repaired: true };
    }

    let repaired = false;
    const ids = new Set<string>();
    const displayNumbers = new Set<number>();
    const sessionIds = new Set<string>();
    const tabs: ChatTab[] = [];
    let nextRepairDisplayNumber = 1;

    for (const value of candidate.tabs) {
      if (!value || typeof value !== "object") {
        repaired = true;
        continue;
      }
      const tab = value as Partial<ChatTab>;
      if (typeof tab.id !== "string" || !tab.id || ids.has(tab.id)) {
        repaired = true;
        continue;
      }
      ids.add(tab.id);

      let displayNumber =
        Number.isInteger(tab.displayNumber) && (tab.displayNumber ?? 0) > 0
          ? tab.displayNumber!
          : 0;
      if (displayNumber === 0 || displayNumbers.has(displayNumber)) {
        repaired = true;
        while (displayNumbers.has(nextRepairDisplayNumber)) {
          nextRepairDisplayNumber += 1;
        }
        displayNumber = nextRepairDisplayNumber;
      }
      displayNumbers.add(displayNumber);
      nextRepairDisplayNumber = Math.max(
        nextRepairDisplayNumber,
        displayNumber + 1,
      );

      let sessionId =
        typeof tab.sessionId === "string" && tab.sessionId
          ? tab.sessionId
          : null;
      if (sessionId && sessionIds.has(sessionId)) {
        repaired = true;
        sessionId = null;
      }
      if (sessionId) sessionIds.add(sessionId);

      const placement =
        tab.placement === "popped" || tab.placement === "docked"
          ? tab.placement
          : "docked";
      if (placement !== tab.placement) repaired = true;
      const terminalGeneration =
        Number.isInteger(tab.terminalGeneration) &&
        (tab.terminalGeneration ?? 0) > 0
          ? tab.terminalGeneration!
          : 1;
      if (terminalGeneration !== tab.terminalGeneration) repaired = true;

      tabs.push({
        id: tab.id,
        displayNumber,
        sessionId,
        placement,
        terminalGeneration,
      });
    }

    if (tabs.length === 0) {
      return { layout: this.createDefaultLayout(), repaired: true };
    }
    if (!tabs.some((tab) => tab.placement === "docked")) {
      tabs[0] = { ...tabs[0], placement: "docked" };
      repaired = true;
    }
    const minimumNextDisplayNumber =
      Math.max(...tabs.map((tab) => tab.displayNumber)) + 1;
    const nextDisplayNumber =
      Number.isInteger(candidate.nextDisplayNumber) &&
      candidate.nextDisplayNumber! >= minimumNextDisplayNumber
        ? candidate.nextDisplayNumber!
        : minimumNextDisplayNumber;
    if (nextDisplayNumber !== candidate.nextDisplayNumber) repaired = true;

    return {
      layout: {
        version: CHAT_TAB_LAYOUT_VERSION,
        tabs,
        nextDisplayNumber,
      },
      repaired,
    };
  }

  private createDefaultLayout(): ChatTabLayout {
    return {
      version: CHAT_TAB_LAYOUT_VERSION,
      tabs: [
        {
          id: this.createUniqueId(),
          displayNumber: 1,
          sessionId: null,
          placement: "docked",
          terminalGeneration: 1,
        },
      ],
      nextDisplayNumber: 2,
    };
  }

  private createUniqueId(): string {
    let id = this.createId();
    while (this.layout?.tabs.some((tab) => tab.id === id)) {
      id = this.createId();
    }
    return id;
  }

  private firstDockedTab(layout: ChatTabLayout): ChatTab {
    const tab = layout.tabs.find(
      (candidate) => candidate.placement === "docked",
    );
    if (!tab) throw new Error("Chat tab layout must contain a docked tab");
    return tab;
  }

  private requireTab(tabId: string): ChatTab {
    const tab = this.layout.tabs.find((candidate) => candidate.id === tabId);
    if (!tab) throw new Error(`Unknown chat tab '${tabId}'`);
    return tab;
  }
}
