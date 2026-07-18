import * as vscode from "vscode";

import type { AgentSessionManager } from "../agent/AgentSessionManager.js";
import type { AgentMessage } from "../agent/types.js";

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
import type { McpUrlElicitationRequest } from "../shared/mcpUrlElicitation.js";
import type {
  AgentUiEvent,
  ReadableAgentUiEventHub,
} from "../agent/AgentUiPublisher.js";

import type { ApprovalRequest } from "../approvals/webview/types.js";
import type { CommandApprovalPolicy } from "../approvals/commandApprovalPolicy.js";

import {
  diffSnapshotHub,
  type DiffSnapshotPreview,
} from "./DiffSnapshotHub.js";
import type { BrowserGatewayRepositoryInfo } from "./BrowserGatewayRepositoryObserver.js";

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
        context: string;
        questions: Question[];
        backgroundTask?: string;
      }
    | undefined;
  questionProgress: QuestionProgressState | undefined;
  urlElicitation: McpUrlElicitationRequest | undefined;
  recentEvents: AgentUiEvent[];
}

export interface BrowserGatewayWireState {
  approval: ApprovalRequest | null;
  question: {
    id: string;
    context: string;
    questions: Question[];
    backgroundTask?: string;
  } | null;
  questionProgress: QuestionProgressState | null;
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
  repository: BrowserGatewayRepositoryInfo | null;
  foreground:
    | {
        sessionId: string;
        project: BrowserGatewayProjectInfo;
        title: string;
        mode: string;
        model: string;
        status: string;
        streaming: boolean;
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
        condenseThreshold?: number;
        commandApprovalPolicy: CommandApprovalPolicy;
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
  repository: BrowserGatewayRepositoryInfo | null;
  foreground: {
    sessionId: string;
    project: BrowserGatewayProjectInfo;
    title: string;
    mode: string;
    model: string;
    status: string;
    streaming: boolean;
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
    condenseThreshold?: number;
    agentWriteApproval: "prompt" | "session" | "project" | "global";
    commandApprovalPolicy: CommandApprovalPolicy;
    configuredCommandApprovalPolicy: Exclude<
      CommandApprovalPolicy,
      "approve-for-me"
    >;
  } | null;
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
  private question:
    | {
        id: string;
        context: string;
        questions: Question[];
        backgroundTask?: string;
      }
    | undefined;
  private questionProgress: QuestionProgressState | undefined;
  private urlElicitation: McpUrlElicitationRequest | undefined;
  private recentEvents: AgentUiEvent[] = [];
  private modelsVersion = 0;
  private repositoryInfoCache:
    | { value: BrowserGatewayRepositoryInfo | null; expiresAt: number }
    | undefined;
  private getRepositoryInfoProvider: () => BrowserGatewayRepositoryInfo | null =
    () => null;
  private getCommandApprovalPolicy: () => CommandApprovalPolicy = () => "safe";
  private getConfiguredCommandApprovalPolicy: () => Exclude<
    CommandApprovalPolicy,
    "approve-for-me"
  > = () => "safe";

  readonly onDidChange = this.onDidChangeEmitter.event;

  /**
   * Register a probe used to skip explicit snapshot work when no browser client
   * is connected. The gateway server wires this to its active SSE client set.
   */
  setHasActiveClientsProbe(probe: (() => boolean) | undefined): void {
    this.hasActiveClientsProbe = probe;
  }

  constructor(
    uiEventHub: ReadableAgentUiEventHub,
    private readonly sessionManager: AgentSessionManager,
    private readonly getThemeSnapshot: () => BrowserGatewayThemeSnapshot,
    private readonly getAgentWriteApprovalState: () => ReturnType<
      ChatViewProvider["getBrowserAgentWriteApprovalState"]
    >,
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
    const snapshot = uiEventHub.getSnapshot();
    if (snapshot) {
      this.applyEvent(snapshot);
    }

    this.disposables.push(
      uiEventHub.onDidPublish((event) => {
        this.applyEvent(event);
      }),
      diffSnapshotHub.onDidChange(() => {
        this.invalidateBrowserSnapshot({ immediate: true });
      }),
    );
  }

  getCurrentThemeSnapshot(): BrowserGatewayThemeSnapshot {
    return this.getThemeSnapshot();
  }

  setRepositoryInfoProvider(
    getRepositoryInfo: () => BrowserGatewayRepositoryInfo | null,
  ): void {
    this.getRepositoryInfoProvider = getRepositoryInfo;
    this.repositoryInfoCache = undefined;
  }

  subscribeToRepositoryChanges(
    onDidChangeRepository: (listener: () => void) => { dispose(): void },
  ): void {
    this.disposables.push(
      onDidChangeRepository(() => {
        this.repositoryInfoCache = undefined;
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
    getConfigured: () => ReturnType<
      ChatViewProvider["getConfiguredCommandApprovalPolicy"]
    >,
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
        this.invalidateBrowserSnapshot();
      }),
    );
  }

  subscribeToSessionChanges(
    onDidChangeSessions: (listener: () => void) => { dispose(): void },
  ): void {
    this.disposables.push(
      onDidChangeSessions(() => {
        this.invalidateBrowserSnapshot();
      }),
    );
  }

  subscribeToSurfaceChanges(
    onDidChangeSurface: (listener: (kind: "mcp" | "theme") => void) => {
      dispose(): void;
    },
  ): void {
    this.disposables.push(
      onDidChangeSurface((kind) => {
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

    const projectionStartedAt = this.streamingMetrics.enabled
      ? performance.now()
      : 0;
    const projectedMessages = projectedMatchesForeground
      ? projected.projectedMessages
      : agentMessagesToChatMessages(persistedMessages);
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
    return {
      projects,
      defaultProjectId,
      sessions,
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
        mode: projectedMatchesForeground ? projected.mode : foreground.mode,
        model: projectedMatchesForeground ? projected.model : foreground.model,
        status: foreground.status,
        streaming: projectedMatchesForeground
          ? projected.streaming
          : foreground.status === "streaming" ||
            foreground.status === "tool_executing" ||
            foreground.status === "awaiting_approval",
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
        condenseThreshold: projectedMatchesForeground
          ? projected.condenseThreshold
          : undefined,
        commandApprovalPolicy: this.getCommandApprovalPolicy(),
        configuredCommandApprovalPolicy:
          this.getConfiguredCommandApprovalPolicy(),
      },
    };
  }

  getSerializableState(): BrowserGatewayWireState {
    const question = this.getForegroundQuestion();
    return {
      approval: this.approval ?? null,
      question: question ?? null,
      questionProgress:
        this.getForegroundQuestionProgress(question?.id) ?? null,
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
      repository: sessionState.repository,
      foreground: sessionState.foreground
        ? {
            sessionId: sessionState.foreground.sessionId,
            project: sessionState.foreground.project,
            title: sessionState.foreground.title,
            mode: sessionState.foreground.mode,
            model: sessionState.foreground.model,
            status: sessionState.foreground.status,
            streaming: sessionState.foreground.streaming,
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
            condenseThreshold: sessionState.foreground.condenseThreshold,
            agentWriteApproval: this.getAgentWriteApprovalState(),
            commandApprovalPolicy:
              sessionState.foreground.commandApprovalPolicy,
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
      ui.urlElicitation ||
      session?.questionRequest ||
      session?.status === "awaiting_approval"
    ) {
      return {
        kind: "awaiting_approval",
        label: ui.urlElicitation
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
      session?.status === "tool_executing"
    ) {
      return {
        kind: "working",
        label: session.status === "tool_executing" ? "Tool running" : "Working",
        detail: session.statusOverride ?? session.status,
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
    this.invalidateBrowserSnapshot({ immediate: true });
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
    this.cancelPendingForegroundInvalidation();
    this.approval = undefined;
    this.question = undefined;
    this.questionProgress = undefined;
    this.urlElicitation = undefined;
    this.recentEvents = [];
    this.lastSerializedSnapshot = "";
    this.snapshotRevision = 0;
    this.onDidChangeEmitter.dispose();
  }

  private getForegroundQuestion(): BrowserGatewayUiState["question"] {
    const foreground = this.sessionManager.getForegroundSession();
    const projected = this.getProjectedForegroundState();
    if (foreground && projected?.sessionId === foreground.id) {
      const foregroundQuestion = projected.questionRequest;
      if (foregroundQuestion) {
        return {
          id: foregroundQuestion.id,
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
    return { ...this.questionProgress };
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

  private applyEvent(event: AgentUiEvent): void {
    switch (event.type) {
      case "showApproval":
        this.approval = event.request;
        break;
      case "idle":
        this.approval = undefined;
        break;
      case "agentQuestionRequest":
        this.question = {
          id: event.id,
          context: event.context,
          questions: event.questions,
          ...(event.backgroundTask
            ? { backgroundTask: event.backgroundTask }
            : {}),
        };
        this.questionProgress = undefined;
        break;
      case "agentQuestionCleared":
        if (!this.question || this.question.id === event.id) {
          this.question = undefined;
        }
        if (!this.questionProgress || this.questionProgress.id === event.id) {
          this.questionProgress = undefined;
        }
        break;
      case "agentQuestionProgress":
        this.questionProgress = {
          id: event.id,
          step: event.step,
          answers: { ...event.answers },
          notes: { ...event.notes },
          origin: event.origin,
        };
        break;
      case "agentUrlElicitationRequest":
        this.urlElicitation = { ...event.request };
        break;
      case "agentUrlElicitationCleared":
        if (!this.urlElicitation || this.urlElicitation.id === event.id) {
          this.urlElicitation = undefined;
        }
        break;
    }

    this.recentEvents = [...this.recentEvents, event].slice(
      -this.maxRecentEvents,
    );
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
