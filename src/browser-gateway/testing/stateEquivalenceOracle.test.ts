import { describe, expect, it } from "vitest";

import type { ChatMessage } from "@agentlink/protocol/chat-transcript";
import type { ContextHealthSnapshot } from "@agentlink/protocol/context-health";
import type { BrowserGatewaySnapshotState } from "../BrowserGatewayService.js";
import {
  BrowserGatewayOwnerProjectionAdapter,
  type BrowserGatewayOwnerProjectionPublication,
} from "../dataPlane/ownerProjectionAdapter.js";
import type {
  BrowserGatewayOwnerProjectionReadSet,
  BrowserGatewayOwnerProjectionSourceKind,
  BrowserGatewayOwnerProjectionSources,
} from "../dataPlane/ownerProjectionSources.js";
import {
  BrowserGatewayRelayProjectionAccumulator,
  compareBrowserGatewayStateEquivalence,
  getBrowserGatewayStateEquivalenceBlockers,
} from "./stateEquivalenceOracle.js";

const identity = {
  helperGenerationId: "helper-generation-1",
  ownerId: "owner-1",
  ownerGenerationId: "owner-generation-1",
};

const PARITY_CONTEXT_HEALTH = {
  memory: { status: "ready", retrieval: "hybrid", activeRecordCount: 7 },
  retrieval: {
    status: "degraded",
    lexical: "ready",
    vector: "unavailable",
    structural: "ready",
    sourceCount: 12,
    chunkCount: 48,
    staleSourceCount: 2,
    reason: "Vector retrieval is unavailable.",
  },
  index: { status: "working", state: "indexing", current: 3, total: 10 },
} satisfies ContextHealthSnapshot;

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
      contextHealth: structuredClone(PARITY_CONTEXT_HEALTH),
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
      approvalPolicy: "on-request",
      approvalReviewer: "user",
      executionPreset: "native-manual",
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
    throw new Error("invalid parity fixture");
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
      chatWorkspace: null,
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
      repository: readSet.repository ? { ...readSet.repository } : null,
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
        contextHealth: foreground.contextHealth
          ? structuredClone(foreground.contextHealth)
          : null,
        ...(foreground.contextBudget
          ? { contextBudget: { ...foreground.contextBudget } }
          : {}),
        ...(foreground.condenseThreshold !== undefined
          ? { condenseThreshold: foreground.condenseThreshold }
          : {}),
        messageQueue: foreground.queue.map((item) => ({
          id: item.id,
          text: item.text,
        })),
        questionRequest: null,
        detectedQuestion: null,
        todos: structuredClone(foreground.todos) as never,
        debugInfo: null,
        systemPrompt: null,
        loadedInstructions: null,
        restoringSession: foreground.restoringSession,
        revertRecoveryNotice: foreground.revertRecoveryNotice
          ? { ...foreground.revertRecoveryNotice }
          : null,
        agentWriteApproval: readSet.policies.agentWriteApproval,
        commandApprovalPolicy: readSet.policies.commandApprovalPolicy,
        approvalPolicy: readSet.policies.approvalPolicy,
        approvalReviewer: readSet.policies.approvalReviewer,
        executionPreset: readSet.policies.executionPreset,
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

function createHarness() {
  const readSet = createReadSet();
  const legacy = createLegacySnapshot(readSet);
  const sources = new MutableProjectionSources(readSet);
  const accumulator = new BrowserGatewayRelayProjectionAccumulator();
  const publications: BrowserGatewayOwnerProjectionPublication[] = [];
  let now = 1_000;
  const adapter = new BrowserGatewayOwnerProjectionAdapter(sources, identity, {
    now: () => now,
    createId: (kind, sequence) => `${kind}-${sequence}`,
    createDetailId: (locator, revision) => `${locator}:${revision}`,
  });
  adapter.onDidPublish((publication) => {
    publications.push(publication);
    accumulator.apply(publication);
  });
  adapter.setDemanded(true);
  return {
    accumulator,
    adapter,
    legacy,
    publications,
    readSet,
    sources,
    compare() {
      return compareBrowserGatewayStateEquivalence({
        legacy,
        relay: accumulator.getCheckpoint(),
        resolveDetail: accumulator.resolveDetail,
      });
    },
    advanceNow() {
      now += 1;
    },
  };
}

