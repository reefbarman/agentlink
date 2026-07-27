import * as vscode from "vscode";

import type { AgentSessionManager } from "../agent/AgentSessionManager.js";
import type { ChatWorkspaceViewSnapshot } from "../agent/chatTabProtocol.js";
import { getLatestTodoState } from "../agent/todoTool.js";
import type { AgentMessage, SessionInfo } from "../agent/types.js";

import type {
  ChatMessage,
  ChatState,
  Question,
  SessionSummary,
} from "../agent/webview/types.js";
import type { TodoItem } from "../agent/webview/types.js";
import {
  agentMessagesToChatMessages,
  type AppState,
} from "../shared/chatProjection.js";
import type {
  BgSessionInfo,
  BrowserGatewayThemeSnapshot,
} from "../shared/types.js";
import {
  getDevelopmentStreamingBaselineMetrics,
  type StreamingBaselineMetrics,
  utf8ByteLength,
} from "../shared/streamingBaselineMetrics.js";

import type { ChatViewProvider } from "../agent/ChatViewProvider.js";
import type { BrowserGatewayInstanceStatusSummary } from "./protocol.js";
import type { BrowserGatewayChatWorkspaceSummary } from "./dataPlane/protocol.js";
import type { McpFormElicitationRequest } from "../shared/mcpElicitation.js";
import type { McpUrlElicitationRequest } from "../shared/mcpUrlElicitation.js";
import type {
  AgentUiEvent,
  ReadableAgentUiEventHub,
  SessionUiEvent,
} from "../agent/AgentUiPublisher.js";

import type { ApprovalRequest } from "../approvals/webview/types.js";
import type { CommandApprovalPolicy } from "../approvals/commandApprovalPolicy.js";

import {
  diffSnapshotHub,
  type DiffSnapshotPreview,
} from "./DiffSnapshotHub.js";
import type { BrowserGatewayRepositoryInfo } from "./BrowserGatewayRepositoryObserver.js";
import type {
  BrowserGatewayOwnerProjectionReadSet,
  BrowserGatewayOwnerProjectionSourceKind,
  BrowserGatewayOwnerProjectionSources,
} from "./dataPlane/ownerProjectionSources.js";

export type { BrowserGatewayRepositoryInfo } from "./BrowserGatewayRepositoryObserver.js";

const REPOSITORY_INFO_CACHE_MS = 1_000;
const DEFAULT_FOREGROUND_PUBLICATION_COALESCE_MS = 150;

interface BrowserGatewayServiceTimerOptions {
  foregroundCoalesceMs?: number;
  setTimeout?: (
    callback: () => void,
    timeoutMs: number,
  ) => ReturnType<typeof setTimeout>;
  clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void;
}

export interface QuestionProgressState {
  id: string;
  step: number;
  answers: Record<string, string | string[] | number | boolean | undefined>;
  notes: Record<string, string>;
  origin: string;
}

export interface BrowserGatewayUiState {
  approval: ApprovalRequest | undefined;
  question:
    | {
        id: string;
        toolCallId?: string;
        context: string;
        questions: Question[];
        backgroundTask?: string;
      }
    | undefined;
  questionProgress: QuestionProgressState | undefined;
  formElicitation: McpFormElicitationRequest | undefined;
  urlElicitation: McpUrlElicitationRequest | undefined;
  recentEvents: AgentUiEvent[];
}

export interface BrowserGatewayWireState {
  approval: ApprovalRequest | null;
  question: {
    id: string;
    toolCallId?: string;
    context: string;
    questions: Question[];
    backgroundTask?: string;
  } | null;
  questionProgress: QuestionProgressState | null;
  formElicitation: McpFormElicitationRequest | null;
  urlElicitation: McpUrlElicitationRequest | null;
  recentEvents: AgentUiEvent[];
  mcpStatusInfos: ReturnType<ChatViewProvider["getBrowserMcpStatusInfos"]>;
}

export interface BrowserGatewayProjectInfo {
  projectId: string;
  displayName: string;
  availability: "available" | "unavailable";
}

export interface BrowserGatewaySessionState {
  projects: BrowserGatewayProjectInfo[];
  defaultProjectId: string | null;
  sessions: SessionSummary[];
  chatWorkspace: BrowserGatewayChatWorkspaceSummary | null;
  repository: BrowserGatewayRepositoryInfo | null;
  foreground:
    | {
        sessionId: string;
        project: BrowserGatewayProjectInfo;
        title: string;
        originalPrompt?: string;
        mode: string;
        model: string;
        status: string;
        interactiveExecutionPhase?: import("../agent/types.js").InteractiveExecutionPhase;
        streaming: boolean;
        interrupted?: boolean;
        messages: AgentMessage[];
        projectedMessages: ChatMessage[];
        statusOverride: string | null;
        thinkingEnabled: boolean;
        reasoningEffort: import("../agent/providers/types.js").ReasoningEffort;
        lastInputTokens: number;
        lastOutputTokens: number;
        lastCacheReadTokens: number;
        estimatedTotalUsed: number;
        messageQueue: AppState["messageQueue"];
        questionRequest: {
          id: string;
          toolCallId?: string;
          context: string;
          questions: Question[];
          backgroundTask?: string;
        } | null;
        detectedQuestion: AppState["detectedQuestion"];
        todos: TodoItem[];
        debugInfo: AppState["debugInfo"];
        systemPrompt: AppState["systemPrompt"];
        loadedInstructions: AppState["loadedInstructions"];
        restoringSession: AppState["restoringSession"];
        revertRecoveryNotice: AppState["revertRecoveryNotice"];
        contextBudget?: ChatState["contextBudget"];
        contextHealth: AppState["contextHealth"];
        condenseThreshold?: number;
        commandApprovalPolicy: CommandApprovalPolicy;
        approvalPolicy: NonNullable<ChatState["approvalPolicy"]>;
        approvalReviewer: NonNullable<ChatState["approvalReviewer"]>;
        executionPreset: NonNullable<ChatState["executionPreset"]>;
        configuredCommandApprovalPolicy: Exclude<
          CommandApprovalPolicy,
          "approve-for-me"
        >;
      }
    | undefined;
}

export interface BrowserGatewayWireSessionState {
  projects: BrowserGatewayProjectInfo[];
  defaultProjectId: string | null;
  sessions: SessionSummary[];
  chatWorkspace: BrowserGatewayChatWorkspaceSummary | null;
  repository: BrowserGatewayRepositoryInfo | null;
  foreground: {
    sessionId: string;
    project: BrowserGatewayProjectInfo;
    title: string;
    originalPrompt?: string;
    mode: string;
    model: string;
    status: string;
    interactiveExecutionPhase?: import("../agent/types.js").InteractiveExecutionPhase;
    streaming: boolean;
    interrupted?: boolean;
    projectedMessages: ChatMessage[];
    statusOverride: string | null;
    thinkingEnabled: boolean;
    reasoningEffort: import("../agent/providers/types.js").ReasoningEffort;
    lastInputTokens: number;
    lastOutputTokens: number;
    lastCacheReadTokens: number;
    estimatedTotalUsed: number;
    messageQueue: AppState["messageQueue"];
    questionRequest: {
      id: string;
      toolCallId?: string;
      context: string;
      questions: Question[];
      backgroundTask?: string;
    } | null;
    detectedQuestion: AppState["detectedQuestion"];
    todos: TodoItem[];
    debugInfo: AppState["debugInfo"];
    systemPrompt: AppState["systemPrompt"];
    loadedInstructions: AppState["loadedInstructions"];
    restoringSession: AppState["restoringSession"];
    revertRecoveryNotice: AppState["revertRecoveryNotice"];
    contextBudget?: ChatState["contextBudget"];
    contextHealth: AppState["contextHealth"];
    condenseThreshold?: number;
    agentWriteApproval: "prompt" | "session" | "project" | "global";
    commandApprovalPolicy: CommandApprovalPolicy;
    approvalPolicy: NonNullable<ChatState["approvalPolicy"]>;
    approvalReviewer: NonNullable<ChatState["approvalReviewer"]>;
    executionPreset: NonNullable<ChatState["executionPreset"]>;
    configuredCommandApprovalPolicy: Exclude<
      CommandApprovalPolicy,
      "approve-for-me"
    >;
  } | null;
}

