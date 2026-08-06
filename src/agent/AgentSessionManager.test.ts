import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { pathToFileURL } from "url";

import type { AgentConfig, AgentMessage } from "./types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AgentSessionManager,
  recoverInterruptedRunMessages,
} from "./AgentSessionManager.js";
import { ProjectCustomizationRegistry } from "./ProjectCustomizationRegistry.js";
import { SessionStore } from "./SessionStore.js";
import { WorkspaceMutationCoordinator } from "./WorkspaceMutationCoordinator.js";
import type {
  PersistedSessionRecord,
  PersistedSessionRunState,
} from "./persistenceContracts.js";
import { ProviderRegistry } from "./providers/index.js";
import { buildContextLedger } from "../core/contextLedger.js";
import {
  createWorkspaceProjectId,
  isProjectlessSessionScope,
} from "../core/workspaceProjects.js";

const mocks = vi.hoisted(() => {
  let skillCatalogProjection: any;
  let advertisedSkills: any[] = [];
  const resolveTestPromptProfile = (session: {
    model: string;
    providerId?: string;
    promptProfileOverrides?: Readonly<
      Record<string, "compatibility" | "reasoning">
    >;
  }) => {
    const override = session.promptProfileOverrides?.[session.model];
    return {
      profile: override ?? "compatibility",
      source: override ? "exact-model-override" : "compatibility-default",
      policyRevision: "prompt-profile-policy-v1",
      ...(session.providerId ? { providerId: session.providerId } : {}),
      modelId: session.model,
    };
  };
  const createSession = vi.fn(async (opts: any): Promise<any> => {
    const promptProfileOverrides =
      opts.projectScope?.projectId === "projectless" &&
      opts.projectScope?.workspaceFolderUri === "agentlink://projectless"
        ? undefined
        : opts.config.promptProfileOverrides;
    const session: any = {
      id: "session-1",
      mode: opts.mode,
      agentMode: opts.agentMode,
      model: opts.config.model,
      providerId: opts.providerId,
      promptProfileOverrides,
      projectScope: opts.projectScope,
      projectAvailability: opts.projectAvailability ?? "available",
      activeFilePath: opts.activeFilePath,
      activeContextResourceUri: opts.activeContextResourceUri,
      requireProjectRoot: vi.fn(() => opts.projectScope.rootPath),
      autoCondenseThreshold: opts.config.autoCondenseThreshold,
      reasoningEffort: "high",
      thinkingBudget: opts.config.thinkingBudget,
      title: "New Chat",
      background: Boolean(opts.background),
      modeInstructionPlacement:
        opts.background || opts.isBackground || opts.lightweight
          ? "system"
          : "conversation",
      status: "idle",
      messageCount: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
      lastInputTokens: 0,
      lastOutputTokens: 0,
      lastCacheReadTokens: 0,
      contextBreakdown: {
        prompt: { sections: [], totalChars: 7, estimatedTokens: 2 },
      },
      currentTool: undefined,
      addUserMessage: vi.fn(),
      appendRuntimeError: vi.fn(),
      consumePendingInterjection: vi.fn(() => null),
      queuePendingModeResume: vi.fn(),
      consumePendingModeResume: vi.fn(() => null),
      autoTitle: vi.fn(),
      getAllMessages: vi.fn(() => []),
      getActiveSkillAllowedTools: vi.fn(() => undefined),
      getAdvertisedSkills: vi.fn(() => advertisedSkills),
      getSkillCatalogProjection: vi.fn(() => skillCatalogProjection),
      restoreFromStore: vi.fn(),
      rebuildSystemPrompt: vi.fn(async () => {}),
      refreshModeInstructionAnchor: vi.fn(async () => {}),
      updateModelSelection: vi.fn(async function (
        this: { model: string; providerId: string | undefined },
        model: string,
        providerId: string | undefined,
      ) {
        this.model = model;
        this.providerId = providerId;
      }),
      setMode: vi.fn(async function (this: { mode: string }, mode: string) {
        this.mode = mode;
      }),
    };
    session.promptProfile = resolveTestPromptProfile(session);
    return session;
  });

  return {
    createSession,
    getConfiguration: vi.fn(),
    setSkillCatalog(projection: any, skills: any[]) {
      skillCatalogProjection = projection;
      advertisedSkills = skills;
    },
  };
});

vi.mock("vscode", async () => {
  const actual = await vi.importActual<typeof import("../__mocks__/vscode.js")>(
    "../__mocks__/vscode.js",
  );
  return {
    ...actual,
    workspace: {
      ...actual.workspace,
      getConfiguration: (...args: unknown[]) => {
        const config = mocks.getConfiguration(...args);
        return {
          ...config,
          get: (key: string, ...getArgs: unknown[]) => {
            if (
              key === "webAccess.searchBackend" ||
              key === "webAccess.fetchBackend"
            ) {
              return "disabled";
            }
            return config.get(key, ...getArgs);
          },
        };
      },
    },
  };
});

vi.mock("./AgentSession.js", () => ({
  AgentSession: {
    create: (opts: unknown) => mocks.createSession(opts),
    createTranscriptOnly: (opts: unknown) => mocks.createSession(opts),
  },
}));

