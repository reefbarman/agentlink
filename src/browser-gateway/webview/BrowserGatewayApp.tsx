import type { JSX } from "preact";
import type {
  ChatMessage,
  ModeInfo,
  Question,
  ReasoningEffort,
  ProjectInfo,
  SessionSummary,
  SlashCommandInfo,
  TodoItem,
  WebviewModelInfo,
} from "../../agent/webview/types";

import {
  createMcpElicitationInitialValues,
  validateAndCoerceMcpElicitationValues,
  type McpElicitationFieldErrors,
  type McpElicitationValues,
  type McpFormElicitationRequest,
  type McpFormElicitationResponse,
} from "../../shared/mcpElicitation";
import type { McpUrlElicitationRequest } from "../../shared/mcpUrlElicitation";
import type {
  McpConfigBatchMutation,
  McpConfigMutationResult,
  McpConfigSnapshot,
  McpManagerScope,
  McpManagerServerDraft,
  McpManagerView,
} from "../../shared/mcpManagerTypes";
import type { DetectedQuestion } from "../../shared/questionDetection";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "preact/hooks";

import type {
  ApprovalRequest,
  DecisionMessage,
} from "../../approvals/webview/types";
import {
  ApprovalPanelEmbed,
  DEFAULT_APPROVAL_PANEL_HEIGHT,
  MIN_APPROVAL_PANEL_HEIGHT,
} from "../../agent/webview/components/ApprovalPanelEmbed";
import { ChatHeader } from "../../agent/webview/components/ChatHeader";
import { ChatView } from "../../agent/webview/components/ChatView";
import { ContextUsageRow } from "../../agent/webview/components/ContextUsageRow";
import { DebugInfo } from "../../agent/webview/components/DebugInfo";
import { BackgroundSessionStrip } from "../../agent/webview/components/BackgroundSessionStrip";
import { BrowserDiffViewer } from "./components/BrowserDiffViewer";
import { LazyMcpManagerPanel } from "./components/LazyMcpManagerPanel";
import {
  InputArea,
  type ComposerContextMode,
  type ComposerMedia,
} from "../../agent/webview/components/InputArea";
import { MessageQueuePanel } from "../../agent/webview/components/MessageQueuePanel";
import {
  QuestionCard,
  type QuestionOtherContext,
} from "../../agent/webview/components/QuestionCard";
import { SessionHistory } from "../../agent/webview/components/SessionHistory";
import { StreamingStatusBar } from "../../agent/webview/components/StreamingStatusBar";
import { TodoPanel } from "../../agent/webview/components/TodoPanel";
import { TranscriptView } from "../../agent/webview/components/TranscriptView";

import {
  agentMessagesToChatMessages,
  type AppState,
  type LoadedInstructionDebugInfo,
} from "../../shared/chatProjection";
import {
  getFinalMessageContinueAction,
  getLatestAutoContinueAction,
  getLatestFinalMessageMarker,
} from "../../shared/finalStatus";
import {
  AUTO_CONTINUE_NO_PROGRESS_REASON,
  turnMadeProgress,
} from "../../shared/autoContinueProgress";
import { isForwardedBuiltinCommand } from "../../shared/builtinCommandForwarding";
import { randomId } from "../../shared/randomId";
import {
  isWriteApprovalSelection,
  toHttpSelectionRequest,
  type WriteApprovalSelection,
} from "../../shared/selectionCommands";
import {
  isCommandApprovalPolicy,
  type CommandApprovalPolicy,
} from "../../approvals/commandApprovalPolicy";
import type {
  TerminalApprovalPolicy,
  TerminalApprovalReviewer,
  TerminalExecutionPreset,
} from "../../core/capabilities/terminal";
import { getDevelopmentStreamingBaselineMetrics } from "../../shared/streamingBaselineMetrics";

import { EmptyState, PaneCard, PaneHeader } from "../../shared/ui/Panes";
import { ChatActivityShelf } from "../../shared/ui/ChatActivityShelf";
import { McpElicitationFormControls } from "../../shared/ui/McpElicitationFormControls";

import type {
  BgSessionInfo,
  BrowserGatewayThemeSnapshot,
  RevertRecoveryNotice,
} from "../../shared/types";
import {
  normalizeBrowserGatewayDataPlaneMode,
  type BrowserGatewayDataPlaneMode,
} from "../browserGatewayDataPlaneMode";
import type { BrowserGatewayInstanceStatusSummary } from "../protocol";
import type {
  BrowserGatewayChatTabStatus,
  BrowserGatewayChatTabSummary,
  BrowserGatewayChatWorkspaceSummary,
} from "../dataPlane/protocol";
import type { BrowserGatewayDetachedSessionDetail } from "../BrowserGatewayService";
import {
  BROWSER_GATEWAY_ASK_AGENT_TAB_ID,
  BROWSER_GATEWAY_ASK_AGENT_TAB_TITLE,
} from "../askAgentTabs";
import {
  RELAY_SHADOW_OVERRIDE_STORAGE_KEY,
  resolveRelayClientEnabled,
} from "./relay/relayClientSelection";
import {
  createRelaySourceEventPaintQueue,
  queueAcceptedRelaySourceEventPaint,
  type RelaySourceEventPaintMarker,
  useRelayGatewayConnection,
} from "./relay/useRelayGatewayConnection";
import { useGatewaySnapshotConnection } from "./useGatewaySnapshotConnection";
import {
  requestDirectSessionDetail,
  type BrowserGatewaySessionDetailRequest,
} from "./sessionDetailTransport";

const DEFAULT_MAX_TOKENS = 200_000;
const AUTO_CONTINUE_MAX_TURNS = 10;
const AUTO_CONTINUE_BROWSER_SETTLE_MS = 500;
const THEME_CACHE_KEY = "agentlink.browserGateway.themeSnapshot.v1";
const SIDE_PANE_WIDTH_KEY = "agentlink.browserGateway.sidePaneWidth.v1";
const TAB_FLASH_INTERVAL_MS = 1_000;
const TAB_FLASH_TITLE = "⚠ Action needed — AgentLink";
const DEFAULT_SIDE_PANE_PERCENT = 36;
const MIN_SIDE_PANE_PERCENT = 22;
const MAX_SIDE_PANE_PERCENT = 70;
const MIN_SIDE_PANE_WIDTH = 280;
const MIN_CHAT_PANE_WIDTH = 420;
const SIDE_PANE_KEYBOARD_STEP = 32;
const MOBILE_LAYOUT_MEDIA_QUERY = "(max-width: 720px)";
const TOUCH_POINTER_MEDIA_QUERY = "(hover: none) and (pointer: coarse)";
const DISCONNECTED_INSTANCE_RETENTION_MS = 3 * 60 * 1_000;
const MAX_DETACHED_SESSION_DETAIL_CACHE_ENTRIES = 4;

/**
 * Run `callback` after the browser has had a chance to paint the current
 * update. Used to let a cheap frame (e.g. the tab switch highlight + loading
 * state) reach the screen before committing a render heavy enough to block
 * the main thread.
 */
function scheduleAfterNextPaint(callback: () => void): void {
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => {
      window.setTimeout(callback, 0);
    });
  } else {
    window.setTimeout(callback, 0);
  }
}
const streamingBaselineMetrics = __DEV_BUILD__
  ? getDevelopmentStreamingBaselineMetrics("browser-webview", true)
  : undefined;
const queueRelaySourceEventPaint = streamingBaselineMetrics
  ? createRelaySourceEventPaintQueue({
      scheduleAfterNextPaint,
      record: (measurement) => {
        streamingBaselineMetrics.record({
          type: "source_event_paint",
          surface: "browser-webview",
          ...measurement,
        });
      },
    })
  : undefined;
const observeGatewayConnection = streamingBaselineMetrics
  ? (observation: {
      phase: "created" | "open" | "first_commit" | "error";
      elapsedMs: number;
    }) => {
      streamingBaselineMetrics.record({
        type: "browser_connection",
        surface: "browser-webview",
        ...observation,
      });
    }
  : undefined;

function serializeInstancesIgnoringLastSeen(
  instances: BrowserGatewayInstanceOption[],
): string {
  return JSON.stringify(
    instances.map(({ lastSeenAt: _lastSeenAt, ...rest }) => rest),
  );
}

function dedupeBackgroundSessions(sessions: BgSessionInfo[]): BgSessionInfo[] {
  if (sessions.length <= 1) return sessions;

  const byId = new Map<string, BgSessionInfo>();
  let changed = false;
  for (const session of sessions) {
    if (byId.has(session.id)) {
      changed = true;
    }
    byId.set(session.id, session);
  }

  return changed ? Array.from(byId.values()) : sessions;
}

function projectFinalMarkerAutoContinueState(
  messages: ChatMessage[],
  hiddenMessageIds: ReadonlySet<string>,
  stopReasons: ReadonlyMap<string, string>,
): ChatMessage[] {
  if (hiddenMessageIds.size === 0 && stopReasons.size === 0) return messages;

  let changed = false;
  const next = messages.map((message) => {
    if (message.role !== "assistant" || !message.finalMarker) return message;

    let finalMarker = message.finalMarker;
    if (
      hiddenMessageIds.has(message.id) &&
      getFinalMessageContinueAction(finalMarker)
    ) {
      const { continueAction: _continueAction, ...rest } = finalMarker;
      finalMarker = { ...rest, continueActionConsumed: true };
    }

    const stopReason = stopReasons.get(message.id);
    if (stopReason && finalMarker.autoContinueStopReason !== stopReason) {
      finalMarker = { ...finalMarker, autoContinueStopReason: stopReason };
    }

    if (finalMarker === message.finalMarker) return message;
    changed = true;
    return { ...message, finalMarker };
  });

  return changed ? next : messages;
}

const DEFAULT_BROWSER_MODES: ModeInfo[] = [
  { slug: "code", name: "Code", icon: "symbol-misc" },
  { slug: "architect", name: "Architect", icon: "symbol-misc" },
  { slug: "ask", name: "Ask", icon: "symbol-misc" },
  { slug: "debug", name: "Debug", icon: "symbol-misc" },
  { slug: "review", name: "Review", icon: "symbol-misc" },
];

type AskAgentCapabilityStatus = {
  capabilityId: string;
  state: string;
  reason?: string;
};

type AskAgentModelCatalogStatus = {
  source: "cached" | "fallback" | "unknown";
  publishedByOwnerId?: string;
  publishedAt?: number;
  modelCount: number;
};

type AskAgentStatusNotice = {
  kind: "info" | "warning";
  title: string;
  message: string;
};

type AskAgentDerivedMemoryStatus = {
  sessionSummaryCount: number;
  chunkSummaryCount: number;
  totalSummaryCount: number;
  lastUpdatedAt: number | null;
  recentSessions: Array<{
    sessionId: string;
    title: string;
    messageCount: number;
    updatedAt: number;
  }>;
};

type AskAgentMemoryCandidateNudge = {
  id: string;
  sessionId: string;
  createdAt: number;
  kind: "preference" | "correction" | "gotcha" | "workflow";
  matchedPhrase: string;
  suggestedScope: "global";
  suggestedTier: "memory";
  title: string;
  rationale: string;
  content: string;
};

type AskAgentMemoryClearConfirmation = "idle" | "confirming";

type AskAgentProjectHandoff = {
  id: string;
  sessionId: string;
  createdAt: number;
  targetInstanceId: string;
  targetWorkspaceName: string;
  targetWorkspacePath: string;
  mode: string;
  instruction: string;
  status: "pending" | "launching" | "completed" | "cancelled" | "failed";
  error?: string;
};

type AskAgentReadGrant = {
  id: string;
  createdAt: number;
  rootPath: string;
  label: string;
  kind: "file" | "directory";
};

type BrowserGatewayInstanceOption = {
  instanceId: string;
  workspaceName: string;
  workspacePath: string;
  url: string;
  status?: BrowserGatewayInstanceStatusSummary;
  lastSeenAt: number;
  disconnectedAt?: number;
};

type BrowserLogicalTabSelection = BrowserGatewaySessionDetailRequest;

type AskAgentSessionResponse = {
  ok: true;
  ownerRegistration?: {
    capabilities?: AskAgentCapabilityStatus[];
  };
  session?: {
    capabilities?: AskAgentCapabilityStatus[];
  };
  snapshot: GatewaySnapshot;
};

type GatewaySnapshotReadResult = {
  snapshot: GatewaySnapshot;
  askAgentCapabilities?: AskAgentCapabilityStatus[];
};

export type GatewaySnapshot = {
  ui: {
    approval: ApprovalRequest | null;
    question: {
      id: string;
      context: string;
      questions: Question[];
      backgroundTask?: string;
    } | null;
    questionProgress: {
      id: string;
      step: number;
      answers: Record<string, string | string[] | number | boolean | undefined>;
      notes: Record<string, string>;
      origin: string;
    } | null;
    formElicitation: McpFormElicitationRequest | null;
    urlElicitation: McpUrlElicitationRequest | null;
    recentEvents: Array<{ type: string }>;
    memoryCandidateNudge?: AskAgentMemoryCandidateNudge | null;
    projectHandoff?: AskAgentProjectHandoff | null;
    readGrants?: AskAgentReadGrant[];
    mcpStatusInfos: Array<{
      name: string;
      status: string;
      error?: string;
      toolCount: number;
      resourceCount: number;
      promptCount: number;
      tools: Array<{ name: string; description?: string }>;
    }>;
  };
  session: {
    projects?: ProjectInfo[];
    defaultProjectId?: string | null;
    chatWorkspace?: BrowserGatewayChatWorkspaceSummary | null;
    repository: {
      projectId: string;
      branch?: string;
      dirty?: boolean;
    } | null;
    sessions: Array<{
      id: string;
      mode: string;
      model: string;
      title: string;
      messageCount: number;
      totalInputTokens: number;
      totalOutputTokens: number;
      createdAt: number;
      lastActiveAt: number;
      project?: ProjectInfo;
    }>;
    foreground: {
      sessionId: string;
      project?: ProjectInfo;
      title: string;
      originalPrompt?: string;
      mode: string;
      model: string;
      status: string;
      streaming: boolean;
      interrupted?: boolean;
      projectedMessages: ChatMessage[];
      statusOverride: string | null;
      thinkingEnabled?: boolean;
      reasoningEffort?: ReasoningEffort;
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
      detectedQuestion: (DetectedQuestion & { messageId: string }) | null;
      todos: TodoItem[];
      debugInfo: Record<string, string | number> | null;
      systemPrompt: string | null;
      loadedInstructions: LoadedInstructionDebugInfo[] | null;
      restoringSession: boolean;
      revertRecoveryNotice: RevertRecoveryNotice | null;
      contextBudget?: {
        contextWindow: number;
        maxInputTokens: number;
        usedInputTokens: number;
        outputReservation: number;
        safetyBufferTokens: number;
        softThresholdBudget: number;
        hardBudget: number;
      };
      condenseThreshold?: number;
      agentWriteApproval: "prompt" | "session" | "project" | "global";
      commandApprovalPolicy: CommandApprovalPolicy;
      approvalPolicy: TerminalApprovalPolicy;
      approvalReviewer: TerminalApprovalReviewer;
      executionPreset: TerminalExecutionPreset;
      configuredCommandApprovalPolicy: Exclude<
        CommandApprovalPolicy,
        "approve-for-me"
      >;
    } | null;
  };
  background: BgSessionInfo[];
  diffs: Array<{
    requestId: string;
    filePath: string;
    operation: string;
    originalPreview: string;
    proposedPreview: string;
    outsideWorkspace: boolean;
    createdAt: number;
  }>;
  theme: BrowserGatewayThemeSnapshot;
  modelsVersion?: number;
};

function logicalTabDomId(instanceId: string, tabId: string): string {
  return `logical-tab-${encodeURIComponent(instanceId)}-${encodeURIComponent(tabId)}`;
}

function instanceGroupColor(instanceId: string): string {
  let hash = 0;
  for (const character of instanceId) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return `hsl(${hash % 360} 55% 55%)`;
}

function logicalTabSelectionKey(selection: BrowserLogicalTabSelection): string {
  return [
    selection.instanceId,
    selection.controllerEpoch,
    selection.tabId,
    selection.sessionId,
  ].join("\u0000");
}

export function cacheDetachedSessionDetail(
  cache: Map<string, BrowserGatewayDetachedSessionDetail>,
  key: string,
  detail: BrowserGatewayDetachedSessionDetail,
  maxEntries = MAX_DETACHED_SESSION_DETAIL_CACHE_ENTRIES,
): void {
  cache.delete(key);
  cache.set(key, detail);
  while (cache.size > maxEntries) {
    const oldestKey = cache.keys().next().value;
    if (typeof oldestKey !== "string") return;
    cache.delete(oldestKey);
  }
}

export function pruneDetachedSessionDetailCache(
  cache: Map<string, BrowserGatewayDetachedSessionDetail>,
  instanceId: string,
  workspace: BrowserGatewayChatWorkspaceSummary,
): void {
  const validKeys = new Set(
    workspace.tabs.flatMap((tab) => {
      const selection = logicalTabSelection(instanceId, workspace, tab);
      return selection ? [logicalTabSelectionKey(selection)] : [];
    }),
  );
  const instancePrefix = `${instanceId}\u0000`;
  for (const key of cache.keys()) {
    if (key.startsWith(instancePrefix) && !validKeys.has(key)) {
      cache.delete(key);
    }
  }
}

function logicalTabSelection(
  instanceId: string,
  workspace: BrowserGatewayChatWorkspaceSummary,
  tab: BrowserGatewayChatTabSummary,
): BrowserLogicalTabSelection | null {
  if (!tab.sessionId) return null;
  return {
    instanceId,
    controllerEpoch: workspace.controllerEpoch,
    tabId: tab.tabId,
    sessionId: tab.sessionId,
  };
}

function rebindLogicalTabSnapshot(
  ownerSnapshot: GatewaySnapshot,
  selection: BrowserLogicalTabSelection,
): GatewaySnapshot {
  const workspace = ownerSnapshot.session.chatWorkspace;
  if (!workspace || workspace.controllerEpoch !== selection.controllerEpoch) {
    return ownerSnapshot;
  }
  return {
    ...ownerSnapshot,
    session: {
      ...ownerSnapshot.session,
      chatWorkspace: {
        ...workspace,
        tabs: workspace.tabs.map((tab) =>
          tab.tabId === selection.tabId
            ? { ...tab, sessionId: selection.sessionId }
            : tab,
        ),
      },
    },
  };
}

export function mergeDetachedSessionDetail(
  ownerSnapshot: GatewaySnapshot,
  detail: BrowserGatewayDetachedSessionDetail,
): GatewaySnapshot {
  return {
    ...ownerSnapshot,
    ui: {
      ...ownerSnapshot.ui,
      approval: detail.ui.approval,
      question: detail.ui.question,
      questionProgress: detail.ui.questionProgress,
      formElicitation: detail.ui.formElicitation,
      urlElicitation: detail.ui.urlElicitation,
    },
    session: {
      ...ownerSnapshot.session,
      foreground: detail.session,
    },
  };
}

function isGatewaySnapshot(value: unknown): value is GatewaySnapshot {
  return Boolean(
    value &&
    typeof value === "object" &&
    "session" in value &&
    "ui" in value &&
    "background" in value &&
    "diffs" in value &&
    "theme" in value,
  );
}

async function readGatewaySnapshotResponse(
  response: Response,
): Promise<GatewaySnapshotReadResult> {
  const data = (await response.json()) as
    | GatewaySnapshot
    | AskAgentSessionResponse;
  if (data && typeof data === "object" && "snapshot" in data && data.snapshot) {
    if (!isGatewaySnapshot(data.snapshot)) {
      throw new Error("invalid_gateway_snapshot");
    }
    return {
      snapshot: data.snapshot,
      askAgentCapabilities:
        data.session?.capabilities ?? data.ownerRegistration?.capabilities,
    };
  }
  if (!isGatewaySnapshot(data)) {
    throw new Error("invalid_gateway_snapshot");
  }
  return { snapshot: data as GatewaySnapshot };
}

function buildAskAgentStatusNotice(params: {
  isAskAgentSelected: boolean;
  foreground: GatewaySnapshot["session"]["foreground"] | null;
  capabilities: AskAgentCapabilityStatus[];
  modelCatalog: AskAgentModelCatalogStatus | null;
}): AskAgentStatusNotice | null {
  if (!params.isAskAgentSelected || !params.foreground) return null;

  const modelAuth = params.capabilities.find(
    (capability) => capability.capabilityId === "model-auth",
  );
  if (modelAuth && modelAuth.state !== "enabled") {
    return {
      kind: "warning",
      title: "Model credentials needed",
      message:
        modelAuth.reason ||
        "Ask Agent needs cached model credentials before it can answer.",
    };
  }

  if (params.modelCatalog?.source === "fallback") {
    return {
      kind: "info",
      title: "Model list may be stale",
      message:
        "Ask Agent is using the fallback model list until a VS Code AgentLink window publishes the current catalog.",
    };
  }

  return null;
}