export interface BrowserGatewayDetachedSessionSelection {
  controllerEpoch: string;
  tabId: string;
  sessionId: string;
}

export interface BrowserGatewayDetachedSessionUiState {
  approval: ApprovalRequest | null;
  question: {
    id: string;
    toolCallId?: string;
    context: string;
    questions: Question[];
    backgroundTask?: string;
  } | null;
  questionProgress: QuestionProgressState | null;
  formElicitation: McpFormElicitationRequest | null;
  urlElicitation: McpUrlElicitationRequest | null;
}

export interface BrowserGatewayDetachedSessionDetail {
  selection: BrowserGatewayDetachedSessionSelection;
  session: NonNullable<BrowserGatewayWireSessionState["foreground"]>;
  ui: BrowserGatewayDetachedSessionUiState;
  revertRecoveryState: ReturnType<
    AgentSessionManager["getRevertRecoveryState"]
  >;
}

export interface BrowserGatewaySnapshotState {
  ui: BrowserGatewayWireState;
  session: BrowserGatewayWireSessionState;
  background: BgSessionInfo[];
  diffs: DiffSnapshotPreview[];
  theme: BrowserGatewayThemeSnapshot;
  /**
   * Monotonic counter bumped when the provider model list/capabilities change
   * (e.g. Anthropic dynamic capability refresh). Browser clients re-fetch
   * `/api/models` when this changes — keeps model metadata in parity without a
   * dedicated event (Target A / Q7).
   */
  modelsVersion: number;
}

export interface BrowserGatewaySnapshotPublication {
  readonly revision: number;
  readonly snapshot: BrowserGatewaySnapshotState;
  readonly serialized: string;
  readonly bytes: number;
}

