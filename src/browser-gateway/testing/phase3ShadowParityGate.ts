import type { ChatMessage } from "../../agent/webview/types.js";
import type { BrowserGatewaySnapshotState } from "../BrowserGatewayService.js";
import {
  isBrowserGatewayOwnerPublicationEnabled,
  resolveEffectiveBrowserGatewayDataPlaneMode,
} from "../browserGatewayDataPlaneMode.js";
import {
  BrowserGatewayOwnerProjectionAdapter,
  type BrowserGatewayOwnerProjectionPublication,
} from "../dataPlane/ownerProjectionAdapter.js";
import type {
  BrowserGatewayOwnerProjectionReadSet,
  BrowserGatewayOwnerProjectionSourceKind,
  BrowserGatewayOwnerProjectionSources,
} from "../dataPlane/ownerProjectionSources.js";
import { BROWSER_GATEWAY_ACTION_SURFACE_INVENTORY } from "../migration/actionSurfaceInventory.js";
import { resolveRelayClientEnabled } from "../webview/relay/relayClientSelection.js";
import {
  BrowserGatewayRelayProjectionAccumulator,
  compareBrowserGatewayStateEquivalence,
  type BrowserGatewayStateEquivalenceDiff,
} from "./stateEquivalenceOracle.js";

const initialIdentity = {
  helperGenerationId: "phase3-helper-1",
  ownerId: "phase3-owner",
  ownerGenerationId: "phase3-owner-1",
};

export interface Phase3ShadowParityStage {
  readonly name: string;
  readonly diffs: readonly BrowserGatewayStateEquivalenceDiff[];
}

export interface Phase3ShadowParityGateReport {
  readonly projectionEquivalent: boolean;
  readonly cutoverReady: boolean;
  readonly stages: readonly Phase3ShadowParityStage[];
  readonly blockerFingerprint: readonly string[];
  readonly publicationCount: number;
  readonly eventPublicationCount: number;
  readonly detailPublicationCount: number;
  readonly generationReplacementProjectionEquivalent: boolean;
  readonly rollout: {
    readonly ownerPublicationInShadow: boolean;
    readonly mixedWindowMode: string;
    readonly offOverrideRejected: boolean;
    readonly productionShadowRelayDisabled: boolean;
    readonly developmentShadowRelayEnabled: boolean;
  };
  readonly rollbackRoutesPreserved: boolean;
}

class MutableProjectionSources implements BrowserGatewayOwnerProjectionSources {
  private readonly listeners = new Set<
    (source: BrowserGatewayOwnerProjectionSourceKind) => void
  >();

  constructor(readonly readSet: BrowserGatewayOwnerProjectionReadSet) {}

  capture(): BrowserGatewayOwnerProjectionReadSet {
    return this.readSet;
  }

  onDidChange(
    listener: (source: BrowserGatewayOwnerProjectionSourceKind) => void,
  ): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  fire(source: BrowserGatewayOwnerProjectionSourceKind): void {
    for (const listener of this.listeners) listener(source);
  }
}