function FormElicitationPanel({
  request,
  onRespond,
}: {
  request: McpFormElicitationRequest;
  onRespond: (response: McpFormElicitationResponse) => Promise<{
    ok: boolean;
    errors?: McpElicitationFieldErrors;
    error?: string;
  }>;
}) {
  const [values, setValues] = useState<McpElicitationValues>(() =>
    createMcpElicitationInitialValues(request.fields),
  );
  const [errors, setErrors] = useState<McpElicitationFieldErrors>({});
  const [submitError, setSubmitError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const respond = async (response: McpFormElicitationResponse) => {
    setSubmitting(true);
    setSubmitError("");
    try {
      const result = await onRespond(response);
      if (!result.ok) {
        setErrors(result.errors ?? {});
        setSubmitError(result.error ?? "The response could not be submitted.");
      }
    } catch {
      setSubmitError("The response could not be submitted.");
    } finally {
      setSubmitting(false);
    }
  };

  const accept = () => {
    const validation = validateAndCoerceMcpElicitationValues(
      request.fields,
      values,
    );
    if (!validation.ok) {
      setErrors(validation.errors);
      setSubmitError("Check the highlighted fields and try again.");
      return;
    }
    setErrors({});
    void respond({
      id: request.id,
      action: "accept",
      values: validation.values,
    });
  };

  return (
    <div class="approval-panel-embed mcp-elicitation-panel">
      <div class="url-elicitation-header">
        <i class="codicon codicon-list-selection" />
        <span>MCP input requested by {request.serverName}</span>
      </div>
      <p>{request.message}</p>
      <McpElicitationFormControls
        fields={request.fields}
        values={values}
        errors={errors}
        disabled={submitting}
        idPrefix={`browser-mcp-elicitation-${request.id}`}
        onChange={(name, value) => {
          setValues((current) => ({ ...current, [name]: value }));
          setErrors((current) => {
            if (!current[name]) return current;
            const next = { ...current };
            delete next[name];
            return next;
          });
          setSubmitError("");
        }}
      />
      {submitError && (
        <p class="mcp-elicitation-error" role="alert">
          {submitError}
        </p>
      )}
      <div class="url-elicitation-actions">
        <button
          type="button"
          disabled={submitting}
          onClick={() => void respond({ id: request.id, action: "cancel" })}
        >
          Cancel
        </button>
        <button type="button" disabled={submitting} onClick={accept}>
          {submitting ? "Submitting…" : "Submit"}
        </button>
      </div>
    </div>
  );
}

function UrlElicitationPanel({
  request,
  onAccept,
  onDecline,
  onCancel,
}: {
  request: McpUrlElicitationRequest;
  onAccept: (id: string, url: string) => void;
  onDecline: (id: string) => void;
  onCancel: (id: string) => void;
}) {
  return (
    <div class="approval-panel-embed url-elicitation-panel">
      <div class="url-elicitation-header">
        <i class="codicon codicon-link-external" />
        <span>MCP URL requested by {request.serverName}</span>
      </div>
      <p>{request.message}</p>
      <div class="url-elicitation-warning">
        Only continue if you trust this MCP server and expected this browser
        flow.
      </div>
      {request.isLocalAddress && (
        <div class="url-elicitation-warning danger">
          This URL points at a local/private network address. Make sure the
          server is trusted.
        </div>
      )}
      <dl class="url-elicitation-details">
        <dt>Origin</dt>
        <dd>{request.origin}</dd>
        <dt>Full URL</dt>
        <dd>{request.url}</dd>
      </dl>
      <div class="url-elicitation-actions">
        <button type="button" onClick={() => onCancel(request.id)}>
          Cancel
        </button>
        <button type="button" onClick={() => onDecline(request.id)}>
          Decline
        </button>
        <button type="button" onClick={() => onAccept(request.id, request.url)}>
          Open URL
        </button>
      </div>
    </div>
  );
}

interface BrowserGatewayAppProps {
  authToken: string;
  currentInstanceId: string;
  workspaceName: string;
  routeByInstance?: boolean;
  initialTheme?: BrowserGatewayThemeSnapshot;
  dataPlaneMode?: BrowserGatewayDataPlaneMode;
  reloadPage?: () => void;
}

function readCachedTheme(): BrowserGatewayThemeSnapshot | null {
  try {
    const raw = window.localStorage.getItem(THEME_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as BrowserGatewayThemeSnapshot;
    if (!parsed || typeof parsed !== "object") return null;
    if (!parsed.cssVariables || typeof parsed.cssVariables !== "object") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeCachedTheme(theme: BrowserGatewayThemeSnapshot): void {
  try {
    window.localStorage.setItem(THEME_CACHE_KEY, JSON.stringify(theme));
  } catch {
    // Ignore storage failures; the live theme still applies for this page load.
  }
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Last path segment, e.g. `plans/foo.md` -> `foo.md`. */
function basenameOf(filePath: string): string {
  const normalized = filePath.replace(/[/\\]+$/, "");
  const lastSlash = Math.max(
    normalized.lastIndexOf("/"),
    normalized.lastIndexOf("\\"),
  );
  return lastSlash === -1 ? normalized : normalized.slice(lastSlash + 1);
}

/** Directory portion, e.g. `plans/foo.md` -> `plans`; empty when at root. */
function dirnameOf(filePath: string): string {
  const normalized = filePath.replace(/[/\\]+$/, "");
  const lastSlash = Math.max(
    normalized.lastIndexOf("/"),
    normalized.lastIndexOf("\\"),
  );
  return lastSlash <= 0 ? "" : normalized.slice(0, lastSlash);
}

function clampSidePanePercentForWidth(
  percent: number,
  totalWidth: number,
): number {
  if (!Number.isFinite(totalWidth) || totalWidth <= 0) {
    return clampNumber(percent, MIN_SIDE_PANE_PERCENT, MAX_SIDE_PANE_PERCENT);
  }

  const minWidth = Math.min(
    totalWidth,
    Math.max(MIN_SIDE_PANE_WIDTH, totalWidth * (MIN_SIDE_PANE_PERCENT / 100)),
  );
  const maxWidth = Math.max(
    minWidth,
    Math.min(
      totalWidth - MIN_CHAT_PANE_WIDTH,
      totalWidth * (MAX_SIDE_PANE_PERCENT / 100),
    ),
  );
  const nextWidth = clampNumber(
    totalWidth * (percent / 100),
    minWidth,
    maxWidth,
  );

  return clampNumber(
    (nextWidth / totalWidth) * 100,
    MIN_SIDE_PANE_PERCENT,
    MAX_SIDE_PANE_PERCENT,
  );
}

function readCachedSidePanePercent(): number {
  try {
    const raw = window.localStorage.getItem(SIDE_PANE_WIDTH_KEY);
    if (!raw) return DEFAULT_SIDE_PANE_PERCENT;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return DEFAULT_SIDE_PANE_PERCENT;
    return clampNumber(parsed, MIN_SIDE_PANE_PERCENT, MAX_SIDE_PANE_PERCENT);
  } catch {
    return DEFAULT_SIDE_PANE_PERCENT;
  }
}

function writeCachedSidePanePercent(percent: number): void {
  try {
    window.localStorage.setItem(SIDE_PANE_WIDTH_KEY, String(percent));
  } catch {
    // Best-effort UI preference only.
  }
}

function applyRuntimeTheme(
  theme: BrowserGatewayThemeSnapshot,
  appliedThemeKeys: Set<string>,
): Set<string> {
  const rootStyle = document.documentElement.style;
  const nextKeys = new Set<string>();

  for (const [key, value] of Object.entries(theme.cssVariables ?? {})) {
    nextKeys.add(key);
    rootStyle.setProperty(key, value);
  }

  for (const prevKey of appliedThemeKeys) {
    if (!nextKeys.has(prevKey)) {
      rootStyle.removeProperty(prevKey);
    }
  }

  if (theme.colorScheme === "light" || theme.colorScheme === "hc-light") {
    rootStyle.colorScheme = "light";
  } else if (theme.colorScheme === "dark" || theme.colorScheme === "hc") {
    rootStyle.colorScheme = "dark";
  }

  return nextKeys;
}

function formatTranscriptTimestamp(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "unknown time";
  return new Date(timestamp).toISOString();
}

function messageTextForExport(message: ChatMessage): string {
  const content = message.content.trim();
  const blockText = message.blocks
    .map((block) => {
      if (block.type === "text" || block.type === "thinking") {
        return content ? "" : block.text;
      }
      if (block.type === "tool_call") {
        return [
          `[Tool: ${block.name}]`,
          block.inputJson ? `Input:\n${block.inputJson}` : "",
          block.result ? `Result:\n${block.result}` : "",
        ]
          .filter(Boolean)
          .join("\n");
      }
      if (content) return "";
      if (block.type === "skill_load") {
        return [
          `[Skill: ${block.skillName ?? block.path ?? "unknown"}]`,
          block.result,
        ]
          .filter(Boolean)
          .join("\n");
      }
      if (block.type === "question_answer") {
        return block.items
          .map((item) => `Q: ${item.question}\nA: ${String(item.answer ?? "")}`)
          .join("\n\n");
      }
      if (block.type === "bg_agent_result") {
        return block.resultText ?? block.summary ?? "";
      }
      return "";
    })
    .filter(Boolean)
    .join("\n\n")
    .trim();
  return [content, blockText].filter(Boolean).join("\n\n");
}

function buildAskAgentTranscriptMarkdown(params: {
  title: string;
  model: string;
  messages: ChatMessage[];
}): string {
  const lines = [
    `# ${params.title || "Ask Agent"}`,
    "",
    `- Exported: ${new Date().toISOString()}`,
    `- Model: ${params.model || "unknown"}`,
    "",
  ];

  for (const message of params.messages) {
    if (message.role === "condense") continue;
    const role =
      message.role === "user"
        ? "User"
        : message.role === "assistant"
          ? "Ask Agent"
          : "Notice";
    const text = messageTextForExport(message);
    const errorText = message.error?.message.trim() ?? "";
    if (!text && !errorText) continue;
    lines.push(`## ${role} — ${formatTranscriptTimestamp(message.timestamp)}`);
    if (message.slashCommandLabel) {
      lines.push("", `> ${message.slashCommandLabel}`);
    }
    if (errorText) {
      lines.push("", `> Error: ${errorText}`);
    }
    if (text && text !== errorText) {
      lines.push("", text, "");
    } else {
      lines.push("");
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function downloadTextFile(filename: string, text: string): void {
  const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function safeTranscriptFilename(title: string): string {
  const base = (title || "ask-agent")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  const stamp = new Date().toISOString().slice(0, 10);
  return `${base || "ask-agent"}-${stamp}.md`;
}

export function BrowserGatewayApp({
  authToken,
  currentInstanceId,
  workspaceName: _workspaceName,
  routeByInstance = false,
  initialTheme,
  dataPlaneMode: initialDataPlaneMode,
  reloadPage = () => window.location.reload(),
}: BrowserGatewayAppProps) {
  const [snapshot, setSnapshot] = useState<GatewaySnapshot | null>(null);
  const [associatedInstanceId, setAssociatedInstanceId] =
    useState(currentInstanceId);
  const [dataPlaneMode, setDataPlaneMode] =
    useState<BrowserGatewayDataPlaneMode>(() =>
      normalizeBrowserGatewayDataPlaneMode(initialDataPlaneMode, "off"),
    );
  const relayClientEnabled = resolveRelayClientEnabled({
    dataPlaneMode,
    developmentBuild: __DEV_BUILD__,
    search: window.location.search,
    storedOverride: window.localStorage.getItem(
      RELAY_SHADOW_OVERRIDE_STORAGE_KEY,
    ),
  });
  const [instanceOptions, setInstanceOptions] = useState<
    BrowserGatewayInstanceOption[]
  >([]);
  const instanceOptionsRef = useRef<BrowserGatewayInstanceOption[]>([]);
  const authRecoveryPendingRef = useRef(false);
  const initialSelectedTabId = BROWSER_GATEWAY_ASK_AGENT_TAB_ID;
  const [selectedTabId, setSelectedTabId] =
    useState<string>(initialSelectedTabId);
  const selectedTabIdRef = useRef(initialSelectedTabId);
  const selectedTabGenerationRef = useRef(0);
  const snapshotCacheRef = useRef<
    Map<string, { generation: number; snapshot: GatewaySnapshot }>
  >(new Map());
  const [ownerSnapshotRevision, setOwnerSnapshotRevision] = useState(0);
  const logicalSelectionByInstanceRef = useRef<
    Map<string, BrowserLogicalTabSelection>
  >(new Map());
  const [selectedLogicalTab, setSelectedLogicalTab] =
    useState<BrowserLogicalTabSelection | null>(null);
  const selectedLogicalTabRef = useRef<BrowserLogicalTabSelection | null>(null);
  const logicalSelectionGenerationRef = useRef(0);
  const detachedDetailCacheRef = useRef<
    Map<string, BrowserGatewayDetachedSessionDetail>
  >(new Map());
  const pendingRelaySendSelectionsRef = useRef<
    Map<string, BrowserLogicalTabSelection>
  >(new Map());
  const detachedDetailRefreshIdRef = useRef(0);
  const snapshotOriginRef = useRef({
    tabId: initialSelectedTabId,
    generation: 0,
  });
  const touchTabPointerRef = useRef<{
    instanceId: string;
    pointerId: number;
    x: number;
    y: number;
  } | null>(null);

  const isAskAgentSelected = selectedTabId === BROWSER_GATEWAY_ASK_AGENT_TAB_ID;
  const selectedInstanceId = isAskAgentSelected ? "" : selectedTabId;
  const selectedProjectId =
    snapshot?.session.foreground?.project?.projectId ??
    snapshot?.session.defaultProjectId ??
    snapshot?.session.projects?.[0]?.projectId;
  const selectedProjectIdRef = useRef<string | undefined>(selectedProjectId);
  selectedProjectIdRef.current = selectedProjectId;

  function logAskAgentBrowserEvent(
    event: string,
    fields: Record<string, string | number | boolean | null | undefined> = {},
  ): void {
    void fetch("/api/ask-agent/log", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ event, fields }),
    }).catch(() => undefined);
  }

  function selectTab(tabId: string): void {
    const previousTabId = selectedTabIdRef.current;
    if (previousTabId === tabId) return;

    const generation = selectedTabGenerationRef.current + 1;
    selectedTabGenerationRef.current = generation;
    selectedTabIdRef.current = tabId;
    logicalSelectionGenerationRef.current += 1;
    const logicalSelection =
      tabId === BROWSER_GATEWAY_ASK_AGENT_TAB_ID
        ? null
        : (logicalSelectionByInstanceRef.current.get(tabId) ?? null);
    selectedLogicalTabRef.current = logicalSelection;
    setSelectedLogicalTab(logicalSelection);
    snapshotOriginRef.current = { tabId, generation };
    // Switch to the lightweight loading state first so the tab change paints
    // immediately; mounting a cached transcript can block the main thread for
    // long enough (especially on mobile) that the tap appears to do nothing.
    setSnapshot(null);
    const advertisedStatus = instanceOptionsRef.current.find(
      (instance) => instance.instanceId === tabId,
    )?.status?.kind;
    const cachedSnapshot =
      advertisedStatus === "working" || advertisedStatus === "awaiting_approval"
        ? undefined
        : snapshotCacheRef.current.get(tabId)?.snapshot;
    if (cachedSnapshot) {
      scheduleAfterNextPaint(() => {
        if (
          selectedTabIdRef.current !== tabId ||
          selectedTabGenerationRef.current !== generation
        ) {
          return;
        }
        // A fresh snapshot may have landed while waiting for the paint; keep it.
        setSnapshot((current) => current ?? cachedSnapshot);
      });
    }
    setLocalDismissedApprovalId(null);
    setLocalDismissedQuestionId(null);
    setQuestionContextMode(null);
    setQuestionAttachments({});
    setSelectedDiffId(null);
    setTranscriptView(null);
    forwardedFollowUpRef.current = "";
    setSelectedTabId(tabId);
    logAskAgentBrowserEvent("tab.select", {
      previousTabId,
      nextTabId: tabId,
      askAgentSelected: tabId === BROWSER_GATEWAY_ASK_AGENT_TAB_ID,
    });
  }

  const buildApiPathForInstance = useCallback(
    (pathname: string, instanceId: string): string => {
      if (!routeByInstance || !instanceId.trim()) {
        return pathname;
      }
      const separator = pathname.includes("?") ? "&" : "?";
      return `${pathname}${separator}instanceId=${encodeURIComponent(instanceId)}`;
    },
    [routeByInstance],
  );
  const buildApiPath = useCallback(
    (pathname: string, instanceId = selectedInstanceId): string =>
      buildApiPathForInstance(pathname, instanceId),
    [buildApiPathForInstance, selectedInstanceId],
  );
  const buildApiPathForTab = useCallback(
    (pathname: string, tabId: string): string =>
      tabId === BROWSER_GATEWAY_ASK_AGENT_TAB_ID
        ? pathname
        : buildApiPathForInstance(pathname, tabId),
    [buildApiPathForInstance],
  );
  const buildSnapshotApiPath = useCallback(
    (
      instanceId = selectedInstanceId,
      askAgentSelected = isAskAgentSelected,
    ): string =>
      askAgentSelected
        ? "/api/ask-agent/session"
        : buildApiPathForInstance("/api/ui-state", instanceId),
    [buildApiPathForInstance, isAskAgentSelected, selectedInstanceId],
  );
  const buildEventsApiPath = useCallback(
    (instanceId: string, askAgentSelected = isAskAgentSelected): string =>
      askAgentSelected
        ? "/api/ask-agent/events"
        : buildApiPathForInstance("/events", instanceId),
    [buildApiPathForInstance, isAskAgentSelected],
  );

  const commitSnapshot = useCallback(
    (
      next: GatewaySnapshot,
      tabId: string,
      generation: number,
      sourceEventPaint?: RelaySourceEventPaintMarker,
    ): boolean => {
      const cached = snapshotCacheRef.current.get(tabId);
      if (!cached || generation >= cached.generation) {
        snapshotCacheRef.current.set(tabId, { generation, snapshot: next });
        setOwnerSnapshotRevision((revision) => revision + 1);
      }
      if (
        selectedTabIdRef.current !== tabId ||
        selectedTabGenerationRef.current !== generation
      ) {
        return false;
      }
      snapshotOriginRef.current = { tabId, generation };
      const logicalSelection = selectedLogicalTabRef.current;
      if (
        tabId === BROWSER_GATEWAY_ASK_AGENT_TAB_ID ||
        !logicalSelection ||
        logicalSelection.instanceId !== tabId ||
        logicalSelection.sessionId === next.session.foreground?.sessionId
      ) {
        setSnapshot(next);
      }
      queueAcceptedRelaySourceEventPaint(
        true,
        sourceEventPaint,
        queueRelaySourceEventPaint,
      );
      return true;
    },
    [],
  );
  const [selectedDiffId, setSelectedDiffId] = useState<string | null>(null);
  const [questionContextMode, setQuestionContextMode] =
    useState<QuestionOtherContext | null>(null);
  const [questionAttachments, setQuestionAttachments] = useState<
    Record<string, { paths: string[]; media: ComposerMedia[] }>
  >({});
  const [sendStatus, setSendStatus] = useState<string>("");
  const [detachedDetailRefresh, setDetachedDetailRefresh] = useState<{
    id: number;
    selection: BrowserLogicalTabSelection;
  } | null>(null);
  const [optimisticQueueInterjections, setOptimisticQueueInterjections] =
    useState<Set<string>>(() => new Set());
  const [showFleetRequest, setShowFleetRequest] = useState(0);
  const [modeStatus, setModeStatus] = useState<string>("");
  const [status, setStatus] = useState("Connecting…");
  const [thinkingPending, setThinkingPending] = useState(false);
  const [pendingReasoningEffort, setPendingReasoningEffort] =
    useState<ReasoningEffort | null>(null);
  const [slashCommands, setSlashCommands] = useState<SlashCommandInfo[]>([]);
  const [modes, setModes] = useState<ModeInfo[]>([]);
  const [models, setModels] = useState<WebviewModelInfo[]>([]);
  const pendingModelSelectionRef = useRef<Promise<boolean> | null>(null);
  const pendingNewSessionRef = useRef<Promise<GatewaySnapshot | null> | null>(
    null,
  );
  const [askAgentCapabilities, setAskAgentCapabilities] = useState<
    AskAgentCapabilityStatus[]
  >([]);
  const [askAgentModelCatalog, setAskAgentModelCatalog] =
    useState<AskAgentModelCatalogStatus | null>(null);
  const [mobileLayout, setMobileLayout] = useState(
    () =>
      typeof window.matchMedia === "function" &&
      window.matchMedia(MOBILE_LAYOUT_MEDIA_QUERY).matches,
  );
  const [touchInput, setTouchInput] = useState(
    () =>
      typeof window.matchMedia === "function" &&
      window.matchMedia(TOUCH_POINTER_MEDIA_QUERY).matches,
  );
  const [mobilePane, setMobilePane] = useState<"review" | null>(null);
  const [sessionHistory, setSessionHistory] = useState<SessionSummary[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [sessionHistoryError, setSessionHistoryError] = useState<string | null>(
    null,
  );
  const [showAskAgentMemory, setShowAskAgentMemory] = useState(false);
  const [askAgentMemory, setAskAgentMemory] =
    useState<AskAgentDerivedMemoryStatus | null>(null);
  const [askAgentMemoryError, setAskAgentMemoryError] = useState<string | null>(
    null,
  );
  const [askAgentMemoryPending, setAskAgentMemoryPending] = useState(false);
  const [askAgentMemoryClearConfirmation, setAskAgentMemoryClearConfirmation] =
    useState<AskAgentMemoryClearConfirmation>("idle");
  const [showAskAgentHandoff, setShowAskAgentHandoff] = useState(false);
  const [showAskAgentReadGrants, setShowAskAgentReadGrants] = useState(false);
  const [askAgentReadGrantPath, setAskAgentReadGrantPath] = useState("");
  const [askAgentReadGrantPending, setAskAgentReadGrantPending] =
    useState(false);
  const [askAgentHandoffTargetId, setAskAgentHandoffTargetId] = useState("");
  const [askAgentHandoffMode, setAskAgentHandoffMode] = useState("code");
  const [askAgentHandoffInstruction, setAskAgentHandoffInstruction] =
    useState("");
  const [askAgentHandoffPending, setAskAgentHandoffPending] = useState(false);
  const [showMcpStatus, setShowMcpStatus] = useState(false);
  const [mcpManagerSnapshot, setMcpManagerSnapshot] =
    useState<McpConfigSnapshot | null>(null);
  const [mcpManagerView, setMcpManagerView] =
    useState<McpManagerView>("status");
  const [askAgentMcpStatusError, setAskAgentMcpStatusError] = useState<
    string | null
  >(null);
  const [transcriptView, setTranscriptView] = useState<{
    sessionId: string;
    task: string;
    messages: ChatMessage[];
    streaming: boolean;
    visible: boolean;
  } | null>(null);
  const [localDismissedApprovalId, setLocalDismissedApprovalId] = useState<
    string | null
  >(null);
  const [localDismissedQuestionId, setLocalDismissedQuestionId] = useState<
    string | null
  >(null);
  const [hiddenFinalContinueMessageIds, setHiddenFinalContinueMessageIds] =
    useState<ReadonlySet<string>>(() => new Set());
  const [autoContinueStopReasons, setAutoContinueStopReasons] = useState<
    ReadonlyMap<string, string>
  >(() => new Map());
  const [autoContinueEnabled, setAutoContinueEnabled] = useState(false);
  const [autoContinueStatus, setAutoContinueStatus] = useState("");
  const autoContinuedMessageIdsRef = useRef<Set<string>>(new Set());
  const autoContinueCountRef = useRef(0);
  const pendingAutoContinueUserMessageIdRef = useRef<string | null>(null);
  const autoContinueSessionIdRef = useRef<string | null>(null);
  const [approvalPanelHeight, setApprovalPanelHeight] = useState(
    DEFAULT_APPROVAL_PANEL_HEIGHT,
  );
  const [approvalResizing, setApprovalResizing] = useState(false);
  const [sidePanePercent, setSidePanePercent] = useState(() =>
    readCachedSidePanePercent(),
  );
  const [sidePaneResizing, setSidePaneResizing] = useState(false);
  const browserLayoutRef = useRef<HTMLElement | null>(null);
  const approvalResizeCleanupRef = useRef<(() => void) | null>(null);
  const sidePaneResizeCleanupRef = useRef<(() => void) | null>(null);
  const forwardedFollowUpRef = useRef("");
  const lastVisibleApprovalIdRef = useRef<string | null>(null);
  const appliedThemeKeysRef = useRef<Set<string>>(new Set());
  const questionProgressOriginRef = useRef<string>(
    `br-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`,
  );
  const seenFleetEventIdsRef = useRef<Set<string> | null>(null);

  useEffect(() => {
    return () => {
      approvalResizeCleanupRef.current?.();
      sidePaneResizeCleanupRef.current?.();
    };
  }, []);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;

    const mobileLayoutQuery = window.matchMedia(MOBILE_LAYOUT_MEDIA_QUERY);
    const touchInputQuery = window.matchMedia(TOUCH_POINTER_MEDIA_QUERY);
    const syncMobilePaneAvailability = () => {
      const isMobileLayout = mobileLayoutQuery.matches;
      setMobileLayout(isMobileLayout);
      setTouchInput(touchInputQuery.matches);
      if (!isMobileLayout) {
        setMobilePane(null);
      }
    };
    syncMobilePaneAvailability();
    mobileLayoutQuery.addEventListener("change", syncMobilePaneAvailability);
    touchInputQuery.addEventListener("change", syncMobilePaneAvailability);
    return () => {
      mobileLayoutQuery.removeEventListener(
        "change",
        syncMobilePaneAvailability,
      );
      touchInputQuery.removeEventListener("change", syncMobilePaneAvailability);
    };
  }, []);

  useEffect(() => {
    const syncSidePanePercent = (): void => {
      const layout = browserLayoutRef.current;
      if (!layout) return;
      const totalWidth = layout.getBoundingClientRect().width;
      setSidePanePercent((current) => {
        const next = clampSidePanePercentForWidth(current, totalWidth);
        if (Math.abs(next - current) < 0.1) return current;
        writeCachedSidePanePercent(next);
        return next;
      });
    };

    syncSidePanePercent();
    window.addEventListener("resize", syncSidePanePercent);
    return () => window.removeEventListener("resize", syncSidePanePercent);
  }, []);

  const refreshDetachedSelection = useCallback(
    (selection: BrowserLogicalTabSelection): void => {
      const ownerSnapshot = snapshotCacheRef.current.get(
        selection.instanceId,
      )?.snapshot;
      if (
        ownerSnapshot?.session.foreground?.sessionId === selection.sessionId
      ) {
        return;
      }
      const current = selectedLogicalTabRef.current;
      if (
        current &&
        logicalTabSelectionKey(current) === logicalTabSelectionKey(selection)
      ) {
        detachedDetailRefreshIdRef.current += 1;
        setDetachedDetailRefresh({
          id: detachedDetailRefreshIdRef.current,
          selection,
        });
      }
    },
    [],
  );

  useGatewaySnapshotConnection({
    enabled: !relayClientEnabled,
    authToken,
    tabId: selectedTabId,
    generation: selectedTabGenerationRef.current,
    instanceId: isAskAgentSelected ? "" : selectedTabId,
    askAgentSelected: isAskAgentSelected,
    routeByInstance,
    streamCoalesceMs:
      typeof window.matchMedia === "function" &&
      window.matchMedia(TOUCH_POINTER_MEDIA_QUERY).matches
        ? 500
        : 150,
    buildSnapshotApiPath,
    buildEventsApiPath,
    readSnapshotResponse: readGatewaySnapshotResponse,
    commitSnapshot,
    setAskAgentCapabilities,
    setStatus,
    fetchModes,
    fetchModels,
    fetchSlashCommands,
    fetchSessions,
    fetchDebugInfo,
    fetchInstances,
    observeConnection: observeGatewayConnection,
  });
  const {
    dispatchCommand: dispatchRelayCommand,
    requestSessionDetail: requestRelaySessionDetail,
  } = useRelayGatewayConnection({
    enabled: relayClientEnabled,
    selectedTabId,
    selectedTabGeneration: selectedTabGenerationRef.current,
    commitSnapshot,
    setStatus,
    onOperation: (operation) => {
      if (operation.state === "accepted") return;
      if (operation.kind === "session.send") {
        const selection = pendingRelaySendSelectionsRef.current.get(
          operation.operationId,
        );
        pendingRelaySendSelectionsRef.current.delete(operation.operationId);
        if (
          (operation.state === "completed" ||
            operation.state === "uncertain") &&
          selection
        ) {
          refreshDetachedSelection(selection);
        }
        setSendStatus(
          operation.state === "completed"
            ? "Sent"
            : `Send ${operation.state}: ${operation.message ?? "unknown status"}`,
        );
      } else if (operation.kind === "session.stop") {
        setSendStatus(
          operation.state === "completed"
            ? "Stopped"
            : `Stop ${operation.state}: ${operation.message ?? "unknown status"}`,
        );
      } else if (operation.kind === "session.select") {
        setSessionHistoryError(
          operation.state === "completed"
            ? null
            : `Session selection ${operation.state}: ${operation.message ?? "unknown status"}`,
        );
      }
    },
  });

  useEffect(() => {
    if (!detachedDetailRefresh) return;
    const { selection } = detachedDetailRefresh;
    const detailKey = logicalTabSelectionKey(selection);
    const selectionGeneration = logicalSelectionGenerationRef.current;
    const controller = new AbortController();
    let cancelled = false;
    void (async () => {
      try {
        const detail = relayClientEnabled
          ? ((await requestRelaySessionDetail(selection))?.detail ?? null)
          : await requestDirectSessionDetail({
              authToken,
              request: selection,
              buildApiPathForInstance,
              signal: controller.signal,
            });
        if (!detail || cancelled || controller.signal.aborted) return;
        if (
          selectedTabIdRef.current !== selection.instanceId ||
          logicalSelectionGenerationRef.current !== selectionGeneration ||
          !selectedLogicalTabRef.current ||
          logicalTabSelectionKey(selectedLogicalTabRef.current) !== detailKey
        ) {
          return;
        }
        cacheDetachedSessionDetail(
          detachedDetailCacheRef.current,
          detailKey,
          detail,
        );
        const latestOwner = snapshotCacheRef.current.get(
          selection.instanceId,
        )?.snapshot;
        if (!latestOwner) return;
        setSnapshot(mergeDetachedSessionDetail(latestOwner, detail));
      } catch (error) {
        if (cancelled || controller.signal.aborted) return;
        setStatus(`Session detail unavailable: ${String(error)}`);
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [
    authToken,
    buildApiPathForInstance,
    detachedDetailRefresh,
    relayClientEnabled,
    requestRelaySessionDetail,
  ]);

  useEffect(() => {
    if (isAskAgentSelected) return;
    const ownerSnapshot = snapshotCacheRef.current.get(selectedTabId)?.snapshot;
    const workspace = ownerSnapshot?.session.chatWorkspace;
    if (!ownerSnapshot || !workspace) return;
    pruneDetachedSessionDetailCache(
      detachedDetailCacheRef.current,
      selectedTabId,
      workspace,
    );

    const current = selectedLogicalTabRef.current;
    const selectedTab = current
      ? workspace.tabs.find(
          (tab) =>
            current.instanceId === selectedTabId &&
            current.controllerEpoch === workspace.controllerEpoch &&
            current.tabId === tab.tabId &&
            current.sessionId === tab.sessionId,
        )
      : undefined;
    if (!selectedTab) {
      const preferred =
        workspace.tabs.find((tab) => tab.tabId === workspace.focusedTabId) ??
        workspace.tabs.find(
          (tab) =>
            tab.sessionId === ownerSnapshot.session.foreground?.sessionId,
        ) ??
        workspace.tabs[0];
      if (!preferred) return;
      const next = logicalTabSelection(selectedTabId, workspace, preferred);
      if (!next) return;
      logicalSelectionByInstanceRef.current.set(selectedTabId, next);
      selectedLogicalTabRef.current = next;
      logicalSelectionGenerationRef.current += 1;
      setSelectedLogicalTab(next);
      return;
    }

    const selection = current!;
    logicalSelectionByInstanceRef.current.set(selectedTabId, selection);
    if (ownerSnapshot.session.foreground?.sessionId === selection.sessionId) {
      setSnapshot(ownerSnapshot);
      return;
    }

    const detailKey = logicalTabSelectionKey(selection);
    const cachedDetail = detachedDetailCacheRef.current.get(detailKey);
    if (cachedDetail) {
      setSnapshot(mergeDetachedSessionDetail(ownerSnapshot, cachedDetail));
    } else {
      setSnapshot(null);
    }

    const selectionGeneration = logicalSelectionGenerationRef.current;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const detail = relayClientEnabled
            ? ((await requestRelaySessionDetail(selection))?.detail ?? null)
            : await requestDirectSessionDetail({
                authToken,
                request: selection,
                buildApiPathForInstance,
                signal: controller.signal,
              });
          if (!detail || controller.signal.aborted) return;
          if (
            selectedTabIdRef.current !== selection.instanceId ||
            logicalSelectionGenerationRef.current !== selectionGeneration ||
            !selectedLogicalTabRef.current ||
            logicalTabSelectionKey(selectedLogicalTabRef.current) !== detailKey
          ) {
            return;
          }
          cacheDetachedSessionDetail(
            detachedDetailCacheRef.current,
            detailKey,
            detail,
          );
          const latestOwner = snapshotCacheRef.current.get(
            selection.instanceId,
          )?.snapshot;
          if (!latestOwner) return;
          setSnapshot(mergeDetachedSessionDetail(latestOwner, detail));
        } catch (error) {
          if (controller.signal.aborted) return;
          setStatus(`Session detail unavailable: ${String(error)}`);
        }
      })();
    }, 150);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [
    authToken,
    buildApiPathForInstance,
    isAskAgentSelected,
    ownerSnapshotRevision,
    relayClientEnabled,
    requestRelaySessionDetail,
    selectedLogicalTab,
    selectedTabId,
  ]);

  useEffect(() => {
    if (!relayClientEnabled) {
      pendingRelaySendSelectionsRef.current.clear();
      return;
    }
    return () => pendingRelaySendSelectionsRef.current.clear();
  }, [relayClientEnabled]);

  useEffect(() => {
    if (!relayClientEnabled) return;
    const tabId = selectedTabId;
    const generation = selectedTabGenerationRef.current;
    void (async () => {
      await fetchInstances();
      if (
        selectedTabIdRef.current !== tabId ||
        selectedTabGenerationRef.current !== generation
      ) {
        return;
      }
      if (isAskAgentSelected) {
        void fetchModes(selectedInstanceId, tabId, generation);
        void fetchSlashCommands(selectedInstanceId, true, tabId, generation);
      }
      void fetchModels(
        selectedInstanceId,
        isAskAgentSelected,
        tabId,
        generation,
      );
      if (!isAskAgentSelected) {
        void fetchSessions(selectedInstanceId, false, tabId, generation);
        void fetchDebugInfo(selectedInstanceId);
      }
    })();
    const timer = window.setInterval(() => void fetchInstances(), 5_000);
    return () => window.clearInterval(timer);
  }, [associatedInstanceId, relayClientEnabled, selectedTabId]);

  useEffect(() => {
    if (isAskAgentSelected || !selectedProjectId) {
      return;
    }
    const tabId = selectedTabId;
    const generation = selectedTabGenerationRef.current;
    void fetchModes(selectedInstanceId, tabId, generation, selectedProjectId);
    void fetchSlashCommands(
      selectedInstanceId,
      false,
      tabId,
      generation,
      selectedProjectId,
    );
  }, [selectedTabId, selectedProjectId]);

  // Re-fetch the model list when the gateway signals a model-metadata change
  // (e.g. Anthropic dynamic capability refresh). Keeps browser models in parity
  // without a dedicated event (Target A / Q7).
  const modelsVersion = snapshot?.modelsVersion;
  useEffect(() => {
    if (modelsVersion === undefined || modelsVersion === 0) return;
    void fetchModels();
  }, [modelsVersion]);

  useEffect(() => {
    const currentDiffs = snapshot?.diffs ?? [];

    if (currentDiffs.length === 0) {
      if (selectedDiffId !== null) {
        setSelectedDiffId(null);
      }
      return;
    }

    if (
      selectedDiffId &&
      currentDiffs.some((diff) => diff.requestId === selectedDiffId)
    ) {
      return;
    }

    setSelectedDiffId(currentDiffs[0]?.requestId ?? null);
  }, [selectedDiffId, snapshot?.diffs]);

  const foreground = snapshot?.session.foreground ?? null;
  const foregroundProjectedMessages = foreground?.projectedMessages;
  const messages = useMemo<ChatMessage[]>(() => {
    return projectFinalMarkerAutoContinueState(
      foregroundProjectedMessages ?? [],
      hiddenFinalContinueMessageIds,
      autoContinueStopReasons,
    );
  }, [
    autoContinueStopReasons,
    foregroundProjectedMessages,
    hiddenFinalContinueMessageIds,
  ]);

  const reasoningEffort: ReasoningEffort = foreground
    ? (foreground.reasoningEffort ??
      (foreground.thinkingEnabled === false ? "none" : "high"))
    : "none";
  const effectiveReasoningEffort =
    thinkingPending && pendingReasoningEffort !== null
      ? pendingReasoningEffort
      : reasoningEffort;

  const diffs = snapshot?.diffs ?? [];
  const snapshotBackground = snapshot?.background;
  const background = useMemo(
    () => dedupeBackgroundSessions(snapshotBackground ?? []),
    [snapshotBackground],
  );
  const openTranscriptBackground = useMemo(
    () =>
      transcriptView
        ? background.find((session) => session.id === transcriptView.sessionId)
        : undefined,
    [background, transcriptView],
  );
  useEffect(() => {
    if (!transcriptView?.visible || !openTranscriptBackground) return;
    let cancelled = false;
    const sessionId = transcriptView.sessionId;
    void (async () => {
      try {
        const response = await fetch(
          buildApiPath("/api/background/open-transcript"),
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${authToken}`,
            },
            body: JSON.stringify({ sessionId }),
          },
        );
        const body = (await response.json()) as {
          ok?: boolean;
          transcript?: {
            sessionId: string;
            task: string;
            messages: unknown[];
          };
        };
        if (cancelled || !body.ok || !body.transcript) return;
        const converted = agentMessagesToChatMessages(body.transcript.messages);
        setTranscriptView((current) => {
          if (current?.sessionId !== sessionId) return current;
          const stillRunning =
            openTranscriptBackground.status === "streaming" ||
            openTranscriptBackground.status === "tool_executing" ||
            openTranscriptBackground.status === "awaiting_approval";
          return {
            ...current,
            task: body.transcript!.task,
            messages:
              stillRunning && converted.length < current.messages.length
                ? current.messages
                : converted,
          };
        });
      } catch {
        // Keep the last transcript snapshot; a later background update can retry.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    authToken,
    buildApiPath,
    openTranscriptBackground?.completedAt,
    openTranscriptBackground?.errorMessage,
    openTranscriptBackground?.lastActiveAt,
    openTranscriptBackground?.lastProgressAt,
    openTranscriptBackground?.status,
    openTranscriptBackground?.streamingText,
    transcriptView?.sessionId,
    transcriptView?.visible,
  ]);
  useEffect(() => {
    const currentIds = new Set(
      background.flatMap(
        (session) => session.events?.map((event) => event.id) ?? [],
      ),
    );
    if (seenFleetEventIdsRef.current === null) {
      seenFleetEventIdsRef.current = currentIds;
      return;
    }
    if (
      typeof Notification !== "undefined" &&
      Notification.permission === "granted"
    ) {
      for (const session of background) {
        for (const event of session.events ?? []) {
          if (!seenFleetEventIdsRef.current.has(event.id) && !event.readAt) {
            new Notification(session.task, { body: event.summary });
          }
        }
      }
    }
    seenFleetEventIdsRef.current = currentIds;
  }, [background]);
  const pendingApproval = snapshot?.ui.approval ?? null;
  const pendingQuestion =
    foreground?.questionRequest ?? snapshot?.ui.question ?? null;
  const pendingFormElicitation = snapshot?.ui.formElicitation ?? null;
  const pendingUrlElicitation = snapshot?.ui.urlElicitation ?? null;
  const visibleApproval =
    pendingApproval && pendingApproval.id !== localDismissedApprovalId
      ? pendingApproval
      : null;
  // `pendingQuestion` is derived from two sources (foreground projection and the
  // UI event snapshot) that clear at slightly different times during a submit
  // round-trip, so the card can toggle on/off after the user answers. Optimistically
  // hide it once submitted locally, mirroring `visibleApproval` above.
  const visibleQuestion =
    pendingQuestion && pendingQuestion.id !== localDismissedQuestionId
      ? pendingQuestion
      : null;

  useEffect(() => {
    setQuestionContextMode(null);
    setQuestionAttachments({});
  }, [visibleQuestion?.id]);

  const mobileReviewOpen = mobileLayout && mobilePane === "review";
  const visibleApprovalDiff =
    visibleApproval?.kind === "write"
      ? diffs.find(
          (diff) =>
            diff.requestId === visibleApproval.id ||
            (visibleApproval.filePath !== undefined &&
              diff.filePath === visibleApproval.filePath),
        )
      : undefined;
  const canOpenMobileReview = mobileLayout && Boolean(visibleApprovalDiff);
  const awaitingUserInput = Boolean(
    visibleApproval ||
    visibleQuestion ||
    pendingFormElicitation ||
    pendingUrlElicitation ||
    instanceOptions.some(
      (instance) => instance.status?.kind === "awaiting_approval",
    ),
  );
  const askAgentMemoryCandidateNudge =
    isAskAgentSelected && !visibleApproval
      ? (snapshot?.ui.memoryCandidateNudge ?? null)
      : null;
  const askAgentProjectHandoff =
    isAskAgentSelected && !visibleApproval
      ? (snapshot?.ui.projectHandoff ?? null)
      : null;
  const askAgentReadGrants =
    isAskAgentSelected && !visibleApproval
      ? (snapshot?.ui.readGrants ?? [])
      : [];
  const askAgentHandoffTargets = instanceOptions.filter(
    (instance) => instance.disconnectedAt === undefined,
  );
  const askAgentStatusNotice = buildAskAgentStatusNotice({
    isAskAgentSelected,
    foreground,
    capabilities: askAgentCapabilities,
    modelCatalog: askAgentModelCatalog,
  });
  const snapshotQuestionProgress = snapshot?.ui.questionProgress ?? null;
  const remoteQuestionProgress =
    snapshotQuestionProgress &&
    snapshotQuestionProgress.origin !== questionProgressOriginRef.current
      ? snapshotQuestionProgress
      : null;

  useEffect(() => {
    const previousVisibleApprovalId = lastVisibleApprovalIdRef.current;
    const currentVisibleApprovalId = visibleApproval?.id ?? null;

    if (
      previousVisibleApprovalId !== null &&
      currentVisibleApprovalId === null &&
      mobilePane === "review"
    ) {
      setMobilePane(null);
    }

    lastVisibleApprovalIdRef.current = currentVisibleApprovalId;
  }, [mobilePane, visibleApproval?.id]);

  useEffect(() => {
    if (mobilePane === "review" && !canOpenMobileReview) {
      setMobilePane(null);
    }
  }, [canOpenMobileReview, mobilePane]);

  useEffect(() => {
    if (!thinkingPending || !foreground || pendingReasoningEffort === null)
      return;
    if (foreground.reasoningEffort === pendingReasoningEffort) {
      setThinkingPending(false);
      setPendingReasoningEffort(null);
    }
  }, [
    thinkingPending,
    pendingReasoningEffort,
    foreground,
    foreground?.reasoningEffort,
  ]);

  useEffect(() => {
    if (!pendingApproval) {
      setLocalDismissedApprovalId(null);
      return;
    }
    if (
      localDismissedApprovalId !== null &&
      pendingApproval.id !== localDismissedApprovalId
    ) {
      setLocalDismissedApprovalId(null);
    }
  }, [pendingApproval, localDismissedApprovalId]);

  useEffect(() => {
    // Only clear the optimistic dismiss when a genuinely different question
    // arrives. Resetting on a transient null (the two question sources clear at
    // different times) would re-show the card the user just answered.
    if (
      localDismissedQuestionId !== null &&
      pendingQuestion &&
      pendingQuestion.id !== localDismissedQuestionId
    ) {
      setLocalDismissedQuestionId(null);
    }
  }, [pendingQuestion, localDismissedQuestionId]);

  useEffect(() => {
    const originalTitle = document.title;
    if (!awaitingUserInput) {
      return;
    }

    let showAttentionTitle = true;
    const renderTitle = () => {
      document.title = showAttentionTitle ? TAB_FLASH_TITLE : originalTitle;
      showAttentionTitle = !showAttentionTitle;
    };

    renderTitle();
    const timer = window.setInterval(renderTitle, TAB_FLASH_INTERVAL_MS);

    return () => {
      window.clearInterval(timer);
      document.title = originalTitle;
    };
  }, [awaitingUserInput]);

  useEffect(() => {
    const cachedTheme = readCachedTheme();
    const theme = cachedTheme ?? initialTheme;
    if (!theme) return;
    appliedThemeKeysRef.current = applyRuntimeTheme(
      theme,
      appliedThemeKeysRef.current,
    );
  }, [initialTheme]);

  useEffect(() => {
    const theme = snapshot?.theme;
    if (!theme) return;

    appliedThemeKeysRef.current = applyRuntimeTheme(
      theme,
      appliedThemeKeysRef.current,
    );
    writeCachedTheme(theme);
  }, [snapshot?.theme]);

  function formatTimestamp(value: number | undefined): string {
    if (value === undefined) return "—";
    try {
      return new Date(value).toLocaleString();
    } catch {
      return "—";
    }
  }

  function deriveSelectedInstanceStatus(): BrowserGatewayInstanceStatusSummary {
    if (foreground?.status === "error") {
      return {
        kind: "error",
        label: "Error",
        detail: foreground.statusOverride ?? foreground.status,
        sessionTitle: foreground.title,
      };
    }

    if (
      pendingApproval ||
      pendingQuestion ||
      pendingFormElicitation ||
      pendingUrlElicitation
    ) {
      return {
        kind: "awaiting_approval",
        label: pendingFormElicitation
          ? "MCP Form"
          : pendingUrlElicitation
            ? "MCP URL"
            : pendingQuestion
              ? "Question"
              : "Approval",
        detail: foreground?.statusOverride ?? "Awaiting response",
        sessionTitle: foreground?.title,
      };
    }

    if (
      foreground?.streaming ||
      foreground?.status === "streaming" ||
      foreground?.status === "tool_executing" ||
      foreground?.status === "awaiting_approval"
    ) {
      return {
        kind: "working",
        label:
          foreground.status === "tool_executing"
            ? "Tool running"
            : foreground.status === "awaiting_approval"
              ? "Waiting"
              : "Working",
        detail:
          foreground.statusOverride ??
          (foreground.status === "awaiting_approval"
            ? "Awaiting interaction details"
            : foreground.status),
        sessionTitle: foreground.title,
      };
    }

    return {
      kind: "idle",
      label: "Idle",
      detail: foreground?.statusOverride ?? foreground?.status,
      sessionTitle: foreground?.title,
    };
  }

  function getInstanceStatus(
    instance: (typeof instanceOptions)[number],
  ): BrowserGatewayInstanceStatusSummary {
    if (instance.disconnectedAt !== undefined) {
      return {
        kind: "disconnected",
        label: "Disconnected",
        detail: "Waiting for this VS Code window to reconnect",
        sessionTitle: instance.status?.sessionTitle,
      };
    }
    if (instance.instanceId === selectedInstanceId) {
      return deriveSelectedInstanceStatus();
    }
    return instance.status ?? { kind: "idle", label: "Idle" };
  }

  function getLogicalTabStatus(
    status: BrowserGatewayChatTabStatus,
  ): BrowserGatewayInstanceStatusSummary {
    switch (status) {
      case "streaming":
        return { kind: "working", label: "Working" };
      case "queued_for_provider":
        return { kind: "working", label: "Provider queue" };
      case "queued_for_workspace_write":
        return { kind: "working", label: "Write queue" };
      case "needs_input":
        return { kind: "awaiting_approval", label: "Input" };
      case "failed":
        return { kind: "error", label: "Failed" };
      case "completed":
        return { kind: "idle", label: "Completed" };
      case "idle":
        return { kind: "idle", label: "Idle" };
    }
  }

  function getInstanceStatusIcon(
    kind: BrowserGatewayInstanceStatusSummary["kind"],
  ): string {
    switch (kind) {
      case "working":
        return "sync";
      case "awaiting_approval":
        return "bell-dot";
      case "error":
        return "error";
      case "disconnected":
        return "debug-disconnect";
      case "idle":
        return "circle-filled";
    }
  }

  /**
   * Selection only ever changes automatically when the current selection is
   * missing from the instance list (initial load or a closed window) — never
   * to chase whichever instance is busy; the tab status styling signals that.
   */
  function selectPreferredInstanceId(
    instances: BrowserGatewayInstanceOption[],
    currentServerInstanceId: string,
  ): string {
    const currentSelectedTabId = selectedTabIdRef.current;
    if (currentSelectedTabId === BROWSER_GATEWAY_ASK_AGENT_TAB_ID) {
      return BROWSER_GATEWAY_ASK_AGENT_TAB_ID;
    }
    const liveInstances = instances.filter(
      (instance) => instance.disconnectedAt === undefined,
    );
    const liveCurrentServerInstance = liveInstances.find(
      (instance) => instance.instanceId === currentServerInstanceId,
    );
    if (currentSelectedTabId.trim()) {
      const currentSelectedInstance = instances.find(
        (instance) => instance.instanceId === currentSelectedTabId,
      );
      if (
        currentSelectedInstance &&
        liveInstances.some(
          (instance) =>
            instance.instanceId === currentSelectedInstance.instanceId,
        )
      ) {
        return currentSelectedTabId;
      }
      if (currentSelectedInstance) {
        const selectedWorkspacePath =
          currentSelectedInstance.workspacePath.trim();
        const liveReplacement = selectedWorkspacePath
          ? liveInstances.find(
              (instance) =>
                instance.workspacePath.trim() === selectedWorkspacePath,
            )
          : undefined;
        if (liveReplacement) {
          return liveReplacement.instanceId;
        }
        if (liveCurrentServerInstance) {
          return liveCurrentServerInstance.instanceId;
        }
        return currentSelectedTabId;
      }
      if (liveCurrentServerInstance) {
        return liveCurrentServerInstance.instanceId;
      }
    }

    return (
      liveCurrentServerInstance?.instanceId ||
      liveInstances[0]?.instanceId ||
      instances[0]?.instanceId ||
      BROWSER_GATEWAY_ASK_AGENT_TAB_ID
    );
  }

  async function fetchInstances(
    options: { commitSelection?: boolean } = {},
  ): Promise<string | null> {
    try {
      const response = await fetch(buildApiPath("/api/instances"), {
        credentials: "same-origin",
      });
      if (response.status === 401) {
        if (!authRecoveryPendingRef.current) {
          authRecoveryPendingRef.current = true;
          setStatus("Authentication expired — reloading…");
          reloadPage();
        }
        return null;
      }
      if (!response.ok) {
        setStatus(`Instance list failed: ${response.status}`);
        return null;
      }
      const data = (await response.json()) as {
        currentInstanceId: string;
        dataPlaneMode?: BrowserGatewayDataPlaneMode;
        instances: Array<{
          instanceId: string;
          workspaceName: string;
          workspacePath: string;
          url: string;
          status?: BrowserGatewayInstanceStatusSummary;
        }>;
      };
      if (data.currentInstanceId) {
        setAssociatedInstanceId(data.currentInstanceId);
      }
      if (data.dataPlaneMode !== undefined) {
        setDataPlaneMode(
          normalizeBrowserGatewayDataPlaneMode(data.dataPlaneMode, "off"),
        );
      }
      const now = Date.now();
      const liveInstanceIds = new Set(
        data.instances.map((instance) => instance.instanceId),
      );
      const liveInstances: BrowserGatewayInstanceOption[] = data.instances.map(
        (instance) => ({
          ...instance,
          lastSeenAt: now,
          disconnectedAt: undefined,
        }),
      );
      const liveWorkspacePaths = new Set(
        liveInstances
          .map((instance) => instance.workspacePath.trim())
          .filter(Boolean),
      );
      const retainedDisconnectedInstances = instanceOptionsRef.current
        .filter(
          (instance) =>
            !liveInstanceIds.has(instance.instanceId) &&
            (!instance.workspacePath.trim() ||
              !liveWorkspacePaths.has(instance.workspacePath.trim())),
        )
        .map((instance) => ({
          ...instance,
          status: instance.status ?? { kind: "idle", label: "Idle" },
          disconnectedAt: instance.disconnectedAt ?? now,
        }))
        .filter(
          (instance) =>
            now - (instance.disconnectedAt ?? now) <
            DISCONNECTED_INSTANCE_RETENTION_MS,
        );
      // Keep tab order stable regardless of registry write order.
      const instances = [
        ...liveInstances,
        ...retainedDisconnectedInstances,
      ].sort(
        (a, b) =>
          a.workspaceName.localeCompare(b.workspaceName) ||
          a.instanceId.localeCompare(b.instanceId),
      );
      const nextSelectedTabId = routeByInstance
        ? selectPreferredInstanceId(instances, data.currentInstanceId)
        : BROWSER_GATEWAY_ASK_AGENT_TAB_ID;
      if (
        options.commitSelection !== false &&
        nextSelectedTabId !== selectedTabIdRef.current
      ) {
        selectTab(nextSelectedTabId);
      }
      // The 5s refresh usually returns an identical list; skip the app-wide
      // re-render then. `lastSeenAt` changes every poll but nothing renders it.
      const previousInstances = instanceOptionsRef.current;
      instanceOptionsRef.current = instances;
      if (
        serializeInstancesIgnoringLastSeen(previousInstances) !==
        serializeInstancesIgnoringLastSeen(instances)
      ) {
        setInstanceOptions(instances);
      }
      return nextSelectedTabId === BROWSER_GATEWAY_ASK_AGENT_TAB_ID
        ? null
        : nextSelectedTabId;
    } catch (err) {
      setStatus(`Instance list error: ${String(err)}`);
      return null;
    }
  }

  async function postBrowserToast(
    message: string,
    level: "info" | "warning" | "error" = "info",
  ): Promise<void> {
    const prefix =
      level === "error" ? "Error" : level === "warning" ? "Warning" : "Info";
    setSendStatus(`${prefix}: ${message}`);
  }

  async function fetchSlashCommands(
    instanceId = selectedInstanceId,
    askAgentSelected = isAskAgentSelected,
    tabId = askAgentSelected ? BROWSER_GATEWAY_ASK_AGENT_TAB_ID : instanceId,
    generation = selectedTabGenerationRef.current,
    projectId = selectedProjectId,
  ): Promise<void> {
    if (!askAgentSelected && !projectId) return;
    try {
      const response = await fetch(
        askAgentSelected
          ? "/api/ask-agent/slash-commands"
          : buildApiPathForInstance(
              `/api/slash-commands${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`,
              instanceId,
            ),
        {
          credentials: "same-origin",
          headers: {
            Authorization: `Bearer ${authToken}`,
          },
        },
      );
      if (!response.ok) {
        return;
      }
      const body = (await response.json()) as { commands?: SlashCommandInfo[] };
      if (
        Array.isArray(body.commands) &&
        selectedTabIdRef.current === tabId &&
        selectedTabGenerationRef.current === generation &&
        (askAgentSelected || selectedProjectIdRef.current === projectId)
      ) {
        setSlashCommands(body.commands);
      }
    } catch {
      // best effort only
    }
  }

  async function fetchModes(
    instanceId = selectedInstanceId,
    tabId = isAskAgentSelected ? BROWSER_GATEWAY_ASK_AGENT_TAB_ID : instanceId,
    generation = selectedTabGenerationRef.current,
    projectId = selectedProjectId,
  ): Promise<void> {
    if (instanceId && !projectId) return;
    try {
      const response = await fetch(
        buildApiPathForInstance(
          `/api/modes${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`,
          instanceId,
        ),
        {
          headers: {
            Authorization: `Bearer ${authToken}`,
          },
        },
      );
      if (!response.ok) {
        if (
          selectedTabIdRef.current === tabId &&
          selectedTabGenerationRef.current === generation &&
          selectedProjectIdRef.current === projectId
        ) {
          setModeStatus(`Mode list unavailable (${response.status})`);
        }
        return;
      }
      const body = (await response.json()) as { modes?: ModeInfo[] };
      if (
        selectedTabIdRef.current !== tabId ||
        selectedTabGenerationRef.current !== generation ||
        selectedProjectIdRef.current !== projectId
      ) {
        return;
      }
      setModeStatus((current) =>
        current.startsWith("Mode list unavailable") ? "" : current,
      );
      if (Array.isArray(body.modes) && body.modes.length > 0) {
        setModes(body.modes);
      }
    } catch {
      if (
        selectedTabIdRef.current === tabId &&
        selectedTabGenerationRef.current === generation &&
        selectedProjectIdRef.current === projectId
      ) {
        setModeStatus("Mode list unavailable");
      }
    }
  }

  async function fetchModels(
    instanceId = selectedInstanceId,
    askAgentSelected = isAskAgentSelected,
    tabId = askAgentSelected ? BROWSER_GATEWAY_ASK_AGENT_TAB_ID : instanceId,
    generation = selectedTabGenerationRef.current,
  ): Promise<void> {
    try {
      const response = await fetch(
        askAgentSelected
          ? `/api/ask-agent/models${associatedInstanceId ? `?instanceId=${encodeURIComponent(associatedInstanceId)}` : ""}`
          : buildApiPathForInstance("/api/models", instanceId),
        {
          credentials: "same-origin",
          headers: {
            Authorization: `Bearer ${authToken}`,
          },
        },
      );
      if (!response.ok) {
        if (
          selectedTabIdRef.current === tabId &&
          selectedTabGenerationRef.current === generation
        ) {
          setModeStatus(`Model list unavailable (${response.status})`);
        }
        return;
      }
      const body = (await response.json()) as {
        models?: WebviewModelInfo[];
        publishedByOwnerId?: string;
        publishedAt?: number;
        source?: "cached" | "fallback";
      };
      if (
        selectedTabIdRef.current !== tabId ||
        selectedTabGenerationRef.current !== generation
      ) {
        return;
      }
      setModeStatus((current) =>
        current.startsWith("Model list unavailable") ? "" : current,
      );
      if (!askAgentSelected) {
        setAskAgentCapabilities([]);
        setAskAgentModelCatalog(null);
      }
      if (Array.isArray(body.models) && body.models.length > 0) {
        setModels(body.models);
        if (askAgentSelected) {
          const source =
            body.source === "cached" || body.source === "fallback"
              ? body.source
              : "unknown";
          setAskAgentModelCatalog({
            source,
            publishedByOwnerId: body.publishedByOwnerId,
            publishedAt: body.publishedAt,
            modelCount: body.models.length,
          });
        }
      }
    } catch {
      if (
        selectedTabIdRef.current === tabId &&
        selectedTabGenerationRef.current === generation
      ) {
        setModeStatus("Model list unavailable");
      }
    }
  }

  async function fetchSessions(
    instanceId = selectedInstanceId,
    askAgentSelected = isAskAgentSelected,
    tabId = askAgentSelected ? BROWSER_GATEWAY_ASK_AGENT_TAB_ID : instanceId,
    generation = selectedTabGenerationRef.current,
  ): Promise<void> {
    try {
      const response = await fetch(
        askAgentSelected
          ? "/api/ask-agent/sessions"
          : buildApiPathForInstance("/api/sessions", instanceId),
        {
          credentials: "same-origin",
          headers: {
            Authorization: `Bearer ${authToken}`,
          },
        },
      );
      if (!response.ok) {
        return;
      }
      const body = (await response.json()) as { sessions?: SessionSummary[] };
      if (
        Array.isArray(body.sessions) &&
        selectedTabIdRef.current === tabId &&
        selectedTabGenerationRef.current === generation
      ) {
        setSessionHistory(body.sessions);
      }
    } catch {
      // best effort only
    }
  }

  async function fetchAskAgentMemory(): Promise<void> {
    if (!isAskAgentSelected) return;
    setAskAgentMemoryPending(true);
    setAskAgentMemoryError(null);
    try {
      const response = await fetch("/api/ask-agent/memory", {
        credentials: "same-origin",
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      });
      const body = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        memory?: AskAgentDerivedMemoryStatus;
      };
      if (!response.ok || !body.ok || !body.memory) {
        setAskAgentMemoryError(
          `Memory status unavailable (${body.error ?? response.status}).`,
        );
        return;
      }
      setAskAgentMemory(body.memory);
      setAskAgentMemoryClearConfirmation("idle");
    } catch (err) {
      setAskAgentMemoryError(`Memory status error: ${String(err)}`);
    } finally {
      setAskAgentMemoryPending(false);
    }
  }

  async function proposeAskAgentMemoryCandidate(
    nudge: AskAgentMemoryCandidateNudge,
  ): Promise<void> {
    setSendStatus("Preparing memory proposal…");
    try {
      const response = await fetch("/api/ask-agent/memory/proposal", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          nudgeId: nudge.id,
          tier: nudge.suggestedTier,
          scope: nudge.suggestedScope,
          operation: "add",
          title: nudge.title,
          rationale: nudge.rationale,
          content: nudge.content,
        }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        snapshot?: GatewaySnapshot;
      };
      if (!response.ok || !body.ok || !body.snapshot) {
        setSendStatus(
          `Memory proposal failed: ${body.error ?? response.status}`,
        );
        return;
      }
      setSnapshot(body.snapshot);
      setSendStatus("Review the memory proposal before it is saved.");
      logAskAgentBrowserEvent("memory.nudge.propose", {
        ok: true,
        kind: nudge.kind,
      });
    } catch (err) {
      setSendStatus(`Memory proposal error: ${String(err)}`);
      logAskAgentBrowserEvent("memory.nudge.propose", {
        ok: false,
        error: String(err),
      });
    }
  }

  async function dismissAskAgentMemoryCandidate(
    nudge: AskAgentMemoryCandidateNudge,
  ): Promise<void> {
    try {
      const response = await fetch("/api/ask-agent/memory/nudge/dismiss", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({ id: nudge.id }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        snapshot?: GatewaySnapshot;
      };
      if (!response.ok || !body.ok || !body.snapshot) {
        setSendStatus(`Dismiss failed: ${body.error ?? response.status}`);
        return;
      }
      setSnapshot(body.snapshot);
      logAskAgentBrowserEvent("memory.nudge.dismiss", {
        ok: true,
        kind: nudge.kind,
      });
    } catch (err) {
      setSendStatus(`Dismiss error: ${String(err)}`);
      logAskAgentBrowserEvent("memory.nudge.dismiss", {
        ok: false,
        error: String(err),
      });
    }
  }

  async function clearAskAgentMemory(): Promise<void> {
    setAskAgentMemoryPending(true);
    setAskAgentMemoryError(null);
    try {
      const response = await fetch("/api/ask-agent/memory/clear", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({ confirm: true }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        memory?: AskAgentDerivedMemoryStatus;
      };
      if (!response.ok || !body.ok || !body.memory) {
        setAskAgentMemoryError(
          `Clear memory failed: ${body.error ?? response.status}`,
        );
        return;
      }
      setAskAgentMemory(body.memory);
      setAskAgentMemoryClearConfirmation("idle");
      setSendStatus("Cleared derived Ask Agent memory summaries.");
      logAskAgentBrowserEvent("memory.clear", {
        ok: true,
      });
    } catch (err) {
      setAskAgentMemoryError(`Clear memory error: ${String(err)}`);
      logAskAgentBrowserEvent("memory.clear", {
        ok: false,
        error: String(err),
      });
    } finally {
      setAskAgentMemoryPending(false);
    }
  }

  async function addAskAgentReadGrant(): Promise<void> {
    const requestedPath = askAgentReadGrantPath.trim();
    if (!requestedPath) {
      setSendStatus(
        "Enter a local file or directory path before granting read access.",
      );
      return;
    }
    setAskAgentReadGrantPending(true);
    setSendStatus("Granting read-only access…");
    try {
      const response = await fetch("/api/ask-agent/read-grants", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({ path: requestedPath, confirm: true }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        snapshot?: GatewaySnapshot;
      };
      if (!response.ok || !body.ok || !body.snapshot) {
        setSendStatus(`Read grant failed: ${body.error ?? response.status}`);
        return;
      }
      setSnapshot(body.snapshot);
      setAskAgentReadGrantPath("");
      setSendStatus("Read-only access granted for Ask Agent.");
      logAskAgentBrowserEvent("read_grant.add", { ok: true });
    } catch (err) {
      setSendStatus(`Read grant error: ${String(err)}`);
      logAskAgentBrowserEvent("read_grant.add", {
        ok: false,
        error: String(err),
      });
    } finally {
      setAskAgentReadGrantPending(false);
    }
  }

  async function revokeAskAgentReadGrant(id: string): Promise<void> {
    setAskAgentReadGrantPending(true);
    try {
      const response = await fetch("/api/ask-agent/read-grants/revoke", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({ id }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        snapshot?: GatewaySnapshot;
      };
      if (!response.ok || !body.ok || !body.snapshot) {
        setSendStatus(
          `Read grant revoke failed: ${body.error ?? response.status}`,
        );
        return;
      }
      setSnapshot(body.snapshot);
      setSendStatus("Read-only access revoked.");
      logAskAgentBrowserEvent("read_grant.revoke", { ok: true });
    } catch (err) {
      setSendStatus(`Read grant revoke error: ${String(err)}`);
      logAskAgentBrowserEvent("read_grant.revoke", {
        ok: false,
        error: String(err),
      });
    } finally {
      setAskAgentReadGrantPending(false);
    }
  }

  async function proposeAskAgentProjectHandoff(): Promise<void> {
    const targetId =
      askAgentHandoffTargetId || askAgentHandoffTargets[0]?.instanceId;
    const instruction = askAgentHandoffInstruction.trim();
    if (!targetId || !instruction) {
      setSendStatus(
        "Choose a VS Code project window and enter an instruction before creating a handoff preview.",
      );
      return;
    }
    setAskAgentHandoffPending(true);
    setSendStatus("Preparing project handoff preview…");
    try {
      const response = await fetch("/api/ask-agent/project-handoff/propose", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          targetInstanceId: targetId,
          mode: askAgentHandoffMode,
          instruction,
        }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        snapshot?: GatewaySnapshot;
      };
      if (!response.ok || !body.ok || !body.snapshot) {
        setSendStatus(
          `Project handoff preview failed: ${body.error ?? response.status}`,
        );
        return;
      }
      setSnapshot(body.snapshot);
      setShowAskAgentHandoff(false);
      setSendStatus("Review the project handoff before launching it.");
      logAskAgentBrowserEvent("project_handoff.propose", {
        ok: true,
        targetInstanceId: targetId,
        instructionChars: instruction.length,
      });
    } catch (err) {
      setSendStatus(`Project handoff preview error: ${String(err)}`);
      logAskAgentBrowserEvent("project_handoff.propose", {
        ok: false,
        error: String(err),
      });
    } finally {
      setAskAgentHandoffPending(false);
    }
  }

  async function cancelAskAgentProjectHandoff(id: string): Promise<void> {
    setAskAgentHandoffPending(true);
    try {
      const response = await fetch("/api/ask-agent/project-handoff/cancel", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({ id }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        snapshot?: GatewaySnapshot;
      };
      if (!response.ok || !body.ok || !body.snapshot) {
        setSendStatus(
          `Project handoff cancel failed: ${body.error ?? response.status}`,
        );
        return;
      }
      setSnapshot(body.snapshot);
      setSendStatus("Project handoff cancelled.");
      logAskAgentBrowserEvent("project_handoff.cancel", { ok: true });
    } catch (err) {
      setSendStatus(`Project handoff cancel error: ${String(err)}`);
      logAskAgentBrowserEvent("project_handoff.cancel", {
        ok: false,
        error: String(err),
      });
    } finally {
      setAskAgentHandoffPending(false);
    }
  }

  async function approveAskAgentProjectHandoff(id: string): Promise<void> {
    setAskAgentHandoffPending(true);
    setSendStatus("Launching approved project handoff…");
    try {
      const response = await fetch("/api/ask-agent/project-handoff/approve", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({ id }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        message?: string;
        snapshot?: GatewaySnapshot;
      };
      if (body.snapshot) {
        setSnapshot(body.snapshot);
      }
      if (!response.ok || !body.ok) {
        setSendStatus(
          `Project handoff failed: ${body.message ?? body.error ?? response.status}`,
        );
        return;
      }
      setAskAgentHandoffInstruction("");
      setSendStatus("Project handoff launched in the selected VS Code window.");
      logAskAgentBrowserEvent("project_handoff.approve", { ok: true });
    } catch (err) {
      setSendStatus(`Project handoff launch error: ${String(err)}`);
      logAskAgentBrowserEvent("project_handoff.approve", {
        ok: false,
        error: String(err),
      });
    } finally {
      setAskAgentHandoffPending(false);
    }
  }

  async function fetchDebugInfo(
    instanceId = selectedInstanceId,
  ): Promise<void> {
    try {
      await fetch(buildApiPath("/api/debug/refresh", instanceId), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      });
    } catch {
      // best effort only
    }
  }

  const handleToggleAutoContinue = useCallback((enabled: boolean): void => {
    setAutoContinueEnabled(enabled);
    setAutoContinueStatus(
      enabled
        ? `Auto Continue enabled (max ${AUTO_CONTINUE_MAX_TURNS} turns).`
        : "Auto Continue disabled.",
    );
    autoContinuedMessageIdsRef.current.clear();
    autoContinueCountRef.current = 0;
    pendingAutoContinueUserMessageIdRef.current = null;
  }, []);

  async function ensureAskAgentForeground(): Promise<
    GatewaySnapshot["session"]["foreground"] | null
  > {
    if (foreground) return foreground;
    if (!isAskAgentSelected || relayClientEnabled) return null;

    try {
      logAskAgentBrowserEvent("send.ensure_session.start", {
        snapshotPresent: snapshot !== null,
      });
      const response = await fetch("/api/ask-agent/session", {
        credentials: "same-origin",
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      });
      if (!response.ok) {
        logAskAgentBrowserEvent("send.ensure_session.response", {
          ok: false,
          status: response.status,
        });
        setSendStatus(`Ask Agent session unavailable (${response.status}).`);
        return null;
      }
      const nextSnapshot = await readGatewaySnapshotResponse(response);
      setSnapshot(nextSnapshot.snapshot);
      if (nextSnapshot.askAgentCapabilities) {
        setAskAgentCapabilities(nextSnapshot.askAgentCapabilities);
      }
      logAskAgentBrowserEvent("send.ensure_session.response", {
        ok: true,
        status: response.status,
        hasForeground: Boolean(nextSnapshot.snapshot.session.foreground),
      });
      return nextSnapshot.snapshot.session.foreground;
    } catch (err) {
      logAskAgentBrowserEvent("send.ensure_session.error", {
        error: String(err),
      });
      setSendStatus(`Ask Agent session error: ${String(err)}`);
      return null;
    }
  }

  async function handleSend(
    text: string,
    attachments: string[],
    displayText?: string,
    slashCommandLabel?: string,
    media?: Array<{
      name: string;
      mimeType: string;
      base64: string;
      kind: "image" | "document";
    }>,
    origin: "user" | "autoContinue" = "user",
    targetForeground?: GatewaySnapshot["session"]["foreground"],
    interject = false,
  ): Promise<boolean> {
    let pendingNewSessionForeground:
      | GatewaySnapshot["session"]["foreground"]
      | null = null;
    if (isAskAgentSelected) {
      const pendingNewSession = pendingNewSessionRef.current;
      if (pendingNewSession) {
        setSendStatus("Waiting for new session…");
        pendingNewSessionForeground =
          (await pendingNewSession)?.session.foreground ?? null;
        if (!pendingNewSessionForeground) {
          setSendStatus(
            "Message not sent because the new session failed to start.",
          );
          return false;
        }
      }
      const pendingModelSelection = pendingModelSelectionRef.current;
      if (pendingModelSelection) {
        setSendStatus("Waiting for model switch…");
        if (!(await pendingModelSelection)) {
          setSendStatus("Message not sent because the model switch failed.");
          return false;
        }
      }
    }
    const activeForeground =
      targetForeground ??
      pendingNewSessionForeground ??
      (await ensureAskAgentForeground());
    if (!activeForeground) {
      logAskAgentBrowserEvent("send.ignored", {
        reason: "missing_foreground",
        askAgentSelected: isAskAgentSelected,
        snapshotPresent: snapshot !== null,
      });
      setSendStatus(
        isAskAgentSelected
          ? "Ask Agent session is still loading. Try again in a moment."
          : "No active session is loaded.",
      );
      return false;
    }
    const selectedSendTarget = isAskAgentSelected
      ? null
      : selectedLogicalTabRef.current;
    const detachedSendTarget =
      selectedSendTarget?.sessionId === activeForeground.sessionId
        ? selectedSendTarget
        : null;

    const userMessageId = randomId();
    if (origin === "autoContinue") {
      pendingAutoContinueUserMessageIdRef.current = userMessageId;
    } else {
      pendingAutoContinueUserMessageIdRef.current = null;
    }

    let fullText = text;
    if (attachments.length > 0) {
      const fileRefs = attachments.map((p) => `[Attached: ${p}]`).join("\n");
      fullText = `${fileRefs}\n\n${text}`;
    }

    const images =
      media
        ?.filter((m) => m.kind === "image")
        .map((m) => ({
          name: m.name,
          mimeType: m.mimeType,
          base64: m.base64,
        })) ?? [];
    const documents =
      media
        ?.filter((m) => m.kind === "document")
        .map((m) => ({
          name: m.name,
          mimeType: m.mimeType,
          base64: m.base64,
        })) ?? [];

    const trimmed = fullText.trim();
    if (
      !trimmed &&
      attachments.length === 0 &&
      images.length === 0 &&
      documents.length === 0
    ) {
      logAskAgentBrowserEvent("send.ignored", {
        reason: "empty_message",
        askAgentSelected: isAskAgentSelected,
        attachmentCount: attachments.length,
        imageCount: images.length,
        documentCount: documents.length,
      });
      return false;
    }

    let displayWithMedia = displayText ?? fullText;
    if (images.length > 0 || documents.length > 0) {
      const indicators: string[] = [];
      if (images.length > 0) {
        indicators.push(
          `${images.length} image${images.length > 1 ? "s" : ""}`,
        );
      }
      if (documents.length > 0) {
        indicators.push(
          `${documents.length} file${documents.length > 1 ? "s" : ""}`,
        );
      }
      displayWithMedia = `[${indicators.join(", ")} attached]\n${displayWithMedia}`;
    }

    try {
      if (isAskAgentSelected && slashCommandLabel?.startsWith("/remember")) {
        const rememberContent = trimmed.replace(/^\/remember\b/i, "").trim();
        if (!rememberContent) {
          setSendStatus("Add what to remember after /remember.");
          return false;
        }
        setSendStatus("Preparing memory proposal…");
        const response = await fetch("/api/ask-agent/memory/proposal", {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${authToken}`,
          },
          body: JSON.stringify({
            tier: "memory",
            scope: "global",
            operation: "add",
            title: "Remember from Ask Agent",
            rationale: "User invoked /remember in Browser Ask Agent.",
            content: rememberContent,
          }),
        });
        const body = (await response.json()) as {
          ok?: boolean;
          error?: string;
          snapshot?: GatewaySnapshot;
        };
        if (body.ok && body.snapshot) {
          setSnapshot(body.snapshot);
          setSendStatus("Review the memory proposal before it is saved.");
        } else {
          setSendStatus(
            `Memory proposal failed: ${body.error ?? response.status}`,
          );
        }
        return Boolean(body.ok);
      }

      const actionOrigin = { ...snapshotOriginRef.current };
      setSendStatus("Sending…");
      logAskAgentBrowserEvent("send.start", {
        askAgentSelected: isAskAgentSelected,
        sessionId: activeForeground.sessionId,
        textChars: trimmed.length,
        attachmentCount: attachments.length,
        imageCount: images.length,
        documentCount: documents.length,
        model: activeForeground.model,
        reasoningEffort: effectiveReasoningEffort,
        origin,
        interject,
      });
      const relayEligible =
        relayClientEnabled &&
        !isAskAgentSelected &&
        origin === "user" &&
        !interject &&
        attachments.length === 0 &&
        images.length === 0 &&
        documents.length === 0 &&
        displayText === undefined &&
        slashCommandLabel === undefined;
      if (relayEligible) {
        const relayOperationId = randomId();
        if (detachedSendTarget) {
          pendingRelaySendSelectionsRef.current.set(
            relayOperationId,
            detachedSendTarget,
          );
        }
        let retainPendingRelaySend = false;
        try {
          const relay = await dispatchRelayCommand(
            {
              kind: "session.send",
              sessionId: activeForeground.sessionId,
              text: trimmed,
              detailHandles: [],
            },
            relayOperationId,
          );
          if (relay.handled) {
            retainPendingRelaySend = relay.operation.state === "accepted";
            setSendStatus(
              relay.operation.state === "accepted"
                ? "Sending…"
                : relay.operation.state === "completed"
                  ? "Sent"
                  : `Send ${relay.operation.state}: ${relay.operation.message ?? "unknown status"}`,
            );
            return (
              relay.operation.state === "accepted" ||
              relay.operation.state === "completed"
            );
          }
        } finally {
          if (detachedSendTarget && !retainPendingRelaySend) {
            pendingRelaySendSelectionsRef.current.delete(relayOperationId);
          }
        }
      }
      const sendPath = isAskAgentSelected
        ? "/api/ask-agent/send"
        : buildApiPath("/api/send");
      const response = await fetch(sendPath, {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          text: trimmed,
          id: userMessageId,
          sessionId: activeForeground.sessionId,
          projectId: isAskAgentSelected
            ? undefined
            : snapshot?.session.foreground?.project?.projectId,
          mode: activeForeground.mode,
          reasoningEffort: effectiveReasoningEffort,
          thinkingEnabled: effectiveReasoningEffort !== "none",
          attachments,
          images: images.length > 0 ? images : undefined,
          documents: documents.length > 0 ? documents : undefined,
          displayText: displayWithMedia,
          slashCommandLabel,
          isSlashCommand: Boolean(slashCommandLabel),
          interject,
          instanceId: isAskAgentSelected ? associatedInstanceId : undefined,
        }),
      });
      const body = (await response.json()) as {
        ok?: boolean;
        queued?: boolean;
        interjected?: boolean;
        error?: string;
        snapshot?: GatewaySnapshot;
      };
      if (!relayClientEnabled && body.ok && body.snapshot) {
        commitSnapshot(
          body.snapshot,
          actionOrigin.tabId,
          actionOrigin.generation,
        );
      }
      if (body.ok && detachedSendTarget) {
        refreshDetachedSelection(detachedSendTarget);
      }
      logAskAgentBrowserEvent("send.response", {
        askAgentSelected: isAskAgentSelected,
        sessionId: activeForeground.sessionId,
        ok: Boolean(body.ok),
        queued: Boolean(body.queued),
        interjected: Boolean(body.interjected),
        status: response.status,
        error: body.error ?? null,
        messageCount:
          body.snapshot?.session.foreground?.projectedMessages.length ?? null,
      });
      setSendStatus(
        body.ok
          ? body.interjected
            ? "Ready to interject at the next break."
            : body.queued
              ? "Queued."
              : "Sent"
          : body.error === "queue_full"
            ? "A message is already queued. Wait for it to send or remove it first."
            : `Send failed: ${body.error ?? response.status}`,
      );
      return Boolean(body.ok);
    } catch (err) {
      logAskAgentBrowserEvent("send.error", {
        askAgentSelected: isAskAgentSelected,
        sessionId: activeForeground.sessionId,
        error: String(err),
      });
      setSendStatus(`Send error: ${String(err)}`);
      return false;
    }
  }

  const handleInterject = (
    text: string,
    attachments: string[],
    displayText?: string,
    slashCommandLabel?: string,
    media?: Array<{
      name: string;
      mimeType: string;
      base64: string;
      kind: "image" | "document";
    }>,
  ): void => {
    void handleSend(
      text,
      attachments,
      displayText,
      slashCommandLabel,
      media,
      "user",
      foreground ?? undefined,
      true,
    );
  };

  const handleStop = (): void => {
    if (!foreground?.sessionId) return;
    const sessionId = foreground.sessionId;
    const actionOrigin = { ...snapshotOriginRef.current };
    setSendStatus("Stopping…");
    void (async () => {
      try {
        if (relayClientEnabled) {
          const relay = await dispatchRelayCommand({
            kind: "session.stop",
            sessionId,
          });
          if (relay.handled) {
            setSendStatus(
              relay.operation.state === "failed" ||
                relay.operation.state === "uncertain"
                ? `Stop ${relay.operation.state}: ${relay.operation.message ?? "unknown status"}`
                : "Stop requested",
            );
            return;
          }
        }
        const response = await fetch(
          isAskAgentSelected
            ? "/api/ask-agent/stop"
            : buildApiPath("/api/stop"),
          {
            method: "POST",
            credentials: "same-origin",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${authToken}`,
            },
            body: JSON.stringify({ sessionId }),
          },
        );
        const body = (await response.json()) as {
          ok?: boolean;
          stopped?: boolean;
          error?: string;
          snapshot?: GatewaySnapshot;
        };
        if (!relayClientEnabled && body.ok && body.snapshot) {
          commitSnapshot(
            body.snapshot,
            actionOrigin.tabId,
            actionOrigin.generation,
          );
        }
        setSendStatus(
          body.ok
            ? body.stopped === false
              ? "Nothing to stop."
              : "Stopped"
            : `Stop failed: ${body.error ?? response.status}`,
        );
      } catch (err) {
        setSendStatus(`Stop error: ${String(err)}`);
      }
    })();
  };

  const handleInstancePointerDown = (
    e: PointerEvent,
    instanceId: string,
  ): void => {
    if (e.pointerType !== "touch") {
      return;
    }
    touchTabPointerRef.current = {
      instanceId,
      pointerId: e.pointerId,
      x: e.clientX,
      y: e.clientY,
    };
  };

  const handleInstancePointerUp = (
    e: PointerEvent,
    instanceId: string,
  ): void => {
    const touchStart = touchTabPointerRef.current;
    touchTabPointerRef.current = null;
    if (
      e.pointerType !== "touch" ||
      !touchStart ||
      touchStart.pointerId !== e.pointerId ||
      touchStart.instanceId !== instanceId
    ) {
      return;
    }

    const moved = Math.hypot(
      e.clientX - touchStart.x,
      e.clientY - touchStart.y,
    );
    if (moved <= 8) {
      selectTab(instanceId);
    }
  };

  const handleInstancePointerCancel = (e: PointerEvent): void => {
    if (touchTabPointerRef.current?.pointerId === e.pointerId) {
      touchTabPointerRef.current = null;
    }
  };

  const handleLogicalTabSelect = (
    instanceId: string,
    workspace: BrowserGatewayChatWorkspaceSummary,
    tab: BrowserGatewayChatTabSummary,
  ): void => {
    const next = logicalTabSelection(instanceId, workspace, tab);
    if (!next) return;
    const previous = selectedLogicalTabRef.current;
    if (
      previous &&
      selectedTabIdRef.current === instanceId &&
      logicalTabSelectionKey(previous) === logicalTabSelectionKey(next)
    ) {
      return;
    }
    logicalSelectionByInstanceRef.current.set(instanceId, next);
    if (selectedTabIdRef.current !== instanceId) {
      selectTab(instanceId);
      return;
    }
    logicalSelectionGenerationRef.current += 1;
    selectedLogicalTabRef.current = next;
    setSelectedLogicalTab(next);
    setSnapshot(null);
    setLocalDismissedApprovalId(null);
    setLocalDismissedQuestionId(null);
    setQuestionContextMode(null);
    setQuestionAttachments({});
    setSelectedDiffId(null);
    setTranscriptView(null);
    forwardedFollowUpRef.current = "";
  };

  const handleSetReasoningEffort = (effort: ReasoningEffort): void => {
    if (!foreground || thinkingPending) {
      logAskAgentBrowserEvent("thinking.ignored", {
        askAgentSelected: isAskAgentSelected,
        reason: !foreground ? "missing_foreground" : "pending",
        effort,
      });
      return;
    }
    void (async () => {
      const actionOrigin = { ...snapshotOriginRef.current };
      setPendingReasoningEffort(effort);
      setThinkingPending(true);
      const pendingTimeout = window.setTimeout(() => {
        setThinkingPending(false);
        setPendingReasoningEffort(null);
      }, 6000);
      try {
        logAskAgentBrowserEvent("thinking.start", {
          askAgentSelected: isAskAgentSelected,
          sessionId: foreground.sessionId,
          effort,
        });
        const selectionRequest = toHttpSelectionRequest({
          type: "reasoningEffort",
          effort,
        });
        const response = await fetch(
          isAskAgentSelected
            ? "/api/ask-agent/thinking"
            : buildApiPath(selectionRequest.path),
          {
            method: "POST",
            credentials: "same-origin",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${authToken}`,
            },
            body: JSON.stringify({
              ...selectionRequest.body,
              sessionId: isAskAgentSelected ? undefined : foreground.sessionId,
            }),
          },
        );
        const body = (await response.json()) as {
          ok?: boolean;
          error?: string;
          snapshot?: GatewaySnapshot;
        };
        if (body.ok && body.snapshot) {
          if (isAskAgentSelected) {
            setSnapshot(body.snapshot);
          } else {
            commitSnapshot(
              body.snapshot,
              actionOrigin.tabId,
              actionOrigin.generation,
            );
          }
        }
        logAskAgentBrowserEvent("thinking.response", {
          askAgentSelected: isAskAgentSelected,
          sessionId: foreground.sessionId,
          effort,
          ok: Boolean(body.ok),
          status: response.status,
          error: body.error ?? null,
        });
        if (!body.ok) {
          setModeStatus(
            `Reasoning update failed: ${body.error ?? response.status}`,
          );
          window.clearTimeout(pendingTimeout);
          setThinkingPending(false);
          setPendingReasoningEffort(null);
        } else {
          window.clearTimeout(pendingTimeout);
        }
      } catch (err) {
        logAskAgentBrowserEvent("thinking.error", {
          askAgentSelected: isAskAgentSelected,
          sessionId: foreground.sessionId,
          effort,
          error: String(err),
        });
        setModeStatus(`Reasoning update error: ${String(err)}`);
        window.clearTimeout(pendingTimeout);
        setThinkingPending(false);
        setPendingReasoningEffort(null);
      }
    })();
  };

  const handleExportTranscript = (): void => {
    if (!isAskAgentSelected) {
      setModeStatus(
        "Transcript export is only available in VS Code for remote sessions.",
      );
      return;
    }
    if (!foreground || messages.length === 0) {
      setModeStatus("No Ask Agent transcript to export yet.");
      return;
    }

    const markdown = buildAskAgentTranscriptMarkdown({
      title: foreground.title || "Ask Agent",
      model: foreground.model,
      messages,
    });
    downloadTextFile(safeTranscriptFilename(foreground.title), markdown);
    setModeStatus("Exported Ask Agent transcript.");
    logAskAgentBrowserEvent("transcript.export", {
      sessionId: foreground.sessionId,
      messageCount: messages.length,
      chars: markdown.length,
    });
  };

  async function createNewSession(
    projectId?: string,
    stopRunning = false,
  ): Promise<GatewaySnapshot | null> {
    try {
      const selection = isAskAgentSelected
        ? null
        : selectedLogicalTabRef.current;
      const response = await fetch(
        isAskAgentSelected
          ? "/api/ask-agent/session/new"
          : buildApiPath("/api/session/new"),
        {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${authToken}`,
          },
          body: JSON.stringify({
            mode: isAskAgentSelected ? "ask" : (foreground?.mode ?? "code"),
            projectId: isAskAgentSelected
              ? undefined
              : (projectId ?? snapshot?.session.defaultProjectId),
            selection: selection
              ? {
                  controllerEpoch: selection.controllerEpoch,
                  tabId: selection.tabId,
                  sessionId: selection.sessionId,
                }
              : undefined,
            stopRunning,
          }),
        },
      );
      const body = (await response.json()) as {
        ok?: boolean;
        snapshot?: GatewaySnapshot;
        reason?: string;
        controllerEpoch?: string;
        tabId?: string;
        sessionId?: string;
      };
      if (
        !body.ok &&
        body.reason === "confirmation_required" &&
        !stopRunning &&
        window.confirm(
          "This chat is still running or queued. Stop it and start a new chat?",
        )
      ) {
        return createNewSession(projectId, true);
      }
      if (!body.ok) {
        setSendStatus(
          `Unable to start a new chat: ${body.reason ?? response.status}`,
        );
        return null;
      }
      if (body.snapshot) {
        setSnapshot(body.snapshot);
      } else if (
        selection &&
        body.controllerEpoch &&
        body.tabId &&
        body.sessionId
      ) {
        const next = {
          instanceId: selection.instanceId,
          controllerEpoch: body.controllerEpoch,
          tabId: body.tabId,
          sessionId: body.sessionId,
        };
        logicalSelectionByInstanceRef.current.set(selection.instanceId, next);
        selectedLogicalTabRef.current = next;
        logicalSelectionGenerationRef.current += 1;
        const cached = snapshotCacheRef.current.get(selection.instanceId);
        if (cached) {
          snapshotCacheRef.current.set(selection.instanceId, {
            ...cached,
            snapshot: rebindLogicalTabSnapshot(cached.snapshot, next),
          });
          setOwnerSnapshotRevision((revision) => revision + 1);
        }
        setSelectedLogicalTab(next);
        setSnapshot(null);
      }
      setShowHistory(false);
      setShowMcpStatus(false);
      void fetchSessions();
      return body.snapshot ?? null;
    } catch (error) {
      setSendStatus(`Unable to start a new chat: ${String(error)}`);
      return null;
    }
  }

  const handleNewSession = (): void => {
    if (pendingNewSessionRef.current) return;
    const pending = createNewSession();
    pendingNewSessionRef.current = pending;
    void pending.finally(() => {
      if (pendingNewSessionRef.current === pending) {
        pendingNewSessionRef.current = null;
      }
    });
  };

  const handleShowHistory = (): void => {
    setShowHistory((prev) => !prev);
    setShowAskAgentMemory(false);
    setSessionHistoryError(null);
    void fetchSessions();
  };

  const handleShowAskAgentMemory = (): void => {
    const next = !showAskAgentMemory;
    setShowAskAgentMemory(next);
    if (next) {
      setShowHistory(false);
      void fetchAskAgentMemory();
    } else {
      setAskAgentMemoryClearConfirmation("idle");
    }
  };

  const handleLoadSession = (sessionId: string, stopRunning = false): void => {
    void (async () => {
      try {
        const selection = isAskAgentSelected
          ? null
          : selectedLogicalTabRef.current;
        const response = await fetch(
          isAskAgentSelected
            ? "/api/ask-agent/session/load"
            : buildApiPath("/api/session/load"),
          {
            method: "POST",
            credentials: "same-origin",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${authToken}`,
            },
            body: JSON.stringify({
              sessionId,
              projectId: isAskAgentSelected
                ? undefined
                : snapshot?.session.sessions.find(
                    (session) => session.id === sessionId,
                  )?.project?.projectId,
              selection: selection
                ? {
                    controllerEpoch: selection.controllerEpoch,
                    tabId: selection.tabId,
                    sessionId: selection.sessionId,
                  }
                : undefined,
              stopRunning,
            }),
          },
        );
        const body = (await response.json().catch(() => ({}))) as {
          ok?: boolean;
          error?: string;
          snapshot?: GatewaySnapshot;
          reason?: string;
          controllerEpoch?: string;
          tabId?: string;
          sessionId?: string;
        };
        if (
          !body.ok &&
          body.reason === "confirmation_required" &&
          !stopRunning &&
          window.confirm(
            "This chat is still running or queued. Stop it and load the selected session?",
          )
        ) {
          handleLoadSession(sessionId, true);
          return;
        }
        if (!response.ok || body.ok === false) {
          setSessionHistoryError(
            `Failed to load session: ${body.error ?? body.reason ?? response.status}`,
          );
          return;
        }
        if (!relayClientEnabled && body.snapshot) {
          setSnapshot(body.snapshot);
        } else if (
          selection &&
          body.controllerEpoch &&
          body.tabId &&
          body.sessionId
        ) {
          const next = {
            instanceId: selection.instanceId,
            controllerEpoch: body.controllerEpoch,
            tabId: body.tabId,
            sessionId: body.sessionId,
          };
          logicalSelectionByInstanceRef.current.set(selection.instanceId, next);
          selectedLogicalTabRef.current = next;
          logicalSelectionGenerationRef.current += 1;
          const cached = snapshotCacheRef.current.get(selection.instanceId);
          if (cached) {
            snapshotCacheRef.current.set(selection.instanceId, {
              ...cached,
              snapshot: rebindLogicalTabSnapshot(cached.snapshot, next),
            });
            setOwnerSnapshotRevision((revision) => revision + 1);
          }
          setSelectedLogicalTab(next);
          setSnapshot(null);
        }
        setShowHistory(false);
        setShowMcpStatus(false);
      } catch (error) {
        setSessionHistoryError(`Failed to load session: ${String(error)}`);
      }
    })();
  };

  const handleDeleteSession = (sessionId: string): void => {
    void (async () => {
      const response = await fetch(
        isAskAgentSelected
          ? "/api/ask-agent/session/delete"
          : buildApiPath("/api/session/delete"),
        {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${authToken}`,
          },
          body: JSON.stringify({ sessionId }),
        },
      );
      const body = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        message?: string;
      };
      if (!response.ok || body.ok === false) {
        setSessionHistoryError(
          body.message ?? `Failed to delete session (${response.status}).`,
        );
        return;
      }
      setSessionHistoryError(null);
      void fetchSessions();
    })();
  };

  const handleRenameSession = (sessionId: string, title: string): void => {
    void (async () => {
      const response = await fetch(
        isAskAgentSelected
          ? "/api/ask-agent/session/rename"
          : buildApiPath("/api/session/rename"),
        {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${authToken}`,
          },
          body: JSON.stringify({ sessionId, title }),
        },
      );
      const body = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        message?: string;
      };
      if (!response.ok || body.ok === false) {
        setSessionHistoryError(
          body.message ?? `Failed to rename session (${response.status}).`,
        );
        return;
      }
      setSessionHistoryError(null);
      void fetchSessions();
    })();
  };

  const handleCopyFirstPrompt = (sessionId: string): void => {
    void (async () => {
      const response = await fetch(
        isAskAgentSelected
          ? "/api/ask-agent/session/copy-first-prompt"
          : buildApiPath("/api/session/copy-first-prompt"),
        {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${authToken}`,
          },
          body: JSON.stringify({ sessionId }),
        },
      );
      const body = (await response.json()) as { ok?: boolean; prompt?: string };
      if (!body.ok || !body.prompt) {
        setSendStatus("Unable to copy the first prompt for this session.");
        return;
      }

      const nextSnapshot = await createNewSession();
      const nextForeground = nextSnapshot?.session.foreground;
      if (!nextForeground) {
        setSendStatus("Unable to start a new session for the copied prompt.");
        return;
      }

      void handleSend(
        body.prompt,
        [],
        undefined,
        undefined,
        undefined,
        "user",
        nextForeground,
      );
    })();
  };

  const handleSwitchMode = (slug: string): void => {
    if (!slug || slug === foreground?.mode) return;
    void (async () => {
      try {
        setModeStatus("Switching…");
        const selectionRequest = toHttpSelectionRequest({
          type: "mode",
          mode: slug,
        });
        const projectId = foreground?.project?.projectId;
        const response = await fetch(buildApiPath(selectionRequest.path), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${authToken}`,
          },
          body: JSON.stringify({
            ...selectionRequest.body,
            projectId,
            sessionId: foreground?.sessionId,
          }),
        });
        const body = (await response.json()) as {
          approved?: boolean;
          mode?: string;
        };
        setModeStatus(
          body.approved ? `Switched to ${body.mode ?? slug}` : "Switch failed",
        );
      } catch (err) {
        setModeStatus(`Mode switch error: ${String(err)}`);
      }
    })();
  };

  const handleSelectModel = (modelId: string): void => {
    if (!modelId) {
      logAskAgentBrowserEvent("model.ignored", {
        askAgentSelected: isAskAgentSelected,
        reason: "missing_model",
      });
      return;
    }
    const previousSelection = pendingModelSelectionRef.current;
    const selection = (previousSelection ?? Promise.resolve(true)).then(
      async (): Promise<boolean> => {
        try {
          const actionOrigin = { ...snapshotOriginRef.current };
          setModeStatus("Switching model…");
          logAskAgentBrowserEvent("model.start", {
            askAgentSelected: isAskAgentSelected,
            currentModel: foreground?.model ?? null,
            nextModel: modelId,
          });
          const selectionRequest = toHttpSelectionRequest({
            type: "model",
            model: modelId,
          });
          const response = await fetch(
            isAskAgentSelected
              ? "/api/ask-agent/model"
              : buildApiPath(selectionRequest.path),
            {
              method: "POST",
              credentials: "same-origin",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${authToken}`,
              },
              body: JSON.stringify({
                ...selectionRequest.body,
                instanceId: isAskAgentSelected
                  ? associatedInstanceId
                  : undefined,
                sessionId: isAskAgentSelected
                  ? undefined
                  : foreground?.sessionId,
              }),
            },
          );
          const body = (await response.json()) as {
            ok?: boolean;
            error?: string;
            snapshot?: GatewaySnapshot;
          };
          if (body.ok && body.snapshot) {
            if (isAskAgentSelected) {
              setSnapshot(body.snapshot);
            } else {
              commitSnapshot(
                body.snapshot,
                actionOrigin.tabId,
                actionOrigin.generation,
              );
            }
          }
          logAskAgentBrowserEvent("model.response", {
            askAgentSelected: isAskAgentSelected,
            currentModel: foreground?.model ?? null,
            nextModel: modelId,
            ok: Boolean(body.ok),
            status: response.status,
            error: body.error ?? null,
          });
          setModeStatus(
            body.ok
              ? "Model updated"
              : `Model switch failed: ${body.error ?? response.status}`,
          );
          return Boolean(body.ok);
        } catch (err) {
          logAskAgentBrowserEvent("model.error", {
            askAgentSelected: isAskAgentSelected,
            currentModel: foreground?.model ?? null,
            nextModel: modelId,
            error: String(err),
          });
          setModeStatus(`Model switch error: ${String(err)}`);
          return false;
        }
      },
    );
    pendingModelSelectionRef.current = selection;
    void selection.finally(() => {
      if (pendingModelSelectionRef.current === selection) {
        pendingModelSelectionRef.current = null;
      }
    });
  };

  const handleSetCommandApprovalPolicy = (
    policy: CommandApprovalPolicy,
  ): void => {
    void (async () => {
      try {
        const selectionRequest = toHttpSelectionRequest({
          type: "commandApprovalPolicy",
          policy,
        });
        const response = await fetch(buildApiPath(selectionRequest.path), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${authToken}`,
          },
          body: JSON.stringify({
            ...selectionRequest.body,
            sessionId: foreground?.sessionId,
          }),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
      } catch (error) {
        console.error("Failed to update command approval policy", error);
      }
    })();
  };

  const handleSetWriteApproval = (nextMode: WriteApprovalSelection): void => {
    if (!nextMode) return;
    void (async () => {
      try {
        const selectionRequest = toHttpSelectionRequest({
          type: "writeApproval",
          mode: nextMode,
        });
        const response = await fetch(buildApiPath(selectionRequest.path), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${authToken}`,
          },
          body: JSON.stringify({
            ...selectionRequest.body,
            sessionId: foreground?.sessionId,
          }),
        });
        const body = (await response.json()) as {
          ok?: boolean;
          error?: string;
        };
        if (!body.ok) {
          setModeStatus(
            `Write approval update failed: ${body.error ?? response.status}`,
          );
        }
      } catch (err) {
        setModeStatus(`Write approval error: ${String(err)}`);
      }
    })();
  };

  const handleSetCondenseThreshold = (_threshold: number): void => {
    // Keep control visible for parity, but browser does not persist this yet.
  };

  const refreshAskAgentMcpStatus = async (options?: {
    reconnect?: boolean;
    view?: McpManagerView;
  }): Promise<void> => {
    try {
      const response = await fetch(
        options?.reconnect
          ? "/api/ask-agent/mcp-refresh"
          : "/api/ask-agent/mcp-config",
        {
          method: options?.reconnect ? "POST" : "GET",
          credentials: "same-origin",
          headers: {
            Authorization: `Bearer ${authToken}`,
          },
        },
      );
      const body = (await response.json()) as {
        ok?: boolean;
        infos?: GatewaySnapshot["ui"]["mcpStatusInfos"];
        configSnapshot?: McpConfigSnapshot;
        error?: string;
      };
      if (body.configSnapshot) {
        setMcpManagerSnapshot(body.configSnapshot);
      } else {
        setMcpManagerSnapshot(null);
      }
      setMcpManagerView(options?.view ?? "status");
      setAskAgentMcpStatusError(body.ok ? null : (body.error ?? null));
      setModeStatus(
        body.ok
          ? options?.reconnect
            ? "Ask Agent MCP servers refreshed."
            : "Ask Agent MCP manager loaded."
          : `Ask Agent MCP unavailable: ${body.error ?? response.status}`,
      );
    } catch (err) {
      setAskAgentMcpStatusError(String(err));
      setMcpManagerSnapshot(null);
      setModeStatus(`Ask Agent MCP status error: ${String(err)}`);
    }
  };

  const refreshWorkspaceMcpStatus = async (
    projectId?: string,
    view: McpManagerView = "status",
  ): Promise<void> => {
    try {
      const query = new URLSearchParams({ profile: "main" });
      if (projectId) query.set("projectId", projectId);
      const response = await fetch(
        buildApiPath(`/api/mcp/config?${query.toString()}`),
        {
          headers: { Authorization: `Bearer ${authToken}` },
        },
      );
      const body = (await response.json()) as {
        ok?: boolean;
        configSnapshot?: McpConfigSnapshot;
        error?: string;
      };
      setMcpManagerSnapshot(body.configSnapshot ?? null);
      setMcpManagerView(view);
      setModeStatus(
        body.ok
          ? "Workspace MCP manager loaded."
          : `Workspace MCP unavailable: ${body.error ?? response.status}`,
      );
    } catch (err) {
      setMcpManagerSnapshot(null);
      setModeStatus(`Workspace MCP status error: ${String(err)}`);
    }
  };

  const mutateAskAgentMcpConfig = async (
    mutation: McpConfigBatchMutation,
  ): Promise<McpConfigMutationResult> => {
    const response = await fetch("/api/ask-agent/mcp-config/server", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify(mutation),
    });
    const result = (await response.json()) as McpConfigMutationResult;
    if (result.configSnapshot) setMcpManagerSnapshot(result.configSnapshot);
    setModeStatus(
      result.ok
        ? result.connectionOutcomes?.some(
            (outcome) => outcome.status === "failed",
          )
          ? "MCP config saved, but one or more servers failed to connect."
          : "Ask Agent MCP config saved."
        : `MCP save failed: ${result.errors?.[0]?.message ?? response.status}`,
    );
    return result;
  };

  const saveAskAgentMcpServer = async (
    scope: McpManagerScope,
    server: McpManagerServerDraft,
  ): Promise<void> => {
    const response = await fetch("/api/ask-agent/mcp-config/server", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ profile: "ask-agent", scope, server }),
    });
    const body = (await response.json()) as {
      ok?: boolean;
      configSnapshot?: McpConfigSnapshot;
      error?: string;
    };
    if (body.configSnapshot) setMcpManagerSnapshot(body.configSnapshot);
    setModeStatus(
      body.ok
        ? "Ask Agent MCP server saved."
        : `MCP save failed: ${body.error ?? response.status}`,
    );
  };

  const removeAskAgentMcpServer = async (
    scope: McpManagerScope,
    serverName: string,
  ): Promise<void> => {
    const response = await fetch("/api/ask-agent/mcp-config/server", {
      method: "DELETE",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ profile: "ask-agent", scope, serverName }),
    });
    const body = (await response.json()) as {
      ok?: boolean;
      configSnapshot?: McpConfigSnapshot;
      error?: string;
    };
    if (body.configSnapshot) setMcpManagerSnapshot(body.configSnapshot);
    setModeStatus(
      body.ok
        ? "Ask Agent MCP server removed."
        : `MCP remove failed: ${body.error ?? response.status}`,
    );
  };

  const openAskAgentRawMcpConfig = async (
    scope: McpManagerScope,
  ): Promise<void> => {
    const response = await fetch("/api/ask-agent/mcp-config/open-raw", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ profile: "ask-agent", scope }),
    });
    const body = (await response.json()) as { ok?: boolean; error?: string };
    setModeStatus(
      body.ok
        ? "Requested VS Code to open the raw Ask Agent MCP config."
        : `Raw config open failed: ${body.error ?? response.status}`,
    );
  };

  const handleMcpAction = (
    serverName: string,
    action: "disable" | "reconnect" | "reauthenticate",
    projectId?: string,
  ): void => {
    void (async () => {
      const response = await fetch(buildApiPath("/api/mcp/action"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({ serverName, action, projectId }),
      });
      const body = (await response.json()) as {
        configSnapshot?: McpConfigSnapshot;
      };
      if (body.configSnapshot) setMcpManagerSnapshot(body.configSnapshot);
    })();
  };

  const handleForwardedApprovalSubmit = (
    data: Omit<DecisionMessage, "type">,
  ): void => {
    const submittedApprovalId = data.id;
    const origin = { ...snapshotOriginRef.current };
    const approval = visibleApproval;
    const followUp =
      data.followUp?.trim() || forwardedFollowUpRef.current.trim();
    forwardedFollowUpRef.current = "";
    setLocalDismissedApprovalId(submittedApprovalId);
    void (async () => {
      const approvalPath =
        origin.tabId === BROWSER_GATEWAY_ASK_AGENT_TAB_ID
          ? approval?.kind === "memory"
            ? "/api/ask-agent/memory/approval"
            : "/api/ask-agent/approval"
          : buildApiPathForTab("/api/approval", origin.tabId);
      const response = await fetch(approvalPath, {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          ...data,
          approvalKind: approval?.kind ?? data.approvalKind,
          ...(followUp ? { followUp } : { followUp: undefined }),
        }),
      });
      const body = (await response.json()) as {
        ok?: boolean;
        error?: string;
        snapshot?: GatewaySnapshot;
      };
      if (!relayClientEnabled && body.ok && body.snapshot) {
        commitSnapshot(body.snapshot, origin.tabId, origin.generation);
      }
      if (!body.ok && selectedTabIdRef.current === origin.tabId) {
        setLocalDismissedApprovalId(null);
        setModeStatus(
          `Approval action failed: ${body.error ?? response.status}`,
        );
      }
    })();
  };

  const handleSuggestRegex = async (args: {
    subCommand: string;
    fullCommand: string;
  }): Promise<string> => {
    const response = await fetch(buildApiPath("/api/suggest-regex"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify(args),
    });
    const body = (await response.json()) as {
      ok?: boolean;
      pattern?: string;
      error?: string;
    };
    if (!response.ok) {
      throw new Error(body.error ?? `HTTP ${response.status}`);
    }
    if (!body.ok || !body.pattern) {
      throw new Error(body.error ?? "Failed to suggest regex");
    }
    return body.pattern;
  };

  const handlePolishPrompt = async (draft: string): Promise<string> => {
    const response = await fetch(buildApiPath("/api/polish-prompt"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ draft }),
    });
    const body = (await response.json()) as {
      ok?: boolean;
      polished?: string;
      error?: string;
    };
    if (!response.ok) {
      throw new Error(body.error ?? `HTTP ${response.status}`);
    }
    if (!body.ok || !body.polished) {
      throw new Error(body.error ?? "Failed to polish prompt");
    }
    return body.polished;
  };

  const commitSidePanePercent = (percent: number): void => {
    const layout = browserLayoutRef.current;
    const totalWidth = layout?.getBoundingClientRect().width ?? 0;
    const nextPercent = clampSidePanePercentForWidth(percent, totalWidth);
    setSidePanePercent(nextPercent);
    writeCachedSidePanePercent(nextPercent);
  };

  const handleSidePaneResizeStart = (e: MouseEvent): void => {
    if (e.button !== 0) return;
    const layout = browserLayoutRef.current;
    if (!layout) return;

    e.preventDefault();
    sidePaneResizeCleanupRef.current?.();

    const rect = layout.getBoundingClientRect();
    let latestPercent = sidePanePercent;
    setSidePaneResizing(true);

    const updateFromClientX = (clientX: number): void => {
      const nextWidth = clientX - rect.left;
      latestPercent = clampSidePanePercentForWidth(
        (nextWidth / rect.width) * 100,
        rect.width,
      );
      setSidePanePercent(latestPercent);
    };

    const onMove = (moveEvent: MouseEvent) => {
      updateFromClientX(moveEvent.clientX);
    };

    const onUp = () => {
      setSidePaneResizing(false);
      writeCachedSidePanePercent(latestPercent);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      sidePaneResizeCleanupRef.current = null;
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    sidePaneResizeCleanupRef.current = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      setSidePaneResizing(false);
    };
  };

  const handleSidePaneResizeKeyDown = (e: KeyboardEvent): void => {
    const layout = browserLayoutRef.current;
    const totalWidth = layout?.getBoundingClientRect().width ?? 0;
    if (!layout || totalWidth <= 0) return;

    const currentWidth = totalWidth * (sidePanePercent / 100);
    const step = e.shiftKey
      ? SIDE_PANE_KEYBOARD_STEP * 2
      : SIDE_PANE_KEYBOARD_STEP;

    if (e.key === "ArrowLeft") {
      e.preventDefault();
      commitSidePanePercent(((currentWidth - step) / totalWidth) * 100);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      commitSidePanePercent(((currentWidth + step) / totalWidth) * 100);
    } else if (e.key === "Home") {
      e.preventDefault();
      commitSidePanePercent(MIN_SIDE_PANE_PERCENT);
    } else if (e.key === "End") {
      e.preventDefault();
      commitSidePanePercent(MAX_SIDE_PANE_PERCENT);
    }
  };

  const handleApprovalResizeStart = (e: MouseEvent): void => {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = approvalPanelHeight;
    setApprovalResizing(true);

    const onMove = (moveEvent: MouseEvent) => {
      const delta = moveEvent.clientY - startY;
      const nextHeight = Math.max(
        MIN_APPROVAL_PANEL_HEIGHT,
        Math.min(720, startHeight - delta),
      );
      setApprovalPanelHeight(nextHeight);
    };

    const onUp = () => {
      setApprovalResizing(false);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      approvalResizeCleanupRef.current = null;
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    approvalResizeCleanupRef.current = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  };

  const handleSignIn = (_provider: string): void => {
    setModeStatus("Sign-in is available in the VS Code extension.");
  };

  const handleRetry = (): void => {
    if (!isAskAgentSelected) {
      void handleSend("Retry the last step.", []);
      return;
    }
    void (async () => {
      if (!foreground) {
        setSendStatus("No Ask Agent session is loaded to retry.");
        return;
      }
      try {
        setSendStatus("Retrying…");
        const response = await fetch("/api/ask-agent/retry", {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${authToken}`,
          },
          body: JSON.stringify({
            sessionId: foreground.sessionId,
            instanceId: associatedInstanceId,
          }),
        });
        const body = (await response.json().catch(() => ({}))) as {
          ok?: boolean;
          error?: string;
          snapshot?: GatewaySnapshot;
        };
        if (body.ok && body.snapshot) {
          setSnapshot(body.snapshot);
          setSendStatus("Retried");
          return;
        }
        setSendStatus(`Retry failed: ${body.error ?? response.status}`);
      } catch (err) {
        setSendStatus(`Retry error: ${String(err)}`);
      }
    })();
  };

  const handleResumeInterruptedSession = (): void => {
    if (isAskAgentSelected || !foreground) return;
    const sessionId = foreground.sessionId;
    setSendStatus("Resuming interrupted session…");
    void fetch(buildApiPath("/api/resume"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ sessionId }),
    })
      .then(async (response) => {
        const body = (await response.json().catch(() => ({}))) as {
          ok?: boolean;
          error?: string;
        };
        if (!response.ok || !body.ok) {
          setSendStatus(
            `Resume failed: ${body.error ?? String(response.status)}`,
          );
          return;
        }
        setSnapshot((previous) => {
          const active = previous?.session.foreground;
          if (!previous || active?.sessionId !== sessionId) return previous;
          return {
            ...previous,
            session: {
              ...previous.session,
              foreground: {
                ...active,
                interrupted: false,
                streaming: true,
                status: "streaming",
              },
            },
          };
        });
        setSendStatus("Resuming…");
      })
      .catch((error) => {
        setSendStatus(`Resume error: ${String(error)}`);
      });
  };

  const handleCondense = (): void => {
    void handleSend("/condense", []);
  };

  const handleRevertCheckpoint = (
    _sessionId: string,
    checkpointId: string,
  ): void => {
    void handleSend(`/revert ${checkpointId}`, []);
  };

  const handleViewCheckpointDiff = (
    _sessionId: string,
    checkpointId: string,
    scope: "turn" | "all",
  ): void => {
    void handleSend(`/checkpoint diff ${checkpointId} ${scope}`, []);
  };

  const handleStopBackground = (sessionId: string): void => {
    void (async () => {
      try {
        const response = await fetch(buildApiPath("/api/background/stop"), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${authToken}`,
          },
          body: JSON.stringify({ sessionId }),
        });
        const body = (await response.json()) as {
          ok?: boolean;
          error?: string;
        };
        setModeStatus(
          body.ok
            ? "Background session stopped"
            : `Stop failed: ${body.error ?? response.status}`,
        );
      } catch (err) {
        setModeStatus(`Stop error: ${String(err)}`);
      }
    })();
  };

  const handleOpenBgTranscript = (sessionId: string): void => {
    if (transcriptView?.sessionId === sessionId) {
      setTranscriptView((current) =>
        current ? { ...current, visible: true } : current,
      );
      const bgInfo = background.find((session) => session.id === sessionId);
      if (
        bgInfo?.status === "streaming" ||
        bgInfo?.status === "tool_executing" ||
        bgInfo?.status === "awaiting_approval"
      ) {
        return;
      }
    }
    void (async () => {
      try {
        const response = await fetch(
          buildApiPath("/api/background/open-transcript"),
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${authToken}`,
            },
            body: JSON.stringify({ sessionId }),
          },
        );
        const body = (await response.json()) as {
          ok?: boolean;
          error?: string;
          transcript?: {
            sessionId: string;
            task: string;
            messages: unknown[];
          };
        };
        if (!body.ok || !body.transcript) {
          setModeStatus(
            `Open transcript failed: ${body.error ?? response.status}`,
          );
          return;
        }

        const converted = agentMessagesToChatMessages(body.transcript.messages);
        setTranscriptView({
          sessionId,
          task: body.transcript.task,
          messages: converted,
          streaming: true,
          visible: true,
        });
        const assistantBlocks = converted
          .filter((message) => message.role === "assistant")
          .reduce((count, message) => count + message.blocks.length, 0);
        setModeStatus(
          `Loaded ${converted.length} messages (${assistantBlocks} assistant blocks) for ${body.transcript.task}`,
        );
      } catch (err) {
        setModeStatus(`Open transcript error: ${String(err)}`);
      }
    })();
  };

  const handleBackgroundAction = (
    action:
      | "steer"
      | "detach"
      | "retry"
      | "archive"
      | "pause"
      | "resume"
      | "mark_read",
    sessionId: string,
    message?: string,
  ): void => {
    void fetch(buildApiPath("/api/background/action"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ action, sessionId, message }),
    }).then(async (response) => {
      const body = (await response.json()) as { ok?: boolean; error?: string };
      setModeStatus(
        body.ok
          ? `Background ${action} accepted`
          : `${action} failed: ${body.error ?? response.status}`,
      );
    });
  };

  const handleAskAgentExecuteBuiltinCommand = (
    name: string,
    _args: string,
  ): void => {
    switch (name) {
      case "mcp":
        setShowMcpStatus(true);
        void refreshAskAgentMcpStatus({ view: "status" });
        break;
      case "mcp-config": {
        setShowMcpStatus(true);
        void refreshAskAgentMcpStatus({ view: "config" });
        break;
      }
      case "mcp-refresh":
        setShowMcpStatus(true);
        void refreshAskAgentMcpStatus({ reconnect: true });
        break;
      default:
        setModeStatus(`Unsupported Ask Agent slash command: /${name}`);
        break;
    }
  };

  const handleExecuteBuiltinCommand = (name: string, args: string): void => {
    switch (name) {
      case "new": {
        handleNewSession();
        break;
      }
      case "mode": {
        const slug = args.trim();
        if (slug) handleSwitchMode(slug);
        break;
      }
      case "model": {
        const modelId = args.trim();
        if (modelId) handleSelectModel(modelId);
        break;
      }
      case "fleet":
        setShowFleetRequest((request) => request + 1);
        return;
      case "mcp":
        setShowMcpStatus(true);
        void refreshWorkspaceMcpStatus(
          foreground?.project?.projectId ??
            snapshot?.session.defaultProjectId ??
            undefined,
        );
        return;
      case "pair":
        setModeStatus(
          "Run /pair in VS Code to add a new browser device — pairing codes can only be generated there.",
        );
        return;
      case "worktree":
        setModeStatus(
          "Run /worktree in VS Code to configure and open a local worktree window.",
        );
        return;
    }

    if (isForwardedBuiltinCommand("browser", name)) {
      void handleSend(`/${name}${args ? ` ${args}` : ""}`, []);
    }
  };

  const reviewPaneContent =
    diffs.length > 0 ? (
      <>
        <div class="diff-list" role="tablist" aria-label="Pending file diffs">
          {diffs.map((diff) => (
            <button
              key={diff.requestId}
              class={`diff-list-item ${selectedDiffId === diff.requestId ? "active" : ""}`}
              onClick={() => setSelectedDiffId(diff.requestId)}
              role="tab"
              aria-selected={selectedDiffId === diff.requestId}
              aria-label={diff.filePath}
              title={`${diff.operation} ${diff.filePath}${diff.outsideWorkspace ? " (outside workspace)" : ""} · ${formatTimestamp(diff.createdAt)}`}
            >
              <i class="codicon codicon-file" />
              <span class="diff-list-title">{basenameOf(diff.filePath)}</span>
              {dirnameOf(diff.filePath) ? (
                <span class="diff-list-subtitle">
                  {dirnameOf(diff.filePath)}
                </span>
              ) : null}
            </button>
          ))}
        </div>
        <div class="diff-detail-card">
          <BrowserDiffViewer
            requestId={selectedDiffId}
            authToken={authToken}
            buildApiPath={buildApiPath}
            theme={snapshot?.theme ?? initialTheme}
          />
        </div>
      </>
    ) : (
      <EmptyState>No pending file diffs.</EmptyState>
    );

  const streaming = foreground?.streaming === true;
  const statusOverride = foreground?.statusOverride ?? null;

  useEffect(() => {
    const sessionId = foreground?.sessionId ?? null;
    if (autoContinueSessionIdRef.current === sessionId) return;
    autoContinueSessionIdRef.current = sessionId;
    autoContinuedMessageIdsRef.current.clear();
    autoContinueCountRef.current = 0;
    pendingAutoContinueUserMessageIdRef.current = null;
    if (autoContinueEnabled) {
      setAutoContinueEnabled(false);
      setAutoContinueStatus("Auto Continue paused after session change.");
    }
  }, [autoContinueEnabled, foreground?.sessionId]);

  useEffect(() => {
    if (!autoContinueEnabled || !foreground) return;
    if (pendingApproval || pendingQuestion) return;
    if (
      foreground.streaming ||
      foreground.status === "streaming" ||
      foreground.status === "tool_executing" ||
      foreground.status === "awaiting_approval"
    ) {
      return;
    }

    const lastMessage = messages[messages.length - 1];
    if (lastMessage?.error) {
      setAutoContinueEnabled(false);
      setAutoContinueStatus("Auto Continue paused after an agent error.");
      return;
    }

    const action = getLatestAutoContinueAction(messages);
    if (!action) {
      const latest = getLatestFinalMessageMarker(messages);
      if (!latest || latest.marker.autoContinueStopReason) return;
      const reason =
        latest.marker.status === "waiting_for_user"
          ? "Auto Continue stopped because the agent is waiting for input."
          : `Auto Continue stopped because the task status is ${latest.marker.status.replaceAll("_", " ")}.`;
      setAutoContinueEnabled(false);
      setAutoContinueStatus(reason);
      setAutoContinueStopReasons((prev) => {
        const next = new Map(prev);
        next.set(latest.messageId, reason);
        return next;
      });
      return;
    }
    if (autoContinuedMessageIdsRef.current.has(action.messageId)) return;

    const timer = window.setTimeout(() => {
      if (autoContinuedMessageIdsRef.current.has(action.messageId)) return;

      const pendingAutoContinueUserMessageId =
        pendingAutoContinueUserMessageIdRef.current;
      if (
        pendingAutoContinueUserMessageId &&
        !turnMadeProgress(messages, pendingAutoContinueUserMessageId)
      ) {
        setAutoContinueEnabled(false);
        setAutoContinueStatus(AUTO_CONTINUE_NO_PROGRESS_REASON);
        pendingAutoContinueUserMessageIdRef.current = null;
        setAutoContinueStopReasons((prev) => {
          const next = new Map(prev);
          next.set(action.messageId, AUTO_CONTINUE_NO_PROGRESS_REASON);
          return next;
        });
        return;
      }

      if (autoContinueCountRef.current >= AUTO_CONTINUE_MAX_TURNS) {
        const reason = `Auto Continue stopped after ${AUTO_CONTINUE_MAX_TURNS} turns to avoid an infinite loop.`;
        setAutoContinueEnabled(false);
        setAutoContinueStatus(reason);
        setAutoContinueStopReasons((prev) => {
          const next = new Map(prev);
          next.set(action.messageId, reason);
          return next;
        });
        return;
      }

      autoContinuedMessageIdsRef.current.add(action.messageId);
      autoContinueCountRef.current += 1;
      setAutoContinueStatus(
        `Auto Continue sent ${autoContinueCountRef.current}/${AUTO_CONTINUE_MAX_TURNS}.`,
      );
      setHiddenFinalContinueMessageIds((prev) => {
        const next = new Set(prev);
        next.add(action.messageId);
        return next;
      });
      void handleSend(
        action.prompt,
        [],
        undefined,
        undefined,
        undefined,
        "autoContinue",
      );
    }, AUTO_CONTINUE_BROWSER_SETTLE_MS);

    return () => window.clearTimeout(timer);
  }, [
    autoContinueEnabled,
    foreground,
    foreground?.status,
    foreground?.streaming,
    handleSend,
    messages,
    pendingApproval,
    pendingQuestion,
  ]);

  const composerModes = modes.length > 0 ? modes : DEFAULT_BROWSER_MODES;
  const composerModels =
    models.length > 0
      ? models
      : foreground?.model
        ? [
            {
              id: foreground.model,
              displayName: foreground.model,
              provider: isAskAgentSelected ? "browser-gateway" : "local",
              contextWindow: 0,
              authenticated: true,
            } satisfies WebviewModelInfo,
          ]
        : [];

  const browserVscodeApi = {
    postMessage: (msg: unknown) => {
      const data =
        msg && typeof msg === "object" ? (msg as Record<string, unknown>) : {};
      const command = typeof data.command === "string" ? data.command : "";

      if (command === "agentRefreshSlashCommands") {
        void fetchSlashCommands();
        return;
      }

      if (command === "agentSearchFiles") {
        const query = String(data.query ?? "").trim();
        const requestId = String(data.requestId ?? "");
        if (!query || !requestId) {
          window.postMessage({
            type: "agentFileSearchResults",
            requestId,
            files: [],
          });
          return;
        }
        const projectId =
          foreground?.project?.projectId ?? snapshot?.session.defaultProjectId;
        const url = buildApiPath(
          `/api/search-files?query=${encodeURIComponent(query)}${projectId ? `&projectId=${encodeURIComponent(projectId)}` : ""}`,
        );
        void fetch(url, {
          headers: {
            Authorization: `Bearer ${authToken}`,
          },
        })
          .then(async (response) => {
            if (!response.ok) {
              window.postMessage({
                type: "agentFileSearchResults",
                requestId,
                files: [],
              });
              return;
            }
            const body = (await response.json()) as {
              files?: Array<{ path: string; kind: "file" | "folder" }>;
            };
            window.postMessage({
              type: "agentFileSearchResults",
              requestId,
              files: Array.isArray(body.files) ? body.files : [],
            });
          })
          .catch(() => {
            window.postMessage({
              type: "agentFileSearchResults",
              requestId,
              files: [],
            });
          });
        return;
      }

      if (command === "agentOpenFile") {
        const filePath = String(data.path ?? "").trim();
        const line =
          typeof data.line === "number" && Number.isInteger(data.line)
            ? data.line
            : undefined;
        if (!filePath || !selectedProjectId) {
          setModeStatus("File cannot be opened without an available project.");
          return;
        }
        void fetch(buildApiPath("/api/open-file"), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${authToken}`,
          },
          body: JSON.stringify({
            path: filePath,
            line,
            projectId: selectedProjectId,
          }),
        })
          .then(async (response) => {
            if (response.ok) return;
            const body = (await response.json().catch(() => ({}))) as {
              error?: string;
            };
            setModeStatus(
              `Could not open ${filePath}: ${body.error ?? response.status}`,
            );
          })
          .catch(() => {
            setModeStatus(`Could not open ${filePath}.`);
          });
        return;
      }

      if (command === "agentToast") {
        void postBrowserToast(
          String(data.message ?? ""),
          (data.level as "info" | "warning" | "error" | undefined) ?? "info",
        );
        return;
      }

      if (command === "agentAttachFile") {
        void fetch(buildApiPath("/api/attach-file"), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${authToken}`,
          },
          body: JSON.stringify({
            projectId:
              foreground?.project?.projectId ??
              snapshot?.session.defaultProjectId,
          }),
        })
          .then(async (response) => {
            if (!response.ok) {
              window.postMessage({
                type: "agentDroppedFilesResolved",
                files: [],
              });
              return;
            }
            const body = (await response.json()) as {
              files?: string[];
            };
            window.postMessage({
              type: "agentDroppedFilesResolved",
              files: Array.isArray(body.files) ? body.files : [],
            });
          })
          .catch(() => {
            window.postMessage({
              type: "agentDroppedFilesResolved",
              files: [],
            });
          });
        return;
      }

      if (command === "agentSetModel") {
        const modelId = String(data.model ?? "").trim();
        if (modelId) {
          handleSelectModel(modelId);
        }
        return;
      }

      if (command === "agentSwitchMode") {
        const mode = String(data.mode ?? "").trim();
        if (mode) {
          handleSwitchMode(mode);
        }
        return;
      }

      if (command === "agentNewSession") {
        handleNewSession();
        return;
      }

      if (command === "agentListSessions") {
        void fetchSessions();
        return;
      }

      if (command === "agentLoadSession") {
        const sessionId = String(data.sessionId ?? "").trim();
        if (sessionId) {
          handleLoadSession(sessionId);
        }
        return;
      }

      if (command === "agentDeleteSession") {
        const sessionId = String(data.sessionId ?? "").trim();
        if (sessionId) {
          handleDeleteSession(sessionId);
        }
        return;
      }

      if (command === "agentRenameSession") {
        const sessionId = String(data.sessionId ?? "").trim();
        const title = String(data.title ?? "").trim();
        if (sessionId && title) {
          handleRenameSession(sessionId, title);
        }
        return;
      }

      if (command === "agentCopyFirstPrompt") {
        const sessionId = String(data.sessionId ?? "").trim();
        if (sessionId) {
          handleCopyFirstPrompt(sessionId);
        }
        return;
      }

      if (command === "agentQuestionResponse") {
        const id = String(data.id ?? "").trim();
        const originTabId = String(
          data.originTabId ?? snapshotOriginRef.current.tabId,
        );
        const answers =
          data.answers && typeof data.answers === "object"
            ? (data.answers as Record<
                string,
                string | string[] | number | boolean
              >)
            : {};
        const notes =
          data.notes && typeof data.notes === "object"
            ? (data.notes as Record<string, string>)
            : {};
        const attachments =
          data.attachments && typeof data.attachments === "object"
            ? data.attachments
            : {};
        if (id) {
          void fetch(
            buildApiPathForTab(
              originTabId === BROWSER_GATEWAY_ASK_AGENT_TAB_ID
                ? "/api/ask-agent/question"
                : "/api/question",
              originTabId,
            ),
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${authToken}`,
              },
              body: JSON.stringify({ id, answers, notes, attachments }),
            },
          );
        }
        return;
      }

      if (command === "agentUrlElicitationResponse") {
        const id = String(data.id ?? "").trim();
        const action = String(data.action ?? "");
        const originTabId = String(
          data.originTabId ?? snapshotOriginRef.current.tabId,
        );
        if (
          id &&
          (action === "accept" || action === "cancel" || action === "decline")
        ) {
          void fetch(buildApiPathForTab("/api/url-elicitation", originTabId), {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${authToken}`,
            },
            body: JSON.stringify({ id, action }),
          });
        }
        return;
      }

      if (command === "agentQuestionProgress") {
        const id = String(data.id ?? "").trim();
        const step = Number(data.step ?? 0);
        const originTabId = String(
          data.originTabId ?? snapshotOriginRef.current.tabId,
        );
        const answers =
          data.answers && typeof data.answers === "object"
            ? (data.answers as Record<
                string,
                string | string[] | number | boolean | undefined
              >)
            : {};
        const notes =
          data.notes && typeof data.notes === "object"
            ? (data.notes as Record<string, string>)
            : {};
        const origin = String(data.origin ?? questionProgressOriginRef.current);
        if (id) {
          void fetch(
            buildApiPathForTab(
              originTabId === BROWSER_GATEWAY_ASK_AGENT_TAB_ID
                ? "/api/ask-agent/question-progress"
                : "/api/question-progress",
              originTabId,
            ),
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${authToken}`,
              },
              body: JSON.stringify({ id, step, answers, notes, origin }),
            },
          );
        }
        return;
      }

      if (command === "approvalDecision") {
        const payload = data as unknown as DecisionMessage;
        if (payload.id && payload.decision) {
          handleForwardedApprovalSubmit(payload);
        }
        return;
      }

      if (command === "agentMcpAction") {
        const serverName = String(data.serverName ?? "").trim();
        const action = String(data.action ?? "") as
          | "disable"
          | "reconnect"
          | "reauthenticate";
        if (serverName && action) {
          setShowMcpStatus(true);
          handleMcpAction(serverName, action);
        }
        return;
      }

      if (command === "agentSetWriteApproval") {
        const writeApprovalMode = String(data.mode ?? "").trim();
        if (isWriteApprovalSelection(writeApprovalMode)) {
          handleSetWriteApproval(writeApprovalMode);
        }
        return;
      }

      if (command === "agentSetCommandApprovalPolicy") {
        if (isCommandApprovalPolicy(data.policy)) {
          handleSetCommandApprovalPolicy(data.policy);
        }
        return;
      }

      if (
        command === "agentSteerQueuedMessage" ||
        command === "agentInterjectQueuedMessage"
      ) {
        const sessionId = String(data.sessionId ?? "").trim();
        const queueId = String(data.queueId ?? "").trim();
        if (!sessionId || !queueId) return;
        const isSteer = command === "agentSteerQueuedMessage";
        const optimisticKey = `${sessionId}:${queueId}`;
        const clearOptimisticInterjection = () => {
          if (isSteer) return;
          setOptimisticQueueInterjections((previous) => {
            if (!previous.has(optimisticKey)) return previous;
            const next = new Set(previous);
            next.delete(optimisticKey);
            return next;
          });
        };
        if (!isSteer) {
          setOptimisticQueueInterjections((previous) => {
            const next = new Set(previous);
            next.add(optimisticKey);
            return next;
          });
        }
        const origin = { ...snapshotOriginRef.current };
        setSendStatus(isSteer ? "Steering…" : "Interjecting…");
        void fetch(
          buildApiPath(isSteer ? "/api/queue/steer" : "/api/queue/interject"),
          {
            method: "POST",
            credentials: "same-origin",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${authToken}`,
            },
            body: JSON.stringify({
              sessionId,
              projectId: foreground?.project?.projectId,
              queueId,
              text: typeof data.text === "string" ? data.text : "",
              displayText:
                typeof data.displayText === "string"
                  ? data.displayText
                  : undefined,
              isSlashCommand: data.isSlashCommand === true,
              slashCommandLabel:
                typeof data.slashCommandLabel === "string"
                  ? data.slashCommandLabel
                  : undefined,
              attachments: Array.isArray(data.attachments)
                ? data.attachments
                : undefined,
              images: Array.isArray(data.images) ? data.images : undefined,
              documents: Array.isArray(data.documents)
                ? data.documents
                : undefined,
            }),
          },
        )
          .then(async (response) => {
            const body = (await response.json()) as {
              ok?: boolean;
              error?: string;
              snapshot?: GatewaySnapshot;
            };
            if (body.ok && body.snapshot) {
              commitSnapshot(body.snapshot, origin.tabId, origin.generation);
            }
            clearOptimisticInterjection();
            setSendStatus(
              body.ok
                ? isSteer
                  ? "Steered."
                  : "Interjection queued."
                : `${isSteer ? "Steer" : "Interject"} failed: ${body.error ?? response.status}`,
            );
          })
          .catch((err) => {
            clearOptimisticInterjection();
            setSendStatus(
              `${isSteer ? "Steer" : "Interject"} error: ${String(err)}`,
            );
          });
        return;
      }

      if (command === "agentResolveDroppedFiles") {
        window.postMessage({
          type: "agentDroppedFilesResolved",
          files: [],
        });
      }
    },
  };

  return (
    <div class="browser-shell">
      <header class="browser-header">
        <div class="browser-title">AgentLink Remote</div>
        <div class="browser-status-group">
          <span class="browser-status">{status}</span>
          {sendStatus && (
            <span class="browser-status-detail">{sendStatus}</span>
          )}
          {modeStatus && (
            <span class="browser-status-detail">{modeStatus}</span>
          )}
        </div>
      </header>

      <div class="browser-instance-tabs" role="tablist" aria-label="Instances">
        <button
          key={BROWSER_GATEWAY_ASK_AGENT_TAB_ID}
          aria-controls="browser-instance-panel"
          aria-selected={isAskAgentSelected}
          class={`instance-tab instance-tab-idle instance-tab-pinned${isAskAgentSelected ? " active" : ""}`}
          id={`instance-tab-${BROWSER_GATEWAY_ASK_AGENT_TAB_ID}`}
          onClick={() => selectTab(BROWSER_GATEWAY_ASK_AGENT_TAB_ID)}
          role="tab"
          title="Projectless browser Ask Agent"
          type="button"
        >
          <span class="instance-tab-main">
            <i class="codicon codicon-comment-discussion" />
            <span class="instance-tab-name">
              {BROWSER_GATEWAY_ASK_AGENT_TAB_TITLE}
            </span>
          </span>
          <span class="instance-tab-status">
            <i class="codicon codicon-circle-filled" />
            <span>Ask</span>
          </span>
        </button>
        {instanceOptions.map((instance) => {
          const instanceStatus = getInstanceStatus(instance);
          const ownerSnapshot = snapshotCacheRef.current.get(
            instance.instanceId,
          )?.snapshot;
          const workspace = ownerSnapshot?.session.chatWorkspace;
          const activeInstance = instance.instanceId === selectedInstanceId;
          if (!workspace || workspace.tabs.length === 0) {
            return (
              <button
                key={instance.instanceId}
                aria-controls="browser-instance-panel"
                aria-selected={activeInstance}
                class={`instance-tab instance-tab-${instanceStatus.kind}${activeInstance ? " active" : ""}`}
                id={`instance-tab-${instance.instanceId}`}
                onClick={() => selectTab(instance.instanceId)}
                onPointerCancel={(e) =>
                  handleInstancePointerCancel(e as unknown as PointerEvent)
                }
                onPointerDown={(e) =>
                  handleInstancePointerDown(
                    e as unknown as PointerEvent,
                    instance.instanceId,
                  )
                }
                onPointerUp={(e) =>
                  handleInstancePointerUp(
                    e as unknown as PointerEvent,
                    instance.instanceId,
                  )
                }
                role="tab"
                title={`${instance.workspaceName} · ${instanceStatus.label}${instanceStatus.detail ? ` · ${instanceStatus.detail}` : ""}`}
                type="button"
              >
                <span class="instance-tab-main">
                  <i class="codicon codicon-window" />
                  <span class="instance-tab-name">
                    {instance.workspaceName}
                  </span>
                </span>
                <span class="instance-tab-status">
                  <i
                    class={`codicon codicon-${getInstanceStatusIcon(instanceStatus.kind)}${instanceStatus.kind === "working" ? " codicon-modifier-spin" : ""}`}
                  />
                  <span>{instanceStatus.label}</span>
                </span>
              </button>
            );
          }
          return (
            <section
              key={instance.instanceId}
              class={`browser-instance-group${activeInstance ? " active" : ""}`}
              role="presentation"
              style={
                {
                  "--instance-group-color": instanceGroupColor(
                    instance.instanceId,
                  ),
                } as unknown as JSX.CSSProperties
              }
            >
              <div class="browser-instance-group-label">
                <i class="codicon codicon-window" />
                <span>{instance.workspaceName}</span>
                {instance.disconnectedAt !== undefined && (
                  <i
                    aria-label="Disconnected"
                    class="codicon codicon-debug-disconnect"
                  />
                )}
              </div>
              <div class="browser-logical-tabs" role="presentation">
                {workspace.tabs.map((tab) => {
                  const selection = logicalTabSelection(
                    instance.instanceId,
                    workspace,
                    tab,
                  );
                  const active = Boolean(
                    activeInstance &&
                    selection &&
                    selectedLogicalTab &&
                    logicalTabSelectionKey(selection) ===
                      logicalTabSelectionKey(selectedLogicalTab),
                  );
                  const tabStatus = getLogicalTabStatus(tab.status);
                  return (
                    <button
                      key={tab.tabId}
                      aria-controls="browser-instance-panel"
                      aria-selected={active}
                      class={`instance-tab logical-tab instance-tab-${tabStatus.kind}${active ? " active" : ""}`}
                      disabled={!selection}
                      id={logicalTabDomId(instance.instanceId, tab.tabId)}
                      onClick={() =>
                        handleLogicalTabSelect(
                          instance.instanceId,
                          workspace,
                          tab,
                        )
                      }
                      role="tab"
                      title={`${tab.label} · ${tab.title ?? "Empty chat"} · ${tab.placement} · ${tabStatus.label}`}
                      type="button"
                    >
                      <span class="instance-tab-main">
                        <span class="logical-tab-label">{tab.label}</span>
                        <span class="instance-tab-name">
                          {tab.title ?? "Empty chat"}
                        </span>
                        {tab.placement === "popped" && (
                          <i
                            aria-label="Popped out"
                            class="codicon codicon-opened-editors"
                          />
                        )}
                      </span>
                      <span class="instance-tab-status">
                        <i
                          class={`codicon codicon-${tabStatus.kind === "idle" ? "check" : getInstanceStatusIcon(tabStatus.kind)}${tabStatus.kind === "working" ? " codicon-modifier-spin" : ""}`}
                        />
                        <span>{tabStatus.label}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>

      {/** Shared sendability rule: text or other attached content. */}

      <main
        ref={browserLayoutRef}
        aria-labelledby={
          selectedLogicalTab
            ? logicalTabDomId(
                selectedLogicalTab.instanceId,
                selectedLogicalTab.tabId,
              )
            : `instance-tab-${selectedTabId}`
        }
        class={`browser-layout${sidePaneResizing ? " browser-layout-resizing" : ""}${isAskAgentSelected ? " browser-layout-chat-only" : ""}`}
        id="browser-instance-panel"
        role="tabpanel"
        style={
          {
            "--browser-side-width": `${sidePanePercent}%`,
          } as unknown as JSX.CSSProperties
        }
      >
        {!isAskAgentSelected && (
          <>
            <section class="browser-side browser-side-top">
              <PaneCard fill className="review-pane-card">
                <div class="pane-body review-pane-body">
                  {mobileLayout ? null : reviewPaneContent}
                </div>
              </PaneCard>
            </section>

            <div
              aria-label="Resize chat and review panes"
              aria-orientation="vertical"
              aria-valuemax={MAX_SIDE_PANE_PERCENT}
              aria-valuemin={MIN_SIDE_PANE_PERCENT}
              aria-valuenow={Math.round(sidePanePercent)}
              class="browser-column-resize-handle"
              onKeyDown={(e) =>
                handleSidePaneResizeKeyDown(e as unknown as KeyboardEvent)
              }
              onMouseDown={(e) =>
                handleSidePaneResizeStart(e as unknown as MouseEvent)
              }
              role="separator"
              tabIndex={0}
              title="Drag to resize chat and review panes"
            />
          </>
        )}

        <section class="browser-main">
          <PaneCard fill className="chat-pane-card">
            <div class="pane-body browser-chat-pane chat-container">
              {transcriptView?.visible && (
                <TranscriptView
                  task={transcriptView.task}
                  sessionId={transcriptView.sessionId}
                  messages={transcriptView.messages}
                  streaming={background.some(
                    (session) =>
                      session.id === transcriptView.sessionId &&
                      (session.status === "streaming" ||
                        session.status === "tool_executing" ||
                        session.status === "awaiting_approval"),
                  )}
                  runtimeStatus={background.find(
                    (session) => session.id === transcriptView.sessionId,
                  )}
                  onClose={() =>
                    setTranscriptView((current) =>
                      current ? { ...current, visible: false } : current,
                    )
                  }
                />
              )}
              <ChatHeader
                restoringSession={foreground?.restoringSession}
                showHistory={showHistory}
                onNewSession={handleNewSession}
                onShowHistory={handleShowHistory}
                extraActions={
                  isAskAgentSelected && (
                    <>
                      <button
                        class={`icon-button${showAskAgentMemory ? " active" : ""}`}
                        onClick={handleShowAskAgentMemory}
                        title="Ask Agent Memory"
                        type="button"
                      >
                        <i class="codicon codicon-archive" />
                        {askAgentMemory &&
                          askAgentMemory.totalSummaryCount > 0 && (
                            <span class="memory-count-badge">
                              {askAgentMemory.totalSummaryCount}
                            </span>
                          )}
                      </button>
                      <button
                        class={`icon-button${showAskAgentReadGrants ? " active" : ""}`}
                        onClick={() =>
                          setShowAskAgentReadGrants((value) => !value)
                        }
                        title="Read-only local file grants"
                        type="button"
                      >
                        <i class="codicon codicon-folder-opened" />
                        {askAgentReadGrants.length > 0 && (
                          <span class="memory-count-badge">
                            {askAgentReadGrants.length}
                          </span>
                        )}
                      </button>
                      <button
                        class={`icon-button${showAskAgentHandoff ? " active" : ""}`}
                        onClick={() => {
                          setShowAskAgentHandoff((value) => !value);
                          if (!askAgentHandoffTargetId) {
                            setAskAgentHandoffTargetId(
                              askAgentHandoffTargets[0]?.instanceId ?? "",
                            );
                          }
                        }}
                        title="Handoff to VS Code project session"
                        type="button"
                      >
                        <i class="codicon codicon-git-pull-request-go-to-changes" />
                      </button>
                    </>
                  )
                }
              />
              {showAskAgentMemory && (
                <section
                  aria-label="Ask Agent derived memory"
                  class="ask-agent-memory-panel"
                >
                  <div class="ask-agent-memory-panel-header">
                    <div>
                      <strong>Derived Ask Agent memory</strong>
                      <span>
                        Local summaries used for recall. Raw transcripts and
                        durable memory are separate.
                      </span>
                    </div>
                    <button
                      class="icon-button"
                      onClick={() => {
                        setShowAskAgentMemory(false);
                        setAskAgentMemoryClearConfirmation("idle");
                      }}
                      title="Close Ask Agent memory"
                      type="button"
                    >
                      <i class="codicon codicon-close" />
                    </button>
                  </div>
                  {askAgentMemoryError && (
                    <div class="session-history-error" role="alert">
                      <i class="codicon codicon-warning" />
                      <span>{askAgentMemoryError}</span>
                    </div>
                  )}
                  <div class="ask-agent-memory-stats" role="status">
                    <div>
                      <span>Session summaries</span>
                      <strong>
                        {askAgentMemory?.sessionSummaryCount ?? "—"}
                      </strong>
                    </div>
                    <div>
                      <span>Turn summaries</span>
                      <strong>
                        {askAgentMemory?.chunkSummaryCount ?? "—"}
                      </strong>
                    </div>
                    <div>
                      <span>Last updated</span>
                      <strong>
                        {askAgentMemory?.lastUpdatedAt
                          ? formatTimestamp(askAgentMemory.lastUpdatedAt)
                          : "Never"}
                      </strong>
                    </div>
                  </div>
                  {askAgentMemory?.recentSessions.length ? (
                    <div class="ask-agent-memory-recent">
                      <span class="review-section-label">Recent summaries</span>
                      <ul>
                        {askAgentMemory.recentSessions.map((session) => (
                          <li key={session.sessionId}>
                            <span>{session.title}</span>
                            <small>
                              {session.messageCount} messages ·{" "}
                              {formatTimestamp(session.updatedAt)}
                            </small>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : (
                    <p class="ask-agent-memory-empty">
                      No derived memory summaries yet.
                    </p>
                  )}
                  <div class="ask-agent-memory-actions">
                    <button
                      class="secondary"
                      disabled={askAgentMemoryPending}
                      onClick={() => void fetchAskAgentMemory()}
                      type="button"
                    >
                      Refresh
                    </button>
                    {askAgentMemoryClearConfirmation === "confirming" ? (
                      <>
                        <span role="status">
                          Clear derived summaries only? Raw transcripts and
                          durable memory will remain.
                        </span>
                        <button
                          disabled={askAgentMemoryPending}
                          onClick={() => void clearAskAgentMemory()}
                          type="button"
                        >
                          Confirm clear
                        </button>
                        <button
                          class="secondary"
                          disabled={askAgentMemoryPending}
                          onClick={() =>
                            setAskAgentMemoryClearConfirmation("idle")
                          }
                          type="button"
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button
                        class="secondary"
                        disabled={
                          askAgentMemoryPending ||
                          (askAgentMemory?.totalSummaryCount ?? 0) === 0
                        }
                        onClick={() =>
                          setAskAgentMemoryClearConfirmation("confirming")
                        }
                        type="button"
                      >
                        Clear summaries…
                      </button>
                    )}
                  </div>
                </section>
              )}
              {showAskAgentReadGrants && isAskAgentSelected && (
                <section
                  aria-label="Ask Agent read-only local grants"
                  class="ask-agent-memory-panel ask-agent-read-grants-panel"
                >
                  <div class="ask-agent-memory-panel-header">
                    <div>
                      <strong>Read-only local file access</strong>
                      <span>
                        Grant exact local files or directories for Ask Agent
                        read/list/search tools. No write, shell, editor, or MCP
                        access is enabled.
                      </span>
                    </div>
                    <button
                      class="icon-button"
                      onClick={() => setShowAskAgentReadGrants(false)}
                      title="Close read grants"
                      type="button"
                    >
                      <i class="codicon codicon-close" />
                    </button>
                  </div>
                  <label class="ask-agent-handoff-field">
                    <span>Local path to grant</span>
                    <input
                      type="text"
                      value={askAgentReadGrantPath}
                      onInput={(event) =>
                        setAskAgentReadGrantPath(
                          (event.target as HTMLInputElement).value,
                        )
                      }
                      placeholder="/Users/name/project or /Users/name/file.md"
                    />
                  </label>
                  <div class="ask-agent-memory-actions">
                    <button
                      disabled={askAgentReadGrantPending}
                      onClick={() => void addAskAgentReadGrant()}
                      type="button"
                    >
                      Confirm read grant
                    </button>
                  </div>
                  {askAgentReadGrants.length > 0 ? (
                    <ul class="ask-agent-read-grants-list">
                      {askAgentReadGrants.map((grant) => (
                        <li key={grant.id}>
                          <div>
                            <strong>{grant.label}</strong>
                            <span>
                              {grant.kind} · {grant.rootPath}
                            </span>
                          </div>
                          <button
                            class="secondary"
                            disabled={askAgentReadGrantPending}
                            onClick={() =>
                              void revokeAskAgentReadGrant(grant.id)
                            }
                            type="button"
                          >
                            Revoke
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p class="ask-agent-memory-empty">
                      No local paths have been granted to Ask Agent.
                    </p>
                  )}
                </section>
              )}
              {showAskAgentHandoff && isAskAgentSelected && (
                <section
                  aria-label="Project session handoff"
                  class="ask-agent-memory-panel ask-agent-handoff-panel"
                >
                  <div class="ask-agent-memory-panel-header">
                    <div>
                      <strong>Handoff to a VS Code project session</strong>
                      <span>
                        Preview an instruction, then explicitly approve
                        launching it in a selected VS Code window.
                      </span>
                    </div>
                    <button
                      class="icon-button"
                      onClick={() => setShowAskAgentHandoff(false)}
                      title="Close project handoff"
                      type="button"
                    >
                      <i class="codicon codicon-close" />
                    </button>
                  </div>
                  {askAgentHandoffTargets.length === 0 ? (
                    <p class="ask-agent-memory-empty">
                      Open an AgentLink VS Code window to hand off into a
                      project session.
                    </p>
                  ) : (
                    <>
                      <label class="ask-agent-handoff-field">
                        <span>Target window</span>
                        <select
                          value={
                            askAgentHandoffTargetId ||
                            askAgentHandoffTargets[0]?.instanceId ||
                            ""
                          }
                          onChange={(event) =>
                            setAskAgentHandoffTargetId(
                              (event.target as HTMLSelectElement).value,
                            )
                          }
                        >
                          {askAgentHandoffTargets.map((instance) => (
                            <option
                              key={instance.instanceId}
                              value={instance.instanceId}
                            >
                              {instance.workspaceName || "No Workspace"} —{" "}
                              {instance.workspacePath}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label class="ask-agent-handoff-field">
                        <span>Mode</span>
                        <select
                          value={askAgentHandoffMode}
                          onChange={(event) =>
                            setAskAgentHandoffMode(
                              (event.target as HTMLSelectElement).value,
                            )
                          }
                        >
                          <option value="code">Code</option>
                          <option value="architect">Architect</option>
                          <option value="ask">Ask</option>
                          <option value="debug">Debug</option>
                        </select>
                      </label>
                      <label class="ask-agent-handoff-field">
                        <span>Initial instruction</span>
                        <textarea
                          rows={4}
                          value={askAgentHandoffInstruction}
                          onInput={(event) =>
                            setAskAgentHandoffInstruction(
                              (event.target as HTMLTextAreaElement).value,
                            )
                          }
                          placeholder="Describe what the project session should do…"
                        />
                      </label>
                      <div class="ask-agent-memory-actions">
                        <button
                          disabled={askAgentHandoffPending}
                          onClick={() => void proposeAskAgentProjectHandoff()}
                          type="button"
                        >
                          Create handoff preview
                        </button>
                        <button
                          class="secondary"
                          disabled={askAgentHandoffPending}
                          onClick={() => setShowAskAgentHandoff(false)}
                          type="button"
                        >
                          Cancel
                        </button>
                      </div>
                    </>
                  )}
                </section>
              )}
              {showHistory && (
                <>
                  {sessionHistoryError && (
                    <div class="session-history-error" role="alert">
                      <i class="codicon codicon-warning" />
                      <span>{sessionHistoryError}</span>
                    </div>
                  )}
                  <SessionHistory
                    sessions={sessionHistory}
                    currentSessionId={foreground?.sessionId ?? null}
                    onLoad={handleLoadSession}
                    onDelete={handleDeleteSession}
                    onRename={handleRenameSession}
                    onCopyFirstPrompt={handleCopyFirstPrompt}
                    onClose={() => setShowHistory(false)}
                  />
                </>
              )}
              {foreground?.revertRecoveryNotice && (
                <div class="revert-recovery-notice" role="alert">
                  <i class="codicon codicon-warning" />
                  <div>
                    <strong>{foreground.revertRecoveryNotice.title}</strong>
                    <span>{foreground.revertRecoveryNotice.message}</span>
                  </div>
                </div>
              )}
              {foreground?.debugInfo && (
                <DebugInfo
                  info={foreground.debugInfo}
                  systemPrompt={foreground.systemPrompt}
                  loadedInstructions={
                    foreground.loadedInstructions ?? undefined
                  }
                />
              )}
              {askAgentMemoryCandidateNudge && (
                <div
                  class="ask-agent-memory-candidate-nudge"
                  role="status"
                  aria-label="Durable memory suggestion"
                >
                  <i class="codicon codicon-lightbulb" />
                  <div>
                    <strong>Possible durable memory</strong>
                    <span>
                      Ask Agent noticed a possible{" "}
                      {askAgentMemoryCandidateNudge.kind}. Review creates an
                      approval card; nothing is saved unless you accept it.
                    </span>
                    <code>{askAgentMemoryCandidateNudge.matchedPhrase}</code>
                    <div class="ask-agent-memory-candidate-actions">
                      <button
                        type="button"
                        onClick={() =>
                          void proposeAskAgentMemoryCandidate(
                            askAgentMemoryCandidateNudge,
                          )
                        }
                      >
                        Review memory proposal
                      </button>
                      <button
                        class="secondary"
                        type="button"
                        onClick={() =>
                          void dismissAskAgentMemoryCandidate(
                            askAgentMemoryCandidateNudge,
                          )
                        }
                      >
                        Dismiss
                      </button>
                    </div>
                  </div>
                </div>
              )}
              {askAgentProjectHandoff &&
                askAgentProjectHandoff.status !== "cancelled" && (
                  <div
                    class={`ask-agent-memory-candidate-nudge ask-agent-handoff-card ask-agent-handoff-card-${askAgentProjectHandoff.status}`}
                    role="status"
                    aria-label="Project session handoff preview"
                  >
                    <i class="codicon codicon-git-pull-request-go-to-changes" />
                    <div>
                      <strong>Project session handoff</strong>
                      <span>
                        {askAgentProjectHandoff.status === "completed"
                          ? "Launched in the selected VS Code project window."
                          : askAgentProjectHandoff.status === "failed"
                            ? "Launch failed. Review the error before retrying."
                            : "Review this handoff before launching it in VS Code."}
                      </span>
                      <dl class="ask-agent-handoff-details">
                        <dt>Target</dt>
                        <dd>
                          {askAgentProjectHandoff.targetWorkspaceName ||
                            "No Workspace"}
                        </dd>
                        <dt>Path</dt>
                        <dd>{askAgentProjectHandoff.targetWorkspacePath}</dd>
                        <dt>Mode</dt>
                        <dd>{askAgentProjectHandoff.mode}</dd>
                      </dl>
                      <pre>{askAgentProjectHandoff.instruction}</pre>
                      {askAgentProjectHandoff.error && (
                        <div class="session-history-error" role="alert">
                          <i class="codicon codicon-warning" />
                          <span>{askAgentProjectHandoff.error}</span>
                        </div>
                      )}
                      {askAgentProjectHandoff.status === "pending" && (
                        <div class="ask-agent-memory-candidate-actions">
                          <button
                            disabled={askAgentHandoffPending}
                            type="button"
                            onClick={() =>
                              void approveAskAgentProjectHandoff(
                                askAgentProjectHandoff.id,
                              )
                            }
                          >
                            Approve and launch
                          </button>
                          <button
                            class="secondary"
                            disabled={askAgentHandoffPending}
                            type="button"
                            onClick={() =>
                              void cancelAskAgentProjectHandoff(
                                askAgentProjectHandoff.id,
                              )
                            }
                          >
                            Cancel
                          </button>
                        </div>
                      )}
                      {askAgentProjectHandoff.status === "launching" && (
                        <span role="status">Launching…</span>
                      )}
                    </div>
                  </div>
                )}
              {askAgentStatusNotice && (
                <div
                  class={`ask-agent-status-notice ask-agent-status-notice-${askAgentStatusNotice.kind}`}
                  role={
                    askAgentStatusNotice.kind === "warning" ? "alert" : "status"
                  }
                >
                  <i
                    class={`codicon codicon-${askAgentStatusNotice.kind === "warning" ? "warning" : "info"}`}
                  />
                  <div>
                    <strong>{askAgentStatusNotice.title}</strong>
                    <span>{askAgentStatusNotice.message}</span>
                  </div>
                </div>
              )}
              {mobileReviewOpen && (
                <div class="mobile-secondary-pane">
                  <PaneCard fill className="mobile-secondary-card">
                    <PaneHeader
                      title="Review"
                      right={
                        <button
                          class="icon-button"
                          onClick={() => setMobilePane(null)}
                          title="Close review"
                          type="button"
                        >
                          <i class="codicon codicon-close" />
                        </button>
                      }
                    />
                    <div class="pane-body review-pane-body">
                      {reviewPaneContent}
                    </div>
                  </PaneCard>
                </div>
              )}
              <div
                class={`browser-transcript${mobileReviewOpen ? " mobile-hidden-while-review" : ""}`}
              >
                {snapshot === null ? (
                  <EmptyState>
                    {isAskAgentSelected
                      ? "Loading Ask Agent session…"
                      : "Loading session…"}
                  </EmptyState>
                ) : (
                  <ChatView
                    key={`${snapshotOriginRef.current.tabId}:${foreground?.sessionId ?? "empty"}`}
                    messages={messages}
                    streaming={Boolean(streaming)}
                    initialMessageLimit={
                      mobileLayout || touchInput ? 20 : undefined
                    }
                    sessionId={foreground?.sessionId ?? null}
                    originalPrompt={foreground?.originalPrompt}
                    detectedQuestion={foreground?.detectedQuestion ?? null}
                    onDetectedQuestionAnswer={(payload) => {
                      void handleSend(payload, []);
                    }}
                    onDismissDetectedQuestion={() => undefined}
                    onOpenFile={
                      isAskAgentSelected
                        ? undefined
                        : (filePath, line) =>
                            browserVscodeApi.postMessage({
                              command: "agentOpenFile",
                              path: filePath,
                              line,
                            })
                    }
                    onRetry={handleRetry}
                    onSignIn={() => handleSignIn("codex")}
                    onSignInAnotherAccount={() =>
                      setModeStatus(
                        "Use VS Code account controls to sign in with another account.",
                      )
                    }
                    onCondense={handleCondense}
                    bgSessions={background}
                    onStopBackground={handleStopBackground}
                    onOpenTranscript={handleOpenBgTranscript}
                    onFinalMarkerContinue={(prompt) => {
                      const continuedMessageIds = messages.flatMap(
                        (message) => {
                          if (
                            message.role !== "assistant" ||
                            !message.finalMarker
                          ) {
                            return [];
                          }
                          return getFinalMessageContinueAction(
                            message.finalMarker,
                          )?.prompt === prompt
                            ? [message.id]
                            : [];
                        },
                      );
                      void handleSend(
                        prompt,
                        [],
                        undefined,
                        undefined,
                        undefined,
                        "user",
                        foreground ?? undefined,
                      ).then((sent) => {
                        if (!sent) return;
                        setHiddenFinalContinueMessageIds((prev) => {
                          const next = new Set(prev);
                          for (const id of continuedMessageIds) {
                            next.add(id);
                          }
                          return next;
                        });
                      });
                    }}
                    onRevertCheckpoint={handleRevertCheckpoint}
                    onViewCheckpointDiff={handleViewCheckpointDiff}
                    streamingMetrics={streamingBaselineMetrics}
                    streamingMetricsSurface="browser-webview"
                    streamingMetricsScope={`${snapshotOriginRef.current.tabId}:${foreground?.sessionId ?? "foreground"}`}
                  />
                )}
              </div>
              <ChatActivityShelf
                revealKey={visibleApproval?.id ?? null}
                revealMinHeight={approvalPanelHeight + 10}
              >
                {!isAskAgentSelected &&
                  foreground &&
                  foreground.messageQueue.length > 0 &&
                  !mobileReviewOpen && (
                    <MessageQueuePanel
                      queue={foreground.messageQueue.map((item) =>
                        optimisticQueueInterjections.has(
                          `${foreground.sessionId}:${item.id}`,
                        )
                          ? { ...item, interjectionReady: true }
                          : item,
                      )}
                      onSteer={(item) => {
                        browserVscodeApi.postMessage({
                          command: "agentSteerQueuedMessage",
                          sessionId: foreground.sessionId,
                          queueId: item.id,
                          text: item.fullText ?? item.text,
                          displayText: item.text,
                          isSlashCommand: item.isSlashCommand === true,
                          slashCommandLabel: item.slashCommandLabel,
                          attachments: item.attachments,
                          images: item.images,
                          documents: item.documents,
                        });
                      }}
                      onInterject={(item) => {
                        browserVscodeApi.postMessage({
                          command: "agentInterjectQueuedMessage",
                          sessionId: foreground.sessionId,
                          queueId: item.id,
                          text: item.fullText ?? item.text,
                          displayText: item.text,
                          isSlashCommand: item.isSlashCommand === true,
                          slashCommandLabel: item.slashCommandLabel,
                          attachments: item.attachments,
                          images: item.images,
                          documents: item.documents,
                        });
                      }}
                    />
                  )}
                {!isAskAgentSelected && !mobileReviewOpen && foreground && (
                  <ContextUsageRow
                    inputTokens={foreground.lastInputTokens}
                    outputTokens={foreground.lastOutputTokens}
                    cacheReadTokens={foreground.lastCacheReadTokens}
                    estimatedTotalUsed={foreground.estimatedTotalUsed}
                    models={composerModels}
                    modelId={foreground.model}
                    contextBudget={foreground.contextBudget}
                    condenseThreshold={foreground.condenseThreshold}
                    defaultMaxTokens={DEFAULT_MAX_TOKENS}
                    className="browser-context-row"
                  />
                )}
                {!mobileReviewOpen &&
                  showMcpStatus &&
                  (mcpManagerSnapshot ||
                    (!isAskAgentSelected && snapshot?.ui.mcpStatusInfos)) &&
                  (() => {
                    const renderedMcpSnapshot =
                      mcpManagerSnapshot ??
                      ({
                        profile: "main",
                        version: 0,
                        sources: [],
                        entries: [],
                        statusInfos: snapshot?.ui.mcpStatusInfos ?? [],
                        capabilities: {
                          canEditConfig: false,
                          canOpenRawConfig: false,
                          canReconnect: true,
                          canReauthenticate: true,
                          canDisable: false,
                          canUseProjectConfig: true,
                        },
                      } satisfies McpConfigSnapshot);
                    const panelSnapshot = isAskAgentSelected
                      ? ({
                          ...renderedMcpSnapshot,
                          capabilities: {
                            ...renderedMcpSnapshot.capabilities,
                            canOpenRawConfig: false,
                          },
                        } satisfies McpConfigSnapshot)
                      : renderedMcpSnapshot;
                    return (
                      <LazyMcpManagerPanel
                        snapshot={panelSnapshot}
                        initialView={mcpManagerView}
                        error={
                          askAgentMcpStatusError === "mcp_host_unavailable"
                            ? "No VS Code MCP host is available for Ask Agent."
                            : askAgentMcpStatusError
                        }
                        onClose={() => setShowMcpStatus(false)}
                        onRefresh={() => {
                          if (isAskAgentSelected) {
                            void refreshAskAgentMcpStatus({ reconnect: true });
                          } else {
                            void refreshWorkspaceMcpStatus(
                              panelSnapshot.project?.projectId,
                              mcpManagerView,
                            );
                          }
                        }}
                        onSelectProject={(projectId) => {
                          if (!isAskAgentSelected) {
                            void refreshWorkspaceMcpStatus(
                              projectId,
                              mcpManagerView,
                            );
                          }
                        }}
                        onServerAction={(serverName, action) => {
                          if (isAskAgentSelected) {
                            if (
                              action === "reconnect" ||
                              action === "reauthenticate"
                            ) {
                              void refreshAskAgentMcpStatus({
                                reconnect: true,
                              });
                            }
                          } else {
                            handleMcpAction(
                              serverName,
                              action,
                              panelSnapshot.project?.projectId,
                            );
                          }
                        }}
                        onOpenRawConfig={(scope) => {
                          if (isAskAgentSelected) {
                            void openAskAgentRawMcpConfig(scope);
                          }
                        }}
                        onMutateConfig={
                          isAskAgentSelected
                            ? (mutation) => mutateAskAgentMcpConfig(mutation)
                            : undefined
                        }
                        onSaveServer={(scope, server) => {
                          if (isAskAgentSelected) {
                            void saveAskAgentMcpServer(scope, server);
                          }
                        }}
                        onRemoveServer={(scope, serverName) => {
                          if (isAskAgentSelected) {
                            void removeAskAgentMcpServer(scope, serverName);
                          }
                        }}
                      />
                    );
                  })()}
                {!mobileReviewOpen && (foreground?.todos?.length ?? 0) > 0 && (
                  <TodoPanel todos={foreground?.todos ?? []} />
                )}
                {!isAskAgentSelected &&
                  pendingFormElicitation &&
                  !mobileReviewOpen &&
                  (() => {
                    const originTabId = snapshotOriginRef.current.tabId;
                    return (
                      <FormElicitationPanel
                        key={`${originTabId}:${pendingFormElicitation.id}`}
                        request={pendingFormElicitation}
                        onRespond={async (response) => {
                          const result = await fetch(
                            buildApiPathForTab(
                              "/api/form-elicitation",
                              originTabId,
                            ),
                            {
                              method: "POST",
                              headers: {
                                "Content-Type": "application/json",
                                Authorization: `Bearer ${authToken}`,
                              },
                              body: JSON.stringify(response),
                            },
                          );
                          const body = (await result
                            .json()
                            .catch(() => ({}))) as {
                            ok?: boolean;
                            errors?: McpElicitationFieldErrors;
                          };
                          if (result.ok && body.ok === true)
                            return { ok: true };
                          return {
                            ok: false,
                            errors: body.errors,
                            error:
                              result.status === 404
                                ? "This request is no longer active."
                                : "The response could not be submitted.",
                          };
                        }}
                      />
                    );
                  })()}
                {!isAskAgentSelected &&
                  pendingUrlElicitation &&
                  !mobileReviewOpen && (
                    <UrlElicitationPanel
                      request={pendingUrlElicitation}
                      onAccept={(id, url) => {
                        window.open(url, "_blank", "noopener,noreferrer");
                        browserVscodeApi.postMessage({
                          command: "agentUrlElicitationResponse",
                          id,
                          action: "accept",
                          originTabId: snapshotOriginRef.current.tabId,
                        });
                      }}
                      onDecline={(id) => {
                        browserVscodeApi.postMessage({
                          command: "agentUrlElicitationResponse",
                          id,
                          action: "decline",
                          originTabId: snapshotOriginRef.current.tabId,
                        });
                      }}
                      onCancel={(id) => {
                        browserVscodeApi.postMessage({
                          command: "agentUrlElicitationResponse",
                          id,
                          action: "cancel",
                          originTabId: snapshotOriginRef.current.tabId,
                        });
                      }}
                    />
                  )}
                {visibleQuestion && !mobileReviewOpen && (
                  <QuestionCard
                    key={`${snapshotOriginRef.current.tabId}:${visibleQuestion.id}`}
                    id={visibleQuestion.id}
                    context={visibleQuestion.context}
                    questions={visibleQuestion.questions}
                    backgroundTask={visibleQuestion.backgroundTask}
                    modes={modes}
                    attachmentCounts={Object.fromEntries(
                      Object.entries(questionAttachments).map(
                        ([questionId, value]) => [
                          questionId,
                          value.paths.length + value.media.length,
                        ],
                      ),
                    )}
                    onEditOtherContext={setQuestionContextMode}
                    remoteProgress={
                      remoteQuestionProgress &&
                      remoteQuestionProgress.id === visibleQuestion.id
                        ? {
                            step: remoteQuestionProgress.step,
                            answers: remoteQuestionProgress.answers,
                            notes: remoteQuestionProgress.notes,
                          }
                        : null
                    }
                    onProgressChange={(progress) => {
                      browserVscodeApi.postMessage({
                        command: "agentQuestionProgress",
                        id: visibleQuestion.id,
                        step: progress.step,
                        answers: progress.answers,
                        notes: progress.notes,
                        origin: questionProgressOriginRef.current,
                        originTabId: snapshotOriginRef.current.tabId,
                      });
                    }}
                    onSubmit={(id, answers, notes) => {
                      const attachments = Object.fromEntries(
                        Object.entries(questionAttachments).flatMap(
                          ([questionId, value]) => {
                            const items = [
                              ...value.paths.map((path) => ({
                                kind: "file" as const,
                                name: path.split(/[\\/]/).pop() || path,
                                path,
                              })),
                              ...value.media.map((media) => ({
                                kind: media.kind,
                                name: media.name,
                                mimeType: media.mimeType,
                                base64: media.base64,
                              })),
                            ];
                            return items.length > 0
                              ? [[questionId, items]]
                              : [];
                          },
                        ),
                      );
                      setLocalDismissedQuestionId(id);
                      setQuestionContextMode(null);
                      setQuestionAttachments({});
                      browserVscodeApi.postMessage({
                        command: "agentQuestionResponse",
                        id,
                        answers,
                        notes,
                        attachments,
                        originTabId: snapshotOriginRef.current.tabId,
                      });
                    }}
                  />
                )}
                {visibleApproval && (
                  <ApprovalPanelEmbed
                    key={`${snapshotOriginRef.current.tabId}:${visibleApproval.id}`}
                    request={visibleApproval}
                    height={approvalPanelHeight}
                    resizing={approvalResizing}
                    followUpRef={forwardedFollowUpRef}
                    submit={handleForwardedApprovalSubmit}
                    onResizeStart={handleApprovalResizeStart}
                    onSuggestRegex={handleSuggestRegex}
                    actions={
                      canOpenMobileReview && (
                        <div class="approval-mobile-review-actions">
                          <button
                            class={`secondary mobile-review-button${mobileReviewOpen ? " active" : ""}`}
                            aria-expanded={mobileReviewOpen}
                            onClick={() =>
                              setMobilePane((current) =>
                                current === "review" ? null : "review",
                              )
                            }
                            type="button"
                          >
                            <i
                              class={`codicon ${mobileReviewOpen ? "codicon-comment-discussion" : "codicon-diff"}`}
                            />
                            <span>
                              {mobileReviewOpen ? "Back to chat" : "View diff"}
                            </span>
                          </button>
                        </div>
                      )
                    }
                  />
                )}
                {!isAskAgentSelected &&
                  foreground?.interrupted &&
                  !streaming &&
                  !mobileReviewOpen && (
                    <div class="interrupted-session-banner">
                      <i class="codicon codicon-debug-restart" />
                      <div>
                        <strong>Session interrupted</strong>
                        <span>
                          The previous agent turn stopped before it finished.
                          Resume to let the agent inspect current state and
                          continue safely.
                        </span>
                      </div>
                      <button
                        type="button"
                        class="interrupted-session-resume"
                        onClick={handleResumeInterruptedSession}
                        title="Resume interrupted session"
                      >
                        Resume
                      </button>
                    </div>
                  )}
                {streaming && !mobileReviewOpen ? (
                  <StreamingStatusBar
                    messages={messages}
                    statusOverride={statusOverride}
                    className="browser-streaming-row"
                  />
                ) : null}
                {!isAskAgentSelected && !mobileReviewOpen && (
                  <BackgroundSessionStrip
                    key={foreground?.sessionId ?? selectedTabId}
                    sessions={background}
                    showFleetRequest={showFleetRequest}
                    onStop={handleStopBackground}
                    onOpenTranscript={handleOpenBgTranscript}
                    onSteer={(sessionId, message) =>
                      handleBackgroundAction("steer", sessionId, message)
                    }
                    onDetach={(sessionId) =>
                      handleBackgroundAction("detach", sessionId)
                    }
                    onRetry={(sessionId) =>
                      handleBackgroundAction("retry", sessionId)
                    }
                    onArchive={(sessionId) =>
                      handleBackgroundAction("archive", sessionId)
                    }
                    onPause={(sessionId) =>
                      handleBackgroundAction("pause", sessionId)
                    }
                    onResume={(sessionId) =>
                      handleBackgroundAction("resume", sessionId)
                    }
                  />
                )}
              </ChatActivityShelf>
              {!mobileReviewOpen && (
                <div class="browser-chat-composer">
                  <InputArea
                    onSend={handleSend}
                    contextMode={
                      questionContextMode
                        ? ({
                            key: `${visibleQuestion?.id ?? "question"}:${questionContextMode.questionId}`,
                            title: "Adding context to agent question",
                            placeholder:
                              "Add details, paste a screenshot, or attach supporting files…",
                            initialText: questionContextMode.initialText,
                            initialAttachments:
                              questionAttachments[
                                questionContextMode.questionId
                              ]?.paths,
                            initialMedia:
                              questionAttachments[
                                questionContextMode.questionId
                              ]?.media,
                            onSubmit: (
                              text,
                              paths,
                              _displayText,
                              _slashLabel,
                              media,
                            ) => {
                              questionContextMode.onCommit(text);
                              setQuestionAttachments((current) => ({
                                ...current,
                                [questionContextMode.questionId]: {
                                  paths,
                                  media: media ?? [],
                                },
                              }));
                              setQuestionContextMode(null);
                            },
                            onCancel: () => setQuestionContextMode(null),
                          } satisfies ComposerContextMode)
                        : null
                    }
                    onInterject={
                      isAskAgentSelected ? undefined : handleInterject
                    }
                    onPolishPrompt={
                      isAskAgentSelected ? undefined : handlePolishPrompt
                    }
                    onComposerEvent={
                      isAskAgentSelected
                        ? (event, fields) =>
                            logAskAgentBrowserEvent(`composer.${event}`, fields)
                        : undefined
                    }
                    onStop={handleStop}
                    streaming={Boolean(streaming)}
                    submitOnEnter={!mobileLayout && !touchInput}
                    reasoningEffort={effectiveReasoningEffort}
                    onSetReasoningEffort={handleSetReasoningEffort}
                    onExportTranscript={handleExportTranscript}
                    hasMessages={messages.length > 0}
                    vscodeApi={browserVscodeApi}
                    injection={null}
                    onInjectionConsumed={() => undefined}
                    slashCommands={slashCommands}
                    onExecuteBuiltinCommand={
                      isAskAgentSelected
                        ? handleAskAgentExecuteBuiltinCommand
                        : handleExecuteBuiltinCommand
                    }
                    modes={isAskAgentSelected ? [] : composerModes}
                    currentMode={foreground?.mode ?? "ask"}
                    currentModel={foreground?.model ?? "ask-agent-unavailable"}
                    currentCondenseThreshold={foreground?.condenseThreshold}
                    availableModels={composerModels}
                    onSwitchMode={
                      isAskAgentSelected ? undefined : handleSwitchMode
                    }
                    onSelectModel={handleSelectModel}
                    onSetCondenseThreshold={
                      isAskAgentSelected
                        ? undefined
                        : handleSetCondenseThreshold
                    }
                    onSignIn={isAskAgentSelected ? undefined : handleSignIn}
                    agentWriteApproval={
                      isAskAgentSelected
                        ? undefined
                        : (foreground?.agentWriteApproval ?? "prompt")
                    }
                    onSetAgentWriteApproval={
                      isAskAgentSelected ? undefined : handleSetWriteApproval
                    }
                    commandApprovalPolicy={
                      isAskAgentSelected
                        ? undefined
                        : (foreground?.commandApprovalPolicy ?? "safe")
                    }
                    configuredCommandApprovalPolicy={
                      isAskAgentSelected
                        ? undefined
                        : (foreground?.configuredCommandApprovalPolicy ??
                          "safe")
                    }
                    onSetCommandApprovalPolicy={
                      isAskAgentSelected
                        ? undefined
                        : handleSetCommandApprovalPolicy
                    }
                    autoContinueEnabled={
                      isAskAgentSelected ? false : autoContinueEnabled
                    }
                    onToggleAutoContinue={
                      isAskAgentSelected ? undefined : handleToggleAutoContinue
                    }
                    autoContinueStatus={
                      isAskAgentSelected ? "" : autoContinueStatus
                    }
                    allowAttachments={!isAskAgentSelected}
                    allowMediaPaste={true}
                    allowThinkingToggle={true}
                    allowExportTranscript={isAskAgentSelected}
                    allowFileMentions={!isAskAgentSelected}
                    disabled={
                      !isAskAgentSelected &&
                      ((snapshot?.session.projects?.length ?? 0) === 0 ||
                        foreground?.project?.availability === "unavailable")
                    }
                    disabledReason={
                      !isAskAgentSelected &&
                      (snapshot?.session.projects?.length ?? 0) === 0
                        ? "Open a folder to enable local execution."
                        : !isAskAgentSelected &&
                            foreground?.project?.availability === "unavailable"
                          ? `Project unavailable: ${foreground.project.displayName}`
                          : undefined
                    }
                  />
                </div>
              )}
            </div>
          </PaneCard>
        </section>
      </main>
    </div>
  );
}