function syncLegacyForeground(
  legacy: BrowserGatewaySnapshotState,
  readSet: BrowserGatewayOwnerProjectionReadSet,
): void {
  const source = readSet.foreground;
  const target = legacy.session.foreground;
  if (!source || !target) throw new Error("missing foreground fixture");
  target.title = source.title;
  target.mode = source.mode;
  target.model = source.model;
  target.status = source.status;
  target.streaming = source.streaming;
  target.statusOverride = source.statusOverride;
  target.thinkingEnabled = source.thinkingEnabled;
  target.reasoningEffort = source.reasoningEffort;
  target.lastInputTokens = source.lastInputTokens;
  target.lastOutputTokens = source.lastOutputTokens;
  target.lastCacheReadTokens = source.lastCacheReadTokens;
  target.estimatedTotalUsed = source.estimatedTokens ?? 0;
  target.contextHealth = source.contextHealth
    ? structuredClone(source.contextHealth)
    : null;
  target.contextBudget = source.contextBudget
    ? { ...source.contextBudget }
    : undefined;
  target.condenseThreshold = source.condenseThreshold;
  target.restoringSession = source.restoringSession;
  target.revertRecoveryNotice = source.revertRecoveryNotice
    ? { ...source.revertRecoveryNotice }
    : null;
  target.agentWriteApproval = readSet.policies.agentWriteApproval;
  target.commandApprovalPolicy = readSet.policies.commandApprovalPolicy;
  target.approvalPolicy = readSet.policies.approvalPolicy;
  target.approvalReviewer = readSet.policies.approvalReviewer;
  target.executionPreset = readSet.policies.executionPreset;
  target.configuredCommandApprovalPolicy =
    readSet.policies.configuredCommandApprovalPolicy;
  target.projectedMessages = structuredClone(source.messages) as ChatMessage[];
  target.messageQueue = source.queue.map((item) => ({
    id: item.id,
    text: item.text,
  }));
  target.todos = structuredClone(source.todos) as never;
}