async function flushPromises(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

function addCurrentMutationMetadata(
  manager: AgentSessionManager,
  sessionId: string,
  root = "/tmp",
): void {
  const checkpoint = manager.getCheckpoints(sessionId)[0];
  if (!checkpoint?.projectId) throw new Error("Missing checkpoint fixture");
  checkpoint.projectSnapshots = [
    {
      projectId: checkpoint.projectId,
      commitHash: checkpoint.commitHash,
      createdAt: checkpoint.createdAt,
      mutation: (manager as any).host.workspaceMutationCoordinator.getSnapshot(
        root,
        sessionId,
      ),
    },
  ];
}

const makeConfig = (): AgentConfig => ({
  model: "claude-sonnet-4-6",
  maxTokens: 8192,
  thinkingBudget: 0,
  showThinking: false,
  autoCondense: true,
  autoCondenseThreshold: 0.9,
});

describe("AgentSessionManager host injection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.setSkillCatalog(undefined, []);
    mocks.getConfiguration.mockReturnValue({
      get: () => undefined,
      inspect: () => undefined,
    });
  });

  it("publishes committed skill catalog fallback updates without blocking sessions", async () => {
    const update = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(() => {
        throw new Error("retrieval unavailable");
      });
    const remove = vi.fn(async () => undefined);
    const skill = {
      id: "project:agentlink:.agentlink/skills/omitted",
      name: "omitted",
      description: "Omitted skill metadata",
      revision: "skill-revision",
      invocation: "auto",
      recommendations: ["related"],
      enabled: true,
    };
    const projection = (revision: string) => ({
      revision,
      omissions: [
        {
          id: skill.id,
          name: skill.name,
          revision: skill.revision,
          reason: "budget",
        },
      ],
    });
    mocks.setSkillCatalog(projection("catalog-create"), [skill]);
    const log = vi.fn();
    const mgr = new AgentSessionManager(
      makeConfig(),
      "/tmp",
      undefined,
      false,
      undefined,
      log,
      undefined,
      { skillCatalogFallbackProvider: { update, remove } },
    );

    const session = await mgr.createSession("code");
    await flushPromises();
    expect(update).toHaveBeenLastCalledWith({
      publisherId: session.id,
      projectId: session.projectScope.projectId,
      catalogRevision: "catalog-create",
      observedAt: expect.any(String),
      entries: [
        {
          id: skill.id,
          name: skill.name,
          description: skill.description,
          revision: skill.revision,
          invocation: "auto",
          recommendations: ["related"],
        },
      ],
    });

    mocks.setSkillCatalog(projection("catalog-rebuild"), [skill]);
    await mgr.rebuildSystemPrompts();
    await flushPromises();
    expect(update).toHaveBeenLastCalledWith(
      expect.objectContaining({ catalogRevision: "catalog-rebuild" }),
    );

    mocks.setSkillCatalog(projection("catalog-mode"), [skill]);
    await expect(mgr.switchSessionMode(session.id, "ask")).resolves.toBe(
      session,
    );
    await flushPromises();
    expect(update).toHaveBeenLastCalledWith(
      expect.objectContaining({ catalogRevision: "catalog-mode" }),
    );
    expect(log).toHaveBeenCalledWith(
      `[skills] Failed to update retrieval fallback for session ${session.id}: Error: retrieval unavailable`,
    );
  });

  it("captures a root-tab terminal provider and clears the window-global fallback", async () => {
    const rawProvider = { executeCommand: vi.fn() } as any;
    const scopedProvider = { executeCommand: vi.fn() } as any;
    const terminalProviderForSession = vi
      .fn()
      .mockReturnValueOnce(scopedProvider)
      .mockReturnValueOnce(undefined);
    const mgr = new AgentSessionManager(
      makeConfig(),
      "/tmp",
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      { terminalProviderForSession },
    );
    mgr.setToolContext({
      approvalManager: { bindSessionProject: vi.fn() } as any,
      approvalPanel: {} as any,
      sessionId: "agent",
      extensionUri: {} as any,
      terminalProvider: rawProvider,
    });
    const session = await mgr.createSession("code");
    session.fleetMetadata = { rootSessionId: "root-session" } as any;

    const owned = (mgr as any).captureSessionToolContext(session);
    const unavailable = (mgr as any).captureSessionToolContext(session);

    expect(terminalProviderForSession).toHaveBeenNthCalledWith(
      1,
      session.id,
      "root-session",
    );
    expect(owned.terminalProvider).toBe(scopedProvider);
    expect(unavailable.terminalProvider).toBeUndefined();
  });

  it("forwards background question tool-call identity through the manager wrapper", async () => {
    const mgr = new AgentSessionManager(makeConfig(), "/tmp");
    const session = await mgr.createSession("code");
    (session as any).background = true;
    const onQuestion = vi.fn().mockResolvedValue({
      answers: { choice: "A" },
      notes: {},
    });
    const overrides = (mgr as any).buildBackgroundInteractionOverrides(
      session,
      "Review implementation",
      { onQuestion },
    );
    const questions = [
      {
        id: "choice",
        type: "multiple_choice",
        question: "Which option?",
        options: ["A", "B"],
        recommended: "A",
      },
    ];

    await overrides.onQuestion(
      "Choose.",
      questions,
      session.id,
      undefined,
      undefined,
      "tool-call-background-1",
    );

    expect(onQuestion).toHaveBeenCalledWith(
      "Choose.",
      questions,
      session.id,
      "Review implementation",
      undefined,
      "tool-call-background-1",
    );
  });

  it("acquires and marks a mutation lease at a late mutating boundary", async () => {
    const coordinator = new WorkspaceMutationCoordinator(undefined, {
      createEpoch: () => "test-epoch",
    });
    const mgr = new AgentSessionManager(
      makeConfig(),
      "/tmp",
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      {
        host: {
          workspaceMutationCoordinator: coordinator,
          createCheckpointManager: vi.fn(() => ({
            baseCommit: null,
            initialize: vi.fn(async () => true),
            createCheckpoint: vi.fn(async () => null),
            previewRevert: vi.fn(async () => null),
            revertToCheckpoint: vi.fn(async () => false),
            getDiffBetween: vi.fn(async () => ""),
          })),
        },
      },
    );
    mgr.setToolContext({
      approvalManager: { bindSessionProject: vi.fn() } as any,
      approvalPanel: {} as any,
      sessionId: "agent",
      extensionUri: {} as any,
    });
    const session = await mgr.createSession("code");
    const leaseHolder: {
      sessionId: string;
      lease?: { release(): void };
    } = { sessionId: session.id };
    const context = (mgr as any).captureSessionToolContext(
      session,
      undefined,
      undefined,
      leaseHolder,
    );

    expect(
      coordinator.getSnapshot("/tmp", "observer", session.id).generation,
    ).toBe(0);
    await context.prepareWorkspaceMutation();
    expect(
      coordinator.getSnapshot("/tmp", "observer", session.id).generation,
    ).toBe(1);
    expect(leaseHolder.lease).toBeDefined();

    (mgr as any).releaseWorkspaceMutationLease(leaseHolder);
    const nextLease = await coordinator.acquire(
      "other-session",
      coordinator.createDomain(["/tmp"]),
    );
    nextLease.release();
  });

  it("keeps mutation leases independent across foreground agent trees", async () => {
    const coordinator = new WorkspaceMutationCoordinator();
    const mgr = new AgentSessionManager(
      makeConfig(),
      "/tmp",
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      { host: { workspaceMutationCoordinator: coordinator } },
    );
    mgr.setToolContext({
      approvalManager: { bindSessionProject: vi.fn() } as any,
      approvalPanel: {} as any,
      sessionId: "agent",
      extensionUri: {} as any,
    });
    const first = await mgr.createSession("code");
    first.addUserMessage("first tab work");
    const second = await mgr.createSession("code");
    second.addUserMessage("second tab work");
    const firstDomain = (mgr as any).createWorkspaceMutationDomain(first);
    const secondDomain = (mgr as any).createWorkspaceMutationDomain(second);

    expect(firstDomain.scopeId).toBe(first.id);
    expect(secondDomain.scopeId).toBe(second.id);
    expect(firstDomain.roots).toEqual(secondDomain.roots);
  });

  it("creates an addressed session without changing foreground ownership", async () => {
    const defaultCreateSession = mocks.createSession.getMockImplementation();
    if (!defaultCreateSession)
      throw new Error("Missing session fixture factory");
    mocks.createSession
      .mockImplementationOnce(async (opts: any) => ({
        ...(await defaultCreateSession(opts)),
        id: "session-foreground",
      }))
      .mockImplementationOnce(async (opts: any) => ({
        ...(await defaultCreateSession(opts)),
        id: "session-addressed",
      }));
    const mgr = new AgentSessionManager(makeConfig(), "/tmp");
    const foreground = await mgr.createSession("code");
    const configBefore = mgr.getConfig();

    const addressed = await mgr.createSession("architect", {
      foreground: false,
    });

    expect(addressed.id).not.toBe(foreground.id);
    expect(addressed.mode).toBe("architect");
    expect(mgr.getSession(addressed.id)).toBe(addressed);
    expect(mgr.getForegroundSession()).toBe(foreground);
    expect(mgr.getConfig()).toEqual(configBefore);
  });

  it("updates model and reasoning for an addressed non-foreground session", async () => {
    const defaultCreateSession = mocks.createSession.getMockImplementation();
    if (!defaultCreateSession)
      throw new Error("Missing session fixture factory");
    const config = { ...makeConfig(), thinkingBudget: 1024 };
    const mgr = new AgentSessionManager(config, "/tmp");
    const foreground = await mgr.createSession("code");
    mgr.switchTo(foreground.id);
    const originalConfigModel = mgr.getConfig().model;
    const target = {
      ...(await defaultCreateSession({
        mode: "code",
        config,
        projectScope: foreground.projectScope,
      })),
      id: "session-target",
      model: "target-old-model",
      reasoningEffort: "none" as const,
      thinkingBudget: 0,
    };
    (mgr as any).sessions.set(target.id, target);
    const maybeAutoCondenseSession = vi
      .spyOn(mgr, "maybeAutoCondenseSession")
      .mockResolvedValue();

    await expect(
      mgr.setSessionModel(target.id, "target-new-model"),
    ).resolves.toBe("target-new-model");
    expect(mgr.setSessionReasoningEffort(target.id, "max")).toBe(true);

    expect(target.updateModelSelection).toHaveBeenCalledWith(
      "target-new-model",
      undefined,
      expect.objectContaining({ workspaceFolders: expect.any(Array) }),
    );
    expect(target.model).toBe("target-new-model");
    expect(target.reasoningEffort).toBe("max");
    expect(target.thinkingBudget).toBe(config.thinkingBudget);
    expect(maybeAutoCondenseSession).toHaveBeenCalledWith(target.id);
    expect(mgr.getForegroundSession()).toBe(foreground);
    expect(foreground.updateModelSelection).not.toHaveBeenCalled();
    expect(foreground.reasoningEffort).toBe("high");
    expect(mgr.getConfig().model).toBe(originalConfigModel);
  });

  it("falls back to an enabled model when saved selections use a disabled provider", async () => {
    const capabilities = {
      supportsThinking: true,
      supportsCaching: false,
      supportsImages: true,
      supportsToolUse: true,
      contextWindow: 200_000,
      maxOutputTokens: 8_192,
    };
    const providers = new ProviderRegistry();
    providers.register({
      id: "anthropic",
      displayName: "Anthropic",
      condenseModel: "claude-sonnet-4-6",
      isAuthenticated: vi.fn(async () => true),
      getCapabilities: vi.fn(() => capabilities),
      listModels: vi.fn(() => [
        {
          id: "claude-sonnet-4-6",
          displayName: "Claude Sonnet 4.6",
          provider: "anthropic",
          capabilities,
        },
      ]),
      stream: vi.fn(),
      complete: vi.fn(),
    } as any);
    providers.register({
      id: "codex",
      displayName: "Codex",
      condenseModel: "gpt-5.6-sol",
      isAuthenticated: vi.fn(async () => true),
      getCapabilities: vi.fn(() => capabilities),
      listModels: vi.fn(() => [
        {
          id: "gpt-5.6-sol",
          displayName: "GPT-5.6 Sol",
          provider: "codex",
          capabilities,
        },
      ]),
      stream: vi.fn(),
      complete: vi.fn(),
    } as any);
    providers.setDisabledProviders(["anthropic"]);
    const mgr = new AgentSessionManager(
      makeConfig(),
      "/tmp",
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      {
        host: {
          providers,
          config: {
            resolveModelForMode: () => "claude-sonnet-4-6",
            getCondenseThresholdForModel: () => 0.9,
            getBgSummaryMode: () => "heuristic",
            getBackgroundAgentSettings: () => ({}),
          },
        },
      },
    );

    const session = await mgr.createSession("code");

    expect(session.model).toBe("gpt-5.6-sol");
    expect(session.providerId).toBe("codex");
    expect(mgr.getConfig().model).toBe("gpt-5.6-sol");

    await expect(mgr.setModel("claude-sonnet-4-6")).rejects.toThrow(
      'Model "claude-sonnet-4-6" is not available.',
    );
    expect(session.model).toBe("gpt-5.6-sol");
    expect(mgr.getConfig().model).toBe("gpt-5.6-sol");
  });

  it("accepts an explicit model before providers finish registering", async () => {
    const mgr = new AgentSessionManager(makeConfig(), "/tmp");
    const session = await mgr.createSession("code");

    await expect(mgr.setModel("startup-model")).resolves.toBe("startup-model");
    expect(session.model).toBe("startup-model");
    expect(mgr.getConfig().model).toBe("startup-model");
  });

  it("creates only a tool-free Ask session when no workspace project exists", async () => {
    const createCheckpointManager = vi.fn();
    const loadCustomModes = vi.fn(async () => []);
    const projectCustomizationRegistry = new ProjectCustomizationRegistry({
      loadCustomModes,
      loadSlashCommands: vi.fn(async () => []),
    });
    const projectCatalog = {
      listProjects: () => [],
      resolveProjectForResource: () => undefined,
      resolvePersistedScope: (scope: never) => ({
        status: "missing" as const,
        scope,
      }),
    };
    const engine = { setToolRuntime: vi.fn() };
    const resolveModelForMode = vi.fn(
      (mode: string, fallbackModel: string, scope?: unknown) =>
        mode === "ask" && scope === undefined
          ? "openrouter-moonshotai-kimi-k3"
          : fallbackModel,
    );
    const providers = new ProviderRegistry();
    providers.register({
      id: "openai-compatible:openrouter-main",
      displayName: "OpenRouter",
      condenseModel: "openrouter-moonshotai-kimi-k3",
      isAuthenticated: vi.fn(async () => true),
      getCapabilities: vi.fn(() => ({
        supportsThinking: false,
        supportsCaching: false,
        supportsImages: true,
        supportsToolUse: true,
        contextWindow: 32_768,
        maxOutputTokens: 4_096,
      })),
      listModels: vi.fn(() => [
        {
          id: "openrouter-moonshotai-kimi-k3",
          displayName: "Kimi K3",
          provider: "openai-compatible:openrouter-main",
          capabilities: {
            supportsThinking: false,
            supportsCaching: false,
            supportsImages: true,
            supportsToolUse: true,
            contextWindow: 32_768,
            maxOutputTokens: 4_096,
          },
        },
      ]),
      stream: vi.fn(),
      complete: vi.fn(),
    } as any);
    const mgr = new AgentSessionManager(
      {
        ...makeConfig(),
        promptProfileOverrides: {
          "openrouter-moonshotai-kimi-k3": "reasoning",
        },
      },
      "/",
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      {
        projectCatalog,
        projectCustomizationRegistry,
        host: {
          providers,
          config: {
            resolveModelForMode,
            getCondenseThresholdForModel: () => 0.9,
            getBgSummaryMode: () => "heuristic",
            getBackgroundAgentSettings: () => ({}),
          },
          createCheckpointManager,
          createEngine: vi.fn(() => engine as never),
        },
      },
    );

    const session = await mgr.createSession("ask");

    expect(isProjectlessSessionScope(session.projectScope)).toBe(true);
    expect(session.agentMode.slug).toBe("ask");
    expect(session.model).toBe("openrouter-moonshotai-kimi-k3");
    expect(session.promptProfile).toMatchObject({
      profile: "compatibility",
      source: "compatibility-default",
      modelId: "openrouter-moonshotai-kimi-k3",
    });
    expect(resolveModelForMode).toHaveBeenCalledWith(
      "ask",
      makeConfig().model,
      undefined,
    );
    expect(loadCustomModes).not.toHaveBeenCalled();
    expect(createCheckpointManager).not.toHaveBeenCalled();
    expect((mgr as any).captureSessionToolContext(session)).toBeUndefined();
    expect(
      (mgr as any).bindCapturedEngineToSession(engine, session, undefined),
    ).toBeUndefined();
    expect(engine.setToolRuntime).toHaveBeenCalledWith(null);
    await expect(mgr.createSession("code")).rejects.toThrow(
      "Open an available workspace folder to start a session.",
    );
  });

  it("resolves conflicting custom mode definitions from each session project", async () => {
    const projectA = {
      id: "project-a",
      name: "Project A",
      uri: "file:///project-a",
      rootPath: "/project-a",
      availability: { status: "available" as const },
    };
    const projectB = {
      id: "project-b",
      name: "Project B",
      uri: "file:///project-b",
      rootPath: "/project-b",
      availability: { status: "available" as const },
    };
    const projectCatalog = {
      listProjects: () => [projectA, projectB],
      resolveProjectForResource: () => projectA,
      resolvePersistedScope: (scope: {
        projectId: string;
        workspaceFolderUri: string;
      }) => {
        const project = scope.projectId === projectB.id ? projectB : projectA;
        return {
          status: "available" as const,
          project,
          scope: {
            schemaVersion: 1 as const,
            kind: "project" as const,
            projectId: project.id,
            workspaceFolderUri: project.uri,
            displayName: project.name,
            rootPath: project.rootPath,
          },
        };
      },
    };
    const loadCustomModes = vi.fn(async (rootPath: string) => [
      {
        slug: "code",
        name: rootPath === projectA.rootPath ? "Code A" : "Code B",
        icon: "code",
        toolGroups:
          rootPath === projectA.rootPath ? ["read"] : ["read", "edit"],
        customInstructions:
          rootPath === projectA.rootPath ? "PROJECT A MODE" : "PROJECT B MODE",
      },
      {
        slug: "audit",
        name: rootPath === projectA.rootPath ? "Audit A" : "Audit B",
        icon: "shield",
        toolGroups:
          rootPath === projectA.rootPath ? ["read"] : ["read", "search"],
      },
    ]);
    const projectCustomizationRegistry = new ProjectCustomizationRegistry({
      loadCustomModes,
      loadSlashCommands: vi.fn(async () => []),
    });
    const onBrowserPreferredProjectChanged = vi.fn(async () => undefined);
    const mgr = new AgentSessionManager(
      makeConfig(),
      projectA.rootPath,
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      {
        projectCatalog,
        projectCustomizationRegistry,
        onBrowserPreferredProjectChanged,
      },
    );

    const sessionA = await mgr.createSession("code", {
      projectId: projectA.id,
    });
    const sessionB = await mgr.createSession("code", {
      projectId: projectB.id,
    });

    expect(sessionA.agentMode).toMatchObject({
      name: "Code A",
      toolGroups: ["read"],
      customInstructions: "PROJECT A MODE",
    });
    expect(sessionB.agentMode).toMatchObject({
      name: "Code B",
      toolGroups: ["read", "edit"],
      customInstructions: "PROJECT B MODE",
    });
    await mgr.switchSessionMode(sessionB.id, "audit");

    expect(sessionB.setMode).toHaveBeenCalledWith(
      "audit",
      expect.objectContaining({
        agentMode: expect.objectContaining({
          name: "Audit B",
          toolGroups: ["read", "search"],
        }),
      }),
    );
    expect(loadCustomModes).toHaveBeenCalledTimes(2);

    expect(mgr.setBrowserPreferredProject(projectB.id)).toBe(true);
    await flushPromises();
    expect(onBrowserPreferredProjectChanged).toHaveBeenCalledWith(projectB.id);
    const preferredSession = await mgr.createSession("code");
    expect(preferredSession.projectScope.projectId).toBe(projectB.id);
    expect(mgr.getDefaultProjectScope()?.projectId).toBe(projectB.id);
    expect(mgr.setBrowserPreferredProject("missing-project")).toBe(false);

    const restoredManager = new AgentSessionManager(
      makeConfig(),
      projectA.rootPath,
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      {
        projectCatalog,
        projectCustomizationRegistry,
        browserPreferredProjectId: projectB.id,
      },
    );
    expect(restoredManager.getDefaultProjectScope()?.projectId).toBe(
      projectB.id,
    );
    expect(
      (await restoredManager.createSession("code")).projectScope.projectId,
    ).toBe(projectB.id);
  });

  it("resolves execution settings from each session project scope", async () => {
    const defaultCreateSession = mocks.createSession.getMockImplementation();
    if (!defaultCreateSession) {
      throw new Error("Missing session fixture factory");
    }
    mocks.createSession
      .mockImplementationOnce(async (opts: any) => ({
        ...(await defaultCreateSession(opts)),
        id: "session-a",
      }))
      .mockImplementationOnce(async (opts: any) => ({
        ...(await defaultCreateSession(opts)),
        id: "session-b",
      }));
    const projects = [
      {
        id: "project-a",
        name: "Project A",
        uri: "file:///project-a",
        rootPath: "/project-a",
        availability: { status: "available" as const },
      },
      {
        id: "project-b",
        name: "Project B",
        uri: "file:///project-b",
        rootPath: "/project-b",
        availability: { status: "available" as const },
      },
    ];
    const projectCatalog = {
      listProjects: () => projects,
      resolveProjectForResource: () => projects[0],
      resolvePersistedScope: (scope: { projectId: string }) => {
        const project = projects.find(({ id }) => id === scope.projectId)!;
        return {
          status: "available" as const,
          project,
          scope: {
            schemaVersion: 1 as const,
            kind: "project" as const,
            projectId: project.id,
            workspaceFolderUri: project.uri,
            displayName: project.name,
            rootPath: project.rootPath,
          },
        };
      },
    };
    const resolveModelForMode = vi.fn(
      (_mode: string, _fallback: string, scope?: { projectId: string }) =>
        scope?.projectId === "project-b"
          ? "project-b-model"
          : "project-a-model",
    );
    const resolveReasoningEffortForMode = vi.fn(
      (_mode: string, scope?: { projectId: string }) =>
        scope?.projectId === "project-b" ? "xhigh" : "low",
    );
    const getCondenseThresholdForModel = vi.fn(
      (_model: string, scope?: { projectId: string }) =>
        scope?.projectId === "project-b" ? 0.7 : 0.8,
    );
    const mgr = new AgentSessionManager(
      makeConfig(),
      projects[0].rootPath,
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      {
        projectCatalog,
        host: {
          config: {
            resolveAgentConfig: (base, scope) => ({
              ...base,
              maxTokens: scope.projectId === "project-b" ? 4096 : 2048,
              thinkingBudget: scope.projectId === "project-b" ? 3000 : 2000,
              autoCondense: scope.projectId === "project-b",
              codexStatefulResponses: scope.projectId !== "project-b",
              codexStoreResponses: scope.projectId === "project-b",
              codexProMode: scope.projectId === "project-b",
              disabledSkillIds: [`disabled-${scope.projectId}`],
            }),
            resolveModelForMode,
            resolveReasoningEffortForMode: resolveReasoningEffortForMode as any,
            getCondenseThresholdForModel,
            getBgSummaryMode: () => "heuristic",
            getBackgroundAgentSettings: () => ({}),
          },
        },
      },
    );

    const sessionA = await mgr.createSession("code", {
      projectId: "project-a",
    });
    const sessionB = await mgr.createSession("code", {
      projectId: "project-b",
    });

    expect(sessionA).toMatchObject({
      model: "project-a-model",
      reasoningEffort: "low",
      autoCondenseThreshold: 0.8,
    });
    expect(mocks.createSession).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        config: expect.objectContaining({
          maxTokens: 2048,
          thinkingBudget: 2000,
          autoCondense: false,
          codexStatefulResponses: true,
          codexStoreResponses: false,
          codexProMode: false,
        }),
      }),
    );
    expect(sessionB).toMatchObject({
      model: "project-b-model",
      reasoningEffort: "xhigh",
      autoCondenseThreshold: 0.7,
    });
    expect(mocks.createSession).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        config: expect.objectContaining({
          maxTokens: 4096,
          thinkingBudget: 3000,
          autoCondense: true,
          codexStatefulResponses: false,
          codexStoreResponses: true,
          codexProMode: true,
        }),
      }),
    );

    await mgr.switchSessionMode(sessionB.id, "architect");
    expect(resolveModelForMode).toHaveBeenLastCalledWith(
      "architect",
      "project-b-model",
      sessionB.projectScope,
    );
    expect(resolveReasoningEffortForMode).toHaveBeenLastCalledWith(
      "architect",
      sessionB.projectScope,
    );
    expect(getCondenseThresholdForModel).toHaveBeenLastCalledWith(
      "project-b-model",
      sessionB.projectScope,
    );

    vi.mocked(sessionA.rebuildSystemPrompt).mockClear();
    vi.mocked(sessionB.rebuildSystemPrompt).mockClear();
    await mgr.rebuildSystemPrompts("project-a");
    expect(sessionA.rebuildSystemPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        disabledSkillIds: ["disabled-project-a"],
      }),
    );
    expect(sessionB.rebuildSystemPrompt).not.toHaveBeenCalled();

    vi.mocked(sessionA.rebuildSystemPrompt).mockRejectedValueOnce(
      new Error("project-a prompt failed"),
    );
    await expect(mgr.rebuildSystemPrompts()).rejects.toThrow(
      "project-a prompt failed",
    );
    expect(sessionA.rebuildSystemPrompt).toHaveBeenCalledTimes(2);
    expect(sessionB.rebuildSystemPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        disabledSkillIds: ["disabled-project-b"],
      }),
    );
  });

  it("keeps command approval policy session-scoped and migrates an explicit pre-send choice", async () => {
    const mgr = new AgentSessionManager(makeConfig(), "/tmp");

    expect(mgr.getCommandApprovalPolicy("missing", "manual")).toBe("manual");
    mgr.setCommandApprovalPolicy("agent", "approve-for-me");
    const session = await mgr.createSession("code");

    expect(mgr.getCommandApprovalPolicy(session.id)).toBe("approve-for-me");
    expect(mgr.getCommandApprovalPolicy("agent")).toBe("safe");

    mgr.setCommandApprovalPolicy(session.id, "sensitive");
    expect(mgr.getCommandApprovalPolicy(session.id)).toBe("sensitive");
    mgr.clearSessionCommandApprovalPolicy(session.id);
    expect(mgr.getCommandApprovalPolicy(session.id, "manual")).toBe("manual");
  });

  it("syncs Approve for Me guidance in the system prompt and mode anchor", async () => {
    const mgr = new AgentSessionManager(makeConfig(), "/tmp");
    const session = await mgr.createSession("architect");
    session.approveForMe = false;

    mgr.setCommandApprovalPolicy(session.id, "approve-for-me");
    expect(session.approveForMe).toBe(true);
    await flushPromises();
    expect(session.rebuildSystemPrompt).toHaveBeenCalledTimes(1);
    expect(session.refreshModeInstructionAnchor).toHaveBeenCalledTimes(1);

    // Re-applying the same policy must not schedule a redundant rebuild.
    mgr.setCommandApprovalPolicy(session.id, "approve-for-me");
    await flushPromises();
    expect(session.rebuildSystemPrompt).toHaveBeenCalledTimes(1);
    expect(session.refreshModeInstructionAnchor).toHaveBeenCalledTimes(1);

    mgr.setCommandApprovalPolicy(session.id, "safe");
    expect(session.approveForMe).toBe(false);
    await flushPromises();
    expect(session.rebuildSystemPrompt).toHaveBeenCalledTimes(2);
    expect(session.refreshModeInstructionAnchor).toHaveBeenCalledTimes(2);
  });

  it("starts an explicit new foreground session with Approve for Me off", async () => {
    const clearSession = vi.fn();
    const mgr = new AgentSessionManager(makeConfig(), "/tmp");
    mgr.setToolContext({
      approvalManager: {
        bindSessionProject: vi.fn(),
        clearSession,
      } as any,
      approvalPanel: {} as any,
      sessionId: "agent",
      extensionUri: {} as any,
    });
    mgr.setCommandApprovalPolicy("agent", "approve-for-me");

    const session = await mgr.createForegroundSession("code");

    expect(clearSession).toHaveBeenCalledOnce();
    expect(clearSession).toHaveBeenCalledWith("agent");
    expect(mgr.getCommandApprovalPolicy(session.id, "sensitive")).toBe(
      "sensitive",
    );
    expect(mgr.getCommandApprovalPolicy("agent", "sensitive")).toBe(
      "sensitive",
    );
  });

  it("persists approval dimensions when a live session policy changes", async () => {
    const saveSession = vi.fn(
      async (_args: {
        session: PersistedSessionRecord;
        expectedRevision: string | null;
      }) => ({
        ok: true as const,
        revision: "revision-1",
      }),
    );
    const store = {
      saveSession,
      list: vi.fn(() => []),
    } as any;
    const mgr = new AgentSessionManager(
      makeConfig(),
      "/tmp",
      undefined,
      false,
      store,
    );
    const session = await mgr.createSession("code");

    mgr.setCommandApprovalPolicy(session.id, "approve-for-me");
    await flushPromises();

    expect(saveSession).toHaveBeenCalledTimes(1);
    expect(saveSession.mock.calls[0]![0].session.metadata).toMatchObject({
      commandApprovalPolicy: "approve-for-me",
      approvalPolicy: "on-request",
      approvalReviewer: "auto-review",
      executionPreset: "workspace-write",
    });
  });

  it("hydrates a persisted session without changing foreground ownership", async () => {
    const summary = {
      schemaVersion: 1,
      id: "session-2",
      mode: "code",
      model: "claude-sonnet-4-6",
      title: "Persisted",
      messageCount: 1,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      createdAt: 1,
      lastActiveAt: 2,
    };
    const readSession = vi.fn(async () => ({
      ok: true as const,
      revision: "revision-1",
      value: {
        summary,
        messages: [{ role: "user" as const, content: "hello" }],
        metadata: {
          mode: summary.mode,
          model: summary.model,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          checkpointState: { baseCommit: null, checkpoints: [] },
        },
      },
    }));
    const mgr = new AgentSessionManager(
      makeConfig(),
      "/tmp",
      undefined,
      false,
      {
        readSession,
        list: vi.fn(() => [summary]),
        listAll: vi.fn(() => [summary]),
      } as any,
    );
    const foreground = await mgr.createSession("code");
    const changes = vi.fn();
    mgr.onSessionsChanged = changes;

    const hydrated = await mgr.hydratePersistedSession(summary.id);

    expect(hydrated).toBeDefined();
    expect(mgr.getSession(summary.id)).toBe(hydrated);
    expect(mgr.getForegroundSession()).toBe(foreground);
    expect(changes).toHaveBeenCalledOnce();
  });

  it("restores completed context evidence for persisted background sessions", async () => {
    const contextLedger = buildContextLedger({
      capabilities: {
        contextWindow: 200_000,
        maxInputTokens: 180_000,
        maxOutputTokens: 20_000,
      },
      layers: [{ layer: "system_prompt", requestedTokens: 123 }],
    });
    const summary = {
      schemaVersion: 1,
      id: "background-session",
      mode: "code",
      model: "claude-sonnet-4-6",
      title: "Background",
      messageCount: 1,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      createdAt: 1,
      lastActiveAt: 2,
      background: true,
    };
    const readSession = vi.fn(async () => ({
      ok: true as const,
      revision: "revision-1",
      value: {
        summary,
        messages: [{ role: "user" as const, content: "hello" }],
        metadata: {
          mode: summary.mode,
          model: summary.model,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          contextLedger,
          fleet: {
            schemaVersion: 1 as const,
            projectId: "project-1",
            placement: "background" as const,
            task: "Review",
            depth: 1,
            backend: "native" as const,
            lifecycle: "completed" as const,
          },
        },
      },
    }));
    const mgr = new AgentSessionManager(
      makeConfig(),
      "/tmp",
      undefined,
      false,
      {
        readSession,
        list: vi.fn(() => []),
        listAll: vi.fn(() => [summary]),
      } as any,
    );

    const [restored] = await mgr.restorePersistedBackgroundSessions();

    expect(restored?.contextBreakdown).toEqual({
      prompt: { sections: [], totalChars: 7, estimatedTokens: 2 },
      contextLedger,
    });
  });

  it("deduplicates concurrent hydration and does not notify for cached reuse", async () => {
    const summary = {
      schemaVersion: 1,
      id: "session-2",
      mode: "code",
      model: "claude-sonnet-4-6",
      title: "Persisted",
      messageCount: 1,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      createdAt: 1,
      lastActiveAt: 2,
    };
    const readSession = vi.fn(async () => ({
      ok: true as const,
      revision: "revision-1",
      value: {
        summary,
        messages: [{ role: "user" as const, content: "hello" }],
        metadata: {
          mode: summary.mode,
          model: summary.model,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          checkpointState: { baseCommit: null, checkpoints: [] },
        },
      },
    }));
    const mgr = new AgentSessionManager(
      makeConfig(),
      "/tmp",
      undefined,
      false,
      {
        readSession,
        list: vi.fn(() => [summary]),
        listAll: vi.fn(() => [summary]),
      } as any,
    );

    const changes = vi.fn();
    mgr.onSessionsChanged = changes;
    const [first, concurrent] = await Promise.all([
      mgr.hydratePersistedSession(summary.id),
      mgr.hydratePersistedSession(summary.id),
    ]);
    const cached = await mgr.hydratePersistedSession(summary.id);

    expect(concurrent).toBe(first);
    expect(cached).toBe(first);
    expect(readSession).toHaveBeenCalledTimes(1);
    expect(mocks.createSession).toHaveBeenCalledTimes(1);
    expect(changes).toHaveBeenCalledOnce();
  });

  it("returns null when a persisted session cannot be hydrated", async () => {
    const readSession = vi.fn(async () => ({
      ok: false as const,
      reason: "not_found" as const,
    }));

    const mgr = new AgentSessionManager(
      makeConfig(),
      "/tmp",
      undefined,
      false,
      {
        readSession,
        list: vi.fn(() => []),
        listAll: vi.fn(() => []),
      } as any,
    );

    const changes = vi.fn();
    mgr.onSessionsChanged = changes;
    await expect(mgr.hydratePersistedSession("missing")).resolves.toBeNull();
    expect(mgr.getForegroundSession()).toBeUndefined();
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(changes).not.toHaveBeenCalled();
  });

  it("restores independent approval dimensions and derives missing dimensions from legacy policy", async () => {
    const activeSkillState = {
      schemaVersion: 1 as const,
      catalogRevision: "catalog-revision",
      activations: [
        {
          id: "project:agentlink:.agentlink/skills/review",
          name: "review",
          revision: "skill-revision",
        },
      ],
      policy: {
        schemaVersion: 1 as const,
        revision: "policy-revision",
        skillIds: ["project:agentlink:.agentlink/skills/review"],
        dependencies: [],
        recommendations: [],
        requestedTools: [],
        allowedTools: ["read_file"],
      },
    };
    const summary = {
      schemaVersion: 1,
      id: "session-1",
      mode: "code",
      model: "claude-sonnet-4-6",
      title: "Persisted",
      messageCount: 1,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      createdAt: 1,
      lastActiveAt: 2,
    };
    const restoredContextLedger = buildContextLedger({
      capabilities: {
        contextWindow: 200_000,
        maxInputTokens: 180_000,
        maxOutputTokens: 20_000,
      },
      layers: [{ layer: "system_prompt", requestedTokens: 123 }],
    });
    const readSession = vi.fn(async () => ({
      ok: true as const,
      revision: "revision-1",
      value: {
        summary,
        messages: [{ role: "user" as const, content: "hello" }],
        metadata: {
          mode: summary.mode,
          model: summary.model,
          commandApprovalPolicy: "safe" as const,
          approvalPolicy: "on-request" as const,
          approvalReviewer: "auto-review" as const,
          executionPreset: "workspace-write" as const,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          contextLedger: restoredContextLedger,
          loadedSkills: ["review"],
          activeSkillState,
          checkpointState: { baseCommit: null, checkpoints: [] },
        },
      },
    }));
    const store = {
      readSession,
      list: vi.fn(() => [summary]),
      listAll: vi.fn(() => [summary]),
    } as any;
    const mgr = new AgentSessionManager(
      makeConfig(),
      "/tmp",
      undefined,
      false,
      store,
    );

    const restored = await mgr.loadPersistedSession(summary.id);

    expect(restored?.restoreFromStore).toHaveBeenCalledWith(
      expect.objectContaining({
        loadedSkills: ["review"],
        activeSkillState,
      }),
    );
    expect(restored?.contextBreakdown).toEqual({
      prompt: { sections: [], totalChars: 7, estimatedTokens: 2 },
      contextLedger: restoredContextLedger,
    });
    expect(mgr.getSessionApprovalMode(summary.id)).toEqual({
      commandApprovalPolicy: "safe",
      approvalPolicy: "on-request",
      approvalReviewer: "auto-review",
      executionPreset: "workspace-write",
    });

    readSession.mockResolvedValueOnce({
      ok: true,
      revision: "revision-2",
      value: {
        summary: { ...summary, id: "legacy-session" },
        messages: [{ role: "user", content: "legacy" }],
        metadata: {
          mode: summary.mode,
          model: summary.model,
          commandApprovalPolicy: "approve-for-me",
          totalInputTokens: 0,
          totalOutputTokens: 0,
          checkpointState: { baseCommit: null, checkpoints: [] },
        },
      },
    } as any);
    const legacySession = await mgr.loadPersistedSession("legacy-session");
    expect(legacySession?.contextBreakdown).toEqual({
      prompt: { sections: [], totalChars: 7, estimatedTokens: 2 },
    });
    expect(mgr.getSessionApprovalMode("legacy-session")).toEqual({
      commandApprovalPolicy: "approve-for-me",
      approvalPolicy: "on-request",
      approvalReviewer: "auto-review",
      executionPreset: "workspace-write",
    });
  });

  it("fans out session changes without replacing the legacy callback", async () => {
    const mgr = new AgentSessionManager(makeConfig(), "/tmp");
    const legacyListener = vi.fn();
    const retainedListener = vi.fn();
    const disposedListener = vi.fn();
    mgr.onSessionsChanged = legacyListener;
    mgr.onDidChangeSessions(retainedListener);
    const disposedSubscription = mgr.onDidChangeSessions(disposedListener);

    const session = await mgr.createSession("code");

    expect(legacyListener).toHaveBeenCalledTimes(1);
    expect(retainedListener).toHaveBeenCalledTimes(1);
    expect(disposedListener).toHaveBeenCalledTimes(1);

    disposedSubscription.dispose();
    mgr.setCommandApprovalPolicy(session.id, "sensitive");

    expect(legacyListener).toHaveBeenCalledTimes(2);
    expect(retainedListener).toHaveBeenCalledTimes(2);
    expect(disposedListener).toHaveBeenCalledTimes(1);
  });

  it("notifies session listeners after a persisted snapshot commits", async () => {
    const store = {
      saveSession: vi.fn(async () => ({ ok: true, revision: "revision-1" })),
      list: vi.fn(() => []),
    };
    const mgr = new AgentSessionManager(
      makeConfig(),
      "/tmp",
      undefined,
      false,
      store as any,
    );
    const session = await mgr.createSession("code");
    const legacyListener = vi.fn();
    const sessionListener = vi.fn();
    mgr.onSessionsChanged = legacyListener;
    mgr.onDidChangeSessions(sessionListener);

    mgr.saveSession(session.id);
    await flushPromises();

    expect(store.saveSession).toHaveBeenCalledTimes(1);
    expect(sessionListener).toHaveBeenCalledTimes(1);
    expect(legacyListener).not.toHaveBeenCalled();
  });

  it("replaces empty foreground sessions instead of keeping them in memory", async () => {
    let nextSessionNumber = 1;
    const createEmptySession = async (opts: any) => ({
      id: `session-${nextSessionNumber++}`,
      mode: opts.mode,
      agentMode: opts.agentMode,
      model: opts.config.model,
      providerId: opts.providerId,
      projectScope: opts.projectScope,
      projectAvailability: opts.projectAvailability ?? "available",
      activeFilePath: opts.activeFilePath,
      activeContextResourceUri: opts.activeContextResourceUri,
      requireProjectRoot: vi.fn(() => opts.projectScope.rootPath),
      autoCondenseThreshold: opts.config.autoCondenseThreshold,
      reasoningEffort: "high",
      thinkingBudget: opts.config.thinkingBudget,
      title: "New Chat",
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
      currentTool: undefined,
      addUserMessage: vi.fn(),
      appendRuntimeError: vi.fn(),
      consumePendingInterjection: vi.fn(() => null),
      queuePendingModeResume: vi.fn(),
      consumePendingModeResume: vi.fn(() => null),
      autoTitle: vi.fn(),
      getAllMessages: vi.fn(() => []),
      getAdvertisedSkills: vi.fn(() => []),
      getSkillCatalogProjection: vi.fn(() => undefined),
      restoreFromStore: vi.fn(),
      rebuildSystemPrompt: vi.fn(async () => {}),
      updateModelSelection: vi.fn(async function (
        this: { model: string; providerId: string | undefined },
        model: string,
        providerId: string | undefined,
      ) {
        this.model = model;
        this.providerId = providerId;
      }),
      setMode: vi.fn(async function (this: { mode: string }, mode: string) {
        this.mode = mode;
      }),
    });
    mocks.createSession
      .mockImplementationOnce(createEmptySession)
      .mockImplementationOnce(createEmptySession)
      .mockImplementationOnce(createEmptySession);

    const remove = vi.fn(async () => undefined);
    const mgr = new AgentSessionManager(
      makeConfig(),
      "/tmp",
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      {
        skillCatalogFallbackProvider: {
          update: vi.fn(async () => undefined),
          remove,
        },
      },
    );

    const first = await mgr.createForegroundSession("code");
    const second = await mgr.createForegroundSession("code");
    const third = await mgr.createForegroundSession("code");

    expect(mgr.getSession(first.id)).toBeUndefined();
    expect(mgr.getSession(second.id)).toBeUndefined();
    expect(mgr.getSession(third.id)).toBe(third);
    expect(mgr.getSessionInfos().map((session) => session.id)).toEqual([
      third.id,
    ]);
    expect(remove).toHaveBeenCalledWith({
      publisherId: first.id,
      projectId: first.projectScope.projectId,
    });
    expect(remove).toHaveBeenCalledWith({
      publisherId: second.id,
      projectId: second.projectScope.projectId,
    });
  });

  it("filters empty persisted foreground sessions from visible history", () => {
    const store = {
      list: vi.fn(() => [
        {
          id: "empty-foreground",
          mode: "code",
          model: "claude-sonnet-4-6",
          title: "New Chat",
          messageCount: 0,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          createdAt: 100,
          lastActiveAt: 100,
          schemaVersion: 1,
        },
        {
          id: "real-foreground",
          mode: "code",
          model: "claude-sonnet-4-6",
          title: "Real chat",
          messageCount: 2,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          createdAt: 200,
          lastActiveAt: 200,
          schemaVersion: 1,
        },
      ]),
    };
    const mgr = new AgentSessionManager(
      makeConfig(),
      "/tmp",
      undefined,
      false,
      store as any,
    );

    expect(mgr.listPersistedSessions().map((session) => session.id)).toEqual([
      "real-foreground",
    ]);
  });

  it("persists foreground reasoning effort changes immediately", async () => {
    const savedRecords: PersistedSessionRecord[] = [];
    const store = {
      saveSession: vi.fn(async (args: { session: PersistedSessionRecord }) => {
        savedRecords.push(args.session);
        return { ok: true, revision: String(savedRecords.length) };
      }),
      list: vi.fn(() => []),
    };
    const mgr = new AgentSessionManager(
      { ...makeConfig(), thinkingBudget: 1024 },
      "/tmp",
      undefined,
      false,
      store as any,
    );
    const session = await mgr.createForegroundSession("code");
    session.thinkingBudget = 0;

    expect(mgr.setForegroundReasoningEffort("max")).toBe(true);
    await flushPromises();

    expect(session.reasoningEffort).toBe("max");
    expect(session.thinkingBudget).toBe(1024);
    expect(savedRecords.at(-1)?.metadata.reasoningEffort).toBe("max");
  });

  it("does not persist empty foreground sessions during shutdown", async () => {
    const store = {
      save: vi.fn(),
      list: vi.fn(() => []),
    };
    const mgr = new AgentSessionManager(
      makeConfig(),
      "/tmp",
      undefined,
      false,
      store as any,
    );

    await mgr.createForegroundSession("code");
    mgr.saveAllSessions();

    expect(store.save).not.toHaveBeenCalled();
  });

  it("uses injected host dependencies when creating foreground sessions", async () => {
    const providers = new ProviderRegistry();
    const createSession = vi.fn(
      (opts: Parameters<typeof mocks.createSession>[0]) =>
        mocks.createSession(opts),
    );
    const createActivityTraceRecorder = vi.fn(() => ({
      appendAgentEvent: vi.fn(),
    }));
    const createCheckpointManager = vi.fn(() => ({
      baseCommit: null,
      initialize: vi.fn(async () => undefined),
      createCheckpoint: vi.fn(async () => null),
      previewRevert: vi.fn(async () => null),
      revertToCheckpoint: vi.fn(async () => false),
      getDiffBetween: vi.fn(async () => ""),
    }));

    const mgr = new AgentSessionManager(
      makeConfig(),
      "/tmp",
      undefined,
      false,
      undefined,
      undefined,
      { maxConcurrent: 3 },
      {
        host: {
          workspace: {
            getWorkspaceFolders: () => [
              { name: "Injected", path: "/workspace/injected" },
            ],
          },
          config: {
            resolveModelForMode: () => "host-model",
            getCondenseThresholdForModel: () => 0.42,
            getBgSummaryMode: () => "heuristic",
            getBackgroundAgentSettings: () => ({}),
          },
          providers,
          createSession: createSession as any,
          createActivityTraceRecorder,
          createCheckpointManager,
        },
      },
    );

    await mgr.createSession("code");

    expect(createActivityTraceRecorder).toHaveBeenCalledWith({
      workspaceDir: "/tmp",
    });
    expect(createCheckpointManager).toHaveBeenCalledWith({
      workspaceDir: "/tmp",
      taskId: "agent",
      log: expect.any(Function),
    });
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          model: "host-model",
          autoCondenseThreshold: 0.42,
        }),
        workspaceFolders: [{ name: "Injected", path: "/workspace/injected" }],
      }),
    );
  });

  it("migrates retired configured models before creating or updating a session", async () => {
    const providers = new ProviderRegistry();
    providers.register({
      id: "test",
      displayName: "Test",
      condenseModel: "model-current",
      isAuthenticated: vi.fn(async () => true),
      getCapabilities: vi.fn(() => ({
        supportsThinking: false,
        supportsCaching: false,
        supportsImages: false,
        supportsToolUse: true,
        contextWindow: 200_000,
        maxOutputTokens: 8_192,
      })),
      listModels: vi.fn(() => [
        {
          id: "model-current",
          displayName: "Current model",
          provider: "test",
          capabilities: {
            supportsThinking: false,
            supportsCaching: false,
            supportsImages: false,
            supportsToolUse: true,
            contextWindow: 200_000,
            maxOutputTokens: 8_192,
          },
        },
      ]),
      getModelMigration: vi.fn((model: string) =>
        model === "model-retired" ? "model-current" : undefined,
      ),
      stream: vi.fn(),
      complete: vi.fn(),
    } as any);
    const mgr = new AgentSessionManager(
      { ...makeConfig(), model: "model-retired" },
      "/tmp",
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      {
        host: {
          providers,
          config: {
            resolveModelForMode: (_mode, fallbackModel) => fallbackModel,
            getCondenseThresholdForModel: () => 0.9,
            getBgSummaryMode: () => "heuristic",
            getBackgroundAgentSettings: () => ({}),
          },
        },
      },
    );

    const session = await mgr.createSession("code");
    expect(session.model).toBe("model-current");
    expect(session.providerId).toBe("test");
    await expect(mgr.setModel("model-retired")).resolves.toBe("model-current");
    expect(mgr.getConfig().model).toBe("model-current");
  });

  it("rebuilds on same-provider model/profile changes and skips identical resolutions", async () => {
    const providers = new ProviderRegistry();
    providers.register({
      id: "test",
      displayName: "Test",
      condenseModel: "model-a",
      isAuthenticated: vi.fn(async () => true),
      getCapabilities: vi.fn(() => ({
        supportsThinking: false,
        supportsCaching: false,
        supportsImages: false,
        supportsToolUse: true,
        contextWindow: 200_000,
        maxOutputTokens: 8_192,
      })),
      listModels: vi.fn(() =>
        ["model-a", "model-b"].map((id) => ({
          id,
          displayName: id,
          provider: "test",
          capabilities: {
            supportsThinking: false,
            supportsCaching: false,
            supportsImages: false,
            supportsToolUse: true,
            contextWindow: 200_000,
            maxOutputTokens: 8_192,
          },
        })),
      ),
      stream: vi.fn(),
      complete: vi.fn(),
    } as any);
    const promptProfileOverrides = { "model-b": "reasoning" as const };
    const mgr = new AgentSessionManager(
      { ...makeConfig(), model: "model-a", promptProfileOverrides },
      "/tmp",
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      {
        host: {
          providers,
          config: {
            resolveModelForMode: (_mode, fallbackModel) => fallbackModel,
            getCondenseThresholdForModel: () => 0.9,
            getBgSummaryMode: () => "heuristic",
            getBackgroundAgentSettings: () => ({}),
          },
        },
      },
    );

    const session = await mgr.createSession("code");
    expect(session.promptProfile).toMatchObject({
      profile: "compatibility",
      modelId: "model-a",
    });
    vi.mocked(session.rebuildSystemPrompt).mockClear();

    await expect(mgr.setModel("model-b")).resolves.toBe("model-b");
    expect(session.providerId).toBe("test");
    expect(session.promptProfile).toEqual({
      profile: "reasoning",
      source: "exact-model-override",
      policyRevision: "prompt-profile-policy-v1",
      providerId: "test",
      modelId: "model-b",
    });
    expect(session.rebuildSystemPrompt).toHaveBeenCalledTimes(1);
    expect(session.rebuildSystemPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ promptProfileOverrides }),
    );

    await expect(mgr.setModel("model-b")).resolves.toBe("model-b");
    expect(session.rebuildSystemPrompt).toHaveBeenCalledTimes(1);
  });

  it("wires runtime fallback reconciliation through the production engine boundary", async () => {
    const providers = new ProviderRegistry();
    providers.register({
      id: "test",
      displayName: "Test",
      condenseModel: "model-a",
      isAuthenticated: vi.fn(async () => true),
      getCapabilities: vi.fn(() => ({
        supportsThinking: false,
        supportsCaching: false,
        supportsImages: false,
        supportsToolUse: true,
        contextWindow: 200_000,
        maxOutputTokens: 8_192,
      })),
      listModels: vi.fn(() =>
        ["model-a", "model-b"].map((id) => ({
          id,
          displayName: id,
          provider: "test",
          capabilities: {
            supportsThinking: false,
            supportsCaching: false,
            supportsImages: false,
            supportsToolUse: true,
            contextWindow: 200_000,
            maxOutputTokens: 8_192,
          },
        })),
      ),
      stream: vi.fn(),
      complete: vi.fn(),
    } as any);
    let reconciledBeforeWarning = false;
    const engine = {
      setToolRuntime: vi.fn(),
      run: vi.fn(async function* (session: any, opts: any) {
        await opts.onModelFallback({
          requestedModel: "model-a",
          effectiveModel: "model-b",
        });
        reconciledBeforeWarning =
          session.model === "model-b" &&
          session.providerId === "test" &&
          session.promptProfile.profile === "reasoning" &&
          session.promptProfile.modelId === "model-b";
        yield {
          type: "warning",
          message: "model-a is unavailable. Switched to model-b.",
          modelFallback: {
            requestedModel: "model-a",
            effectiveModel: "model-b",
          },
        };
        yield {
          type: "done",
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalCacheReadTokens: 0,
          totalCacheCreationTokens: 0,
        };
      }),
    };
    const promptProfileOverrides = { "model-b": "reasoning" as const };
    const mgr = new AgentSessionManager(
      { ...makeConfig(), model: "model-a", promptProfileOverrides },
      "/tmp",
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      {
        host: {
          providers,
          createEngine: vi.fn(() => engine as never),
          config: {
            resolveModelForMode: (_mode, fallbackModel) => fallbackModel,
            getCondenseThresholdForModel: () => 0.9,
            getBgSummaryMode: () => "heuristic",
            getBackgroundAgentSettings: () => ({}),
          },
        },
      },
    );
    const session = await mgr.createSession("code");
    vi.mocked(session.rebuildSystemPrompt).mockClear();

    await mgr.sendMessage(session.id, "trigger fallback", session.mode);

    expect(reconciledBeforeWarning).toBe(true);
    expect(session.rebuildSystemPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ promptProfileOverrides }),
    );
    expect(session.promptProfile).toMatchObject({
      profile: "reasoning",
      providerId: "test",
      modelId: "model-b",
    });
  });

  it("emits session-outcome turn and task events through the production send loop", async () => {
    const providers = new ProviderRegistry();
    providers.register({
      id: "test",
      displayName: "Test",
      condenseModel: "model-a",
      isAuthenticated: vi.fn(async () => true),
      getCapabilities: vi.fn(() => ({
        supportsThinking: false,
        supportsCaching: false,
        supportsImages: false,
        supportsToolUse: true,
        contextWindow: 200_000,
        maxOutputTokens: 8_192,
      })),
      listModels: vi.fn(() => [
        {
          id: "model-a",
          displayName: "model-a",
          provider: "test",
          capabilities: {
            supportsThinking: false,
            supportsCaching: false,
            supportsImages: false,
            supportsToolUse: true,
            contextWindow: 200_000,
            maxOutputTokens: 8_192,
          },
        },
      ]),
      stream: vi.fn(),
      complete: vi.fn(),
    } as any);
    const engine = {
      setToolRuntime: vi.fn(),
      run: vi.fn(async function* () {
        yield {
          type: "api_request",
          requestId: "r1",
          model: "model-a",
          reasoningEffort: "none",
          inputTokens: 100,
          uncachedInputTokens: 80,
          outputTokens: 40,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          durationMs: 1_000,
          timeToFirstToken: 10,
        };
        yield {
          type: "tool_result",
          toolCallId: "t1",
          toolName: "read_file",
          result: [],
          durationMs: 200,
          input: { path: "a.ts" },
        };
        yield {
          type: "tool_result",
          toolCallId: "t2",
          toolName: "spawn_background_agent",
          result: [],
          durationMs: 50,
          input: { taskClass: "review_code" },
        };
        yield {
          type: "tool_result",
          toolCallId: "t3",
          toolName: "get_background_result",
          result: [],
          durationMs: 5_000,
          input: { sessionId: "bg" },
        };
        yield {
          type: "tool_result",
          toolCallId: "t4",
          toolName: "set_task_status",
          result: [],
          durationMs: 5,
          input: { status: "completed", summary: "done" },
        };
        yield {
          type: "done",
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalCacheReadTokens: 0,
          totalCacheCreationTokens: 0,
        };
      }),
    };
    const mgr = new AgentSessionManager(
      { ...makeConfig(), model: "model-a" },
      "/tmp",
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      {
        host: {
          providers,
          createEngine: vi.fn(() => engine as never),
          config: {
            resolveModelForMode: (_mode, fallbackModel) => fallbackModel,
            getCondenseThresholdForModel: () => 0.9,
            getBgSummaryMode: () => "heuristic",
            getBackgroundAgentSettings: () => ({}),
          },
        },
      },
    );
    const record = vi.fn();
    mgr.setSessionOutcomeTelemetry({ record } as never);
    const session = await mgr.createSession("code");

    await mgr.sendMessage(session.id, "start", session.mode);

    const events = record.mock.calls.map(([event]) => event);
    const task = events.find((event) => event.type === "task_completed");
    expect(task).toMatchObject({
      sessionId: session.id,
      status: "completed",
      turns: 1,
    });
    expect(task.taskDurationMs).toBeGreaterThanOrEqual(0);
    const turn = events.find((event) => event.type === "turn_completed");
    expect(turn).toMatchObject({
      sessionId: session.id,
      background: false,
      streamingMs: 1_000,
      apiTurns: 1,
      inputTokens: 80,
      outputTokens: 40,
      toolCalls: 4,
      toolMs: 255,
      backgroundWaitMs: 5_000,
      userWaitMs: 0,
      spawns: 1,
      reviewSpawns: 1,
      // read_file ran before the spawn, so this was not delegation-first.
      spawnedBeforeFirstAction: false,
      autoContinues: 0,
    });
    expect(turn.turnDurationMs).toBeGreaterThanOrEqual(0);
  });

  it("rolls back model identity when prompt reconciliation fails", async () => {
    const mgr = new AgentSessionManager(makeConfig(), "/tmp");
    const session = await mgr.createSession("code");
    const previous = {
      configModel: mgr.getConfig().model,
      configThreshold: mgr.getConfig().autoCondenseThreshold,
      model: session.model,
      providerId: session.providerId,
      threshold: session.autoCondenseThreshold,
      promptProfile: session.promptProfile,
    };
    vi.mocked(session.rebuildSystemPrompt).mockRejectedValueOnce(
      new Error("prompt rebuild failed"),
    );

    await expect(mgr.setModel("gpt-5.4")).rejects.toThrow(
      "prompt rebuild failed",
    );

    expect(mgr.getConfig().model).toBe(previous.configModel);
    expect(mgr.getConfig().autoCondenseThreshold).toBe(
      previous.configThreshold,
    );
    expect(session.model).toBe(previous.model);
    expect(session.providerId).toBe(previous.providerId);
    expect(session.autoCondenseThreshold).toBe(previous.threshold);
    expect(session.promptProfile).toBe(previous.promptProfile);
  });

  it("restores the configured reasoning effort when modes change", async () => {
    const mgr = new AgentSessionManager(
      { ...makeConfig(), thinkingBudget: 2048 },
      "/tmp",
      undefined,
      false,
      undefined,
      undefined,
      { maxConcurrent: 3 },
      {
        host: {
          config: {
            resolveModelForMode: (_mode, fallbackModel) => fallbackModel,
            resolveReasoningEffortForMode: (mode) =>
              mode === "architect" ? "xhigh" : "high",
            getCondenseThresholdForModel: () => 0.9,
            getBgSummaryMode: () => "heuristic",
            getBackgroundAgentSettings: () => ({}),
          },
        },
      },
    );

    const session = await mgr.createSession("code");
    expect(session.reasoningEffort).toBe("high");

    await mgr.switchForegroundMode("architect");
    expect(session.mode).toBe("architect");
    expect(session.reasoningEffort).toBe("xhigh");

    session.thinkingBudget = 0;
    await mgr.switchForegroundMode("code");
    expect(session.reasoningEffort).toBe("high");
    expect(session.thinkingBudget).toBe(2048);
  });

  it("owns fresh interactive engines and captured contexts per active session", async () => {
    const providers = new ProviderRegistry();
    const engines = [
      {
        setToolRuntime: vi.fn(),
        run: vi.fn(async function* () {}),
        condenseSession: vi.fn(async function* () {}),
        isOverCondenseThreshold: vi.fn(() => false),
      },
      {
        setToolRuntime: vi.fn(),
        run: vi.fn(async function* () {}),
        condenseSession: vi.fn(async function* () {}),
        isOverCondenseThreshold: vi.fn(() => false),
      },
      {
        setToolRuntime: vi.fn(),
        run: vi.fn(async function* () {}),
        condenseSession: vi.fn(async function* () {}),
        isOverCondenseThreshold: vi.fn(() => false),
      },
    ];
    const createEngine = vi
      .fn()
      .mockReturnValueOnce(engines[0])
      .mockReturnValueOnce(engines[1])
      .mockReturnValueOnce(engines[2]);
    const runtimeA = { executeTool: vi.fn() };
    const runtimeB = { executeTool: vi.fn() };
    const createToolRuntime = vi
      .fn()
      .mockReturnValueOnce(runtimeA)
      .mockReturnValueOnce(runtimeB);

    const mgr = new AgentSessionManager(
      makeConfig(),
      "/tmp",
      undefined,
      false,
      undefined,
      undefined,
      { maxConcurrent: 3 },
      {
        host: {
          providers,
          createEngine: createEngine as any,
          createToolRuntime: createToolRuntime as any,
        },
      },
    );

    const mcpHubA = {
      getToolDefs: vi.fn(() => []),
      getServerConfig: vi.fn(),
    } as any;
    const mcpHubB = {
      getToolDefs: vi.fn(() => []),
      getServerConfig: vi.fn(),
    } as any;
    const bindSessionProject = vi.fn();
    const ctxA = {
      approvalManager: { bindSessionProject } as any,
      approvalPanel: {} as any,
      sessionId: "agent",
      extensionUri: {} as any,
      mcpHub: mcpHubA,
    };
    const ctxB = { ...ctxA, sessionId: "agent-next", mcpHub: mcpHubB };
    const session = await mgr.createSession("code");

    mgr.setToolContext(ctxA);
    const first = (mgr as any).createInteractiveEngine(session.id);
    const requestA = (mgr as any).bindEngineToSession(first, session);
    expect(() => (mgr as any).createInteractiveEngine(session.id)).toThrow(
      "already owns an active interactive engine",
    );

    const other = (mgr as any).createInteractiveEngine("session-2");
    expect(other).not.toBe(first);
    (mgr as any).releaseInteractiveEngine("session-2", other);
    (mgr as any).releaseSessionToolContext(session.id, requestA);
    (mgr as any).releaseInteractiveEngine(session.id, first);

    mgr.setToolContext(ctxB);
    const next = (mgr as any).createInteractiveEngine(session.id);
    const requestB = (mgr as any).bindEngineToSession(next, session);

    expect(next).not.toBe(first);
    expect(createEngine).toHaveBeenCalledTimes(3);
    expect(createEngine).toHaveBeenNthCalledWith(1, providers, undefined);
    expect(createEngine).toHaveBeenNthCalledWith(2, providers, undefined);
    expect(createEngine).toHaveBeenNthCalledWith(3, providers, undefined);
    expect(bindSessionProject).toHaveBeenCalledWith(
      session.id,
      session.projectScope,
    );
    expect(createToolRuntime).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        sessionId: session.id,
        projectScope: session.projectScope,
        projectRoot: "/tmp",
        mcpHub: mcpHubA,
      }),
    );
    expect(engines[0].setToolRuntime).toHaveBeenCalledWith(runtimeA);
    expect(createToolRuntime).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ mcpHub: mcpHubB }),
    );
    expect(engines[2].setToolRuntime).toHaveBeenCalledWith(runtimeB);

    (mgr as any).releaseSessionToolContext(session.id, requestB);
    (mgr as any).releaseInteractiveEngine(session.id, next);
    expect((mgr as any).activeInteractiveEngines.size).toBe(0);
  });

  it("rejects an unknown explicit session instead of creating a fallback session", async () => {
    const mgr = new AgentSessionManager(makeConfig(), "/tmp");
    const createCallsBeforeSend = mocks.createSession.mock.calls.length;

    await expect(
      mgr.sendMessage("missing-session", "do not reroute", "code"),
    ).rejects.toThrow("Session 'missing-session' was not found.");

    expect(mocks.createSession).toHaveBeenCalledTimes(createCallsBeforeSend);
    expect(mgr.getSessionInfos()).toEqual([]);
  });

  it("runs different sessions concurrently with isolated interactive engines", async () => {
    const defaultCreateSession = mocks.createSession.getMockImplementation();
    if (!defaultCreateSession)
      throw new Error("Missing session fixture factory");
    const providers = new ProviderRegistry();
    const startedSessionIds: string[] = [];
    const releases = new Map<string, () => void>();
    const createEngine = vi.fn(() => ({
      setToolRuntime: vi.fn(),
      run: vi.fn(async function* (session: { id: string }) {
        startedSessionIds.push(session.id);
        await new Promise<void>((resolve) => {
          releases.set(session.id, resolve);
        });
        yield {
          type: "done",
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalCacheReadTokens: 0,
          totalCacheCreationTokens: 0,
        };
      }),
      condenseSession: vi.fn(async function* () {}),
      isOverCondenseThreshold: vi.fn(() => false),
    }));
    const mgr = new AgentSessionManager(
      makeConfig(),
      "/tmp",
      undefined,
      false,
      undefined,
      undefined,
      { maxConcurrent: 3 },
      {
        host: {
          providers,
          createEngine: createEngine as any,
        },
      },
    );
    const first = await mgr.createSession("code");
    mocks.createSession.mockImplementationOnce(async (opts: any) => ({
      ...(await defaultCreateSession(opts)),
      id: "session-2",
    }));
    const second = await mgr.createSession("code");

    const firstSend = mgr.sendMessage(first.id, "first", first.mode);
    const secondSend = mgr.sendMessage(second.id, "second", second.mode);
    await vi.waitFor(() => {
      expect(startedSessionIds).toEqual(
        expect.arrayContaining([first.id, second.id]),
      );
    });

    expect(createEngine).toHaveBeenCalledTimes(2);
    expect((mgr as any).activeInteractiveEngines.size).toBe(2);

    releases.get(first.id)?.();
    await firstSend;
    expect((mgr as any).activeInteractiveEngines.has(first.id)).toBe(false);
    expect((mgr as any).activeInteractiveEngines.has(second.id)).toBe(true);

    releases.get(second.id)?.();
    await secondSend;
    expect((mgr as any).activeInteractiveEngines.size).toBe(0);
  });

  it("projects provider admission phase for only the owning interactive session", async () => {
    let releaseProviderQueue!: () => void;
    const providerQueue = new Promise<void>((resolve) => {
      releaseProviderQueue = resolve;
    });
    const createEngine = vi.fn(() => ({
      setToolRuntime: vi.fn(),
      run: vi.fn(async function* (
        _session: unknown,
        opts: {
          onProviderAdmissionPhase?: (
            phase: "queued_for_provider" | "running",
          ) => void;
        },
      ) {
        opts.onProviderAdmissionPhase?.("queued_for_provider");
        await providerQueue;
        opts.onProviderAdmissionPhase?.("running");
        yield {
          type: "done",
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalCacheReadTokens: 0,
          totalCacheCreationTokens: 0,
        };
      }),
      condenseSession: vi.fn(async function* () {}),
      isOverCondenseThreshold: vi.fn(() => false),
    }));
    const mgr = new AgentSessionManager(
      makeConfig(),
      "/tmp",
      undefined,
      false,
      undefined,
      undefined,
      { maxConcurrent: 3 },
      { host: { createEngine: createEngine as any } },
    );
    const session = await mgr.createSession("code");

    const send = mgr.sendMessage(session.id, "queue me", session.mode);
    await vi.waitFor(() => {
      expect(
        mgr.getSessionInfos().find((info) => info.id === session.id)
          ?.interactiveExecutionPhase,
      ).toBe("queued_for_provider");
    });

    releaseProviderQueue();
    await send;
    expect(
      mgr.getSessionInfos().find((info) => info.id === session.id)
        ?.interactiveExecutionPhase,
    ).toBeUndefined();
  });

  it("waits for prepare-time session work to unwind after stop", async () => {
    const mgr = new AgentSessionManager(makeConfig(), "/tmp");
    const session = await mgr.createSession("code");
    (session as any).abort = vi.fn();
    let releasePrepare!: () => void;
    const prepare = new Promise<void>((resolve) => {
      releasePrepare = resolve;
    });
    const queued = (mgr as any).withSessionSendQueue(session.id, () => prepare);
    await flushPromises();

    let stopped = false;
    const stop = mgr.stopSessionAndWait(session.id).then((ids) => {
      stopped = true;
      return ids;
    });
    await flushPromises();
    expect(stopped).toBe(false);

    releasePrepare();
    await queued;
    await expect(stop).resolves.toEqual([session.id]);
  });

  it("stops a running session once and ignores repeated stops", async () => {
    const mgr = new AgentSessionManager(makeConfig(), "/tmp");
    const session = await mgr.createSession("code");
    session.status = "streaming";
    session.runState = { phase: "running", startedAt: Date.now() };
    const abortSpy = vi.fn();
    (session as unknown as { abort: () => void }).abort = abortSpy;
    const changes = vi.fn();
    mgr.onSessionsChanged = changes;

    mgr.stopSession(session.id);

    expect(abortSpy).toHaveBeenCalledTimes(1);
    expect(session.status).toBe("idle");
    expect(session.runState).toBeUndefined();
    const notifyCount = changes.mock.calls.length;
    expect(notifyCount).toBeGreaterThan(0);

    // Regression: re-stopping an already-idle session must be a no-op. The
    // v1.17.71 freeze recursed through stop -> sessions-changed -> tab sync
    // -> stop on the same already-stopped session.
    mgr.stopSession(session.id);
    mgr.interruptSession(session.id);

    expect(abortSpy).toHaveBeenCalledTimes(1);
    expect(changes.mock.calls.length).toBe(notifyCount);
  });

  it("owns stable MCP leases across fresh and inherited request contexts", async () => {
    const hub = {
      getToolDefs: vi.fn(() => []),
      getServerConfig: vi.fn(),
    } as any;
    const releaseParent = vi.fn();
    const releaseChild = vi.fn();
    const retain = vi.fn(() => ({
      projectId: "project",
      generation: 1,
      hub,
      retain: vi.fn(),
      release: releaseChild,
    }));
    const acquire = vi.fn(() => ({
      projectId: "project",
      generation: 1,
      hub,
      retain,
      release: releaseParent,
    }));
    const ensure = vi.fn(() => ({
      projectId: "project",
      generation: 0,
      hub,
    }));
    const mgr = new AgentSessionManager(
      makeConfig(),
      "/tmp",
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      {
        projectMcpHubRegistry: {
          ensure,
          acquire,
          getCurrent: vi.fn(() => ({
            projectId: "project",
            generation: 1,
            hub,
          })),
        } as any,
        host: {
          createToolRuntime: vi.fn(() => ({ executeTool: vi.fn() })) as any,
        },
      },
    );
    const bindSessionProject = vi.fn();
    mgr.setToolContext({
      approvalManager: { bindSessionProject } as any,
      approvalPanel: {} as any,
      sessionId: "agent",
      extensionUri: {} as any,
    });
    const session = await mgr.createSession("code");
    const engine = (mgr as any).host.createEngine(
      (mgr as any).host.providers,
      undefined,
    );

    const parentContext = (mgr as any).bindEngineToSession(engine, session);
    const childContext = (mgr as any).captureSessionToolContext(
      session,
      undefined,
      parentContext,
    );

    expect(bindSessionProject).toHaveBeenCalledWith(
      session.id,
      session.projectScope,
    );
    expect(ensure).toHaveBeenCalledOnce();
    expect(ensure).toHaveBeenCalledWith(session.projectScope);
    expect(acquire).toHaveBeenCalledOnce();
    expect(acquire).toHaveBeenCalledWith(session.projectScope);
    expect(retain).toHaveBeenCalledOnce();
    expect(parentContext.mcpHub).toBe(hub);
    expect(childContext.mcpHub).toBe(hub);

    const currentLease = parentContext.acquireCurrentMcpHub();
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(acquire).toHaveBeenLastCalledWith(session.projectScope);
    expect(currentLease.hub).toBe(hub);
    currentLease.release();

    (mgr as any).releaseSessionToolContext(session.id, childContext);
    (mgr as any).releaseSessionToolContext(session.id, parentContext);
    (mgr as any).releaseSessionToolContext(session.id, parentContext);

    expect(releaseChild).toHaveBeenCalledOnce();
    expect(releaseParent).toHaveBeenCalledTimes(2);
  });

  it("omits unsupported native web tools without rejecting the turn", async () => {
    const createCheckpoint = vi.fn(async () => null);
    const providers = new ProviderRegistry();
    providers.register({
      id: "test",
      displayName: "Test",
      condenseModel: makeConfig().model,
      isAuthenticated: vi.fn(async () => true),
      getCapabilities: vi.fn(() => ({
        supportsThinking: false,
        supportsCaching: false,
        supportsImages: false,
        supportsToolUse: true,
        contextWindow: 200_000,
        maxOutputTokens: 8_192,
      })),
      listModels: vi.fn(() => [
        {
          id: makeConfig().model,
          displayName: "Test model",
          provider: "test",
          capabilities: {
            supportsThinking: false,
            supportsCaching: false,
            supportsImages: false,
            supportsToolUse: true,
            contextWindow: 200_000,
            maxOutputTokens: 8_192,
          },
        },
      ]),
      stream: vi.fn(),
      complete: vi.fn(),
    } as any);
    const mgr = new AgentSessionManager(
      makeConfig(),
      "/tmp",
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      {
        host: {
          providers,
          config: {
            resolveModelForMode: (_mode, fallbackModel) => fallbackModel,
            getCondenseThresholdForModel: () => 0.9,
            getBgSummaryMode: () => "heuristic",
            getBackgroundAgentSettings: () => ({}),
            getWebAccessSettings: () => ({
              searchBackend: "native",
              fetchBackend: "native",
            }),
          },
          createCheckpointManager: vi.fn(() => ({
            baseCommit: null,
            initialize: vi.fn(async () => undefined),
            createCheckpoint,
            previewRevert: vi.fn(async () => null),
            revertToCheckpoint: vi.fn(async () => false),
            getDiffBetween: vi.fn(async () => ""),
          })),
        },
      },
    );
    mgr.setToolContext({
      approvalManager: { bindSessionProject: vi.fn() } as any,
      approvalPanel: {} as any,
      sessionId: "agent",
      extensionUri: {} as any,
    });
    const session = await mgr.createSession("code");
    const prepared = await (mgr as any).prepareTurnExecution(session);

    expect(prepared.policy).toMatchObject({
      backend: "disabled",
      available: false,
      routes: {
        search: {
          backend: "disabled",
          available: false,
          reason: "native_unsupported",
        },
        fetch: {
          backend: "disabled",
          available: false,
          reason: "native_unsupported",
        },
      },
      enabledKinds: [],
    });
    expect(prepared.context.nativeWebToolKinds).toEqual([]);
    expect(createCheckpoint).not.toHaveBeenCalled();
  });

  it("reports an unavailable selected model before native web capability errors", async () => {
    const mgr = new AgentSessionManager(
      { ...makeConfig(), model: "retired-model" },
      "/tmp",
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      {
        host: {
          providers: new ProviderRegistry(),
          config: {
            resolveModelForMode: (_mode, fallbackModel) => fallbackModel,
            getCondenseThresholdForModel: () => 0.9,
            getBgSummaryMode: () => "heuristic",
            getBackgroundAgentSettings: () => ({}),
            getWebAccessSettings: () => ({
              searchBackend: "native",
              fetchBackend: "native",
            }),
          },
        },
      },
    );
    mgr.setToolContext({
      approvalManager: { bindSessionProject: vi.fn() } as any,
      approvalPanel: {} as any,
      sessionId: "agent",
      extensionUri: {} as any,
    });
    const session = await mgr.createSession("code");

    await expect(
      mgr.sendMessage(session.id, "run a local command", session.mode),
    ).rejects.toThrow(
      'Model "retired-model" is no longer available. Select a supported model from the model picker and retry.',
    );
    expect(session.addUserMessage).not.toHaveBeenCalled();
  });

  it("blocks unavailable sessions at every local execution boundary", async () => {
    const run = vi.fn(async function* () {});
    const condenseSession = vi.fn(async function* () {});
    const createCheckpoint = vi.fn(async () => null);
    const previewRevert = vi.fn(async () => null);
    const revertToCheckpoint = vi.fn(async () => false);
    const mgr = new AgentSessionManager(
      makeConfig(),
      "/tmp",
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      {
        host: {
          createEngine: vi.fn(
            () =>
              ({
                setToolRuntime: vi.fn(),
                run,
                condenseSession,
                isOverCondenseThreshold: vi.fn(() => true),
              }) as any,
          ),
        },
      },
    );
    mgr.setToolContext({
      approvalManager: {} as any,
      approvalPanel: {} as any,
      sessionId: "agent",
      extensionUri: {} as any,
    });
    const session = await mgr.createSession("code");
    (session as any).projectAvailability = "missing";
    (mgr as any).checkpointManager = {
      baseCommit: null,
      initialize: vi.fn(),
      createCheckpoint,
      previewRevert,
      revertToCheckpoint,
      getDiffBetween: vi.fn(),
    };
    (mgr as any).checkpoints.set(session.id, [
      {
        id: "checkpoint-1",
        projectId: session.projectScope.projectId,
        commitHash: "hash-1",
        turnIndex: 1,
        createdAt: 1,
      },
    ]);

    const unavailable = "unavailable for local execution";
    await expect(
      mgr.sendMessage(session.id, "do not send", session.mode),
    ).rejects.toThrow(unavailable);
    await expect(mgr.retrySession(session.id)).rejects.toThrow(unavailable);
    await expect(mgr.rebuildSystemPrompts()).rejects.toThrow(unavailable);
    await expect(mgr.setModel("gpt-5.4")).rejects.toThrow(unavailable);
    await expect(
      mgr.switchSessionMode(session.id, "architect"),
    ).rejects.toThrow(unavailable);
    await expect(mgr.condenseCurrentSession()).rejects.toThrow(unavailable);
    await expect(mgr.runBtwQuestion("inspect this")).rejects.toThrow(
      unavailable,
    );
    await expect(
      mgr.spawnBackground(
        { task: "blocked", message: "do not run" },
        session.id,
      ),
    ).rejects.toThrow(unavailable);
    await expect(mgr.createManualCheckpoint()).rejects.toThrow(unavailable);
    await expect(mgr.previewRevert(session.id, "checkpoint-1")).rejects.toThrow(
      unavailable,
    );
    await expect(
      mgr.revertToCheckpoint(session.id, "checkpoint-1"),
    ).resolves.toEqual({ ok: false, reason: "not_found" });

    expect(session.addUserMessage).not.toHaveBeenCalled();
    expect(session.rebuildSystemPrompt).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(condenseSession).not.toHaveBeenCalled();
    expect(createCheckpoint).not.toHaveBeenCalled();
    expect(previewRevert).not.toHaveBeenCalled();
    expect(revertToCheckpoint).not.toHaveBeenCalled();
    expect(mgr.getConfig().model).toBe("claude-sonnet-4-6");
  });
});

