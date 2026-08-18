// @vitest-environment jsdom
//
// Composition-boundary tests for the session-less chat tab seam: a reloaded
// tab layout can reference a session that was never persisted (an empty New
// Chat at reload time). The startup restore unbinds such tabs; selecting one
// must yield a usable New Chat composer, not a starved "Checking model setup"
// placeholder. These tests run the production wiring end to end: real
// SessionStore, AgentSessionManager, ChatTabController, ChatTabHostCoordinator
// and ChatViewProvider on the host side, piped into the real webview App.
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { pathToFileURL } from "url";

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/preact";

import type { AgentConfig } from "../types.js";

const mocks = vi.hoisted(() => {
  let nextId = 0;
  const createSession = vi.fn(async (opts: any): Promise<any> => {
    nextId += 1;
    const messages: any[] = [];
    const session: any = {
      id: `created-${nextId}`,
      mode: opts.mode,
      agentMode: opts.agentMode,
      model: opts.config?.model ?? "claude-sonnet-4-6",
      providerId: opts.providerId,
      projectScope: opts.projectScope,
      projectAvailability: "available",
      title: "New Chat",
      createdAt: 0,
      lastActiveAt: 0,
      background: Boolean(opts.background),
      status: "idle",
      messageCount: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
      lastInputTokens: 0,
      lastOutputTokens: 0,
      lastCacheReadTokens: 0,
      reasoningEffort: "high",
      thinkingBudget: 0,
      autoCondenseThreshold: 0.9,
      contextBreakdown: {
        prompt: { sections: [], totalChars: 7, estimatedTokens: 2 },
      },
      currentTool: undefined,
      runState: undefined,
      isAborted: false,
      abortGeneration: 0,
      hasQueuedUiMessages: false,
      getLoadedSkills: vi.fn(() => []),
      getAllMessages: vi.fn(() => messages),
      getActiveSkillAllowedTools: vi.fn(() => undefined),
      getAdvertisedSkills: vi.fn(() => []),
      getSkillCatalogProjection: vi.fn(() => undefined),
      restoreFromStore: vi.fn((data: any) => {
        Object.assign(session, data);
        messages.splice(0, messages.length, ...(data.messages ?? []));
        session.messageCount = messages.length;
      }),
      rebuildSystemPrompt: vi.fn(async () => {}),
      refreshModeInstructionAnchor: vi.fn(async () => {}),
      consumePendingInterjection: vi.fn(() => null),
      consumePendingModeResume: vi.fn(() => null),
      queuePendingModeResume: vi.fn(),
      setQueuedUiMessageCount: vi.fn(),
      autoTitle: vi.fn(),
      updateModelSelection: vi.fn(async () => {}),
      setMode: vi.fn(async () => {}),
      addUserMessage: vi.fn(),
      appendRuntimeError: vi.fn(),
    };
    return session;
  });
  return {
    createSession,
    getConfiguration: vi.fn(() => ({
      get: () => undefined,
      inspect: () => undefined,
    })),
  };
});

vi.mock("vscode", async () => {
  const actual = await vi.importActual<
    typeof import("../../__mocks__/vscode.js")
  >("../../__mocks__/vscode.js");
  class RelativePattern {
    constructor(
      readonly base: unknown,
      readonly pattern: string,
    ) {}
  }
  return {
    ...actual,
    RelativePattern,
    ColorThemeKind: {
      Light: 1,
      Dark: 2,
      HighContrast: 3,
      HighContrastLight: 4,
    },
    UIKind: { Desktop: 1, Web: 2 },
    version: "1.0.0-test",
    env: {
      sessionId: "test",
      machineId: "test",
      appName: "test",
      appHost: "test",
      uriScheme: "vscode",
      language: "en",
      remoteName: undefined,
      uiKind: 1,
    },
    window: {
      ...(actual as any).window,
      activeColorTheme: { kind: 2 },
      onDidChangeActiveColorTheme: () => ({ dispose() {} }),
      activeTextEditor: undefined,
    },
    workspace: {
      ...(actual as any).workspace,
      getConfiguration: () => mocks.getConfiguration(),
      createFileSystemWatcher: () => ({
        onDidChange: () => ({ dispose() {} }),
        onDidCreate: () => ({ dispose() {} }),
        onDidDelete: () => ({ dispose() {} }),
        dispose() {},
      }),
    },
  };
});

vi.mock("../AgentSession.js", () => ({
  AgentSession: {
    create: (opts: unknown) => mocks.createSession(opts),
    createTranscriptOnly: (opts: unknown) => mocks.createSession(opts),
  },
}));

const makeConfig = (): AgentConfig => ({
  model: "claude-sonnet-4-6",
  maxTokens: 8192,
  thinkingBudget: 0,
  showThinking: false,
  autoCondense: true,
  autoCondenseThreshold: 0.9,
});

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

