import * as vscode from "vscode";

import { getTerminalManager } from "../integrations/TerminalManager.js";

import type { AgentSessionManager } from "../agent/AgentSessionManager.js";
import type { SessionSummary } from "../agent/SessionStore.js";
import type { AgentMessage } from "../agent/types.js";
import type {
  ChatMessage,
  ChatState,
  Question,
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
import type { ChatViewProvider } from "../agent/ChatViewProvider.js";
import type { BrowserGatewayInstanceStatusSummary } from "./protocol.js";
import type {
  AgentUiEvent,
  ReadableAgentUiEventHub,
} from "../agent/AgentUiPublisher.js";

import type { ApprovalRequest } from "../approvals/webview/types.js";

import {
  diffSnapshotHub,
  type DiffSnapshotPreview,
} from "./DiffSnapshotHub.js";

const REPOSITORY_INFO_CACHE_MS = 1_000;

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
        questions: Question[];
      }
    | undefined;
  questionProgress: QuestionProgressState | undefined;
  recentEvents: AgentUiEvent[];
}

export interface BrowserGatewayWireState {
  approval: ApprovalRequest | null;
  question: {
    id: string;
    questions: Question[];
  } | null;
  questionProgress: QuestionProgressState | null;
  recentEvents: AgentUiEvent[];
  mcpStatusInfos: ReturnType<ChatViewProvider["getBrowserMcpStatusInfos"]>;
}

export interface BrowserGatewayTerminalInfo {
  id: string;
  name: string;
  busy: boolean;
  stale?: boolean;
}

export interface BrowserGatewayRepositoryInfo {
  branch?: string;
  dirty?: boolean;
}

export interface BrowserGatewaySessionState {
  sessions: SessionSummary[];
  terminals: BrowserGatewayTerminalInfo[];
  repository: BrowserGatewayRepositoryInfo | null;
  foreground:
    | {
        sessionId: string;
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
        questionRequest: { id: string; questions: Question[] } | null;
        detectedQuestion: AppState["detectedQuestion"];
        todos: TodoItem[];
        debugInfo: AppState["debugInfo"];
        systemPrompt: AppState["systemPrompt"];
        loadedInstructions: AppState["loadedInstructions"];
        restoringSession: AppState["restoringSession"];
        contextBudget?: ChatState["contextBudget"];
        condenseThreshold?: number;
      }
    | undefined;
}

export interface BrowserGatewayWireSessionState {
  sessions: SessionSummary[];
  terminals: BrowserGatewayTerminalInfo[];
  repository: BrowserGatewayRepositoryInfo | null;
  foreground: {
    sessionId: string;
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
    questionRequest: { id: string; questions: Question[] } | null;
    detectedQuestion: AppState["detectedQuestion"];
    todos: TodoItem[];
    debugInfo: AppState["debugInfo"];
    systemPrompt: AppState["systemPrompt"];
    loadedInstructions: AppState["loadedInstructions"];
    restoringSession: AppState["restoringSession"];
    contextBudget?: ChatState["contextBudget"];
    condenseThreshold?: number;
    agentWriteApproval: "prompt" | "session" | "project" | "global";
  } | null;
}

export interface BrowserGatewaySnapshotState {
  ui: BrowserGatewayWireState;
  session: BrowserGatewayWireSessionState;
  background: BgSessionInfo[];
  diffs: DiffSnapshotPreview[];
  theme: BrowserGatewayThemeSnapshot;
}

function listBrowserGatewayTerminals(): BrowserGatewayTerminalInfo[] {
  try {
    return getTerminalManager().listTerminals();
  } catch {
    return [];
  }
}

function isSameOrNestedPath(pathValue: string, candidateRoot: string): boolean {
  const normalizedPath = pathValue.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedRoot = candidateRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  return (
    normalizedPath === normalizedRoot ||
    normalizedPath.startsWith(`${normalizedRoot}/`)
  );
}

function getBrowserGatewayRepositoryInfo(): BrowserGatewayRepositoryInfo | null {
  try {
    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspacePath) return null;

    const gitExtension = vscode.extensions.getExtension("vscode.git")
      ?.exports as
      | { getAPI(version: 1): { repositories: unknown[] } }
      | undefined;
    const gitApi = gitExtension?.getAPI(1);
    if (!gitApi) return null;

    const repositories = gitApi.repositories as Array<{
      rootUri?: { fsPath?: string };
      state?: {
        HEAD?: { name?: string; commit?: string };
        workingTreeChanges?: unknown[];
        indexChanges?: unknown[];
        mergeChanges?: unknown[];
      };
    }>;
    const repository =
      repositories.find((candidate) => {
        const rootPath = candidate.rootUri?.fsPath;
        return rootPath ? isSameOrNestedPath(workspacePath, rootPath) : false;
      }) ?? repositories[0];
    const state = repository?.state;
    if (!state) return null;

    const branch = state.HEAD?.name || state.HEAD?.commit?.slice(0, 8);
    const dirty = Boolean(
      state.workingTreeChanges?.length ||
      state.indexChanges?.length ||
      state.mergeChanges?.length,
    );

    return { ...(branch && { branch }), dirty };
  } catch {
    return null;
  }
}