describe("AgentSessionManager condense thresholds", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getConfiguration.mockReturnValue({
      get: (key: string) => {
        if (key === "modelCondenseThresholds") {
          return {
            "claude-sonnet-4-6": 0.72,
            "gpt-5.4": 0.83,
            "gpt-5.3-codex": 0.77,
          };
        }
        if (key === "modeModelPreferences") {
          return {
            code: "gpt-5.3-codex",
            architect: "gpt-5.4",
          };
        }
        return undefined;
      },
      inspect: () => undefined,
    });
  });

  it("uses mode-specific model preference when creating a session", async () => {
    const mgr = new AgentSessionManager(makeConfig(), "/tmp");

    await mgr.createSession("code");

    expect(mocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          model: "gpt-5.3-codex",
          autoCondenseThreshold: 0.77,
        }),
      }),
    );
  });

  it("applies persisted per-model thresholds when switching models", async () => {
    const mgr = new AgentSessionManager(makeConfig(), "/tmp");
    const session = await mgr.createSession("code");

    await mgr.setModel("gpt-5.4");

    expect(mgr.getConfig().autoCondenseThreshold).toBe(0.83);
    expect(session.model).toBe("gpt-5.4");
    expect(session.autoCondenseThreshold).toBe(0.83);
  });

  it("switchForegroundMode applies the target mode's preferred model", async () => {
    const mgr = new AgentSessionManager(makeConfig(), "/tmp");
    const session = await mgr.createSession("code");
    (session as any).setMode = vi.fn(async () => {});

    await mgr.switchForegroundMode("architect");

    expect(session.model).toBe("gpt-5.4");
    expect(session.autoCondenseThreshold).toBe(0.83);
    expect((session as any).setMode).toHaveBeenCalledWith(
      "architect",
      expect.objectContaining({
        agentMode: expect.objectContaining({
          slug: "architect",
          toolGroups: expect.arrayContaining(["read", "plan"]),
        }),
      }),
    );
  });

  it("passes an MCP disclosure snapshot when MCP tools are connected", async () => {
    mocks.getConfiguration.mockReturnValue({
      get: () => ({}),
      inspect: () => undefined,
    });
    const mgr = new AgentSessionManager(makeConfig(), "/tmp");
    mgr.setToolContext({
      approvalManager: {} as any,
      approvalPanel: {} as any,
      sessionId: "agent",
      extensionUri: {} as any,
      mcpHub: {
        getToolDefs: () => [
          {
            name: "linear__list_issues",
            description: "List issues",
            input_schema: {
              type: "object",
              properties: { query: { type: "string" } },
            },
          },
          {
            name: "ddg-search__search",
            description: "Search the web",
            input_schema: { type: "object", properties: {} },
          },
        ],
        getServerConfig: (serverName: string) =>
          serverName === "linear" ? { toolDisclosure: "deferred" } : undefined,
      } as any,
    });

    await mgr.createSession("code");

    expect(mocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        mcpToolDisclosure: expect.objectContaining({
          inlineTools: [
            expect.objectContaining({ name: "ddg-search__search" }),
          ],
          deferredTools: [
            expect.objectContaining({ name: "linear__list_issues" }),
          ],
          catalog: expect.arrayContaining([
            expect.objectContaining({
              serverName: "ddg-search",
              toolCount: 1,
              representativeTools: ["search"],
              capabilities: ["web-search"],
            }),
            expect.objectContaining({
              serverName: "linear",
              toolCount: 1,
              representativeTools: ["list_issues"],
            }),
          ]),
        }),
      }),
    );
  });

  it("falls back to model-family defaults when there is no stored override", async () => {
    mocks.getConfiguration.mockReturnValue({
      get: () => ({}),
      inspect: () => undefined,
    });
    const mgr = new AgentSessionManager(makeConfig(), "/tmp");

    await mgr.createSession("code");

    expect(mocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          model: "claude-sonnet-4-6",
          autoCondenseThreshold: 0.8,
        }),
      }),
    );
  });

  it("falls back to default threshold resolution when config access fails", async () => {
    mocks.getConfiguration.mockImplementation(() => {
      throw new Error("boom");
    });
    const log = vi.fn();
    const mgr = new AgentSessionManager(
      makeConfig(),
      "/tmp",
      undefined,
      false,
      undefined,
      log,
    );

    await mgr.createSession("code");

    expect(mocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          model: "claude-sonnet-4-6",
          autoCondenseThreshold: 0.8,
        }),
      }),
    );
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining(
        "Failed to resolve configured condense threshold for claude-sonnet-4-6",
      ),
    );
  });
});