export function runPhase3ShadowParityGate(): Phase3ShadowParityGateReport {
  const readSet = createReadSet();
  const legacy = createLegacySnapshot(readSet);
  const sources = new MutableProjectionSources(readSet);
  const accumulator = new BrowserGatewayRelayProjectionAccumulator();
  const publications: BrowserGatewayOwnerProjectionPublication[] = [];
  let now = 1_000;
  const adapter = createAdapter(sources, initialIdentity, () => now);
  adapter.onDidPublish((publication) => {
    publications.push(publication);
    accumulator.apply(publication);
  });
  adapter.setDemanded(true);

  const stages: Phase3ShadowParityStage[] = [];
  const compare = (name: string): void => {
    const result = compareBrowserGatewayStateEquivalence({
      legacy,
      relay: accumulator.getCheckpoint(),
      resolveDetail: accumulator.resolveDetail,
    });
    stages.push({ name, diffs: result.diffs });
  };

  compare("initial checkpoint");

  readSet.catalog.sessions = [
    { ...readSet.catalog.sessions[0]!, title: "Renamed", updatedAt: 201 },
  ];
  legacy.session.sessions[0]!.title = "Renamed";
  legacy.session.sessions[0]!.lastActiveAt = 201;
  now += 1;
  sources.fire("sessions");
  compare("session rename");

  readSet.foreground!.status = "streaming";
  readSet.foreground!.streaming = true;
  syncLegacyForeground(legacy, readSet);
  now += 1;
  sources.fire("foreground");
  compare("foreground streaming");

  readSet.foreground!.messages = [
    ...readSet.foreground!.messages,
    chatMessage("message-final", "assistant", "", 300, [
      { type: "text", text: "Final" },
    ]),
  ];
  syncLegacyForeground(legacy, readSet);
  now += 1;
  sources.fire("foreground");
  compare("transcript append");

  readSet.foreground!.messages.at(-1)!.blocks = [
    { type: "text", text: "Final response" },
  ];
  syncLegacyForeground(legacy, readSet);
  now += 1;
  sources.fire("foreground");
  compare("transcript delta");

  readSet.foreground!.queue = [{ id: "queued-1", text: "Run focused tests" }];
  readSet.foreground!.todos = [
    {
      id: "todo-1",
      content: "Run tests",
      activeForm: "Running tests",
      status: "in_progress",
    },
  ];
  syncLegacyForeground(legacy, readSet);
  now += 1;
  sources.fire("foreground");
  compare("queue and todos");

  readSet.interaction = {
    requestId: "question-1",
    kind: "question",
    backgroundTask: "Review parity",
    step: 1,
    totalSteps: 1,
  };
  legacy.ui.question = {
    id: "question-1",
    context: "Continue?",
    questions: [{ id: "continue", type: "yes_no", question: "Continue?" }],
    backgroundTask: "Review parity",
  };
  legacy.ui.questionProgress = {
    id: "question-1",
    step: 1,
    answers: {},
    notes: {},
    origin: "browser",
  };
  now += 1;
  sources.fire("ui");
  compare("interaction lifecycle");

  readSet.background = [
    {
      sessionId: "background-1",
      title: "Review",
      status: "idle",
      updatedAt: 250,
    },
  ];
  legacy.background = [
    { id: "background-1", task: "Review", status: "idle", lastActiveAt: 250 },
  ];
  now += 1;
  sources.fire("background");
  compare("background status");

  readSet.diffs = [
    { ...readSet.diffs[0]!, filePath: "src/renamed.ts", createdAt: 251 },
  ];
  legacy.diffs = [
    { ...legacy.diffs[0]!, filePath: "src/renamed.ts", createdAt: 251 },
  ];
  now += 1;
  sources.fire("diffs");
  compare("diff metadata");

  readSet.repository = {
    projectId: "project-1",
    branch: "feature/phase3",
    dirty: false,
  };
  legacy.session.repository = { ...readSet.repository };
  now += 1;
  sources.fire("repository");
  compare("repository status");

  readSet.theme = {
    ...readSet.theme,
    colorScheme: "light",
    cssVariables: {
      ...readSet.theme.cssVariables,
      "--vscode-foreground": "#111111",
    },
  };
  legacy.theme = structuredClone(readSet.theme);
  now += 1;
  sources.fire("theme");
  compare("theme update");

  const longText = "phase3 detail 🚀 ".repeat(5_000);
  readSet.foreground!.messages = [
    chatMessage("message-detail", "user", longText, 500),
  ];
  syncLegacyForeground(legacy, readSet);
  now += 1;
  sources.fire("foreground");
  compare("detail-backed transcript");

  const final = compareBrowserGatewayStateEquivalence({
    legacy,
    relay: accumulator.getCheckpoint(),
    resolveDetail: accumulator.resolveDetail,
  });
  adapter.dispose();

  const replacementAccumulator = new BrowserGatewayRelayProjectionAccumulator();
  const replacementAdapter = createAdapter(
    sources,
    {
      helperGenerationId: "phase3-helper-2",
      ownerId: initialIdentity.ownerId,
      ownerGenerationId: "phase3-owner-2",
    },
    () => now + 1,
  );
  replacementAdapter.onDidPublish((publication) =>
    replacementAccumulator.apply(publication),
  );
  replacementAdapter.setDemanded(true);
  const replacementResult = compareBrowserGatewayStateEquivalence({
    legacy,
    relay: replacementAccumulator.getCheckpoint(),
    resolveDetail: replacementAccumulator.resolveDetail,
  });
  replacementAdapter.dispose();

  const rollbackRoutesPreserved = [
    ["GET", "/events"],
    ["GET", "/api/ui-state"],
  ].every(([method, path]) =>
    BROWSER_GATEWAY_ACTION_SURFACE_INVENTORY.some(
      (entry) =>
        entry.surface === "vscode_gateway" &&
        entry.method === method &&
        entry.path === path &&
        entry.disposition === "retained_http",
    ),
  );

  return {
    projectionEquivalent: stages.every((stage) => stage.diffs.length === 0),
    cutoverReady: final.cutoverReady,
    stages,
    blockerFingerprint: final.blockers.map(
      (blocker) => `${blocker.status}:${blocker.path}`,
    ),
    publicationCount: publications.length,
    eventPublicationCount: publications.filter(
      (publication) => publication.kind === "event",
    ).length,
    detailPublicationCount: publications.filter(
      (publication) => (publication.details?.length ?? 0) > 0,
    ).length,
    generationReplacementProjectionEquivalent: replacementResult.equivalent,
    rollout: {
      ownerPublicationInShadow:
        isBrowserGatewayOwnerPublicationEnabled("shadow"),
      mixedWindowMode: resolveEffectiveBrowserGatewayDataPlaneMode([
        "on",
        "shadow",
        "off",
      ]),
      offOverrideRejected: !resolveRelayClientEnabled({
        dataPlaneMode: "off",
        developmentBuild: true,
        search: "?dataPlane=relay",
        storedOverride: "relay",
      }),
      productionShadowRelayDisabled: !resolveRelayClientEnabled({
        dataPlaneMode: "shadow",
        developmentBuild: false,
        search: "?dataPlane=relay",
      }),
      developmentShadowRelayEnabled: resolveRelayClientEnabled({
        dataPlaneMode: "shadow",
        developmentBuild: true,
        search: "?dataPlane=relay",
      }),
    },
    rollbackRoutesPreserved,
  };
}