export class BrowserGatewayService implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly onDidChangeEmitter =
    new vscode.EventEmitter<BrowserGatewaySnapshotState>();
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private lastSerializedSnapshot = "";
  private approval: ApprovalRequest | undefined;
  private question:
    | {
        id: string;
        questions: Question[];
      }
    | undefined;
  private questionProgress: QuestionProgressState | undefined;
  private recentEvents: AgentUiEvent[] = [];
  private repositoryInfoCache:
    | { value: BrowserGatewayRepositoryInfo | null; expiresAt: number }
    | undefined;

  readonly onDidChange = this.onDidChangeEmitter.event;

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
        this.emitSnapshot();
      }),
    );

    // Session and background transcript/state changes are not yet published
    // through a dedicated browser event bus, so poll the current snapshot and
    // emit only when the serialized browser-facing state changes.
    this.pollTimer = setInterval(() => {
      this.emitSnapshotIfChanged();
    }, 150);
  }

  getCurrentThemeSnapshot(): BrowserGatewayThemeSnapshot {
    return this.getThemeSnapshot();
  }

  getUiState(): BrowserGatewayUiState {
    return {
      approval: this.approval,
      question: this.question
        ? {
            id: this.question.id,
            questions: this.question.questions,
          }
        : undefined,
      questionProgress: this.questionProgress
        ? { ...this.questionProgress }
        : undefined,
      recentEvents: [...this.recentEvents],
    };
  }

  getSessionState(): BrowserGatewaySessionState {
    const sessions = this.sessionManager.listPersistedSessions();
    const foreground = this.sessionManager.getForegroundSession();
    if (!foreground) {
      return {
        sessions,
        terminals: listBrowserGatewayTerminals(),
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

    const projectedMessages = projectedMatchesForeground
      ? projected.projectedMessages
      : agentMessagesToChatMessages(persistedMessages);

    return {
      sessions,
      terminals: listBrowserGatewayTerminals(),
      repository: this.getRepositoryInfo(),
      foreground: {
        sessionId: foreground.id,
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
        contextBudget: projectedMatchesForeground
          ? projected.contextBudget
          : undefined,
        condenseThreshold: projectedMatchesForeground
          ? projected.condenseThreshold
          : undefined,
      },
    };
  }

  getSerializableState(): BrowserGatewayWireState {
    return {
      approval: this.approval ?? null,
      question: this.question
        ? {
            id: this.question.id,
            questions: this.question.questions,
          }
        : null,
      questionProgress: this.questionProgress
        ? { ...this.questionProgress }
        : null,
      recentEvents: [...this.recentEvents],
      mcpStatusInfos: this.getMcpStatusInfos(),
    };
  }

  getSerializableSessionState(): BrowserGatewayWireSessionState {
    const sessionState = this.getSessionState();
    // TODO: This wire shape is intentionally simple but unbounded. Before we
    // build a richer browser UI, consider projecting AgentMessage[] into a
    // lighter transcript format or throttling/session-delta updates so SSE does
    // not resend large tool/image payloads on every change.
    return {
      sessions: sessionState.sessions,
      terminals: sessionState.terminals,
      repository: sessionState.repository,
      foreground: sessionState.foreground
        ? {
            sessionId: sessionState.foreground.sessionId,
            title: sessionState.foreground.title,
            mode: sessionState.foreground.mode,
            model: sessionState.foreground.model,
            status: sessionState.foreground.status,
            streaming: sessionState.foreground.streaming,
            messages: sessionState.foreground.messages,
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
            contextBudget: sessionState.foreground.contextBudget,
            condenseThreshold: sessionState.foreground.condenseThreshold,
            agentWriteApproval: this.getAgentWriteApprovalState(),
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
      session?.questionRequest ||
      session?.status === "awaiting_approval"
    ) {
      return {
        kind: "awaiting_approval",
        label:
          ui.question || session?.questionRequest ? "Question" : "Approval",
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
    };
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    this.approval = undefined;
    this.question = undefined;
    this.questionProgress = undefined;
    this.recentEvents = [];
    this.lastSerializedSnapshot = "";
    this.onDidChangeEmitter.dispose();
  }

  private getRepositoryInfo(): BrowserGatewayRepositoryInfo | null {
    const now = Date.now();
    if (this.repositoryInfoCache && this.repositoryInfoCache.expiresAt > now) {
      return this.repositoryInfoCache.value;
    }

    const value = getBrowserGatewayRepositoryInfo();
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
        this.question = undefined;
        this.questionProgress = undefined;
        break;
      case "agentQuestionRequest":
        this.question = {
          id: event.id,
          questions: event.questions,
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
    }

    this.recentEvents = [...this.recentEvents, event].slice(
      -this.maxRecentEvents,
    );
    this.emitSnapshot();
  }

  private emitSnapshot(): void {
    const snapshot = this.getSerializableSnapshotState();
    this.lastSerializedSnapshot = JSON.stringify(snapshot);
    this.onDidChangeEmitter.fire(snapshot);
  }

  private emitSnapshotIfChanged(): void {
    const snapshot = this.getSerializableSnapshotState();
    const serialized = JSON.stringify(snapshot);
    if (serialized === this.lastSerializedSnapshot) {
      return;
    }
    this.lastSerializedSnapshot = serialized;
    this.onDidChangeEmitter.fire(snapshot);
  }
}