describe("AgentSessionManager manual condense", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getConfiguration.mockReturnValue({
      get: () => undefined,
      inspect: () => undefined,
    });
  });

  it("fails closed when workspace execution is disabled", async () => {
    const reason = "Resolve the history-storage conflict before continuing.";
    const mgr = new AgentSessionManager(
      makeConfig(),
      "/tmp",
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      { executionUnavailableReason: reason },
    );

    expect(mgr.getDefaultProjectScope()).toBeUndefined();
    expect(mgr.getWorkspaceProjects()).toEqual([
      expect.objectContaining({
        rootPath: undefined,
        availability: expect.objectContaining({
          status: "unavailable",
          message: reason,
        }),
      }),
    ]);
    await expect(mgr.createSession("code")).rejects.toThrow(reason);
  });

  it("does not start an agent turn after a successful manual condense", async () => {
    const providers = new ProviderRegistry();
    providers.register({
      id: "test",
      displayName: "Test",
      condenseModel: makeConfig().model,
      isAuthenticated: vi.fn(async () => true),
      getCapabilities: vi.fn(() => ({
        supportsThinking: false,
        supportsCaching: false,
        supportsImages: false,
        supportsToolUse: true,
        contextWindow: 200_000,
        maxOutputTokens: 8_192,
        hostedWeb: {
          search: { supported: true },
          fetch: { supported: false },
        },
      })),
      listModels: vi.fn(() => [
        {
          id: makeConfig().model,
          displayName: "Test model",
          provider: "test",
          capabilities: {
            supportsThinking: false,
            supportsCaching: false,
            supportsImages: false,
            supportsToolUse: true,
            contextWindow: 200_000,
            maxOutputTokens: 8_192,
          },
        },
      ]),
      stream: vi.fn(),
      complete: vi.fn(),
    } as any);
    const mgr = new AgentSessionManager(
      makeConfig(),
      "/tmp",
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      {
        host: {
          providers,
          config: {
            resolveModelForMode: (_mode, fallbackModel) => fallbackModel,
            getCondenseThresholdForModel: () => 0.9,
            getBgSummaryMode: () => "heuristic",
            getBackgroundAgentSettings: () => ({}),
            getWebAccessSettings: () => ({
              searchBackend: "native",
              fetchBackend: "disabled",
            }),
          },
        },
      },
    );
    mgr.setToolContext({
      approvalManager: { bindSessionProject: vi.fn() } as any,
      approvalPanel: {} as any,
      sessionId: "agent",
      extensionUri: { fsPath: "/tmp" } as any,
    });
    const session = await mgr.createSession("ask");
    session.status = "idle";
    (session as any).loadedSkills = new Set(["web-writer"]);
    vi.mocked(session.getActiveSkillAllowedTools).mockReturnValue([
      "web_search",
      "write_file",
    ]);
    (session as any).createAbortController = vi.fn(() => new AbortController());
    (mgr as any).foregroundId = session.id;
    const todos = [
      {
        id: "resume",
        content: "Resume the implementation",
        activeForm: "Resuming the implementation",
        status: "in_progress" as const,
      },
    ];
    const messages: AgentMessage[] = [
      { role: "user", content: "Implement the feature" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "todo-1",
            name: "todo_write",
            input: { todos },
          },
        ],
      },
    ];
    vi.mocked(session.getAllMessages).mockReturnValue(messages);

    const onEvent = vi.fn();
    mgr.onEvent = onEvent;

    const engine = {
      setToolRuntime: vi.fn(),
      condenseSession: vi.fn(async function* () {
        yield { type: "condense_start", isAutomatic: false };
        yield {
          type: "condense",
          summary: "summary",
          prevInputTokens: 10_000,
          newInputTokens: 2_000,
        };
      }),
      run: vi.fn(async function* () {
        yield { type: "text_delta", text: "continued" };
        yield {
          type: "done",
          totalInputTokens: 10,
          totalOutputTokens: 5,
          totalCacheReadTokens: 0,
          totalCacheCreationTokens: 0,
        };
      }),
      isOverCondenseThreshold: vi.fn(() => false),
    };

    (mgr as any).host.createEngine = vi.fn(() => engine);

    await mgr.condenseCurrentSession();

    expect(engine.condenseSession).toHaveBeenCalledTimes(1);
    expect(engine.condenseSession).toHaveBeenCalledWith(
      session,
      false,
      undefined,
      expect.objectContaining({
        todos,
        toolNames: expect.arrayContaining([
          "web_search",
          "write_file",
          "find_native_tools",
          "call_native_tool",
          "todo_write",
        ]),
      }),
      session.model,
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        tools: expect.arrayContaining([
          expect.objectContaining({ name: "web_search" }),
          expect.objectContaining({ name: "write_file" }),
          expect.objectContaining({ name: "find_native_tools" }),
          expect.objectContaining({ name: "call_native_tool" }),
          expect.objectContaining({ name: "todo_write" }),
        ]),
      }),
    );
    const condenseOptions = (
      engine.condenseSession.mock.calls as unknown[][]
    )[0]?.[5] as { tools?: Array<{ name: string }> } | undefined;
    expect(
      condenseOptions?.tools?.some((tool) => tool.name === "read_file"),
    ).toBe(false);
    expect(
      condenseOptions?.tools?.some(
        (tool) => tool.name === "get_call_hierarchy",
      ),
    ).toBe(false);
    expect(engine.setToolRuntime).toHaveBeenCalledOnce();
    expect(engine.run).not.toHaveBeenCalled();
    expect(onEvent).toHaveBeenCalledWith(
      session.id,
      expect.objectContaining({ type: "condense" }),
    );
    expect(onEvent).not.toHaveBeenCalledWith(
      session.id,
      expect.objectContaining({ type: "text_delta" }),
    );
    expect(session.status).toBe("idle");
  });

  it("does not report an aborted manual condense as an error", async () => {
    const mgr = new AgentSessionManager(makeConfig(), "/tmp");
    const session = await mgr.createSession("code");
    session.status = "idle";
    (session as any).loadedSkills = new Set<string>();
    (session as any).createAbortController = vi.fn(() => {
      const controller = new AbortController();
      controller.abort();
      return controller;
    });
    (mgr as any).foregroundId = session.id;
    const onEvent = vi.fn();
    mgr.onEvent = onEvent;
    const engine = {
      condenseSession: vi.fn(async function* () {
        yield { type: "condense_start", isAutomatic: false };
        throw new DOMException("Model request admission aborted", "AbortError");
      }),
      run: vi.fn(async function* () {}),
      isOverCondenseThreshold: vi.fn(() => false),
    };
    (mgr as any).host.createEngine = vi.fn(() => engine);

    await mgr.condenseCurrentSession();

    expect(onEvent).not.toHaveBeenCalledWith(
      session.id,
      expect.objectContaining({ type: "condense_error" }),
    );
    expect(session.status).toBe("idle");
  });

  it("queues manual condense behind active session work", async () => {
    const mgr = new AgentSessionManager(makeConfig(), "/tmp");
    const session = await mgr.createSession("code");
    session.status = "idle";
    (session as any).loadedSkills = new Set<string>();
    (session as any).createAbortController = vi.fn(() => new AbortController());
    (mgr as any).foregroundId = session.id;
    let releaseActiveWork!: () => void;
    const activeWork = new Promise<void>((resolve) => {
      releaseActiveWork = resolve;
    });
    const queuedWork = (mgr as any).withSessionSendQueue(
      session.id,
      () => activeWork,
    );
    const engine = {
      condenseSession: vi.fn(async function* () {
        yield { type: "condense_error", error: "stopped" };
      }),
      run: vi.fn(async function* () {}),
      isOverCondenseThreshold: vi.fn(() => false),
    };
    (mgr as any).host.createEngine = vi.fn(() => engine);

    const condense = mgr.condenseCurrentSession();
    await flushPromises();
    expect(engine.condenseSession).not.toHaveBeenCalled();
    releaseActiveWork();
    await queuedWork;
    await condense;
    expect(engine.condenseSession).toHaveBeenCalledTimes(1);
  });

  it("does not continue the agent turn when manual condense does not succeed", async () => {
    const mgr = new AgentSessionManager(makeConfig(), "/tmp");
    const session = await mgr.createSession("code");
    session.status = "idle";
    (session as any).loadedSkills = new Set<string>();
    (session as any).createAbortController = vi.fn(() => new AbortController());
    (mgr as any).foregroundId = session.id;

    const engine = {
      condenseSession: vi.fn(async function* () {
        yield { type: "condense_start", isAutomatic: false };
        yield { type: "condense_error", error: "failed" };
      }),
      run: vi.fn(async function* () {
        yield { type: "text_delta", text: "continued" };
      }),
      isOverCondenseThreshold: vi.fn(() => false),
    };

    (mgr as any).host.createEngine = vi.fn(() => engine);

    await mgr.condenseCurrentSession();

    expect(engine.condenseSession).toHaveBeenCalledTimes(1);
    expect(engine.run).not.toHaveBeenCalled();
  });
});