afterEach(() => cleanup());

/**
 * Boots the production host wiring against a temp workspace containing one
 * persisted session, restores a two-tab layout whose first tab references a
 * never-persisted "ghost" session, and pipes the host to a rendered App.
 */
async function bootWorkspace() {
  const workspace = fs.mkdtempSync(
    path.join(os.tmpdir(), "agentlink-sessionless-tab-"),
  );
  const workspaceFolderUri = pathToFileURL(workspace).toString();
  const projectScope = {
    schemaVersion: 1 as const,
    kind: "project" as const,
    projectId: (
      await import("../../core/workspaceProjects.js")
    ).createWorkspaceProjectId(workspaceFolderUri),
    workspaceFolderUri,
    displayName: workspace,
    rootPath: workspace,
  };

  const { SessionStore } = await import("../SessionStore.js");
  const seedStore = new SessionStore(workspace);
  await seedStore.saveSession({
    expectedRevision: null,
    session: {
      summary: {
        schemaVersion: 1 as const,
        id: "real-session",
        mode: "code",
        model: "claude-sonnet-4-6",
        title: "Real history",
        messageCount: 2,
        totalInputTokens: 10,
        totalOutputTokens: 5,
        createdAt: 100,
        lastActiveAt: 123,
        projectScope,
      },
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: [{ type: "text", text: "hi" }] },
      ] as never,
      metadata: {
        projectScope,
        mode: "code",
        model: "claude-sonnet-4-6",
        totalInputTokens: 10,
        totalOutputTokens: 5,
        totalCacheReadTokens: 0,
        totalCacheCreationTokens: 0,
        lastInputTokens: 0,
        lastCacheReadTokens: 0,
        loadedSkills: [],
        checkpointState: {
          projectId: projectScope.projectId,
          baseCommit: null,
          checkpoints: [],
        },
      },
    },
  });

  const { AgentSessionManager } = await import("../AgentSessionManager.js");
  const manager = new AgentSessionManager(
    makeConfig(),
    workspace,
    undefined,
    false,
    new SessionStore(workspace),
  );

  const layout = {
    version: 1,
    tabs: [
      {
        id: "tab-ghost",
        displayNumber: 1,
        sessionId: "ghost-session",
        placement: "docked",
        terminalGeneration: 1,
      },
      {
        id: "tab-real",
        displayNumber: 2,
        sessionId: "real-session",
        placement: "docked",
        terminalGeneration: 1,
      },
    ],
    nextDisplayNumber: 3,
  };
  const workspaceState = {
    store: new Map<string, unknown>([["agentLink.chatTabs.v1", layout]]),
    get<T>(key: string): T | undefined {
      return this.store.get(key) as T | undefined;
    },
    update(key: string, value: unknown) {
      this.store.set(key, value);
      return Promise.resolve();
    },
  };
  const { ChatTabController } = await import("../ChatTabController.js");
  const controller = new ChatTabController(workspaceState as never);
  await controller.initialize();

  const { ChatTabHostCoordinator } =
    await import("../ChatTabHostCoordinator.js");
  const coordinator = new ChatTabHostCoordinator(controller, manager as never);

  const { ChatViewProvider } = await import("../ChatViewProvider.js");
  const provider = new ChatViewProvider(
    { fsPath: path.join(workspace, "ext") } as never,
    { get: vi.fn(), update: vi.fn(async () => {}) } as never,
  );
  // The test provider registry has no configured models; emulate the
  // authenticated catalog a real install has.
  (provider as any).getBrowserModels = async () => [
    {
      id: "claude-sonnet-4-6",
      displayName: "Claude Sonnet",
      provider: "anthropic",
      providerDisplayName: "Anthropic",
      supportsToolUse: true,
      supportsImages: true,
      reasoningEfforts: ["none", "low", "high"],
      defaultReasoningEffort: "high",
      authenticated: true,
    },
  ];

  (provider as any).postMessage = (message: Record<string, unknown>) => {
    fireEvent(window, new MessageEvent("message", { data: message }));
  };
  (provider as any).webviewReady = true;
  provider.setSessionManager(manager as never);
  (provider as any).chatTabController = controller;
  (provider as any).chatTabHostCoordinator = coordinator;
  controller.onDidChangeWorkspace(() => {
    (provider as any).sendChatWorkspaceUpdate();
  });

  const { restoreChatTabStartup } = await import("../chatTabStartupRestore.js");
  const startupRestore = restoreChatTabStartup({
    getLayout: () => controller.getLayout(),
    getFocusedTab: () => controller.getFocusedTab(),
    getForegroundSession: () => manager.getForegroundSession(),
    getSession: (sessionId: string) => manager.getSession(sessionId),
    getTabForSession: (sessionId: string) =>
      controller.getTabForSession(sessionId),
    hydratePersistedSession: (sessionId: string) =>
      manager.hydratePersistedSession(sessionId),
    restoreLastSession: () => manager.restoreLastSession(),
    restorePersistedBackgroundSessions: (rootSessionIds: ReadonlySet<string>) =>
      manager.restorePersistedBackgroundSessions(rootSessionIds),
    switchTo: (sessionId: string) => manager.switchTo(sessionId),
    createTab: (sessionId: string) => controller.createTab(sessionId),
    focusTab: (tabId: string) => controller.focusTab(tabId),
    setPlacement: (tabId, expectedPlacement, placement) =>
      controller.setPlacement(tabId, expectedPlacement, placement),
    replaceSession: (tabId, expectedSessionId, sessionId) =>
      controller.replaceSession(tabId, expectedSessionId, sessionId),
  });
  provider.setChatTabStartupRestore(startupRestore);

  const sentToHost: Array<Record<string, unknown>> = [];
  const vscodeApi = {
    postMessage: (message: Record<string, unknown>) => {
      sentToHost.push(message);
      void (provider as any).handleWebviewMessage(message).catch(() => {});
    },
    getState: () => undefined,
    setState: () => {},
  };

  const { App } = await import("./App.js");
  const rendered = render(<App vscodeApi={vscodeApi as never} />);

  await (provider as any).hydrateReadyWebview();
  await startupRestore;

  return {
    container: rendered.container,
    controller,
    manager,
    sentToHost,
    workspace,
    cleanupWorkspace: () =>
      fs.rmSync(workspace, { recursive: true, force: true }),
  };
}