export class BrowserGatewayService implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly onDidChangeEmitter =
    new vscode.EventEmitter<BrowserGatewaySnapshotPublication>();
  private readonly onDidChangeOwnerProjectionEmitter =
    new vscode.EventEmitter<BrowserGatewayOwnerProjectionSourceKind>();
  private foregroundInvalidationTimer:
    | ReturnType<typeof setTimeout>
    | undefined;
  private foregroundInvalidationGeneration = 0;
  private foregroundInvalidationPublishWithoutClients = false;
  private lastSerializedSnapshot = "";
  private snapshotRevision = 0;
  // Optional probe, set by the gateway server, reporting whether any browser
  // client is currently connected. Explicit invalidations skip snapshot work when
  // nobody is listening; newly connected clients receive a fresh connect snapshot.
  private hasActiveClientsProbe: (() => boolean) | undefined;
  private approval: ApprovalRequest | undefined;
  private approvalSessionId: string | undefined;
  private question:
    | {
        id: string;
        toolCallId?: string;
        context: string;
        questions: Question[];
        backgroundTask?: string;
      }
    | undefined;
  private questionSessionId: string | undefined;
  private questionProgress: QuestionProgressState | undefined;
  private formElicitation: McpFormElicitationRequest | undefined;
  private formElicitationSessionId: string | undefined;
  private urlElicitation: McpUrlElicitationRequest | undefined;
  private urlElicitationSessionId: string | undefined;
  private seededForegroundSessionId: string | undefined;
  private recentEvents: AgentUiEvent[] = [];
  private modelsVersion = 0;
  private repositoryInfoCache:
    | { value: BrowserGatewayRepositoryInfo | null; expiresAt: number }
    | undefined;
  private getRepositoryInfoProvider: () => BrowserGatewayRepositoryInfo | null =
    () => null;
  private getChatWorkspaceSnapshot: () =>
    | ChatWorkspaceViewSnapshot
    | undefined = () => undefined;
  private getCommandApprovalPolicy: () => CommandApprovalPolicy = () => "safe";
  private getConfiguredCommandApprovalPolicy: (
    projectScope?: Parameters<
      ChatViewProvider["getConfiguredCommandApprovalPolicy"]
    >[0],
  ) => Exclude<CommandApprovalPolicy, "approve-for-me"> = () => "safe";

  readonly onDidChange = this.onDidChangeEmitter.event;

  /**
   * Register a probe used to skip explicit snapshot work when no browser client
   * is connected. The gateway server wires this to its active SSE client set.
   */
  setHasActiveClientsProbe(probe: (() => boolean) | undefined): void {
    this.hasActiveClientsProbe = probe;
  }

  constructor(
    private readonly uiEventHub: ReadableAgentUiEventHub,
    private readonly sessionManager: AgentSessionManager,
    private readonly getThemeSnapshot: () => BrowserGatewayThemeSnapshot,
    private readonly getAgentWriteApprovalState: (
      sessionId?: string,
    ) => ReturnType<ChatViewProvider["getBrowserAgentWriteApprovalState"]>,
    private readonly getThinkingEnabledState: () => ReturnType<
      ChatViewProvider["getBrowserThinkingEnabledState"]
    >,
    private readonly getReasoningEffortState: () => ReturnType<
      ChatViewProvider["getBrowserReasoningEffortState"]
    >,
    private readonly getProjectedForegroundState: () => ReturnType<
      ChatViewProvider["getBrowserProjectedForegroundState"]
    >,
    private readonly getMcpStatusInfos: () => ReturnType<
      ChatViewProvider["getBrowserMcpStatusInfos"]
    >,
    private readonly maxRecentEvents = 20,
    private readonly streamingMetrics: StreamingBaselineMetrics = getDevelopmentStreamingBaselineMetrics(
      "vscode-gateway",
      __DEV_BUILD__,
    ),
    private readonly timers: BrowserGatewayServiceTimerOptions = {},
  ) {
    this.seedForegroundUiState();

    this.disposables.push(
      uiEventHub.onDidPublish((event) => {
        this.applyEvent(event);
        this.onDidChangeOwnerProjectionEmitter.fire("ui");
      }),
      diffSnapshotHub.onDidChange(() => {
        this.onDidChangeOwnerProjectionEmitter.fire("diffs");
        this.invalidateBrowserSnapshot({ immediate: true });
      }),
    );
  }

  getCurrentThemeSnapshot(): BrowserGatewayThemeSnapshot {
    return this.getThemeSnapshot();
  }

  getOwnerProjectionSources(): BrowserGatewayOwnerProjectionSources {
    return {
      capture: () => this.captureOwnerProjectionReadSet(),
      onDidChange: (listener) =>
        this.onDidChangeOwnerProjectionEmitter.event(listener),
    };
  }

  notifyOwnerProjectionSource(
    source: BrowserGatewayOwnerProjectionSourceKind,
  ): void {
    this.onDidChangeOwnerProjectionEmitter.fire(source);
  }

  setRepositoryInfoProvider(
    getRepositoryInfo: () => BrowserGatewayRepositoryInfo | null,
  ): void {
    this.getRepositoryInfoProvider = getRepositoryInfo;
    this.repositoryInfoCache = undefined;
  }

  setChatWorkspaceProvider(
    getSnapshot: () => ChatWorkspaceViewSnapshot | undefined,
    onDidChange: (listener: () => void) => { dispose(): void },
  ): void {
    this.getChatWorkspaceSnapshot = getSnapshot;
    this.disposables.push(
      onDidChange(() => {
        this.onDidChangeOwnerProjectionEmitter.fire("sessions");
        this.invalidateBrowserSnapshot();
      }),
    );
  }

  subscribeToRepositoryChanges(
    onDidChangeRepository: (listener: () => void) => { dispose(): void },
  ): void {
    this.disposables.push(
      onDidChangeRepository(() => {
        this.repositoryInfoCache = undefined;
        this.onDidChangeOwnerProjectionEmitter.fire("repository");
        this.invalidateBrowserSnapshot();
      }),
    );
  }

  setDefaultProject(projectId: string): boolean {
    return this.sessionManager.setBrowserPreferredProject(projectId);
  }

  getProjectAvailability(
    projectId: string,
  ): "available" | "unavailable" | "unknown" {
    const project = this.sessionManager
      .getWorkspaceProjects()
      .find((candidate) => candidate.id === projectId);
    if (!project) return "unknown";
    return project.availability.status === "available"
      ? "available"
      : "unavailable";
  }

  getSessionProjectId(sessionId: string): string | undefined {
    return (
      this.sessionManager.getSession(sessionId)?.projectScope.projectId ??
      this.sessionManager
        .listPersistedSessions()
        .find((session) => session.id === sessionId)?.projectScope?.projectId
    );
  }

  setCommandApprovalPolicyGetters(
    getEffective: () => ReturnType<
      ChatViewProvider["getBrowserCommandApprovalPolicy"]
    >,
    getConfigured: (
      projectScope?: Parameters<
        ChatViewProvider["getConfiguredCommandApprovalPolicy"]
      >[0],
    ) => ReturnType<ChatViewProvider["getConfiguredCommandApprovalPolicy"]>,
  ): void {
    this.getCommandApprovalPolicy = getEffective;
    this.getConfiguredCommandApprovalPolicy = getConfigured;
  }

  subscribeToProjectedForegroundChanges(
    onDidChangeProjectedForeground: (listener: () => void) => {
      dispose(): void;
    },
  ): void {
    this.disposables.push(
      onDidChangeProjectedForeground(() => {
        this.onDidChangeOwnerProjectionEmitter.fire("foreground");
        this.invalidateBrowserSnapshot();
      }),
    );
  }

  subscribeToSessionChanges(
    onDidChangeSessions: (listener: () => void) => { dispose(): void },
  ): void {
    this.disposables.push(
      onDidChangeSessions(() => {
        this.seedForegroundUiState();
        this.onDidChangeOwnerProjectionEmitter.fire("sessions");
        this.invalidateBrowserSnapshot();
      }),
    );
  }

  subscribeToSurfaceChanges(
    onDidChangeSurface: (
      listener: (kind: "background" | "mcp" | "theme") => void,
    ) => {
      dispose(): void;
    },
  ): void {
    this.disposables.push(
      onDidChangeSurface((kind) => {
        this.onDidChangeOwnerProjectionEmitter.fire(kind);
        this.invalidateBrowserSnapshot({
          publishWithoutClients: kind === "theme",
        });
      }),
    );
  }

  invalidateBrowserSnapshot(
    options: { immediate?: boolean; publishWithoutClients?: boolean } = {},
  ): void {
    if (
      !options.publishWithoutClients &&
      this.hasActiveClientsProbe &&
      !this.hasActiveClientsProbe()
    ) {
      return;
    }

    if (options.immediate) {
      this.cancelPendingForegroundInvalidation();
      this.emitSnapshotIfChanged(options.publishWithoutClients);
      return;
    }

    this.foregroundInvalidationPublishWithoutClients ||=
      options.publishWithoutClients === true;
    if (this.foregroundInvalidationTimer) return;

    const generation = ++this.foregroundInvalidationGeneration;
    this.foregroundInvalidationTimer = this.scheduleTimeout(() => {
      if (generation !== this.foregroundInvalidationGeneration) return;
      this.foregroundInvalidationTimer = undefined;
      const publishWithoutClients =
        this.foregroundInvalidationPublishWithoutClients;
      this.foregroundInvalidationPublishWithoutClients = false;
      this.emitSnapshotIfChanged(publishWithoutClients);
    }, this.timers.foregroundCoalesceMs ?? DEFAULT_FOREGROUND_PUBLICATION_COALESCE_MS);
  }

  getUiState(): BrowserGatewayUiState {
    const question = this.getForegroundQuestion();
    const questionProgress = this.getForegroundQuestionProgress(question?.id);
    return {
      approval: this.approval,
      question,
      questionProgress,
      formElicitation: this.formElicitation
        ? cloneFormElicitationRequest(this.formElicitation)
        : undefined,
      urlElicitation: this.urlElicitation
        ? { ...this.urlElicitation }
        : undefined,
      recentEvents: [...this.recentEvents],
    };
  }

  getSessionState(): BrowserGatewaySessionState {
    const projects = this.sessionManager
      .getWorkspaceProjects()
      .map((project) => ({
        projectId: project.id,
        displayName: project.name,
        availability:
          project.availability.status === "available"
            ? ("available" as const)
            : ("unavailable" as const),
      }));
    const defaultProjectId =
      this.sessionManager.getDefaultProjectScope()?.projectId ?? null;
    const projectsById = new Map(
      projects.map((project) => [project.projectId, project]),
    );
    const sessionInfos = this.sessionManager.getSessionInfos();
    const sessions = this.sessionManager
      .listPersistedSessions()
      .map((session) => {
        const projectId = session.projectScope?.projectId;
        const project = projectId
          ? (projectsById.get(projectId) ?? {
              projectId,
              displayName:
                session.projectScope?.displayName ?? "Project unavailable",
              availability: "unavailable" as const,
            })
          : undefined;
        return {
          id: session.id,
          project,
          mode: session.mode,
          model: session.model,
          title: session.title,
          messageCount: session.messageCount,
          totalInputTokens: session.totalInputTokens,
          totalOutputTokens: session.totalOutputTokens,
          createdAt: session.createdAt,
          lastActiveAt: session.lastActiveAt,
        };
      });
    const foreground = this.sessionManager.getForegroundSession();
    if (!foreground) {
      return {
        projects,
        defaultProjectId,
        sessions,
        chatWorkspace: this.createChatWorkspaceSummary(sessionInfos),
        repository: this.getRepositoryInfo(),
        foreground: undefined,
      };
    }

    // Read-only browser snapshots intentionally prefer persisted messages so the
    // gateway can mirror the durable session history format without depending on
    // the chat webview reducer. This can lag an active streaming turn by roughly
    // the persistence interval; richer browser transcript views may need an
    // in-memory tail or a live event projection instead.
    const persistedMessages =
      this.sessionManager.getPersistedSessionMessages(foreground.id) ??
      foreground.getAllMessages();

    const projected = this.getProjectedForegroundState();
    const projectedMatchesForeground =
      projected && projected.sessionId === foreground.id;
    const configuredCommandApprovalPolicy =
      this.getConfiguredCommandApprovalPolicy(foreground.projectScope);
    const approvalMode = this.sessionManager.getSessionApprovalMode(
      foreground.id,
      configuredCommandApprovalPolicy,
    );

    const projectionStartedAt = this.streamingMetrics.enabled
      ? performance.now()
      : 0;
    const persistedProjectedMessages =
      agentMessagesToChatMessages(persistedMessages);
    const projectedMessages = projectedMatchesForeground
      ? projected.projectedMessages
      : persistedProjectedMessages;
    if (this.streamingMetrics.enabled) {
      this.streamingMetrics.record({
        type: "message_projection",
        surface: "vscode-gateway",
        durationMs: performance.now() - projectionStartedAt,
        messageCount: projectedMessages.length,
      });
    }

    const foregroundProject = projectsById.get(
      foreground.projectScope.projectId,
    );
    const interactiveExecutionPhase = sessionInfos.find(
      (session) => session.id === foreground.id,
    )?.interactiveExecutionPhase;
    return {
      projects,
      defaultProjectId,
      sessions,
      chatWorkspace: this.createChatWorkspaceSummary(
        sessionInfos,
        projectedMatchesForeground ? projected : undefined,
      ),
      repository: this.getRepositoryInfo(),
      foreground: {
        sessionId: foreground.id,
        project: {
          projectId: foreground.projectScope.projectId,
          displayName: foreground.projectScope.displayName,
          availability:
            foreground.projectAvailability === "available" &&
            foregroundProject?.availability === "available"
              ? "available"
              : "unavailable",
        },
        title: foreground.title,
        originalPrompt:
          (projectedMatchesForeground ? projected.originalPrompt : undefined) ??
          persistedProjectedMessages.find((message) => message.role === "user")
            ?.content,
        mode: projectedMatchesForeground ? projected.mode : foreground.mode,
        model: projectedMatchesForeground ? projected.model : foreground.model,
        status: foreground.status,
        interactiveExecutionPhase,
        streaming: projectedMatchesForeground
          ? projected.streaming
          : foreground.status === "streaming" ||
            foreground.status === "tool_executing" ||
            foreground.status === "awaiting_approval",
        interrupted: projectedMatchesForeground
          ? Boolean(projected.interrupted)
          : Boolean(
              foreground.runState?.phase === "running" &&
              foreground.status !== "streaming" &&
              foreground.status !== "tool_executing" &&
              foreground.status !== "awaiting_approval",
            ),
        messages: persistedMessages,
        projectedMessages,
        statusOverride: projectedMatchesForeground
          ? projected.statusOverride
          : null,
        thinkingEnabled: projectedMatchesForeground
          ? projected.thinkingEnabled
          : this.getThinkingEnabledState(),
        reasoningEffort: projectedMatchesForeground
          ? projected.reasoningEffort
          : this.getReasoningEffortState(),
        lastInputTokens: projectedMatchesForeground
          ? projected.lastInputTokens
          : foreground.lastInputTokens,
        lastOutputTokens: projectedMatchesForeground
          ? projected.lastOutputTokens
          : foreground.lastOutputTokens,
        lastCacheReadTokens: projectedMatchesForeground
          ? projected.lastCacheReadTokens
          : foreground.lastCacheReadTokens,
        estimatedTotalUsed: projectedMatchesForeground
          ? projected.estimatedTotalUsed
          : foreground.estimatedTotalUsed,
        messageQueue: projectedMatchesForeground ? projected.messageQueue : [],
        questionRequest: projectedMatchesForeground
          ? projected.questionRequest
          : null,
        detectedQuestion: projectedMatchesForeground
          ? projected.detectedQuestion
          : null,
        todos: projectedMatchesForeground ? projected.todos : [],
        debugInfo: projectedMatchesForeground ? projected.debugInfo : null,
        systemPrompt: projectedMatchesForeground
          ? projected.systemPrompt
          : null,
        loadedInstructions: projectedMatchesForeground
          ? projected.loadedInstructions
          : null,
        restoringSession: projectedMatchesForeground
          ? projected.restoringSession
          : false,
        revertRecoveryNotice: projectedMatchesForeground
          ? projected.revertRecoveryNotice
          : null,
        contextBudget: projectedMatchesForeground
          ? projected.contextBudget
          : undefined,
        contextHealth: projectedMatchesForeground
          ? projected.contextHealth
          : null,
        condenseThreshold: projectedMatchesForeground
          ? projected.condenseThreshold
          : undefined,
        commandApprovalPolicy: projectedMatchesForeground
          ? (projected.commandApprovalPolicy ??
            approvalMode.commandApprovalPolicy)
          : approvalMode.commandApprovalPolicy,
        approvalPolicy: projectedMatchesForeground
          ? (projected.approvalPolicy ?? approvalMode.approvalPolicy)
          : approvalMode.approvalPolicy,
        approvalReviewer: projectedMatchesForeground
          ? (projected.approvalReviewer ?? approvalMode.approvalReviewer)
          : approvalMode.approvalReviewer,
        executionPreset: projectedMatchesForeground
          ? (projected.executionPreset ?? approvalMode.executionPreset)
          : approvalMode.executionPreset,
        configuredCommandApprovalPolicy,
      },
    };
  }

  getSerializableSessionDetail(
    selection: BrowserGatewayDetachedSessionSelection,
  ): BrowserGatewayDetachedSessionDetail | null {
    const workspace = this.getChatWorkspaceSnapshot();
    if (
      !workspace ||
      workspace.controllerEpoch !== selection.controllerEpoch ||
      !workspace.tabs.some(
        (tab) =>
          tab.tabId === selection.tabId &&
          tab.sessionId === selection.sessionId,
      )
    ) {
      return null;
    }

    const session = this.sessionManager.getSession(selection.sessionId);
    if (!session) return null;

    // Detached detail is available only for materialized sessions. Prefer the
    // live in-memory transcript here so browser tabs do not lag the active tail
    // by the persistence interval used by the global foreground snapshot.
    const messages = session.getAllMessages();
    const projected = this.getProjectedForegroundState();
    const projectedMatchesSession = projected?.sessionId === session.id;
    const projectedMessages = projectedMatchesSession
      ? projected.projectedMessages
      : agentMessagesToChatMessages(messages);
    const sessionInfo = this.sessionManager
      .getSessionInfos()
      .find((candidate) => candidate.id === session.id);
    const configuredCommandApprovalPolicy =
      this.getConfiguredCommandApprovalPolicy(session.projectScope);
    const approvalMode = this.sessionManager.getSessionApprovalMode(
      session.id,
      configuredCommandApprovalPolicy,
    );
    const ui = createDetachedSessionUiState(
      this.uiEventHub.getSnapshot(session.id),
    );
    const pendingQuestion = this.sessionManager.getPendingQuestionRecovery(
      session.id,
    );
    if (!ui.question && pendingQuestion) {
      ui.question = {
        id: pendingQuestion.questionRequestId,
        toolCallId: pendingQuestion.toolUseId,
        context: pendingQuestion.context,
        questions: structuredClone(pendingQuestion.questions),
      };
    }

    return {
      selection: { ...selection },
      session: {
        sessionId: session.id,
        project: {
          projectId: session.projectScope.projectId,
          displayName: session.projectScope.displayName,
          availability:
            session.projectAvailability === "available"
              ? "available"
              : "unavailable",
        },
        title: session.title,
        originalPrompt:
          (projectedMatchesSession ? projected.originalPrompt : undefined) ??
          projectedMessages.find((message) => message.role === "user")?.content,
        mode: projectedMatchesSession ? projected.mode : session.mode,
        model: projectedMatchesSession ? projected.model : session.model,
        status: session.status,
        interactiveExecutionPhase: sessionInfo?.interactiveExecutionPhase,
        streaming: projectedMatchesSession
          ? projected.streaming
          : session.status === "streaming" ||
            session.status === "tool_executing" ||
            session.status === "awaiting_approval",
        interrupted: projectedMatchesSession
          ? Boolean(projected.interrupted)
          : Boolean(
              session.runState?.phase === "running" &&
              session.status !== "streaming" &&
              session.status !== "tool_executing" &&
              session.status !== "awaiting_approval",
            ),
        projectedMessages,
        statusOverride: projectedMatchesSession
          ? projected.statusOverride
          : null,
        contextHealth: projectedMatchesSession ? projected.contextHealth : null,
        thinkingEnabled: projectedMatchesSession
          ? projected.thinkingEnabled
          : session.reasoningEffort !== "none",
        reasoningEffort: projectedMatchesSession
          ? projected.reasoningEffort
          : session.reasoningEffort,
        lastInputTokens: projectedMatchesSession
          ? projected.lastInputTokens
          : session.lastInputTokens,
        lastOutputTokens: projectedMatchesSession
          ? projected.lastOutputTokens
          : session.lastOutputTokens,
        lastCacheReadTokens: projectedMatchesSession
          ? projected.lastCacheReadTokens
          : session.lastCacheReadTokens,
        estimatedTotalUsed: projectedMatchesSession
          ? projected.estimatedTotalUsed
          : session.estimatedTotalUsed,
        messageQueue: projectedMatchesSession ? projected.messageQueue : [],
        questionRequest: projectedMatchesSession
          ? projected.questionRequest
          : ui.question,
        detectedQuestion: projectedMatchesSession
          ? projected.detectedQuestion
          : null,
        todos: projectedMatchesSession
          ? structuredClone(projected.todos)
          : structuredClone(getLatestTodoState(messages)),
        debugInfo: projectedMatchesSession ? projected.debugInfo : null,
        systemPrompt: projectedMatchesSession ? projected.systemPrompt : null,
        loadedInstructions: projectedMatchesSession
          ? projected.loadedInstructions
          : null,
        restoringSession: projectedMatchesSession
          ? projected.restoringSession
          : false,
        revertRecoveryNotice: projectedMatchesSession
          ? projected.revertRecoveryNotice
          : null,
        contextBudget: projectedMatchesSession
          ? projected.contextBudget
          : undefined,
        condenseThreshold: projectedMatchesSession
          ? projected.condenseThreshold
          : undefined,
        agentWriteApproval: this.getAgentWriteApprovalState(session.id),
        commandApprovalPolicy: projectedMatchesSession
          ? (projected.commandApprovalPolicy ??
            approvalMode.commandApprovalPolicy)
          : approvalMode.commandApprovalPolicy,
        approvalPolicy: projectedMatchesSession
          ? (projected.approvalPolicy ?? approvalMode.approvalPolicy)
          : approvalMode.approvalPolicy,
        approvalReviewer: projectedMatchesSession
          ? (projected.approvalReviewer ?? approvalMode.approvalReviewer)
          : approvalMode.approvalReviewer,
        executionPreset: projectedMatchesSession
          ? (projected.executionPreset ?? approvalMode.executionPreset)
          : approvalMode.executionPreset,
        configuredCommandApprovalPolicy,
      },
      ui,
      revertRecoveryState: this.sessionManager.getRevertRecoveryState(
        session.id,
      ),
    };
  }

  getSerializableState(): BrowserGatewayWireState {
    const question = this.getForegroundQuestion();
    return {
      approval: this.approval ?? null,
      question: question ?? null,
      questionProgress:
        this.getForegroundQuestionProgress(question?.id) ?? null,
      formElicitation: this.formElicitation
        ? cloneFormElicitationRequest(this.formElicitation)
        : null,
      urlElicitation: this.urlElicitation ? { ...this.urlElicitation } : null,
      recentEvents: [...this.recentEvents],
      mcpStatusInfos: this.getMcpStatusInfos(),
    };
  }

  getSerializableSessionState(): BrowserGatewayWireSessionState {
    const sessionState = this.getSessionState();
    // The browser renders only the projected transcript. Do not also serialize
    // raw AgentMessage[] here: long sessions otherwise cross the wire twice.
    return {
      projects: sessionState.projects,
      defaultProjectId: sessionState.defaultProjectId,
      sessions: sessionState.sessions,
      chatWorkspace: sessionState.chatWorkspace,
      repository: sessionState.repository,
      foreground: sessionState.foreground
        ? {
            sessionId: sessionState.foreground.sessionId,
            project: sessionState.foreground.project,
            title: sessionState.foreground.title,
            originalPrompt: sessionState.foreground.originalPrompt,
            mode: sessionState.foreground.mode,
            model: sessionState.foreground.model,
            status: sessionState.foreground.status,
            interactiveExecutionPhase:
              sessionState.foreground.interactiveExecutionPhase,
            streaming: sessionState.foreground.streaming,
            interrupted: sessionState.foreground.interrupted,
            projectedMessages: sessionState.foreground.projectedMessages,
            statusOverride: sessionState.foreground.statusOverride,
            thinkingEnabled: sessionState.foreground.thinkingEnabled,
            reasoningEffort: sessionState.foreground.reasoningEffort,
            lastInputTokens: sessionState.foreground.lastInputTokens,
            lastOutputTokens: sessionState.foreground.lastOutputTokens,
            lastCacheReadTokens: sessionState.foreground.lastCacheReadTokens,
            estimatedTotalUsed: sessionState.foreground.estimatedTotalUsed,
            messageQueue: sessionState.foreground.messageQueue,
            questionRequest: sessionState.foreground.questionRequest,
            detectedQuestion: sessionState.foreground.detectedQuestion,
            todos: sessionState.foreground.todos,
            debugInfo: sessionState.foreground.debugInfo,
            systemPrompt: sessionState.foreground.systemPrompt,
            loadedInstructions: sessionState.foreground.loadedInstructions,
            restoringSession: sessionState.foreground.restoringSession,
            revertRecoveryNotice: sessionState.foreground.revertRecoveryNotice,
            contextBudget: sessionState.foreground.contextBudget,
            contextHealth: sessionState.foreground.contextHealth,
            condenseThreshold: sessionState.foreground.condenseThreshold,
            agentWriteApproval: this.getAgentWriteApprovalState(
              sessionState.foreground.sessionId,
            ),
            commandApprovalPolicy:
              sessionState.foreground.commandApprovalPolicy,
            approvalPolicy: sessionState.foreground.approvalPolicy,
            approvalReviewer: sessionState.foreground.approvalReviewer,
            executionPreset: sessionState.foreground.executionPreset,
            configuredCommandApprovalPolicy:
              sessionState.foreground.configuredCommandApprovalPolicy,
          }
        : null,
    };
  }

  getInstanceStatusSummary(): BrowserGatewayInstanceStatusSummary {
    const ui = this.getUiState();
    const session = this.getSessionState().foreground;

    if (session?.status === "error") {
      return {
        kind: "error",
        label: "Error",
        detail: session.statusOverride ?? session.status,
        sessionTitle: session.title,
      };
    }

    if (
      ui.approval ||
      ui.question ||
      ui.formElicitation ||
      ui.urlElicitation ||
      session?.questionRequest
    ) {
      return {
        kind: "awaiting_approval",
        label: ui.formElicitation
          ? "MCP Form"
          : ui.urlElicitation
            ? "MCP URL"
            : ui.question || session?.questionRequest
              ? "Question"
              : "Approval",
        detail: session?.statusOverride ?? "Awaiting response",
        sessionTitle: session?.title,
      };
    }

    if (
      session?.streaming ||
      session?.status === "streaming" ||
      session?.status === "tool_executing" ||
      session?.status === "awaiting_approval"
    ) {
      return {
        kind: "working",
        label:
          session.status === "tool_executing"
            ? "Tool running"
            : session.status === "awaiting_approval"
              ? "Waiting"
              : "Working",
        detail:
          session.statusOverride ??
          (session.status === "awaiting_approval"
            ? "Awaiting interaction details"
            : session.status),
        sessionTitle: session.title,
      };
    }

    return {
      kind: "idle",
      label: "Idle",
      detail: session?.statusOverride ?? session?.status,
      sessionTitle: session?.title,
    };
  }

  getSerializableSnapshotState(): BrowserGatewaySnapshotState {
    return {
      ui: this.getSerializableState(),
      session: this.getSerializableSessionState(),
      background: this.sessionManager.getBgSessionInfos(),
      diffs: diffSnapshotHub.list().map((diff) => ({
        requestId: diff.requestId,
        filePath: diff.filePath,
        operation: diff.operation,
        originalPreview: diff.originalContent.slice(0, 600),
        proposedPreview: diff.proposedContent.slice(0, 600),
        outsideWorkspace: diff.outsideWorkspace,
        createdAt: diff.createdAt,
      })),
      theme: this.getThemeSnapshot(),
      modelsVersion: this.modelsVersion,
    };
  }

  /**
   * Signal that provider model metadata changed so browser clients re-fetch
   * `/api/models`. Bumps the snapshot's `modelsVersion` and invalidates immediately.
   */
  bumpModelsVersion(): void {
    this.modelsVersion += 1;
    this.onDidChangeOwnerProjectionEmitter.fire("model_catalog");
    this.invalidateBrowserSnapshot({ immediate: true });
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
    this.cancelPendingForegroundInvalidation();
    this.clearInteractionState();
    this.seededForegroundSessionId = undefined;
    this.recentEvents = [];
    this.lastSerializedSnapshot = "";
    this.snapshotRevision = 0;
    this.onDidChangeEmitter.dispose();
    this.onDidChangeOwnerProjectionEmitter.dispose();
  }

  private captureOwnerProjectionReadSet(): BrowserGatewayOwnerProjectionReadSet {
    const snapshot = this.getSerializableSnapshotState();
    const foreground = snapshot.session.foreground;
    const interactionPayload = {
      approval: snapshot.ui.approval,
      question: snapshot.ui.question,
      questionProgress: snapshot.ui.questionProgress,
      formElicitation: snapshot.ui.formElicitation,
      urlElicitation: snapshot.ui.urlElicitation,
    };
    const interaction = snapshot.ui.approval
      ? {
          requestId: snapshot.ui.approval.id,
          kind: "approval" as const,
          payload: interactionPayload,
        }
      : snapshot.ui.question
        ? {
            requestId: snapshot.ui.question.id,
            kind: "question" as const,
            payload: interactionPayload,
            ...(snapshot.ui.question.backgroundTask
              ? { backgroundTask: snapshot.ui.question.backgroundTask }
              : {}),
            ...(snapshot.ui.questionProgress
              ? { step: snapshot.ui.questionProgress.step }
              : {}),
            totalSteps: snapshot.ui.question.questions.length,
          }
        : snapshot.ui.formElicitation
          ? {
              requestId: snapshot.ui.formElicitation.id,
              kind: "form" as const,
              payload: interactionPayload,
            }
          : snapshot.ui.urlElicitation
            ? {
                requestId: snapshot.ui.urlElicitation.id,
                kind: "url" as const,
                payload: interactionPayload,
              }
            : null;
    const background = snapshot.background.map((session) => ({
      sessionId: session.id,
      title: session.task,
      status: session.status,
      ...(session.lastActiveAt !== undefined
        ? { updatedAt: session.lastActiveAt }
        : {}),
    }));
    return {
      catalog: {
        projects: snapshot.session.projects,
        sessions: snapshot.session.sessions.map((session) => ({
          sessionId: session.id,
          projectId: session.project?.projectId ?? null,
          title: session.title,
          mode: session.mode,
          model: session.model,
          messageCount: session.messageCount,
          createdAt: session.createdAt,
          updatedAt: session.lastActiveAt,
        })),
        defaultProjectId: snapshot.session.defaultProjectId,
        foregroundSessionId: foreground?.sessionId ?? null,
        chatWorkspace: snapshot.session.chatWorkspace,
      },
      foreground: foreground
        ? {
            sessionId: foreground.sessionId,
            title: foreground.title,
            originalPrompt: foreground.originalPrompt,
            mode: foreground.mode,
            model: foreground.model,
            status: foreground.status,
            interactiveExecutionPhase: foreground.interactiveExecutionPhase,
            streaming: foreground.streaming,
            interrupted: foreground.interrupted,
            estimatedTokens: foreground.estimatedTotalUsed,
            statusOverride: foreground.statusOverride,
            thinkingEnabled: foreground.thinkingEnabled,
            reasoningEffort: foreground.reasoningEffort,
            lastInputTokens: foreground.lastInputTokens,
            lastOutputTokens: foreground.lastOutputTokens,
            lastCacheReadTokens: foreground.lastCacheReadTokens,
            contextBudget: foreground.contextBudget
              ? { ...foreground.contextBudget }
              : undefined,
            contextHealth: foreground.contextHealth
              ? {
                  memory: { ...foreground.contextHealth.memory },
                  retrieval: { ...foreground.contextHealth.retrieval },
                  index: { ...foreground.contextHealth.index },
                }
              : null,
            condenseThreshold: foreground.condenseThreshold,
            restoringSession: foreground.restoringSession,
            revertRecoveryNotice: foreground.revertRecoveryNotice
              ? { ...foreground.revertRecoveryNotice }
              : null,
            messages: foreground.projectedMessages,
            earlierCursor: null,
            hasEarlier: false,
            cursorBeforeMessage: (messageId) => {
              const index = foreground.projectedMessages.findIndex(
                (message) => message.id === messageId,
              );
              return `${foreground.sessionId}:${Math.max(0, index)}`;
            },
            queue: foreground.messageQueue,
            todos: foreground.todos,
          }
        : null,
      interaction,
      background,
      fleet: [],
      diffs: snapshot.diffs.map((diff) => ({
        requestId: diff.requestId,
        filePath: diff.filePath,
        operation: diff.operation,
        outsideWorkspace: diff.outsideWorkspace,
        createdAt: diff.createdAt,
      })),
      repository: snapshot.session.repository,
      theme: snapshot.theme,
      modelCatalogRevision: String(snapshot.modelsVersion),
      mcp: snapshot.ui.mcpStatusInfos.map((server) => ({
        name: server.name,
        status: server.status,
      })),
      policies: {
        agentWriteApproval: foreground?.agentWriteApproval ?? "prompt",
        commandApprovalPolicy: foreground?.commandApprovalPolicy ?? "safe",
        approvalPolicy: foreground?.approvalPolicy ?? "on-request",
        approvalReviewer: foreground?.approvalReviewer ?? "user",
        executionPreset: foreground?.executionPreset ?? "native-manual",
        configuredCommandApprovalPolicy:
          foreground?.configuredCommandApprovalPolicy ?? "safe",
      },
    };
  }

  private createChatWorkspaceSummary(
    sessionInfos: readonly SessionInfo[],
    projected?: ReturnType<
      ChatViewProvider["getBrowserProjectedForegroundState"]
    >,
  ): BrowserGatewayChatWorkspaceSummary | null {
    const workspace = this.getChatWorkspaceSnapshot();
    if (!workspace) return null;
    const sessionsById = new Map(
      sessionInfos.map((session) => [session.id, session]),
    );
    return {
      controllerEpoch: workspace.controllerEpoch,
      focusedTabId: workspace.focusedTabId,
      tabs: workspace.tabs.map((tab) => {
        const session = tab.sessionId
          ? sessionsById.get(tab.sessionId)
          : undefined;
        const projectedMatches = projected?.sessionId === tab.sessionId;
        return {
          ...tab,
          needsAttention:
            tab.status === "needs_input" || tab.status === "failed",
          ...(session?.mode ? { mode: session.mode } : {}),
          ...(session?.model ? { model: session.model } : {}),
          ...(session?.interactiveExecutionPhase
            ? {
                interactiveExecutionPhase: session.interactiveExecutionPhase,
              }
            : {}),
          ...(projectedMatches
            ? {
                estimatedTokens: projected.estimatedTotalUsed,
                ...(projected.contextBudget?.contextWindow !== undefined
                  ? { maximumTokens: projected.contextBudget.contextWindow }
                  : {}),
              }
            : {}),
        };
      }),
    };
  }

  private getForegroundQuestion(): BrowserGatewayUiState["question"] {
    const foreground = this.sessionManager.getForegroundSession();
    const projected = this.getProjectedForegroundState();
    if (foreground && projected?.sessionId === foreground.id) {
      const foregroundQuestion = projected.questionRequest;
      if (foregroundQuestion) {
        return {
          id: foregroundQuestion.id,
          ...(foregroundQuestion.toolCallId
            ? { toolCallId: foregroundQuestion.toolCallId }
            : {}),
          context: foregroundQuestion.context,
          questions: foregroundQuestion.questions.map((question) => ({
            ...question,
          })),
          ...(foregroundQuestion.backgroundTask
            ? { backgroundTask: foregroundQuestion.backgroundTask }
            : {}),
        };
      }
    }

    if (this.question?.backgroundTask) {
      return {
        id: this.question.id,
        context: this.question.context,
        questions: this.question.questions.map((question) => ({ ...question })),
        backgroundTask: this.question.backgroundTask,
      };
    }

    return undefined;
  }

  private getForegroundQuestionProgress(
    questionId: string | undefined,
  ): QuestionProgressState | undefined {
    // Progress is broadcast through the UI event hub, while the visible question
    // may come from the foreground projection. Both paths use the same request id.
    if (!questionId || this.questionProgress?.id !== questionId) {
      return undefined;
    }
    return {
      ...this.questionProgress,
      answers: { ...this.questionProgress.answers },
      notes: { ...this.questionProgress.notes },
    };
  }

  private getRepositoryInfo(): BrowserGatewayRepositoryInfo | null {
    const now = Date.now();
    if (this.repositoryInfoCache && this.repositoryInfoCache.expiresAt > now) {
      return this.repositoryInfoCache.value;
    }

    const value = this.getRepositoryInfoProvider();
    this.repositoryInfoCache = {
      value,
      expiresAt: now + REPOSITORY_INFO_CACHE_MS,
    };
    return value;
  }

  private seedForegroundUiState(): void {
    const sessionId = this.sessionManager.getForegroundSession()?.id;
    if (sessionId === this.seededForegroundSessionId) return;
    this.seededForegroundSessionId = sessionId;
    const visibleBackgroundApproval = this.approval?.backgroundTask
      ? this.approval
      : undefined;
    const visibleBackgroundApprovalSessionId = visibleBackgroundApproval
      ? this.approvalSessionId
      : undefined;
    this.clearInteractionState();
    this.approval = visibleBackgroundApproval;
    this.approvalSessionId = visibleBackgroundApprovalSessionId;
    if (!sessionId) return;
    for (const event of this.uiEventHub.getSnapshot(sessionId)) {
      if (visibleBackgroundApproval && event.event.type === "showApproval") {
        continue;
      }
      this.applyEvent(event, false);
    }
  }

  private clearInteractionState(): void {
    this.approval = undefined;
    this.approvalSessionId = undefined;
    this.question = undefined;
    this.questionSessionId = undefined;
    this.questionProgress = undefined;
    this.formElicitation = undefined;
    this.formElicitationSessionId = undefined;
    this.urlElicitation = undefined;
    this.urlElicitationSessionId = undefined;
  }

  private applyEvent(envelope: SessionUiEvent, recordRecent = true): void {
    const { sessionId, event } = envelope;
    const selectedSessionId = this.sessionManager.getForegroundSession()?.id;
    const isSelectedSession = sessionId === selectedSessionId;
    const isAttributedBackgroundRequest =
      (event.type === "showApproval" &&
        Boolean(event.request.backgroundTask)) ||
      (event.type === "agentQuestionRequest" && Boolean(event.backgroundTask));
    // Only approvals and questions can be Fleet-attributed background work.
    // Form and URL elicitations remain selected-session-only and are restored
    // from that session's snapshot when it becomes foreground.
    const matchesVisibleBackgroundInteraction =
      (event.type === "idle" && this.approvalSessionId === sessionId) ||
      ((event.type === "agentQuestionCleared" ||
        event.type === "agentQuestionProgress") &&
        this.questionSessionId === sessionId &&
        Boolean(this.question?.backgroundTask));
    if (
      !isSelectedSession &&
      !isAttributedBackgroundRequest &&
      !matchesVisibleBackgroundInteraction
    ) {
      return;
    }

    switch (event.type) {
      case "showApproval":
        this.approval = event.request;
        this.approvalSessionId = sessionId;
        break;
      case "idle":
        if (
          this.approvalSessionId === sessionId &&
          this.approval?.id === event.id
        ) {
          const clearedBackgroundApproval = Boolean(
            this.approval.backgroundTask,
          );
          this.approval = undefined;
          this.approvalSessionId = undefined;
          if (clearedBackgroundApproval && selectedSessionId) {
            for (const selectedEvent of this.uiEventHub.getSnapshot(
              selectedSessionId,
            )) {
              if (selectedEvent.event.type === "showApproval") {
                this.applyEvent(selectedEvent, false);
              }
            }
          }
        }
        break;
      case "agentQuestionRequest":
        this.question = {
          id: event.id,
          ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
          context: event.context,
          questions: event.questions,
          ...(event.backgroundTask
            ? { backgroundTask: event.backgroundTask }
            : {}),
        };
        this.questionSessionId = sessionId;
        this.questionProgress = undefined;
        break;
      case "agentQuestionCleared": {
        const matchesQuestion =
          this.questionSessionId === sessionId &&
          this.question?.id === event.id;
        if (matchesQuestion) {
          this.question = undefined;
          this.questionProgress = undefined;
          this.questionSessionId = undefined;
        }
        break;
      }
      case "agentQuestionProgress":
        if (
          this.questionSessionId === sessionId &&
          this.question?.id === event.id
        ) {
          this.questionProgress = {
            id: event.id,
            step: event.step,
            answers: { ...event.answers },
            notes: { ...event.notes },
            origin: event.origin,
          };
        }
        break;
      case "agentFormElicitationRequest":
        this.formElicitation = cloneFormElicitationRequest(event.request);
        this.formElicitationSessionId = sessionId;
        break;
      case "agentFormElicitationCleared":
        if (
          this.formElicitationSessionId === sessionId &&
          this.formElicitation?.id === event.id
        ) {
          this.formElicitation = undefined;
          this.formElicitationSessionId = undefined;
        }
        break;
      case "agentUrlElicitationRequest":
        this.urlElicitation = { ...event.request };
        this.urlElicitationSessionId = sessionId;
        break;
      case "agentUrlElicitationCleared":
        if (
          this.urlElicitationSessionId === sessionId &&
          this.urlElicitation?.id === event.id
        ) {
          this.urlElicitation = undefined;
          this.urlElicitationSessionId = undefined;
        }
        break;
    }

    if (!recordRecent) return;
    this.recentEvents.push(event);
    if (this.recentEvents.length > this.maxRecentEvents) {
      this.recentEvents.splice(
        0,
        this.recentEvents.length - this.maxRecentEvents,
      );
    }
    this.invalidateBrowserSnapshot({ immediate: true });
  }

  createSnapshotPublication(): BrowserGatewaySnapshotPublication {
    const snapshotStartedAt = this.streamingMetrics.enabled
      ? performance.now()
      : 0;
    const snapshot = this.getSerializableSnapshotState();
    this.recordSnapshotBuild(snapshot, snapshotStartedAt);
    const serializationStartedAt = this.streamingMetrics.enabled
      ? performance.now()
      : 0;
    const serialized = JSON.stringify(snapshot);
    const bytes = this.recordSerialization(serialized, serializationStartedAt);
    this.lastSerializedSnapshot = serialized;
    return this.createPublication(snapshot, serialized, bytes);
  }

  private cancelPendingForegroundInvalidation(): void {
    this.foregroundInvalidationGeneration += 1;
    this.foregroundInvalidationPublishWithoutClients = false;
    if (!this.foregroundInvalidationTimer) return;
    this.cancelTimeout(this.foregroundInvalidationTimer);
    this.foregroundInvalidationTimer = undefined;
  }

  private scheduleTimeout(
    callback: () => void,
    timeoutMs: number,
  ): ReturnType<typeof setTimeout> {
    return (this.timers.setTimeout ?? setTimeout)(callback, timeoutMs);
  }

  private cancelTimeout(timer: ReturnType<typeof setTimeout>): void {
    (this.timers.clearTimeout ?? clearTimeout)(timer);
  }

  private emitSnapshotIfChanged(publishWithoutClients = false): void {
    // No browser client connected → skip the snapshot build and serialization.
    // The server creates a fresh snapshot for each client on connect. Theme changes
    // bypass this gate while the server persists its shared theme cache.
    if (
      !publishWithoutClients &&
      this.hasActiveClientsProbe &&
      !this.hasActiveClientsProbe()
    ) {
      return;
    }
    const snapshotStartedAt = this.streamingMetrics.enabled
      ? performance.now()
      : 0;
    const snapshot = this.getSerializableSnapshotState();
    this.recordSnapshotBuild(snapshot, snapshotStartedAt);
    const serializationStartedAt = this.streamingMetrics.enabled
      ? performance.now()
      : 0;
    const serialized = JSON.stringify(snapshot);
    const bytes = this.recordSerialization(serialized, serializationStartedAt);
    if (serialized === this.lastSerializedSnapshot) {
      return;
    }
    this.lastSerializedSnapshot = serialized;
    this.onDidChangeEmitter.fire(
      this.createPublication(snapshot, serialized, bytes),
    );
  }

  private recordSnapshotBuild(
    snapshot: BrowserGatewaySnapshotState,
    startedAt: number,
  ): void {
    if (!this.streamingMetrics.enabled) return;
    this.streamingMetrics.record({
      type: "snapshot_build",
      surface: "vscode-gateway",
      durationMs: performance.now() - startedAt,
      messageCount: snapshot.session.foreground?.projectedMessages.length ?? 0,
    });
  }

  private createPublication(
    snapshot: BrowserGatewaySnapshotState,
    serialized: string,
    bytes: number,
  ): BrowserGatewaySnapshotPublication {
    this.snapshotRevision += 1;
    return {
      revision: this.snapshotRevision,
      snapshot,
      serialized,
      bytes,
    };
  }

  private recordSerialization(serialized: string, startedAt: number): number {
    const bytes = utf8ByteLength(serialized);
    if (this.streamingMetrics.enabled) {
      this.streamingMetrics.record({
        type: "serialization",
        surface: "vscode-gateway",
        durationMs: performance.now() - startedAt,
        bytes,
      });
    }
    return bytes;
  }
}