describe("AgentSessionManager in-flight persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mocks.getConfiguration.mockReturnValue({
      get: () => undefined,
      inspect: () => undefined,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("recovers a pending tool turn with saved and synthetic results", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "inspect both files" },
    ];
    const runState: PersistedSessionRunState = {
      phase: "running",
      startedAt: 123,
      pendingToolTurn: {
        schemaVersion: 1,
        assistantMessage: {
          role: "assistant",
          content: [
            { type: "text", text: "Checking both." },
            {
              type: "tool_use",
              id: "call_a",
              name: "read_file",
              input: { path: "a.ts" },
            },
            {
              type: "tool_use",
              id: "call_b",
              name: "read_file",
              input: { path: "b.ts" },
            },
          ],
        },
        toolResults: [
          {
            type: "tool_result",
            tool_use_id: "call_a",
            content: "contents of a.ts",
          },
        ],
      },
    };

    const recovered = recoverInterruptedRunMessages(messages, runState);

    expect(recovered.changed).toBe(true);
    expect(recovered.runState).toEqual({
      phase: "running",
      startedAt: 123,
    });
    expect(recovered.messages).toHaveLength(3);
    expect(recovered.messages[1]).toEqual(
      runState.pendingToolTurn?.assistantMessage,
    );
    expect(recovered.messages[2]).toMatchObject({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call_a",
          content: "contents of a.ts",
        },
        {
          type: "tool_result",
          tool_use_id: "call_b",
          content: expect.stringContaining("interrupted"),
          is_error: true,
        },
      ],
    });

    const deduplicated = recoverInterruptedRunMessages(
      recovered.messages,
      runState,
    );
    expect(deduplicated.messages).toHaveLength(recovered.messages.length);
    expect(deduplicated.runState).toEqual({
      phase: "running",
      startedAt: 123,
    });
  });

  it("recovers partial streamed assistant text without duplicating a newer committed response", () => {
    const partialState: PersistedSessionRunState = {
      phase: "running",
      startedAt: 123,
      partialAssistantText: "A partially streamed answer",
    };

    const recovered = recoverInterruptedRunMessages(
      [{ role: "user", content: "answer this" }],
      partialState,
    );
    expect(recovered.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "A partially streamed answer" }],
    });

    const deduplicated = recoverInterruptedRunMessages(
      [
        { role: "user", content: "answer this" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "A partially streamed answer, done." },
          ],
        },
      ],
      {
        ...partialState,
        partialAssistantText: "A partially streamed answer",
      },
    );
    expect(deduplicated.messages).toHaveLength(2);
    expect(deduplicated.runState).toEqual({
      phase: "running",
      startedAt: 123,
    });
  });

  it("preserves an unknown pending tool-turn schema for a newer build", () => {
    const runState = {
      phase: "running",
      startedAt: 123,
      pendingToolTurn: {
        schemaVersion: 2,
        assistantMessage: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "call_future",
              name: "future_tool",
              input: {},
            },
          ],
        },
        toolResults: [],
      },
    } as unknown as PersistedSessionRunState;
    const messages: AgentMessage[] = [
      { role: "user", content: "use the future tool" },
    ];

    expect(recoverInterruptedRunMessages(messages, runState)).toEqual({
      messages,
      runState,
      changed: false,
    });
  });

  it("materializes a pending tool turn exactly once across real store reloads", async () => {
    const workspace = fs.mkdtempSync(
      path.join(os.tmpdir(), "agentlink-recovery-roundtrip-"),
    );

    try {
      const workspaceFolderUri = pathToFileURL(workspace).toString();
      const projectScope = {
        schemaVersion: 1 as const,
        kind: "project" as const,
        projectId: createWorkspaceProjectId(workspaceFolderUri),
        workspaceFolderUri,
        displayName: workspace,
        rootPath: workspace,
      };
      const summary = {
        schemaVersion: 1 as const,
        id: "session-1",
        mode: "code",
        model: "claude-sonnet-4-6",
        title: "Interrupted",
        messageCount: 1,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        createdAt: 100,
        lastActiveAt: 123,
        projectScope,
      };
      const seedStore = new SessionStore(workspace);
      await expect(
        seedStore.saveSession({
          expectedRevision: null,
          session: {
            summary,
            messages: [
              { role: "user", content: "inspect both files" },
            ] satisfies AgentMessage[],
            metadata: {
              projectScope,
              mode: summary.mode,
              model: summary.model,
              totalInputTokens: 0,
              totalOutputTokens: 0,
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
              runState: {
                phase: "running",
                projectId: projectScope.projectId,
                startedAt: 123,
                pendingToolTurn: {
                  schemaVersion: 1,
                  assistantMessage: {
                    role: "assistant",
                    content: [
                      { type: "text", text: "Checking both." },
                      {
                        type: "tool_use",
                        id: "call-a",
                        name: "read_file",
                        input: { path: "a.ts" },
                      },
                      {
                        type: "tool_use",
                        id: "call-b",
                        name: "read_file",
                        input: { path: "b.ts" },
                      },
                    ],
                  },
                  toolResults: [
                    {
                      type: "tool_result",
                      tool_use_id: "call-a",
                      content: "saved a.ts contents",
                    },
                  ],
                },
              },
            },
          },
        }),
      ).resolves.toEqual({ ok: true, revision: "1" });

      const makeRestoredHarness = () => {
        const messages: AgentMessage[] = [];
        const session = {
          id: "unrestored",
          mode: "code",
          model: "claude-sonnet-4-6",
          projectScope,
          projectAvailability: "available",
          title: "New Chat",
          createdAt: 0,
          lastActiveAt: 0,
          background: false,
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
          currentTool: undefined,
          runState: undefined,
          isAborted: false,
          abortGeneration: 0,
          getLoadedSkills: vi.fn(() => []),
          getAllMessages: vi.fn(() => messages),
          restoreFromStore: vi.fn((data: any) => {
            Object.assign(session, data);
            messages.splice(0, messages.length, ...data.messages);
            session.messageCount = messages.length;
          }),
          rebuildSystemPrompt: vi.fn(async () => {}),
          consumePendingInterjection: vi.fn(() => null),
          consumePendingModeResume: vi.fn(() => null),
          autoTitle: vi.fn(),
        } as any;
        return { session, messages };
      };

      const first = makeRestoredHarness();
      const second = makeRestoredHarness();
      mocks.createSession
        .mockResolvedValueOnce(first.session)
        .mockResolvedValueOnce(second.session);

      const firstManager = new AgentSessionManager(
        makeConfig(),
        workspace,
        undefined,
        false,
        new SessionStore(workspace),
      );
      await expect(firstManager.restoreLastSession()).resolves.toBe(
        first.session,
      );

      expect(first.messages).toHaveLength(3);
      expect(first.messages[1]).toMatchObject({
        role: "assistant",
        content: expect.arrayContaining([
          expect.objectContaining({ type: "tool_use", id: "call-a" }),
          expect.objectContaining({ type: "tool_use", id: "call-b" }),
        ]),
      });
      expect(first.messages[2]).toMatchObject({
        role: "user",
        content: [
          expect.objectContaining({
            tool_use_id: "call-a",
            content: "saved a.ts contents",
          }),
          expect.objectContaining({
            tool_use_id: "call-b",
            is_error: true,
            content: expect.stringContaining("interrupted"),
          }),
        ],
      });

      const rewrittenStore = new SessionStore(workspace);
      const rewritten = await rewrittenStore.readSession("session-1");
      if (!rewritten.ok) throw new Error("Expected rewritten session");
      expect(rewritten.revision).toBe("2");
      expect(rewritten.value.summary.messageCount).toBe(3);
      expect(rewritten.value.metadata.runState).toEqual({
        phase: "running",
        projectId: projectScope.projectId,
        startedAt: 123,
      });

      const secondManagerStore = new SessionStore(workspace);
      const beforeSecondReload =
        await secondManagerStore.readSession("session-1");
      if (!beforeSecondReload.ok) {
        throw new Error("Expected saved session before second reload");
      }
      const secondManager = new AgentSessionManager(
        makeConfig(),
        workspace,
        undefined,
        false,
        secondManagerStore,
      );
      await expect(secondManager.restoreLastSession()).resolves.toBe(
        second.session,
      );
      const afterSecondReload =
        await secondManagerStore.readSession("session-1");
      if (!afterSecondReload.ok) {
        throw new Error("Expected saved session after second reload");
      }

      expect(second.messages).toEqual(rewritten.value.messages);
      expect(second.messages).toHaveLength(3);
      expect(afterSecondReload.revision).toBe(beforeSecondReload.revision);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("persists the engine's pending tool-turn snapshot through production manager wiring", async () => {
    const savedRecords: PersistedSessionRecord[] = [];
    const store = {
      saveSession: vi.fn(async (args: { session: PersistedSessionRecord }) => {
        savedRecords.push(structuredClone(args.session));
        return { ok: true, revision: String(savedRecords.length) };
      }),
      list: vi.fn(() => []),
      get: vi.fn(),
      loadMessages: vi.fn(),
      loadMetadata: vi.fn(),
    } as any;
    const mgr = new AgentSessionManager(
      makeConfig(),
      "/tmp",
      undefined,
      false,
      store,
    );
    const session = await mgr.createSession("code");
    const messages: AgentMessage[] = [];
    (session as any).messageCount = 0;
    (session as any).isAborted = false;
    (session as any).lastActiveAt = 123;
    (session as any).getAllMessages = vi.fn(() => messages);
    (session as any).addUserMessage = vi.fn((text: string) => {
      messages.push({ role: "user", content: text });
      (session as any).messageCount = messages.length;
      session.lastActiveAt += 1;
    });
    (session as any).consumePendingInterjection = vi.fn(() => null);
    (session as any).consumePendingModeResume = vi.fn(() => null);
    (session as any).autoTitle = vi.fn();
    (mgr as any).host.createEngine = vi.fn(() => ({
      run: vi.fn(async function* (_session: unknown, opts: any) {
        yield {
          type: "text_delta",
          text: "Already committed prefix",
        };
        opts.onAssistantTurnCommitted();
        yield {
          type: "text_delta",
          text: "Distinct streamed partial",
        };
        await new Promise<void>((resolve) => setTimeout(resolve, 1_100));
        await opts.onPendingToolTurn({
          role: "assistant",
          content: [
            { type: "text", text: "Distinct recovery text" },
            {
              type: "tool_use",
              id: "call_distinct",
              name: "read_file",
              input: { path: "distinct.ts" },
            },
          ],
        });
        yield {
          type: "tool_start",
          toolCallId: "call_distinct",
          toolName: "read_file",
        };
        yield {
          type: "tool_result",
          toolCallId: "call_distinct",
          toolName: "read_file",
          result: [{ type: "text", text: "full UI result" }],
          historyContent: "Distinct saved tool result",
          durationMs: 5,
        };
        await new Promise<void>((resolve) => setTimeout(resolve, 1_100));
        opts.onAssistantTurnCommitted();
        yield {
          type: "done",
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalCacheReadTokens: 0,
          totalCacheCreationTokens: 0,
        };
      }),
    }));

    const send = mgr.sendMessage(session.id, "start", session.mode);
    await flushPromises();
    await vi.advanceTimersByTimeAsync(2_500);
    await send;

    expect(
      savedRecords.some(
        (record) =>
          record.metadata.runState?.phase === "running" &&
          (
            JSON.stringify(
              record.metadata.runState.pendingToolTurn?.assistantMessage
                .content,
            ) ?? ""
          ).includes("Distinct recovery text"),
      ),
    ).toBe(true);
    expect(
      savedRecords.some(
        (record) =>
          record.metadata.runState?.phase === "running" &&
          record.metadata.runState.partialAssistantText ===
            "Distinct streamed partial",
      ),
    ).toBe(true);
    expect(
      savedRecords.some(
        (record) =>
          record.metadata.runState?.pendingToolTurn?.toolResults[0]
            ?.tool_use_id === "call_distinct" &&
          record.metadata.runState.pendingToolTurn.toolResults[0]?.content ===
            "Distinct saved tool result",
      ),
    ).toBe(true);
  });

  it("persists runState while a foreground turn is in-flight and clears it on done", async () => {
    const savedRunStates: Array<string | null> = [];
    const store = {
      saveSession: vi.fn(async (args: { session: PersistedSessionRecord }) => {
        savedRunStates.push(args.session.metadata.runState?.phase ?? null);
        return { ok: true, revision: String(savedRunStates.length) };
      }),
      list: vi.fn(() => []),
      get: vi.fn(),
      loadMessages: vi.fn(),
      loadMetadata: vi.fn(),
    } as any;

    const mgr = new AgentSessionManager(
      makeConfig(),
      "/tmp",
      undefined,
      false,
      store,
    );
    const session = await mgr.createSession("code");
    const messages: AgentMessage[] = [];
    (session as any).messageCount = 0;
    (session as any).isAborted = false;
    (session as any).lastActiveAt = 123;
    (session as any).getAllMessages = vi.fn(() => messages);
    (session as any).addUserMessage = vi.fn((text: string) => {
      messages.push({ role: "user", content: text });
      (session as any).messageCount = messages.length;
      session.lastActiveAt += 1;
    });
    (session as any).consumePendingInterjection = vi.fn(() => null);
    (session as any).consumePendingModeResume = vi.fn(() => null);
    (session as any).autoTitle = vi.fn();
    (mgr as any).host.createEngine = vi.fn(() => ({
      run: vi.fn(async function* () {
        yield {
          type: "done",
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalCacheReadTokens: 0,
          totalCacheCreationTokens: 0,
        };
      }),
    }));

    await mgr.sendMessage(session.id, "continue", session.mode);

    expect(savedRunStates).toContain("running");
    expect(savedRunStates.at(-1)).toBeNull();
    expect(session.runState).toBeUndefined();
  });

  it("persists a pending ask_user recovery snapshot", async () => {
    const savedRunStates: Array<unknown> = [];
    const store = {
      saveSession: vi.fn(async (args: { session: PersistedSessionRecord }) => {
        savedRunStates.push(args.session.metadata.runState);
        return { ok: true, revision: String(savedRunStates.length) };
      }),
      list: vi.fn(() => []),
      get: vi.fn(),
      loadMessages: vi.fn(),
      loadMetadata: vi.fn(),
    } as any;

    const mgr = new AgentSessionManager(
      makeConfig(),
      "/tmp",
      undefined,
      false,
      store,
    );
    const session = await mgr.createSession("code");
    (mgr as any).activeInteractiveEngines.set(session.id, {
      sessionId: session.id,
      engine: {},
      phase: "running",
    });

    await mgr.persistPendingQuestionRecovery(
      session.id,
      "question-1",
      "Pick one.",
      [
        {
          id: "choice",
          type: "multiple_choice",
          question: "Which path?",
          options: ["A", "B"],
          recommended: "A",
        },
      ],
      {
        schemaVersion: 1,
        assistantContent: [
          {
            type: "tool_use",
            id: "toolu-1",
            name: "ask_user",
            input: {},
          },
        ],
        toolUseId: "toolu-1",
        toolName: "ask_user",
        toolInput: {},
      },
    );

    expect(session.runState?.phase).toBe("awaiting_question");
    expect(savedRunStates.at(-1)).toMatchObject({
      phase: "awaiting_question",
      question: {
        questionRequestId: "question-1",
        context: "Pick one.",
        toolUseId: "toolu-1",
      },
    });
    expect(
      mgr.getSessionInfos().find((info) => info.id === session.id)
        ?.interactiveExecutionPhase,
    ).toBe("awaiting_input");

    mgr.clearPendingQuestionRecovery(session.id, "different-question");
    expect(
      mgr.getSessionInfos().find((info) => info.id === session.id)
        ?.interactiveExecutionPhase,
    ).toBe("awaiting_input");

    mgr.clearPendingQuestionRecovery(session.id, "question-1");
    expect(
      mgr.getSessionInfos().find((info) => info.id === session.id)
        ?.interactiveExecutionPhase,
    ).toBe("running");
  });

  it("does not append a recovered answer when the saved tool turn is malformed", async () => {
    const store = {
      saveSession: vi.fn(async () => ({ ok: true, revision: "1" })),
      list: vi.fn(() => []),
      get: vi.fn(),
      loadMessages: vi.fn(),
      loadMetadata: vi.fn(),
    } as any;

    const mgr = new AgentSessionManager(
      makeConfig(),
      "/tmp",
      undefined,
      false,
      store,
    );
    const session = await mgr.createSession("code");
    (session as any).appendAssistantMessage = vi.fn();
    (session as any).appendToolResults = vi.fn();

    await mgr.persistPendingQuestionRecovery(
      session.id,
      "question-1",
      "Pick one.",
      [
        {
          id: "choice",
          type: "multiple_choice",
          question: "Which path?",
          options: ["A", "B"],
          recommended: "A",
        },
      ],
      {
        schemaVersion: 1,
        assistantContent: [],
        toolUseId: "toolu-missing",
        toolName: "ask_user",
        toolInput: {},
      },
    );

    await expect(
      mgr.answerRecoveredQuestion(session.id, "question-1", {
        answers: { choice: "A" },
        notes: {},
      }),
    ).resolves.toBe(false);

    expect(session.appendAssistantMessage).not.toHaveBeenCalled();
    expect(session.appendToolResults).not.toHaveBeenCalled();
    expect(session.runState?.phase).toBe("running");
  });

  it("answers a recovered ask_user by appending the saved tool turn and continuing", async () => {
    const store = {
      saveSession: vi.fn(async () => ({ ok: true, revision: "1" })),
      list: vi.fn(() => []),
      get: vi.fn(),
      loadMessages: vi.fn(),
      loadMetadata: vi.fn(),
    } as any;

    const mgr = new AgentSessionManager(
      makeConfig(),
      "/tmp",
      undefined,
      false,
      store,
    );
    const session = await mgr.createSession("code");
    const appended: AgentMessage[] = [];
    (session as any).appendAssistantMessage = vi.fn((message: AgentMessage) => {
      appended.push(message);
    });
    (session as any).appendToolResults = vi.fn((content: any) => {
      appended.push({ role: "user", content });
    });
    const retrySession = vi
      .spyOn(mgr, "retrySession")
      .mockResolvedValue(undefined);

    await mgr.persistPendingQuestionRecovery(
      session.id,
      "question-1",
      "Pick one.",
      [
        {
          id: "choice",
          type: "multiple_choice",
          question: "Which path?",
          options: ["A", "B"],
          recommended: "A",
        },
      ],
      {
        schemaVersion: 1,
        assistantContent: [
          {
            type: "tool_use",
            id: "toolu-1",
            name: "ask_user",
            input: { context: "Pick one." },
          },
        ],
        toolUseId: "toolu-1",
        toolName: "ask_user",
        toolInput: { context: "Pick one." },
      },
    );

    await expect(
      mgr.answerRecoveredQuestion(session.id, "question-1", {
        answers: { choice: "A" },
        notes: { choice: "Recommended path" },
      }),
    ).resolves.toBe(true);

    expect(appended[0]).toMatchObject({ role: "assistant" });
    expect(appended[1]).toMatchObject({
      role: "user",
      content: [
        expect.objectContaining({
          type: "tool_result",
          tool_use_id: "toolu-1",
          content: expect.stringContaining("Recommended path"),
        }),
      ],
    });
    expect(session.runState?.phase).toBe("running");
    expect(retrySession).toHaveBeenCalledWith(session.id);
  });

  it("answers a recovered ask_user with saved results for completed sibling tool calls", async () => {
    const store = {
      saveSession: vi.fn(async () => ({ ok: true, revision: "1" })),
      list: vi.fn(() => []),
      get: vi.fn(),
      loadMessages: vi.fn(),
      loadMetadata: vi.fn(),
    } as any;

    const mgr = new AgentSessionManager(
      makeConfig(),
      "/tmp",
      undefined,
      false,
      store,
    );
    const session = await mgr.createSession("code");
    const appended: AgentMessage[] = [];
    (session as any).appendAssistantMessage = vi.fn((message: AgentMessage) => {
      appended.push(message);
    });
    (session as any).appendToolResults = vi.fn((content: any) => {
      appended.push({ role: "user", content });
    });
    vi.spyOn(mgr, "retrySession").mockResolvedValue(undefined);

    session.runState = {
      phase: "running",
      startedAt: 1,
      pendingToolTurn: {
        schemaVersion: 1,
        assistantMessage: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu-sibling",
              name: "get_background_status",
              input: { sessionId: "bg-1" },
            },
            {
              type: "tool_use",
              id: "toolu-1",
              name: "ask_user",
              input: { context: "Pick one." },
            },
          ],
          providerReplay: {
            providerId: "anthropic",
            codecVersion: 1,
            payload: { id: "provider-response-1" },
            serializedBytes: 1,
          },
        },
        toolResults: [
          {
            type: "tool_result",
            tool_use_id: "toolu-sibling",
            content: "saved sibling status",
          },
        ],
      },
    };

    await mgr.persistPendingQuestionRecovery(
      session.id,
      "question-1",
      "Pick one.",
      [
        {
          id: "choice",
          type: "multiple_choice",
          question: "Which path?",
          options: ["A", "B"],
          recommended: "A",
        },
      ],
      {
        schemaVersion: 1,
        assistantContent: [
          {
            type: "tool_use",
            id: "toolu-sibling",
            name: "get_background_status",
            input: { sessionId: "bg-1" },
          },
          {
            type: "tool_use",
            id: "toolu-1",
            name: "ask_user",
            input: { context: "Pick one." },
          },
        ],
        toolUseId: "toolu-1",
        toolName: "ask_user",
        toolInput: { context: "Pick one." },
      },
    );

    await expect(
      mgr.answerRecoveredQuestion(session.id, "question-1", {
        answers: { choice: "A" },
        notes: {},
      }),
    ).resolves.toBe(true);

    expect(appended[0]).toMatchObject({
      role: "assistant",
      providerReplay: {
        providerId: "anthropic",
        payload: { id: "provider-response-1" },
      },
    });
    expect(appended[1]).toMatchObject({
      role: "user",
      content: [
        expect.objectContaining({
          type: "tool_result",
          tool_use_id: "toolu-sibling",
          content: "saved sibling status",
        }),
        expect.objectContaining({
          type: "tool_result",
          tool_use_id: "toolu-1",
          content: expect.stringContaining('"answer":"A"'),
        }),
      ],
    });
  });

  it("restores persisted runState and resumes with an interruption notice", async () => {
    const savedMessages: AgentMessage[][] = [];
    const summary = {
      id: "session-1",
      mode: "code",
      model: "claude-sonnet-4-6",
      title: "Interrupted session",
      messageCount: 1,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      createdAt: 100,
      lastActiveAt: 123,
      schemaVersion: 1,
    };
    const store = {
      saveSession: vi.fn(async (args: { session: PersistedSessionRecord }) => {
        savedMessages.push(args.session.messages);
        return { ok: true, revision: String(savedMessages.length + 2) };
      }),
      readSession: vi.fn(async () => ({
        ok: true,
        revision: "2",
        value: {
          summary,
          messages: [{ role: "user", content: "original task" }],
          metadata: {
            mode: "code",
            model: "claude-sonnet-4-6",
            totalInputTokens: 0,
            totalOutputTokens: 0,
            runState: { phase: "running", startedAt: 123 },
            checkpointState: { baseCommit: null, checkpoints: [] },
          },
        },
      })),
      list: vi.fn(() => [summary]),
      get: vi.fn(() => summary),
      loadMessages: vi.fn(() => []),
      loadMetadata: vi.fn(() => null),
    } as any;

    const restoredMessages: AgentMessage[] = [];
    const session = {
      id: "session-temp",
      mode: "code",
      model: "claude-sonnet-4-6",
      title: "New Chat",
      background: false,
      status: "idle",
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
      lastInputTokens: 0,
      lastOutputTokens: 0,
      lastCacheReadTokens: 0,
      lastActiveAt: 123,
      currentTool: undefined,
      runState: undefined,
      messageCount: 0,
      isAborted: false,
      abortGeneration: 0,
      addUserMessage: vi.fn((text: string) => {
        restoredMessages.push({ role: "user", content: text });
        session.messageCount = restoredMessages.length;
        session.lastActiveAt += 1;
      }),
      getAllMessages: vi.fn(() => restoredMessages),
      restoreFromStore: vi.fn((data: any) => {
        session.id = data.id;
        session.title = data.title;
        session.lastActiveAt = data.lastActiveAt;
        session.runState = data.runState;
        restoredMessages.splice(0, restoredMessages.length, ...data.messages);
        session.messageCount = restoredMessages.length;
      }),
      rebuildSystemPrompt: vi.fn(async () => {}),
      consumePendingInterjection: vi.fn(() => null),
      consumePendingModeResume: vi.fn(() => null),
      autoTitle: vi.fn(),
    } as any;
    mocks.createSession.mockResolvedValueOnce(session);

    const mgr = new AgentSessionManager(
      makeConfig(),
      "/tmp",
      undefined,
      false,
      store,
    );
    const loaded = await mgr.restoreLastSession();
    expect(loaded?.runState?.phase).toBe("running");

    (mgr as any).host.createEngine = vi.fn(() => ({
      run: vi.fn(async function* () {
        yield {
          type: "done",
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalCacheReadTokens: 0,
          totalCacheCreationTokens: 0,
        };
      }),
    }));

    await expect(
      Promise.all([
        mgr.resumeInterruptedSession("session-1"),
        mgr.resumeInterruptedSession("session-1"),
      ]),
    ).resolves.toEqual([true, false]);

    await vi.waitFor(() => expect(loaded?.runState).toBeUndefined());
    const flattened = savedMessages.flat().map((message) => message.content);
    expect(flattened).toEqual(
      expect.arrayContaining([
        expect.stringContaining("<interrupted_session_resume>"),
      ]),
    );
    expect(
      restoredMessages.filter(
        (message) =>
          typeof message.content === "string" &&
          message.content.includes("<interrupted_session_resume>"),
      ),
    ).toHaveLength(1);
    expect(loaded?.runState).toBeUndefined();
  });

  it("serializes immediate revision-aware saves so create is followed by update", async () => {
    const expectedRevisions: Array<string | null> = [];
    const store = {
      saveSession: vi.fn(async (args: { expectedRevision: string | null }) => {
        expectedRevisions.push(args.expectedRevision);
        return { ok: true, revision: String(expectedRevisions.length) };
      }),
      list: vi.fn(() => []),
      get: vi.fn(),
      loadMessages: vi.fn(),
      loadMetadata: vi.fn(),
    } as any;

    const mgr = new AgentSessionManager(
      makeConfig(),
      "/tmp",
      undefined,
      false,
      store,
    );
    const session = await mgr.createSession("code");
    (session as any).getAllMessages = vi.fn(() => [
      { role: "user", content: "first" },
    ]);

    mgr.saveSession(session.id);
    mgr.saveSession(session.id);
    await flushPromises();
    await flushPromises();

    expect(expectedRevisions).toEqual([null, "1"]);
  });

  it("periodically saves session progress before done while a turn is in-flight", async () => {
    const savedCounts: number[] = [];
    const store = {
      save: vi.fn((entry: { getAllMessages: () => AgentMessage[] }) => {
        savedCounts.push(entry.getAllMessages().length);
      }),
      list: vi.fn(() => []),
      get: vi.fn(),
      loadMessages: vi.fn(),
      loadMetadata: vi.fn(),
    } as any;

    const mgr = new AgentSessionManager(
      makeConfig(),
      "/tmp",
      undefined,
      false,
      store,
    );

    const session = await mgr.createSession("code");
    const messages: AgentMessage[] = [];
    (session as any).getAllMessages = vi.fn(() => messages);
    (session as any).addUserMessage = vi.fn((text: string) => {
      messages.push({ role: "user", content: text });
      session.lastActiveAt = Date.now();
    });
    (session as any).appendAssistantTurn = vi.fn((content: unknown) => {
      messages.push({ role: "assistant", content: content as any });
      session.lastActiveAt = Date.now();
    });
    (session as any).appendToolResults = vi.fn((results: unknown) => {
      messages.push({ role: "user", content: results as any });
      session.lastActiveAt = Date.now();
    });

    const engine = {
      run: vi.fn(async function* (s: any) {
        yield { type: "text_delta", text: "partial" };
        await new Promise<void>((resolve) => setTimeout(resolve, 1300));
        s.appendAssistantTurn([{ type: "text", text: "assistant partial" }]);
        yield { type: "tool_start", toolCallId: "t1", toolName: "read_file" };
        await new Promise<void>((resolve) => setTimeout(resolve, 1300));
        s.appendToolResults([
          { type: "tool_result", tool_use_id: "t1", content: "ok" },
        ]);
        yield {
          type: "done",
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalCacheReadTokens: 0,
          totalCacheCreationTokens: 0,
        };
      }),
    };

    (mgr as any).host.createEngine = vi.fn(() => engine);

    const sendPromise = mgr.sendMessage(session.id, "start", session.mode);
    await vi.advanceTimersByTimeAsync(3500);
    await sendPromise;

    const inFlightSaveOccurred = savedCounts.some((count) => count >= 2);
    expect(inFlightSaveOccurred).toBe(true);
  });

  it("upgrades a coalesced deferred checkpoint save to durable and never downgrades it", async () => {
    const durabilities: Array<string | undefined> = [];
    let resolveFirstSave!: () => void;
    const firstSaveGate = new Promise<void>((resolve) => {
      resolveFirstSave = resolve;
    });
    const store = {
      saveSession: vi.fn(async (args: { durability?: string }) => {
        durabilities.push(args.durability);
        if (durabilities.length === 1) await firstSaveGate;
        return { ok: true, revision: String(durabilities.length) };
      }),
      list: vi.fn(() => []),
      get: vi.fn(),
      loadMessages: vi.fn(),
      loadMetadata: vi.fn(),
    } as any;
    const mgr = new AgentSessionManager(
      makeConfig(),
      "/tmp",
      undefined,
      false,
      store,
    );
    const session = await mgr.createSession("code");
    await flushPromises();
    const baseline = durabilities.length;

    mgr.saveSession(session.id, { durability: "checkpoint" }); // runs immediately
    mgr.saveSession(session.id, { durability: "checkpoint" }); // deferred behind it
    mgr.saveSession(session.id, { durability: "durable" }); // upgrades the deferred save
    mgr.saveSession(session.id, { durability: "checkpoint" }); // must not downgrade it
    resolveFirstSave();
    await flushPromises();

    expect(durabilities.slice(baseline)).toEqual(["checkpoint", "durable"]);
  });

  it("scales the in-flight checkpoint delay from the last persistence duration with clamping", async () => {
    const mgr = new AgentSessionManager(makeConfig(), "/tmp");
    const anyMgr = mgr as any;

    expect(anyMgr.nextInFlightPersistDelayMs("s1")).toBe(1_000);
    anyMgr.sessionPersistDurationsMs.set("s1", 200);
    expect(anyMgr.nextInFlightPersistDelayMs("s1")).toBe(5_000);
    anyMgr.sessionPersistDurationsMs.set("s1", 10_000);
    expect(anyMgr.nextInFlightPersistDelayMs("s1")).toBe(30_000);
  });

  it("multiplies the in-flight checkpoint delay by the number of running loops", async () => {
    const mgr = new AgentSessionManager(makeConfig(), "/tmp");
    const anyMgr = mgr as any;

    const stopA = anyMgr.startInFlightPersistLoop("a", () => {});
    const stopB = anyMgr.startInFlightPersistLoop("b", () => {});
    const stopC = anyMgr.startInFlightPersistLoop("c", () => {});

    // Three concurrent loops: the 1 s floor becomes 3 s per session, keeping
    // the aggregate cadence at ~1 checkpoint/s across all running turns.
    expect(anyMgr.nextInFlightPersistDelayMs("a")).toBe(3_000);
    anyMgr.sessionPersistDurationsMs.set("a", 200);
    expect(anyMgr.nextInFlightPersistDelayMs("a")).toBe(15_000);
    // The 30 s staleness cap still bounds the scaled delay.
    anyMgr.sessionPersistDurationsMs.set("a", 1_000);
    expect(anyMgr.nextInFlightPersistDelayMs("a")).toBe(30_000);

    // Stopping loops restores the faster cadence; stop() is idempotent.
    stopC();
    stopC();
    expect(anyMgr.nextInFlightPersistDelayMs("b")).toBe(2_000);
    stopB();
    stopA();
    expect(anyMgr.nextInFlightPersistDelayMs("b")).toBe(1_000);
  });

  it("reschedules in-flight checkpoints using the adaptive delay until stopped", async () => {
    const mgr = new AgentSessionManager(makeConfig(), "/tmp");
    const anyMgr = mgr as any;
    let ticks = 0;

    anyMgr.sessionPersistDurationsMs.set("s1", 200); // → 5 s cadence
    const stop = anyMgr.startInFlightPersistLoop("s1", () => {
      ticks += 1;
    });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(ticks).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(ticks).toBe(1);

    // Each tick picks the delay for the next one, so the tick scheduled with
    // the old 5 s cadence still fires 5 s out; the one after drops to 1 s.
    anyMgr.sessionPersistDurationsMs.set("s1", 0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ticks).toBe(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ticks).toBe(3);

    stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ticks).toBe(3);
  });

  it("pauses in-flight checkpoints while the last persist exceeded the skip threshold", async () => {
    const mgr = new AgentSessionManager(makeConfig(), "/tmp");
    const anyMgr = mgr as any;
    let ticks = 0;

    // Above the 1 200 ms skip threshold: ticks keep firing (30 s cadence) but
    // the checkpoint callback is suppressed.
    anyMgr.sessionPersistDurationsMs.set("s1", 2_000);
    const stop = anyMgr.startInFlightPersistLoop("s1", () => {
      ticks += 1;
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(ticks).toBe(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(ticks).toBe(0);

    // Once persistence gets cheap again (e.g. after condensing), the loop
    // resumes checkpointing on its next tick.
    anyMgr.sessionPersistDurationsMs.set("s1", 100);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(ticks).toBe(1);

    stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ticks).toBe(1);
  });

  it("delivers checkpoint durability and the transcript-revision skip through production store wiring", async () => {
    const workspace = fs.mkdtempSync(
      path.join(os.tmpdir(), "agentlink-durability-"),
    );
    try {
      const events: string[] = [];
      const normalize = (name: string) => {
        const tempMatch = /^\.(.+?)\.\d+\..*\.tmp$/.exec(name);
        return tempMatch ? tempMatch[1] : name;
      };
      const store = new SessionStore(
        workspace,
        { ownerId: "test-owner", surface: "test", startedAt: 1 },
        {
          open: async (filePath, flags) => {
            const name = normalize(path.basename(String(filePath)));
            const handle = await fs.promises.open(filePath, flags);
            return {
              writeFile: (data, options) => handle.writeFile(data, options),
              sync: async () => {
                events.push(`fsync:${name}`);
                await handle.sync();
              },
              close: () => handle.close(),
            };
          },
          rename: async (oldPath, newPath) => {
            events.push(`rename:${normalize(path.basename(String(newPath)))}`);
            await fs.promises.rename(oldPath, newPath);
          },
          rm: (filePath, options) => fs.promises.rm(filePath, options),
        },
      );
      const mgr = new AgentSessionManager(
        makeConfig(),
        workspace,
        undefined,
        false,
        store,
      );
      const session = await mgr.createSession("code");
      (session as any).getAllMessages = vi.fn(() => [
        { role: "user", content: "distinct checkpoint transcript" },
      ]);
      (session as any).transcriptRevision = 7;
      await (mgr as any).sessionSaveQueues.get(session.id);

      events.length = 0;
      mgr.saveSession(session.id, { durability: "checkpoint" });
      await (mgr as any).sessionSaveQueues.get(session.id);

      // The in-flight checkpoint tier reached the store: transcript written
      // atomically with no fsync anywhere in the save.
      expect(events).toContain("rename:messages.json");
      expect(events.filter((event) => event.startsWith("fsync:"))).toEqual([]);

      events.length = 0;
      mgr.saveSession(session.id, { durability: "durable" });
      await (mgr as any).sessionSaveQueues.get(session.id);

      // The durable save skipped rewriting the unchanged transcript via the
      // session's transcriptRevision, but flushed the checkpoint-tier bytes.
      expect(events).not.toContain("rename:messages.json");
      expect(events).toContain("fsync:messages.json");
      expect(store.loadMessages(session.id)).toEqual([
        { role: "user", content: "distinct checkpoint transcript" },
      ]);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});

describe("AgentSessionManager activity tracing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getConfiguration.mockReturnValue({
      get: () => undefined,
      inspect: () => undefined,
    });
  });

  it("does not emit late events from an aborted overlapping run", async () => {
    const workspace = fs.mkdtempSync(
      path.join(os.tmpdir(), "agentlink-manager-overlap-"),
    );
    try {
      const mgr = new AgentSessionManager(makeConfig(), workspace);
      const session = await mgr.createSession("code");
      const messages: AgentMessage[] = [];
      let abortGeneration = 0;
      let abortController: AbortController | undefined;
      let abortSignal: AbortSignal | undefined;
      (session as any).messageCount = 0;
      (session as any).lastActiveAt = 123;
      (session as any).createAbortController = vi.fn(() => {
        abortController = new AbortController();
        abortSignal = abortController.signal;
        return abortController;
      });
      (session as any).abort = vi.fn(() => {
        abortGeneration++;
        abortController?.abort();
        abortController = undefined;
      });
      Object.defineProperty(session, "abortGeneration", {
        configurable: true,
        get: () => abortGeneration,
      });
      Object.defineProperty(session, "isAborted", {
        configurable: true,
        get: () => abortSignal?.aborted ?? false,
      });
      (session as any).getAllMessages = vi.fn(() => messages);
      (session as any).addUserMessage = vi.fn((text: string) => {
        messages.push({ role: "user", content: text });
        (session as any).messageCount += 1;
        session.lastActiveAt = Date.now();
      });
      (session as any).autoTitle = vi.fn();
      (session as any).consumePendingInterjection = vi.fn(() => null);
      (session as any).consumePendingModeResume = vi.fn(() => null);

      let releaseFirst: (() => void) | undefined;
      const engine = {
        run: vi
          .fn()
          .mockImplementationOnce(async function* () {
            await new Promise<void>((resolve) => {
              releaseFirst = resolve;
            });
            yield { type: "text_delta", text: "late first text" };
            yield {
              type: "done",
              totalInputTokens: 1,
              totalOutputTokens: 1,
              totalCacheReadTokens: 0,
              totalCacheCreationTokens: 0,
            };
          })
          .mockImplementationOnce(async function* () {
            yield { type: "text_delta", text: "second text" };
            yield {
              type: "done",
              totalInputTokens: 2,
              totalOutputTokens: 2,
              totalCacheReadTokens: 0,
              totalCacheCreationTokens: 0,
            };
          }),
      };
      (mgr as any).host.createEngine = vi.fn(() => engine);
      const onEvent = vi.fn();
      mgr.onEvent = onEvent;

      const firstSend = mgr.sendMessage(session.id, "first", session.mode);
      await flushPromises();
      mgr.stopSession(session.id);
      const secondSend = mgr.sendMessage(session.id, "second", session.mode);
      await flushPromises();

      releaseFirst?.();
      await Promise.all([firstSend, secondSend]);

      expect(onEvent).toHaveBeenCalledWith(
        session.id,
        expect.objectContaining({ type: "text_delta", text: "second text" }),
      );
      expect(onEvent).not.toHaveBeenCalledWith(
        session.id,
        expect.objectContaining({
          type: "text_delta",
          text: "late first text",
        }),
      );
      expect(
        onEvent.mock.calls.filter(
          ([, event]) => (event as { type?: string }).type === "done",
        ),
      ).toHaveLength(1);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("records forwarded agent events to a bounded session trace", async () => {
    const workspace = fs.mkdtempSync(
      path.join(os.tmpdir(), "agentlink-manager-trace-"),
    );
    try {
      const mgr = new AgentSessionManager(makeConfig(), workspace);
      const session = await mgr.createSession("code");
      (session as any).messageCount = 0;
      (session as any).isAborted = false;
      (session as any).getAllMessages = vi.fn(() => []);
      (session as any).addUserMessage = vi.fn(() => {
        (session as any).messageCount += 1;
        session.lastActiveAt = Date.now();
      });
      (session as any).autoTitle = vi.fn();
      (session as any).consumePendingInterjection = vi.fn(() => null);
      (session as any).consumePendingModeResume = vi.fn(() => null);

      const engine = {
        run: vi.fn(async function* () {
          yield {
            type: "tool_start",
            toolCallId: "tool-1",
            toolName: "read_file",
          };
          yield {
            type: "tool_result",
            toolCallId: "tool-1",
            toolName: "read_file",
            result: [{ type: "text", text: "ok" }],
            durationMs: 12,
            input: { path: "src/example.ts" },
          };
          yield {
            type: "api_request",
            requestId: "req-1",
            model: "model-a",
            inputTokens: 100,
            uncachedInputTokens: 80,
            outputTokens: 25,
            cacheReadTokens: 10,
            cacheCreationTokens: 5,
            durationMs: 50,
            timeToFirstToken: 10,
          };
          yield {
            type: "done",
            totalInputTokens: 100,
            totalOutputTokens: 25,
            totalCacheReadTokens: 10,
            totalCacheCreationTokens: 5,
          };
        }),
      };
      (mgr as any).host.createEngine = vi.fn(() => engine);

      await mgr.sendMessage(session.id, "start", session.mode);
      await mgr.flushActivityTrace();

      const sessionDir = path.join(
        workspace,
        ".agentlink",
        "history",
        session.id,
      );
      const tracePath = path.join(sessionDir, "activity-trace.jsonl");
      const summaryPath = path.join(sessionDir, "activity-trace-summary.json");
      const traceLines = fs
        .readFileSync(tracePath, "utf-8")
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line) as { kind: string });
      const summary = JSON.parse(fs.readFileSync(summaryPath, "utf-8"));

      expect(traceLines.map((event) => event.kind)).toEqual([
        "tool_start",
        "tool_result",
        "api_request",
        "done",
      ]);
      expect(summary).toMatchObject({
        eventCount: 4,
        toolCalls: 1,
        toolCallsByName: { read_file: 1 },
        apiCalls: 1,
        totalInputTokens: 100,
        totalOutputTokens: 25,
        totalCacheReadTokens: 10,
        totalCacheCreationTokens: 5,
      });
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});

describe("AgentSessionManager checkpoints", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getConfiguration.mockReturnValue({
      get: () => undefined,
      inspect: () => undefined,
    });
  });

  it("waits for active workspace writers before capturing a manual checkpoint", async () => {
    const coordinator = new WorkspaceMutationCoordinator();
    const domain = coordinator.createDomain(["/tmp"]);
    const writer = await coordinator.acquire("writer-session", domain);
    const createCheckpoint = vi.fn(async (turnIndex: number) => ({
      id: "checkpoint-1",
      commitHash: "commit-1",
      turnIndex,
      createdAt: 100,
    }));
    const mgr = new AgentSessionManager(
      makeConfig(),
      "/tmp",
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      {
        host: {
          workspaceMutationCoordinator: coordinator,
          createCheckpointManager: vi.fn(() => ({
            baseCommit: "base-1",
            initialize: vi.fn(async () => true),
            createCheckpoint,
            previewRevert: vi.fn(async () => null),
            revertToCheckpoint: vi.fn(async () => false),
            getDiffBetween: vi.fn(async () => ""),
          })),
        },
      },
    );
    const session = await mgr.createSession("code");
    session.getAllMessages = vi.fn(() => [
      { role: "user" as const, content: "capture this state" },
    ]);

    const checkpointPromise = mgr.createManualCheckpoint();
    await Promise.resolve();
    expect(createCheckpoint).not.toHaveBeenCalled();

    writer.release();
    await expect(checkpointPromise).resolves.toMatchObject({
      id: "checkpoint-1",
      commitHash: "commit-1",
    });
    expect(createCheckpoint).toHaveBeenCalledWith(1);
  });

  it("fails closed when legacy checkpoint mutation metadata is missing", async () => {
    const mgr = new AgentSessionManager(makeConfig(), "/tmp");
    const session = await mgr.createSession("code");
    const revertToCheckpoint = vi.fn(async () => true);
    (mgr as any).checkpointManager = { revertToCheckpoint };

    const result = await (mgr as any).revertWorkspaceToCheckpoint(session, {
      id: "legacy-checkpoint",
      projectId: session.projectScope.projectId,
      commitHash: "commit-1",
      turnIndex: 1,
      createdAt: 100,
    });

    expect(result).toEqual({
      ok: false,
      reason: "workspace_mutation_conflict",
    });
    expect(revertToCheckpoint).not.toHaveBeenCalled();
  });

  it("rejects a checkpoint after another session advances the workspace generation", async () => {
    const coordinator = new WorkspaceMutationCoordinator(undefined, {
      createEpoch: () => "test-epoch",
    });
    const mgr = new AgentSessionManager(
      makeConfig(),
      "/tmp",
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      { host: { workspaceMutationCoordinator: coordinator } },
    );
    const session = await mgr.createSession("code");
    const mutation = coordinator.getSnapshot("/tmp", session.id);
    const otherLease = await coordinator.acquire(
      "other-session",
      coordinator.createDomain(["/tmp"]),
    );
    await otherLease.markMutation();
    otherLease.release();
    const revertToCheckpoint = vi.fn(async () => true);
    (mgr as any).checkpointManager = { revertToCheckpoint };

    const result = await (mgr as any).revertWorkspaceToCheckpoint(session, {
      id: "checkpoint-1",
      projectId: session.projectScope.projectId,
      commitHash: "commit-1",
      turnIndex: 1,
      createdAt: 100,
      projectSnapshots: [
        {
          projectId: session.projectScope.projectId,
          commitHash: "commit-1",
          createdAt: 100,
          mutation,
        },
      ],
    });

    expect(result).toEqual({
      ok: false,
      reason: "workspace_mutation_conflict",
    });
    expect(revertToCheckpoint).not.toHaveBeenCalled();
  });

  it("rejects a revert when the workspace fingerprint changed after preview", async () => {
    const coordinator = new WorkspaceMutationCoordinator(undefined, {
      createEpoch: () => "test-epoch",
    });
    const getWorkspaceRevision = vi.fn(async () => "changed-revision");
    const revertToCheckpoint = vi.fn(async () => true);
    const mgr = new AgentSessionManager(
      makeConfig(),
      "/tmp",
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      {
        host: {
          workspaceMutationCoordinator: coordinator,
          createCheckpointManager: vi.fn(() => ({
            baseCommit: "base-1",
            initialize: vi.fn(async () => true),
            createCheckpoint: vi.fn(async () => null),
            previewRevert: vi.fn(async () => null),
            getWorkspaceRevision,
            revertToCheckpoint,
            getDiffBetween: vi.fn(async () => ""),
          })),
        },
      },
    );
    const session = await mgr.createSession("code");
    const mutation = coordinator.getSnapshot("/tmp", session.id);

    const result = await (mgr as any).revertWorkspaceToCheckpoint(
      session,
      {
        id: "checkpoint-1",
        projectId: session.projectScope.projectId,
        commitHash: "commit-1",
        turnIndex: 1,
        createdAt: 100,
        projectSnapshots: [
          {
            projectId: session.projectScope.projectId,
            commitHash: "commit-1",
            createdAt: 100,
            mutation,
          },
        ],
      },
      "preview-revision",
    );

    expect(result).toEqual({
      ok: false,
      reason: "workspace_mutation_conflict",
    });
    expect(getWorkspaceRevision).toHaveBeenCalledOnce();
    expect(revertToCheckpoint).not.toHaveBeenCalled();
  });

  it("creates, previews, diffs, and reverts one checkpoint across all workspace roots", async () => {
    const workspace = fs.mkdtempSync(
      path.join(os.tmpdir(), "agentlink-checkpoint-projects-"),
    );
    const rootA = path.join(workspace, "project-a");
    const rootB = path.join(workspace, "project-b");
    fs.mkdirSync(rootA);
    fs.mkdirSync(rootB);

    try {
      const projectA = {
        id: "project-a",
        name: "Project A",
        uri: `file://${rootA}`,
        rootPath: rootA,
        availability: { status: "available" as const },
      };
      const projectB = {
        id: "project-b",
        name: "Project B",
        uri: `file://${rootB}`,
        rootPath: rootB,
        availability: { status: "available" as const },
      };
      const projects = [projectA, projectB];
      const projectCatalog = {
        listProjects: () => projects,
        resolveProjectForResource: () => projectA,
        resolvePersistedScope: (scope: { projectId: string }) => {
          const project = [projectA, projectB].find(
            (candidate) => candidate.id === scope.projectId,
          )!;
          return {
            status: "available" as const,
            project,
            scope: {
              schemaVersion: 1 as const,
              kind: "project" as const,
              projectId: project.id,
              workspaceFolderUri: project.uri,
              displayName: project.name,
              rootPath: project.rootPath,
            },
          };
        },
      };
      const managers = new Map<
        string,
        {
          baseCommit: string;
          initialize: ReturnType<typeof vi.fn>;
          createCheckpoint: ReturnType<typeof vi.fn>;
          previewRevert: ReturnType<typeof vi.fn>;
          revertToCheckpoint: ReturnType<typeof vi.fn>;
          getDiffBetween: ReturnType<typeof vi.fn>;
        }
      >();
      const createCheckpointManager = vi.fn(
        ({ workspaceDir }: { workspaceDir: string }) => {
          const label = workspaceDir === rootA ? "a" : "b";
          const manager = {
            baseCommit: `base-${label}`,
            initialize: vi.fn(async () => undefined),
            createCheckpoint: vi.fn(async (turnIndex: number) => ({
              id: `checkpoint-${label}`,
              commitHash: `commit-${label}`,
              turnIndex,
              createdAt: label === "a" ? 100 : 200,
            })),
            previewRevert: vi.fn(async () => ({
              modified: [`${label}.ts`],
              deleted: [],
              restored: [],
            })),
            revertToCheckpoint: vi.fn(async () => true),
            getDiffBetween: vi.fn(
              async (fromHash: string, toHash: string) =>
                `${label}:${fromHash}:${toHash}`,
            ),
          };
          managers.set(workspaceDir, manager);
          return manager;
        },
      );
      const mgr = new AgentSessionManager(
        makeConfig(),
        rootA,
        undefined,
        false,
        undefined,
        undefined,
        undefined,
        {
          projectCatalog,
          host: { createCheckpointManager },
        },
      );
      const createSession = (project: typeof projectA, id: string) => ({
        id,
        projectScope: {
          schemaVersion: 1 as const,
          kind: "project" as const,
          projectId: project.id,
          workspaceFolderUri: project.uri,
          displayName: project.name,
          rootPath: project.rootPath,
        },
        projectAvailability: "available" as const,
        getAllMessages: vi.fn(() => [
          { role: "user" as const, content: `prompt-${project.id}` },
        ]),
        replaceMessages: vi.fn(),
        status: "idle" as const,
      });
      const session = createSession(projectA, "session-a");
      (mgr as any).sessions.set(session.id, session);

      mgr.switchTo(session.id);
      const checkpoint = await mgr.createManualCheckpoint();

      expect(
        createCheckpointManager.mock.calls.map(
          ([options]) => options.workspaceDir,
        ),
      ).toEqual([rootA, rootB]);
      expect(checkpoint).toMatchObject({
        projectId: projectA.id,
        commitHash: "commit-a",
        createdAt: 200,
        projectSnapshots: [
          { projectId: projectA.id, commitHash: "commit-a", createdAt: 100 },
          { projectId: projectB.id, commitHash: "commit-b", createdAt: 200 },
        ],
      });
      expect(checkpoint?.id).toEqual(expect.any(String));

      await expect(
        mgr.previewRevert(session.id, checkpoint!.id),
      ).resolves.toMatchObject({
        projectId: projectA.id,
        preview: {
          modified: ["Project A/a.ts", "Project B/b.ts"],
          deleted: [],
          restored: [],
        },
      });
      await expect(
        mgr.getCheckpointDiff(session.id, checkpoint!.id, "all"),
      ).resolves.toBe(
        "## Project A\n\na:base-a:commit-a\n\n## Project B\n\nb:base-b:commit-b",
      );
      await expect(
        mgr.revertToCheckpoint(session.id, checkpoint!.id),
      ).resolves.toMatchObject({ ok: true });

      const managerA = managers.get(rootA)!;
      const managerB = managers.get(rootB)!;
      expect(managerA.createCheckpoint).toHaveBeenCalledWith(1);
      expect(managerB.createCheckpoint).toHaveBeenCalledWith(1);
      expect(managerA.previewRevert).toHaveBeenCalledWith(
        expect.objectContaining({
          id: checkpoint!.id,
          projectId: projectA.id,
          commitHash: "commit-a",
        }),
      );
      expect(managerB.previewRevert).toHaveBeenCalledWith(
        expect.objectContaining({
          id: checkpoint!.id,
          projectId: projectB.id,
          commitHash: "commit-b",
        }),
      );
      expect(managerA.revertToCheckpoint).toHaveBeenCalledWith(
        expect.objectContaining({
          id: checkpoint!.id,
          projectId: projectA.id,
          commitHash: "commit-a",
        }),
      );
      expect(managerB.revertToCheckpoint).toHaveBeenCalledWith(
        expect.objectContaining({
          id: checkpoint!.id,
          projectId: projectB.id,
          commitHash: "commit-b",
        }),
      );
      expect(managerA.getDiffBetween).toHaveBeenCalledWith(
        "base-a",
        "commit-a",
      );
      expect(managerB.getDiffBetween).toHaveBeenCalledWith(
        "base-b",
        "commit-b",
      );

      const coordinator = (mgr as any).host
        .workspaceMutationCoordinator as WorkspaceMutationCoordinator;
      const externalLease = await coordinator.acquire(
        "other-session",
        coordinator.createDomain([rootB], session.id),
      );
      await externalLease.markMutation();
      externalLease.release();

      await expect(
        mgr.revertToCheckpoint(session.id, checkpoint!.id),
      ).resolves.toEqual({
        ok: false,
        reason: "workspace_mutation_conflict",
      });
      expect(managerA.revertToCheckpoint).toHaveBeenCalledTimes(1);
      expect(managerB.revertToCheckpoint).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("renames unloaded persisted sessions with the current stored revision", async () => {
    const summary = {
      id: "session-1",
      mode: "code",
      model: "claude-sonnet-4-6",
      title: "Old title",
      messageCount: 1,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      createdAt: 100,
      lastActiveAt: 123,
      schemaVersion: 1,
    };
    const renameSession = vi.fn(async () => ({ ok: true, revision: "6" }));
    const store = {
      renameSession,
      readSession: vi.fn(async () => ({
        ok: true,
        revision: "5",
        value: {
          summary,
          messages: [{ role: "user", content: "persisted" }],
          metadata: {
            mode: "code",
            model: "claude-sonnet-4-6",
            totalInputTokens: 0,
            totalOutputTokens: 0,
            checkpointState: { baseCommit: null, checkpoints: [] },
          },
        },
      })),
      list: vi.fn(() => []),
      get: vi.fn(() => summary),
      loadMessages: vi.fn(() => []),
      loadMetadata: vi.fn(() => null),
    } as any;

    const mgr = new AgentSessionManager(
      makeConfig(),
      "/tmp",
      undefined,
      false,
      store,
    );

    await expect(
      mgr.renamePersistedSession("session-1", "New title"),
    ).resolves.toBe(true);
    expect(renameSession).toHaveBeenCalledWith({
      sessionId: "session-1",
      title: "New title",
      expectedRevision: "5",
    });
  });

  it("returns conflict details when persisted session rename sees a stale revision", async () => {
    const summary = {
      id: "session-1",
      mode: "code",
      model: "claude-sonnet-4-6",
      title: "Old title",
      messageCount: 1,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      createdAt: 100,
      lastActiveAt: 123,
      schemaVersion: 1,
    };
    const renameSession = vi.fn(async () => ({
      ok: false,
      reason: "conflict",
      currentRevision: "6",
    }));
    const log = vi.fn();
    const store = {
      renameSession,
      readSession: vi.fn(async () => ({
        ok: true,
        revision: "5",
        value: {
          summary,
          messages: [{ role: "user", content: "persisted" }],
          metadata: {
            mode: "code",
            model: "claude-sonnet-4-6",
            totalInputTokens: 0,
            totalOutputTokens: 0,
            checkpointState: { baseCommit: null, checkpoints: [] },
          },
        },
      })),
      list: vi.fn(() => []),
      get: vi.fn(() => summary),
      loadMessages: vi.fn(() => []),
      loadMetadata: vi.fn(() => null),
    } as any;

    const mgr = new AgentSessionManager(
      makeConfig(),
      "/tmp",
      undefined,
      false,
      store,
      log,
    );

    await expect(
      mgr.renamePersistedSessionWithResult("session-1", "New title"),
    ).resolves.toEqual({
      ok: false,
      operation: "rename",
      reason: "conflict",
      currentRevision: "6",
    });
    await expect(
      mgr.renamePersistedSession("session-1", "New title"),
    ).resolves.toBe(false);
    expect(log).toHaveBeenCalledWith(
      "[session] persistence rename conflict for session-1: current=6",
    );
  });

  it("deletes loaded persisted sessions with the tracked revision", async () => {
    const summary = {
      id: "session-1",
      mode: "code",
      model: "claude-sonnet-4-6",
      title: "Loaded session",
      messageCount: 1,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      createdAt: 100,
      lastActiveAt: 123,
      schemaVersion: 1,
    };
    const deleteSession = vi.fn(async () => ({ ok: true, revision: "4" }));
    const store = {
      deleteSession,
      readSession: vi.fn(async () => ({
        ok: true,
        revision: "3",
        value: {
          summary,
          messages: [{ role: "user", content: "persisted" }],
          metadata: {
            mode: "code",
            model: "claude-sonnet-4-6",
            totalInputTokens: 0,
            totalOutputTokens: 0,
            checkpointState: { baseCommit: null, checkpoints: [] },
          },
        },
      })),
      list: vi.fn(() => []),
      get: vi.fn(() => summary),
      loadMessages: vi.fn(() => []),
      loadMetadata: vi.fn(() => null),
    } as any;

    const mgr = new AgentSessionManager(
      makeConfig(),
      "/tmp",
      undefined,
      false,
      store,
    );
    const session = await mgr.createSession("code");
    expect(session.id).toBe("session-1");
    const loaded = await mgr.loadPersistedSession("session-1");
    expect(loaded).toBe(session);

    await expect(mgr.deletePersistedSession("session-1")).resolves.toBe(true);
    expect(deleteSession).toHaveBeenCalledWith({
      sessionId: "session-1",
      expectedRevision: "3",
    });
    expect(mgr.getSession("session-1")).toBeUndefined();
  });

  it("returns ownership details when persisted session rename is owned elsewhere", async () => {
    const summary = {
      id: "session-1",
      mode: "code",
      model: "claude-sonnet-4-6",
      title: "Old title",
      messageCount: 1,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      createdAt: 100,
      lastActiveAt: 123,
      schemaVersion: 1,
    };
    const renameSession = vi.fn(async () => ({
      ok: false,
      reason: "not_owner",
      owner: { ownerId: "other", surface: "cli", startedAt: 99 },
    }));
    const store = {
      renameSession,
      readSession: vi.fn(async () => ({
        ok: true,
        revision: "5",
        value: {
          summary,
          messages: [{ role: "user", content: "persisted" }],
          metadata: {
            mode: "code",
            model: "claude-sonnet-4-6",
            totalInputTokens: 0,
            totalOutputTokens: 0,
            checkpointState: { baseCommit: null, checkpoints: [] },
          },
        },
      })),
      list: vi.fn(() => []),
      get: vi.fn(() => summary),
      loadMessages: vi.fn(() => []),
      loadMetadata: vi.fn(() => null),
    } as any;

    const mgr = new AgentSessionManager(
      makeConfig(),
      "/tmp",
      undefined,
      false,
      store,
    );

    await expect(
      mgr.renamePersistedSessionWithResult("session-1", "New title"),
    ).resolves.toEqual({
      ok: false,
      operation: "rename",
      reason: "not_owner",
      message: undefined,
    });
  });

  it("returns IO details when persisted session delete fails", async () => {
    const summary = {
      id: "session-1",
      mode: "code",
      model: "claude-sonnet-4-6",
      title: "Loaded session",
      messageCount: 1,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      createdAt: 100,
      lastActiveAt: 123,
      schemaVersion: 1,
    };
    const deleteSession = vi.fn(async () => ({
      ok: false,
      reason: "io_error",
      message: "disk full",
    }));
    const store = {
      deleteSession,
      readSession: vi.fn(async () => ({
        ok: true,
        revision: "3",
        value: {
          summary,
          messages: [{ role: "user", content: "persisted" }],
          metadata: {
            mode: "code",
            model: "claude-sonnet-4-6",
            totalInputTokens: 0,
            totalOutputTokens: 0,
            checkpointState: { baseCommit: null, checkpoints: [] },
          },
        },
      })),
      list: vi.fn(() => []),
      get: vi.fn(() => summary),
      loadMessages: vi.fn(() => []),
      loadMetadata: vi.fn(() => null),
    } as any;

    const mgr = new AgentSessionManager(
      makeConfig(),
      "/tmp",
      undefined,
      false,
      store,
    );

    await expect(
      mgr.deletePersistedSessionWithResult("session-1"),
    ).resolves.toEqual({
      ok: false,
      operation: "delete",
      reason: "io_error",
      message: "disk full",
    });
    await expect(mgr.deletePersistedSession("session-1")).resolves.toBe(false);
  });

  it("does not replace a newer tracked revision when loading an already live session", async () => {
    const saveSession = vi.fn(
      async (args: { expectedRevision: string | null }) => {
        if (args.expectedRevision === null) return { ok: true, revision: "2" };
        return { ok: true, revision: "3" };
      },
    );
    const summary = {
      id: "session-1",
      mode: "code",
      model: "claude-sonnet-4-6",
      title: "Live session",
      messageCount: 1,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      createdAt: 100,
      lastActiveAt: 123,
      schemaVersion: 1,
    };
    const store = {
      saveSession,
      readSession: vi.fn(async () => ({
        ok: true,
        revision: "1",
        value: {
          summary,
          messages: [{ role: "user", content: "persisted" }],
          metadata: {
            mode: "code",
            model: "claude-sonnet-4-6",
            totalInputTokens: 0,
            totalOutputTokens: 0,
            checkpointState: { baseCommit: null, checkpoints: [] },
          },
        },
      })),
      list: vi.fn(() => []),
      get: vi.fn(() => summary),
      loadMessages: vi.fn(() => []),
      loadMetadata: vi.fn(() => null),
    } as any;

    const mgr = new AgentSessionManager(
      makeConfig(),
      "/tmp",
      undefined,
      false,
      store,
    );
    const session = await mgr.createSession("code");
    (session as any).getAllMessages = vi.fn(() => [
      { role: "user", content: "live" },
    ]);

    mgr.saveSession(session.id);
    await flushPromises();

    const loaded = await mgr.loadPersistedSession(session.id);
    expect(loaded).toBe(session);

    mgr.saveSession(session.id);
    await flushPromises();

    expect(
      saveSession.mock.calls.map(([args]) => args.expectedRevision),
    ).toEqual([null, "2"]);
  });

  it("creates an idempotent checkpoint for each completed user turn", async () => {
    const mgr = new AgentSessionManager(makeConfig(), "/tmp");
    const session = await mgr.createSession("code");
    const messages: AgentMessage[] = [];
    (session as any).messageCount = 0;
    (session as any).isAborted = false;
    (session as any).lastActiveAt = 123;
    (session as any).getAllMessages = vi.fn(() => messages);
    (session as any).addUserMessage = vi.fn((text: string) => {
      messages.push({ role: "user", content: text });
      (session as any).messageCount = messages.length;
      session.lastActiveAt += 1;
    });
    (session as any).consumePendingInterjection = vi.fn(() => null);
    (session as any).consumePendingModeResume = vi.fn(() => null);
    (session as any).autoTitle = vi.fn();

    const checkpointManager = {
      createCheckpoint: vi
        .fn()
        .mockResolvedValueOnce({
          id: "cp-turn-1",
          commitHash: "hash-1",
          turnIndex: 1,
          createdAt: 111,
        })
        .mockResolvedValueOnce({
          id: "cp-turn-1-refresh",
          commitHash: "hash-1-refreshed",
          turnIndex: 1,
          createdAt: 222,
        })
        .mockResolvedValueOnce({
          id: "cp-turn-2",
          commitHash: "hash-2",
          turnIndex: 2,
          createdAt: 333,
        }),
    };
    (mgr as any).checkpointManager = checkpointManager;

    const engine = {
      run: vi.fn(async function* () {
        yield {
          type: "done",
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalCacheReadTokens: 0,
          totalCacheCreationTokens: 0,
        };
      }),
    };
    (mgr as any).host.createEngine = vi.fn(() => engine);

    const onEvent = vi.fn();
    mgr.onEvent = onEvent;

    await mgr.sendMessage(session.id, "first prompt", session.mode);
    await mgr.sendMessage(session.id, "second prompt", session.mode);

    expect(checkpointManager.createCheckpoint).toHaveBeenCalledTimes(3);
    expect(checkpointManager.createCheckpoint).toHaveBeenNthCalledWith(1, 1);
    expect(checkpointManager.createCheckpoint).toHaveBeenNthCalledWith(2, 1);
    expect(checkpointManager.createCheckpoint).toHaveBeenNthCalledWith(3, 2);
    expect(mgr.getCheckpoints(session.id)).toEqual([
      expect.objectContaining({
        id: "cp-turn-1",
        projectId: session.projectScope.projectId,
        commitHash: "hash-1-refreshed",
        turnIndex: 1,
        createdAt: 222,
      }),
      expect.objectContaining({
        id: "cp-turn-2",
        projectId: session.projectScope.projectId,
        commitHash: "hash-2",
        turnIndex: 2,
        createdAt: 333,
      }),
    ]);
    expect(onEvent).toHaveBeenCalledWith(
      session.id,
      expect.objectContaining({
        type: "checkpoint_created",
        checkpointId: "cp-turn-1",
        turnIndex: 1,
      }),
    );
    expect(onEvent).toHaveBeenCalledWith(
      session.id,
      expect.objectContaining({
        type: "checkpoint_created",
        checkpointId: "cp-turn-2",
        turnIndex: 2,
      }),
    );
  });

  it("waits for an aborted run to settle before starting a replacement send", async () => {
    const mgr = new AgentSessionManager(makeConfig(), "/tmp");
    const session = await mgr.createSession("code");
    const messages: AgentMessage[] = [];
    Object.assign(session, {
      reasoningEffort: "high",
      thinkingBudget: 0,
      messageCount: 0,
      lastActiveAt: 1,
      abortGeneration: 0,
      isAborted: false,
      addUserMessage: vi.fn((text: string) => {
        messages.push({ role: "user", content: text });
        (session as any).messageCount = messages.length;
        session.lastActiveAt += 1;
      }),
      getAllMessages: vi.fn(() => messages),
      consumePendingInterjection: vi.fn(() => null),
      consumePendingModeResume: vi.fn(() => null),
      autoTitle: vi.fn(),
      abort: vi.fn(() => {
        (session as any).isAborted = true;
        (session as any).abortGeneration += 1;
      }),
    });

    let releaseFirstRun!: () => void;
    let firstRunStarted = false;
    let firstRunSettled = false;
    const engine = {
      run: vi.fn(async function* () {
        if (!firstRunStarted) {
          firstRunStarted = true;
          await new Promise<void>((resolve) => {
            releaseFirstRun = resolve;
          });
          firstRunSettled = true;
          return;
        }
        yield {
          type: "done",
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalCacheReadTokens: 0,
          totalCacheCreationTokens: 0,
        };
      }),
    };
    (mgr as any).host.createEngine = vi.fn(() => engine);

    const firstSend = mgr.sendMessage(session.id, "first prompt", session.mode);
    await flushPromises();
    expect(firstRunStarted).toBe(true);

    mgr.stopSession(session.id);
    const secondSend = mgr.sendMessage(
      session.id,
      "replacement prompt",
      session.mode,
    );
    await flushPromises();

    expect(firstRunSettled).toBe(false);
    expect(session.addUserMessage).toHaveBeenCalledTimes(1);
    expect(session.addUserMessage).toHaveBeenLastCalledWith(
      "first prompt",
      expect.any(Object),
    );

    (session as any).isAborted = false;
    releaseFirstRun();
    await firstSend;
    await secondSend;

    expect(session.addUserMessage).toHaveBeenCalledTimes(2);
    expect(session.addUserMessage).toHaveBeenLastCalledWith(
      "replacement prompt",
      expect.any(Object),
    );
    expect(engine.run).toHaveBeenCalledTimes(2);
  });

  it("creates a checkpoint when a queued message is injected mid-turn", async () => {
    const mgr = new AgentSessionManager(makeConfig(), "/tmp");
    const session = await mgr.createSession("code");
    const messages: AgentMessage[] = [];
    (session as any).messageCount = 0;
    (session as any).isAborted = false;
    (session as any).lastActiveAt = 123;
    (session as any).getAllMessages = vi.fn(() => messages);
    (session as any).addUserMessage = vi.fn((text: string) => {
      messages.push({ role: "user", content: text });
      (session as any).messageCount = messages.length;
      session.lastActiveAt += 1;
    });
    (session as any).consumePendingInterjection = vi.fn(() => null);
    (session as any).consumePendingModeResume = vi.fn(() => null);
    (session as any).autoTitle = vi.fn();

    const checkpointManager = {
      createCheckpoint: vi
        .fn()
        .mockResolvedValueOnce({
          id: "cp-before-interjection",
          commitHash: "hash-before-interjection",
          turnIndex: 1,
          createdAt: 111,
        })
        .mockResolvedValueOnce({
          id: "cp-after-interjection",
          commitHash: "hash-after-interjection",
          turnIndex: 2,
          createdAt: 222,
        }),
    };
    (mgr as any).checkpointManager = checkpointManager;

    const engine = {
      run: vi.fn(async function* () {
        messages.push({ role: "user", content: "queued prompt" });
        (session as any).messageCount = messages.length;
        session.lastActiveAt += 1;
        yield {
          type: "user_interjection",
          text: "queued prompt",
          queueId: "queue-1",
        };
        yield {
          type: "done",
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalCacheReadTokens: 0,
          totalCacheCreationTokens: 0,
        };
      }),
    };
    (mgr as any).host.createEngine = vi.fn(() => engine);

    const onEvent = vi.fn();
    mgr.onEvent = onEvent;

    await mgr.sendMessage(session.id, "first prompt", session.mode);

    expect(checkpointManager.createCheckpoint).toHaveBeenCalledTimes(2);
    expect(checkpointManager.createCheckpoint).toHaveBeenNthCalledWith(1, 1);
    expect(checkpointManager.createCheckpoint).toHaveBeenNthCalledWith(2, 2);
    expect(mgr.getCheckpoints(session.id)).toEqual([
      expect.objectContaining({
        id: "cp-before-interjection",
        turnIndex: 1,
      }),
      expect.objectContaining({
        id: "cp-after-interjection",
        turnIndex: 2,
      }),
    ]);
    expect(onEvent).toHaveBeenCalledWith(
      session.id,
      expect.objectContaining({
        type: "checkpoint_created",
        checkpointId: "cp-before-interjection",
        turnIndex: 1,
      }),
    );
  });

  it("returns session and persistence revisions with checkpoint revert previews", async () => {
    const sessionMessages: AgentMessage[] = [
      { role: "user", content: "first prompt" },
      { role: "assistant", content: "first answer" },
      { role: "user", content: "second prompt" },
    ];
    const session: any = {
      id: "session-1",
      mode: "code",
      model: "claude-sonnet-4-6",
      providerId: undefined,
      autoCondenseThreshold: 0.9,
      title: "Checkpoint test",
      background: false,
      status: "idle",
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
      lastInputTokens: 0,
      lastOutputTokens: 0,
      lastCacheReadTokens: 0,
      currentTool: undefined,
      addUserMessage: vi.fn(),
      appendRuntimeError: vi.fn(),
      consumePendingInterjection: vi.fn(() => null),
      queuePendingModeResume: vi.fn(),
      consumePendingModeResume: vi.fn(() => null),
      autoTitle: vi.fn(),
      getAllMessages: vi.fn(() => sessionMessages),
      getLoadedSkills: vi.fn(() => []),
      replaceMessages: vi.fn(),
      restoreFromStore: vi.fn((data: { messages: AgentMessage[] }) => {
        sessionMessages.splice(0, sessionMessages.length, ...data.messages);
      }),
      rebuildSystemPrompt: vi.fn(async () => {}),
      lastActiveAt: 123,
      createdAt: 100,
    };
    mocks.createSession.mockResolvedValueOnce(session);

    const summary = {
      id: "session-1",
      mode: "code",
      model: "claude-sonnet-4-6",
      title: "Checkpoint test",
      messageCount: 3,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      createdAt: 100,
      lastActiveAt: 123,
      schemaVersion: 1,
    };
    const store = {
      readSession: vi.fn(async () => ({
        ok: true,
        revision: "persisted-1",
        value: {
          summary,
          messages: sessionMessages,
          metadata: {
            mode: "code",
            model: "claude-sonnet-4-6",
            totalInputTokens: 0,
            totalOutputTokens: 0,
            checkpointState: {
              baseCommit: null,
              checkpoints: [
                {
                  id: "cp-1",
                  commitHash: "hash-1",
                  turnIndex: 1,
                  createdAt: 111,
                },
              ],
            },
          },
        },
      })),
      get: vi.fn(() => summary),
      loadMessages: vi.fn(() => sessionMessages),
      loadMetadata: vi.fn(() => null),
      list: vi.fn(() => []),
    } as any;

    const mgr = new AgentSessionManager(
      makeConfig(),
      "/tmp",
      undefined,
      false,
      store,
    );
    await mgr.loadPersistedSession("session-1");

    const checkpointManager = {
      previewRevert: vi.fn(async () => ({
        modified: ["src/a.ts"],
        deleted: [],
        restored: [],
      })),
    };
    (mgr as any).checkpointManager = checkpointManager;

    const preview = await mgr.previewRevert("session-1", "cp-1");

    expect(preview).toEqual({
      projectId: session.projectScope.projectId,
      checkpointId: "cp-1",
      sessionRevision: expect.any(String),
      persistenceRevision: "persisted-1",
      workspaceRevision: "hash-1",
      preview: { modified: ["src/a.ts"], deleted: [], restored: [] },
    });
  });

  it("reverts to the selected checkpoint snapshot and persists checkpoint metadata", async () => {
    const sessionMessages: AgentMessage[] = [
      { role: "user", content: "first prompt" },
      { role: "assistant", content: "first answer" },
      { role: "user", content: "second prompt" },
      { role: "assistant", content: "second answer" },
    ];

    const replaceMessages = vi.fn((messages: AgentMessage[]) => {
      sessionMessages.splice(0, sessionMessages.length, ...messages);
    });

    const session: any = {
      id: "session-1",
      mode: "code",
      model: "claude-sonnet-4-6",
      providerId: undefined,
      autoCondenseThreshold: 0.9,
      title: "Checkpoint test",
      background: false,
      status: "idle",
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
      lastInputTokens: 0,
      lastOutputTokens: 0,
      lastCacheReadTokens: 0,
      currentTool: undefined,
      addUserMessage: vi.fn(),
      appendRuntimeError: vi.fn(),
      consumePendingInterjection: vi.fn(() => null),
      queuePendingModeResume: vi.fn(),
      consumePendingModeResume: vi.fn(() => null),
      autoTitle: vi.fn(),
      getAllMessages: vi.fn(() => sessionMessages),
      getLoadedSkills: vi.fn(() => []),
      replaceMessages,
      restoreFromStore: vi.fn((data: { messages: AgentMessage[] }) => {
        sessionMessages.splice(0, sessionMessages.length, ...data.messages);
      }),
      rebuildSystemPrompt: vi.fn(async () => {}),
      lastActiveAt: 123,
      createdAt: 100,
    };
    mocks.createSession.mockResolvedValueOnce(session);

    const saveSession = vi.fn(
      async (_args: { session: PersistedSessionRecord }) => ({
        ok: true,
        revision: "2",
      }),
    );
    const summary = {
      id: "session-1",
      mode: "code",
      model: "claude-sonnet-4-6",
      title: "Checkpoint test",
      messageCount: 4,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      createdAt: 100,
      lastActiveAt: 123,
      schemaVersion: 1,
    };
    const store = {
      saveSession,
      readSession: vi.fn(async () => ({
        ok: true,
        revision: "1",
        value: {
          summary,
          messages: sessionMessages,
          metadata: {
            mode: "code",
            model: "claude-sonnet-4-6",
            totalInputTokens: 0,
            totalOutputTokens: 0,
            checkpointState: {
              baseCommit: null,
              checkpoints: [
                {
                  id: "cp-1",
                  commitHash: "hash-1",
                  turnIndex: 1,
                  createdAt: 111,
                },
                {
                  id: "cp-2",
                  commitHash: "hash-2",
                  turnIndex: 2,
                  createdAt: 222,
                },
              ],
            },
          },
        },
      })),
      get: vi.fn(() => summary),
      loadMessages: vi.fn(() => sessionMessages),
      loadMetadata: vi.fn(() => ({
        schemaVersion: 1,
        mode: "code",
        model: "claude-sonnet-4-6",
        totalInputTokens: 0,
        totalOutputTokens: 0,
        checkpoints: [],
      })),
      list: vi.fn(() => []),
    } as any;

    const mgr = new AgentSessionManager(
      makeConfig(),
      "/tmp",
      undefined,
      false,
      store,
    );
    const loaded = await mgr.loadPersistedSession("session-1");
    expect(loaded).toBe(session);
    addCurrentMutationMetadata(mgr, "session-1");

    const checkpointManager = {
      revertToCheckpoint: vi.fn(async () => true),
    };
    (mgr as any).checkpointManager = checkpointManager;

    const result = await mgr.revertToCheckpoint("session-1", "cp-1");

    expect(result).toEqual({
      ok: true,
      restoredPrompt: "second prompt",
      sessionRevision: "2",
    });
    expect(checkpointManager.revertToCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({ id: "cp-1", turnIndex: 1 }),
    );
    expect(replaceMessages).toHaveBeenCalledWith([
      { role: "user", content: "first prompt" },
      { role: "assistant", content: "first answer" },
    ]);
    expect(mgr.getCheckpoints("session-1")).toEqual([
      expect.objectContaining({
        id: "cp-1",
        projectId: session.projectScope.projectId,
        commitHash: "hash-1",
        turnIndex: 1,
        createdAt: 111,
        projectSnapshots: [
          expect.objectContaining({
            projectId: session.projectScope.projectId,
            mutation: expect.objectContaining({ ownerSessionId: "session-1" }),
          }),
        ],
      }),
    ]);
    expect(saveSession).toHaveBeenCalled();
    const lastSaveArg = saveSession.mock.lastCall![0].session;
    expect(lastSaveArg?.metadata.checkpointState?.checkpoints).toEqual([
      expect.objectContaining({
        id: "cp-1",
        projectId: session.projectScope.projectId,
        commitHash: "hash-1",
        turnIndex: 1,
        createdAt: 111,
        projectSnapshots: [
          expect.objectContaining({
            projectId: session.projectScope.projectId,
            mutation: expect.objectContaining({ ownerSessionId: "session-1" }),
          }),
        ],
      }),
    ]);
    expect(lastSaveArg?.messages).toEqual([
      { role: "user", content: "first prompt" },
      { role: "assistant", content: "first answer" },
    ]);
  });

  it("persists revertPending when workspace revert succeeds but session save conflicts", async () => {
    const sessionMessages: AgentMessage[] = [
      { role: "user", content: "first prompt" },
      { role: "assistant", content: "first answer" },
      { role: "user", content: "second prompt" },
      { role: "assistant", content: "second answer" },
    ];
    const replaceMessages = vi.fn((messages: AgentMessage[]) => {
      sessionMessages.splice(0, sessionMessages.length, ...messages);
    });
    const session: any = {
      id: "session-1",
      mode: "code",
      model: "claude-sonnet-4-6",
      providerId: undefined,
      autoCondenseThreshold: 0.9,
      title: "Checkpoint test",
      background: false,
      status: "idle",
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
      lastInputTokens: 0,
      lastOutputTokens: 0,
      lastCacheReadTokens: 0,
      currentTool: undefined,
      addUserMessage: vi.fn(),
      appendRuntimeError: vi.fn(),
      consumePendingInterjection: vi.fn(() => null),
      queuePendingModeResume: vi.fn(),
      consumePendingModeResume: vi.fn(() => null),
      autoTitle: vi.fn(),
      getAllMessages: vi.fn(() => sessionMessages),
      getLoadedSkills: vi.fn(() => []),
      replaceMessages,
      restoreFromStore: vi.fn((data: { messages: AgentMessage[] }) => {
        sessionMessages.splice(0, sessionMessages.length, ...data.messages);
      }),
      rebuildSystemPrompt: vi.fn(async () => {}),
      lastActiveAt: 123,
      createdAt: 100,
    };
    mocks.createSession.mockResolvedValueOnce(session);

    const summary = {
      id: "session-1",
      mode: "code",
      model: "claude-sonnet-4-6",
      title: "Checkpoint test",
      messageCount: 4,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      createdAt: 100,
      lastActiveAt: 123,
      schemaVersion: 1,
    };
    const persistedRecord = {
      summary,
      messages: sessionMessages,
      metadata: {
        mode: "code",
        model: "claude-sonnet-4-6",
        totalInputTokens: 0,
        totalOutputTokens: 0,
        checkpointState: {
          baseCommit: null,
          checkpoints: [
            {
              id: "cp-1",
              commitHash: "hash-1",
              turnIndex: 1,
              createdAt: 111,
            },
          ],
        },
      },
    } satisfies PersistedSessionRecord;
    const saveSession = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        reason: "conflict",
        currentRevision: "2",
      })
      .mockResolvedValueOnce({ ok: true, revision: "3" });
    const store = {
      saveSession,
      readSession: vi.fn(async () => ({
        ok: true,
        revision: "1",
        value: persistedRecord,
      })),
      get: vi.fn(() => summary),
      loadMessages: vi.fn(() => sessionMessages),
      loadMetadata: vi.fn(() => null),
      list: vi.fn(() => []),
    } as any;

    const mgr = new AgentSessionManager(
      makeConfig(),
      "/tmp",
      undefined,
      false,
      store,
    );
    await mgr.loadPersistedSession("session-1");
    addCurrentMutationMetadata(mgr, "session-1");

    const checkpointManager = {
      revertToCheckpoint: vi.fn(async () => true),
    };
    (mgr as any).checkpointManager = checkpointManager;

    const result = await mgr.revertToCheckpoint("session-1", "cp-1");

    expect(result).toEqual({
      ok: false,
      reason: "persistence_failed",
      currentRevision: "2",
    });
    expect(checkpointManager.revertToCheckpoint).toHaveBeenCalled();
    expect(replaceMessages).not.toHaveBeenCalled();
    expect(saveSession).toHaveBeenCalledTimes(2);
    expect(saveSession.mock.calls[1][0].session.metadata.revertPending).toEqual(
      expect.objectContaining({
        projectId: session.projectScope.projectId,
        checkpointId: "cp-1",
        reason: "workspace_reverted_session_save_failed",
        sessionRevision: "2",
        workspaceRevision: "hash-1",
      }),
    );
  });

  it("does not return a cached current revision for non-conflict persistence failures", async () => {
    const sessionMessages: AgentMessage[] = [
      { role: "user", content: "first prompt" },
      { role: "assistant", content: "first answer" },
      { role: "user", content: "second prompt" },
    ];
    const session: any = {
      id: "session-1",
      mode: "code",
      model: "claude-sonnet-4-6",
      providerId: undefined,
      autoCondenseThreshold: 0.9,
      title: "Checkpoint test",
      background: false,
      status: "idle",
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
      lastInputTokens: 0,
      lastOutputTokens: 0,
      lastCacheReadTokens: 0,
      currentTool: undefined,
      addUserMessage: vi.fn(),
      appendRuntimeError: vi.fn(),
      consumePendingInterjection: vi.fn(() => null),
      queuePendingModeResume: vi.fn(),
      consumePendingModeResume: vi.fn(() => null),
      autoTitle: vi.fn(),
      getAllMessages: vi.fn(() => sessionMessages),
      getLoadedSkills: vi.fn(() => []),
      replaceMessages: vi.fn(),
      restoreFromStore: vi.fn((data: { messages: AgentMessage[] }) => {
        sessionMessages.splice(0, sessionMessages.length, ...data.messages);
      }),
      rebuildSystemPrompt: vi.fn(async () => {}),
      lastActiveAt: 123,
      createdAt: 100,
    };
    mocks.createSession.mockResolvedValueOnce(session);

    const summary = {
      id: "session-1",
      mode: "code",
      model: "claude-sonnet-4-6",
      title: "Checkpoint test",
      messageCount: 3,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      createdAt: 100,
      lastActiveAt: 123,
      schemaVersion: 1,
    };
    const record: PersistedSessionRecord = {
      summary,
      messages: sessionMessages,
      metadata: {
        mode: "code",
        model: "claude-sonnet-4-6",
        totalInputTokens: 0,
        totalOutputTokens: 0,
        checkpointState: {
          baseCommit: null,
          checkpoints: [
            {
              id: "cp-1",
              commitHash: "hash-1",
              turnIndex: 1,
              createdAt: 111,
            },
          ],
        },
      },
    };
    const store = {
      saveSession: vi.fn(async () => ({
        ok: false,
        reason: "io_error",
        message: "disk full",
      })),
      readSession: vi.fn(async () => ({
        ok: true,
        revision: "1",
        value: record,
      })),
      get: vi.fn(() => summary),
      loadMessages: vi.fn(() => sessionMessages),
      loadMetadata: vi.fn(() => null),
      list: vi.fn(() => []),
    } as any;

    const mgr = new AgentSessionManager(
      makeConfig(),
      "/tmp",
      undefined,
      false,
      store,
    );
    await mgr.loadPersistedSession("session-1");
    addCurrentMutationMetadata(mgr, "session-1");
    (mgr as any).checkpointManager = {
      revertToCheckpoint: vi.fn(async () => true),
    };

    const result = await mgr.revertToCheckpoint("session-1", "cp-1");

    expect(result).toEqual({ ok: false, reason: "persistence_failed" });
  });

  it("rejects checkpoint revert when the session is not loaded in memory", async () => {
    const mgr = new AgentSessionManager(makeConfig(), "/tmp");
    (mgr as any).checkpoints.set("session-1", [
      { id: "cp-1", commitHash: "hash-1", turnIndex: 1, createdAt: 111 },
    ]);
    const checkpointManager = { revertToCheckpoint: vi.fn(async () => true) };
    (mgr as any).checkpointManager = checkpointManager;

    const result = await mgr.revertToCheckpoint("session-1", "cp-1");

    expect(result).toEqual({ ok: false, reason: "not_found" });
    expect(checkpointManager.revertToCheckpoint).not.toHaveBeenCalled();
  });

  it("rejects checkpoint revert when the session changed after preview", async () => {
    const sessionMessages: AgentMessage[] = [
      { role: "user", content: "first prompt" },
      { role: "assistant", content: "first answer" },
      { role: "user", content: "second prompt" },
    ];
    const session: any = {
      id: "session-1",
      mode: "code",
      model: "claude-sonnet-4-6",
      providerId: undefined,
      autoCondenseThreshold: 0.9,
      title: "Checkpoint test",
      background: false,
      status: "idle",
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
      lastInputTokens: 0,
      lastOutputTokens: 0,
      lastCacheReadTokens: 0,
      currentTool: undefined,
      addUserMessage: vi.fn(),
      appendRuntimeError: vi.fn(),
      consumePendingInterjection: vi.fn(() => null),
      queuePendingModeResume: vi.fn(),
      consumePendingModeResume: vi.fn(() => null),
      autoTitle: vi.fn(),
      getAllMessages: vi.fn(() => sessionMessages),
      getLoadedSkills: vi.fn(() => []),
      replaceMessages: vi.fn(),
      restoreFromStore: vi.fn((data: { messages: AgentMessage[] }) => {
        sessionMessages.splice(0, sessionMessages.length, ...data.messages);
      }),
      rebuildSystemPrompt: vi.fn(async () => {}),
      lastActiveAt: 123,
      createdAt: 100,
    };
    mocks.createSession.mockResolvedValueOnce(session);

    const summary = {
      id: "session-1",
      mode: "code",
      model: "claude-sonnet-4-6",
      title: "Checkpoint test",
      messageCount: 3,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      createdAt: 100,
      lastActiveAt: 123,
      schemaVersion: 1,
    };
    const store = {
      readSession: vi.fn(async () => ({
        ok: true,
        revision: "1",
        value: {
          summary,
          messages: sessionMessages,
          metadata: {
            mode: "code",
            model: "claude-sonnet-4-6",
            totalInputTokens: 0,
            totalOutputTokens: 0,
            checkpointState: {
              baseCommit: null,
              checkpoints: [
                {
                  id: "cp-1",
                  commitHash: "hash-1",
                  turnIndex: 1,
                  createdAt: 111,
                },
              ],
            },
          },
        },
      })),
      get: vi.fn(() => summary),
      loadMessages: vi.fn(() => sessionMessages),
      loadMetadata: vi.fn(() => null),
      list: vi.fn(() => []),
    } as any;

    const mgr = new AgentSessionManager(
      makeConfig(),
      "/tmp",
      undefined,
      false,
      store,
    );
    await mgr.loadPersistedSession("session-1");

    const checkpointManager = {
      previewRevert: vi.fn(async () => ({
        modified: [],
        deleted: [],
        restored: [],
      })),
      revertToCheckpoint: vi.fn(async () => true),
    };
    (mgr as any).checkpointManager = checkpointManager;
    const preview = await mgr.previewRevert("session-1", "cp-1");
    expect(preview).not.toBeNull();

    sessionMessages.push({ role: "assistant", content: "new answer" });
    const result = await mgr.revertToCheckpoint(
      "session-1",
      "cp-1",
      preview!.sessionRevision,
      preview!.persistenceRevision,
    );

    expect(result).toEqual({
      ok: false,
      reason: "session_conflict",
      currentRevision: expect.any(String),
    });
    expect(checkpointManager.revertToCheckpoint).not.toHaveBeenCalled();
    expect(session.replaceMessages).not.toHaveBeenCalled();
  });

  it("accepts reverting to a checkpoint at the current transcript tail", async () => {
    const sessionMessages: AgentMessage[] = [
      { role: "user", content: "first prompt" },
      { role: "assistant", content: "first answer" },
      { role: "user", content: "second prompt" },
      { role: "assistant", content: "second answer" },
    ];

    const replaceMessages = vi.fn((messages: AgentMessage[]) => {
      sessionMessages.splice(0, sessionMessages.length, ...messages);
    });

    const session: any = {
      id: "session-1",
      mode: "code",
      model: "claude-sonnet-4-6",
      providerId: undefined,
      autoCondenseThreshold: 0.9,
      title: "Checkpoint test",
      background: false,
      status: "idle",
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
      lastInputTokens: 0,
      lastOutputTokens: 0,
      lastCacheReadTokens: 0,
      currentTool: undefined,
      addUserMessage: vi.fn(),
      appendRuntimeError: vi.fn(),
      consumePendingInterjection: vi.fn(() => null),
      queuePendingModeResume: vi.fn(),
      consumePendingModeResume: vi.fn(() => null),
      autoTitle: vi.fn(),
      getAllMessages: vi.fn(() => sessionMessages),
      getLoadedSkills: vi.fn(() => []),
      replaceMessages,
      restoreFromStore: vi.fn((data: { messages: AgentMessage[] }) => {
        sessionMessages.splice(0, sessionMessages.length, ...data.messages);
      }),
      rebuildSystemPrompt: vi.fn(async () => {}),
      lastActiveAt: 123,
      createdAt: 100,
    };
    mocks.createSession.mockResolvedValueOnce(session);

    const saveSession = vi.fn(
      async (_args: { session: PersistedSessionRecord }) => ({
        ok: true,
        revision: "2",
      }),
    );
    const summary = {
      id: "session-1",
      mode: "code",
      model: "claude-sonnet-4-6",
      title: "Checkpoint test",
      messageCount: 4,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      createdAt: 100,
      lastActiveAt: 123,
      schemaVersion: 1,
    };
    const store = {
      saveSession,
      readSession: vi.fn(async () => ({
        ok: true,
        revision: "1",
        value: {
          summary,
          messages: sessionMessages,
          metadata: {
            mode: "code",
            model: "claude-sonnet-4-6",
            totalInputTokens: 0,
            totalOutputTokens: 0,
            checkpointState: {
              baseCommit: null,
              checkpoints: [
                {
                  id: "cp-tail",
                  commitHash: "hash-tail",
                  turnIndex: 2,
                  createdAt: 222,
                },
              ],
            },
          },
        },
      })),
      get: vi.fn(() => summary),
      loadMessages: vi.fn(() => sessionMessages),
      loadMetadata: vi.fn(() => ({
        schemaVersion: 1,
        mode: "code",
        model: "claude-sonnet-4-6",
        totalInputTokens: 0,
        totalOutputTokens: 0,
        checkpoints: [],
      })),
      list: vi.fn(() => []),
    } as any;

    const mgr = new AgentSessionManager(
      makeConfig(),
      "/tmp",
      undefined,
      false,
      store,
    );
    await mgr.loadPersistedSession("session-1");
    addCurrentMutationMetadata(mgr, "session-1");

    const checkpointManager = {
      revertToCheckpoint: vi.fn(async () => true),
    };
    (mgr as any).checkpointManager = checkpointManager;

    const result = await mgr.revertToCheckpoint("session-1", "cp-tail");

    expect(result).toEqual({
      ok: true,
      restoredPrompt: undefined,
      sessionRevision: "2",
    });
    expect(replaceMessages).toHaveBeenCalledWith([
      { role: "user", content: "first prompt" },
      { role: "assistant", content: "first answer" },
      { role: "user", content: "second prompt" },
      { role: "assistant", content: "second answer" },
    ]);
    expect(saveSession).toHaveBeenCalled();
  });

  it("pins legacy checkpoints to the persisted session project instead of the current root", async () => {
    const projectA = {
      id: "project-a",
      name: "Project A",
      uri: "file:///workspace/a",
      rootPath: "/workspace/a",
      availability: { status: "available" as const },
    };
    const projectB = {
      id: "project-b",
      name: "Project B",
      uri: "file:///workspace/b",
      rootPath: "/workspace/b",
      availability: { status: "available" as const },
    };
    const projectScopeB = {
      projectId: projectB.id,
      workspaceFolderUri: projectB.uri,
      displayName: projectB.name,
    };
    const summary = {
      id: "session-1",
      mode: "code",
      model: "claude-sonnet-4-6",
      title: "Project B checkpoint",
      messageCount: 1,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      createdAt: 100,
      lastActiveAt: 123,
      schemaVersion: 1,
      projectScope: projectScopeB,
    };
    const store = {
      readSession: vi.fn(async () => ({
        ok: true,
        revision: "persisted-1",
        value: {
          summary,
          messages: [{ role: "user", content: "persisted" }],
          metadata: {
            projectScope: projectScopeB,
            mode: "code",
            model: "claude-sonnet-4-6",
            totalInputTokens: 0,
            totalOutputTokens: 0,
            checkpointState: {
              baseCommit: null,
              checkpoints: [
                {
                  id: "legacy-checkpoint",
                  commitHash: "hash-b",
                  turnIndex: 1,
                  createdAt: 111,
                },
              ],
            },
          },
        },
      })),
      get: vi.fn(() => summary),
      loadMessages: vi.fn(() => []),
      loadMetadata: vi.fn(() => null),
      list: vi.fn(() => []),
    } as any;
    const projectCatalog = {
      listProjects: () => [projectA, projectB],
      resolveProjectForResource: () => projectA,
      resolvePersistedScope: (scope: typeof projectScopeB) => {
        const project = scope.projectId === projectB.id ? projectB : projectA;
        return {
          status: "available" as const,
          project,
          scope: { ...scope, rootPath: project.rootPath },
        };
      },
    };
    const mgr = new AgentSessionManager(
      makeConfig(),
      projectA.rootPath,
      undefined,
      false,
      store,
      undefined,
      undefined,
      { projectCatalog } as any,
    );

    const session = await mgr.loadPersistedSession("session-1");

    expect(session?.projectScope.projectId).toBe(projectB.id);
    expect(mgr.getCheckpoints("session-1")).toEqual([
      expect.objectContaining({
        id: "legacy-checkpoint",
        projectId: projectB.id,
      }),
    ]);
  });

  it("rejects checkpoints and previews attributed to another project", async () => {
    const mgr = new AgentSessionManager(makeConfig(), "/tmp");
    const session = await mgr.createSession("code");
    (mgr as any).checkpoints.set(session.id, [
      {
        id: "foreign-checkpoint",
        projectId: "project-other",
        commitHash: "hash-other",
        turnIndex: 1,
        createdAt: 111,
      },
    ]);
    const checkpointManager = {
      previewRevert: vi.fn(async () => ({
        modified: [],
        deleted: [],
        restored: [],
      })),
      revertToCheckpoint: vi.fn(async () => true),
    };
    (mgr as any).checkpointManager = checkpointManager;

    await expect(
      mgr.previewRevert(session.id, "foreign-checkpoint"),
    ).resolves.toBeNull();
    await expect(
      mgr.revertToCheckpoint(session.id, "foreign-checkpoint"),
    ).resolves.toEqual({ ok: false, reason: "not_found" });
    expect(checkpointManager.previewRevert).not.toHaveBeenCalled();
    expect(checkpointManager.revertToCheckpoint).not.toHaveBeenCalled();
  });

  it("rejects a revert preview attributed to another project", async () => {
    const mgr = new AgentSessionManager(makeConfig(), "/tmp");
    const session = await mgr.createSession("code");
    (mgr as any).checkpoints.set(session.id, [
      {
        id: "checkpoint-1",
        projectId: session.projectScope.projectId,
        commitHash: "hash-1",
        turnIndex: 1,
        createdAt: 111,
      },
    ]);
    const checkpointManager = {
      revertToCheckpoint: vi.fn(async () => true),
    };
    (mgr as any).checkpointManager = checkpointManager;

    const result = await mgr.revertToCheckpoint(
      session.id,
      "checkpoint-1",
      undefined,
      undefined,
      "project-other",
    );

    expect(result).toEqual({
      ok: false,
      reason: "session_conflict",
      currentRevision: expect.any(String),
    });
    expect(checkpointManager.revertToCheckpoint).not.toHaveBeenCalled();
  });

  it("pins legacy recovery to the loaded session project and rejects mismatches", async () => {
    const mgr = new AgentSessionManager(makeConfig(), "/tmp");
    const session = await mgr.createSession("code");
    const recovery = {
      checkpointId: "checkpoint-1",
      sessionRevision: "revision-1",
      workspaceRevision: "hash-1",
      startedAt: 111,
      reason: "workspace_reverted_session_save_failed" as const,
    };

    (mgr as any).sessionRevertPending.set(session.id, recovery);
    expect(mgr.getRevertRecoveryState(session.id)).toEqual({
      ...recovery,
      projectId: session.projectScope.projectId,
    });

    (mgr as any).sessionRevertPending.set(session.id, {
      ...recovery,
      projectId: "project-other",
    });
    expect(mgr.getRevertRecoveryState(session.id)).toBeNull();
  });

  it("includes the session project in checkpoint revision tokens", async () => {
    const mgr = new AgentSessionManager(makeConfig(), "/tmp");
    const session = await mgr.createSession("code");
    const firstRevision = (mgr as any).currentSessionRevisionToken(session.id);

    (mgr as any).sessions.set(session.id, {
      ...session,
      projectScope: {
        ...session.projectScope,
        projectId: "project-other",
      },
    });
    const secondRevision = (mgr as any).currentSessionRevisionToken(session.id);

    expect(secondRevision).not.toBe(firstRevision);
  });
});

