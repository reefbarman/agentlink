import * as crypto from "crypto";
import * as nodePath from "path";
import { fileURLToPath, pathToFileURL } from "url";

import type { AgentConfig, AgentMessage, SessionInfo } from "./types.js";
import type {
  AgentToolRuntime,
  PendingQuestionRecoveryContext,
} from "../core/tools/types.js";
import {
  normalizeCoreWebAccessSettings,
  resolveCoreWebAccessPolicy,
  type CoreResolvedWebAccessPolicy,
} from "../core/webAccess.js";
import {
  buildNativeWebDelegationPrompt,
  collectNativeWebToolResult,
  continueNativeWebProviderStream,
} from "../core/nativeWebTools.js";
import { runWatchedProviderStream } from "../core/providerStreamWatchdog.js";
import type {
  BackgroundAgentBudgetUsage,
  BackgroundAgentResultContent,
  BackgroundAgentRuntimePhase,
  BackgroundResultState,
} from "../core/capabilities/background.js";
import type { NativeWebToolExecutionRequest } from "../core/capabilities/web.js";
import type {
  PendingQuestionRecoveryState,
  PersistedFleetMetadata,
  PersistResult,
  PersistedSessionRecord,
  PersistenceRevision,
  RevertRecoveryState,
} from "./persistenceContracts.js";
import { hasPendingTodos, todoTool, type TodoItem } from "./todoTool.js";
import {
  createCommandReviewTurnCircuit,
  createRetainedCommandReviewDenials,
} from "../approvals/commandApprovalReview.js";
import { AgentSession } from "./AgentSession.js";
import type { WorkspaceFolderInfo } from "./systemPrompt.js";
import { AgentEngine } from "./AgentEngine.js";
import type { AgentEvent } from "./types.js";
import { resolveMode, type AgentMode } from "./modes.js";
import { ProjectCustomizationRegistry } from "./ProjectCustomizationRegistry.js";
import type { ProjectMcpHubRegistry } from "./ProjectMcpHubRegistry.js";
import type {
  ContentBlock,
  ImageBlock,
  ReasoningEffort,
} from "./providers/types.js";
import type { Question } from "./webview/types.js";
import {
  buildAskUserToolResult,
  getAgentTools,
  type ToolDispatchContext,
  type BgStatusResult,
  type QuestionResponse,
} from "./toolAdapter.js";
import type { SessionStore, SessionSummary } from "./SessionStore.js";
import type { BgSessionInfo } from "../shared/types.js";
import type { Checkpoint, RevertPreview } from "./CheckpointManager.js";
import type {
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionUpdate,
  ToolKind,
} from "@agentclientprotocol/sdk" with { "resolution-mode": "import" };
import { normalizeBackgroundAgentSettings } from "./background/acpAgentConfig.js";
import { resolveBackgroundBackendRoute } from "./background/backgroundBackendRouter.js";
import { resolveBackgroundRoute } from "./backgroundModelRouter.js";
import { parseMcpToolName } from "./mcpToolNames.js";
import {
  partitionMcpToolsForDisclosure,
  type McpToolDisclosurePartition,
} from "./mcpToolDisclosure.js";
import { CODEX_CONDENSE_MODEL_FALLBACKS } from "../core/model/providers/codex/models.js";
import { getEffectiveAutoCondenseThreshold } from "./modelCondenseThresholds.js";
import {
  callOpenAiCompatibleChat,
  getOpenAiCompatibleEndpoint,
} from "./openaiCompatibleClient.js";

import { summarizeTextForPreview } from "../shared/textSummary.js";
import {
  applyMemoryCandidateNudge,
  countMemoryNudges,
} from "../shared/memoryCandidates.js";
import type {
  SpawnBackgroundRequest,
  SpawnBackgroundResult,
} from "./backgroundTypes.js";
import {
  createDefaultAgentSessionManagerHost,
  mergeAgentSessionManagerHost,
  type ActivityTraceRecorderLike,
  type AgentSessionManagerHost,
  type AgentSessionManagerOptions,
  type CheckpointManagerLike,
} from "./AgentSessionManagerHost.js";
import { FleetAdmissionError, FleetScheduler } from "./FleetScheduler.js";
import {
  createSessionProjectScope,
  createWorkspaceProjectId,
  type ProjectScopeResolver,
  type SessionProjectResolution,
  type SessionProjectScope,
  type WorkspaceProject,
} from "../core/workspaceProjects.js";
import { selectNewSessionProject } from "../adapters/vscode/workspaceProjectCapabilities.js";
import {
  inferBackgroundDisplayStatus,
  pickBackgroundDisplayStatus,
} from "./backgroundDisplayStatus.js";
import { BackgroundSummaryScheduler } from "./BackgroundSummaryScheduler.js";
import { captureReviewScope } from "./reviewScopeSnapshot.js";
import {
  formatFleetResultEnvelope,
  parseFleetResultEnvelope,
  planFleetWorkflow,
  scoreFleetCandidate,
  type FleetWorkflowRequest,
  type FleetWorkflowOutcome,
  withFleetResultInstruction,
} from "./FleetWorkflows.js";
import { WorktreeFleetExchangeStore } from "../worktree/WorktreeFleetExchangeStore.js";
import {
  isCommandApprovalPolicy,
  type CommandApprovalPolicy,
} from "../approvals/commandApprovalPolicy.js";
import type {
  TerminalApprovalModeSnapshot,
  TerminalApprovalPolicy,
  TerminalApprovalReviewer,
  TerminalExecutionPreset,
} from "../core/capabilities/terminal.js";
import { convertAcpContentBlock } from "./acpContent.js";
import type { WorktreeAgentLaunchRequest } from "../core/capabilities/worktree.js";
import type { ToolResult } from "../shared/types.js";
import { isMemoryProtectedPath } from "../approvals/protectedPaths.js";
import { canonicalizePath, isPathWithinRoot } from "../util/paths.js";

const FLEET_VISIBILITY_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MAX_BACKGROUND_HANDOFF_IMAGES = 8;
const MAX_BACKGROUND_PARTIAL_RESULT_CHARS = 40 * 1024;
const MAX_ACP_OUTPUT_IMAGES = 8;

interface AcpOutputState {
  assistantTextParts: string[];
  directImages: ImageBlock[];
  toolImages: Map<string, ImageBlock[]>;
  warnings: Set<string>;
}

/**
 * Per-turn budget for auto-continuing after a mode switch. Kept separate from
 * MAX_AUTO_CONTINUE: each queued resume traces back to an explicit approval
 * (mode-switch approval or an ask_user answer mapped to a mode), so the todo
 * auto-continue budget must not silently swallow the continuation — the turn
 * would end right after the user's answer with no indication of why.
 */
const MAX_MODE_SWITCH_RESUMES = 10;

/** Incremental progress emitted while a /btw side question runs. */
export type BtwProgressEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool"; toolName: string }
  | { type: "warning"; message: string }
  | {
      type: "budget";
      apiTurns: number;
      toolCalls: number;
      maxApiTurns: number;
      maxToolCalls: number;
    };

export interface BtwQuestionOptions {
  /** Streamed incremental progress (text, tool activity, warnings, budget). */
  onProgress?: (event: BtwProgressEvent) => void;
  /** External cancellation (e.g. a Cancel button). Aborts the side session. */
  signal?: AbortSignal;
  /** Overall wall-clock deadline; aborts the side session when it elapses. */
  timeoutMs?: number;
}

export interface BtwQuestionResult {
  answer: string;
  toolCalls: Array<{ toolName: string; durationMs?: number }>;
  warnings: string[];
  inputTokens: number;
  outputTokens: number;
  /** True when the run was cut short by cancellation or the deadline. */
  cancelled: boolean;
  /** API turns consumed / allowed, for a legible budget in the UI. */
  apiTurns: number;
  maxApiTurns: number;
  /** Dispatchable tool calls consumed / allowed. */
  toolCallCount: number;
  maxToolCalls: number;
}

/** Bounds for a /btw side question — surfaced to the UI as a visible budget. */
const BTW_MAX_API_TURNS = 5;
const BTW_MAX_TOOL_CALLS = 10;
/** Default overall deadline for a /btw run before it self-aborts. */
const BTW_DEFAULT_TIMEOUT_MS = 120_000;

export type WorktreeSetupProgressEvent = BtwProgressEvent;

export interface WorktreeSetupOptions {
  onProgress?: (event: WorktreeSetupProgressEvent) => void;
  onSessionStarted?: (sessionId: string) => void;
  signal?: AbortSignal;
  conversation?: Array<{ role: "user" | "assistant"; text: string }>;
}

export interface WorktreeSetupResult extends BtwQuestionResult {
  sessionId: string;
  sourcePath: string;
}

const WORKTREE_SETUP_MAX_API_TURNS = 6;
const WORKTREE_SETUP_MAX_TOOL_CALLS = 12;
const WORKTREE_SETUP_SYSTEM_PROMPT = `You are a small, temporary setup agent for AgentLink's /worktree command. Your only job is to produce a safe, useful configuration for a new isolated Git worktree agent.

You may inspect the current repository with read-only tools. When the task or desired outcome is unclear, ask one focused question as ordinary text and stop. The host will return the user's reply in a later turn. Prefer repository and AgentLink defaults for optional settings; do not make the user choose a branch, base ref, path, mode, or autosubmit behavior unless their request makes that choice material. Never edit files, launch agents, or create the worktree yourself.

When the configuration is ready, briefly summarize it and end with exactly one machine-readable envelope using this shape:
<worktree-config>{"task":"short shelf label","prompt":"complete initial instruction for the new agent","branch":"optional branch","baseRef":"optional Git ref","worktreePath":"optional path","mode":"optional mode","autoSubmit":true}</worktree-config>

Only task and prompt are required. Omit optional JSON properties to use AgentLink defaults. Do not emit the envelope until all necessary user questions have been answered. When asking a question, do not emit the envelope.`;

/** Hard-stop backstop after the nominal budget has triggered a wrap-up. */
const BUDGET_HARD_LIMIT_RATIO = 3;

interface PreparedTurnExecution {
  context: Readonly<ToolDispatchContext> | undefined;
  policy: Readonly<CoreResolvedWebAccessPolicy>;
  mcpToolDisclosure: Readonly<McpToolDisclosurePartition>;
  mcpToolDefinitions: readonly import("./providers/types.js").ToolDefinition[];
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}

function getEngineHardLimit(limit: number | undefined): number | undefined {
  return limit === undefined
    ? undefined
    : Math.ceil(limit * BUDGET_HARD_LIMIT_RATIO);
}

/** Human-readable label for a budget check kind (e.g. "tool_calls" → "tool call"). */
function formatBudgetKind(kind: string): string {
  switch (kind) {
    case "tokens":
      return "token";
    case "tool_calls":
      return "tool call";
    case "api_turns":
      return "API turn";
    case "elapsed_time":
      return "elapsed time";
    case "estimated_cost":
      return "estimated cost";
    default:
      return kind.replace(/_/g, " ");
  }
}

export interface CheckpointRevertPreviewResult {
  projectId: string;
  checkpointId: string;
  sessionRevision: PersistenceRevision;
  persistenceRevision?: PersistenceRevision;
  workspaceRevision?: string;
  preview: RevertPreview;
}

export type CheckpointRevertResult =
  | { ok: true; restoredPrompt?: string; sessionRevision?: PersistenceRevision }
  | {
      ok: false;
      reason:
        | "not_found"
        | "session_conflict"
        | "checkpoint_stale"
        | "workspace_revert_failed"
        | "persistence_failed";
      currentRevision?: PersistenceRevision;
    };

export type PersistedSessionMutationOperation = "rename" | "delete";

export type PersistedSessionMutationResult =
  | { ok: true }
  | {
      ok: false;
      operation: PersistedSessionMutationOperation;
      reason: "conflict" | "not_owner" | "not_found" | "corrupt" | "io_error";
      currentRevision?: PersistenceRevision;
      message?: string;
    };

export type SessionApprovalMode = Readonly<
  TerminalApprovalModeSnapshot & {
    commandApprovalPolicy: CommandApprovalPolicy;
    approvalPolicy: TerminalApprovalPolicy;
    approvalReviewer: TerminalApprovalReviewer;
    executionPreset: TerminalExecutionPreset;
  }
>;

function approvalModeFromLegacyPolicy(
  commandApprovalPolicy: CommandApprovalPolicy,
): SessionApprovalMode {
  const approveForMe = commandApprovalPolicy === "approve-for-me";
  return Object.freeze({
    commandApprovalPolicy,
    approvalPolicy: "on-request",
    approvalReviewer: approveForMe ? "auto-review" : "user",
    executionPreset: approveForMe ? "workspace-write" : "native-manual",
  });
}

function restoredApprovalMode(
  metadata: PersistedSessionRecord["metadata"],
  fallback: CommandApprovalPolicy = "safe",
): SessionApprovalMode {
  const commandApprovalPolicy = isCommandApprovalPolicy(
    metadata.commandApprovalPolicy,
  )
    ? metadata.commandApprovalPolicy
    : fallback;
  const legacy = approvalModeFromLegacyPolicy(commandApprovalPolicy);
  return Object.freeze({
    commandApprovalPolicy,
    approvalPolicy:
      metadata.approvalPolicy === "on-request"
        ? metadata.approvalPolicy
        : legacy.approvalPolicy,
    approvalReviewer:
      metadata.approvalReviewer === "user" ||
      metadata.approvalReviewer === "auto-review"
        ? metadata.approvalReviewer
        : legacy.approvalReviewer,
    executionPreset:
      metadata.executionPreset === "native-manual" ||
      metadata.executionPreset === "workspace-write"
        ? metadata.executionPreset
        : legacy.executionPreset,
  });
}

export class AgentSessionManager {
  private sessions = new Map<string, AgentSession>();
  private sessionApprovalModes = new Map<string, SessionApprovalMode>();
  private retainedCommandReviewDenials = createRetainedCommandReviewDenials();
  private foregroundId: string | null = null;
  private engine: AgentEngine | null = null;
  private config: AgentConfig;
  private cwd: string;
  private apiKey?: string;
  private toolCtx?: ToolDispatchContext;
  private activeRequestToolContexts = new Map<
    string,
    Readonly<ToolDispatchContext>
  >();
  private readonly releasedToolContexts = new WeakSet<
    Readonly<ToolDispatchContext>
  >();
  private foregroundEngineRequest?: {
    sessionId: string;
    context: Readonly<ToolDispatchContext>;
  };
  private devMode: boolean;
  private persistence?: SessionStore;
  private sessionRevisions = new Map<string, PersistenceRevision>();
  private sessionRevertPending = new Map<string, RevertRecoveryState>();
  private sessionSaveQueues = new Map<string, Promise<void>>();
  private sessionRunSettled = new Map<string, Promise<void>>();
  private sessionSendQueues = new Map<string, Promise<void>>();
  private log?: (msg: string) => void;
  private readonly host: AgentSessionManagerHost;
  private readonly projectCatalog: ProjectScopeResolver;
  private readonly projectCustomizationRegistry: ProjectCustomizationRegistry;
  private readonly projectMcpHubRegistry: ProjectMcpHubRegistry | undefined;
  private readonly legacyProjectScope: SessionProjectScope | undefined;
  private readonly executionUnavailableReason: string | undefined;
  private browserPreferredProjectId: string | undefined;
  private readonly onBrowserPreferredProjectChanged:
    | ((projectId: string) => void | Promise<void>)
    | undefined;
  private activityTraceRecorder: ActivityTraceRecorderLike;

  /** Single-project compatibility override retained for focused tests. */
  private checkpointManager: CheckpointManagerLike | null = null;
  /** Project-keyed shadow repositories. Never route by state-anchor cwd. */
  private readonly checkpointManagers = new Map<
    string,
    CheckpointManagerLike
  >();
  /** Checkpoints per session: sessionId → logical multi-project checkpoints. */
  private checkpoints = new Map<string, Checkpoint[]>();
  /** Pending waiters for background session completion: sessionId → resolvers */
  private bgResultWaiters = new Map<string, Array<(result: string) => void>>();
  /** Stored final results for completed bg sessions (prevents race in waitForBackground). */
  private bgFinalResults = new Map<string, string>();
  /** Safety timers per bg session (cleared on normal completion). */
  private bgSafetyTimers = new Map<
    string,
    ReturnType<AgentSessionManagerHost["timers"]["setTimeout"]>[]
  >();
  /** Budget owners that have already received a soft-limit wrap-up request. */
  private bgBudgetWrapUps = new Map<string, { kind: string }>();
  /** Accumulated streaming text for background sessions (for UI preview). */
  private bgStreamingText = new Map<string, string>();
  /** Bounded substantive output retained for terminal failure and reload recovery. */
  private bgPartialResults = new Map<string, string>();
  /** Provider/engine retryability for terminal background failures. */
  private bgAgentRetryable = new Map<string, boolean>();
  /** Background sessions loaded from persistence rather than launched in this process. */
  private restoredBackgroundSessionIds = new Set<string>();
  /** Completion timestamps for background sessions (for auto-dismiss). */
  private bgCompletedAt = new Map<string, number>();
  /** Error messages for background sessions. */
  private bgErrors = new Map<string, string>();
  /** Human-friendly status detail (e.g. active file path) per background session. */
  private bgStatusDetail = new Map<string, string>();
  /** Set of bg session IDs that were explicitly cancelled by the user. */
  private bgCancelled = new Set<string>();
  /** Foreground session that launched each background session. */
  private bgParents = new Map<
    string,
    {
      sessionId: string;
      task: string;
    }
  >();
  /** Routing metadata per background session. */
  private bgMeta = new Map<
    string,
    {
      resolvedMode: string;
      resolvedModel: string;
      resolvedProvider: string;
      taskClass: string;
      routingReason: string;
      fallbackUsed: boolean;
      toolCalls: number;
      tokenUsage: number;
      apiTurns: number;
      startedAt: number;
      lastProgressAt: number;
      phase: BackgroundAgentRuntimePhase;
      phaseStartedAt?: number;
      requestStartedAt?: number;
      retryAt?: number;
    }
  >();
  private readonly bgSummaryScheduler = new BackgroundSummaryScheduler();
  private bgLaunchQueue: Array<{
    sessionId: string;
    start: () => Promise<void>;
  }> = [];
  /**
   * In-flight get_background_result waits per waiter session. A background
   * session with an entry here is blocked on a descendant and releases its
   * concurrency slot so the awaited work can be scheduled.
   */
  private bgResultWaitHolds = new Map<string, number>();
  private readonly worktreeMonitorTimers = new Map<
    string,
    ReturnType<AgentSessionManagerHost["timers"]["setInterval"]>
  >();
  private fleetVisibilityExpiryTimer?: ReturnType<
    AgentSessionManagerHost["timers"]["setTimeout"]
  >;
  private fleetVisibilityExpiryDeadline?: number;
  private fleetVisibilityExpiryDisposed = false;
  private readonly fleetScheduler: FleetScheduler;
  /** True while a transient /btw side question is running. */
  private btwInFlight = false;
  /** Background summary state keyed by session id. */
  private bgSummary = new Map<
    string,
    {
      inFlight: boolean;
      generatedAt?: number;
      sourceModel?: string;
      fallbackUsed?: boolean;
      confidence?: number;
      shortStatus?: string;
      lastAttemptAt?: number;
      lastFailureAt?: number;
      lastFailureReason?: string;
      lastInputHash?: string;
      needsRefresh: boolean;
    }
  >();

  /** Callback invoked with each event from the running agent */
  onEvent?: (sessionId: string, event: AgentEvent) => void;
  private readonly agentEventListeners = new Set<
    (sessionId: string, event: AgentEvent) => void
  >();

  addAgentEventListener(
    listener: (sessionId: string, event: AgentEvent) => void,
  ): () => void {
    this.agentEventListeners.add(listener);
    return () => this.agentEventListeners.delete(listener);
  }

  /** Callback when session list changes */
  onSessionsChanged?: () => void;
  private readonly sessionChangeListeners = new Set<() => void>();

  onDidChangeSessions(listener: () => void): { dispose(): void } {
    this.sessionChangeListeners.add(listener);
    return {
      dispose: () => this.sessionChangeListeners.delete(listener),
    };
  }

  /** Durable fleet lifecycle hook for notifications and automations. */
  onFleetEvent?: (
    sessionId: string,
    event: NonNullable<PersistedFleetMetadata["events"]>[number],
  ) => void;
  private readonly fleetEventListeners = new Set<
    (
      sessionId: string,
      event: NonNullable<PersistedFleetMetadata["events"]>[number],
    ) => void
  >();

  addFleetEventListener(
    listener: (
      sessionId: string,
      event: NonNullable<PersistedFleetMetadata["events"]>[number],
    ) => void,
  ): () => void {
    this.fleetEventListeners.add(listener);
    return () => this.fleetEventListeners.delete(listener);
  }

  private notifySessionsChanged(): void {
    const legacyListener = this.onSessionsChanged;
    legacyListener?.();
    this.notifySessionChangeListeners();
    this.scheduleFleetVisibilityExpiry();
  }

  private notifySessionChangeListeners(): void {
    for (const listener of this.sessionChangeListeners) {
      listener();
    }
  }

  private scheduleFleetVisibilityExpiry(): void {
    if (this.fleetVisibilityExpiryDisposed) return;

    const now = Date.now();
    let nextDeadline: number | undefined;
    for (const session of this.sessions.values()) {
      if (!session.background) continue;
      const fleet = session.fleetMetadata;
      const { done } = this.getProjectedBgStatus(session);
      if (!done || fleet?.lifecycle === "paused") continue;
      const activity =
        fleet?.completedAt ?? session.lastActiveAt ?? session.createdAt;
      const deadline = activity + FLEET_VISIBILITY_MAX_AGE_MS + 1;
      if (
        deadline > now &&
        (nextDeadline === undefined || deadline < nextDeadline)
      ) {
        nextDeadline = deadline;
      }
    }

    if (
      nextDeadline === this.fleetVisibilityExpiryDeadline &&
      this.fleetVisibilityExpiryTimer
    ) {
      return;
    }
    if (this.fleetVisibilityExpiryTimer) {
      this.host.timers.clearTimeout(this.fleetVisibilityExpiryTimer);
      this.fleetVisibilityExpiryTimer = undefined;
    }
    this.fleetVisibilityExpiryDeadline = nextDeadline;
    if (nextDeadline === undefined) return;
    this.fleetVisibilityExpiryTimer = this.host.timers.setTimeout(
      () => {
        this.fleetVisibilityExpiryTimer = undefined;
        this.fleetVisibilityExpiryDeadline = undefined;
        if (this.fleetVisibilityExpiryDisposed) return;
        if (Date.now() >= nextDeadline) {
          this.notifySessionChangeListeners();
        }
        this.scheduleFleetVisibilityExpiry();
      },
      Math.min(MAX_TIMER_DELAY_MS, Math.max(0, nextDeadline - now)),
    );
  }

  /** Clear only the browser-projection visibility timer owned by A4 publication. */
  disposeFleetVisibilityExpiry(): void {
    this.fleetVisibilityExpiryDisposed = true;
    if (!this.fleetVisibilityExpiryTimer) return;
    this.host.timers.clearTimeout(this.fleetVisibilityExpiryTimer);
    this.fleetVisibilityExpiryTimer = undefined;
    this.fleetVisibilityExpiryDeadline = undefined;
  }

  constructor(
    config: AgentConfig,
    cwd: string,
    apiKey?: string,
    devMode?: boolean,
    store?: SessionStore,
    log?: (msg: string) => void,
    private readonly bgDefaults: {
      maxConcurrent: number;
      maxConcurrentPerRoot?: number;
      maxConcurrentPerProvider?: number;
      maxDepth?: number;
      maxChildrenPerParent?: number;
    } = {
      maxConcurrent: 3,
    },
    opts?: AgentSessionManagerOptions,
  ) {
    this.config = config;
    this.cwd = cwd;
    this.apiKey = apiKey;
    this.devMode = devMode ?? false;
    this.log = log;
    const defaultHost = createDefaultAgentSessionManagerHost({
      cwd,
      log,
      store,
    });
    this.host = mergeAgentSessionManagerHost(defaultHost, opts?.host);
    this.projectCatalog =
      opts?.projectCatalog ?? this.createLegacyProjectCatalog(cwd);
    this.projectCustomizationRegistry =
      opts?.projectCustomizationRegistry ?? new ProjectCustomizationRegistry();
    this.projectMcpHubRegistry = opts?.projectMcpHubRegistry;
    this.executionUnavailableReason = opts?.executionUnavailableReason;
    this.browserPreferredProjectId = opts?.browserPreferredProjectId;
    this.onBrowserPreferredProjectChanged =
      opts?.onBrowserPreferredProjectChanged;
    const firstProject = this.projectCatalog.listProjects()[0];
    this.legacyProjectScope =
      opts?.legacyProjectScope ??
      (firstProject ? createSessionProjectScope(firstProject) : undefined);
    this.persistence = this.host.persistence;
    this.activityTraceRecorder = this.host.createActivityTraceRecorder({
      workspaceDir: cwd,
    });
    this.fleetScheduler = new FleetScheduler({
      maxConcurrent: this.bgDefaults.maxConcurrent,
      maxConcurrentPerRoot:
        this.bgDefaults.maxConcurrentPerRoot ?? this.bgDefaults.maxConcurrent,
      maxConcurrentPerProvider:
        this.bgDefaults.maxConcurrentPerProvider ??
        this.bgDefaults.maxConcurrent,
      maxDepth: this.bgDefaults.maxDepth ?? 2,
      maxChildrenPerParent: this.bgDefaults.maxChildrenPerParent ?? 4,
    });
  }

  private createLegacyProjectCatalog(cwd: string): ProjectScopeResolver {
    const workspaceFolderUri = pathToFileURL(cwd).toString();
    const project: WorkspaceProject = {
      id: createWorkspaceProjectId(workspaceFolderUri),
      name: cwd,
      uri: workspaceFolderUri,
      rootPath: cwd,
      availability: { status: "available" },
    };
    return {
      listProjects: () => [project],
      resolveProjectForResource: () => project,
      resolvePersistedScope: (scope): SessionProjectResolution =>
        scope.projectId === project.id &&
        scope.workspaceFolderUri === project.uri
          ? {
              status: "available",
              project,
              scope: createSessionProjectScope(project),
            }
          : { status: "missing", scope },
    };
  }

  private selectProjectScope(input?: {
    explicitProjectId?: string;
    activeFilePath?: string;
  }): SessionProjectScope {
    this.requireWorkspaceExecution();
    const selection = selectNewSessionProject(this.projectCatalog, {
      explicitProjectId: input?.explicitProjectId,
      activeResourceUri: input?.activeFilePath
        ? pathToFileURL(input.activeFilePath).toString()
        : undefined,
      browserPreferredProjectId: this.browserPreferredProjectId,
    });
    if (selection.status !== "selected") {
      throw new Error("Open an available workspace folder to start a session.");
    }
    return selection.scope;
  }

  private async createBoundSession(
    opts: Parameters<AgentSessionManagerHost["createSession"]>[0],
  ): Promise<AgentSession> {
    const allModes = await this.projectCustomizationRegistry.getModes(
      opts.projectScope,
    );
    const agentMode = opts.agentMode ?? resolveMode(opts.mode, allModes);
    const session = await this.host.createSession({ ...opts, agentMode });
    const existingScope = session.projectScope;
    if (existingScope === undefined) {
      Object.defineProperty(session, "projectScope", {
        value: Object.freeze({ ...opts.projectScope }),
        enumerable: true,
        configurable: false,
        writable: false,
      });

      Object.defineProperty(session, "projectAvailability", {
        value: "available",
        enumerable: true,
        configurable: false,
        writable: false,
      });
      return session;
    }
    if (
      existingScope.projectId !== opts.projectScope.projectId ||
      existingScope.workspaceFolderUri !== opts.projectScope.workspaceFolderUri
    ) {
      throw new Error("Session factory returned a mismatched project scope.");
    }
    return session;
  }

  private async createRestoredSession(args: {
    summary: SessionSummary;
    metadata: PersistedSessionRecord["metadata"];
    background?: boolean;
  }): Promise<AgentSession> {
    const persistedScope =
      args.metadata.projectScope ??
      args.summary.projectScope ??
      this.legacyProjectScope;
    if (persistedScope === undefined) {
      throw new Error(
        `Persisted session ${args.summary.id} has no project scope and no legacy migration project is available.`,
      );
    }
    const resolution =
      this.projectCatalog.resolvePersistedScope(persistedScope);
    const model = this.resolveAvailableModelId(args.summary.model);
    const providerId = this.host.providers.tryResolveProvider(model)?.id;
    const activeContextProject = args.metadata.activeContextResourceUri
      ? this.projectCatalog.resolveProjectForResource(
          args.metadata.activeContextResourceUri,
        )
      : undefined;
    let activeFilePath: string | undefined;
    if (
      activeContextProject?.id === persistedScope.projectId &&
      args.metadata.activeContextResourceUri?.startsWith("file:")
    ) {
      try {
        activeFilePath = fileURLToPath(args.metadata.activeContextResourceUri);
      } catch {
        activeFilePath = undefined;
      }
    }
    const common = {
      mode: args.summary.mode,
      config: this.buildConfigForModel(model),
      background: args.background,
      activeFilePath,
      activeContextResourceUri: args.metadata.activeContextResourceUri,
      workspaceFolders: this.getWorkspaceFolders(),
      providerId,
    };
    if (resolution.status === "available") {
      return this.createBoundSession({
        ...common,
        projectScope: resolution.scope,
        devMode: this.devMode,
        isBackground: args.background,
      });
    }
    return AgentSession.createTranscriptOnly({
      ...common,
      projectScope: persistedScope,
      projectAvailability: resolution.status,
    });
  }

  /**
   * Snapshot the open workspace folders so the agent's system prompt can list
   * where each project lives (multi-root workspaces). Read fresh each time so
   * folder add/remove is reflected on the next session create or prompt rebuild.
   */
  private getWorkspaceFolders(): WorkspaceFolderInfo[] {
    return this.host.workspace.getWorkspaceFolders();
  }

  private requireWorkspaceExecution(): void {
    if (this.executionUnavailableReason) {
      throw new Error(this.executionUnavailableReason);
    }
  }

  private requireSessionExecution(session: AgentSession): string {
    this.requireWorkspaceExecution();
    const resolution = this.projectCatalog.resolvePersistedScope(
      session.projectScope,
    );
    if (
      session.projectAvailability !== "available" ||
      resolution.status !== "available" ||
      resolution.scope.projectId !== session.projectScope.projectId ||
      resolution.scope.workspaceFolderUri !==
        session.projectScope.workspaceFolderUri ||
      resolution.scope.rootPath === undefined ||
      resolution.scope.rootPath !== session.projectScope.rootPath
    ) {
      throw new Error(
        `Project '${session.projectScope.displayName}' is unavailable for local execution.`,
      );
    }
    return resolution.scope.rootPath;
  }

