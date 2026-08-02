import type {
  ChatTab,
  ChatTabLayout,
  ChatTabPlacement,
} from "./ChatTabController.js";

interface RestoredSession {
  id: string;
}

export interface ChatTabStartupRestoreHost {
  getLayout(): ChatTabLayout;
  getFocusedTab(): ChatTab;
  getForegroundSession(): RestoredSession | undefined;
  getSession(sessionId: string): RestoredSession | undefined;
  getTabForSession(sessionId: string): ChatTab | undefined;
  hydratePersistedSession(sessionId: string): Promise<RestoredSession | null>;
  restoreLastSession(): Promise<RestoredSession | null>;
  restorePersistedBackgroundSessions(
    rootSessionIds: ReadonlySet<string>,
  ): Promise<unknown>;
  switchTo(sessionId: string): void;
  createTab(sessionId: string): Promise<ChatTab>;
  focusTab(tabId: string): Promise<boolean>;
  setPlacement(
    tabId: string,
    expectedPlacement: ChatTabPlacement,
    placement: ChatTabPlacement,
  ): Promise<unknown>;
  replaceSession(
    tabId: string,
    expectedSessionId: string | null,
    sessionId: string | null,
  ): Promise<unknown>;
}

export interface ChatTabStartupRestoreResult {
  superseded: boolean;
  hadRestorableSession: boolean;
}

async function focusCurrentForeground(
  host: ChatTabStartupRestoreHost,
): Promise<string | undefined> {
  const visited = new Set<string>();
  let foregroundId = host.getForegroundSession()?.id;
  while (foregroundId && !visited.has(foregroundId)) {
    visited.add(foregroundId);
    const existing = host.getTabForSession(foregroundId);
    if (existing) {
      if (existing.placement === "popped") {
        await host.setPlacement(existing.id, "popped", "docked");
      }
      await host.focusTab(existing.id);
    } else {
      await host.createTab(foregroundId);
    }
    const currentForegroundId = host.getForegroundSession()?.id;
    if (currentForegroundId === foregroundId) return foregroundId;
    foregroundId = currentForegroundId;
  }
  return undefined;
}

export async function restoreChatTabStartup(
  host: ChatTabStartupRestoreHost,
): Promise<ChatTabStartupRestoreResult> {
  const initialForegroundId = host.getForegroundSession()?.id;
  const restoredRootSessionIds = new Set<string>();

  for (const tab of host.getLayout().tabs) {
    if (!tab.sessionId) continue;
    const session = await host.hydratePersistedSession(tab.sessionId);
    if (session) {
      restoredRootSessionIds.add(session.id);
      continue;
    }
    if (tab.placement === "popped") {
      await host.setPlacement(tab.id, "popped", "docked");
    }
    await host.replaceSession(tab.id, tab.sessionId, null);
  }

  await host.restorePersistedBackgroundSessions(restoredRootSessionIds);

  const foregroundId = await focusCurrentForeground(host);
  if (foregroundId) {
    return {
      superseded: foregroundId !== initialForegroundId,
      hadRestorableSession: true,
    };
  }

  let focusedTab = host.getFocusedTab();
  if (!focusedTab.sessionId || !host.getSession(focusedTab.sessionId)) {
    const fallback = host
      .getLayout()
      .tabs.find(
        (tab) =>
          tab.placement === "docked" &&
          tab.sessionId !== null &&
          host.getSession(tab.sessionId) !== undefined,
      );
    if (fallback && (await host.focusTab(fallback.id))) {
      focusedTab = fallback;
    }
  }

  const foregroundAfterFocusId = await focusCurrentForeground(host);
  if (foregroundAfterFocusId) {
    return {
      superseded: foregroundAfterFocusId !== initialForegroundId,
      hadRestorableSession: true,
    };
  }

  if (focusedTab.sessionId && host.getSession(focusedTab.sessionId)) {
    host.switchTo(focusedTab.sessionId);
    return { superseded: false, hadRestorableSession: true };
  }

  const restored = await host.restoreLastSession();
  const finalForegroundId = await focusCurrentForeground(host);
  if (finalForegroundId) {
    return {
      superseded: restored?.id !== finalForegroundId,
      hadRestorableSession: true,
    };
  }

  return { superseded: false, hadRestorableSession: false };
}