function createAdapter(
  sources: BrowserGatewayOwnerProjectionSources,
  identity: typeof initialIdentity,
  now: () => number,
): BrowserGatewayOwnerProjectionAdapter {
  return new BrowserGatewayOwnerProjectionAdapter(sources, identity, {
    now,
    createId: (kind, sequence) =>
      `${identity.ownerGenerationId}:${kind}:${sequence}`,
    createDetailId: (locator, revision) =>
      `${identity.ownerGenerationId}:${locator}:${revision}`,
  });
}

function chatMessage(
  id: string,
  role: ChatMessage["role"],
  content: string,
  timestamp: number,
  blocks: ChatMessage["blocks"] = [],
): ChatMessage {
  return { id, role, content, timestamp, blocks };
}

function createReadSet(): BrowserGatewayOwnerProjectionReadSet {
  return {
    catalog: {
      projects: [
        {
          projectId: "project-1",
          displayName: "AgentLink",
          availability: "available",
        },
      ],
      sessions: [
        {
          sessionId: "session-1",
          projectId: "project-1",
          title: "Parity session",
          mode: "code",
          model: "gpt-5.6-sol",
          messageCount: 2,
          createdAt: 100,
          updatedAt: 200,
        },
      ],
      defaultProjectId: "project-1",
      foregroundSessionId: "session-1",
    },
    foreground: {
      sessionId: "session-1",
      title: "Parity session",
      mode: "code",
      model: "gpt-5.6-sol",
      status: "idle",
      streaming: false,
      estimatedTokens: 33,
      maximumTokens: 200_000,
      statusOverride: "Restoring parity state",
      thinkingEnabled: false,
      reasoningEffort: "medium",
      lastInputTokens: 11,
      lastOutputTokens: 22,
      lastCacheReadTokens: 33,
      contextBudget: {
        contextWindow: 200_000,
        maxInputTokens: 180_000,
        usedInputTokens: 11,
        outputReservation: 8_192,
        safetyBufferTokens: 4_096,
        softThresholdBudget: 144_000,
        hardBudget: 175_904,
      },
      condenseThreshold: 0.8,
      restoringSession: true,
      revertRecoveryNotice: {
        projectId: "project-1",
        checkpointId: "checkpoint-1",
        sessionRevision: "session-revision-1",
        startedAt: 150,
        title: "Recovery required",
        message: "Restore the parity fixture.",
      },
      messages: [
        chatMessage("message-user", "user", "Run parity", 100),
        chatMessage("message-assistant", "assistant", "", 200, [
          { type: "text", text: "Ready" },
        ]),
      ],
      earlierCursor: null,
      hasEarlier: false,
      cursorBeforeMessage: (messageId) => `before:${messageId}`,
      queue: [],
      todos: [],
    },
    interaction: null,
    background: [
      {
        sessionId: "background-1",
        title: "Review",
        status: "streaming",
        updatedAt: 150,
      },
    ],
    fleet: [],
    diffs: [
      {
        requestId: "diff-1",
        filePath: "src/example.ts",
        operation: "modify",
        outsideWorkspace: false,
        createdAt: 175,
      },
    ],
    repository: {
      projectId: "project-1",
      branch: "feature/parity",
      dirty: true,
    },
    theme: {
      cssVariables: {
        "--vscode-editor-background": "#1e1e1e",
        "--vscode-foreground": "#cccccc",
        "--private-theme-value": "not-relay-safe",
      },
      colorScheme: "dark",
      themeLabel: "Dark",
      source: "vscode-theme-api",
    },
    modelCatalogRevision: "models-1",
    mcp: [],
    policies: {
      agentWriteApproval: "prompt",
      commandApprovalPolicy: "safe",
      configuredCommandApprovalPolicy: "safe",
    },
  };
}