function createDetachedSessionUiState(
  events: readonly SessionUiEvent[],
): BrowserGatewayDetachedSessionUiState {
  const state: BrowserGatewayDetachedSessionUiState = {
    approval: null,
    question: null,
    questionProgress: null,
    formElicitation: null,
    urlElicitation: null,
  };

  for (const { event } of events) {
    switch (event.type) {
      case "showApproval":
        state.approval = structuredClone(event.request);
        break;
      case "agentQuestionRequest":
        state.question = {
          id: event.id,
          ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
          context: event.context,
          questions: structuredClone(event.questions),
          ...(event.backgroundTask
            ? { backgroundTask: event.backgroundTask }
            : {}),
        };
        break;
      case "agentQuestionProgress":
        if (state.question?.id === event.id) {
          state.questionProgress = {
            id: event.id,
            step: event.step,
            answers: structuredClone(event.answers),
            notes: { ...event.notes },
            origin: event.origin,
          };
        }
        break;
      case "agentFormElicitationRequest":
        state.formElicitation = cloneFormElicitationRequest(event.request);
        break;
      case "agentUrlElicitationRequest":
        state.urlElicitation = { ...event.request };
        break;
      case "idle":
      case "agentQuestionCleared":
      case "agentFormElicitationCleared":
      case "agentUrlElicitationCleared":
        break;
    }
  }

  return state;
}

function cloneFormElicitationRequest(
  request: McpFormElicitationRequest,
): McpFormElicitationRequest {
  return {
    ...request,
    fields: request.fields.map((field) => {
      if (field.kind === "single-select") {
        return {
          ...field,
          options: field.options.map((option) => ({ ...option })),
        };
      }
      if (field.kind === "multi-select") {
        return {
          ...field,
          options: field.options.map((option) => ({ ...option })),
          ...(field.default ? { default: [...field.default] } : {}),
        };
      }
      return { ...field };
    }),
  };
}