  private getCheckpointManagerForProject(
    project: WorkspaceProject,
  ): CheckpointManagerLike {
    const projectRoot = project.rootPath;
    if (project.availability.status !== "available" || !projectRoot) {
      throw new Error(
        `Project '${project.name}' is unavailable for checkpointing.`,
      );
    }
    const projectId = project.id;
    if (
      this.projectCatalog.listProjects().length === 1 &&
      this.checkpointManager
    ) {
      this.checkpointManagers.set(projectId, this.checkpointManager);
      return this.checkpointManager;
    }
    const existing = this.checkpointManagers.get(projectId);
    if (existing) return existing;

    const manager = this.host.createCheckpointManager({
      workspaceDir: projectRoot,
      taskId: "agent",
      log: (message) => this.log?.(message),
    });
    this.checkpointManagers.set(projectId, manager);
    manager.initialize?.().catch((error: unknown) => {
      this.log?.(`[checkpoint] Init error for project ${projectId}: ${error}`);
    });
    return manager;
  }

  private getCheckpointManagerForSession(
    session: AgentSession,
  ): CheckpointManagerLike {
    this.requireSessionExecution(session);
    const project = this.projectCatalog
      .listProjects()
      .find((candidate) => candidate.id === session.projectScope.projectId);
    if (!project) {
      throw new Error(
        `Project '${session.projectScope.displayName}' is unavailable for checkpointing.`,
      );
    }
    return this.getCheckpointManagerForProject(project);
  }

  private peekCheckpointManagerForSession(
    session: AgentSession,
  ): CheckpointManagerLike | undefined {
    return this.projectCatalog.listProjects().length === 1 &&
      this.checkpointManager
      ? this.checkpointManager
      : this.checkpointManagers.get(session.projectScope.projectId);
  }

  private async getInitializedCheckpointManagerForSession(
    session: AgentSession,
  ): Promise<CheckpointManagerLike | null> {
    const manager = this.getCheckpointManagerForSession(session);
    if (typeof manager.initialize !== "function") return manager;
    return (await manager.initialize()) === false ? null : manager;
  }

  private async prepareSessionProjectMutation(
    session: AgentSession,
  ): Promise<void> {
    const availableProjects = this.projectCatalog
      .listProjects()
      .filter(
        (project): project is WorkspaceProject & { rootPath: string } =>
          project.availability.status === "available" &&
          project.rootPath !== undefined,
      );
    if (availableProjects.length === 0) return;

    for (const project of availableProjects) {
      const manager = this.getCheckpointManagerForProject(project);
      const initialized =
        typeof manager.initialize === "function"
          ? await manager.initialize()
          : true;
      if (initialized === false) {
        this.log?.(
          `[checkpoint] Skipping unavailable checkpoint protection for project '${project.name}'.`,
        );
      }
    }

    const currentTurnIndex = session
      .getAllMessages()
      .filter(
        (message) =>
          message.role === "user" && typeof message.content === "string",
      ).length;
    const previousBoundary = currentTurnIndex - 1;
    if (previousBoundary > 0) {
      await this.ensureCheckpointForTurn(session, previousBoundary);
    }
  }

  private captureSessionToolContext(
    session: AgentSession,
    overrides?: Partial<ToolDispatchContext>,
    inheritedContext?: Readonly<ToolDispatchContext>,
  ): Readonly<ToolDispatchContext> | undefined {
    const projectRoot = this.requireSessionExecution(session);
    const baseContext = inheritedContext ?? this.toolCtx;
    if (!baseContext) return undefined;
    baseContext.approvalManager.bindSessionProject(
      session.id,
      session.projectScope,
    );
    baseContext.approvalManager.touchSession?.(session.id);
    if (!inheritedContext) {
      this.projectMcpHubRegistry?.ensure(session.projectScope);
    }
    const mcpHubLease = inheritedContext?.mcpHubLease
      ? inheritedContext.mcpHubLease.retain()
      : this.projectMcpHubRegistry?.acquire(session.projectScope);
    try {
      const captured = inheritedContext
        ? { ...baseContext, ...overrides }
        : this.host.captureProjectToolContext(
            { ...baseContext, ...overrides },
            session.projectScope,
          );
      if (
        captured.projectScope !== undefined &&
        (captured.projectScope.projectId !== session.projectScope.projectId ||
          captured.projectScope.workspaceFolderUri !==
            session.projectScope.workspaceFolderUri)
      ) {
        throw new Error("Tool runtime returned a mismatched project scope.");
      }
      if (
        captured.projectRoot !== undefined &&
        captured.projectRoot !== projectRoot
      ) {
        throw new Error("Tool runtime returned a mismatched project root.");
      }
      return Object.freeze({
        ...captured,
        sessionId: session.id,
        mode: session.mode,
        isBackgroundSession: session.background,
        projectScope: session.projectScope,
        projectRoot,
        workspaceProjectRoots: this.projectCatalog
          .listProjects()
          .flatMap((project) => (project.rootPath ? [project.rootPath] : [])),
        prepareWorkspaceMutation: () =>
          this.prepareSessionProjectMutation(session),
        commandReviewTurnCircuit: createCommandReviewTurnCircuit(),
        retainedCommandReviewDenials: this.retainedCommandReviewDenials,
        ...(mcpHubLease ? { mcpHub: mcpHubLease.hub, mcpHubLease } : {}),
        onFileRead: (filePath: string) => session.trackFileRead(filePath),
        getAdvertisedSkills: () => session.getAdvertisedSkills(),
        getAdvertisedRules: () => session.getAdvertisedRules(),
        onSkillLoad: (skillName: string) => session.trackLoadedSkill(skillName),
        ...(this.activityTraceRecorder.diagnoseSessionActivity
          ? {
              sessionActivityDiagnosticsProvider: {
                diagnose: (
                  query: import("../core/sessionActivityDiagnostics.js").SessionActivityQuery,
                ) =>
                  this.activityTraceRecorder.diagnoseSessionActivity!(
                    session.id,
                    query,
                  ),
              },
            }
          : {}),
      });
    } catch (error) {
      mcpHubLease?.release();
      throw error;
    }
  }

  private bindCapturedEngineToSession(
    engine: AgentEngine,
    session: AgentSession,
    context: Readonly<ToolDispatchContext> | undefined,
    runtime?: AgentToolRuntime,
  ): Readonly<ToolDispatchContext> | undefined {
    if (!context) return undefined;
    try {
      this.refreshMcpToolDisclosure(session, context);
      engine.setToolRuntime(runtime ?? this.host.createToolRuntime(context));
      this.activeRequestToolContexts.set(session.id, context);
      if (engine === this.engine) {
        this.foregroundEngineRequest = { sessionId: session.id, context };
      }
      return context;
    } catch (error) {
      context.mcpHubLease?.release();
      throw error;
    }
  }

  private bindEngineToSession(
    engine: AgentEngine,
    session: AgentSession,
    overrides?: Partial<ToolDispatchContext>,
    inheritedContext?: Readonly<ToolDispatchContext>,
  ): Readonly<ToolDispatchContext> | undefined {
    if (engine === this.engine && this.foregroundEngineRequest) {
      throw new Error(
        `Foreground engine is already bound to session '${this.foregroundEngineRequest.sessionId}'.`,
      );
    }
    const context = this.captureSessionToolContext(
      session,
      overrides,
      inheritedContext,
    );
    if (!context) return undefined;
    return this.bindCapturedEngineToSession(engine, session, context);
  }

  private releaseSessionToolContext(
    sessionId: string,
    context: Readonly<ToolDispatchContext> | undefined,
  ): void {
    if (!context || this.releasedToolContexts.has(context)) return;
    this.releasedToolContexts.add(context);
    if (this.activeRequestToolContexts.get(sessionId) === context) {
      this.activeRequestToolContexts.delete(sessionId);
    }
    if (this.foregroundEngineRequest?.context === context) {
      this.foregroundEngineRequest = undefined;
    }
    context.mcpHubLease?.release();
  }

  setToolContext(ctx: ToolDispatchContext): void {
    // This is a window-level capability source only. Active requests capture a
    // project-bound snapshot and must not be mutated when the source changes.
    this.toolCtx = ctx;
  }

  private getBackgroundAgentSettings(scope?: Readonly<SessionProjectScope>) {
    return normalizeBackgroundAgentSettings(
      this.host.config.getBackgroundAgentSettings(scope),
    );
  }

  private cloneMcpToolDefinitions(
    context: Readonly<ToolDispatchContext> | undefined,
  ): import("./providers/types.js").ToolDefinition[] {
    return context?.mcpHub ? structuredClone(context.mcpHub.getToolDefs()) : [];
  }

  private async prepareTurnExecution(
    session: AgentSession,
    options: {
      overrides?: Partial<ToolDispatchContext>;
      inheritedContext?: Readonly<ToolDispatchContext>;
    } = {},
  ): Promise<PreparedTurnExecution> {
    const context = this.captureSessionToolContext(
      session,
      options.overrides,
      options.inheritedContext,
    );
    try {
      const settings = normalizeCoreWebAccessSettings(
        this.host.config.getWebAccessSettings?.(),
      );
      const modelResolution = this.host.providers.resolveAvailableModel(
        session.model,
      );
      if (
        !modelResolution &&
        (settings.searchBackend === "native" ||
          settings.fetchBackend === "native")
      ) {
        throw new Error(
          `Model "${session.model}" is no longer available. Select a supported model from the model picker and retry.`,
        );
      }
      if (modelResolution && modelResolution.model !== session.model) {
        const retiredModel = session.model;
        session.model = modelResolution.model;
        session.providerId = modelResolution.provider.id;
        this.applyThresholdToSession(session);
        if (!session.background && this.foregroundId === session.id) {
          this.updateConfig({
            model: session.model,
            autoCondenseThreshold: session.autoCondenseThreshold,
          });
        }
        this.log?.(
          `[model] migrated retired model "${retiredModel}" to "${session.model}" before request execution`,
        );
      }
      const provider =
        modelResolution?.provider ??
        this.host.providers.tryResolveProvider(session.model);
      const capabilities = provider?.getRequestCapabilities
        ? await provider.getRequestCapabilities(session.model)
        : provider?.getCapabilities(session.model);
      const mcpTools = this.cloneMcpToolDefinitions(context);
      const policy = resolveCoreWebAccessPolicy({
        settings,
        providerCapabilities: capabilities?.hostedWeb,
      });
      const unavailableNativeRoute = [
        policy.routes.search,
        policy.routes.fetch,
      ].find(
        (route) =>
          settings[
            route.kind === "search" ? "searchBackend" : "fetchBackend"
          ] === "native" && !route.available,
      );
      if (unavailableNativeRoute) {
        throw new Error(
          `Native web ${unavailableNativeRoute.kind} is unavailable (${unavailableNativeRoute.reason}).`,
        );
      }

      const serverNames = new Set(
        mcpTools
          .map((tool) => parseMcpToolName(tool.name)?.serverName)
          .filter((name): name is string => Boolean(name)),
      );
      const mcpToolDisclosure = partitionMcpToolsForDisclosure(mcpTools, {
        serverConfigs: [...serverNames].map((serverName) => ({
          serverName,
          mode: context?.mcpHub?.getServerConfig(serverName)?.toolDisclosure,
        })),
      });
      const requestContext =
        context && provider
          ? Object.freeze({
              ...context,
              nativeWebToolKinds: [...policy.enabledKinds],
              nativeWebToolProvider: {
                execute: async (request: NativeWebToolExecutionRequest) => {
                  const route = policy.routes[request.kind];
                  if (!route.available || !route.hostedTool) {
                    throw new Error(
                      `Native web ${request.kind} is not available for this request.`,
                    );
                  }
                  const hostedTool = route.hostedTool;
                  const permit =
                    await this.host.providers.requestScheduler.acquire(
                      provider.id,
                      session.background ? "background" : "interactive",
                      request.signal,
                    );
                  try {
                    if (provider.executeNativeWebTool) {
                      try {
                        const directResult =
                          await provider.executeNativeWebTool({
                            model: session.model,
                            kind: request.kind,
                            input: request.input,
                            settings: policy.settings,
                            signal: request.signal,
                          });
                        if (directResult !== null) return directResult;
                      } catch (error) {
                        if (request.signal?.aborted) throw error;
                        this.log?.(
                          `[web] ${provider.id} standalone ${request.kind} failed; falling back to delegated hosted execution: ${error instanceof Error ? error.message : String(error)}`,
                        );
                      }
                    }
                    const prompt = buildNativeWebDelegationPrompt(
                      request.kind,
                      request.input,
                    );
                    return await collectNativeWebToolResult({
                      provider: provider.id,
                      operation: request.kind,
                      input: request.input,
                      events: continueNativeWebProviderStream({
                        initialMessages: [
                          { role: "user", content: prompt.userPrompt },
                        ],
                        // Watchdog-wrapped: a hung delegated stream would
                        // otherwise pin its scheduler permit forever with no
                        // timeout coverage at all.
                        stream: (messages) =>
                          runWatchedProviderStream({
                            signal: request.signal,
                            start: ({ signal, onTransportActivity }) =>
                              provider.stream({
                                model: session.model,
                                systemPrompt: prompt.systemPrompt,
                                messages,
                                tools: [],
                                hostedTools: [hostedTool],
                                maxTokens: Math.min(session.maxTokens, 16_384),
                                reasoningEffort: "low",
                                state: { store: false },
                                providerHints: {
                                  codex: {
                                    sessionId: `${session.id}:web:${request.kind}`,
                                  },
                                },
                                signal,
                                onTransportActivity,
                              }),
                          }),
                      }),
                    });
                  } finally {
                    permit.release();
                  }
                },
              },
            })
          : context;

      return Object.freeze({
        context: requestContext,
        policy: deepFreeze(policy),
        mcpToolDisclosure: deepFreeze(mcpToolDisclosure),
        mcpToolDefinitions: deepFreeze(mcpTools),
      });
    } catch (error) {
      context?.mcpHubLease?.release();
      throw error;
    }
  }