describe("browser gateway state equivalence oracle", () => {
  it("matches the supported checkpoint semantics while preserving explicit cutover blockers", () => {
    const harness = createHarness();
    const result = harness.compare();

    expect(result.equivalent).toBe(true);
    expect(result.diffs).toEqual([]);
    expect(result.cutoverReady).toBe(false);
    expect(result.blockers.length).toBeGreaterThan(0);
    expect(result.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "ui.approval",
          status: "partial",
        }),
        expect.objectContaining({
          path: "session.foreground.detectedQuestion",
          status: "missing",
        }),
      ]),
    );

    harness.adapter.dispose();
  });

  it("stays equivalent across source-localized incremental publication boundaries", () => {
    const harness = createHarness();
    const { legacy, readSet, sources } = harness;

    readSet.catalog.sessions = [
      { ...readSet.catalog.sessions[0], title: "Renamed", updatedAt: 201 },
    ];
    legacy.session.sessions[0].title = "Renamed";
    legacy.session.sessions[0].lastActiveAt = 201;
    sources.fire("sessions");
    expect(harness.compare().diffs, "sessions").toEqual([]);

    readSet.foreground!.status = "streaming";
    readSet.foreground!.streaming = true;
    readSet.foreground!.statusOverride = null;
    readSet.foreground!.thinkingEnabled = true;
    readSet.foreground!.reasoningEffort = "high";
    readSet.foreground!.lastInputTokens = 44;
    readSet.foreground!.lastOutputTokens = 55;
    readSet.foreground!.lastCacheReadTokens = 66;
    readSet.foreground!.estimatedTokens = 77;
    readSet.foreground!.contextBudget = {
      ...readSet.foreground!.contextBudget!,
      usedInputTokens: 44,
    };
    readSet.foreground!.condenseThreshold = 0.75;
    readSet.foreground!.restoringSession = false;
    readSet.foreground!.revertRecoveryNotice = null;
    syncLegacyForeground(legacy, readSet);
    sources.fire("foreground");
    expect(harness.compare().diffs, "foreground").toEqual([]);

    readSet.policies = {
      agentWriteApproval: "project",
      commandApprovalPolicy: "sensitive",
      approvalPolicy: "on-request",
      approvalReviewer: "auto-review",
      executionPreset: "workspace-write",
      configuredCommandApprovalPolicy: "sensitive",
    };
    syncLegacyForeground(legacy, readSet);
    sources.fire("policies");
    expect(harness.compare().diffs, "policies").toEqual([]);

    readSet.foreground!.messages = [
      ...readSet.foreground!.messages,
      chatMessage("message-final", "assistant", "", 300, [
        { type: "text", text: "Final" },
      ]),
    ];
    syncLegacyForeground(legacy, readSet);
    sources.fire("foreground");
    expect(harness.compare().diffs, "transcript append").toEqual([]);

    const finalMessage = readSet.foreground!.messages.at(-1)!;
    finalMessage.blocks = [{ type: "text", text: "Final response" }];
    syncLegacyForeground(legacy, readSet);
    sources.fire("foreground");
    expect(harness.compare().diffs, "transcript delta").toEqual([]);

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
    sources.fire("foreground");
    expect(harness.compare().diffs, "queue and todos").toEqual([]);

    readSet.interaction = {
      requestId: "question-1",
      kind: "question",
      backgroundTask: "Review parity",
      step: 1,
      totalSteps: 1,
      payload: {
        approval: null,
        question: {
          id: "question-1",
          context: "Continue?",
          questions: [
            { id: "continue", type: "yes_no", question: "Continue?" },
          ],
          backgroundTask: "Review parity",
        },
        questionProgress: {
          id: "question-1",
          step: 0,
          answers: {},
          notes: {},
          origin: "browser",
        },
        formElicitation: null,
        urlElicitation: null,
      },
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
    sources.fire("ui");
    expect(harness.compare().diffs, "interaction").toEqual([]);

    readSet.background = [
      {
        sessionId: "background-1",
        title: "Review",
        status: "idle",
        updatedAt: 250,
      },
    ];
    legacy.background = [
      {
        id: "background-1",
        task: "Review",
        status: "idle",
        lastActiveAt: 250,
      },
    ];
    sources.fire("background");
    expect(harness.compare().diffs, "background").toEqual([]);

    readSet.diffs = [
      {
        ...readSet.diffs[0],
        filePath: "src/renamed.ts",
        createdAt: 251,
      },
    ];
    legacy.diffs = [
      {
        ...legacy.diffs[0],
        filePath: "src/renamed.ts",
        createdAt: 251,
      },
    ];
    sources.fire("diffs");
    expect(harness.compare().diffs, "diffs").toEqual([]);

    readSet.repository = {
      projectId: "project-1",
      branch: "feature/oracle",
      dirty: false,
    };
    legacy.session.repository = { ...readSet.repository };
    sources.fire("repository");
    expect(harness.compare().diffs, "repository").toEqual([]);

    readSet.theme = {
      ...readSet.theme,
      colorScheme: "light",
      cssVariables: {
        ...readSet.theme.cssVariables,
        "--vscode-foreground": "#111111",
      },
    };
    legacy.theme = structuredClone(readSet.theme);
    sources.fire("theme");
    expect(harness.compare().diffs, "theme").toEqual([]);

    expect(
      harness.publications
        .slice(1)
        .filter((publication) => publication.kind === "event").length,
    ).toBeGreaterThan(8);
    harness.adapter.dispose();
  });

  it("normalizes theme safety, interaction progress, and invalid background timestamps consistently", () => {
    const harness = createHarness();
    harness.readSet.theme.cssVariables = {
      "--vscode-empty": "",
      "--vscode-safe": "#123456",
      "--vscode-unsafe": "url(https://example.com/theme.png)",
      "--private-variable": "private",
    };
    harness.legacy.theme = structuredClone(harness.readSet.theme);
    harness.sources.fire("theme");
    expect(harness.compare().diffs, "theme safety").toEqual([]);
    expect(harness.compare().relay.theme.variables).toEqual([
      { name: "--vscode-empty", value: "" },
      { name: "--vscode-safe", value: "#123456" },
    ]);

    harness.readSet.interaction = {
      requestId: "question-without-total",
      kind: "question",
      payload: {
        approval: null,
        question: {
          id: "question-without-total",
          context: "Continue?",
          questions: [],
        },
        questionProgress: null,
        formElicitation: null,
        urlElicitation: null,
      },
    };
    harness.legacy.ui.question = {
      id: "question-without-total",
      context: "Continue?",
      questions: [],
    };
    harness.legacy.ui.questionProgress = null;
    harness.sources.fire("ui");
    expect(harness.compare().diffs, "pending question").toEqual([]);

    harness.readSet.interaction = {
      requestId: "approval-with-step",
      kind: "approval",
      step: 2,
      totalSteps: 3,
      payload: {
        approval: {
          kind: "write",
          id: "approval-with-step",
          filePath: "src/example.ts",
          writeOperation: "modify",
        },
        question: null,
        questionProgress: null,
        formElicitation: null,
        urlElicitation: null,
      },
    };
    harness.legacy.ui.question = null;
    harness.legacy.ui.approval = {
      kind: "write",
      id: "approval-with-step",
      filePath: "src/example.ts",
      writeOperation: "modify",
    };
    harness.sources.fire("ui");
    expect(harness.compare().diffs, "approval progress excluded").toEqual([]);

    harness.readSet.background = [
      {
        sessionId: "background-invalid-time",
        title: "Invalid timestamp",
        status: "idle",
        updatedAt: -10,
      },
    ];
    harness.legacy.background = [
      {
        id: "background-invalid-time",
        task: "Invalid timestamp",
        status: "idle",
        lastActiveAt: -10,
      },
    ];
    harness.sources.fire("background");
    expect(harness.compare().diffs, "background timestamp").toEqual([]);

    harness.adapter.dispose();
  });

  it("localizes foreground correctness mismatches", () => {
    const harness = createHarness();

    harness.legacy.session.foreground!.thinkingEnabled = true;
    harness.legacy.session.foreground!.contextBudget = {
      ...harness.legacy.session.foreground!.contextBudget!,
      hardBudget: 170_000,
    };
    harness.legacy.session.foreground!.contextHealth = {
      ...harness.legacy.session.foreground!.contextHealth!,
      retrieval: {
        ...harness.legacy.session.foreground!.contextHealth!.retrieval,
        staleSourceCount: 3,
      },
    };

    expect(harness.compare().diffs).toEqual([
      expect.objectContaining({ path: "foreground.contextBudget.hardBudget" }),
      expect.objectContaining({
        path: "foreground.contextHealth.retrieval.staleSourceCount",
      }),
      expect.objectContaining({ path: "foreground.thinkingEnabled" }),
    ]);

    harness.adapter.dispose();
  });

  it("resolves detail-backed transcript content and localizes semantic mismatches", () => {
    const harness = createHarness();
    const longText = "relay detail ".repeat(8_000);
    harness.readSet.foreground!.messages = [
      chatMessage("message-long", "user", longText, 500),
    ];
    syncLegacyForeground(harness.legacy, harness.readSet);
    harness.sources.fire("foreground");

    const equivalent = harness.compare();
    expect(equivalent.diffs).toEqual([]);
    expect(
      harness.publications.some(
        (publication) => (publication.details?.length ?? 0) > 0,
      ),
    ).toBe(true);

    harness.legacy.session.foreground!.projectedMessages[0].content =
      "different content";
    const mismatch = harness.compare();
    expect(mismatch.equivalent).toBe(false);
    expect(mismatch.diffs).toEqual([
      expect.objectContaining({ path: "transcript[message-long].content" }),
    ]);

    harness.adapter.dispose();
  });

  it("rejects sequence gaps and owner-generation changes without rolling state back", () => {
    const harness = createHarness();
    const checkpoint = harness.accumulator.getCheckpoint();
    const lastPublication = harness.publications[0];
    if (lastPublication.kind !== "checkpoint")
      throw new Error("expected initial checkpoint");

    harness.accumulator.apply(lastPublication);
    expect(harness.accumulator.getCheckpoint()).toEqual(checkpoint);

    const eventBase = {
      protocolVersion: checkpoint.protocolVersion,
      helperGenerationId: checkpoint.helperGenerationId,
      ownerId: checkpoint.ownerId,
      ownerGenerationId: checkpoint.ownerGenerationId,
      eventId: "manual-event",
      emittedAt: 2_000,
      kind: "repository.updated" as const,
      payload: { repository: null },
    };
    expect(() =>
      harness.accumulator.apply({
        kind: "event",
        event: {
          ...eventBase,
          ownerSequence: checkpoint.checkpointSequence + 2,
        },
      }),
    ).toThrow("state_equivalence_sequence_gap");
    expect(() =>
      harness.accumulator.apply({
        kind: "event",
        event: {
          ...eventBase,
          ownerGenerationId: "owner-generation-2",
          ownerSequence: checkpoint.checkpointSequence + 1,
        },
      }),
    ).toThrow("state_equivalence_owner_generation_changed");
    expect(harness.accumulator.getCheckpoint()).toEqual(checkpoint);

    harness.adapter.dispose();
  });

  it("rejects malformed details and duplicate checkpoint identities", () => {
    const harness = createHarness();
    const longText = "multibyte detail 🚀 ".repeat(5_000);
    harness.readSet.foreground!.messages = [
      chatMessage("message-detail", "user", longText, 500),
    ];
    syncLegacyForeground(harness.legacy, harness.readSet);
    harness.sources.fire("foreground");
    const publication = harness.publications.at(-1);
    if (
      !publication ||
      publication.kind !== "checkpoint" ||
      !publication.details?.[0]
    ) {
      throw new Error("expected detail-backed checkpoint");
    }

    const detail = publication.details[0];
    const wrongIdentity: BrowserGatewayOwnerProjectionPublication = {
      kind: "checkpoint",
      checkpoint: structuredClone(publication.checkpoint),
      details: [
        {
          ...detail,
          handle: {
            ...detail.handle,
            ownerGenerationId: "owner-generation-2",
          },
        },
      ],
    };
    expect(() =>
      new BrowserGatewayRelayProjectionAccumulator().apply(wrongIdentity),
    ).toThrow("state_equivalence_detail_identity_mismatch");

    const wrongLength: BrowserGatewayOwnerProjectionPublication = {
      kind: "checkpoint",
      checkpoint: structuredClone(publication.checkpoint),
      details: [
        {
          ...detail,
          handle: {
            ...detail.handle,
            byteLength: detail.handle.byteLength + 1,
          },
        },
      ],
    };
    expect(() =>
      new BrowserGatewayRelayProjectionAccumulator().apply(wrongLength),
    ).toThrow("state_equivalence_detail_byte_length_mismatch");

    const duplicate = structuredClone(publication);
    duplicate.checkpoint.catalog.projects.push({
      ...duplicate.checkpoint.catalog.projects[0],
    });
    expect(() =>
      new BrowserGatewayRelayProjectionAccumulator().apply(duplicate),
    ).toThrow("state_equivalence_duplicate_project_id");

    harness.adapter.dispose();
  });

  it("does not commit attached details from stale events", () => {
    const harness = createHarness();
    const checkpoint = harness.accumulator.getCheckpoint();
    const content = new TextEncoder().encode("stale detail");
    const handle = {
      helperGenerationId: checkpoint.helperGenerationId,
      ownerId: checkpoint.ownerId,
      ownerGenerationId: checkpoint.ownerGenerationId,
      handleId: "stale-detail",
      kind: "message" as const,
      byteLength: content.byteLength,
      expiresAt: 10_000,
      mediaType: "text/plain; charset=utf-8",
    };

    harness.accumulator.apply({
      kind: "event",
      details: [{ handle, content }],
      event: {
        protocolVersion: checkpoint.protocolVersion,
        helperGenerationId: checkpoint.helperGenerationId,
        ownerId: checkpoint.ownerId,
        ownerGenerationId: checkpoint.ownerGenerationId,
        ownerSequence: checkpoint.checkpointSequence,
        eventId: "stale-event",
        emittedAt: 2_000,
        kind: "repository.updated",
        payload: { repository: null },
      },
    });

    expect(harness.accumulator.resolveDetail(handle)).toBeNull();
    expect(harness.accumulator.getCheckpoint()).toEqual(checkpoint);
    harness.adapter.dispose();
  });

  it("rejects invalid transcript append, upsert, and delta transitions", () => {
    const harness = createHarness();
    const checkpoint = harness.accumulator.getCheckpoint();
    const message = checkpoint.transcript.messages[0];
    const eventBase = {
      protocolVersion: checkpoint.protocolVersion,
      helperGenerationId: checkpoint.helperGenerationId,
      ownerId: checkpoint.ownerId,
      ownerGenerationId: checkpoint.ownerGenerationId,
      eventId: "invalid-transcript-event",
      emittedAt: 2_000,
      ownerSequence: checkpoint.checkpointSequence + 1,
    };

    expect(() =>
      harness.accumulator.apply({
        kind: "event",
        event: {
          ...eventBase,
          kind: "transcript.message.appended",
          payload: { message },
        },
      }),
    ).toThrow("state_equivalence_duplicate_message_id");

    const upsertAccumulator = new BrowserGatewayRelayProjectionAccumulator();
    upsertAccumulator.apply(harness.publications[0]);
    expect(() =>
      upsertAccumulator.apply({
        kind: "event",
        event: {
          ...eventBase,
          kind: "transcript.message.upserted",
          payload: { message },
        },
      }),
    ).toThrow("state_equivalence_message_revision_unchanged");

    const deltaAccumulator = new BrowserGatewayRelayProjectionAccumulator();
    deltaAccumulator.apply(harness.publications[0]);
    expect(() =>
      deltaAccumulator.apply({
        kind: "event",
        event: {
          ...eventBase,
          kind: "transcript.block.delta",
          payload: {
            messageId: "message-assistant",
            blockId: "text-0",
            field: "thinking",
            delta: " invalid",
            revision: checkpoint.transcript.messages[1].revision === 1 ? 2 : 1,
          },
        },
      }),
    ).toThrow("state_equivalence_delta_field_mismatch");

    harness.adapter.dispose();
  });

  it("derives unresolved blockers directly from the executable parity contract", () => {
    const blockers = getBrowserGatewayStateEquivalenceBlockers();
    expect(blockers.every((entry) => entry.status !== "covered")).toBe(true);
    expect(blockers.every((entry) => entry.status !== "excluded")).toBe(true);
    expect(new Set(blockers.map((entry) => entry.path)).size).toBe(
      blockers.length,
    );
  });
});