describe("AgentSessionManager memory candidate nudges", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getConfiguration.mockReturnValue({
      get: () => undefined,
      inspect: () => undefined,
    });
  });

  async function makeSendHarness() {
    const mgr = new AgentSessionManager(makeConfig(), "/tmp");
    const session = await mgr.createSession("code");
    const messages: AgentMessage[] = [];
    (session as any).messageCount = 0;
    (session as any).isAborted = false;
    (session as any).lastActiveAt = 123;
    (session as any).getAllMessages = vi.fn(() => messages);
    (session as any).addUserMessage = vi.fn((text: string, opts?: unknown) => {
      messages.push({
        role: "user",
        content: text,
        uiHint: opts
          ? { userMessage: opts as Record<string, unknown> }
          : undefined,
      } as AgentMessage);
      (session as any).messageCount = messages.length;
      session.lastActiveAt += 1;
    });
    (session as any).consumePendingInterjection = vi.fn(() => null);
    (session as any).consumePendingModeResume = vi.fn(() => null);
    (session as any).autoTitle = vi.fn();

    (mgr as any).checkpointManager = { createCheckpoint: vi.fn() };
    const run = vi.fn(async function* (
      _session: unknown,
      _options?: { automaticMemoryContext?: unknown },
    ) {
      yield {
        type: "done",
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheReadTokens: 0,
        totalCacheCreationTokens: 0,
      };
    });
    (mgr as any).host.createEngine = vi.fn(() => ({ run }));
    mgr.onEvent = vi.fn();
    return { mgr, session, messages, run };
  }

  it("prepares bounded automatic recall from the latest user text and fails open", async () => {
    const { mgr, session, messages } = await makeSendHarness();
    messages.push({ role: "user", content: "older unrelated context" });
    messages.push({ role: "user", content: "use the focused test preference" });
    const recallAutomatically = vi.fn(async () => ({
      result: {
        mode: "lexical-only" as const,
        memories: [
          {
            record: {} as never,
            score: 1,
            rendering:
              '<memory-evidence authority="low" instruction="false">\nStatement: Use focused tests.\n</memory-evidence>',
            authority: "low-authority-evidence" as const,
            canAuthorizeTools: false as const,
          },
        ],
      },
      health: { status: "ready" as const },
    }));

    const snapshot = await (mgr as any).prepareAutomaticMemoryContext(session, {
      memoryToolProvider: { recallAutomatically },
    });

    expect(recallAutomatically).toHaveBeenCalledOnce();
    expect(recallAutomatically).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          query: expect.stringContaining("use the focused test preference"),
          scope: "all",
          limit: 8,
        }),
        context: expect.objectContaining({
          sessionId: session.id,
          projectId: session.projectScope.projectId,
          isBackground: false,
        }),
      }),
    );
    expect(snapshot).toMatchObject({
      memoryCount: 1,
      estimatedTokens: expect.any(Number),
      scopes: ["project", "global"],
      authority: "low-authority-evidence",
      canAuthorizeTools: false,
    });
    expect(Object.isFrozen(snapshot)).toBe(true);

    recallAutomatically.mockRejectedValueOnce(new Error("memory unavailable"));
    await expect(
      (mgr as any).prepareAutomaticMemoryContext(session, {
        memoryToolProvider: { recallAutomatically },
      }),
    ).resolves.toBeUndefined();
  });

  it("retrieves automatic memory once per send or retry and passes the snapshot to the engine", async () => {
    const { mgr, session, run } = await makeSendHarness();
    const snapshot = Object.freeze({
      rendering:
        '<memory-evidence authority="low" instruction="false">memory</memory-evidence>',
      estimatedTokens: 20,
      memoryCount: 1,
      query: "remember",
      scopes: ["project", "global"] as const,
      authority: "low-authority-evidence" as const,
      canAuthorizeTools: false as const,
    });
    const prepareAutomaticMemoryContext = vi
      .spyOn(mgr as any, "prepareAutomaticMemoryContext")
      .mockResolvedValue(snapshot);

    await mgr.sendMessage(session.id, "use my preference", session.mode);
    await mgr.retrySession(session.id);

    expect(prepareAutomaticMemoryContext).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenCalledTimes(2);
    for (const [, options] of run.mock.calls) {
      expect(options).toMatchObject({ automaticMemoryContext: snapshot });
    }
  });

  it("stores a model-facing memory reminder while preserving display text", async () => {
    const { mgr, session } = await makeSendHarness();
    const text = "Going forward, always ask me before switching modes.";

    await mgr.sendMessage(session.id, text, session.mode);

    expect((session as any).addUserMessage).toHaveBeenCalledWith(
      expect.stringContaining("[memory-candidate]"),
      expect.objectContaining({ displayText: text }),
    );
  });

  it("skips slash commands but not media messages with real text", async () => {
    const { mgr, session } = await makeSendHarness();

    await mgr.sendMessage(
      session.id,
      "Going forward, always ask me before switching modes.",
      session.mode,
      { isSlashCommand: true },
    );
    expect((session as any).addUserMessage).toHaveBeenLastCalledWith(
      "Going forward, always ask me before switching modes.",
      expect.objectContaining({ isSlashCommand: true }),
    );

    await mgr.sendMessage(
      session.id,
      "Going forward, always ask me before switching modes.",
      session.mode,
      { images: [{ name: "a.png", mimeType: "image/png", base64: "abc" }] },
    );
    expect((session as any).addUserMessage).toHaveBeenLastCalledWith(
      expect.stringContaining("[memory-candidate]"),
      expect.objectContaining({
        images: [{ name: "a.png", mimeType: "image/png", base64: "abc" }],
      }),
    );
  });

  it("respects the per-session nudge cap", async () => {
    const { mgr, session } = await makeSendHarness();

    await mgr.sendMessage(
      session.id,
      "Going forward, always ask me before mode switches.",
      session.mode,
    );
    await mgr.sendMessage(
      session.id,
      "In the future, always ask me before running release commands.",
      session.mode,
    );
    await mgr.sendMessage(
      session.id,
      "Remember to always ask me before deleting files.",
      session.mode,
    );

    const calls = (session as any).addUserMessage.mock.calls as Array<
      [string, unknown]
    >;
    expect(
      calls.filter(([content]) => content.includes("[memory-candidate]"))
        .length,
    ).toBe(2);
    expect(calls.at(-1)?.[0]).toBe(
      "Remember to always ask me before deleting files.",
    );
  });
});