describe("session-less chat tab restore seam", () => {
  it("revives a restored ghost tab as a usable New Chat instead of starving it", async () => {
    const { container, controller, manager, cleanupWorkspaceSafe } =
      await bootWorkspace().then((boot) => ({
        ...boot,
        cleanupWorkspaceSafe: boot.cleanupWorkspace,
      }));
    try {
      // Startup restore unbinds the never-persisted session and promotes the
      // restorable one.
      expect(controller.getLayout().tabs.map((tab) => tab.sessionId)).toEqual([
        null,
        "real-session",
      ]);
      expect(manager.getForegroundSession()?.id).toBe("real-session");

      // The user switches to the ghost tab.
      const tabButtons =
        container.querySelectorAll<HTMLButtonElement>(".chat-tab-select");
      fireEvent.click(tabButtons[0]!);

      // The tab must become a usable New Chat: no "Checking model setup"
      // block, composer available, send enabled.
      await waitFor(
        () => {
          expect(
            container
              .querySelector(".chat-session-pane")
              ?.getAttribute("data-tab-key"),
          ).toBe("tab-ghost:new");
          expect(screen.queryByText("Checking model setup")).toBeNull();
          expect(container.querySelector(".chat-input")).not.toBeNull();
        },
        { timeout: 15000 },
      );

      // Sending from the revived tab creates a session bound to that tab.
      const composer = container.querySelector(
        ".chat-input",
      ) as HTMLTextAreaElement;
      fireEvent.input(composer, { target: { value: "message from tab" } });
      fireEvent.click(screen.getByTitle("Send message (Enter)"));
      await waitFor(
        () => {
          const ghostTab = controller
            .getLayout()
            .tabs.find((tab) => tab.id === "tab-ghost");
          expect(ghostTab?.sessionId).toBeTruthy();
          expect(manager.getForegroundSession()?.id).toBe(ghostTab?.sessionId);
        },
        { timeout: 15000 },
      );
    } finally {
      cleanupWorkspaceSafe();
    }
  }, 30000);

  it("unbinds and revives a tab whose bound session record disappeared", async () => {
    const boot = await bootWorkspace();
    const { container, controller } = boot;
    try {
      // Simulate a binding that survived restore but whose record is gone
      // (e.g. history deleted from another window while this one was open).
      const rebound = await controller.replaceSession(
        "tab-ghost",
        null,
        "deleted-session",
      );
      expect(rebound.ok).toBe(true);

      const tabButtons =
        container.querySelectorAll<HTMLButtonElement>(".chat-tab-select");
      fireEvent.click(tabButtons[0]!);

      await waitFor(
        () => {
          const ghostTab = controller
            .getLayout()
            .tabs.find((tab) => tab.id === "tab-ghost");
          expect(ghostTab?.sessionId).toBeNull();
          expect(
            container
              .querySelector(".chat-session-pane")
              ?.getAttribute("data-tab-key"),
          ).toBe("tab-ghost:new");
          expect(screen.queryByText("Checking model setup")).toBeNull();
          expect(container.querySelector(".chat-input")).not.toBeNull();
        },
        { timeout: 15000 },
      );
    } finally {
      boot.cleanupWorkspace();
    }
  }, 30000);
});