  private async prepareInteractiveTurnExecution(
    session: AgentSession,
  ): Promise<PreparedTurnExecution> {
    try {
      return await this.prepareTurnExecution(session);
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err);
      session.status = "error";
      if (!session.background) {
        session.runState = undefined;
      }
      this.recordAndEmitEvent(session.id, {
        type: "error",
        error,
        retryable: false,
      });
      await this.saveSessionNow(session.id);
      this.recordAndEmitEvent(session.id, {
        type: "done",
        totalInputTokens: session.totalInputTokens,
        totalOutputTokens: session.totalOutputTokens,
        totalCacheReadTokens: session.totalCacheReadTokens,
        totalCacheCreationTokens: session.totalCacheCreationTokens,
      });
      this.notifySessionsChanged();
      throw err;
    }
  }

  private getAcpAdditionalDirectories(projectRoot: string): string[] {
    return this.getWorkspaceFolders()
      .map((folder) => folder.path)
      .filter((folderPath) => folderPath && folderPath !== projectRoot);
  }

  private acpOutputImageCount(
    state: AcpOutputState,
    excludingToolCallId?: string,
  ): number {
    let count = state.directImages.length;
    for (const [toolCallId, images] of state.toolImages) {
      if (toolCallId !== excludingToolCallId) count += images.length;
    }
    return count;
  }

  private setAcpToolImages(
    state: AcpOutputState,
    update: Extract<SessionUpdate, { sessionUpdate: "tool_call_update" }>,
  ): void {
    if (!update.content) return;
    const images: ImageBlock[] = [];
    const available = Math.max(
      0,
      MAX_ACP_OUTPUT_IMAGES -
        this.acpOutputImageCount(state, update.toolCallId),
    );
    let validImageCount = 0;
    for (const item of update.content) {
      if (item.type !== "content" || item.content.type !== "image") continue;
      const converted = convertAcpContentBlock(item.content);
      if (converted.warning) state.warnings.add(converted.warning);
      if (converted.content?.type !== "image") continue;
      validImageCount += 1;
      if (images.length < available) images.push(converted.content);
    }
    if (validImageCount > images.length) {
      state.warnings.add(
        `[ACP images truncated: showing at most ${MAX_ACP_OUTPUT_IMAGES} images]`,
      );
    }
    state.toolImages.set(update.toolCallId, images);
  }

  private buildAcpAssistantContent(
    state: AcpOutputState,
    extraText?: string,
  ): ContentBlock[] {
    const responseText = state.assistantTextParts.join("").trim();
    const warningText = Array.from(state.warnings).join("\n").trim();
    const toolImages = Array.from(state.toolImages.values()).flat();
    const imageCount = state.directImages.length + toolImages.length;
    const text = [
      responseText ||
        (imageCount > 0
          ? `ACP agent returned ${imageCount} image${imageCount === 1 ? "" : "s"}.`
          : ""),
      warningText,
      extraText?.trim(),
    ]
      .filter(Boolean)
      .join("\n\n");
    return [
      ...(text ? ([{ type: "text", text }] as ContentBlock[]) : []),
      ...state.directImages,
      ...toolImages,
    ];
  }

  private applyAcpPromptResponseUsage(
    session: AgentSession,
    response: PromptResponse,
  ): void {
    const usage = response.usage;
    if (!usage) return;

    session.totalInputTokens = usage.inputTokens;
    session.totalOutputTokens = usage.outputTokens;
    session.totalCacheReadTokens = usage.cachedReadTokens ?? 0;
    session.totalCacheCreationTokens = usage.cachedWriteTokens ?? 0;
    session.lastInputTokens =
      usage.inputTokens +
      (usage.cachedReadTokens ?? 0) +
      (usage.cachedWriteTokens ?? 0);
    session.lastOutputTokens = usage.outputTokens;
    session.lastCacheReadTokens = usage.cachedReadTokens ?? 0;

    const meta = this.bgMeta.get(session.id);
    if (meta) {
      // Budget "tokens" counts spend: uncached input + output, matching the
      // in-process engine metric (uncachedInputTokens + outputTokens per API
      // turn). ACP usage is cumulative across the session, so assign rather
      // than accumulate. totalTokens would also count cache reads, which
      // grow with every turn and would exhaust budgets far faster than the
      // equivalent native agent.
      meta.tokenUsage = usage.inputTokens + usage.outputTokens;
      meta.apiTurns += 1;
    }
    this.enforceBackgroundBudget(session);
  }

  private acpStopReasonMessage(response: PromptResponse): string | undefined {
    if (response.stopReason === "end_turn") return undefined;
    if (response.stopReason === "cancelled") {
      return "ACP background agent cancelled.";
    }
    if (response.stopReason === "refusal") {
      return "ACP background agent refused the request.";
    }
    if (response.stopReason === "max_tokens") {
      return "ACP background agent stopped after reaching its token limit.";
    }
    if (response.stopReason === "max_turn_requests") {
      return "ACP background agent stopped after reaching its turn limit.";
    }
    return `ACP background agent stopped: ${response.stopReason}`;
  }

  private acpToolKindToApprovalKind(
    kind: ToolKind | null | undefined,
  ): "command" | "write" | "mcp" {
    if (kind === "execute") return "command";
    if (kind === "edit" || kind === "delete" || kind === "move") return "write";
    return "mcp";
  }

  private isReadonlyAllowedAcpToolKind(
    kind: ToolKind | null | undefined,
  ): boolean {
    return (
      kind === "read" ||
      kind === "search" ||
      kind === "think" ||
      kind === "fetch"
    );
  }

  /**
   * Reuse inherited write authority only when ACP supplies complete structured
   * file locations. Opaque rawInput is provider-defined and must still prompt.
   */
  private getInheritedAcpWriteOption(args: {
    sessionId: string;
    requestContext: Readonly<ToolDispatchContext> | undefined;
    request: RequestPermissionRequest;
  }): string | undefined {
    const toolKind = args.request.toolCall.kind;
    if (toolKind !== "edit" && toolKind !== "delete" && toolKind !== "move") {
      return undefined;
    }

    const allowOnce = args.request.options.find(
      (option) => option.kind === "allow_once",
    );
    const locations = args.request.toolCall.locations;
    const requestContext = args.requestContext;
    const projectRoot = requestContext?.projectRoot;
    if (!allowOnce || !locations?.length || !requestContext || !projectRoot) {
      return undefined;
    }

    const workspaceRoots = requestContext.workspaceProjectRoots?.length
      ? requestContext.workspaceProjectRoots
      : [projectRoot];
    const canonicalRoots = workspaceRoots.map((root) => canonicalizePath(root));
    const approvalManager = requestContext.approvalManager;

    for (const location of locations) {
      const rawPath = location.path.trim();
      if (!rawPath) return undefined;
      const absolutePath = canonicalizePath(
        nodePath.isAbsolute(rawPath)
          ? rawPath
          : nodePath.resolve(projectRoot, rawPath),
      );
      if (isMemoryProtectedPath(absolutePath, { cwd: projectRoot })) {
        return undefined;
      }

      const inWorkspace = canonicalRoots.some((root) =>
        isPathWithinRoot(absolutePath, root),
      );
      const authorized = inWorkspace
        ? approvalManager.getAgentWriteAuthorization(
            args.sessionId,
            absolutePath,
          ).allowed
        : approvalManager.isPathTrusted(args.sessionId, absolutePath) &&
          approvalManager.getFileWriteAuthorization(
            args.sessionId,
            absolutePath,
          ).allowed;
      if (!authorized) return undefined;
    }

    return allowOnce.optionId;
  }

  private async handleAcpPermissionRequest(args: {
    sessionId: string;
    task: string;
    readonlyOnly: boolean;
    requestContext: Readonly<ToolDispatchContext> | undefined;
    request: RequestPermissionRequest;
  }): Promise<RequestPermissionResponse> {
    const toolKind = args.request.toolCall.kind;
    if (args.readonlyOnly && !this.isReadonlyAllowedAcpToolKind(toolKind)) {
      return { outcome: { outcome: "cancelled" } };
    }

    const options = args.request.options;
    if (options.length === 0) return { outcome: { outcome: "cancelled" } };

    if (this.bgCancelled.has(args.sessionId)) {
      return { outcome: { outcome: "cancelled" } };
    }

    const inheritedWriteOption = this.getInheritedAcpWriteOption(args);
    if (inheritedWriteOption) {
      return {
        outcome: { outcome: "selected", optionId: inheritedWriteOption },
      };
    }

    this.noteBackgroundProgress(args.sessionId, "awaiting_approval");

    const selected = await args.requestContext?.onApprovalRequest?.(
      {
        kind: this.acpToolKindToApprovalKind(toolKind),
        title:
          args.request.toolCall.title?.trim() ||
          "ACP background agent requests permission",
        detail: JSON.stringify(
          {
            toolKind,
            rawInput: args.request.toolCall.rawInput,
            options: options.map((option) => ({
              id: option.optionId,
              name: option.name,
              kind: option.kind,
            })),
          },
          null,
          2,
        ),
        choices: options.map((option) => ({
          label: option.name,
          value: option.optionId,
          isPrimary: option.kind === "allow_once",
          isDanger: option.kind.startsWith("reject"),
        })),
        backgroundTask: args.task,
      },
      args.sessionId,
    );

    if (!selected || typeof selected !== "string") {
      return { outcome: { outcome: "cancelled" } };
    }
    return { outcome: { outcome: "selected", optionId: selected } };
  }

  private applyAcpSessionUpdate(args: {
    session: AgentSession;
    output: AcpOutputState;
    update: SessionUpdate;
  }): void {
    const { session, update } = args;
    if (update.sessionUpdate === "agent_message_chunk") {
      this.noteBackgroundProgress(session.id, "responding");
      const converted = convertAcpContentBlock(update.content);
      if (converted.warning) args.output.warnings.add(converted.warning);
      if (converted.content?.type === "text") {
        args.output.assistantTextParts.push(converted.content.text);
        this.appendBgStreamingText(session.id, converted.content.text);
        this.recordAndEmitEvent(session.id, {
          type: "text_delta",
          text: converted.content.text,
        });
      } else if (converted.content?.type === "image") {
        if (this.acpOutputImageCount(args.output) < MAX_ACP_OUTPUT_IMAGES) {
          args.output.directImages.push(converted.content);
        } else {
          args.output.warnings.add(
            `[ACP images truncated: showing at most ${MAX_ACP_OUTPUT_IMAGES} images]`,
          );
        }
      }
      return;
    }

    if (update.sessionUpdate === "tool_call") {
      this.noteBackgroundProgress(session.id, "executing_tool");
      session.currentTool = update.title;
      session.status = "tool_executing";
      this.bgStatusDetail.set(session.id, update.title);
      const meta = this.bgMeta.get(session.id);
      if (meta) meta.toolCalls += 1;
      this.recordAndEmitEvent(session.id, {
        type: "tool_start",
        toolCallId: update.toolCallId,
        toolName: update.title,
      });
      this.enforceBackgroundBudget(session);
      return;
    }

    if (update.sessionUpdate === "tool_call_update") {
      this.setAcpToolImages(args.output, update);
      this.noteBackgroundProgress(
        session.id,
        update.status === "completed" || update.status === "failed"
          ? "waiting_for_provider"
          : "executing_tool",
      );
      if (update.title) {
        session.currentTool = update.title;
        this.bgStatusDetail.set(session.id, update.title);
      }
      if (update.status === "completed" || update.status === "failed") {
        session.currentTool = undefined;
      }
      return;
    }

    if (update.sessionUpdate === "usage_update") {
      this.noteBackgroundProgress(session.id, "waiting_for_provider");
      // update.used is context-window occupancy ("tokens currently in
      // context"), not cumulative spend — it must not count against the
      // token budget, or an agent that loads a large diff would exhaust a
      // reasonable budget instantly. Spend is applied from the prompt
      // response usage instead. Still re-run enforcement so elapsed-time
      // budgets are checked between turns.
      session.lastInputTokens = update.used;
      this.enforceBackgroundBudget(session);
    }
  }

  private recordAndEmitEvent(sessionId: string, event: AgentEvent): void {
    const session = this.sessions.get(sessionId);
    if (session && event.type === "warning" && event.modelFallback) {
      session.model = event.modelFallback.effectiveModel;
      this.applyThresholdToSession(session);
      const backgroundMeta = this.bgMeta.get(sessionId);
      if (backgroundMeta) {
        backgroundMeta.resolvedModel = event.modelFallback.effectiveModel;
        backgroundMeta.fallbackUsed = true;
      }
      if (!session.background && this.foregroundId === sessionId) {
        this.updateConfig({
          model: event.modelFallback.effectiveModel,
          autoCondenseThreshold: this.getCondenseThresholdForModel(
            event.modelFallback.effectiveModel,
            session.projectScope,
          ),
        });
      }
      this.saveSession(sessionId);
      this.notifySessionsChanged();
    }
    if (session) {
      this.activityTraceRecorder.appendAgentEvent(
        sessionId,
        session.projectScope.projectId,
        event,
        session.background ? "background_agent" : "foreground_agent",
      );
    }
    this.onEvent?.(sessionId, event);
    for (const listener of this.agentEventListeners) {
      listener(sessionId, event);
    }
  }

  private async withSessionSendQueue(
    sessionId: string,
    fn: () => Promise<void>,
  ): Promise<void> {
    const previous = this.sessionSendQueues.get(sessionId) ?? Promise.resolve();
    let releaseCurrent!: () => void;
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const queued = previous.catch(() => undefined).then(() => current);
    this.sessionSendQueues.set(sessionId, queued);

    await previous.catch(() => undefined);
    try {
      await fn();
    } finally {
      releaseCurrent();
      if (this.sessionSendQueues.get(sessionId) === queued) {
        this.sessionSendQueues.delete(sessionId);
      }
    }
  }

  private async ensureCheckpointForTurn(
    session: AgentSession,
    turnIndex: number,
    opts?: { refreshExisting?: boolean },
  ): Promise<Checkpoint | null> {
    if (turnIndex <= 0) return null;

    const primaryProjectId = session.projectScope.projectId;
    const projectIds = new Set(
      this.projectCatalog
        .listProjects()
        .filter(
          (project) =>
            project.availability.status === "available" && project.rootPath,
        )
        .map((project) => project.id),
    );

    const existing = this.checkpoints.get(session.id) ?? [];
    const existingIndex = existing.findIndex(
      (checkpoint) => checkpoint.turnIndex === turnIndex,
    );
    const existingCheckpoint = existing[existingIndex];
    const existingSnapshots = new Map(
      (existingCheckpoint?.projectSnapshots ?? []).map((snapshot) => [
        snapshot.projectId,
        snapshot,
      ]),
    );
    if (
      existingCheckpoint?.projectId &&
      !existingSnapshots.has(existingCheckpoint.projectId)
    ) {
      existingSnapshots.set(existingCheckpoint.projectId, {
        projectId: existingCheckpoint.projectId,
        commitHash: existingCheckpoint.commitHash,
        createdAt: existingCheckpoint.createdAt,
      });
    }

    let changed = false;
    let createdCheckpointId: string | undefined;
    for (const projectId of projectIds) {
      if (existingSnapshots.has(projectId) && !opts?.refreshExisting) continue;
      const project = this.projectCatalog
        .listProjects()
        .find((candidate) => candidate.id === projectId);
      if (!project) continue;
      const manager = this.getCheckpointManagerForProject(project);
      const initialized =
        typeof manager.initialize === "function"
          ? await manager.initialize()
          : true;
      if (initialized === false) {
        this.log?.(
          `[checkpoint] Skipping unavailable checkpoint protection for project '${project.name}'.`,
        );
        continue;
      }
      const created = await manager.createCheckpoint(turnIndex);
      if (!created) {
        this.log?.(
          `[checkpoint] Failed to capture project '${project.name}'; continuing without checkpoint coverage for that root.`,
        );
        continue;
      }
      if (projectId === primaryProjectId || createdCheckpointId === undefined) {
        createdCheckpointId = created.id;
      }
      existingSnapshots.set(projectId, {
        projectId,
        commitHash: created.commitHash,
        createdAt: created.createdAt,
      });
      changed = true;
    }

    if (!changed && existingCheckpoint) return null;
    const snapshots = [...existingSnapshots.values()];
    const primarySnapshot =
      existingSnapshots.get(primaryProjectId) ?? snapshots[0];
    if (!primarySnapshot) return null;
    const checkpoint: Checkpoint = {
      id: existingCheckpoint?.id ?? createdCheckpointId ?? crypto.randomUUID(),
      projectId: primaryProjectId,
      commitHash: primarySnapshot.commitHash,
      turnIndex,
      createdAt: Math.max(...snapshots.map((snapshot) => snapshot.createdAt)),
      projectSnapshots: snapshots,
    };

    if (existingIndex !== -1) {
      const next = [...existing];
      next[existingIndex] = checkpoint;
      this.checkpoints.set(session.id, next);
      return checkpoint;
    }

    this.checkpoints.set(session.id, [...existing, checkpoint]);
    this.recordAndEmitEvent(session.id, {
      type: "checkpoint_created",
      checkpointId: checkpoint.id,
      turnIndex,
    });
    return checkpoint;
  }

  private getEngine(): AgentEngine {
    if (!this.engine) {
      this.engine = this.host.createEngine(this.host.providers, this.log);
    }
    return this.engine;
  }

  updateConfig(config: Partial<AgentConfig>): void {
    Object.assign(this.config, config);
  }

  private getCondenseThresholdForModel(
    model: string,
    scope?: Readonly<SessionProjectScope>,
  ): number {
    try {
      return this.host.config.getCondenseThresholdForModel(model, scope);
    } catch (err) {
      this.log?.(
        `[agent] Failed to resolve configured condense threshold for ${model}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return getEffectiveAutoCondenseThreshold(
        model,
        undefined,
        this.host.providers.tryResolveProvider(model)?.getCapabilities(model),
      );
    }
  }

  private buildConfigForModel(
    model: string,
    scope?: Readonly<SessionProjectScope>,
  ): AgentConfig {
    const base = {
      ...this.config,
      model,
      autoCondenseThreshold: this.getCondenseThresholdForModel(model, scope),
    };
    if (!scope || !this.host.config.resolveAgentConfig) return base;
    try {
      return this.host.config.resolveAgentConfig(base, scope);
    } catch (err) {
      this.log?.(
        `[agent] Failed to resolve project agent config: ${err instanceof Error ? err.message : String(err)}`,
      );
      return base;
    }
  }

  private getModelForMode(
    mode: string,
    scope?: Readonly<SessionProjectScope>,
  ): string {
    try {
      return this.resolveAvailableModelId(
        this.host.config.resolveModelForMode(mode, this.config.model, scope),
      );
    } catch (err) {
      this.log?.(
        `[agent] Failed to resolve configured model for mode ${mode}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return this.resolveAvailableModelId(this.config.model);
    }
  }

  private resolveAvailableModelId(model: string): string {
    return this.host.providers.resolveAvailableModel(model)?.model ?? model;
  }

  private getReasoningEffortForMode(
    mode: string,
    scope?: Readonly<SessionProjectScope>,
  ): ReasoningEffort {
    try {
      return (
        this.host.config.resolveReasoningEffortForMode?.(mode, scope) ?? "high"
      );
    } catch (err) {
      this.log?.(
        `[agent] Failed to resolve configured reasoning effort for mode ${mode}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return "high";
    }
  }

  private applyReasoningEffortToSession(
    session: AgentSession,
    effort: ReasoningEffort,
  ): void {
    session.reasoningEffort = effort;
    if (effort === "none") {
      session.thinkingBudget = 0;
    } else if (session.thinkingBudget === 0) {
      session.thinkingBudget = this.config.thinkingBudget;
    }
  }

  private applyThresholdToSession(session: AgentSession): void {
    session.autoCondenseThreshold = this.getCondenseThresholdForModel(
      session.model,
      session.projectScope,
    );
  }

  private buildMcpToolDisclosure(
    context: Pick<ToolDispatchContext, "mcpHub"> | undefined = this.toolCtx,
  ): McpToolDisclosurePartition | undefined {
    const mcpHub = context?.mcpHub;
    if (!mcpHub) return undefined;
    const tools = mcpHub.getToolDefs();
    if (tools.length === 0) return undefined;
    const serverNames = new Set(
      tools
        .map((tool) => parseMcpToolName(tool.name)?.serverName)
        .filter((name): name is string => name !== undefined),
    );
    const serverConfigs = [...serverNames].map((serverName) => ({
      serverName,
      mode: mcpHub.getServerConfig(serverName)?.toolDisclosure,
    }));
    return partitionMcpToolsForDisclosure(tools, { serverConfigs });
  }

  private refreshMcpToolDisclosure(
    session: AgentSession,
    context?: Pick<ToolDispatchContext, "mcpHub">,
  ): void {
    const currentContext =
      context ??
      (() => {
        const generation = this.projectMcpHubRegistry?.getCurrent(
          session.projectScope,
        );
        return generation ? { mcpHub: generation.hub } : undefined;
      })();
    session.mcpToolDisclosure = this.buildMcpToolDisclosure(currentContext);
  }

  getConfig(): AgentConfig {
    return this.config;
  }

  getWorkspaceProjects(): readonly WorkspaceProject[] {
    if (!this.executionUnavailableReason)
      return this.projectCatalog.listProjects();
    return this.projectCatalog.listProjects().map((project) => ({
      ...project,
      rootPath: undefined,
      availability: {
        status: "unavailable" as const,
        reason: "root_unavailable" as const,
        message: this.executionUnavailableReason!,
      },
    }));
  }

  getDefaultProjectScope(): SessionProjectScope | undefined {
    if (this.executionUnavailableReason) return undefined;
    const selection = selectNewSessionProject(this.projectCatalog, {
      browserPreferredProjectId: this.browserPreferredProjectId,
    });
    return selection.status === "selected" ? selection.scope : undefined;
  }

  setBrowserPreferredProject(projectId: string): boolean {
    const project = this.projectCatalog
      .listProjects()
      .find((candidate) => candidate.id === projectId);
    if (!project || project.availability.status !== "available") return false;
    if (this.browserPreferredProjectId === projectId) return true;
    this.browserPreferredProjectId = projectId;
    this.notifySessionsChanged();
    Promise.resolve(this.onBrowserPreferredProjectChanged?.(projectId)).catch(
      (error: unknown) => {
        this.log?.(
          `[browser] failed to persist preferred project ${projectId}: ${error}`,
        );
      },
    );
    return true;
  }

  async createForegroundSession(
    mode: string,
    opts?: { activeFilePath?: string; projectId?: string },
  ): Promise<AgentSession> {
    await this.discardEmptyForegroundSession();
    return this.createSession(mode, opts);
  }

  async createSession(
    mode: string,
    opts?: { activeFilePath?: string; projectId?: string },
  ): Promise<AgentSession> {
    const projectScope = this.selectProjectScope({
      explicitProjectId: opts?.projectId,
      activeFilePath: opts?.activeFilePath,
    });
    const model = this.getModelForMode(mode, projectScope);
    const config = this.buildConfigForModel(model, projectScope);
    const providerId = this.host.providers.tryResolveProvider(config.model)?.id;
    this.updateConfig({
      model,
      autoCondenseThreshold: config.autoCondenseThreshold,
    });
    const projectMcpGeneration =
      this.projectMcpHubRegistry?.getCurrent(projectScope);
    const session = await this.createBoundSession({
      mode,
      config,
      projectScope,
      workspaceFolders: this.getWorkspaceFolders(),
      devMode: this.devMode,
      activeFilePath: opts?.activeFilePath,
      activeContextResourceUri: opts?.activeFilePath
        ? pathToFileURL(opts.activeFilePath).toString()
        : undefined,
      providerId,
      mcpToolDisclosure: this.buildMcpToolDisclosure(
        projectMcpGeneration ? { mcpHub: projectMcpGeneration.hub } : undefined,
      ),
    });
    this.applyReasoningEffortToSession(
      session,
      this.getReasoningEffortForMode(mode, projectScope),
    );
    this.sessions.set(session.id, session);
    this.getCheckpointManagerForSession(session);
    const pendingApprovalMode = this.sessionApprovalModes.get("agent");
    if (pendingApprovalMode) {
      this.sessionApprovalModes.set(session.id, pendingApprovalMode);
      this.sessionApprovalModes.delete("agent");
    }
    this.foregroundId = session.id;
    this.notifySessionsChanged();
    return session;
  }

  /**
   * Rebuild the system prompt for all active foreground sessions.
   * Called when instruction files (AGENTS.md, CLAUDE.md, etc.) change on disk.
   */
  async rebuildSystemPrompts(projectId?: string): Promise<void> {
    const fg = this.getForegroundSession();
    if (!fg || (projectId && fg.projectScope.projectId !== projectId)) return;
    this.requireSessionExecution(fg);
    this.refreshMcpToolDisclosure(fg);
    await fg.rebuildSystemPrompt({
      devMode: this.devMode,
      workspaceFolders: this.getWorkspaceFolders(),
    });
  }

  /**
   * Update the model on the active foreground session.
   * If the model crosses a provider boundary (e.g. Anthropic → Codex),
   * updates the session's providerId and rebuilds the system prompt so
   * provider-specific behavioral tuning takes effect.
   */
  async setModel(model: string): Promise<string> {
    const fg = this.getForegroundSession();
    if (fg) this.requireSessionExecution(fg);
    const requestedModel = model;
    model = this.resolveAvailableModelId(model);
    this.updateConfig({
      model,
      autoCondenseThreshold: this.getCondenseThresholdForModel(
        model,
        fg?.projectScope,
      ),
    });
    if (!fg) return model;

    fg.model = model;
    this.applyThresholdToSession(fg);
    const newProviderId = this.host.providers.tryResolveProvider(model)?.id;
    if (newProviderId !== fg.providerId) {
      fg.providerId = newProviderId;
      await fg.rebuildSystemPrompt({
        devMode: this.devMode,
        workspaceFolders: this.getWorkspaceFolders(),
      });
    }
    await this.maybeAutoCondenseForegroundSession();
    if (requestedModel !== model) {
      this.log?.(
        `[model] migrated retired model "${requestedModel}" to "${model}"`,
      );
    }
    return model;
  }

  getSession(id: string): AgentSession | undefined {
    return this.sessions.get(id);
  }

  getCommandApprovalPolicy(
    sessionId: string,
    fallback: CommandApprovalPolicy = "safe",
  ): CommandApprovalPolicy {
    return (
      this.sessionApprovalModes.get(sessionId)?.commandApprovalPolicy ??
      fallback
    );
  }

  getSessionApprovalMode(
    sessionId: string,
    fallback: CommandApprovalPolicy = "safe",
  ): SessionApprovalMode {
    return (
      this.sessionApprovalModes.get(sessionId) ??
      approvalModeFromLegacyPolicy(fallback)
    );
  }

  setSessionApprovalMode(sessionId: string, mode: SessionApprovalMode): void {
    if (!this.sessions.has(sessionId) && sessionId !== "agent") return;
    this.sessionApprovalModes.set(sessionId, Object.freeze({ ...mode }));
    if (sessionId !== "agent") this.saveSession(sessionId);
    this.notifySessionsChanged();
  }

  setCommandApprovalPolicy(
    sessionId: string,
    policy: CommandApprovalPolicy,
  ): void {
    if (!this.sessions.has(sessionId) && sessionId !== "agent") return;
    this.setSessionApprovalMode(
      sessionId,
      approvalModeFromLegacyPolicy(policy),
    );
  }

  clearSessionCommandApprovalPolicy(sessionId: string): void {
    if (!this.sessionApprovalModes.delete(sessionId)) return;
    if (sessionId !== "agent") this.saveSession(sessionId);
    this.notifySessionsChanged();
  }

  setForegroundReasoningEffort(effort: ReasoningEffort): boolean {
    const session = this.getForegroundSession();
    if (!session) return false;

    this.applyReasoningEffortToSession(session, effort);
    this.saveSession(session.id);
    this.notifySessionsChanged();
    return true;
  }

  saveAllSessions(): void {
    for (const [id, session] of this.sessions) {
      if (this.isEmptyForegroundSession(session)) continue;
      this.saveSession(id);
    }
  }

  private isEmptyForegroundSession(session: AgentSession): boolean {
    return (
      !session.background &&
      session.status === "idle" &&
      session.messageCount === 0 &&
      !this.sessionRevertPending.has(session.id) &&
      (this.checkpoints.get(session.id)?.length ?? 0) === 0
    );
  }

  private async discardEmptyForegroundSession(): Promise<void> {
    const session = this.getForegroundSession();
    if (!session || !this.isEmptyForegroundSession(session)) return;

    if (this.persistence?.get(session.id)) {
      const result = await this.deletePersistedSessionWithResult(session.id);
      if (!result.ok && result.reason !== "not_found") return;
    }

    this.sessions.delete(session.id);
    this.sessionApprovalModes.delete(session.id);
    this.retainedCommandReviewDenials.clearSession(session.id);
    this.sessionRevisions.delete(session.id);
    this.sessionSaveQueues.delete(session.id);
    if (this.foregroundId === session.id) {
      this.foregroundId = null;
    }
  }

  saveSession(id: string): void {
    if (!this.persistence || !this.sessions.has(id)) return;

    if (typeof this.persistence.saveSession !== "function") {
      const session = this.sessions.get(id);
      if (session) this.saveSessionLegacy(session);
      return;
    }

    const run = () => this.saveSessionRevisionAware(id);
    const previous = this.sessionSaveQueues.get(id);
    const next = previous ? previous.then(run, run) : run();
    const tracked = next.finally(() => {
      if (this.sessionSaveQueues.get(id) === tracked) {
        this.sessionSaveQueues.delete(id);
      }
    });
    tracked.catch(() => undefined);
    this.sessionSaveQueues.set(id, tracked);
  }

  private saveSessionLegacy(session: AgentSession): void {
    this.persistence?.save({
      id: session.id,
      mode: session.mode,
      model: session.model,
      title: session.title,
      createdAt: session.createdAt,
      lastActiveAt: session.lastActiveAt,
      totalInputTokens: session.totalInputTokens,
      totalOutputTokens: session.totalOutputTokens,
      totalCacheReadTokens: session.totalCacheReadTokens,
      totalCacheCreationTokens: session.totalCacheCreationTokens,
      lastInputTokens: session.lastInputTokens,
      lastCacheReadTokens: session.lastCacheReadTokens,
      reasoningEffort: session.reasoningEffort,
      ...this.getSessionApprovalMode(session.id),
      background: session.background,
      projectScope: session.projectScope,
      activeContextResourceUri: session.activeContextResourceUri,
      getLoadedSkills: () => session.getLoadedSkills?.() ?? [],
      getAllMessages: () => session.getAllMessages(),
      checkpoints: this.checkpoints.get(session.id) ?? [],
    });
    this.notifySessionChangeListeners();
  }

  private async saveSessionRevisionAware(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session || !this.persistence) return;
    await this.saveSessionRecordRevisionAware(
      id,
      this.buildPersistedSessionRecord(session),
    );
  }

  private async saveSessionNow(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session || !this.persistence) return;
    // Capture an immutable record at call time so runState transitions cannot be
    // lost if the live session mutates before this queued write executes.
    const record = this.buildPersistedSessionRecord(session);
    const run = () => this.saveSessionRecordRevisionAware(id, record);
    const previous = this.sessionSaveQueues.get(id);
    const next = previous ? previous.then(run, run) : run();
    const tracked = next.finally(() => {
      if (this.sessionSaveQueues.get(id) === tracked) {
        this.sessionSaveQueues.delete(id);
      }
    });
    this.sessionSaveQueues.set(id, tracked);
    await tracked;
  }

  private async saveSessionRecordRevisionAware(
    id: string,
    record: PersistedSessionRecord,
  ): Promise<void> {
    if (!this.persistence) return;

    const expectedRevision = this.sessionRevisions.get(id) ?? null;
    let result;
    try {
      result = await this.persistence.saveSession({
        session: record,
        expectedRevision,
      });
    } catch (error) {
      this.log?.(
        `[session] persistence save failed for ${id}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }

    if (result.ok) {
      this.sessionRevisions.set(id, result.revision);
      this.notifySessionChangeListeners();
      return;
    }

    if (result.reason === "conflict") {
      this.sessionRevisions.set(id, result.currentRevision);
      this.log?.(
        `[session] persistence conflict for ${id}: expected=${expectedRevision ?? "<create>"} current=${result.currentRevision}`,
      );
      return;
    }

    this.log?.(
      `[session] persistence save failed for ${id}: ${result.reason}${"message" in result ? `: ${result.message}` : ""}`,
    );
  }

  private buildPersistedSessionRecord(
    session: AgentSession,
    opts?: {
      messages?: AgentMessage[];
      checkpoints?: Checkpoint[];
      revertPending?: RevertRecoveryState | null;
    },
  ): PersistedSessionRecord {
    const messages = opts?.messages ?? session.getAllMessages();
    const revertPending =
      opts?.revertPending === null
        ? undefined
        : (opts?.revertPending ?? this.sessionRevertPending.get(session.id));
    return {
      summary: {
        schemaVersion: 1,
        id: session.id,
        mode: session.mode,
        model: session.model,
        title: session.title,
        messageCount: messages.length,
        totalInputTokens: session.totalInputTokens,
        totalOutputTokens: session.totalOutputTokens,
        createdAt: session.createdAt,
        lastActiveAt: session.lastActiveAt,
        background: session.background,
        projectScope: session.projectScope,
      },
      messages,
      metadata: {
        projectScope: session.projectScope,
        activeContextResourceUri: session.activeContextResourceUri,
        mode: session.mode,
        model: session.model,
        ...this.getSessionApprovalMode(session.id),
        totalInputTokens: session.totalInputTokens,
        totalOutputTokens: session.totalOutputTokens,
        totalCacheReadTokens: session.totalCacheReadTokens,
        totalCacheCreationTokens: session.totalCacheCreationTokens,
        lastInputTokens: session.lastInputTokens,
        lastCacheReadTokens: session.lastCacheReadTokens,
        reasoningEffort: session.reasoningEffort,
        loadedSkills: session.getLoadedSkills?.() ?? [],
        runState: session.runState
          ? { ...session.runState, projectId: session.projectScope.projectId }
          : undefined,
        fleet: session.fleetMetadata
          ? {
              ...structuredClone(session.fleetMetadata),
              projectId: session.projectScope.projectId,
            }
          : undefined,
        checkpointState: {
          projectId: session.projectScope.projectId,
          baseCommit:
            this.peekCheckpointManagerForSession(session)?.baseCommit ?? null,
          checkpoints:
            opts?.checkpoints ?? this.checkpoints.get(session.id) ?? [],
        },
        revertPending: revertPending
          ? {
              ...revertPending,
              projectId: session.projectScope.projectId,
            }
          : undefined,
      },
    };
  }

  getForegroundSession(): AgentSession | undefined {
    return this.foregroundId ? this.sessions.get(this.foregroundId) : undefined;
  }

  getSessionInfos(): SessionInfo[] {
    return Array.from(this.sessions.values()).map((s) => ({
      id: s.id,
      status: s.status,
      mode: s.mode,
      model: s.model,
      title: s.title,
      messageCount: s.messageCount,
      totalInputTokens: s.totalInputTokens,
      totalOutputTokens: s.totalOutputTokens,
      background: s.background,
      createdAt: s.createdAt,
      lastActiveAt: s.lastActiveAt,
      projectScope: s.projectScope,
      projectAvailability: s.projectAvailability,
    }));
  }

  async runBtwQuestion(
    question: string,
    opts?: BtwQuestionOptions,
  ): Promise<BtwQuestionResult> {
    const trimmed = question.trim();
    if (!trimmed) throw new Error("/btw requires a question");
    if (!this.toolCtx) throw new Error("No tool context — cannot run /btw");
    if (this.btwInFlight) {
      throw new Error("Another /btw question is already running");
    }

    // Already-cancelled before we start: the engine creates its own abort
    // controller on first iteration, so a pre-aborted external signal would
    // otherwise be lost. Return a cancelled result without spinning anything up.
    if (opts?.signal?.aborted) {
      return {
        answer: "",
        toolCalls: [],
        warnings: [],
        inputTokens: 0,
        outputTokens: 0,
        cancelled: true,
        apiTurns: 0,
        maxApiTurns: BTW_MAX_API_TURNS,
        toolCallCount: 0,
        maxToolCalls: BTW_MAX_TOOL_CALLS,
      };
    }

    const fg = this.getForegroundSession();
    if (fg) this.requireSessionExecution(fg);

    const mode = fg?.mode ?? "code";
    const model = fg?.model ?? this.config.model;
    const providerId =
      fg?.providerId ?? this.host.providers.tryResolveProvider(model)?.id;
    const config: AgentConfig = fg
      ? {
          ...this.buildConfigForModel(model),
          maxTokens: fg.maxTokens,
          thinkingBudget: fg.thinkingBudget,
          autoCondense: fg.autoCondense,
          autoCondenseThreshold: fg.autoCondenseThreshold,
          codexStatefulResponses: fg.codexStatefulResponses,
          codexStoreResponses: fg.codexStoreResponses,
          codexProMode: fg.codexProMode,
        }
      : this.buildConfigForModel(model);

    const projectScope = fg?.projectScope ?? this.selectProjectScope();
    const session = await this.createBoundSession({
      mode,
      agentMode: fg?.agentMode,
      config,
      projectScope,
      workspaceFolders: this.getWorkspaceFolders(),
      devMode: this.devMode,
      activeFilePath: fg?.activeFilePath,
      activeContextResourceUri: fg?.activeContextResourceUri,
      providerId,
    });

    session.title = `/btw ${trimmed}`.slice(0, 80);
    session.reasoningEffort = fg?.reasoningEffort ?? session.reasoningEffort;
    if (fg) {
      session.systemPrompt = fg.systemPrompt;
      session.replaceMessages(
        structuredClone(fg.getMessages()) as AgentMessage[],
      );
    }
    const engine = this.host.createEngine(this.host.providers, this.log);
    const preparedTurn = await this.prepareTurnExecution(session, {
      overrides: {
        onModeSwitch: undefined,
        onApprovalRequest: undefined,
        onQuestion: undefined,
        onSpawnBackground: undefined,
        onGetBackgroundStatus: undefined,
        onGetBackgroundResult: undefined,
        onKillBackground: undefined,
        onFinalStatus: undefined,
      },
      inheritedContext: fg
        ? this.activeRequestToolContexts.get(fg.id)
        : undefined,
    });
    const sideCtx = this.bindCapturedEngineToSession(
      engine,
      session,
      preparedTurn.context,
    );

    session.addUserMessage(trimmed, {
      displayText: `/btw ${trimmed}`,
      isSlashCommand: true,
      slashCommandLabel: "/btw",
    });
    session.status = "streaming";

    let answer = "";
    const toolCalls: BtwQuestionResult["toolCalls"] = [];
    const warnings: string[] = [];
    let apiTurns = 0;
    let cancelled = false;

    // Cancellation: abort the side session from either the external signal
    // (Cancel button) or the deadline timer. The engine's run() loop checks
    // session.isAborted between turns and after each tool dispatch.
    const cancel = () => {
      if (cancelled) return;
      cancelled = true;
      session.abort();
    };
    const timeoutMs = opts?.timeoutMs ?? BTW_DEFAULT_TIMEOUT_MS;
    const deadline =
      timeoutMs > 0
        ? this.host.timers.setTimeout(cancel, timeoutMs)
        : undefined;
    const externalSignal = opts?.signal;
    const onExternalAbort = () => cancel();
    if (externalSignal) {
      if (externalSignal.aborted) cancel();
      else externalSignal.addEventListener("abort", onExternalAbort);
    }

    const emitBudget = () => {
      opts?.onProgress?.({
        type: "budget",
        apiTurns,
        toolCalls: toolCalls.length,
        maxApiTurns: BTW_MAX_API_TURNS,
        maxToolCalls: BTW_MAX_TOOL_CALLS,
      });
    };

    this.btwInFlight = true;
    try {
      for await (const event of engine.run(session, {
        toolProfile: "btw",
        maxApiTurns: BTW_MAX_API_TURNS,
        maxToolCalls: BTW_MAX_TOOL_CALLS,
        webAccessPolicy: preparedTurn.policy,
        mcpToolDisclosure: preparedTurn.mcpToolDisclosure,
        mcpToolDefinitions: preparedTurn.mcpToolDefinitions,
      })) {
        switch (event.type) {
          case "text_delta":
            answer += event.text;
            opts?.onProgress?.({ type: "text_delta", text: event.text });
            break;
          case "api_request":
            apiTurns += 1;
            emitBudget();
            break;
          case "tool_result":
            toolCalls.push({
              toolName: event.toolName,
              durationMs: event.durationMs,
            });
            opts?.onProgress?.({ type: "tool", toolName: event.toolName });
            emitBudget();
            break;
          case "warning":
            warnings.push(event.message);
            opts?.onProgress?.({ type: "warning", message: event.message });
            break;
          case "error":
            throw new Error(event.error);
        }
      }
    } finally {
      this.releaseSessionToolContext(session.id, sideCtx);
      this.btwInFlight = false;
      if (deadline) this.host.timers.clearTimeout(deadline);
      externalSignal?.removeEventListener("abort", onExternalAbort);
    }

    return {
      answer: session.getLastAssistantText() ?? answer,
      toolCalls,
      warnings,
      inputTokens: session.totalInputTokens,
      outputTokens: session.totalOutputTokens,
      cancelled,
      apiTurns,
      maxApiTurns: BTW_MAX_API_TURNS,
      toolCallCount: toolCalls.length,
      maxToolCalls: BTW_MAX_TOOL_CALLS,
    };
  }

  /**
   * Run the transient agent behind /worktree. Unlike /btw, this starts with a
   * lightweight, purpose-built prompt instead of cloning foreground history,
   * and it may use ask_user so configuration can happen in the Activity Shelf.
   */
  async runWorktreeSetup(
    initialDraft: Partial<WorktreeAgentLaunchRequest>,
    opts: WorktreeSetupOptions,
  ): Promise<WorktreeSetupResult> {
    if (!this.toolCtx) {
      throw new Error("No tool context — cannot configure a worktree");
    }
    if (!this.toolCtx.worktreeAgentLaunchProvider) {
      throw new Error("Worktree agent startup is unavailable in this window");
    }

    const fg = this.getForegroundSession();
    if (fg) this.requireSessionExecution(fg);
    const mode = "ask";
    const model = fg?.model ?? this.config.model;
    const providerId =
      fg?.providerId ?? this.host.providers.tryResolveProvider(model)?.id;
    const projectScope = fg?.projectScope ?? this.selectProjectScope();
    const session = await this.createBoundSession({
      mode,
      config: this.buildConfigForModel(model, projectScope),
      projectScope,
      workspaceFolders: this.getWorkspaceFolders(),
      devMode: this.devMode,
      providerId,
      lightweight: true,
    });
    session.title = "/worktree setup";
    session.reasoningEffort = "low";
    session.systemPrompt = WORKTREE_SETUP_SYSTEM_PROMPT;
    opts.onSessionStarted?.(session.id);

    if (opts.signal?.aborted) {
      return {
        sessionId: session.id,
        sourcePath: this.requireSessionExecution(session),
        answer: "",
        toolCalls: [],
        warnings: [],
        inputTokens: 0,
        outputTokens: 0,
        cancelled: true,
        apiTurns: 0,
        maxApiTurns: WORKTREE_SETUP_MAX_API_TURNS,
        toolCallCount: 0,
        maxToolCalls: WORKTREE_SETUP_MAX_TOOL_CALLS,
      };
    }

    const sourcePath = this.requireSessionExecution(session);
    const engine = this.host.createEngine(this.host.providers, this.log);
    const preparedTurn = await this.prepareTurnExecution(session, {
      overrides: {
        onModeSwitch: undefined,
        onApprovalRequest: undefined,
        onQuestion: undefined,
        onSpawnBackground: undefined,
        onGetBackgroundStatus: undefined,
        onGetBackgroundResult: undefined,
        onKillBackground: undefined,
        onFinalStatus: undefined,
      },
    });
    const sideCtx = this.bindCapturedEngineToSession(
      engine,
      session,
      preparedTurn.context,
    );
    session.addUserMessage(
      [
        `Repository: ${sourcePath}`,
        "Configure a new worktree agent from these supplied /worktree arguments:",
        JSON.stringify(initialDraft, null, 2),
        ...(opts.conversation?.length
          ? [
              "Setup conversation so far:",
              JSON.stringify(opts.conversation, null, 2),
            ]
          : []),
        "If task intent is missing, ask the user. Otherwise use sensible defaults and return the configuration envelope.",
      ].join("\n\n"),
      {
        displayText: "/worktree",
        isSlashCommand: true,
        slashCommandLabel: "/worktree",
      },
    );
    session.status = "streaming";

    let answer = "";
    const toolCalls: WorktreeSetupResult["toolCalls"] = [];
    const warnings: string[] = [];
    let apiTurns = 0;
    let cancelled = false;
    const cancel = () => {
      if (cancelled) return;
      cancelled = true;
      session.abort();
    };
    const externalSignal = opts.signal;
    const onExternalAbort = () => cancel();
    if (externalSignal) {
      if (externalSignal.aborted) cancel();
      else externalSignal.addEventListener("abort", onExternalAbort);
    }
    const emitBudget = () =>
      opts.onProgress?.({
        type: "budget",
        apiTurns,
        toolCalls: toolCalls.length,
        maxApiTurns: WORKTREE_SETUP_MAX_API_TURNS,
        maxToolCalls: WORKTREE_SETUP_MAX_TOOL_CALLS,
      });

    try {
      for await (const event of engine.run(session, {
        toolProfile: "worktree-setup",
        maxApiTurns: WORKTREE_SETUP_MAX_API_TURNS,
        maxToolCalls: WORKTREE_SETUP_MAX_TOOL_CALLS,
        webAccessPolicy: preparedTurn.policy,
        mcpToolDisclosure: preparedTurn.mcpToolDisclosure,
        mcpToolDefinitions: preparedTurn.mcpToolDefinitions,
      })) {
        switch (event.type) {
          case "text_delta":
            answer += event.text;
            opts.onProgress?.({ type: "text_delta", text: event.text });
            break;
          case "api_request":
            apiTurns += 1;
            emitBudget();
            break;
          case "tool_result":
            toolCalls.push({
              toolName: event.toolName,
              durationMs: event.durationMs,
            });
            opts.onProgress?.({ type: "tool", toolName: event.toolName });
            emitBudget();
            break;
          case "warning":
            warnings.push(event.message);
            opts.onProgress?.({ type: "warning", message: event.message });
            break;
          case "error":
            throw new Error(event.error);
        }
      }
    } finally {
      this.releaseSessionToolContext(session.id, sideCtx);
      externalSignal?.removeEventListener("abort", onExternalAbort);
    }

    return {
      sessionId: session.id,
      sourcePath,
      answer: session.getLastAssistantText() ?? answer,
      toolCalls,
      warnings,
      inputTokens: session.totalInputTokens,
      outputTokens: session.totalOutputTokens,
      cancelled,
      apiTurns,
      maxApiTurns: WORKTREE_SETUP_MAX_API_TURNS,
      toolCallCount: toolCalls.length,
      maxToolCalls: WORKTREE_SETUP_MAX_TOOL_CALLS,
    };
  }

  startWorktreeAgent(
    request: WorktreeAgentLaunchRequest,
    options?: import("../core/capabilities/worktree.js").WorktreeAgentLaunchOptions,
  ): Promise<ToolResult> {
    const provider = this.toolCtx?.worktreeAgentLaunchProvider;
    if (!provider) {
      throw new Error("Worktree agent startup is unavailable in this window");
    }
    return provider.start(request, options);
  }

  async sendMessage(
    sessionId: string | undefined,
    text: string,
    mode: string,
    opts?: {
      thinkingEnabled?: boolean;
      reasoningEffort?: import("./providers/types.js").ReasoningEffort;
      activeFilePath?: string;
      displayText?: string;
      isSlashCommand?: boolean;
      slashCommandLabel?: string;
      origin?: "vscode" | "browser";
      images?: Array<{ name: string; mimeType: string; base64: string }>;
      documents?: Array<{ name: string; mimeType: string; base64: string }>;
      additionalMessages?: Array<{
        text: string;
        displayText?: string;
        isSlashCommand?: boolean;
        slashCommandLabel?: string;
        origin?: "vscode" | "browser";
        images?: Array<{ name: string; mimeType: string; base64: string }>;
        documents?: Array<{ name: string; mimeType: string; base64: string }>;
      }>;
    },
  ): Promise<void> {
    let session: AgentSession;

    if (sessionId && this.sessions.has(sessionId)) {
      session = this.sessions.get(sessionId)!;
    } else {
      session = await this.createSession(mode, {
        activeFilePath: opts?.activeFilePath,
      });
    }

    return this.withSessionSendQueue(session.id, async () => {
      this.requireSessionExecution(session);
      const previousRunSettled = this.sessionRunSettled.get(session.id);
      if (previousRunSettled) {
        await previousRunSettled;
      }

      const engine = this.getEngine();
      const preparedTurn = await this.prepareInteractiveTurnExecution(session);
      let requestToolContext = preparedTurn.context;
      requestToolContext = this.bindCapturedEngineToSession(
        engine,
        session,
        requestToolContext,
      );

      try {
        // Update reasoning effort. Legacy callers can still send thinkingEnabled.
        if (opts?.reasoningEffort) {
          session.reasoningEffort = opts.reasoningEffort;
        } else if (opts?.thinkingEnabled === false) {
          session.reasoningEffort = "none";
        } else if (session.reasoningEffort === "none") {
          session.reasoningEffort = "high";
        }

        // Keep the legacy budget field in sync for budget-based providers.
        if (session.reasoningEffort === "none") {
          session.thinkingBudget = 0;
        } else if (session.thinkingBudget === 0) {
          session.thinkingBudget = this.config.thinkingBudget;
        }

        // Create checkpoint before adding the next user message, but only after the
        // first turn — the initial message has no prior state worth restoring to.
        // `turnIndex` here means "how many visible user turns already exist at this
        // snapshot". Example: immediately before the second user message, turnIndex=1.
        // In the UI that checkpoint is displayed on the first user message.
        const turnIndex = session
          .getAllMessages()
          .filter(
            (m) => m.role === "user" && typeof m.content === "string",
          ).length;
        await this.ensureCheckpointForTurn(session, turnIndex, {
          refreshExisting: true,
        });

        // Clear any stale pending interjections from the previous run — if the
        // webview already drained the queue and sent this message via agentSend,
        // the old interjections would otherwise be re-emitted mid-turn as duplicates.
        while (session.consumePendingInterjection() !== null) {
          // drain
        }
        // Pasted images/PDFs are stored on the message itself so they're injected
        // into every API call (the API is stateless) and survive session restore.
        const priorUserTexts = session
          .getAllMessages()
          .filter(
            (message): message is AgentMessage & { content: string } =>
              message.role === "user" && typeof message.content === "string",
          )
          .map((message) => message.content);
        const messagesToAdd = [
          {
            text,
            displayText: opts?.displayText,
            isSlashCommand: opts?.isSlashCommand,
            slashCommandLabel: opts?.slashCommandLabel,
            origin: opts?.origin,
            images: opts?.images,
            documents: opts?.documents,
          },
          ...(opts?.additionalMessages ?? []),
        ].filter(
          (message) =>
            message.text.trim().length > 0 ||
            (message.images?.length ?? 0) > 0 ||
            (message.documents?.length ?? 0) > 0,
        );
        if (messagesToAdd.length === 0) return;

        const previousMessageCount = session.messageCount;
        for (const message of messagesToAdd) {
          const memoryNudge =
            message.isSlashCommand === true || message.text.trim().length === 0
              ? { text: message.text, nudged: false }
              : applyMemoryCandidateNudge(
                  message.text,
                  priorUserTexts,
                  countMemoryNudges(priorUserTexts),
                );
          session.addUserMessage(memoryNudge.text, {
            displayText:
              message.displayText ??
              (memoryNudge.nudged ? message.text : undefined),
            isSlashCommand: message.isSlashCommand === true,
            slashCommandLabel: message.slashCommandLabel,
            origin: message.origin,
            images: message.images,
            documents: message.documents,
          });
          priorUserTexts.push(memoryNudge.text);
          if (message.images?.length || message.documents?.length) {
            this.log?.(
              `[media] attached media to user message: images=${message.images?.length ?? 0} documents=${message.documents?.length ?? 0} totalRawMessages=${session.messageCount}`,
            );
          }
        }

        session.status = "streaming";
        if (!session.background) {
          session.runState = { phase: "running", startedAt: Date.now() };
        }

        if (previousMessageCount === 0) {
          session.autoTitle();
        }

        // Persist immediately so the session appears in history even if the
        // API call fails (e.g. network error, auth failure on the first message).
        await this.saveSessionNow(session.id);
        let lastPersistedActiveAt = session.lastActiveAt;

        const persistIfHistoryChanged = () => {
          if (session.lastActiveAt !== lastPersistedActiveAt) {
            this.saveSession(session.id);
            lastPersistedActiveAt = session.lastActiveAt;
          }
        };

        // Keep checkpointing in-flight turns so reloads don't drop recent transcript
        // progress. The guard above avoids writes unless message history changed.
        const inFlightPersistTimer = this.host.timers.setInterval(
          persistIfHistoryChanged,
          1000,
        );

        this.notifySessionsChanged();

        const MAX_AUTO_CONTINUE = 5;
        let autoContinueCount = 0;
        let modeSwitchResumeCount = 0;
        let lastTodos: TodoItem[] = [];

        let resolveRunSettled!: () => void;
        const runSettled = new Promise<void>((resolve) => {
          resolveRunSettled = resolve;
        });
        this.sessionRunSettled.set(session.id, runSettled);

        let runAbortGeneration = session.abortGeneration;
        try {
          while (true) {
            let naturalDone = false;
            let explicitFinalMarker = false;
            runAbortGeneration = session.abortGeneration;

            for await (const event of engine.run(session, {
              webAccessPolicy: preparedTurn.policy,
              mcpToolDisclosure: preparedTurn.mcpToolDisclosure,
              mcpToolDefinitions: preparedTurn.mcpToolDefinitions,
            })) {
              if (
                session.isAborted ||
                session.abortGeneration !== runAbortGeneration
              ) {
                break;
              }
              if (event.type === "todo_update") {
                lastTodos = event.todos;
              }
              if (event.type === "final_marker") {
                explicitFinalMarker = true;
              }
              if (event.type === "done") {
                this.saveSession(session.id);
                naturalDone = true;
                // Don't forward yet — check for pending todos first
                continue;
              }
              this.recordAndEmitEvent(session.id, event);

              // After forwarding a user_interjection event, create a checkpoint so
              // the user can revert to the state immediately before that injected
              // turn. Because the message already exists in webview state at this
              // point, the checkpoint will render on the preceding user message.
              if (event.type === "user_interjection") {
                // The interjection is already present in the transcript here, so
                // length - 1 gives the index of that injected user turn.
                const interjectionTurnIndex =
                  session
                    .getAllMessages()
                    .filter(
                      (m) => m.role === "user" && typeof m.content === "string",
                    ).length - 1;
                await this.ensureCheckpointForTurn(
                  session,
                  interjectionTurnIndex,
                );
              }
            }

            // Aborted — let ChatViewProvider handle the done notification
            if (
              session.isAborted ||
              session.abortGeneration !== runAbortGeneration
            ) {
              break;
            }

            const modeResumePrompt = naturalDone
              ? this.takeModeSwitchResumePrompt(session, modeSwitchResumeCount)
              : null;
            if (modeResumePrompt) {
              modeSwitchResumeCount++;
              session.addUserMessage(modeResumePrompt);
              session.status = "streaming";
              continue;
            }

            // Queued user messages take priority over auto-continue: emit the
            // deferred done instead so the UI surfaces flush their queues (and
            // any not-yet-drained interjection is sent on the next run).
            const hasQueuedUserMessages =
              session.hasPendingInterjections === true ||
              session.hasQueuedUiMessages === true;
            if (
              naturalDone &&
              hasQueuedUserMessages &&
              hasPendingTodos(lastTodos)
            ) {
              this.log?.(
                "[agent] skipping auto-continue: a queued user message takes priority",
              );
            }

            // Check if we should auto-continue due to pending todos
            if (
              naturalDone &&
              !explicitFinalMarker &&
              !hasQueuedUserMessages &&
              autoContinueCount < MAX_AUTO_CONTINUE &&
              hasPendingTodos(lastTodos)
            ) {
              autoContinueCount++;
              this.log?.(
                `[agent] auto-continuing (${autoContinueCount}/${MAX_AUTO_CONTINUE}): pending todos remain`,
              );
              session.addUserMessage(
                "You stopped but there are still pending tasks. Continue with the remaining items.",
              );
              session.status = "streaming";
              continue;
            }

            const completedTurnIndex = session
              .getAllMessages()
              .filter(
                (m) => m.role === "user" && typeof m.content === "string",
              ).length;
            await this.ensureCheckpointForTurn(session, completedTurnIndex);
            if (!session.background) {
              session.runState = undefined;
            }
            await this.saveSessionNow(session.id);

            // Emit the deferred done
            this.recordAndEmitEvent(session.id, {
              type: "done",
              totalInputTokens: session.totalInputTokens,
              totalOutputTokens: session.totalOutputTokens,
              totalCacheReadTokens: session.totalCacheReadTokens,
              totalCacheCreationTokens: session.totalCacheCreationTokens,
            });
            break;
          }
        } catch (err: unknown) {
          if (
            session.isAborted ||
            session.abortGeneration !== runAbortGeneration
          ) {
            return;
          }
          const error = err instanceof Error ? err.message : String(err);
          session.status = "error";
          this.recordAndEmitEvent(session.id, {
            type: "error",
            error,
            retryable: false,
          });
          // Persist before emitting done so sendSessionList sees the saved session
          if (!session.background) {
            session.runState = undefined;
          }
          await this.saveSessionNow(session.id);
          this.recordAndEmitEvent(session.id, {
            type: "done",
            totalInputTokens: session.totalInputTokens,
            totalOutputTokens: session.totalOutputTokens,
            totalCacheReadTokens: session.totalCacheReadTokens,
            totalCacheCreationTokens: session.totalCacheCreationTokens,
          });
        } finally {
          this.host.timers.clearInterval(inFlightPersistTimer);
          persistIfHistoryChanged();
          if (this.sessionRunSettled.get(session.id) === runSettled) {
            this.sessionRunSettled.delete(session.id);
          }
          resolveRunSettled();
          this.notifySessionsChanged();
        }
      } finally {
        this.releaseSessionToolContext(session.id, requestToolContext);
      }
    });
  }

  /**
   * Kill a running background agent and return its partial output.
   * Called by the foreground agent via the kill_background_agent tool.
   */
  killBackground(
    sessionId: string,
    reason?: string,
  ): { killed: boolean; partialOutput?: string } {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { killed: false, partialOutput: "Session not found" };
    }
    if (!session.background) {
      return { killed: false, partialOutput: "Not a background session" };
    }
    const isRunning =
      session.status === "queued" ||
      session.status === "streaming" ||
      session.status === "tool_executing" ||
      session.status === "awaiting_approval";
    if (!isRunning) {
      return {
        killed: false,
        partialOutput:
          session.getLastAssistantText() ??
          "(background agent already finished)",
      };
    }

    this.log?.(
      `[bg-kill] session=${sessionId} reason="${reason ?? "no reason"}"`,
    );

    // Capture partial output before stopping
    const partialOutput =
      session.getLastAssistantText() ??
      this.bgStreamingText.get(sessionId) ??
      "(no output captured)";

    // Stop the session (marks as cancelled, aborts, resolves waiters)
    this.stopSession(sessionId);

    return { killed: true, partialOutput };
  }

  stopSession(sessionId: string): void {
    const childIds = Array.from(this.sessions.values())
      .filter(
        (candidate) =>
          candidate.fleetMetadata?.parentSessionId === sessionId &&
          candidate.background,
      )
      .map((candidate) => candidate.id);
    for (const childId of childIds) this.stopSession(childId);

    const session = this.sessions.get(sessionId);
    if (session) {
      const exchangeId = session.fleetMetadata?.worktreeExchangeId;
      const globalStoragePath = this.toolCtx?.globalStorageUri?.fsPath;
      if (exchangeId && globalStoragePath) {
        void new WorktreeFleetExchangeStore(globalStoragePath)
          .requestCancel(exchangeId)
          .catch((error) =>
            this.log?.(
              `[worktree-fleet] cancellation request failed: ${String(error)}`,
            ),
          );
      }
      this.bgLaunchQueue = this.bgLaunchQueue.filter(
        (queued) => queued.sessionId !== sessionId,
      );
      session.abort();
      session.status = "idle";
      session.runState = undefined;
      void this.saveSessionNow(session.id);
      // Mark bg sessions as cancelled so the UI can distinguish stop vs complete
      if (session.background) {
        this.bgCancelled.add(sessionId);
        this.markBgCompleted(sessionId);
        if (session.fleetMetadata) {
          session.fleetMetadata.lifecycle = "cancelled";
          session.fleetMetadata.terminalReason = "cancelled_by_user";
          session.fleetMetadata.finalResult =
            session.getLastAssistantText() ??
            this.bgStreamingText.get(sessionId) ??
            undefined;
          this.appendFleetEvent(session, "cancelled", "Agent cancelled");
        }
      }
      this.notifySessionsChanged();
    }
  }

  async persistPendingQuestionRecovery(
    sessionId: string,
    questionRequestId: string,
    context: string,
    questions: Question[],
    pendingQuestionRecovery: PendingQuestionRecoveryContext,
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || session.background) return;
    session.runState = {
      phase: "awaiting_question",
      startedAt: Date.now(),
      question: {
        ...pendingQuestionRecovery,
        questionRequestId,
        context,
        questions: structuredClone(questions),
      },
    };
    await this.saveSessionNow(session.id);
  }

  clearPendingQuestionRecovery(
    sessionId: string,
    questionRequestId: string,
  ): void {
    const session = this.sessions.get(sessionId);
    if (
      session?.runState?.phase !== "awaiting_question" ||
      session.runState.question.questionRequestId !== questionRequestId
    ) {
      return;
    }
    session.runState = { phase: "running", startedAt: Date.now() };
    void this.saveSessionNow(session.id);
  }

  getPendingQuestionRecovery(
    sessionId: string,
  ): PendingQuestionRecoveryState | null {
    const session = this.sessions.get(sessionId);
    if (session?.runState?.phase !== "awaiting_question") return null;
    return session.runState.question;
  }

  private isValidPendingQuestionRecovery(
    question: PendingQuestionRecoveryState,
  ): boolean {
    if (question.schemaVersion !== 1 || question.toolName !== "ask_user") {
      return false;
    }
    return question.assistantContent.some(
      (block) => block.type === "tool_use" && block.id === question.toolUseId,
    );
  }

  async answerRecoveredQuestion(
    sessionId: string,
    questionRequestId: string,
    response: QuestionResponse,
    modeSwitchProvider?: Parameters<
      typeof buildAskUserToolResult
    >[0]["modeSwitchProvider"],
  ): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session || session.background) return false;
    const runState = session.runState;
    if (
      runState?.phase !== "awaiting_question" ||
      runState.question.questionRequestId !== questionRequestId ||
      runState.question.toolName !== "ask_user"
    ) {
      return false;
    }
    if (session.status !== "idle" && session.status !== "error") return false;

    const question = runState.question;
    if (!this.isValidPendingQuestionRecovery(question)) {
      session.runState = { phase: "running", startedAt: Date.now() };
      await this.saveSessionNow(session.id);
      return false;
    }

    const toolResult = await buildAskUserToolResult({
      context: question.context,
      questions: question.questions,
      response,
      modeSwitchProvider,
    });
    session.appendAssistantTurn(structuredClone(question.assistantContent));
    const toolResultText =
      toolResult.content.find((block) => block.type === "text")?.text ??
      JSON.stringify(toolResult.content);
    session.appendToolResults([
      {
        type: "tool_result" as const,
        tool_use_id: question.toolUseId,
        content: toolResultText,
      },
    ]);
    session.runState = { phase: "running", startedAt: Date.now() };
    await this.saveSessionNow(session.id);
    void this.retrySession(session.id);
    return true;
  }

  async resumeInterruptedSession(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session || session.background || !session.runState) return false;
    if (session.runState.phase === "awaiting_question") return false;
    if (session.status !== "idle" && session.status !== "error") return false;

    const prompt = [
      "<interrupted_session_resume>",
      "This session was interrupted before the previous agent turn reached a final status (for example, the VS Code window reloaded or the computer restarted).",
      "Review the transcript and current workspace state, then continue from the most likely safe point.",
      "If a write, command, approval, or other tool operation may have been interrupted, inspect the current state before retrying and avoid duplicating completed work.",
      "</interrupted_session_resume>",
    ].join("\n");

    await this.sendMessage(session.id, prompt, session.mode, {
      displayText: "Resume interrupted session",
      isSlashCommand: true,
      slashCommandLabel: "/resume interrupted session",
    });
    return true;
  }

  /**
   * Retry the last turn of a session after an error (e.g. auth failure).
   * Re-creates the engine (which re-reads credentials) and re-runs the agent loop.
   */
  async retrySession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.requireSessionExecution(session);

    // Force re-creation of the engine so it picks up refreshed credentials
    this.engine = null;

    const engine = this.getEngine();
    const preparedTurn = await this.prepareInteractiveTurnExecution(session);
    const requestToolContext = this.bindCapturedEngineToSession(
      engine,
      session,
      preparedTurn.context,
    );

    session.status = "streaming";
    if (!session.background) {
      session.runState = { phase: "running", startedAt: Date.now() };
      await this.saveSessionNow(session.id);
    }
    let lastPersistedActiveAt = session.lastActiveAt;

    const persistIfHistoryChanged = () => {
      if (session.lastActiveAt !== lastPersistedActiveAt) {
        this.saveSession(session.id);
        lastPersistedActiveAt = session.lastActiveAt;
      }
    };

    const inFlightPersistTimer = this.host.timers.setInterval(
      persistIfHistoryChanged,
      1000,
    );
    this.notifySessionsChanged();

    let modeSwitchResumeCount = 0;
    try {
      while (true) {
        let naturalDone = false;
        for await (const event of engine.run(session, {
          webAccessPolicy: preparedTurn.policy,
          mcpToolDisclosure: preparedTurn.mcpToolDisclosure,
          mcpToolDefinitions: preparedTurn.mcpToolDefinitions,
        })) {
          if (event.type === "done") {
            // Defer done — a queued mode-switch resume may continue this turn.
            this.saveSession(session.id);
            naturalDone = true;
            continue;
          }
          this.recordAndEmitEvent(session.id, event);
        }

        // Aborted or the engine ended without done — nothing to resume.
        if (!naturalDone) break;

        const modeResumePrompt = this.takeModeSwitchResumePrompt(
          session,
          modeSwitchResumeCount,
        );
        if (modeResumePrompt) {
          modeSwitchResumeCount++;
          session.addUserMessage(modeResumePrompt);
          session.status = "streaming";
          continue;
        }

        if (!session.background) {
          session.runState = undefined;
        }
        await this.saveSessionNow(session.id);
        this.recordAndEmitEvent(session.id, {
          type: "done",
          totalInputTokens: session.totalInputTokens,
          totalOutputTokens: session.totalOutputTokens,
          totalCacheReadTokens: session.totalCacheReadTokens,
          totalCacheCreationTokens: session.totalCacheCreationTokens,
        });
        break;
      }
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err);
      session.status = "error";
      this.recordAndEmitEvent(session.id, {
        type: "error",
        error,
        retryable: false,
      });
      if (!session.background) {
        session.runState = undefined;
      }
      await this.saveSessionNow(session.id);
      this.recordAndEmitEvent(session.id, {
        type: "done",
        totalInputTokens: session.totalInputTokens,
        totalOutputTokens: session.totalOutputTokens,
        totalCacheReadTokens: session.totalCacheReadTokens,
        totalCacheCreationTokens: session.totalCacheCreationTokens,
      });
    } finally {
      this.releaseSessionToolContext(session.id, requestToolContext);
      this.host.timers.clearInterval(inFlightPersistTimer);
      persistIfHistoryChanged();
      this.notifySessionsChanged();
    }
  }

  switchTo(sessionId: string): void {
    if (this.sessions.has(sessionId)) {
      this.foregroundId = sessionId;
      this.notifySessionsChanged();
    }
  }

  /** Switch one session in-place without changing foreground ownership. */
  async switchSessionMode(
    sessionId: string,
    mode: string,
    opts?: { agentMode?: AgentMode; devMode?: boolean },
  ): Promise<AgentSession | null> {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    this.requireSessionExecution(session);

    const model = this.getModelForMode(mode, session.projectScope);
    const newProviderId = this.host.providers.tryResolveProvider(model)?.id;

    session.model = model;
    session.providerId = newProviderId;
    this.applyReasoningEffortToSession(
      session,
      this.getReasoningEffortForMode(mode, session.projectScope),
    );
    this.applyThresholdToSession(session);
    this.refreshMcpToolDisclosure(session);
    const agentMode =
      opts?.agentMode ??
      resolveMode(
        mode,
        await this.projectCustomizationRegistry.getModes(session.projectScope),
      );
    await session.setMode(mode, { ...opts, agentMode });

    if (!session.background && this.foregroundId === session.id) {
      this.updateConfig({
        model,
        autoCondenseThreshold: session.autoCondenseThreshold,
      });
    }

    this.notifySessionsChanged();
    this.saveSession(session.id);
    return session;
  }

  /** Switch the current foreground session while preserving its identity. */
  async switchForegroundMode(
    mode: string,
    opts?: { agentMode?: AgentMode; devMode?: boolean },
  ): Promise<AgentSession | null> {
    const session = this.getForegroundSession();
    if (!session) return null;
    return this.switchSessionMode(session.id, mode, opts);
  }

  queueModeSwitchResume(
    sessionId: string,
    mode: string,
    opts?: { reason?: string; followUp?: string },
  ): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.background) return;
    session.queuePendingModeResume(mode, opts);
  }

  /**
   * Consume a queued mode-switch resume and build the continuation prompt.
   * Returns null when nothing is queued or the per-turn resume budget is
   * exhausted. The drop is logged — a silently dropped resume looks to the
   * user like the agent stopping dead right after their answer.
   */
  private takeModeSwitchResumePrompt(
    session: AgentSession,
    resumesUsed: number,
  ): string | null {
    const pending = session.consumePendingModeResume();
    if (!pending) return null;
    if (resumesUsed >= MAX_MODE_SWITCH_RESUMES) {
      this.log?.(
        `[agent] dropped mode-switch resume to ${pending.mode}: limit ${MAX_MODE_SWITCH_RESUMES} reached for this turn`,
      );
      return null;
    }
    this.log?.(
      `[agent] auto-continuing (mode resume ${resumesUsed + 1}/${MAX_MODE_SWITCH_RESUMES}): resumed after switch to ${pending.mode}`,
    );
    const reason = pending.reason?.trim();
    const followUp = pending.followUp?.trim();
    const details = [
      `You just switched this session to ${pending.mode} mode.`,
      "Continue immediately in the new mode and start the next concrete implementation step now.",
    ];
    if (reason) {
      details.push(`Switch reason: ${reason}`);
    }
    if (followUp) {
      details.push(`User follow-up: ${followUp}`);
    }
    return details.join("\n");
  }

  /**
   * Manually condense the foreground session's context.
   * Emits condense or condense_error events via onEvent.
   */
  private buildPreservedContext(
    session: AgentSession,
    context: Readonly<ToolDispatchContext> | undefined,
  ): {
    toolNames: string[];
    mcpServerNames: string[];
    activeSkills: string[];
  } {
    this.refreshMcpToolDisclosure(session, context);
    const connectedMcpToolDefs = context?.mcpHub?.getToolDefs() ?? [];
    const providerMcpToolDefs =
      session.mcpToolDisclosure?.inlineTools ?? connectedMcpToolDefs;
    const rawTools = context
      ? [
          ...getAgentTools(session.agentMode, providerMcpToolDefs, false),
          todoTool,
        ]
      : undefined;
    return {
      toolNames: rawTools?.map((t) => t.name) ?? [],
      mcpServerNames: [
        ...new Set(
          connectedMcpToolDefs
            .map((t) => parseMcpToolName(t.name)?.serverName ?? "")
            .filter((name) => name.length > 0),
        ),
      ],
      activeSkills: [...session.loadedSkills],
    };
  }

  private async condenseSession(
    session: AgentSession,
    isAutomatic: boolean,
  ): Promise<void> {
    this.requireSessionExecution(session);
    const engine = this.getEngine();
    const requestToolContext = this.bindEngineToSession(engine, session);
    const preservedContext = this.buildPreservedContext(
      session,
      requestToolContext,
    );
    session.status = "streaming";
    this.notifySessionsChanged();

    try {
      for await (const event of engine.condenseSession(
        session,
        isAutomatic,
        undefined,
        preservedContext,
      )) {
        this.recordAndEmitEvent(session.id, event);
      }
      this.saveSession(session.id);
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err);
      this.recordAndEmitEvent(session.id, { type: "condense_error", error });
    } finally {
      this.releaseSessionToolContext(session.id, requestToolContext);
      session.status = "idle";
      this.notifySessionsChanged();
    }
  }

  async condenseCurrentSession(): Promise<void> {
    const session = this.getForegroundSession();
    if (!session) return;
    await this.withSessionSendQueue(session.id, () =>
      this.condenseSession(session, false),
    );
  }

  async maybeAutoCondenseForegroundSession(): Promise<void> {
    const session = this.getForegroundSession();
    if (!session || session.background) return;
    if (session.status !== "idle") return;
    if (!this.getEngine().isOverCondenseThreshold(session)) return;
    await this.condenseSession(session, true);
  }

  // ---------------------------------------------------------------------------
  // Checkpoints
  // ---------------------------------------------------------------------------

  /** Return all checkpoints for a session, in creation order. */
  getCheckpoints(sessionId: string): Checkpoint[] {
    return this.checkpoints.get(sessionId) ?? [];
  }

  /**
   * Create a checkpoint for the current workspace/session state on demand.
   * Returns null when no foreground session exists or checkpoint creation fails.
   */
  async createManualCheckpoint(): Promise<Checkpoint | null> {
    const session = this.getForegroundSession();
    if (!session) return null;
    this.requireSessionExecution(session);

    const turnIndex = session
      .getAllMessages()
      .filter((m) => m.role === "user" && typeof m.content === "string").length;
    if (turnIndex === 0) return null;

    return this.ensureCheckpointForTurn(session, turnIndex, {
      refreshExisting: true,
    });
  }

  private getCheckpointProjectSnapshots(checkpoint: Checkpoint): Array<{
    project: WorkspaceProject & { rootPath: string };
    snapshot: { projectId: string; commitHash: string; createdAt: number };
  }> {
    const snapshots = checkpoint.projectSnapshots?.length
      ? checkpoint.projectSnapshots
      : checkpoint.projectId
        ? [
            {
              projectId: checkpoint.projectId,
              commitHash: checkpoint.commitHash,
              createdAt: checkpoint.createdAt,
            },
          ]
        : [];
    const projects = new Map(
      this.projectCatalog
        .listProjects()
        .filter(
          (project): project is WorkspaceProject & { rootPath: string } =>
            project.availability.status === "available" &&
            project.rootPath !== undefined,
        )
        .map((project) => [project.id, project]),
    );
    return snapshots.flatMap((snapshot) => {
      const project = projects.get(snapshot.projectId);
      return project ? [{ project, snapshot }] : [];
    });
  }

  private prefixRevertPreview(
    projectName: string,
    preview: RevertPreview,
  ): RevertPreview {
    const prefix = (filePath: string) => `${projectName}/${filePath}`;
    return {
      modified: preview.modified.map(prefix),
      deleted: preview.deleted.map(prefix),
      restored: preview.restored.map(prefix),
    };
  }

  /**
   * Preview the files that would be affected by reverting to a checkpoint.
   */
  async previewRevert(
    sessionId: string,
    checkpointId: string,
  ): Promise<CheckpointRevertPreviewResult | null> {
    const session = this.sessions.get(sessionId);
    const checkpoint = this.findCheckpoint(sessionId, checkpointId);
    if (!session || !checkpoint) return null;
    this.requireSessionExecution(session);
    const preview: RevertPreview = { modified: [], deleted: [], restored: [] };
    const projectSnapshots = this.getCheckpointProjectSnapshots(checkpoint);
    const labelProjects = projectSnapshots.length > 1;
    for (const { project, snapshot } of projectSnapshots) {
      const manager = this.getCheckpointManagerForProject(project);
      if (
        typeof manager.initialize === "function" &&
        (await manager.initialize()) === false
      ) {
        return null;
      }
      const projectPreview = await manager.previewRevert({
        ...checkpoint,
        projectId: project.id,
        commitHash: snapshot.commitHash,
        createdAt: snapshot.createdAt,
      });
      if (!projectPreview) return null;
      const visiblePreview = labelProjects
        ? this.prefixRevertPreview(project.name, projectPreview)
        : projectPreview;
      preview.modified.push(...visiblePreview.modified);
      preview.deleted.push(...visiblePreview.deleted);
      preview.restored.push(...visiblePreview.restored);
    }
    return {
      projectId: session.projectScope.projectId,
      checkpointId,
      sessionRevision: this.currentSessionRevisionToken(sessionId),
      persistenceRevision: this.sessionRevisions.get(sessionId),
      workspaceRevision: checkpoint.commitHash,
      preview,
    };
  }

  /**
   * Revert workspace files to the state at `checkpointId`, then truncate the
   * session's message history to that turn.
   */
  async revertToCheckpoint(
    sessionId: string,
    checkpointId: string,
    expectedSessionRevision?: PersistenceRevision,
    expectedPersistenceRevision?: PersistenceRevision,
    expectedProjectId?: string,
  ): Promise<CheckpointRevertResult> {
    const session = this.sessions.get(sessionId);
    const checkpoint = this.findCheckpoint(sessionId, checkpointId);
    if (!session || !checkpoint) {
      return { ok: false, reason: "not_found" };
    }
    try {
      this.requireSessionExecution(session);
    } catch {
      return { ok: false, reason: "not_found" };
    }
    if (
      expectedProjectId !== undefined &&
      expectedProjectId !== session.projectScope.projectId
    ) {
      return {
        ok: false,
        reason: "session_conflict",
        currentRevision: this.currentSessionRevisionToken(sessionId),
      };
    }

    const pendingSave = this.sessionSaveQueues.get(sessionId);
    if (pendingSave) {
      await pendingSave.catch(() => undefined);
    }

    if (
      expectedSessionRevision &&
      this.currentSessionRevisionToken(sessionId) !== expectedSessionRevision
    ) {
      return {
        ok: false,
        reason: "session_conflict",
        currentRevision: this.currentSessionRevisionToken(sessionId),
      };
    }

    if (
      expectedPersistenceRevision &&
      this.persistence &&
      typeof this.persistence.readSession === "function"
    ) {
      const readResult = await this.persistence.readSession(sessionId);
      if (
        readResult.ok &&
        readResult.revision !== expectedPersistenceRevision
      ) {
        return {
          ok: false,
          reason: "session_conflict",
          currentRevision: readResult.revision,
        };
      }
      if (!readResult.ok && readResult.reason !== "not_found") {
        return { ok: false, reason: "persistence_failed" };
      }
    }

    const truncateResult = this.buildCheckpointTruncation(session, checkpoint);
    if (!truncateResult) {
      return { ok: false, reason: "checkpoint_stale" };
    }

    const existingCheckpoints = this.checkpoints.get(sessionId) ?? [];
    const idx = existingCheckpoints.findIndex((c) => c.id === checkpointId);
    const nextCheckpoints =
      idx === -1 ? existingCheckpoints : existingCheckpoints.slice(0, idx + 1);

    if (
      expectedSessionRevision &&
      this.currentSessionRevisionToken(sessionId) !== expectedSessionRevision
    ) {
      return {
        ok: false,
        reason: "session_conflict",
        currentRevision: this.currentSessionRevisionToken(sessionId),
      };
    }

    for (const { project, snapshot } of this.getCheckpointProjectSnapshots(
      checkpoint,
    )) {
      const manager = this.getCheckpointManagerForProject(project);
      if (
        typeof manager.initialize === "function" &&
        (await manager.initialize()) === false
      ) {
        return { ok: false, reason: "workspace_revert_failed" };
      }
      const workspaceReverted = await manager.revertToCheckpoint({
        ...checkpoint,
        projectId: project.id,
        commitHash: snapshot.commitHash,
        createdAt: snapshot.createdAt,
      });
      if (!workspaceReverted) {
        return { ok: false, reason: "workspace_revert_failed" };
      }
    }

    const saveResult = await this.saveCheckpointRevertResult(
      session,
      truncateResult.messages,
      nextCheckpoints,
    );
    if (!saveResult.ok) {
      await this.persistRevertPending(session, checkpoint, saveResult);
      return saveResult.reason === "conflict"
        ? {
            ok: false,
            reason: "persistence_failed",
            currentRevision: saveResult.currentRevision,
          }
        : { ok: false, reason: "persistence_failed" };
    }
    this.sessionRevertPending.delete(sessionId);
    session.replaceMessages(truncateResult.messages);
    session.status = "idle";
    this.checkpoints.set(sessionId, nextCheckpoints);
    this.notifySessionsChanged();
    return {
      ok: true,
      restoredPrompt: truncateResult.restoredPrompt,
      sessionRevision: saveResult.revision,
    };
  }

  private currentSessionRevisionToken(sessionId: string): PersistenceRevision {
    const session = this.sessions.get(sessionId);
    const messages = session?.getAllMessages() ?? [];
    const checkpoints = this.checkpoints.get(sessionId) ?? [];
    return crypto
      .createHash("sha256")
      .update(
        JSON.stringify({
          projectId: session?.projectScope.projectId,
          checkpoints,
          messages,
        }),
      )
      .digest("hex");
  }

  private buildCheckpointTruncation(
    session: AgentSession,
    checkpoint: Checkpoint,
  ): { messages: AgentMessage[]; restoredPrompt?: string } | null {
    const allMessages = session.getAllMessages();
    let restoredPrompt: string | undefined;
    let userCount = 0;
    let keepUntil = allMessages.length;
    for (let i = 0; i < allMessages.length; i++) {
      const message = allMessages[i];
      if (message.role === "user" && typeof message.content === "string") {
        if (userCount === checkpoint.turnIndex) {
          restoredPrompt = message.content;
          keepUntil = i;
          break;
        }
        userCount++;
      }
    }
    if (
      keepUntil === allMessages.length &&
      userCount !== checkpoint.turnIndex
    ) {
      return null;
    }
    return { messages: allMessages.slice(0, keepUntil), restoredPrompt };
  }

  private async saveCheckpointRevertResult(
    session: AgentSession,
    messages: AgentMessage[],
    checkpoints: Checkpoint[],
  ): Promise<PersistResult> {
    if (
      !this.persistence ||
      typeof this.persistence.saveSession !== "function"
    ) {
      return {
        ok: true,
        revision: this.currentSessionRevisionToken(session.id),
      };
    }

    const pendingSave = this.sessionSaveQueues.get(session.id);
    if (pendingSave) {
      await pendingSave.catch(() => undefined);
    }

    const expectedRevision = this.sessionRevisions.get(session.id) ?? null;
    const result = await this.persistence.saveSession({
      session: this.buildPersistedSessionRecord(session, {
        checkpoints,
        messages,
        revertPending: null,
      }),
      expectedRevision,
    });
    if (result.ok) {
      this.sessionRevisions.set(session.id, result.revision);
    } else if (result.reason === "conflict") {
      this.sessionRevisions.set(session.id, result.currentRevision);
    }
    return result;
  }

  private async persistRevertPending(
    session: AgentSession,
    checkpoint: Checkpoint,
    failedSaveResult: PersistResult,
  ): Promise<void> {
    const pending: RevertRecoveryState = {
      projectId: session.projectScope.projectId,
      checkpointId: checkpoint.id,
      sessionRevision:
        "currentRevision" in failedSaveResult
          ? failedSaveResult.currentRevision
          : (this.sessionRevisions.get(session.id) ?? "unknown"),
      workspaceRevision: checkpoint.commitHash,
      startedAt: Date.now(),
      reason: "workspace_reverted_session_save_failed",
    };
    this.sessionRevertPending.set(session.id, pending);

    if (
      !this.persistence ||
      typeof this.persistence.saveSession !== "function"
    ) {
      return;
    }

    try {
      const readResult = await this.persistence.readSession(session.id);
      if (!readResult.ok) return;
      const persistedProjectId =
        readResult.value.metadata.projectScope?.projectId ??
        readResult.value.summary.projectScope?.projectId ??
        this.legacyProjectScope?.projectId;
      if (persistedProjectId !== session.projectScope.projectId) return;
      const result = await this.persistence.saveSession({
        session: {
          ...readResult.value,
          metadata: {
            ...readResult.value.metadata,
            revertPending: pending,
          },
        },
        expectedRevision: readResult.revision,
      });
      if (result.ok) {
        this.sessionRevisions.set(session.id, result.revision);
      }
    } catch (error) {
      this.log?.(
        `[checkpoint] failed to persist revertPending for ${session.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Get the diff from the shadow repo at a given checkpoint.
   * @param scope "turn" = diff since the previous checkpoint (or base), "all" = diff since session start
   */
  async getCheckpointDiff(
    sessionId: string,
    checkpointId: string,
    scope: "turn" | "all",
  ): Promise<string> {
    const session = this.sessions.get(sessionId);
    const checkpoint = this.findCheckpoint(sessionId, checkpointId);
    if (!session || !checkpoint) return "";
    const all = this.checkpoints.get(sessionId) ?? [];
    const idx = all.findIndex((candidate) => candidate.id === checkpointId);
    const previous = idx > 0 ? all[idx - 1] : undefined;
    const previousSnapshots = new Map(
      (previous?.projectSnapshots ?? []).map((snapshot) => [
        snapshot.projectId,
        snapshot,
      ]),
    );
    const sections: string[] = [];
    const projectSnapshots = this.getCheckpointProjectSnapshots(checkpoint);
    const labelProjects = projectSnapshots.length > 1;
    for (const { project, snapshot } of projectSnapshots) {
      const manager = this.getCheckpointManagerForProject(project);
      if (
        typeof manager.initialize === "function" &&
        (await manager.initialize()) === false
      ) {
        continue;
      }
      const fromHash =
        scope === "all"
          ? manager.baseCommit
          : (previousSnapshots.get(project.id)?.commitHash ??
            manager.baseCommit);
      if (!fromHash) continue;
      const diff = await manager.getDiffBetween(fromHash, snapshot.commitHash);
      if (diff.trim()) {
        sections.push(labelProjects ? `## ${project.name}\n\n${diff}` : diff);
      }
    }
    return sections.join("\n\n");
  }

  private findCheckpoint(
    sessionId: string,
    checkpointId: string,
  ): Checkpoint | undefined {
    const session = this.sessions.get(sessionId);
    const checkpoints = this.checkpoints.get(sessionId);
    const checkpoint = checkpoints?.find(
      (candidate) => candidate.id === checkpointId,
    );
    if (!session || !checkpoint) return undefined;
    const projectId = session.projectScope.projectId;
    if (checkpoint.projectId !== undefined) {
      return checkpoint.projectId === projectId ? checkpoint : undefined;
    }

    const pinnedCheckpoint = { ...checkpoint, projectId };
    this.checkpoints.set(
      sessionId,
      checkpoints!.map((candidate) =>
        candidate === checkpoint ? pinnedCheckpoint : candidate,
      ),
    );
    return pinnedCheckpoint;
  }

  // ---------------------------------------------------------------------------
  // Session history (delegates to SessionStore)
  // ---------------------------------------------------------------------------

  /** List all persisted sessions, most-recent first. */
  listPersistedSessions(): SessionSummary[] {
    return (this.persistence?.list() ?? []).filter(
      (session) => !session.background && session.messageCount > 0,
    );
  }

  /** List persisted background/fleet sessions without changing foreground history defaults. */
  listPersistedFleetSessions(): SessionSummary[] {
    return (this.persistence?.listAll() ?? []).filter(
      (session) => session.background && session.messageCount > 0,
    );
  }

  getPersistedSessionSummary(sessionId: string): SessionSummary | undefined {
    return this.persistence?.get(sessionId);
  }

  getPersistedSessionMessages(sessionId: string): AgentMessage[] | null {
    return this.persistence?.loadMessages(sessionId) ?? null;
  }

  getRevertRecoveryState(
    sessionId: string,
  ): (RevertRecoveryState & { projectId: string }) | null {
    const session = this.sessions.get(sessionId);
    const recovery = this.sessionRevertPending.get(sessionId);
    if (!session || !recovery) return null;
    const projectId = session.projectScope.projectId;
    if (recovery.projectId !== undefined && recovery.projectId !== projectId) {
      return null;
    }
    const attributedRecovery = { ...recovery, projectId };
    if (recovery.projectId !== projectId) {
      this.sessionRevertPending.set(sessionId, attributedRecovery);
    }
    return attributedRecovery;
  }

  /**
   * Load a persisted session's message history into memory and make it the
   * foreground session. Returns the loaded session or null if not found.
   */
  async loadPersistedSession(
    sessionId: string,
    opts?: { onlyIfForegroundUnset?: boolean },
  ): Promise<AgentSession | null> {
    if (!this.persistence) return null;

    const readResult = await this.persistence.readSession(sessionId);
    if (!readResult.ok) return null;
    const { summary, messages, metadata } = readResult.value;

    if (opts?.onlyIfForegroundUnset && this.foregroundId) return null;

    // Reuse in-memory session if already loaded
    if (this.sessions.has(sessionId)) {
      if (!this.sessionRevisions.has(sessionId)) {
        this.sessionRevisions.set(sessionId, readResult.revision);
      }
      if (opts?.onlyIfForegroundUnset && this.foregroundId) return null;
      this.foregroundId = sessionId;
      await this.restorePersistedBackgroundSessions(sessionId);
      this.notifySessionsChanged();
      return this.sessions.get(sessionId)!;
    }

    this.sessionRevisions.set(sessionId, readResult.revision);
    const session = await this.createRestoredSession({ summary, metadata });
    this.sessionApprovalModes.set(sessionId, restoredApprovalMode(metadata));
    const projectId = session.projectScope.projectId;
    const checkpointState = metadata.checkpointState;
    const restoredCheckpoints =
      checkpointState?.projectId !== undefined &&
      checkpointState.projectId !== projectId
        ? []
        : (checkpointState?.checkpoints ?? []).map((checkpoint) => ({
            ...checkpoint,
            projectId: checkpoint.projectId ?? projectId,
          }));
    this.checkpoints.set(sessionId, restoredCheckpoints);
    if (
      metadata.revertPending &&
      (metadata.revertPending.projectId === undefined ||
        metadata.revertPending.projectId === projectId)
    ) {
      this.sessionRevertPending.set(sessionId, {
        ...metadata.revertPending,
        projectId,
      });
    } else {
      this.sessionRevertPending.delete(sessionId);
    }

    // Restore persisted state
    session.restoreFromStore({
      id: sessionId,
      title: summary.title,
      createdAt: summary.createdAt,
      lastActiveAt: summary.lastActiveAt,
      totalInputTokens: summary.totalInputTokens,
      totalOutputTokens: summary.totalOutputTokens,
      totalCacheReadTokens: metadata.totalCacheReadTokens ?? 0,
      totalCacheCreationTokens: metadata.totalCacheCreationTokens ?? 0,
      lastInputTokens: metadata.lastInputTokens ?? 0,
      // Use 0 for resumed sessions so cache-aware threshold isn't biased by stale prior runs.
      lastCacheReadTokens: 0,
      reasoningEffort: metadata.reasoningEffort,
      loadedSkills: metadata.loadedSkills ?? [],
      runState: metadata.runState,
      messages,
    });

    if (opts?.onlyIfForegroundUnset && this.foregroundId) return null;
    this.sessions.set(sessionId, session);
    this.foregroundId = sessionId;
    await this.restorePersistedBackgroundSessions(sessionId);
    this.notifySessionsChanged();
    return session;
  }

  /**
   * Restore the most recently active persisted session as the foreground session.
   * Called on startup so the last chat is visible after a reload or panel move.
   * Returns the loaded session or null if there are no persisted sessions.
   */
  async restoreLastSession(): Promise<AgentSession | null> {
    if (!this.persistence) return null;
    const sessions = this.persistence.list();
    if (sessions.length === 0) return null;
    // Abort restore if the user started a foreground session while startup restore
    // was still in flight. This keeps auto-restore from stealing focus back.
    if (this.foregroundId) return null;
    const targetSessionId = sessions[0].id;
    const session = await this.loadPersistedSession(targetSessionId, {
      onlyIfForegroundUnset: true,
    });
    if (!session) return null;
    if (this.foregroundId !== targetSessionId) {
      return null;
    }
    return session;
  }

  /** Remove inactive restored trees before loading another foreground's children. */
  private pruneRestoredBackgroundSessions(rootSessionId?: string): void {
    if (!rootSessionId) return;
    for (const sessionId of this.restoredBackgroundSessionIds) {
      const session = this.sessions.get(sessionId);
      if (!session) {
        this.restoredBackgroundSessionIds.delete(sessionId);
        continue;
      }
      const fleet = session.fleetMetadata;
      if (
        fleet?.rootSessionId === rootSessionId ||
        fleet?.parentSessionId === rootSessionId ||
        !this.getProjectedBgStatus(session).done
      ) {
        continue;
      }
      this.sessions.delete(sessionId);
      this.sessionRevisions.delete(sessionId);
      this.sessionSaveQueues.delete(sessionId);
      this.sessionApprovalModes.delete(sessionId);
      this.retainedCommandReviewDenials.clearSession(sessionId);
      this.bgFinalResults.delete(sessionId);
      this.bgStreamingText.delete(sessionId);
      this.bgPartialResults.delete(sessionId);
      this.bgAgentRetryable.delete(sessionId);
      this.bgCompletedAt.delete(sessionId);
      this.bgErrors.delete(sessionId);
      this.bgStatusDetail.delete(sessionId);
      this.bgCancelled.delete(sessionId);
      this.bgParents.delete(sessionId);
      this.bgMeta.delete(sessionId);
      this.bgSummary.delete(sessionId);
      this.restoredBackgroundSessionIds.delete(sessionId);
    }
  }

  /** Restore durable background records belonging to one foreground session. */
  async restorePersistedBackgroundSessions(
    rootSessionId?: string,
  ): Promise<AgentSession[]> {
    if (!this.persistence || typeof this.persistence.listAll !== "function") {
      return [];
    }
    this.pruneRestoredBackgroundSessions(rootSessionId);
    const restored: AgentSession[] = [];
    for (const summary of this.persistence
      .listAll()
      .filter((candidate) => candidate.background)) {
      if (this.sessions.has(summary.id)) continue;
      const readResult = await this.persistence.readSession(summary.id);
      if (!readResult.ok) continue;
      const { messages, metadata } = readResult.value;
      if (
        rootSessionId &&
        metadata.fleet?.rootSessionId !== rootSessionId &&
        metadata.fleet?.parentSessionId !== rootSessionId
      ) {
        continue;
      }
      const session = await this.createRestoredSession({
        summary,
        metadata,
        background: true,
      });
      this.sessionApprovalModes.set(summary.id, restoredApprovalMode(metadata));
      session.restoreFromStore({
        id: summary.id,
        title: summary.title,
        createdAt: summary.createdAt,
        lastActiveAt: summary.lastActiveAt,
        totalInputTokens: summary.totalInputTokens,
        totalOutputTokens: summary.totalOutputTokens,
        totalCacheReadTokens: metadata.totalCacheReadTokens ?? 0,
        totalCacheCreationTokens: metadata.totalCacheCreationTokens ?? 0,
        lastInputTokens: metadata.lastInputTokens ?? 0,
        lastCacheReadTokens: 0,
        reasoningEffort: metadata.reasoningEffort,
        loadedSkills: metadata.loadedSkills ?? [],
        messages,
        fleetMetadata: metadata.fleet,
      });

      const fleet = session.fleetMetadata;
      if (fleet?.lifecycle === "running") {
        fleet.lifecycle = "interrupted";
        fleet.resultState = "interrupted";
        fleet.terminalReason = "extension_reloaded_during_run";
        fleet.completedAt = Date.now();
      }
      if (fleet?.lifecycle === "cancelled") {
        this.bgCancelled.add(session.id);
        session.status = "idle";
      } else if (
        fleet?.lifecycle === "failed" ||
        fleet?.lifecycle === "budget_exhausted" ||
        fleet?.lifecycle === "interrupted"
      ) {
        session.status = "error";
        this.setBgError(
          session.id,
          fleet.terminalReason ?? "Background agent interrupted",
        );
      } else {
        session.status = "idle";
      }
      if (fleet?.parentSessionId) {
        this.bgParents.set(session.id, {
          sessionId: fleet.parentSessionId,
          task: fleet.task,
        });
      }
      if (fleet) {
        this.bgMeta.set(session.id, {
          resolvedMode: fleet.resolvedMode,
          resolvedModel: fleet.resolvedModel,
          resolvedProvider: fleet.resolvedProvider,
          taskClass: fleet.taskClass,
          routingReason: fleet.routingReason,
          fallbackUsed: fleet.fallbackUsed,
          toolCalls: 0,
          tokenUsage: session.totalInputTokens + session.totalOutputTokens,
          apiTurns: fleet.budgetUsage?.apiTurns ?? 0,
          startedAt:
            fleet.completedAt && fleet.budgetUsage
              ? fleet.completedAt - fleet.budgetUsage.elapsedMs
              : session.createdAt,
          lastProgressAt:
            fleet.completedAt ?? session.lastActiveAt ?? session.createdAt,
          phase: this.bgCancelled.has(session.id)
            ? "cancelled"
            : session.status === "error"
              ? "failed"
              : "completed",
        });
        if (fleet.completedAt) {
          this.bgCompletedAt.set(session.id, fleet.completedAt);
        }
        if (fleet.finalResult) {
          this.bgFinalResults.set(session.id, fleet.finalResult);
        }
        if (fleet.partialResult) {
          this.bgPartialResults.set(session.id, fleet.partialResult);
          this.bgStreamingText.set(session.id, fleet.partialResult.slice(-500));
        }
        if (fleet.agentRetryable !== undefined) {
          this.bgAgentRetryable.set(session.id, fleet.agentRetryable);
        }
      }
      this.sessions.set(session.id, session);
      this.restoredBackgroundSessionIds.add(session.id);
      this.sessionRevisions.set(session.id, readResult.revision);
      restored.push(session);
      if (fleet?.lifecycle === "interrupted") {
        await this.saveSessionNow(session.id);
      }
    }
    if (restored.length > 0) this.notifySessionsChanged();
    return restored;
  }

  async deletePersistedSession(sessionId: string): Promise<boolean> {
    return (await this.deletePersistedSessionWithResult(sessionId)).ok;
  }

  async deletePersistedSessionWithResult(
    sessionId: string,
  ): Promise<PersistedSessionMutationResult> {
    if (!this.persistence) {
      return { ok: false, operation: "delete", reason: "not_found" };
    }

    const pendingSave = this.sessionSaveQueues.get(sessionId);
    if (pendingSave) {
      await pendingSave.catch(() => undefined);
    }

    let deleted: boolean;
    if (typeof this.persistence.deleteSession === "function") {
      const expectedRevision = await this.getExpectedSessionRevision(sessionId);
      if (expectedRevision === null) {
        return { ok: false, operation: "delete", reason: "not_found" };
      }
      const result = await this.persistence.deleteSession({
        sessionId,
        expectedRevision,
      });
      if (result.ok) {
        deleted = true;
      } else {
        return this.handlePersistenceMutationFailure(
          sessionId,
          "delete",
          result,
        );
      }
    } else {
      deleted = this.persistence.delete(sessionId);
    }

    if (!deleted) {
      return { ok: false, operation: "delete", reason: "not_found" };
    }

    this.sessionRevisions.delete(sessionId);
    this.sessionSaveQueues.delete(sessionId);
    this.sessionApprovalModes.delete(sessionId);
    this.retainedCommandReviewDenials.clearSession(sessionId);
    if (this.sessions.has(sessionId)) {
      this.sessions.delete(sessionId);
      if (this.foregroundId === sessionId) {
        this.foregroundId = null;
      }
    }
    this.notifySessionsChanged();
    return { ok: true };
  }

  async renamePersistedSession(
    sessionId: string,
    title: string,
  ): Promise<boolean> {
    return (await this.renamePersistedSessionWithResult(sessionId, title)).ok;
  }

  async renamePersistedSessionWithResult(
    sessionId: string,
    title: string,
  ): Promise<PersistedSessionMutationResult> {
    if (!this.persistence) {
      return { ok: false, operation: "rename", reason: "not_found" };
    }

    let nextRevision: PersistenceRevision | null = null;
    let renamed: boolean;
    if (typeof this.persistence.renameSession === "function") {
      const expectedRevision = await this.getExpectedSessionRevision(sessionId);
      if (expectedRevision === null) {
        return { ok: false, operation: "rename", reason: "not_found" };
      }
      const result = await this.persistence.renameSession({
        sessionId,
        title,
        expectedRevision,
      });
      if (result.ok) {
        renamed = true;
        nextRevision = result.revision;
      } else {
        return this.handlePersistenceMutationFailure(
          sessionId,
          "rename",
          result,
        );
      }
    } else {
      renamed = this.persistence.rename(sessionId, title);
    }

    if (!renamed) {
      return { ok: false, operation: "rename", reason: "not_found" };
    }

    if (nextRevision) {
      this.sessionRevisions.set(sessionId, nextRevision);
    }
    const session = this.sessions.get(sessionId);
    if (session) {
      session.title = title;
    }
    this.notifySessionsChanged();
    return { ok: true };
  }

  private async getExpectedSessionRevision(
    sessionId: string,
  ): Promise<PersistenceRevision | null> {
    const tracked = this.sessionRevisions.get(sessionId);
    if (tracked) return tracked;
    if (
      !this.persistence ||
      typeof this.persistence.readSession !== "function"
    ) {
      return null;
    }
    const readResult = await this.persistence.readSession(sessionId);
    if (!readResult.ok) {
      this.log?.(
        `[session] persistence revision lookup failed for ${sessionId}: ${readResult.reason}${"message" in readResult ? `: ${readResult.message}` : ""}`,
      );
      return null;
    }
    this.sessionRevisions.set(sessionId, readResult.revision);
    return readResult.revision;
  }

  private handlePersistenceMutationFailure(
    sessionId: string,
    operation: PersistedSessionMutationOperation,
    result: Exclude<PersistResult, { ok: true }>,
  ): PersistedSessionMutationResult {
    if (result.reason === "conflict") {
      this.sessionRevisions.set(sessionId, result.currentRevision);
      this.log?.(
        `[session] persistence ${operation} conflict for ${sessionId}: current=${result.currentRevision}`,
      );
      return {
        ok: false,
        operation,
        reason: "conflict",
        currentRevision: result.currentRevision,
      };
    }
    this.log?.(
      `[session] persistence ${operation} failed for ${sessionId}: ${result.reason}${"message" in result ? `: ${result.message}` : ""}`,
    );
    return {
      ok: false,
      operation,
      reason: result.reason,
      message: "message" in result ? result.message : undefined,
    };
  }

  /**
   * Return the text of the first user message for a persisted session.
   * Used by "Copy First Prompt" to prefill a new session.
   */
  loadFirstPrompt(sessionId: string): string | null {
    // Try in-memory first
    const live = this.sessions.get(sessionId);
    if (live) {
      const first = live.getAllMessages()[0];
      if (first?.role === "user" && typeof first.content === "string") {
        return first.content;
      }
    }

    // Fall back to disk
    const messages = this.persistence?.loadMessages(sessionId);
    if (!messages) return null;
    const first = messages[0];
    if (first?.role === "user" && typeof first.content === "string") {
      return first.content;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Background agents
  // ---------------------------------------------------------------------------

  private inheritBackgroundApprovalMode(
    parentSessionId: string,
    childSessionId: string,
  ): void {
    const parentMode = this.getSessionApprovalMode(
      parentSessionId,
      this.toolCtx?.getCommandApprovalPolicy?.(parentSessionId) ?? "safe",
    );
    this.sessionApprovalModes.set(
      childSessionId,
      Object.freeze({ ...parentMode }),
    );
  }

  private inheritSharedBackgroundSessionApprovals(
    parentSessionId: string,
    childSessionId: string,
  ): void {
    const parent = this.sessions.get(parentSessionId);
    const child = this.sessions.get(childSessionId);
    if (
      !parent?.projectScope.rootPath ||
      !child?.projectScope.rootPath ||
      !this.toolCtx?.inheritSessionApprovalState
    ) {
      return;
    }

    // Approval inheritance validates project identity. Background sessions are
    // created with the parent's scope, but their tool contexts have not yet
    // necessarily been captured (and therefore bound) at spawn time.
    this.toolCtx.approvalManager.bindSessionProject(
      parentSessionId,
      parent.projectScope,
    );
    this.toolCtx.approvalManager.bindSessionProject(
      childSessionId,
      child.projectScope,
    );
    this.toolCtx.inheritSessionApprovalState(parentSessionId, childSessionId);
  }

  private inheritSharedBackgroundApprovalState(
    parentSessionId: string,
    childSessionId: string,
  ): void {
    this.inheritBackgroundApprovalMode(parentSessionId, childSessionId);
    this.inheritSharedBackgroundSessionApprovals(
      parentSessionId,
      childSessionId,
    );
  }

  private refreshingBackgroundApprovalInheritance = false;

  /**
   * Add newly granted parent approvals to active shared-process descendants.
   * Existing child authority remains independent and is never revoked here.
   */
  refreshBackgroundApprovalInheritance(): void {
    if (
      this.refreshingBackgroundApprovalInheritance ||
      !this.toolCtx?.inheritSessionApprovalState
    ) {
      return;
    }

    this.refreshingBackgroundApprovalInheritance = true;
    try {
      const children = Array.from(this.sessions.values())
        .filter((session) => {
          if (!session.background || session.providerId === "worktree") {
            return false;
          }
          const lifecycle = session.fleetMetadata?.lifecycle;
          return (
            lifecycle === "queued" ||
            lifecycle === "running" ||
            lifecycle === "paused" ||
            session.status === "streaming" ||
            session.status === "tool_executing" ||
            session.status === "awaiting_approval"
          );
        })
        .sort(
          (left, right) =>
            (left.fleetMetadata?.depth ?? 0) -
            (right.fleetMetadata?.depth ?? 0),
        );

      for (const child of children) {
        const parentSessionId = this.getBackgroundParentSessionId(child.id);
        if (!parentSessionId || !this.sessions.has(parentSessionId)) continue;
        this.inheritSharedBackgroundSessionApprovals(parentSessionId, child.id);
      }
    } finally {
      this.refreshingBackgroundApprovalInheritance = false;
    }
  }

  /**
   * True when a background session occupies a concurrency slot. Sessions
   * blocked in get_background_result do not count: a full pool of parents
   * each waiting on a queued descendant would otherwise deadlock the fleet.
   */
  private occupiesBackgroundSlot(session: AgentSession): boolean {
    return (
      session.background &&
      !this.bgResultWaitHolds.has(session.id) &&
      (session.status === "streaming" ||
        session.status === "tool_executing" ||
        session.status === "awaiting_approval")
    );
  }

  private activeBackgroundCount(): number {
    return Array.from(this.sessions.values()).filter((session) =>
      this.occupiesBackgroundSlot(session),
    ).length;
  }

  private activeBackgroundCountForRoot(rootSessionId: string): number {
    return Array.from(this.sessions.values()).filter(
      (session) =>
        session.fleetMetadata?.rootSessionId === rootSessionId &&
        this.occupiesBackgroundSlot(session),
    ).length;
  }

  private activeBackgroundCountForProvider(provider: string): number {
    return Array.from(this.sessions.values()).filter(
      (session) =>
        this.bgMeta.get(session.id)?.resolvedProvider === provider &&
        this.occupiesBackgroundSlot(session),
    ).length;
  }

  private canStartBackground(session: AgentSession): boolean {
    const root = session.fleetMetadata?.rootSessionId;
    const provider = this.bgMeta.get(session.id)?.resolvedProvider ?? "native";
    return this.fleetScheduler.canStart({
      activeGlobal: this.activeBackgroundCount(),
      activeForRoot: root ? this.activeBackgroundCountForRoot(root) : 0,
      activeForProvider: this.activeBackgroundCountForProvider(provider),
    });
  }

  private scheduleBackgroundLaunch(
    session: AgentSession,
    start: () => Promise<void>,
  ): void {
    const launch = async (): Promise<void> => {
      const meta = this.bgMeta.get(session.id);
      if (meta) {
        const now = Date.now();
        meta.startedAt = now;
        meta.lastProgressAt = now;
        meta.phase = "waiting_for_provider";
        meta.phaseStartedAt = now;
      }
      const maxElapsedMs = session.fleetMetadata?.budget?.maxElapsedMs;
      if (maxElapsedMs !== undefined && maxElapsedMs > 0) {
        const timers = [
          maxElapsedMs,
          maxElapsedMs * BUDGET_HARD_LIMIT_RATIO,
        ].map((delayMs) =>
          this.host.timers.setTimeout(() => {
            this.enforceBackgroundBudget(session);
          }, delayMs),
        );
        this.bgSafetyTimers.set(session.id, timers);
      }
      await start();
    };
    if (!this.canStartBackground(session)) {
      session.status = "queued";
      if (session.fleetMetadata) session.fleetMetadata.lifecycle = "queued";
      this.bgLaunchQueue.push({ sessionId: session.id, start: launch });
      this.saveSession(session.id);
      this.notifySessionsChanged();
      return;
    }
    session.status = "streaming";
    if (session.fleetMetadata) session.fleetMetadata.lifecycle = "running";
    this.appendFleetEvent(session, "started", "Agent started");
    void launch().finally(() => this.drainBackgroundQueue());
  }

  private drainBackgroundQueue(): void {
    while (this.bgLaunchQueue.length > 0) {
      const nextIndex = this.fleetScheduler.findNextRunnable(
        this.bgLaunchQueue,
        (candidate) => {
          const candidateSession = this.sessions.get(candidate.sessionId);
          return Boolean(
            candidateSession && this.canStartBackground(candidateSession),
          );
        },
      );
      if (nextIndex < 0) break;
      const [queued] = this.bgLaunchQueue.splice(nextIndex, 1);
      const session = this.sessions.get(queued.sessionId);
      if (!session || this.bgCancelled.has(queued.sessionId)) continue;
      session.status = "streaming";
      if (session.fleetMetadata) session.fleetMetadata.lifecycle = "running";
      this.appendFleetEvent(session, "started", "Agent started from queue");
      this.saveSession(session.id);
      this.notifySessionsChanged();
      void queued.start().finally(() => this.drainBackgroundQueue());
    }
  }

  /**
   * Spawn a background agent session and return the resolved routing metadata.
   */
  async spawnBackground(
    request: SpawnBackgroundRequest,
    parentSessionId?: string,
  ): Promise<SpawnBackgroundResult> {
    if (!this.toolCtx) {
      throw new Error("No tool context — cannot spawn background agent");
    }

    const task = request.task?.trim();
    const message = request.message?.trim();
    if (!task || !message) {
      throw new Error(
        "spawn_background_agent requires non-empty task and message",
      );
    }
    if ((request.images?.length ?? 0) > MAX_BACKGROUND_HANDOFF_IMAGES) {
      throw new Error(
        `spawn_background_agent supports at most ${MAX_BACKGROUND_HANDOFF_IMAGES} inherited images`,
      );
    }
    if (
      request.images?.some(
        (image) =>
          !image.name.trim() || !image.mimeType.trim() || !image.base64.trim(),
      )
    ) {
      throw new Error("spawn_background_agent received an invalid image");
    }
    const parent = parentSessionId
      ? this.sessions.get(parentSessionId)
      : this.getForegroundSession();
    const inheritedScope =
      parent?.projectScope ??
      this.getForegroundSession()?.projectScope ??
      this.selectProjectScope();
    const executionRoot = parent
      ? this.requireSessionExecution(parent)
      : inheritedScope.rootPath;
    if (!executionRoot) {
      throw new Error(
        `Project '${inheritedScope.displayName}' is unavailable for local execution.`,
      );
    }
    const parentRequestContext = parent
      ? this.activeRequestToolContexts.get(parent.id)
      : undefined;
    const parentDepth = parent?.fleetMetadata?.depth ?? 0;
    const childCount = parent
      ? Array.from(this.sessions.values()).filter(
          (candidate) =>
            candidate.fleetMetadata?.parentSessionId === parent.id &&
            candidate.fleetMetadata.lifecycle !== "completed" &&
            candidate.fleetMetadata.lifecycle !== "failed" &&
            candidate.fleetMetadata.lifecycle !== "cancelled" &&
            candidate.fleetMetadata.lifecycle !== "budget_exhausted" &&
            candidate.fleetMetadata.lifecycle !== "interrupted",
        ).length
      : 0;
    const admission = this.fleetScheduler.evaluateSpawn({
      parentRequested: Boolean(parentSessionId),
      parentFound: Boolean(parent),
      parentDepth,
      activeChildren: childCount,
    });
    if (!admission.ok) {
      throw new FleetAdmissionError(admission);
    }
    this.ensureChildBudgetAdmission(parent, request);
    this.ensureSharedWorkspaceScopeAvailable(request);
    const executionMessage = request.reviewScope
      ? `${message}\n\n${await captureReviewScope(
          executionRoot,
          request.reviewScope,
          {
            workspaceRoots: this.getWorkspaceFolders().map(
              (folder) => folder.path,
            ),
          },
        )}`
      : message;

    if (request.worktree === "isolated") {
      if (request.images?.length) {
        throw new Error(
          "Image handoff is not supported for isolated-worktree background agents; use a native shared background agent or save the images in the workspace and reference their paths.",
        );
      }
      return this.spawnIsolatedWorktree(
        { ...request, message: executionMessage },
        parent,
      );
    }

    const backendRoute = resolveBackgroundBackendRoute(
      this.getBackgroundAgentSettings(inheritedScope),
      request,
    );
    const fg = this.getForegroundSession();
    parentSessionId = parent?.id;

    if (backendRoute.backend === "acp") {
      if (request.images?.length) {
        throw new Error(
          "Image handoff is not supported by ACP background agents; use a native background agent or save the images in the workspace and reference their paths.",
        );
      }
      // ACP agents do not use AgentLink's set_task_status tool, so keep the
      // serialized-envelope fallback at that external boundary only.
      const acpExecutionMessage = withFleetResultInstruction(
        request.expectedResult,
        executionMessage,
      );
      const resolvedMode = request.mode?.trim() || "review";
      const taskClass = request.taskClass?.trim() || "review";
      const session = await this.createBoundSession({
        mode: resolvedMode,
        config: {
          ...this.config,
          model: `acp:${backendRoute.agent.id}`,
          thinkingBudget: 0,
        },
        projectScope: inheritedScope,
        workspaceFolders: this.getWorkspaceFolders(),
        devMode: this.devMode,
        background: true,
        isBackground: true,
        lightweight: true,
        providerId: "acp",
      });
      session.reasoningEffort = "none";
      session.title = task.slice(0, 80);
      session.status = "queued";
      session.addUserMessage(executionMessage);
      session.createAbortController();
      this.sessions.set(session.id, session);
      if (parentSessionId) {
        this.inheritSharedBackgroundApprovalState(parentSessionId, session.id);
        this.bgParents.set(session.id, { sessionId: parentSessionId, task });
      }
      this.bgMeta.set(session.id, {
        resolvedMode,
        resolvedModel: `acp:${backendRoute.agent.id}`,
        resolvedProvider: "acp",
        taskClass,
        routingReason:
          backendRoute.reason === "explicit_provider"
            ? `explicit ACP provider override (${backendRoute.reference})`
            : `configured default ACP background agent (${backendRoute.reference})`,
        fallbackUsed: false,
        toolCalls: 0,
        tokenUsage: 0,
        apiTurns: 0,
        startedAt: Date.now(),
        lastProgressAt: Date.now(),
        phase: "queued",
        phaseStartedAt: Date.now(),
      });
      session.fleetMetadata = this.createFleetMetadata(session, {
        task,
        parentSessionId,
        backend: `acp:${backendRoute.agent.id}`,
        readonlyOnly: backendRoute.agent.readonlyOnly,
        resolvedMode,
        resolvedModel: `acp:${backendRoute.agent.id}`,
        resolvedProvider: "acp",
        taskClass,
        routingReason:
          backendRoute.reason === "explicit_provider"
            ? `explicit ACP provider override (${backendRoute.reference})`
            : `configured default ACP background agent (${backendRoute.reference})`,
        fallbackUsed: false,
        delegation: {
          ownedPaths: request.ownedPaths,
          forbiddenPaths: request.forbiddenPaths,
          permissionProfile: request.permissionProfile,
          worktree: request.worktree,
          expectedResult: request.expectedResult,
        },
        budget: request.budget,
        goalId: request.goalId,
        workflowId: request.workflowId,
      });
      this.appendFleetEvent(session, "queued", "Agent admitted to the fleet");
      this.saveSession(session.id);
      this.notifySessionsChanged();

      const acpRequestContext = this.captureSessionToolContext(
        session,
        undefined,
        parentRequestContext,
      );
      if (acpRequestContext) {
        this.activeRequestToolContexts.set(session.id, acpRequestContext);
      }
      const acpOutput: AcpOutputState = {
        assistantTextParts: [],
        directImages: [],
        toolImages: new Map(),
        warnings: new Set(),
      };
      let promptResponse: PromptResponse | undefined;
      const runAcpBackground = async () => {
        let lastPersistedPartialResult = session.fleetMetadata?.partialResult;
        const persistPartialResult = () => {
          const partialResult = session.fleetMetadata?.partialResult;
          if (partialResult === lastPersistedPartialResult) return;
          this.saveSession(session.id);
          lastPersistedPartialResult = partialResult;
        };
        const inFlightPersistTimer = this.host.timers.setInterval(
          persistPartialResult,
          1000,
        );
        try {
          await this.host.acpBackgroundRunner.run({
            agent: backendRoute.agent,
            cwd: session.requireProjectRoot(),
            additionalDirectories: this.getAcpAdditionalDirectories(
              session.requireProjectRoot(),
            ),
            prompt: acpExecutionMessage,
            signal: session.abortSignal,
            onEvent: (event) => {
              if (event.type === "stderr") {
                this.log?.(
                  `[acp:${backendRoute.agent.id}] ${event.text.trimEnd()}`,
                );
                return;
              }
              if (event.type === "stop") {
                this.noteBackgroundProgress(session.id, "waiting_for_provider");
                promptResponse = event.response;
                this.applyAcpPromptResponseUsage(session, event.response);
                this.notifySessionChangeListeners();
                return;
              }
              this.applyAcpSessionUpdate({
                session,
                output: acpOutput,
                update: event.update,
              });
              const { status } = this.getProjectedBgStatus(session);
              this.maybeScheduleBgSummary({
                sessionId: session.id,
                event: {
                  type: "status_update",
                  message: session.currentTool ?? status,
                },
                status,
                currentTool: session.currentTool,
                streamingText: this.bgStreamingText.get(session.id),
                statusDetail: this.bgStatusDetail.get(session.id),
              });
              this.notifySessionChangeListeners();
            },
            onRequestPermission: (permissionRequest) =>
              this.handleAcpPermissionRequest({
                sessionId: session.id,
                task,
                readonlyOnly: backendRoute.agent.readonlyOnly,
                requestContext: acpRequestContext,
                request: permissionRequest,
              }),
          });
          if (!this.bgCancelled.has(session.id)) {
            const stopReasonMessage = promptResponse
              ? this.acpStopReasonMessage(promptResponse)
              : undefined;
            const assistantContent = this.buildAcpAssistantContent(
              acpOutput,
              stopReasonMessage,
            );
            if (assistantContent.length > 0) {
              session.appendAssistantTurn(assistantContent);
            }
            if (stopReasonMessage) {
              session.status = "error";
              this.setBgError(session.id, stopReasonMessage, false);
              this.recordAndEmitEvent(session.id, {
                type: "error",
                error: stopReasonMessage,
                retryable: false,
              });
            } else {
              session.status = "idle";
            }
            this.recordAndEmitEvent(session.id, {
              type: "done",
              totalInputTokens: session.totalInputTokens,
              totalOutputTokens: session.totalOutputTokens,
              totalCacheReadTokens: session.totalCacheReadTokens,
              totalCacheCreationTokens: session.totalCacheCreationTokens,
            });
          }
        } catch (err: unknown) {
          const error = err instanceof Error ? err.message : String(err);
          if (this.bgCancelled.has(session.id) || session.isAborted) {
            this.bgCancelled.add(session.id);
          } else {
            const partialContent = this.buildAcpAssistantContent(acpOutput);
            if (partialContent.length > 0) {
              session.appendAssistantTurn(partialContent);
            }
            session.status = "error";
            this.setBgError(session.id, error, false);
            this.recordAndEmitEvent(session.id, {
              type: "error",
              error,
              retryable: false,
            });
          }
        } finally {
          this.host.timers.clearInterval(inFlightPersistTimer);
          persistPartialResult();
          this.releaseSessionToolContext(session.id, acpRequestContext);
          if (session.fleetMetadata?.lifecycle === "paused") {
            this.saveSession(session.id);
            this.notifySessionsChanged();
          } else {
            this.bgStatusDetail.delete(session.id);
            this.markBgCompleted(session.id);
            const fallbackMsg = this.bgErrors.get(session.id)
              ? `ACP background agent stopped: ${this.bgErrors.get(session.id)}`
              : "(ACP background agent completed without output)";
            const resolution = this.resolveBackgroundResult(
              session,
              fallbackMsg,
            );
            this.cancelOwnedChildrenOnCompletion(session.id);
            this.finalizeFleetMetadata(session, resolution);
            await this.saveSessionNow(session.id);
            this.bgFinalResults.set(session.id, resolution.resultText);
            for (const t of this.bgSafetyTimers.get(session.id) ?? []) {
              this.host.timers.clearTimeout(t);
            }
            this.bgSafetyTimers.delete(session.id);
            for (const resolve of this.bgResultWaiters.get(session.id) ?? []) {
              resolve(resolution.resultText);
            }
            this.bgResultWaiters.delete(session.id);
            this.notifySessionsChanged();
            this.host.timers.setTimeout(
              () => {
                this.bgFinalResults.delete(session.id);
                this.bgParents.delete(session.id);
              },
              5 * 60 * 1000,
            );
          }
        }
      };
      this.scheduleBackgroundLaunch(session, runAcpBackground);

      return {
        sessionId: session.id,
        resolvedMode,
        resolvedModel: `acp:${backendRoute.agent.id}`,
        resolvedProvider: "acp",
        taskClass,
        routingReason:
          backendRoute.reason === "explicit_provider"
            ? `explicit ACP provider override (${backendRoute.reference})`
            : `configured default ACP background agent (${backendRoute.reference})`,
        fallbackUsed: false,
      };
    }

    const foregroundMode = parent?.mode ?? fg?.mode ?? "code";
    const foregroundModel = parent?.model ?? fg?.model ?? this.config.model;

    const route = await resolveBackgroundRoute(this.host.providers, request, {
      mode: foregroundMode,
      model: foregroundModel,
    });
    const isReviewTask = route.taskClass.startsWith("review_");
    const effectivePermissionProfile =
      request.permissionProfile ?? (isReviewTask ? "review-only" : undefined);
    const effectiveExpectedResult =
      request.expectedResult ?? (isReviewTask ? "review_findings" : undefined);
    const effectiveBudget = request.budget ?? route.defaultBudget;

    this.log?.(
      `[bg-route] task=${task} class=${route.taskClass} requested={mode:${request.mode ?? "-"},model:${request.model ?? "-"},provider:${request.provider ?? "-"}} resolved={mode:${route.resolvedMode},model:${route.resolvedModel},provider:${route.resolvedProvider}} fallback=${route.fallbackUsed} reason="${route.routingReason}"`,
    );

    const bgConfig: AgentConfig = {
      ...this.buildConfigForModel(route.resolvedModel),
      // Apply per-task-class thinking budget override
      ...(route.thinkingBudget !== undefined
        ? { thinkingBudget: route.thinkingBudget }
        : {}),
    };

    const providerId =
      this.host.providers.tryResolveProvider(route.resolvedModel)?.id ??
      route.resolvedProvider;

    const session = await this.createBoundSession({
      mode: route.resolvedMode,
      config: bgConfig,
      projectScope: inheritedScope,
      workspaceFolders: this.getWorkspaceFolders(),
      devMode: this.devMode,
      background: true,
      isBackground: true,
      providerId,
    });

    if (route.thinkingBudget === 0) {
      session.reasoningEffort = "none";
    }

    session.title = task.slice(0, 80);
    // Set status to "streaming" BEFORE registering the session, so the first
    // bgSessionsUpdate the UI receives already shows the agent as running
    // (not briefly "idle"/done).
    session.status = "queued";
    this.sessions.set(session.id, session);
    if (parentSessionId) {
      this.inheritSharedBackgroundApprovalState(parentSessionId, session.id);
      this.bgParents.set(session.id, {
        sessionId: parentSessionId,
        task,
      });
    }
    this.bgMeta.set(session.id, {
      resolvedMode: route.resolvedMode,
      resolvedModel: route.resolvedModel,
      resolvedProvider: route.resolvedProvider,
      taskClass: route.taskClass,
      routingReason: route.routingReason,
      fallbackUsed: route.fallbackUsed,
      toolCalls: 0,
      tokenUsage: 0,
      apiTurns: 0,
      startedAt: Date.now(),
      lastProgressAt: Date.now(),
      phase: "queued",
      phaseStartedAt: Date.now(),
    });
    session.fleetMetadata = this.createFleetMetadata(session, {
      task,
      parentSessionId,
      backend: "native",
      resolvedMode: route.resolvedMode,
      resolvedModel: route.resolvedModel,
      resolvedProvider: route.resolvedProvider,
      taskClass: route.taskClass,
      routingReason: route.routingReason,
      fallbackUsed: route.fallbackUsed,
      delegation: {
        ownedPaths: request.ownedPaths,
        forbiddenPaths: request.forbiddenPaths,
        permissionProfile: effectivePermissionProfile,
        worktree: request.worktree,
        expectedResult: effectiveExpectedResult,
      },
      budget: effectiveBudget,
      goalId: request.goalId,
      workflowId: request.workflowId,
    });
    this.appendFleetEvent(session, "queued", "Agent admitted to the fleet");
    this.saveSession(session.id);
    this.notifySessionsChanged();

    // Build a bg-specific tool context and preserve session-scoped fleet
    // controls so this agent may coordinate descendants within scheduler policy.
    const effectiveToolProfile =
      effectivePermissionProfile === "review-only"
        ? "review"
        : route.toolProfile;
    const baseCtx = parentRequestContext ?? this.toolCtx;
    const bgContextOverrides: Partial<ToolDispatchContext> = {
      commandExecutionPolicy:
        effectiveToolProfile === "review" ||
        effectiveToolProfile === "readonly-research"
          ? "read-only"
          : baseCtx.commandExecutionPolicy,
      delegationPolicy: {
        ownedPaths: request.ownedPaths,
        forbiddenPaths: request.forbiddenPaths,
        onDecision: (decision) => this.appendPolicyAudit(session, decision),
      },
      onApprovalRequest: baseCtx.onApprovalRequest
        ? (req) => {
            this.noteBackgroundProgress(session.id, "awaiting_approval");
            this.appendPolicyAudit(session, {
              decision: "approval_requested",
              operation: req.kind,
              reason: req.title || "approval_required",
            });
            this.appendFleetEvent(
              session,
              "approval",
              req.title || "Approval required",
            );
            return baseCtx.onApprovalRequest!({ ...req, backgroundTask: task });
          }
        : undefined,
      onQuestion: baseCtx.onQuestion
        ? (context, questions, bgSessionId) => {
            this.noteBackgroundProgress(session.id, "awaiting_approval");
            this.appendFleetEvent(
              session,
              "question",
              questions[0]?.question || "Answer required",
            );
            return baseCtx.onQuestion!(context, questions, bgSessionId, task);
          }
        : undefined,
    };

    const bgEngine = this.host.createEngine(this.host.providers, this.log);
    const preparedTurn = await this.prepareTurnExecution(session, {
      overrides: bgContextOverrides,
      inheritedContext: parentRequestContext,
    });
    const bgCtx = this.bindCapturedEngineToSession(
      bgEngine,
      session,
      preparedTurn.context,
    );

    if (request.images?.length) {
      session.addUserMessage(executionMessage, { images: request.images });
    } else {
      session.addUserMessage(executionMessage);
    }

    // Fire-and-forget — runs concurrently alongside the foreground session.
    // Reviews receive an automatic bounded budget unless the caller supplies
    // one; other task classes retain foreground-style open-ended execution.
    const runNativeBackground = async () => {
      let lastPersistedActiveAt = session.lastActiveAt;
      let lastPersistedPartialResult = session.fleetMetadata?.partialResult;
      let terminalEngineError: (AgentEvent & { type: "error" }) | undefined;
      const persistIfHistoryChanged = () => {
        const partialResult = session.fleetMetadata?.partialResult;
        if (
          session.lastActiveAt !== lastPersistedActiveAt ||
          partialResult !== lastPersistedPartialResult
        ) {
          this.saveSession(session.id);
          lastPersistedActiveAt = session.lastActiveAt;
          lastPersistedPartialResult = partialResult;
        }
      };
      const inFlightPersistTimer = this.host.timers.setInterval(
        persistIfHistoryChanged,
        1000,
      );

      // Session-scoped caps also flow into the engine as a final safety net.
      // The nominal caps stay soft: the manager warns and interjects while the
      // engine only refuses work at the same 3x boundary as the hard backstop.
      // Subtree/goal budgets are shared pools, so their totals don't apply to
      // a single engine run.
      const budget = session.fleetMetadata?.budget;
      const engineBudget =
        budget && (budget.scope === undefined || budget.scope === "session")
          ? budget
          : undefined;
      try {
        for await (const event of bgEngine.run(session, {
          isBackground: true,
          toolProfile: effectiveToolProfile,
          maxToolCalls: getEngineHardLimit(engineBudget?.maxToolCalls),
          maxApiTurns: getEngineHardLimit(engineBudget?.maxApiTurns),
          webAccessPolicy: preparedTurn.policy,
          mcpToolDisclosure: preparedTurn.mcpToolDisclosure,
          mcpToolDefinitions: preparedTurn.mcpToolDefinitions,
        })) {
          this.noteBackgroundAgentEvent(session.id, event);
          if (event.type === "text_delta") {
            this.appendBgStreamingText(session.id, event.text);
          }
          if (event.type === "tool_start") {
            // Clear stale detail from previous tool runs.
            this.bgStatusDetail.delete(session.id);
          }
          if (event.type === "tool_result") {
            const detail = this.extractToolStatusDetail(
              event.toolName,
              event.input,
            );
            if (detail) {
              this.bgStatusDetail.set(session.id, detail);
            }
            session.currentTool = undefined;
          }
          if (event.type === "error") {
            terminalEngineError = event;
          }

          // Track tool calls and token usage for observability
          const meta = this.bgMeta.get(session.id);
          if (meta) {
            if (event.type === "tool_start") {
              meta.toolCalls += 1;
            }
            if (event.type === "api_request") {
              meta.tokenUsage += event.uncachedInputTokens + event.outputTokens;
              meta.apiTurns += 1;
            }
          }

          if (this.enforceBackgroundBudget(session)) {
            this.notifySessionChangeListeners();
            break;
          }

          const { status } = this.getProjectedBgStatus(session);
          this.maybeScheduleBgSummary({
            sessionId: session.id,
            event,
            status,
            currentTool: session.currentTool,
            streamingText: this.bgStreamingText.get(session.id),
            resultText:
              session.status === "idle" || session.status === "error"
                ? session.getLastAssistantText()
                : undefined,
            errorMessage: this.bgErrors.get(session.id),
            statusDetail: this.bgStatusDetail.get(session.id),
          });

          this.recordAndEmitEvent(session.id, event);
          this.notifySessionChangeListeners();
        }
        if (terminalEngineError) {
          session.status = "error";
          this.setBgError(
            session.id,
            terminalEngineError.error,
            terminalEngineError.retryable,
          );
        } else if (session.status === "streaming") {
          session.status = "idle";
        }
      } catch (err: unknown) {
        const error = err instanceof Error ? err.message : String(err);
        session.status = "error";
        this.setBgError(session.id, error, false);
        this.recordAndEmitEvent(session.id, {
          type: "error",
          error,
          retryable: false,
        });
        this.recordAndEmitEvent(session.id, {
          type: "done",
          totalInputTokens: session.totalInputTokens,
          totalOutputTokens: session.totalOutputTokens,
          totalCacheReadTokens: session.totalCacheReadTokens,
          totalCacheCreationTokens: session.totalCacheCreationTokens,
        });
      } finally {
        this.releaseSessionToolContext(session.id, bgCtx);
        this.host.timers.clearInterval(inFlightPersistTimer);
        persistIfHistoryChanged();
      }

      if (session.fleetMetadata?.lifecycle === "paused") {
        this.saveSession(session.id);
        this.notifySessionsChanged();
        return;
      }

      // Clear transient status detail once the run has finished.
      this.bgStatusDetail.delete(session.id);

      // Mark completion time for auto-dismiss
      this.markBgCompleted(session.id);

      // Resolve any callers waiting on get_background_result
      const fallbackMsg = this.bgErrors.get(session.id)
        ? `Background agent stopped: ${this.bgErrors.get(session.id)}`
        : "(background agent completed without output)";
      const resolution = this.resolveBackgroundResult(session, fallbackMsg);
      this.cancelOwnedChildrenOnCompletion(session.id);
      this.finalizeFleetMetadata(session, resolution);
      await this.saveSessionNow(session.id);

      // Store result BEFORE resolving waiters to close the race window
      this.bgFinalResults.set(session.id, resolution.resultText);

      // Clear all safety timers for this session
      for (const t of this.bgSafetyTimers.get(session.id) ?? [])
        this.host.timers.clearTimeout(t);
      this.bgSafetyTimers.delete(session.id);

      for (const resolve of this.bgResultWaiters.get(session.id) ?? []) {
        resolve(resolution.resultText);
      }
      this.bgResultWaiters.delete(session.id);
      this.notifySessionsChanged();
      // Cleanup stored result after 5 minutes to prevent unbounded memory growth
      this.host.timers.setTimeout(
        () => {
          this.bgFinalResults.delete(session.id);
          this.bgParents.delete(session.id);
        },
        5 * 60 * 1000,
      );
    };
    this.scheduleBackgroundLaunch(session, runNativeBackground);

    return {
      sessionId: session.id,
      resolvedMode: route.resolvedMode,
      resolvedModel: route.resolvedModel,
      resolvedProvider: route.resolvedProvider,
      taskClass: route.taskClass,
      routingReason: route.routingReason,
      fallbackUsed: route.fallbackUsed,
    };
  }

  async startFleetWorkflow(
    request: FleetWorkflowRequest,
    parentSessionId?: string,
  ): Promise<{
    workflowId: string;
    goalId?: string;
    sessions: SpawnBackgroundResult[];
  }> {
    const plan = planFleetWorkflow(request);
    const sessions: SpawnBackgroundResult[] = [];
    for (const delegation of plan.delegations) {
      sessions.push(
        await this.spawnBackground(
          { ...delegation, workflowId: plan.workflowId },
          parentSessionId,
        ),
      );
    }
    return {
      workflowId: plan.workflowId,
      goalId: plan.goalId,
      sessions,
    };
  }

  async collectFleetWorkflow(
    workflowId: string,
    kind: import("./FleetWorkflows.js").FleetWorkflowKind,
  ): Promise<FleetWorkflowOutcome> {
    const sessions = Array.from(this.sessions.values()).filter(
      (session) => session.fleetMetadata?.workflowId === workflowId,
    );
    if (sessions.length === 0) {
      throw new Error(`Fleet workflow not found: ${workflowId}`);
    }
    await Promise.all(
      sessions.map((session) => this.waitForBackground(session.id)),
    );
    const candidates = sessions.map((session) => {
      const fleet = session.fleetMetadata!;
      const result =
        fleet.structuredResult ??
        parseFleetResultEnvelope(
          fleet.delegation
            ?.expectedResult as SpawnBackgroundRequest["expectedResult"],
          fleet.finalResult ?? "",
        );
      return {
        sessionId: session.id,
        result,
        worktreePath: fleet.worktreePath,
        worktreeBranch: fleet.worktreeBranch,
        score: scoreFleetCandidate(result),
      };
    });
    const winner =
      kind === "best_of_n"
        ? candidates.slice().sort((a, b) => b.score - a.score)[0]
        : undefined;
    return {
      workflowId,
      kind,
      completed: true,
      candidates,
      winnerSessionId: winner?.sessionId,
      summary: winner
        ? `Selected ${winner.sessionId} with evidence score ${winner.score}. Review worktree ${winner.worktreePath ?? "unknown"} before integration.`
        : `Collected ${candidates.length} structured workflow result(s).`,
    };
  }

  private extractToolStatusDetail(toolName: string, input?: unknown): string {
    if (!input || typeof input !== "object") return "";

    const tool = toolName.toLowerCase();
    const obj = input as Record<string, unknown>;
    const pathVal = typeof obj.path === "string" ? obj.path.trim() : "";

    if (!pathVal) return "";

    const compactPath =
      pathVal.length > 60 ? `…${pathVal.slice(-57)}` : pathVal;

    if (tool.includes("read_file")) return `Reading ${compactPath}`;
    if (tool.includes("search_files")) return `Searching ${compactPath}`;
    if (tool.includes("write_file")) return `Writing ${compactPath}`;
    if (tool.includes("find_and_replace")) return `Editing ${compactPath}`;
    if (tool.includes("rename_symbol")) return `Renaming in ${compactPath}`;

    return "";
  }

  private getOrInitBgSummary(sessionId: string): {
    inFlight: boolean;
    generatedAt?: number;
    sourceModel?: string;
    fallbackUsed?: boolean;
    confidence?: number;
    shortStatus?: string;
    lastAttemptAt?: number;
    lastFailureAt?: number;
    lastFailureReason?: string;
    lastInputHash?: string;
    needsRefresh: boolean;
  } {
    const existing = this.bgSummary.get(sessionId);
    if (existing) return existing;
    const init = {
      inFlight: false,
      needsRefresh: true,
    };
    this.bgSummary.set(sessionId, init);
    return init;
  }

  private async tryRefreshBgSummary(args: {
    sessionId: string;
    trigger: "phase_change" | "important_tool" | "error" | "done";
    status: BgSessionInfo["status"];
    currentTool?: string;
    streamingText?: string;
    resultText?: string;
    errorMessage?: string;
  }): Promise<void> {
    const mode = this.host.config.getBgSummaryMode(
      this.sessions.get(args.sessionId)?.projectScope,
    );
    if (mode === "heuristic") return;

    const summary = this.getOrInitBgSummary(args.sessionId);
    const now = Date.now();
    const cooldownMs = 10_000;

    if (summary.inFlight) return;
    if (summary.lastAttemptAt && now - summary.lastAttemptAt < cooldownMs)
      return;

    const contextText = [
      `status=${args.status}`,
      args.currentTool ? `tool=${args.currentTool}` : null,
      args.errorMessage ? `error=${args.errorMessage}` : null,
      args.streamingText ? `stream=${args.streamingText.slice(-500)}` : null,
      args.resultText ? `result=${args.resultText.slice(0, 1000)}` : null,
    ]
      .filter((v): v is string => Boolean(v))
      .join("\n");

    const contextHash = `${args.status}|${args.currentTool ?? ""}|${contextText.slice(-400)}`;
    if (summary.lastInputHash === contextHash && !summary.needsRefresh) return;

    summary.inFlight = true;
    summary.lastAttemptAt = now;
    summary.lastInputHash = contextHash;
    this.notifySessionsChanged();

    try {
      const session = this.sessions.get(args.sessionId);
      if (!session) return;

      const systemPrompt = [
        "Summarize the background agent's current state for a tiny UI status area.",
        "Return ONLY JSON with shape:",
        '{"status":"string","confidence":0.0}',
        "Rules:",
        "- status must be 1-3 words (hard max 5 words)",
        "- concise, phase-oriented wording",
        "- confidence between 0 and 1",
      ].join("\n");

      const userPayload = [
        `Trigger: ${args.trigger}`,
        `Context:\n${contextText}`,
      ].join("\n\n");

      let text = "";
      let selectedModel: string | undefined;
      let fallbackUsed = false;
      let lastError = "";

      if (mode === "openai") {
        const endpoint = getOpenAiCompatibleEndpoint();
        const model = endpoint.model || "openai-compatible";
        const startedAt = Date.now();
        this.activityTraceRecorder.appendBackgroundSummaryEvent?.(
          session.id,
          session.projectScope.projectId,
          {
            type: "start",
            provider: "openai-compatible",
            model,
            startedAt,
            schedulerQueued: false,
          },
        );
        try {
          const result = await callOpenAiCompatibleChat({
            endpoint,
            systemPrompt,
            userContent: userPayload,
            maxTokens: 120,
            temperature: 0,
          });
          text = result.content;
          selectedModel = model;
          this.activityTraceRecorder.appendBackgroundSummaryEvent?.(
            session.id,
            session.projectScope.projectId,
            {
              type: "complete",
              provider: "openai-compatible",
              model,
              startedAt,
              durationMs: Date.now() - startedAt,
            },
          );
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
          this.activityTraceRecorder.appendBackgroundSummaryEvent?.(
            session.id,
            session.projectScope.projectId,
            {
              type: "error",
              provider: "openai-compatible",
              model,
              startedAt,
              durationMs: Date.now() - startedAt,
              error: lastError,
            },
          );
        }
      } else {
        const provider = this.host.providers.tryResolveProvider(session.model);
        if (!provider) {
          summary.lastFailureAt = Date.now();
          summary.lastFailureReason = `No provider for model ${session.model}`;
          summary.needsRefresh = false;
          return;
        }

        const modelCandidates =
          provider.id === "codex"
            ? [...CODEX_CONDENSE_MODEL_FALLBACKS]
            : [provider.condenseModel];
        const uniqueModels = [...new Set(modelCandidates)];

        for (let i = 0; i < uniqueModels.length; i++) {
          const model = uniqueModels[i];
          const startedAt = Date.now();
          const schedulerQueued =
            !this.host.providers.requestScheduler.hasCapacity(
              provider.id,
              "maintenance",
            );
          this.activityTraceRecorder.appendBackgroundSummaryEvent?.(
            session.id,
            session.projectScope.projectId,
            {
              type: "start",
              provider: provider.id,
              model,
              startedAt,
              schedulerQueued,
            },
          );
          let providerQueueWaitMs = 0;
          let permit:
            | import("../core/modelRequestScheduler.js").ModelRequestPermit
            | undefined;
          try {
            permit = await this.host.providers.requestScheduler.acquire(
              provider.id,
              "maintenance",
              session.abortSignal,
            );
            providerQueueWaitMs = permit.waitMs;
            const result = await provider.complete({
              model,
              systemPrompt,
              messages: [{ role: "user", content: userPayload }],
              maxTokens: 120,
              temperature: 0,
            });
            selectedModel = model;
            fallbackUsed = i > 0;
            text = result.text;
            this.activityTraceRecorder.appendBackgroundSummaryEvent?.(
              session.id,
              session.projectScope.projectId,
              {
                type: "complete",
                provider: provider.id,
                model,
                startedAt,
                schedulerQueued,
                providerQueueWaitMs,
                durationMs: Date.now() - startedAt,
              },
            );
            break;
          } catch (err) {
            lastError = err instanceof Error ? err.message : String(err);
            this.activityTraceRecorder.appendBackgroundSummaryEvent?.(
              session.id,
              session.projectScope.projectId,
              {
                type: "error",
                provider: provider.id,
                model,
                startedAt,
                schedulerQueued,
                providerQueueWaitMs,
                durationMs: Date.now() - startedAt,
                error: lastError,
              },
            );
          } finally {
            permit?.release();
          }
        }
      }

      if (!selectedModel || !text.trim()) {
        summary.lastFailureAt = Date.now();
        summary.lastFailureReason =
          lastError || "No model candidate produced a summary";
        summary.needsRefresh = false;
        return;
      }

      let shortStatus = "";
      let confidence: number | undefined;
      try {
        const unfenced = text
          .trim()
          .replace(/^```(?:json)?\s*/i, "")
          .replace(/\s*```$/, "")
          .trim();
        const parsed = JSON.parse(unfenced) as {
          status?: unknown;
          confidence?: unknown;
        };
        shortStatus =
          typeof parsed.status === "string" ? parsed.status.trim() : "";
        confidence =
          typeof parsed.confidence === "number" ? parsed.confidence : undefined;
      } catch {
        shortStatus = "";
      }

      if (!shortStatus) {
        summary.lastFailureAt = Date.now();
        summary.lastFailureReason = "Summary response was not valid JSON";
        summary.needsRefresh = false;
        return;
      }

      const wordCount = shortStatus.split(/\s+/).filter(Boolean).length;
      if (wordCount < 1 || wordCount > 5) {
        summary.lastFailureAt = Date.now();
        summary.lastFailureReason = "Summary status violated 1-5 word rule";
        summary.needsRefresh = false;
        return;
      }

      summary.shortStatus = shortStatus;
      summary.confidence = confidence;
      summary.generatedAt = Date.now();
      summary.sourceModel = selectedModel;
      summary.fallbackUsed = fallbackUsed;
      summary.lastFailureReason = undefined;
      summary.needsRefresh = false;
    } finally {
      summary.inFlight = false;
      this.notifySessionsChanged();
    }
  }

  private maybeScheduleBgSummary(args: {
    sessionId: string;
    event: AgentEvent;
    status: BgSessionInfo["status"];
    currentTool?: string;
    streamingText?: string;
    resultText?: string;
    errorMessage?: string;
    statusDetail?: string;
  }): void {
    const trigger = this.bgSummaryScheduler.evaluate(args);
    if (!trigger) return;

    void this.tryRefreshBgSummary({
      sessionId: args.sessionId,
      trigger,
      status: args.status,
      currentTool: args.currentTool,
      streamingText: args.streamingText,
      resultText: args.resultText,
      errorMessage: args.errorMessage,
    });
  }

  private getBackgroundResultState(
    session: AgentSession,
    done: boolean,
  ): BackgroundResultState | undefined {
    const fleet = session.fleetMetadata;
    if (fleet?.resultState) return fleet.resultState;
    if (!done) return "running";
    switch (fleet?.lifecycle) {
      case "completed":
        return "completed";
      case "failed":
        return "failed";
      case "cancelled":
        return "cancelled";
      case "budget_exhausted":
        return "budget_exhausted";
      case "interrupted":
        return "interrupted";
      default:
        return session.status === "error" ? "failed" : "completed";
    }
  }

  private getProjectedBgStatus(session: AgentSession): {
    status: BgSessionInfo["status"];
    done: boolean;
  } {
    const isCancelled = this.bgCancelled.has(session.id);
    if (isCancelled) {
      return { status: "cancelled", done: true };
    }
    return {
      status: session.status as BgSessionInfo["status"],
      done: session.status === "idle" || session.status === "error",
    };
  }

  private noteBackgroundProgress(
    sessionId: string,
    phase?: BackgroundAgentRuntimePhase,
  ): void {
    const meta = this.bgMeta.get(sessionId);
    if (!meta) return;
    const now = Date.now();
    meta.lastProgressAt = now;
    if (phase && phase !== meta.phase) {
      meta.phase = phase;
      meta.phaseStartedAt = now;
    }
  }

  private noteBackgroundAgentEvent(sessionId: string, event: AgentEvent): void {
    let phase: BackgroundAgentRuntimePhase | undefined;
    switch (event.type) {
      case "api_request_start": {
        const meta = this.bgMeta.get(sessionId);
        if (meta) {
          meta.requestStartedAt = event.startedAt;
          meta.retryAt = undefined;
        }
        phase = "waiting_for_provider";
        break;
      }
      case "thinking_start":
      case "thinking_delta":
      case "condense_start":
      case "condense":
        phase = "thinking";
        break;
      case "text_delta":
        phase = "responding";
        break;
      case "tool_start":
      case "tool_input_delta":
        phase = "executing_tool";
        break;
      case "warning":
        if (event.retryDelayMs) {
          const meta = this.bgMeta.get(sessionId);
          if (meta) meta.retryAt = event.retryAt;
          phase = "retrying_provider";
        }
        break;
      case "api_request": {
        const meta = this.bgMeta.get(sessionId);
        if (meta) {
          meta.requestStartedAt = undefined;
          meta.retryAt = undefined;
        }
        break;
      }
      case "error":
      case "condense_error":
        phase = "failed";
        break;
      case "done":
        phase = "completed";
        break;
      default:
        break;
    }
    this.noteBackgroundProgress(sessionId, phase);
  }

  private getBackgroundRuntimeTelemetry(session: AgentSession): {
    phase: BackgroundAgentRuntimePhase;
    startedAt?: number;
    lastProgressAt?: number;
    phaseStartedAt?: number;
    requestStartedAt?: number;
    requestElapsedMs?: number;
    retryAt?: number;
    elapsedMs: number;
    idleMs?: number;
    budgetUsage: BackgroundAgentBudgetUsage;
    canSteer: boolean;
    canKill: boolean;
  } {
    const meta = this.bgMeta.get(session.id);
    const { status, done } = this.getProjectedBgStatus(session);
    const now = Date.now();
    const isQueued = status === "queued";
    const startedAt = isQueued
      ? undefined
      : (meta?.startedAt ?? session.createdAt);
    const lastProgressAt =
      meta?.lastProgressAt ?? session.lastActiveAt ?? startedAt;
    const completedAt =
      session.fleetMetadata?.completedAt ?? this.bgCompletedAt.get(session.id);
    const endAt = done ? (completedAt ?? lastProgressAt ?? now) : now;
    const elapsedMs =
      startedAt !== undefined ? Math.max(0, endAt - startedAt) : 0;
    const canSteer =
      status === "streaming" ||
      status === "tool_executing" ||
      status === "awaiting_approval";
    const canKill = status === "queued" || canSteer;
    const phase = this.bgCancelled.has(session.id)
      ? "cancelled"
      : status === "error"
        ? "failed"
        : done
          ? "completed"
          : isQueued
            ? "queued"
            : status === "awaiting_approval"
              ? "awaiting_approval"
              : status === "tool_executing"
                ? "executing_tool"
                : (meta?.phase ?? "waiting_for_provider");

    return {
      phase,
      startedAt,
      lastProgressAt,
      phaseStartedAt: meta?.phaseStartedAt,
      requestStartedAt: meta?.requestStartedAt,
      requestElapsedMs: meta?.requestStartedAt
        ? Math.max(0, now - meta.requestStartedAt)
        : undefined,
      retryAt: meta?.retryAt,
      elapsedMs,
      idleMs:
        !done && lastProgressAt ? Math.max(0, now - lastProgressAt) : undefined,
      budgetUsage: {
        tokens: meta?.tokenUsage ?? 0,
        toolCalls: meta?.toolCalls ?? 0,
        apiTurns: meta?.apiTurns ?? 0,
        elapsedMs,
      },
      canSteer,
      canKill,
    };
  }

  /**
   * Non-blocking status check for a background session.
   */
  getBackgroundStatus(sessionId: string): BgStatusResult {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return {
        status: "error",
        done: true,
        partialOutput: "Session not found",
        displayStatus: "Error",
        phase: "failed",
        canSteer: false,
        canKill: false,
      };
    }
    const { status, done } = this.getProjectedBgStatus(session);
    const streamingText = this.bgStreamingText.get(sessionId);
    const heuristicStatus = inferBackgroundDisplayStatus({
      status: status as BgSessionInfo["status"],
      currentTool: session.currentTool,
      streamingText,
      resultText: done
        ? (session.getLastAssistantText() ??
          session.fleetMetadata?.finalResult ??
          session.fleetMetadata?.partialResult ??
          this.bgPartialResults.get(sessionId))
        : undefined,
      errorMessage: this.bgErrors.get(sessionId),
      statusDetail: this.bgStatusDetail.get(sessionId),
    });
    const summary = this.getOrInitBgSummary(sessionId);
    const picked = pickBackgroundDisplayStatus({
      status: status as BgSessionInfo["status"],
      heuristicStatus,
      summary,
    });

    const meta = this.bgMeta.get(sessionId);
    const telemetry = this.getBackgroundRuntimeTelemetry(session);
    const progressSummary = summary.shortStatus?.trim() || picked.displayStatus;
    const fleet = session.fleetMetadata;
    const partialOutput = done
      ? (fleet?.partialResult ??
        this.bgPartialResults.get(sessionId) ??
        session.getLastAssistantText())
      : undefined;

    return {
      status,
      currentTool: session.currentTool,
      done,
      partialOutput,
      displayStatus: picked.displayStatus,
      streamingPreview: streamingText,
      progressSummary,
      resolvedMode: meta?.resolvedMode,
      resolvedModel: meta?.resolvedModel,
      resolvedProvider: meta?.resolvedProvider,
      taskClass: meta?.taskClass,
      toolCalls: meta?.toolCalls,
      tokenUsage: meta?.tokenUsage,
      apiTurns: meta?.apiTurns,
      resultState: this.getBackgroundResultState(session, done),
      terminalReason: fleet?.terminalReason,
      retrySafe: done ? true : undefined,
      agentRetryable: fleet?.agentRetryable,
      phase: telemetry.phase,
      startedAt: telemetry.startedAt,
      lastProgressAt: telemetry.lastProgressAt,
      phaseStartedAt: telemetry.phaseStartedAt,
      requestStartedAt: telemetry.requestStartedAt,
      requestElapsedMs: telemetry.requestElapsedMs,
      retryAt: telemetry.retryAt,
      elapsedMs: telemetry.elapsedMs,
      idleMs: telemetry.idleMs,
      budget: session.fleetMetadata?.budget,
      budgetUsage: telemetry.budgetUsage,
      canSteer: telemetry.canSteer,
      canKill: telemetry.canKill,
    };
  }

  private canManageBackground(
    callerSessionId: string,
    targetSessionId: string,
  ): boolean {
    const caller = this.sessions.get(callerSessionId);
    const target = this.sessions.get(targetSessionId);
    if (!caller || !target?.background) return false;
    if (!caller.background) return caller.id === this.foregroundId;
    let parentId = target.fleetMetadata?.parentSessionId;
    while (parentId) {
      if (parentId === callerSessionId) return true;
      parentId = this.sessions.get(parentId)?.fleetMetadata?.parentSessionId;
    }
    return false;
  }

  getAuthorizedBackgroundStatus(
    callerSessionId: string,
    sessionId: string,
  ): BgStatusResult {
    if (!this.canManageBackground(callerSessionId, sessionId)) {
      return {
        status: "error",
        done: true,
        partialOutput: "Background session is outside the caller's subtree",
        displayStatus: "Unauthorized",
        resultState: "authorization_lost",
        terminalReason: "outside_caller_subtree",
        retrySafe: false,
        phase: "failed",
        canSteer: false,
        canKill: false,
      };
    }
    return this.getBackgroundStatus(sessionId);
  }

  waitForAuthorizedBackground(
    callerSessionId: string,
    sessionId: string,
  ): Promise<string> {
    if (!this.canManageBackground(callerSessionId, sessionId)) {
      return Promise.resolve(
        JSON.stringify({
          status: "authorization_lost",
          terminalReason: "outside_caller_subtree",
          retrySafe: false,
          agentRetryable: false,
          error: "Background session is outside the caller's subtree",
        }),
      );
    }
    return this.waitForBackgroundReleasingSlot(callerSessionId, sessionId);
  }

  /**
   * Wait for a background result, releasing the caller's concurrency slot
   * while blocked. Without this, parents waiting on queued descendants can
   * fill every slot and deadlock the fleet. The caller resumes as soon as
   * the wait resolves, which may briefly overshoot the concurrency limits;
   * the scheduler simply starts nothing new until counts drop back down.
   */
  private waitForBackgroundReleasingSlot(
    callerSessionId: string,
    sessionId: string,
  ): Promise<string> {
    const caller = this.sessions.get(callerSessionId);
    const target = this.sessions.get(sessionId);
    const willBlock =
      caller?.background === true &&
      target !== undefined &&
      this.bgFinalResults.get(sessionId) === undefined &&
      !this.getProjectedBgStatus(target).done;
    if (!willBlock) return this.waitForBackground(sessionId);

    this.bgResultWaitHolds.set(
      callerSessionId,
      (this.bgResultWaitHolds.get(callerSessionId) ?? 0) + 1,
    );
    this.drainBackgroundQueue();
    return this.waitForBackground(sessionId).finally(() => {
      const remaining = (this.bgResultWaitHolds.get(callerSessionId) ?? 1) - 1;
      if (remaining > 0) {
        this.bgResultWaitHolds.set(callerSessionId, remaining);
      } else {
        this.bgResultWaitHolds.delete(callerSessionId);
      }
    });
  }

  async waitForAuthorizedBackgroundContent(
    callerSessionId: string,
    sessionId: string,
  ): Promise<string | BackgroundAgentResultContent> {
    const text = await this.waitForAuthorizedBackground(
      callerSessionId,
      sessionId,
    );
    if (!this.canManageBackground(callerSessionId, sessionId)) return text;

    const session = this.sessions.get(sessionId);
    if (!session) return text;
    const images = session
      .getAllMessages()
      .flatMap((message) =>
        message.role === "assistant" && Array.isArray(message.content)
          ? message.content
              .filter((block): block is ImageBlock => block.type === "image")
              .map((block) => ({
                data: block.source.data,
                mimeType: block.source.media_type,
              }))
          : [],
      )
      .slice(0, MAX_ACP_OUTPUT_IMAGES);
    return images.length > 0 ? { text, images } : text;
  }

  killAuthorizedBackground(
    callerSessionId: string,
    sessionId: string,
    reason?: string,
  ): { killed: boolean; partialOutput?: string } {
    if (!this.canManageBackground(callerSessionId, sessionId)) {
      return {
        killed: false,
        partialOutput: "Background session is outside the caller's subtree",
      };
    }
    return this.killBackground(sessionId, reason);
  }

  steerAuthorizedBackground(
    callerSessionId: string,
    sessionId: string,
    message: string,
  ): { accepted: boolean; reason?: string } {
    if (!this.canManageBackground(callerSessionId, sessionId)) {
      return { accepted: false, reason: "outside the caller's subtree" };
    }
    const session = this.sessions.get(sessionId);
    const instruction = message.trim();
    if (!session || !instruction) {
      return { accepted: false, reason: "session and message are required" };
    }
    if (
      session.status !== "streaming" &&
      session.status !== "tool_executing" &&
      session.status !== "awaiting_approval"
    ) {
      return { accepted: false, reason: "session is not currently running" };
    }
    const accepted = session.setPendingInterjection(
      instruction,
      crypto.randomUUID(),
      undefined,
      instruction,
    );
    this.notifySessionsChanged();
    return accepted
      ? { accepted: true }
      : {
          accepted: false,
          reason: "the session cannot accept steering messages",
        };
  }

  detachAuthorizedBackground(
    callerSessionId: string,
    sessionId: string,
  ): { detached: boolean; reason?: string } {
    if (!this.canManageBackground(callerSessionId, sessionId)) {
      return { detached: false, reason: "outside the caller's subtree" };
    }
    const session = this.sessions.get(sessionId);
    const fleet = session?.fleetMetadata;
    if (!session || !fleet?.parentSessionId) {
      return { detached: false, reason: "session is already a root" };
    }
    const updateSubtree = (
      node: AgentSession,
      rootId: string,
      depth: number,
    ) => {
      if (!node.fleetMetadata) return;
      node.fleetMetadata.rootSessionId = rootId;
      node.fleetMetadata.depth = depth;
      for (const child of this.sessions.values()) {
        if (child.fleetMetadata?.parentSessionId === node.id) {
          updateSubtree(child, rootId, depth + 1);
        }
      }
      this.saveSession(node.id);
    };
    fleet.parentSessionId = undefined;
    this.bgParents.delete(sessionId);
    updateSubtree(session, session.id, 1);
    this.appendFleetEvent(session, "detached", "Subtree detached");
    this.notifySessionsChanged();
    return { detached: true };
  }

  archiveBackground(sessionId: string): { archived: boolean; reason?: string } {
    const session = this.sessions.get(sessionId);
    if (!session?.fleetMetadata || !session.background) {
      return { archived: false, reason: "background session not found" };
    }
    if (
      session.status === "streaming" ||
      session.status === "tool_executing" ||
      session.status === "awaiting_approval" ||
      session.status === "queued"
    ) {
      return { archived: false, reason: "active sessions cannot be archived" };
    }
    session.fleetMetadata.archivedAt = Date.now();
    this.saveSession(sessionId);
    this.notifySessionsChanged();
    return { archived: true };
  }

  pauseBackground(sessionId: string): { paused: boolean; reason?: string } {
    const session = this.sessions.get(sessionId);
    const fleet = session?.fleetMetadata;
    if (!session?.background || !fleet) {
      return { paused: false, reason: "background session not found" };
    }
    if (fleet.backend !== "native") {
      return { paused: false, reason: "backend does not support pause" };
    }
    if (
      session.status !== "queued" &&
      session.status !== "streaming" &&
      session.status !== "tool_executing" &&
      session.status !== "awaiting_approval"
    ) {
      return { paused: false, reason: "session is not active" };
    }
    this.bgLaunchQueue = this.bgLaunchQueue.filter(
      (queued) => queued.sessionId !== sessionId,
    );
    fleet.lifecycle = "paused";
    fleet.terminalReason = "paused_by_user";
    session.abort();
    session.status = "idle";
    this.appendFleetEvent(session, "paused", "Agent paused");
    this.saveSession(sessionId);
    this.notifySessionsChanged();
    return { paused: true };
  }

  async resumeBackground(sessionId: string): Promise<SpawnBackgroundResult> {
    const session = this.sessions.get(sessionId);
    if (session?.fleetMetadata?.lifecycle !== "paused") {
      throw new Error("Only paused background sessions can be resumed");
    }
    const result = await this.retryBackground(sessionId);
    const replacement = this.sessions.get(result.sessionId);
    if (replacement?.fleetMetadata) {
      replacement.fleetMetadata.resumedFromSessionId = sessionId;
      this.appendFleetEvent(replacement, "resumed", "Agent resumed");
      this.saveSession(replacement.id);
    }
    session.fleetMetadata.terminalReason = "resumed_as_new_session";
    session.fleetMetadata.archivedAt = Date.now();
    this.saveSession(sessionId);
    this.notifySessionsChanged();
    return result;
  }

  async retryBackground(sessionId: string): Promise<SpawnBackgroundResult> {
    const session = this.sessions.get(sessionId);
    const fleet = session?.fleetMetadata;
    if (!session?.background || !fleet) {
      throw new Error("Background session not found");
    }
    const firstUserMessage = session
      .getAllMessages()
      .find(
        (message) =>
          message.role === "user" && typeof message.content === "string",
      );
    return this.spawnBackground(
      {
        task: fleet.task,
        message:
          typeof firstUserMessage?.content === "string"
            ? firstUserMessage.content
            : `Retry the task: ${fleet.task}`,
        images: firstUserMessage?.media?.images,
        mode: fleet.resolvedMode,
        model: fleet.resolvedModel,
        provider: fleet.resolvedProvider,
        taskClass: fleet.taskClass,
        ownedPaths: fleet.delegation?.ownedPaths,
        forbiddenPaths: fleet.delegation?.forbiddenPaths,
        permissionProfile: fleet.delegation?.permissionProfile as
          | "review-only"
          | "workspace-safe"
          | "interactive"
          | undefined,
        expectedResult: fleet.delegation?.expectedResult as
          | "text"
          | "review_findings"
          | "patch"
          | "verification"
          | undefined,
        budget: fleet.budget,
        goalId: fleet.goalId,
      },
      fleet.parentSessionId,
    );
  }

  /**
   * Async — blocks until the background session finishes.
   * Returns the last assistant message text.
   * Uses a double-check pattern to prevent races between status check and waiter registration.
   */
  waitForBackground(sessionId: string): Promise<string> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return Promise.resolve(
        JSON.stringify({ error: `No background session: ${sessionId}` }),
      );
    }

    // Check stored result first (set in finally block of completion handler)
    const storedResult = this.bgFinalResults.get(sessionId);
    if (storedResult !== undefined) {
      return Promise.resolve(storedResult);
    }

    // Already done (belt + suspenders)
    if (this.getProjectedBgStatus(session).done) {
      return Promise.resolve(
        session.fleetMetadata?.finalResult ??
          this.resolveBackgroundResult(
            session,
            "(background agent completed without output)",
          ).resultText,
      );
    }

    return new Promise((resolve) => {
      const waiters = this.bgResultWaiters.get(sessionId) ?? [];
      waiters.push(resolve);
      this.bgResultWaiters.set(sessionId, waiters);

      // Double-check after registration to close the race window
      const storedAfter = this.bgFinalResults.get(sessionId);
      if (storedAfter !== undefined) {
        resolve(storedAfter);
        return;
      }

      // Safety timeout: resolve after 30 minutes as a last resort to prevent
      // permanently hung waiters (e.g. if the session crashes without cleanup).
      const safetyMs = 30 * 60 * 1000;
      const timerId = this.host.timers.setTimeout(() => {
        this.log?.(
          `[background] Result waiter timed out for ${sessionId}; background agent is still allowed to continue running.`,
        );
        resolve(
          session.getLastAssistantText() ??
            "(background agent timed out waiting for result)",
        );
      }, safetyMs);
      const timers = this.bgSafetyTimers.get(sessionId) ?? [];
      timers.push(timerId);
      this.bgSafetyTimers.set(sessionId, timers);
    });
  }

  /** Append bounded streaming evidence while keeping a compact UI preview. */
  appendBgStreamingText(sessionId: string, text: string): void {
    const existing = this.bgPartialResults.get(sessionId) ?? "";
    const updated = existing + text;
    const partialResult =
      updated.length > MAX_BACKGROUND_PARTIAL_RESULT_CHARS
        ? updated.slice(-MAX_BACKGROUND_PARTIAL_RESULT_CHARS)
        : updated;
    this.bgPartialResults.set(sessionId, partialResult);
    this.bgStreamingText.set(sessionId, partialResult.slice(-500));
    const fleet = this.sessions.get(sessionId)?.fleetMetadata;
    if (fleet) fleet.partialResult = partialResult;
  }

  /** Record a bg session error message and provider retryability. */
  setBgError(sessionId: string, error: string, retryable = false): void {
    this.bgErrors.set(sessionId, error);
    this.bgAgentRetryable.set(sessionId, retryable);
    const fleet = this.sessions.get(sessionId)?.fleetMetadata;
    if (fleet) fleet.agentRetryable = retryable;
  }

  /** Mark a bg session as completed with a timestamp. */
  markBgCompleted(sessionId: string): void {
    const completedAt = Date.now();
    this.bgCompletedAt.set(sessionId, completedAt);
    const session = this.sessions.get(sessionId);
    const meta = this.bgMeta.get(sessionId);
    if (meta) {
      meta.lastProgressAt = completedAt;
      meta.phase = this.bgCancelled.has(sessionId)
        ? "cancelled"
        : session?.status === "error"
          ? "failed"
          : "completed";
    }
    if (session?.fleetMetadata) {
      session.fleetMetadata.completedAt = completedAt;
    }
  }

  private appendFleetEvent(
    session: AgentSession,
    type: NonNullable<PersistedFleetMetadata["events"]>[number]["type"],
    summary: string,
  ): void {
    const fleet = session.fleetMetadata;
    if (!fleet) return;
    const existing = fleet.events?.at(-1);
    if (existing?.type === type && !existing.readAt) return;
    const sequence = (fleet.eventSequence ?? 0) + 1;
    fleet.eventSequence = sequence;
    const event = {
      id: `${session.id}:${sequence}`,
      sequence,
      type,
      timestamp: Date.now(),
      summary: summary.slice(0, 240),
    };
    fleet.events = [...(fleet.events ?? []).slice(-99), event];
    this.saveSession(session.id);
    this.onFleetEvent?.(session.id, event);
    for (const listener of this.fleetEventListeners) {
      listener(session.id, event);
    }
    this.notifySessionsChanged();
  }

  private appendPolicyAudit(
    session: AgentSession,
    entry: {
      decision: "allowed" | "denied" | "approval_requested";
      operation: string;
      reason: string;
      path?: string;
    },
  ): void {
    const fleet = session.fleetMetadata;
    if (!fleet) return;
    fleet.policyAudit = [
      ...(fleet.policyAudit ?? []).slice(-199),
      {
        id: crypto.randomUUID(),
        timestamp: Date.now(),
        ...entry,
      },
    ];
    this.saveSession(session.id);
    this.notifySessionsChanged();
  }

  markFleetEventsRead(sessionId: string): { marked: number } {
    const session = this.sessions.get(sessionId);
    const events = session?.fleetMetadata?.events;
    if (!events) return { marked: 0 };
    const readAt = Date.now();
    let marked = 0;
    for (const event of events) {
      if (!event.readAt) {
        event.readAt = readAt;
        marked += 1;
      }
    }
    if (marked) {
      this.saveSession(sessionId);
      this.notifySessionsChanged();
    }
    return { marked };
  }

  private createFleetMetadata(
    session: AgentSession,
    args: Omit<
      PersistedFleetMetadata,
      "schemaVersion" | "placement" | "rootSessionId" | "depth" | "lifecycle"
    >,
  ): PersistedFleetMetadata {
    const parent = args.parentSessionId
      ? this.sessions.get(args.parentSessionId)
      : undefined;
    return {
      schemaVersion: 1,
      placement: "background",
      ...args,
      rootSessionId:
        parent?.fleetMetadata?.rootSessionId ??
        args.parentSessionId ??
        session.id,
      depth: parent?.fleetMetadata ? parent.fleetMetadata.depth + 1 : 1,
      lifecycle: "running",
      resultState: "running",
    };
  }

  private finalizeFleetMetadata(
    session: AgentSession,
    resolution: {
      resultText: string;
      structuredResult: import("./FleetWorkflows.js").FleetResultEnvelope;
      resultState: BackgroundResultState;
      partialResult?: string;
    },
  ): void {
    const fleet = session.fleetMetadata;
    if (!fleet) return;
    this.bgBudgetWrapUps.delete(session.id);
    fleet.completedAt = this.bgCompletedAt.get(session.id) ?? Date.now();
    fleet.finalResult = resolution.resultText;
    fleet.structuredResult = resolution.structuredResult;
    fleet.resultState = resolution.resultState;
    fleet.partialResult = resolution.partialResult;
    fleet.agentRetryable = this.bgAgentRetryable.get(session.id);
    const meta = this.bgMeta.get(session.id);
    if (meta) {
      fleet.budgetUsage = {
        tokens: meta.tokenUsage,
        toolCalls: meta.toolCalls,
        apiTurns: meta.apiTurns,
        elapsedMs: Math.max(0, Date.now() - meta.startedAt),
        estimatedCostUsd: fleet.budget?.estimatedCostPerMillionTokens
          ? (meta.tokenUsage / 1_000_000) *
            fleet.budget.estimatedCostPerMillionTokens
          : undefined,
      };
    }
    if (resolution.resultState === "completed") {
      fleet.lifecycle = "completed";
      fleet.terminalReason = undefined;
      fleet.agentRetryable = undefined;
      session.status = "idle";
      this.bgErrors.delete(session.id);
      this.bgAgentRetryable.delete(session.id);
      this.appendFleetEvent(session, "completed", "Agent completed");
    } else if (resolution.resultState === "cancelled") {
      fleet.lifecycle = "cancelled";
      fleet.terminalReason ??= "cancelled_by_user";
      this.appendFleetEvent(session, "cancelled", "Agent cancelled");
    } else if (resolution.resultState === "budget_exhausted") {
      fleet.lifecycle = "budget_exhausted";
      this.appendFleetEvent(
        session,
        "failed",
        fleet.terminalReason ?? "budget_exhausted",
      );
    } else if (resolution.resultState === "interrupted") {
      fleet.lifecycle = "interrupted";
      fleet.terminalReason ??= "background_agent_interrupted";
      this.appendFleetEvent(session, "failed", fleet.terminalReason);
    } else {
      fleet.lifecycle = "failed";
      fleet.terminalReason =
        resolution.resultState === "incomplete_expected_result"
          ? "incomplete_expected_result"
          : (this.bgErrors.get(session.id) ?? "agent_error");
      this.appendFleetEvent(session, "failed", fleet.terminalReason);
    }
  }

  private resolveBackgroundResult(
    session: AgentSession,
    fallbackText: string,
  ): {
    resultText: string;
    structuredResult: import("./FleetWorkflows.js").FleetResultEnvelope;
    resultState: BackgroundResultState;
    partialResult?: string;
  } {
    // A valid final marker is authoritative even if the provider disconnects
    // immediately afterward. The marker is already persisted in session history.
    const marker = session.getLastFinalMarker?.();
    if (marker?.result) {
      return {
        resultText: formatFleetResultEnvelope(marker.result),
        structuredResult: marker.result,
        resultState: "completed",
      };
    }

    const durablePartialResult =
      this.bgPartialResults.get(session.id) ??
      session.fleetMetadata?.partialResult;
    const partialResult =
      session.fleetMetadata?.placement === "worktree"
        ? (durablePartialResult ??
          session.getLastAssistantText() ??
          marker?.summary)
        : (session.getLastAssistantText() ??
          marker?.summary ??
          durablePartialResult);
    const rawText = partialResult ?? fallbackText;
    const expected = session.fleetMetadata?.delegation
      ?.expectedResult as SpawnBackgroundRequest["expectedResult"];
    const structuredResult = parseFleetResultEnvelope(expected, rawText);
    let resultState: BackgroundResultState = "completed";
    if (this.bgCancelled.has(session.id)) {
      resultState = "cancelled";
    } else if (
      session.fleetMetadata?.terminalReason?.startsWith("budget_exhausted:")
    ) {
      resultState = "budget_exhausted";
    } else if (session.fleetMetadata?.lifecycle === "interrupted") {
      resultState = "interrupted";
    } else if (
      expected &&
      expected !== "text" &&
      structuredResult.type === expected
    ) {
      // A valid expected envelope is authoritative even if a late provider error
      // changed the transport status after the response was captured.
      resultState = "completed";
    } else if (session.status === "error") {
      resultState = "failed";
    } else if (
      expected &&
      expected !== "text" &&
      structuredResult.type !== expected
    ) {
      resultState = "incomplete_expected_result";
    }

    if (resultState === "completed") {
      return {
        resultText:
          structuredResult.type === "text"
            ? structuredResult.text
            : formatFleetResultEnvelope(structuredResult),
        structuredResult,
        resultState,
      };
    }

    const terminalReason =
      resultState === "incomplete_expected_result"
        ? "incomplete_expected_result"
        : (this.bgErrors.get(session.id) ??
          session.fleetMetadata?.terminalReason ??
          resultState);
    const failureResult = JSON.stringify({
      status: resultState,
      terminalReason,
      retrySafe: true,
      agentRetryable: this.bgAgentRetryable.get(session.id) ?? false,
      ...(partialResult ? { partialOutput: partialResult } : {}),
    });
    return {
      resultText: failureResult,
      structuredResult: { type: "text", text: failureResult },
      resultState,
      partialResult,
    };
  }

  private enforceBackgroundBudget(session: AgentSession): boolean {
    const owners = Array.from(this.sessions.values()).filter((candidate) => {
      const budget = candidate.fleetMetadata?.budget;
      if (!budget) return false;
      if (candidate.id === session.id) return true;
      if (budget.scope === "goal") {
        return (
          Boolean(candidate.fleetMetadata?.goalId) &&
          candidate.fleetMetadata?.goalId === session.fleetMetadata?.goalId
        );
      }
      return (
        budget.scope === "subtree" &&
        this.isFleetDescendant(session.id, candidate.id)
      );
    });
    for (const owner of owners) {
      if (this.enforceBudgetOwner(owner)) return true;
    }
    return false;
  }

  private ensureChildBudgetAdmission(
    parent: AgentSession | undefined,
    request: SpawnBackgroundRequest,
  ): void {
    if (!parent || !request.budget) return;
    let owner: AgentSession | undefined = parent;
    while (
      owner &&
      (!owner.fleetMetadata?.budget ||
        owner.fleetMetadata.budget.scope === "session")
    ) {
      const parentId: string | undefined = owner.fleetMetadata?.parentSessionId;
      owner = parentId ? this.sessions.get(parentId) : undefined;
    }
    const envelope = owner?.fleetMetadata?.budget;
    if (!owner || !envelope) return;
    const activeMembers = Array.from(this.sessions.values()).filter(
      (candidate) =>
        candidate.id !== owner!.id &&
        (candidate.fleetMetadata?.lifecycle === "queued" ||
          candidate.fleetMetadata?.lifecycle === "running") &&
        (envelope.scope === "goal"
          ? Boolean(owner!.fleetMetadata?.goalId) &&
            candidate.fleetMetadata?.goalId === owner!.fleetMetadata?.goalId
          : this.isFleetDescendant(candidate.id, owner!.id)),
    );
    const fields: Array<
      [keyof NonNullable<PersistedFleetMetadata["budget"]>, string]
    > = [
      ["maxTokens", "tokens"],
      ["maxToolCalls", "tool calls"],
      ["maxApiTurns", "API turns"],
      ["maxElapsedMs", "elapsed time"],
      ["maxEstimatedCostUsd", "estimated cost"],
    ];
    for (const [field, label] of fields) {
      const limit = envelope[field];
      const requested = request.budget[field];
      if (typeof limit !== "number" || typeof requested !== "number") continue;
      const reserved = activeMembers.reduce((sum, member) => {
        const value = member.fleetMetadata?.budget?.[field];
        return sum + (typeof value === "number" ? value : 0);
      }, 0);
      if (reserved + requested > limit) {
        throw new FleetAdmissionError({
          ok: false,
          code: "budget_reservation",
          message: `Background spawn rejected: ${label} reservation exceeds the parent ${envelope.scope ?? "subtree"} budget.`,
          limit,
        });
      }
    }
  }

  private ensureSharedWorkspaceScopeAvailable(
    request: SpawnBackgroundRequest,
  ): void {
    if (request.worktree === "isolated" || !request.ownedPaths?.length) return;
    const normalize = (value: string) =>
      value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
    const overlaps = (left: string, right: string) => {
      const a = normalize(left);
      const b = normalize(right);
      return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
    };
    for (const session of this.sessions.values()) {
      const fleet = session.fleetMetadata;
      if (
        !session.background ||
        fleet?.placement !== "background" ||
        (fleet.lifecycle !== "queued" && fleet.lifecycle !== "running")
      ) {
        continue;
      }
      const conflicting = request.ownedPaths.find((requested) =>
        fleet.delegation?.ownedPaths?.some((owned) =>
          overlaps(requested, owned),
        ),
      );
      if (conflicting) {
        throw new FleetAdmissionError({
          ok: false,
          code: "workspace_conflict",
          message: `Background spawn rejected: shared-workspace ownership overlaps active agent ${session.id} at ${conflicting}. Use worktree: 'isolated' or choose a disjoint scope.`,
        });
      }
    }
  }

  private async spawnIsolatedWorktree(
    request: SpawnBackgroundRequest,
    parent: AgentSession | undefined,
  ): Promise<SpawnBackgroundResult> {
    const toolCtx = this.toolCtx;
    const provider = toolCtx?.worktreeAgentLaunchProvider;
    const globalStoragePath = toolCtx?.globalStorageUri?.fsPath;
    if (!provider || !globalStoragePath) {
      throw new Error("Isolated worktree launcher is unavailable");
    }
    const mode = request.mode?.trim() || parent?.mode || "code";
    const model = request.model?.trim() || parent?.model || this.config.model;
    const session = await this.createBoundSession({
      mode,
      config: { ...this.config, model },
      projectScope: parent?.projectScope ?? this.selectProjectScope(),
      workspaceFolders: this.getWorkspaceFolders(),
      devMode: this.devMode,
      background: true,
      isBackground: true,
      providerId: "worktree",
    });
    session.title = request.task.slice(0, 80);
    session.addUserMessage(request.message);
    session.status = "streaming";
    this.sessions.set(session.id, session);
    if (parent) {
      this.inheritBackgroundApprovalMode(parent.id, session.id);
    }
    this.bgMeta.set(session.id, {
      resolvedMode: mode,
      resolvedModel: model,
      resolvedProvider: "worktree",
      taskClass: request.taskClass ?? "general",
      routingReason: "isolated worktree delegation",
      fallbackUsed: false,
      toolCalls: 0,
      tokenUsage: 0,
      apiTurns: 0,
      startedAt: Date.now(),
      lastProgressAt: Date.now(),
      phase: "waiting_for_provider",
    });
    session.fleetMetadata = this.createFleetMetadata(session, {
      task: request.task,
      parentSessionId: parent?.id,
      backend: "native",
      resolvedMode: mode,
      resolvedModel: model,
      resolvedProvider: "worktree",
      taskClass: request.taskClass ?? "general",
      routingReason: "isolated worktree delegation",
      fallbackUsed: false,
      delegation: {
        ownedPaths: request.ownedPaths,
        forbiddenPaths: request.forbiddenPaths,
        permissionProfile: request.permissionProfile,
        worktree: "isolated",
        expectedResult: request.expectedResult,
      },
      budget: request.budget,
      goalId: request.goalId,
      workflowId: request.workflowId,
    });
    session.fleetMetadata.placement = "worktree";
    session.fleetMetadata.lifecycle = "running";
    const exchangeStore = new WorktreeFleetExchangeStore(globalStoragePath);
    const sourceWorkspacePath = this.requireSessionExecution(session);
    const exchange = await exchangeStore.create({
      parentFleetSessionId: session.id,
      sourceWorkspacePath,
    });
    session.fleetMetadata.worktreeExchangeId = exchange.id;
    this.appendFleetEvent(session, "queued", "Worktree agent launch requested");
    this.saveSession(session.id);
    this.notifySessionsChanged();
    try {
      const approvalMode = this.getSessionApprovalMode(session.id);
      const result = await provider.start({
        task: request.task,
        prompt: withFleetResultInstruction(
          request.expectedResult,
          request.message,
        ),
        sourcePath: sourceWorkspacePath,
        mode: request.mode,
        autoSubmit: true,
        fleetExchangeId: exchange.id,
        ...approvalMode,
      });
      const text =
        result.content.find((item) => item.type === "text")?.text ?? "{}";
      const payload = JSON.parse(text) as Record<string, unknown>;
      if (payload.error || payload.status === "rejected") {
        throw new Error(String(payload.error ?? "Worktree launch rejected"));
      }
      const worktreePath =
        typeof payload.worktreePath === "string"
          ? payload.worktreePath
          : undefined;
      session.fleetMetadata.worktreePath = worktreePath;
      session.fleetMetadata.worktreeBranch =
        typeof payload.branch === "string" ? payload.branch : undefined;
      await exchangeStore.update(exchange.id, { worktreePath });
      this.appendFleetEvent(session, "started", "Worktree window opened");
      this.startWorktreeExchangeMonitor(session, exchangeStore, exchange.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      session.status = "error";
      session.fleetMetadata.lifecycle = "failed";
      session.fleetMetadata.terminalReason = "worktree_launch_failed";
      session.fleetMetadata.finalResult = message;
      session.fleetMetadata.completedAt = Date.now();
      await exchangeStore.update(exchange.id, {
        status: "failed",
        error: message,
      });
      this.appendFleetEvent(session, "failed", message);
      this.saveSession(session.id);
      throw error;
    }
    return {
      sessionId: session.id,
      resolvedMode: mode,
      resolvedModel: model,
      resolvedProvider: "worktree",
      taskClass: request.taskClass ?? "general",
      routingReason: "isolated worktree delegation",
      fallbackUsed: false,
    };
  }

  private startWorktreeExchangeMonitor(
    session: AgentSession,
    store: WorktreeFleetExchangeStore,
    exchangeId: string,
  ): void {
    const poll = async () => {
      const record = await store.read(exchangeId);
      if (!record || !session.fleetMetadata) return;
      session.fleetMetadata.childSessionId = record.childSessionId;
      session.fleetMetadata.worktreePath = record.worktreePath;
      if (record.status === "claimed" || record.status === "running") {
        session.status = "streaming";
        session.fleetMetadata.lifecycle = "running";
      } else if (
        record.status === "completed" ||
        record.status === "failed" ||
        record.status === "cancelled"
      ) {
        const timer = this.worktreeMonitorTimers.get(session.id);
        if (timer) this.host.timers.clearInterval(timer);
        this.worktreeMonitorTimers.delete(session.id);
        session.status = record.status === "failed" ? "error" : "idle";
        session.fleetMetadata.lifecycle = record.status;
        session.fleetMetadata.terminalReason =
          record.status === "completed"
            ? undefined
            : (record.error ?? `worktree_${record.status}`);
        if (record.status === "cancelled") {
          this.bgCancelled.add(session.id);
        } else if (record.status === "failed") {
          this.setBgError(
            session.id,
            record.error ?? "Worktree background agent failed",
            false,
          );
        }
        const rawResult =
          record.resultText ??
          record.error ??
          "Worktree agent ended without output";
        this.bgPartialResults.set(session.id, rawResult);
        const resolution = this.resolveBackgroundResult(session, rawResult);
        const meta = this.bgMeta.get(session.id);
        if (meta && record.usage) {
          meta.tokenUsage =
            record.usage.inputTokens + record.usage.outputTokens;
        }
        this.finalizeFleetMetadata(session, resolution);
        await this.saveSessionNow(session.id);
        this.bgFinalResults.set(session.id, resolution.resultText);
        for (const resolve of this.bgResultWaiters.get(session.id) ?? []) {
          resolve(resolution.resultText);
        }
        this.bgResultWaiters.delete(session.id);
      } else {
        this.saveSession(session.id);
      }
      this.notifySessionsChanged();
    };
    const timer = this.host.timers.setInterval(() => {
      void poll().catch((error) =>
        this.log?.(`[worktree-fleet] exchange poll failed: ${String(error)}`),
      );
    }, 1000);
    this.worktreeMonitorTimers.set(session.id, timer);
    void poll();
  }

  private isFleetDescendant(sessionId: string, ancestorId: string): boolean {
    let parentId = this.sessions.get(sessionId)?.fleetMetadata?.parentSessionId;
    const visited = new Set<string>();
    while (parentId && !visited.has(parentId)) {
      if (parentId === ancestorId) return true;
      visited.add(parentId);
      parentId = this.sessions.get(parentId)?.fleetMetadata?.parentSessionId;
    }
    return false;
  }

  /**
   * Best-effort budget message injection into running in-process members.
   * External backends (ACP, worktree) have no interjection channel and are
   * skipped. Returns true when at least one member accepted the message.
   */
  private injectBudgetInterjection(
    members: AgentSession[],
    text: string,
  ): boolean {
    let accepted = false;
    for (const member of members) {
      const fleet = member.fleetMetadata;
      if (!fleet || fleet.backend !== "native") continue;
      if (fleet.placement !== "background") continue;
      if (fleet.lifecycle !== "running" && fleet.lifecycle !== "queued") {
        continue;
      }
      if (member.setPendingInterjection(text, crypto.randomUUID())) {
        accepted = true;
      }
    }
    return accepted;
  }

  private enforceBudgetOwner(owner: AgentSession): boolean {
    const fleet = owner.fleetMetadata;
    const budget = fleet?.budget;
    if (!fleet || !budget) return false;
    // Never re-enforce a session that already reached a terminal state (a
    // stale grace timer could otherwise mark a completed session as failed).
    if (fleet.lifecycle !== "running" && fleet.lifecycle !== "queued") {
      return false;
    }
    const members = Array.from(this.sessions.values()).filter((candidate) => {
      if (budget.scope === "goal") {
        return (
          Boolean(fleet.goalId) &&
          candidate.fleetMetadata?.goalId === fleet.goalId
        );
      }
      if (budget.scope === "subtree") {
        return (
          candidate.id === owner.id ||
          this.isFleetDescendant(candidate.id, owner.id)
        );
      }
      return candidate.id === owner.id;
    });
    const usage = members.reduce(
      (total, member) => {
        const meta = this.bgMeta.get(member.id);
        if (!meta) return total;
        total.tokens += meta.tokenUsage;
        total.toolCalls += meta.toolCalls;
        total.apiTurns += meta.apiTurns;
        total.elapsedMs += Math.max(0, Date.now() - meta.startedAt);
        return total;
      },
      { tokens: 0, toolCalls: 0, apiTurns: 0, elapsedMs: 0 },
    );
    const estimatedCostUsd = budget.estimatedCostPerMillionTokens
      ? (usage.tokens / 1_000_000) * budget.estimatedCostPerMillionTokens
      : 0;
    const checks: Array<[number | undefined, number, string]> = [
      [budget.maxTokens, usage.tokens, "tokens"],
      [budget.maxToolCalls, usage.toolCalls, "tool_calls"],
      [budget.maxApiTurns, usage.apiTurns, "api_turns"],
      [budget.maxElapsedMs, usage.elapsedMs, "elapsed_time"],
      [budget.maxEstimatedCostUsd, estimatedCostUsd, "estimated_cost"],
    ];
    const warningThreshold = Math.min(
      0.99,
      Math.max(0, budget.warningThresholdRatio ?? 0.8),
    );
    const warning = checks
      .map(([limit, used, kind]) => ({
        kind,
        ratio: limit && limit > 0 ? used / limit : 0,
      }))
      .find(({ ratio }) => ratio >= warningThreshold);
    if (warning && warning.ratio < 1 && !fleet.budgetWarning) {
      fleet.budgetWarning = {
        ...warning,
        emittedAt: Date.now(),
      };
      this.appendFleetEvent(
        owner,
        "budget_warning",
        `${warning.kind} budget at ${Math.round(warning.ratio * 100)}%`,
      );
      // Tell the agent, not just the UI — leave enough budget headroom to
      // finish and deliver findings rather than getting cut off mid-work.
      this.injectBudgetInterjection(
        members,
        `[fleet budget] About ${Math.round(warning.ratio * 100)}% of the ${formatBudgetKind(warning.kind)} budget for this task is used. Prioritize the remaining work and start wrapping up so you can deliver your findings before the budget runs out.`,
      );
      this.saveSession(owner.id);
      this.notifySessionsChanged();
    }
    const hardExhausted = checks.find(
      ([limit, used]) =>
        limit !== undefined &&
        limit >= 0 &&
        used >= limit * BUDGET_HARD_LIMIT_RATIO,
    );
    const exhausted = checks.find(
      ([limit, used]) => limit !== undefined && limit >= 0 && used >= limit,
    );
    if (!exhausted) return false;

    const [, , exhaustedKind] = exhausted;
    if (!this.bgBudgetWrapUps.has(owner.id)) {
      const accepted = this.injectBudgetInterjection(
        members,
        `[fleet budget] The planned ${formatBudgetKind(exhaustedKind)} budget for this task has been reached. Finish promptly, but use any additional tool calls that are genuinely needed to produce a correct, useful result. A hard safety backstop remains well beyond this soft limit.`,
      );
      this.bgBudgetWrapUps.set(owner.id, { kind: exhaustedKind });
      this.appendFleetEvent(
        owner,
        "budget_warning",
        accepted
          ? `${exhaustedKind} planned budget reached — prompt finish requested`
          : `${exhaustedKind} soft limit reached — hard backstop active`,
      );
      this.saveSession(owner.id);
      this.notifySessionsChanged();
    }
    if (!hardExhausted) return false;

    this.bgBudgetWrapUps.delete(owner.id);
    const [, , hardExhaustedKind] = hardExhausted;
    const reason = `budget_exhausted:${hardExhaustedKind}`;
    fleet.terminalReason = reason;
    owner.status = "error";
    this.setBgError(owner.id, reason);
    owner.abort();
    // Budget exhaustion owns the subtree just like explicit cancellation.
    for (const candidate of this.sessions.values()) {
      if (
        this.isFleetDescendant(candidate.id, owner.id) &&
        candidate.fleetMetadata?.lifecycle !== "completed" &&
        candidate.fleetMetadata?.lifecycle !== "failed" &&
        candidate.fleetMetadata?.lifecycle !== "cancelled" &&
        candidate.fleetMetadata?.lifecycle !== "budget_exhausted"
      ) {
        this.stopSession(candidate.id);
        if (candidate.fleetMetadata) {
          candidate.fleetMetadata.terminalReason = "parent_budget_exhausted";
          this.saveSession(candidate.id);
          this.notifySessionsChanged();
        }
      }
    }
    return true;
  }

  private cancelOwnedChildrenOnCompletion(parentSessionId: string): void {
    for (const child of this.sessions.values()) {
      const fleet = child.fleetMetadata;
      if (
        fleet?.parentSessionId !== parentSessionId ||
        fleet.lifecycle === "completed" ||
        fleet.lifecycle === "failed" ||
        fleet.lifecycle === "cancelled" ||
        fleet.lifecycle === "budget_exhausted" ||
        fleet.lifecycle === "interrupted"
      ) {
        continue;
      }
      this.stopSession(child.id);
      if (child.fleetMetadata) {
        child.fleetMetadata.terminalReason = "parent_completed_without_join";
        this.saveSession(child.id);
        this.notifySessionsChanged();
      }
    }
  }

  /**
   * Resolve the user-facing result for a background session. Prefers the
   * structured set_task_status result (final marker) over trailing assistant
   * prose — the final assistant message is often a bare tool call with no
   * text. Safe to call from the `done` event handler, which fires before
   * bgFinalResults is populated: the marker is already on the session then.
   */
  getBackgroundResult(sessionId: string): {
    resultText?: string;
    summary?: string;
  } {
    const session = this.sessions.get(sessionId);
    const marker = session?.getLastFinalMarker?.();
    const resultText =
      this.bgFinalResults.get(sessionId) ??
      (marker?.result ? formatFleetResultEnvelope(marker.result) : undefined) ??
      session?.fleetMetadata?.finalResult ??
      session?.getLastAssistantText();
    return { resultText, summary: marker?.summary };
  }

  getBackgroundResultSummary(sessionId: string): string | undefined {
    const finalSummary = this.getBackgroundResult(sessionId).summary?.trim();
    if (finalSummary) return finalSummary;

    const summary = this.bgSummary.get(sessionId)?.shortStatus?.trim();
    if (summary) return summary;

    const session = this.sessions.get(sessionId);
    if (!session) return undefined;

    const isCancelled = this.bgCancelled.has(sessionId);
    if (isCancelled) return "Cancelled";
    if (session.status === "error") return "Error";

    return summarizeTextForPreview(
      this.getBackgroundResult(sessionId).resultText,
      {
        maxLength: 220,
        minSentenceLength: 20,
      },
    );
  }

  getBackgroundParentSessionId(sessionId: string): string | undefined {
    const session = this.sessions.get(sessionId);
    return (
      session?.fleetMetadata?.parentSessionId ??
      this.bgParents.get(sessionId)?.sessionId
    );
  }

  /**
   * Return status info for all background sessions (for the UI strip).
   */
  getBgSessionInfos(): BgSessionInfo[] {
    const foregroundId = this.foregroundId;
    const visibleAfter = Date.now() - FLEET_VISIBILITY_MAX_AGE_MS;
    const infos = Array.from(this.sessions.values())
      .filter((session) => {
        if (!session.background) return false;

        const fleet = session.fleetMetadata;
        if (foregroundId) {
          const parentId =
            fleet?.parentSessionId ?? this.bgParents.get(session.id)?.sessionId;
          const belongsToForeground =
            fleet?.rootSessionId === foregroundId || parentId === foregroundId;
          if (!belongsToForeground) return false;
        }

        const { done } = this.getProjectedBgStatus(session);
        if (!done || fleet?.lifecycle === "paused") return true;
        const mostRecentActivity =
          fleet?.completedAt ?? session.lastActiveAt ?? session.createdAt;
        return mostRecentActivity >= visibleAfter;
      })
      .map((s): BgSessionInfo => {
        const { status, done: isDone } = this.getProjectedBgStatus(s);
        const meta = this.bgMeta.get(s.id);
        const telemetry = this.getBackgroundRuntimeTelemetry(s);
        const streamingText = this.bgStreamingText.get(s.id);
        const resultText = isDone
          ? (s.getLastAssistantText() ??
            s.fleetMetadata?.finalResult ??
            s.fleetMetadata?.partialResult ??
            this.bgPartialResults.get(s.id))
          : undefined;
        const errorMessage = this.bgErrors.get(s.id);
        const heuristicStatus = inferBackgroundDisplayStatus({
          status,
          currentTool: s.currentTool,
          streamingText,
          resultText,
          errorMessage,
          statusDetail: this.bgStatusDetail.get(s.id),
        });
        const summary = this.getOrInitBgSummary(s.id);
        const picked = pickBackgroundDisplayStatus({
          status,
          heuristicStatus,
          summary,
        });
        const events = s.fleetMetadata?.events ?? [];
        const unreadEvents = events.filter((event) => !event.readAt);
        const latestUnread = unreadEvents.at(-1);
        const eventKind =
          latestUnread?.type === "question"
            ? "question"
            : status === "awaiting_approval" ||
                latestUnread?.type === "approval"
              ? "approval"
              : latestUnread?.type === "budget_warning"
                ? "budget_warning"
                : s.fleetMetadata?.lifecycle === "interrupted"
                  ? "interrupted"
                  : status === "error"
                    ? "failure"
                    : s.fleetMetadata?.lifecycle === "completed"
                      ? "completion"
                      : undefined;
        const eventTimestamp =
          s.fleetMetadata?.completedAt ?? s.lastActiveAt ?? s.createdAt;

        return {
          id: s.id,
          task: s.title,
          status,
          currentTool: s.currentTool,
          displayStatus: picked.displayStatus,
          displayStatusSource: picked.displayStatusSource,
          resolvedMode: meta?.resolvedMode,
          resolvedModel: meta?.resolvedModel,
          resolvedProvider: meta?.resolvedProvider,
          taskClass: meta?.taskClass,
          routingReason: meta?.routingReason,
          fallbackUsed: meta?.fallbackUsed,
          parentSessionId: this.getBackgroundParentSessionId(s.id),
          rootSessionId: s.fleetMetadata?.rootSessionId,
          goalId: s.fleetMetadata?.goalId,
          workflowId: s.fleetMetadata?.workflowId,
          workspace: s.projectScope.displayName,
          worktreePath: s.fleetMetadata?.worktreePath,
          worktreeBranch: s.fleetMetadata?.worktreeBranch,
          depth: s.fleetMetadata?.depth,
          placement: s.fleetMetadata?.placement,
          delegation: s.fleetMetadata?.delegation,
          backend: s.fleetMetadata?.backend,
          capabilities: s.fleetMetadata
            ? s.fleetMetadata.backend === "native"
              ? {
                  canRead: true,
                  canWrite:
                    s.fleetMetadata.delegation?.permissionProfile !==
                    "review-only",
                  canExecute: true,
                  canUseMcp: true,
                  canDelegate: true,
                  limitationReason:
                    s.fleetMetadata.delegation?.permissionProfile ===
                    "review-only"
                      ? "The delegation can execute only classifier-approved read-only commands."
                      : undefined,
                }
              : {
                  canRead: true,
                  canWrite: !s.fleetMetadata.readonlyOnly,
                  canExecute: !s.fleetMetadata.readonlyOnly,
                  canUseMcp: false,
                  canDelegate: false,
                  limitationReason: s.fleetMetadata.readonlyOnly
                    ? "This ACP backend declares read-only operation."
                    : "Capabilities are declared by the ACP backend.",
                }
            : undefined,
          lifecycle: s.fleetMetadata?.lifecycle,
          terminalReason: s.fleetMetadata?.terminalReason,
          createdAt: s.createdAt,
          lastActiveAt: s.lastActiveAt,
          startedAt: telemetry.startedAt,
          lastProgressAt: telemetry.lastProgressAt,
          phaseStartedAt: telemetry.phaseStartedAt,
          requestStartedAt: telemetry.requestStartedAt,
          requestElapsedMs: telemetry.requestElapsedMs,
          retryAt: telemetry.retryAt,
          elapsedMs: telemetry.elapsedMs,
          idleMs: telemetry.idleMs,
          phase: telemetry.phase,
          canSteer: telemetry.canSteer,
          canKill: telemetry.canKill,
          totalInputTokens: s.totalInputTokens,
          totalOutputTokens: s.totalOutputTokens,
          toolCalls: meta?.toolCalls,
          apiTurns: meta?.apiTurns,
          budget: s.fleetMetadata?.budget,
          attention:
            latestUnread?.type === "question"
              ? "question"
              : status === "awaiting_approval" ||
                  latestUnread?.type === "approval"
                ? "approval"
                : latestUnread?.type === "budget_warning"
                  ? "budget_warning"
                  : s.fleetMetadata?.lifecycle === "interrupted"
                    ? "interrupted"
                    : status === "error"
                      ? "failed"
                      : undefined,
          attentionEvent: eventKind
            ? {
                id: `${s.id}:${eventKind}:${eventTimestamp}`,
                kind: eventKind,
                timestamp: eventTimestamp,
              }
            : undefined,
          archivedAt: s.fleetMetadata?.archivedAt,
          unreadEventCount: unreadEvents.length,
          events,
          policyAuditCount: s.fleetMetadata?.policyAudit?.length ?? 0,
          structuredResult: s.fleetMetadata?.structuredResult,
          resultState: this.getBackgroundResultState(s, isDone),
          partialResult: s.fleetMetadata?.partialResult,
          agentRetryable: s.fleetMetadata?.agentRetryable,
          streamingText,
          errorMessage,
          completedAt:
            this.bgCompletedAt.get(s.id) ?? s.fleetMetadata?.completedAt,
          resultSummary: summary.shortStatus,
          summaryMeta: {
            inFlight: summary.inFlight,
            generatedAt: summary.generatedAt,
            sourceModel: summary.sourceModel,
            fallbackUsed: summary.fallbackUsed,
            confidence: summary.confidence,
            lastAttemptAt: summary.lastAttemptAt,
            lastFailureAt: summary.lastFailureAt,
            lastFailureReason: summary.lastFailureReason,
          },
        };
      });

    // Keep each subtree contiguous and parents ahead of descendants. Orphaned
    // restored nodes remain visible as roots instead of disappearing.
    const byParent = new Map<string | undefined, BgSessionInfo[]>();
    const ids = new Set(infos.map((info) => info.id));
    for (const info of infos) {
      const parent =
        info.parentSessionId && ids.has(info.parentSessionId)
          ? info.parentSessionId
          : undefined;
      const children = byParent.get(parent) ?? [];
      children.push(info);
      byParent.set(parent, children);
    }
    for (const children of byParent.values()) {
      children.sort(
        (a, b) =>
          (a.createdAt ?? 0) - (b.createdAt ?? 0) || a.id.localeCompare(b.id),
      );
    }
    const ordered: BgSessionInfo[] = [];
    const visited = new Set<string>();
    const visit = (parent: string | undefined): void => {
      for (const info of byParent.get(parent) ?? []) {
        if (visited.has(info.id)) continue;
        visited.add(info.id);
        ordered.push(info);
        visit(info.id);
      }
    };
    visit(undefined);
    // Defensive fallback for corrupt cyclic ancestry in older persisted data.
    for (const info of infos) {
      if (!visited.has(info.id)) ordered.push(info);
    }
    return ordered;
  }

  /**
   * Return the most recent background routing summaries for debug surfaces.
   */
  getRecentBgRoutingSummaries(limit = 5): string[] {
    const infos = this.getBgSessionInfos()
      .slice()
      .sort((a, b) => {
        const at = a.completedAt ?? Number.MAX_SAFE_INTEGER;
        const bt = b.completedAt ?? Number.MAX_SAFE_INTEGER;
        return bt - at;
      })
      .slice(0, Math.max(1, limit));

    return infos.map((info) => {
      const route = [
        info.resolvedMode ? `mode=${info.resolvedMode}` : null,
        info.resolvedProvider ? `provider=${info.resolvedProvider}` : null,
        info.resolvedModel ? `model=${info.resolvedModel}` : null,
      ]
        .filter((v): v is string => Boolean(v))
        .join(", ");
      const reason = info.routingReason
        ? ` reason="${info.routingReason}"`
        : "";
      const flags = [info.fallbackUsed ? "fallback=true" : null]
        .filter((v): v is string => Boolean(v))
        .join(" ");

      return `${info.id} task="${info.task}"${route ? ` ${route}` : ""}${reason}${flags ? ` ${flags}` : ""}`;
    });
  }
}