function createLegacySnapshot(
  readSet: BrowserGatewayOwnerProjectionReadSet,
): BrowserGatewaySnapshotState {
  const foreground = readSet.foreground;
  const foregroundProject = readSet.catalog.projects.find(
    (project) => project.projectId === readSet.catalog.defaultProjectId,
  );
  if (!foreground || !foregroundProject)
    throw new Error("invalid phase3 parity fixture");
  return {
    ui: {
      approval: null,
      question: null,
      questionProgress: null,
      formElicitation: null,
      urlElicitation: null,
      recentEvents: [],
      mcpStatusInfos: [],
    },
    session: {
      projects: readSet.catalog.projects.map((project) => ({ ...project })),
      defaultProjectId: readSet.catalog.defaultProjectId,
      sessions: readSet.catalog.sessions.map((session) => ({
        id: session.sessionId,
        project: session.projectId
          ? readSet.catalog.projects.find(
              (project) => project.projectId === session.projectId,
            )
          : undefined,
        mode: session.mode,
        model: session.model,
        title: session.title,
        messageCount: session.messageCount,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        createdAt: session.createdAt,
        lastActiveAt: session.updatedAt,
      })),
      repository: { ...readSet.repository! },
      foreground: {
        sessionId: foreground.sessionId,
        project: { ...foregroundProject },
        title: foreground.title,
        mode: foreground.mode,
        model: foreground.model,
        status: foreground.status,
        streaming: foreground.streaming,
        projectedMessages: structuredClone(
          foreground.messages,
        ) as ChatMessage[],
        statusOverride: foreground.statusOverride,
        thinkingEnabled: foreground.thinkingEnabled,
        reasoningEffort: foreground.reasoningEffort,
        lastInputTokens: foreground.lastInputTokens,
        lastOutputTokens: foreground.lastOutputTokens,
        lastCacheReadTokens: foreground.lastCacheReadTokens,
        estimatedTotalUsed: foreground.estimatedTokens ?? 0,
        ...(foreground.contextBudget
          ? { contextBudget: { ...foreground.contextBudget } }
          : {}),
        ...(foreground.condenseThreshold !== undefined
          ? { condenseThreshold: foreground.condenseThreshold }
          : {}),
        messageQueue: [],
        questionRequest: null,
        detectedQuestion: null,
        todos: [],
        debugInfo: null,
        systemPrompt: null,
        loadedInstructions: null,
        restoringSession: foreground.restoringSession,
        revertRecoveryNotice: foreground.revertRecoveryNotice
          ? { ...foreground.revertRecoveryNotice }
          : null,
        agentWriteApproval: readSet.policies.agentWriteApproval,
        commandApprovalPolicy: readSet.policies.commandApprovalPolicy,
        configuredCommandApprovalPolicy:
          readSet.policies.configuredCommandApprovalPolicy,
      },
    },
    background: readSet.background.map((session) => ({
      id: session.sessionId,
      task: session.title,
      status: session.status as "streaming",
      lastActiveAt: session.updatedAt,
    })),
    diffs: readSet.diffs.map((diff) => ({
      requestId: diff.requestId,
      filePath: diff.filePath,
      operation: diff.operation as "create" | "modify",
      originalPreview: "",
      proposedPreview: "",
      outsideWorkspace: diff.outsideWorkspace,
      createdAt: diff.createdAt,
    })),
    theme: structuredClone(readSet.theme),
    modelsVersion: 1,
  };
}

function syncLegacyForeground(
  legacy: BrowserGatewaySnapshotState,
  readSet: BrowserGatewayOwnerProjectionReadSet,
): void {
  const source = readSet.foreground;
  const target = legacy.session.foreground;
  if (!source || !target) throw new Error("missing phase3 foreground fixture");
  target.title = source.title;
  target.mode = source.mode;
  target.model = source.model;
  target.status = source.status;
  target.streaming = source.streaming;
  target.projectedMessages = structuredClone(source.messages) as ChatMessage[];
  target.messageQueue = source.queue.map((item) => ({
    id: item.id,
    text: item.text,
  }));
  target.todos = structuredClone(source.todos) as never;
}
