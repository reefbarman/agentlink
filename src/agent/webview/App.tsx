import {
  AUTO_CONTINUE_NO_PROGRESS_REASON,
  turnMadeProgress,
} from "../../shared/autoContinueProgress.js";
import type {
  ApprovalRequest,
  DecisionMessage,
} from "../../approvals/webview/types";
import type {
  ChatMessage,
  ReasoningEffort,
  SessionSummary,
  TodoItem,
  WorktreeSetupState,
} from "./types";
import type {
  McpConfigBatchMutation,
  McpConfigMutationResult,
  McpConfigSnapshot,
  McpManagerScope,
} from "../../shared/mcpManagerTypes";
import type { AgentPluginManagerSnapshot } from "../../shared/agentPluginManagerTypes";
import {
  agentMessagesToChatMessages,
  initialState,
  reducer,
  shouldAcceptSessionChunk,
  shouldDropSessionScopedEvent,
  shouldProjectBackgroundCompletion,
  type AppAction,
} from "../../shared/chatProjection.js";
import {
  getFinalMessageContinueAction,
  getLatestAutoContinueAction,
  getLatestFinalMessageMarker,
} from "../../shared/finalStatus.js";
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "preact/hooks";

import {
  ApprovalPanelEmbed,
  DEFAULT_APPROVAL_PANEL_HEIGHT,
  MIN_APPROVAL_PANEL_HEIGHT,
} from "./components/ApprovalPanelEmbed";
import { BackgroundSessionStrip } from "./components/BackgroundSessionStrip";
import type { BgSessionInfoProps } from "./components/BackgroundSessionStrip";
import { BtwPanel } from "./components/BtwPanel";
import type { BtwState } from "./components/BtwPanel";
import { WorktreeSetupPanel } from "./components/WorktreeSetupPanel";
import { ChatHeader } from "./components/ChatHeader";
import { ChatTabConfirmation } from "./components/ChatTabConfirmation";
import { ChatSessionPane, ChatWorkspace } from "./components/ChatWorkspace";
import { ChatView } from "./components/ChatView";
import { ContextUsageRow } from "./components/ContextUsageRow";
import { EnvironmentPanel } from "./components/EnvironmentPanel";
import { ModelSetupCard } from "./components/ModelSetupCard";
import { ElicitationModal } from "./components/ElicitationModal";
import {
  InputArea,
  type ComposerContextMode,
  type ComposerMedia,
} from "./components/InputArea";
import { ChatActivityShelf } from "../../shared/ui/ChatActivityShelf";
import { SessionHandoffPanel } from "../../shared/ui/SessionHandoffPanel";
import type { SessionHandoffDraft } from "../sessionHandoff";

import { AgentPluginManagerPanel } from "../../shared/ui/AgentPluginManagerPanel";
import { MemoryPanel } from "../../shared/ui/MemoryPanel";
import { McpManagerPanel } from "../../shared/ui/McpManagerPanel";
import type {
  ManageMemoryToolInput,
  MemoryInspectionQueryRequest,
  MemoryPanelSnapshot,
  MemoryToolScope,
} from "../../core/capabilities/memory.js";
import type { MemoryArchiveV1 } from "../../core/memory/contracts.js";
import type {
  McpElicitationValues,
  McpFormElicitationRequest,
} from "../../shared/mcpElicitation";
import type { McpUrlElicitationRequest } from "../../shared/mcpUrlElicitation";
import {
  MessageQueuePanel,
  type MessageQueueItem,
} from "./components/MessageQueuePanel";
import { ProviderUsagePanel } from "./components/ProviderUsageBlock";
import {
  QuestionCard,
  type QuestionComposerState,
} from "./components/QuestionCard";
import { SessionHistory } from "./components/SessionHistory";
import { StreamingStatusBar } from "./components/StreamingStatusBar";
import { TodoPanel } from "./components/TodoPanel";
import { TranscriptView } from "./components/TranscriptView";
import { UrlElicitationModal } from "./components/UrlElicitationModal";
import { detectQuestionFromAssistantText } from "./questionDetection";
import { getDevelopmentStreamingBaselineMetrics } from "../../shared/streamingBaselineMetrics";
import { isForwardedBuiltinCommand } from "../../shared/builtinCommandForwarding";
import { deriveModelSetupState } from "../../shared/modelSetup";
import { randomId } from "../../shared/randomId";
import {
  resolveOpenFileRequest,
  trackOpenFileRequest,
} from "./components/fileLinkFeedback";
import {
  toVsCodeSelectionMessage,
  type WriteApprovalSelection,
} from "../../shared/selectionCommands";
import type { CommandApprovalPolicy } from "../../approvals/commandApprovalPolicy";
import {
  addressChatPaneMessage,
  type ChatWebviewBootstrap,
} from "../chatPaneProtocol";
import {
  selectedWorkspaceSessionId,
  type ChatTabActionConfirmationRequest,
  type ChatWorkspaceViewSnapshot,
} from "../chatTabProtocol";
import { InactiveChatProjectionCache } from "./InactiveChatProjectionCache";
import { ChatProjectionStateCache } from "./ChatProjectionStateCache";
import { addressChatWebviewMessage } from "./chatTabActions";
import { useWebviewMessageConnection } from "./useWebviewMessageConnection";

const DEFAULT_MAX_TOKENS = 200_000;
const AUTO_CONTINUE_MAX_TURNS = 10;
const MCP_CONFIG_MUTATION_TIMEOUT_MS = 30_000;
const PROMPT_POLISH_TIMEOUT_MS = 60_000;

interface OpenTranscriptState {
  sessionId: string;
  task: string;
  messages: ChatMessage[];
  streaming: boolean;
  todos: TodoItem[];
  statusOverride: string | null;
  visible: boolean;
}

function reduceOpenTranscript(
  current: OpenTranscriptState | null,
  sessionId: string,
  action: AppAction,
  overrides?: Partial<OpenTranscriptState>,
): OpenTranscriptState | null {
  if (current?.sessionId !== sessionId) return current;
  const next = reducer(
    {
      ...initialState,
      messages: current.messages,
      streaming: current.streaming,
      todos: current.todos,
      statusOverride: current.statusOverride,
    },
    action,
  );
  return {
    ...current,
    messages: next.messages,
    streaming: next.streaming,
    todos: next.todos,
    statusOverride: next.statusOverride,
    ...overrides,
  };
}

/**
 * Streaming-flag override applied when projecting a background stream event
 * into an open transcript. Any mid-run event proves the agent is still live,
 * so it turns the transcript spinner on — including interjections, which are
 * consumed right before the engine starts another API turn whose first token
 * may be a long time away. Terminal events turn it off; anything else leaves
 * the flag untouched.
 */
export function shouldReuseBackgroundTranscript(
  currentSessionId: string | undefined,
  requestedSessionId: string,
): boolean {
  return currentSessionId === requestedSessionId;
}

export function bgTranscriptStreamingOverride(
  msgType: string,
): { streaming: boolean } | undefined {
  switch (msgType) {
    case "agentBgThinkingStart":
    case "agentBgThinkingDelta":
    case "agentBgTextDelta":
    case "agentBgToolStart":
    case "agentBgToolInputDelta":
    case "agentBgToolComplete":
    case "agentBgInterjection":
      return { streaming: true };
    case "agentBgError":
      return { streaming: false };
    default:
      return undefined;
  }
}

type DisplayMedia = NonNullable<ChatMessage["displayMedia"]>;
type SendImage = { name: string; mimeType: string; base64: string };
type SendDocument = { name: string; mimeType: string; base64?: string };

function mediaToDisplayMedia(
  images: SendImage[],
  documents: SendDocument[],
): DisplayMedia | undefined {
  if (images.length === 0 && documents.length === 0) return undefined;
  return {
    images: images.map((image) => ({
      name: image.name,
      mimeType: image.mimeType,
      src: `data:${image.mimeType};base64,${image.base64}`,
    })),
    documents: documents.map((document) => ({
      name: document.name,
      mimeType: document.mimeType,
    })),
  };
}

function captureVsCodeThemeSnapshot(): {
  cssVariables: Record<string, string>;
  colorScheme: "light" | "dark" | "hc" | "hc-light";
} {
  const computed = getComputedStyle(document.documentElement);
  const cssVariables: Record<string, string> = {};
  for (let i = 0; i < computed.length; i += 1) {
    const key = computed.item(i);
    if (!key || !key.startsWith("--vscode-")) continue;
    const value = computed.getPropertyValue(key).trim();
    if (!value) continue;
    cssVariables[key] = value;
  }

  const bodyClass = document.body.classList;
  const colorScheme = bodyClass.contains("vscode-high-contrast-light")
    ? "hc-light"
    : bodyClass.contains("vscode-high-contrast")
      ? "hc"
      : bodyClass.contains("vscode-light")
        ? "light"
        : "dark";

  return {
    cssVariables,
    colorScheme,
  };
}

function hasFinalContinueAction(message: ChatMessage): boolean {
  return Boolean(
    message.finalMarker && getFinalMessageContinueAction(message.finalMarker),
  );
}

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

export {
  agentMessagesToChatMessages,
  initialState,
  reducer,
  shouldAcceptSessionChunk,
  shouldDropSessionScopedEvent,
  shouldProjectBackgroundCompletion,
};

export function queuedMessagesReadyToDrain(
  queue: MessageQueueItem[],
  editingQueueId: string | null,
): MessageQueueItem[] {
  return queue.filter(
    (item) => item.source !== "browser" && item.id !== editingQueueId,
  );
}

export interface Injection {
  type: "prompt" | "attachment" | "context";
  prompt?: string;
  attachments?: string[];
  autoSubmit?: boolean;
  path?: string;
  context?: string;
}

const streamingBaselineMetrics = __DEV_BUILD__
  ? getDevelopmentStreamingBaselineMetrics("vscode-webview", true)
  : undefined;

/**
 * How long without a `hostHeartbeat` message (sent every 2s by
 * ChatViewProvider) before the tab-strip indicator flags the extension host as
 * unresponsive. Three missed beats: long enough to ignore ordinary jitter,
 * short enough to also make multi-second event-loop stalls visible.
 */
const HOST_HEARTBEAT_STALE_MS = 6_000;

/**
 * Session-scoped events whose content is fully superseded by an applied
 * `agentSessionLoaded` hydration (persisted transcript + in-flight tail).
 * Replaying these on top of a load duplicates the turn; everything else in
 * the inactive buffer (questions, approvals, queue changes, API telemetry)
 * carries state the payload cannot rebuild and is replayed after the load.
 */
const TRANSCRIPT_CONTENT_EVENT_TYPES = new Set<string>([
  "agentThinkingStart",
  "agentThinkingDelta",
  "agentThinkingEnd",
  "agentTextDelta",
  "agentToolStart",
  "agentToolInputDelta",
  "agentToolComplete",
  "agentDone",
  "agentError",
  "agentInterjection",
  "agentCommittedUserMessage",
  "agentSurfaceChange",
  "agentCondenseStart",
  "agentCondense",
  "agentCondenseError",
  "agentCheckpointCreated",
  "agentTodoUpdate",
  "agentFinalMarker",
]);

export function App({
  vscodeApi: hostVscodeApi,
  pane = { surface: "sidebar" },
}: {
  vscodeApi: VsCodeApi;
  pane?: ChatWebviewBootstrap;
}) {
  const pinnedPane = pane.surface === "editor" ? pane.address : undefined;
  const pinnedTabId = pinnedPane?.tabId;
  const [state, dispatch] = useReducer(reducer, initialState);
  const [workspaceSnapshot, setWorkspaceSnapshot] =
    useState<ChatWorkspaceViewSnapshot | null>(null);
  const workspaceSnapshotRef = useRef<ChatWorkspaceViewSnapshot | null>(null);
  const [hostConnectionStale, setHostConnectionStale] = useState(false);
  const [handoffDraft, setHandoffDraft] = useState<SessionHandoffDraft | null>(
    null,
  );
  const [handoffError, setHandoffError] = useState<string | null>(null);
  const lastHostHeartbeatRef = useRef(Date.now());
  const inactiveProjectionCacheRef = useRef(new InactiveChatProjectionCache());
  const projectionStateCacheRef = useRef(new ChatProjectionStateCache());
  const restoredCachedSessionRef = useRef<string | null>(null);
  const acceptedTranscriptRevisionsRef = useRef(
    new Map<string, { controllerEpoch: string | null; revision: number }>(),
  );
  /**
   * Sessions whose projection held by this webview (live, or saved in the
   * projection cache) came from a real hydration or has been maintained by an
   * unbroken event stream since. Only such projections may be served instead
   * of applying an incoming hydration, and only they may be saved to the
   * projection cache — saving a never-hydrated placeholder poisons the cache
   * with a permanently empty transcript.
   */
  const hydratedSessionsRef = useRef(new Set<string>());
  const flushConnectionDeltasRef = useRef<() => void>(() => {});
  const vscodeApi = useMemo<VsCodeApi>(
    () => ({
      postMessage: (message) => {
        const addressed = addressChatWebviewMessage(
          message,
          workspaceSnapshotRef.current,
          pinnedPane,
        );
        hostVscodeApi.postMessage(
          pinnedPane
            ? addressChatPaneMessage(addressed, pinnedPane)
            : addressed,
        );
      },
      getState: () => hostVscodeApi.getState(),
      setState: (nextState) => hostVscodeApi.setState(nextState),
    }),
    [hostVscodeApi, pinnedPane],
  );
  const stateRef = useRef(state.chatState);
  stateRef.current = state.chatState;
  const modelSetupState = useMemo(
    () => deriveModelSetupState(state.chatState.model, state.availableModels),
    [state.chatState.model, state.availableModels],
  );
  const pendingSessionSelectionsRef = useRef<{
    tabId: string | null;
    mode?: string;
    model?: string;
    reasoningEffort?: ReasoningEffort;
    agentWriteApproval?: WriteApprovalSelection;
    commandApprovalPolicy?: CommandApprovalPolicy;
  }>({ tabId: null });
  const fullStateRef = useRef(state);
  fullStateRef.current = state;
  const optimisticFirstSendRef = useRef<{
    tabId: string;
    sessionId: string | null;
  } | null>(null);

  // Flag the extension host as unresponsive when heartbeats stop arriving.
  // The webview renderer keeps running while the host event loop is blocked,
  // so a stale beat is a reliable "backend is wedged" signal.
  useEffect(() => {
    if (pane.surface !== "sidebar") return;
    const timer = setInterval(() => {
      const stale =
        Date.now() - lastHostHeartbeatRef.current > HOST_HEARTBEAT_STALE_MS;
      setHostConnectionStale((prev) => (prev === stale ? prev : stale));
    }, 1_000);
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        // Hidden webviews get timer-throttled and may miss beats; grant a
        // fresh grace period on return so only staleness observed while
        // visible is flagged.
        lastHostHeartbeatRef.current = Date.now();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [pane.surface]);
  const previousStreamingRef = useRef(state.streaming);
  const activeDetectRequestRef = useRef<{
    requestId: string;
    messageId: string;
    assistantText: string;
  } | null>(null);
  const startupRestorePendingRef = useRef(true);
  const loadingSessionIdRef = useRef<string | null>(null);
  const historyLoadPendingRef = useRef(false);
  const messageQueueRef = useRef(state.messageQueue);
  messageQueueRef.current = state.messageQueue;
  const editingQueuedMessageRef = useRef<{
    id: string;
    resumeInterjection: boolean;
  } | null>(null);
  const reasoningEffortRef = useRef<ReasoningEffort>(
    state.chatState.reasoningEffort ??
      (state.thinkingEnabled ? "high" : "none"),
  );
  reasoningEffortRef.current =
    state.chatState.reasoningEffort ??
    (state.thinkingEnabled ? "high" : "none");
  // Guards against stale delta events arriving after agentDone (stop race condition).
  // Set true when a turn starts, false when agentDone fires.
  const streamingRef = useRef(false);

  const [injection, setInjection] = useState<Injection | null>(null);
  const [autoContinueEnabled, setAutoContinueEnabled] = useState(false);
  const [autoContinueStatus, setAutoContinueStatus] = useState("");
  const autoContinuedMessageIdsRef = useRef<Set<string>>(new Set());
  const autoContinueCountRef = useRef(0);
  const pendingAutoContinueUserMessageIdRef = useRef<string | null>(null);
  const autoContinueSessionIdRef = useRef<string | null>(
    state.chatState.sessionId,
  );
  const [shiftDragOver, setShiftDragOver] = useState(false);
  const dragCounterRef = useRef(0);
  const [mcpManagerSnapshot, setMcpManagerSnapshot] =
    useState<McpConfigSnapshot | null>(null);
  const [agentPluginManagerSnapshot, setAgentPluginManagerSnapshot] =
    useState<AgentPluginManagerSnapshot | null>(null);
  const [memoryPanelOpen, setMemoryPanelOpen] = useState(false);
  const [environmentPanelOpen, setEnvironmentPanelOpen] = useState(false);
  const [memoryPanelSnapshot, setMemoryPanelSnapshot] =
    useState<MemoryPanelSnapshot | null>(null);
  const [memoryPanelScope, setMemoryPanelScope] =
    useState<MemoryToolScope>("global");
  const [memoryPanelAvailableScopes, setMemoryPanelAvailableScopes] = useState<
    MemoryToolScope[]
  >(["global"]);
  const [memoryPanelLoading, setMemoryPanelLoading] = useState(false);
  const [memoryPanelError, setMemoryPanelError] = useState<string | null>(null);
  const memoryPanelQueryRef = useRef<MemoryInspectionQueryRequest>({
    scope: "global",
    limit: 100,
  });
  const memoryPanelRequestIdRef = useRef<string | null>(null);
  const memoryPanelMutationRequestIdsRef = useRef(new Set<string>());
  const beginMemoryPanelRequest = () => {
    const requestId = randomId();
    memoryPanelRequestIdRef.current = requestId;
    return requestId;
  };
  const beginMemoryPanelMutation = () => {
    const requestId = beginMemoryPanelRequest();
    memoryPanelMutationRequestIdsRef.current.add(requestId);
    return requestId;
  };
  const mcpMutationResolversRef = useRef(
    new Map<
      string,
      {
        resolve: (result: McpConfigMutationResult) => void;
        reject: (reason: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    >(),
  );
  const [providerUsage, setProviderUsage] = useState<
    import("./types").ProviderUsageCardData | null
  >(null);
  const [mcpManagerView, setMcpManagerView] = useState<
    "status" | "config" | "add" | "edit"
  >("status");
  const [elicitation, setElicitation] =
    useState<McpFormElicitationRequest | null>(null);
  const [urlElicitation, setUrlElicitation] =
    useState<McpUrlElicitationRequest | null>(null);
  const [sessionHistory, setSessionHistory] = useState<SessionSummary[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [chatTabConfirmation, setChatTabConfirmation] =
    useState<ChatTabActionConfirmationRequest | null>(null);
  const [chatTabFailure, setChatTabFailure] = useState<string | null>(null);
  const [globalApproval, setGlobalApproval] = useState<ApprovalRequest | null>(
    null,
  );
  const globalApprovalRef = useRef<ApprovalRequest | null>(null);
  globalApprovalRef.current = globalApproval;
  const [approvalPanelHeight, setApprovalPanelHeight] = useState(
    DEFAULT_APPROVAL_PANEL_HEIGHT,
  );
  const [approvalResizing, setApprovalResizing] = useState(false);
  const approvalResizeCleanupRef = useRef<(() => void) | null>(null);
  const forwardedFollowUpRef = useRef("");
  const [questionContextMode, setQuestionContextMode] = useState<{
    requestId: string;
    state: QuestionComposerState;
  } | null>(null);
  const [questionAttachments, setQuestionAttachments] = useState<{
    requestId: string;
    values: Record<string, { paths: string[]; media: ComposerMedia[] }>;
  } | null>(null);
  useEffect(() => {
    setQuestionContextMode(null);
    setQuestionAttachments(null);
  }, [state.questionRequest?.id]);
  const [remoteQuestionProgress, setRemoteQuestionProgress] = useState<{
    id: string;
    step: number;
    answers: Record<string, string | string[] | number | boolean | undefined>;
    notes: Record<string, string>;
    origin: string;
  } | null>(null);
  const questionProgressOriginRef = useRef<string>(
    `ext-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`,
  );
  const activeQuestionAttachments =
    questionAttachments &&
    questionAttachments.requestId === state.questionRequest?.id
      ? questionAttachments.values
      : {};
  const activeQuestionStep =
    remoteQuestionProgress &&
    remoteQuestionProgress.id === state.questionRequest?.id
      ? remoteQuestionProgress.step
      : 0;
  const activeQuestionContextMode = state.questionRequest
    ? questionContextMode?.requestId === state.questionRequest.id
      ? questionContextMode.state
      : {
          revision: "initial",
          questionId:
            state.questionRequest.questions[activeQuestionStep]?.id ?? "",
          initialText:
            remoteQuestionProgress?.id === state.questionRequest.id
              ? (remoteQuestionProgress.notes[
                  state.questionRequest.questions[activeQuestionStep]?.id ?? ""
                ] ?? "")
              : "",
          focusComposer:
            state.questionRequest.questions[activeQuestionStep]?.type !==
              "text" &&
            state.questionRequest.questions[activeQuestionStep]?.type !==
              "confirmation",
          onCommit: () => undefined,
          canGoBack: false,
          onBack: () => undefined,
          primaryLabel: "Submit" as const,
          primaryDisabled: true,
          onPrimary: () => undefined,
          hidePrimaryAction:
            state.questionRequest.questions[activeQuestionStep]?.type ===
            "confirmation",
        }
    : null;
  const [bgSessions, setBgSessions] = useState<BgSessionInfoProps[]>([]);
  const bgSessionsRef = useRef<BgSessionInfoProps[]>([]);
  bgSessionsRef.current = bgSessions;
  const [showFleetRequest, setShowFleetRequest] = useState(0);
  const [transcriptView, setTranscriptView] =
    useState<OpenTranscriptState | null>(null);
  const [btwStates, setBtwStates] = useState<Record<string, BtwState>>({});
  const [worktreeSetupState, setWorktreeSetupState] =
    useState<WorktreeSetupState | null>(null);

  useEffect(() => {
    const sendThemeSnapshot = () => {
      const snapshot = captureVsCodeThemeSnapshot();
      vscodeApi.postMessage({
        command: "themeSnapshot",
        cssVariables: snapshot.cssVariables,
        colorScheme: snapshot.colorScheme,
      });
    };

    let themeReportTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleThemeSnapshot = () => {
      if (themeReportTimer !== null) {
        clearTimeout(themeReportTimer);
      }
      themeReportTimer = setTimeout(() => {
        themeReportTimer = null;
        sendThemeSnapshot();
      }, 75);
    };

    sendThemeSnapshot();

    const root = document.documentElement;
    const body = document.body;
    const observer = new MutationObserver(() => {
      scheduleThemeSnapshot();
    });
    observer.observe(root, {
      attributes: true,
      attributeFilter: ["style", "class"],
    });
    observer.observe(body, {
      attributes: true,
      attributeFilter: ["class"],
    });

    return () => {
      observer.disconnect();
      if (themeReportTimer !== null) {
        clearTimeout(themeReportTimer);
      }
    };
  }, [vscodeApi]);

  useEffect(
    () => () => {
      for (const pending of mcpMutationResolversRef.current.values()) {
        clearTimeout(pending.timer);
        pending.reject(
          new Error("The MCP Manager was closed before the save completed."),
        );
      }
      mcpMutationResolversRef.current.clear();
    },
    [],
  );

  const applyWorkspaceSnapshot = useCallback(
    (snapshot: ChatWorkspaceViewSnapshot) => {
      const previousSnapshot = workspaceSnapshotRef.current;
      const previousSessionId = selectedWorkspaceSessionId(
        previousSnapshot,
        pinnedTabId,
      );
      const controllerEpochChanged =
        !previousSnapshot ||
        previousSnapshot.controllerEpoch !== snapshot.controllerEpoch;
      if (controllerEpochChanged) {
        acceptedTranscriptRevisionsRef.current.clear();
        inactiveProjectionCacheRef.current.clear();
        projectionStateCacheRef.current.clear();
        restoredCachedSessionRef.current = null;
        hydratedSessionsRef.current.clear();
        optimisticFirstSendRef.current = null;
        setBtwStates({});
      }
      const nextSessionId = selectedWorkspaceSessionId(snapshot, pinnedTabId);
      const previousSelectedTabId =
        pinnedTabId ?? previousSnapshot?.focusedTabId;
      const nextSelectedTabId = pinnedTabId ?? snapshot.focusedTabId;
      const selectedTabChanged = previousSelectedTabId !== nextSelectedTabId;
      const optimisticFirstSend = optimisticFirstSendRef.current;
      const boundSelectedTabToSession = Boolean(
        !controllerEpochChanged &&
        previousSnapshot &&
        previousSelectedTabId === nextSelectedTabId &&
        previousSessionId === null &&
        nextSessionId &&
        optimisticFirstSend?.tabId === nextSelectedTabId &&
        optimisticFirstSend.sessionId === null,
      );
      const openSessionIds = new Set(
        snapshot.tabs.flatMap((tab) => (tab.sessionId ? [tab.sessionId] : [])),
      );
      if (!controllerEpochChanged) {
        setBtwStates((previous) =>
          Object.fromEntries(
            Object.entries(previous).filter(([sessionId]) =>
              openSessionIds.has(sessionId),
            ),
          ),
        );
      }
      if (
        previousSessionId !== nextSessionId ||
        (selectedTabChanged && (!previousSessionId || !nextSessionId))
      ) {
        flushConnectionDeltasRef.current();
        if (selectedTabChanged) {
          optimisticFirstSendRef.current = null;
        }
        if (boundSelectedTabToSession && nextSessionId) {
          // The first send renders optimistically before the host creates a
          // session. Binding that same tab must adopt the session identity
          // without restoring a fresh, empty projection over the first turn.
          const bound = {
            ...fullStateRef.current,
            chatState: {
              ...fullStateRef.current.chatState,
              sessionId: nextSessionId,
            },
          };
          fullStateRef.current = bound;
          stateRef.current = bound.chatState;
          streamingRef.current = bound.streaming;
          optimisticFirstSendRef.current = {
            tabId: optimisticFirstSend!.tabId,
            sessionId: nextSessionId,
          };
          hydratedSessionsRef.current.delete(nextSessionId);
          workspaceSnapshotRef.current = snapshot;
          dispatch({ type: "RESTORE_PROJECTION", state: bound });
        } else {
          // Only a projection that came from a real hydration — or that visibly
          // accumulated session state while live — may be cached. Saving a
          // pristine placeholder (switching away before the session's first
          // load arrived) would poison the cache with an empty transcript that
          // later gets trusted.
          const outgoing = fullStateRef.current;
          const outgoingHasSubstance =
            outgoing.messages.length > 0 ||
            outgoing.messageQueue.length > 0 ||
            outgoing.streaming ||
            outgoing.estimatedTotalUsed > 0;
          if (
            !controllerEpochChanged &&
            previousSessionId &&
            (hydratedSessionsRef.current.has(previousSessionId) ||
              outgoingHasSubstance)
          ) {
            projectionStateCacheRef.current.save(outgoing);
          }
          restoredCachedSessionRef.current =
            nextSessionId && projectionStateCacheRef.current.has(nextSessionId)
              ? nextSessionId
              : null;
          if (nextSessionId && restoredCachedSessionRef.current === null) {
            // The incoming projection is a fresh placeholder, not session state.
            hydratedSessionsRef.current.delete(nextSessionId);
          }
          const restored = projectionStateCacheRef.current.restore(
            nextSessionId,
            {
              modes: fullStateRef.current.modes,
              availableModels: fullStateRef.current.availableModels,
              slashCommands: fullStateRef.current.slashCommands,
            },
          );
          fullStateRef.current = restored;
          stateRef.current = restored.chatState;
          messageQueueRef.current = restored.messageQueue;
          streamingRef.current = restored.streaming;
          workspaceSnapshotRef.current = snapshot;
          dispatch({ type: "RESTORE_PROJECTION", state: restored });
        }
      }
      inactiveProjectionCacheRef.current.retainSessions(openSessionIds);
      projectionStateCacheRef.current.retainSessions(openSessionIds);
      for (const sessionId of acceptedTranscriptRevisionsRef.current.keys()) {
        if (!openSessionIds.has(sessionId)) {
          acceptedTranscriptRevisionsRef.current.delete(sessionId);
        }
      }
      for (const sessionId of hydratedSessionsRef.current) {
        if (!openSessionIds.has(sessionId)) {
          hydratedSessionsRef.current.delete(sessionId);
        }
      }
      const optimisticFirstSendAfterUpdate = optimisticFirstSendRef.current;
      if (
        optimisticFirstSendAfterUpdate?.sessionId &&
        !openSessionIds.has(optimisticFirstSendAfterUpdate.sessionId)
      ) {
        optimisticFirstSendRef.current = null;
      }
      workspaceSnapshotRef.current = snapshot;
      setWorkspaceSnapshot(snapshot);
    },
    [pinnedTabId],
  );

  const replayInactiveSessionMessage = useWebviewMessageConnection({
    vscodeApi,
    sessionIdRef: {
      get current() {
        const snapshot = workspaceSnapshotRef.current;
        const selected = snapshot?.tabs.find(
          (tab) => tab.tabId === (pinnedTabId ?? snapshot.focusedTabId),
        );
        return selected?.sessionId ?? stateRef.current.sessionId;
      },
    },
    streamingRef,
    openSessionIdsRef: {
      get current() {
        return new Set(
          workspaceSnapshotRef.current?.tabs.flatMap((tab) =>
            tab.sessionId ? [tab.sessionId] : [],
          ) ?? [],
        );
      },
    },
    flushDeltasRef: flushConnectionDeltasRef,
    dispatchDelta: dispatch,
    onStreamDrop: (sessionId) => {
      // A dropped event means this webview's replica of that session is no
      // longer complete; stop serving it in place of real hydrations.
      if (sessionId) hydratedSessionsRef.current.delete(sessionId);
    },
    onInactiveSessionMessage: (msg) => {
      if (msg.type === "agentSessionLoaded") return;
      if (msg.type === "agentDone" && msg.transcriptRevision !== undefined) {
        const controllerEpoch =
          workspaceSnapshotRef.current?.controllerEpoch ?? null;
        const accepted = acceptedTranscriptRevisionsRef.current.get(
          msg.sessionId,
        );
        acceptedTranscriptRevisionsRef.current.set(msg.sessionId, {
          controllerEpoch,
          revision:
            accepted?.controllerEpoch === controllerEpoch
              ? Math.max(accepted.revision, msg.transcriptRevision)
              : msg.transcriptRevision,
        });
      }
      inactiveProjectionCacheRef.current.append(msg);
    },
    onMessage: (msg, controls) => {
      const { dropIfNotStreaming, flushDeltasNow } = controls;

      switch (msg.type) {
        case "hostHeartbeat":
          lastHostHeartbeatRef.current = Date.now();
          setHostConnectionStale(false);
          break;
        case "chatWorkspaceUpdate":
          applyWorkspaceSnapshot(msg.snapshot);
          setChatTabFailure(null);
          break;
        case "chatTabActionConfirmationRequested":
          setChatTabConfirmation(msg.request);
          break;
        case "chatTabActionRejected":
          applyWorkspaceSnapshot(msg.rejection.snapshot);
          setChatTabConfirmation(null);
          setChatTabFailure(
            "That chat tab changed. Please try the action again.",
          );
          break;
        case "chatTabActionFailed":
          applyWorkspaceSnapshot(msg.failure.snapshot);
          setChatTabConfirmation(null);
          setChatTabFailure(
            msg.failure.reason === "close_blocked"
              ? "At least one chat tab must remain open."
              : msg.failure.reason === "session_not_found"
                ? "That saved chat is no longer available."
                : msg.failure.reason === "invalid_order"
                  ? "The tab order changed before it could be saved."
                  : msg.failure.reason === "placement_failed"
                    ? "The chat tab could not be moved. Please try again."
                    : "The chat tab could not be updated.",
          );
          break;
        case "stateUpdate": {
          const snapshot = workspaceSnapshotRef.current;
          const selectedSessionId = selectedWorkspaceSessionId(
            snapshot,
            pinnedTabId,
          );
          if (snapshot && msg.state.sessionId !== selectedSessionId) break;
          // Interrupted-run controls stay hidden until the session's
          // transcript hydration has landed: the banner would float above an
          // empty transcript and resume needs the hydrated session anyway.
          const incomingState =
            msg.state.interrupted &&
            startupRestorePendingRef.current &&
            (!msg.state.sessionId ||
              !hydratedSessionsRef.current.has(msg.state.sessionId))
              ? { ...msg.state, interrupted: false }
              : msg.state;
          streamingRef.current = Boolean(incomingState.streaming);
          if (incomingState.sessionId) {
            pendingSessionSelectionsRef.current = { tabId: null };
            dispatch({ type: "SET_STATE", state: incomingState });
            break;
          }
          const tabId = pinnedTabId ?? snapshot?.focusedTabId ?? null;
          const pending = pendingSessionSelectionsRef.current;
          if (pending.tabId !== tabId) {
            pendingSessionSelectionsRef.current = { tabId };
            dispatch({ type: "SET_STATE", state: incomingState });
            break;
          }
          const { tabId: _tabId, reasoningEffort, ...selections } = pending;
          dispatch({
            type: "SET_STATE",
            state: {
              ...incomingState,
              ...selections,
              ...(reasoningEffort
                ? {
                    reasoningEffort,
                    thinkingEnabled: reasoningEffort !== "none",
                  }
                : {}),
            },
          });
          break;
        }
        case "agentRestoreSessionStart":
          startupRestorePendingRef.current = true;
          dispatch({ type: "SET_RESTORING_SESSION", restoring: true });
          break;
        case "agentRestoreSessionDone":
          startupRestorePendingRef.current = false;
          dispatch({ type: "SET_RESTORING_SESSION", restoring: false });
          break;
        case "agentThinkingStart":
          if (dropIfNotStreaming()) break;
          dispatch({ type: "THINKING_START", thinkingId: msg.thinkingId });
          break;
        case "agentThinkingDelta":
          if (dropIfNotStreaming()) break;
          controls.appendThinkingDelta(msg.thinkingId, msg.text);
          break;
        case "agentThinkingEnd":
          if (dropIfNotStreaming()) break;
          // Flush buffered thinking deltas so content arrives before the block
          // is marked complete (same pattern as agentToolComplete).
          flushDeltasNow();
          dispatch({ type: "THINKING_END", thinkingId: msg.thinkingId });
          break;
        case "agentToolStart":
          if (dropIfNotStreaming()) break;
          streamingBaselineMetrics?.record({
            type: "delta",
            surface: "vscode-webview",
            kind: "semantic",
            chars: 0,
          });
          // Flush any buffered text deltas first so pre-tool text lands in its
          // own block before the tool_call block is inserted.
          flushDeltasNow();
          dispatch({
            type: "TOOL_START",
            toolCallId: msg.toolCallId,
            toolName: msg.toolName,
            parentCallId: msg.parentCallId,
            input: msg.input,
          });
          break;
        case "agentToolInputDelta":
          if (dropIfNotStreaming()) break;
          controls.appendToolInputDelta(msg.toolCallId, msg.partialJson);
          break;
        case "agentToolComplete":
          if (dropIfNotStreaming()) break;
          streamingBaselineMetrics?.record({
            type: "delta",
            surface: "vscode-webview",
            kind: "semantic",
            chars: 0,
          });
          // Flush any buffered input deltas before marking complete,
          // otherwise the input JSON may be empty/partial when the
          // tool block switches to its "complete" state.
          flushDeltasNow();
          dispatch({
            type: "TOOL_COMPLETE",
            toolCallId: msg.toolCallId,
            toolName: msg.toolName,
            result: msg.result,
            resultImages: msg.resultImages,
            resultDocuments: msg.resultDocuments,
            durationMs: msg.durationMs,
            input: msg.input,
            parentCallId: msg.parentCallId,
            mcpApprovalPromotion: msg.mcpApprovalPromotion,
            composeTrace: msg.composeTrace,
          });
          break;
        case "agentTokenEstimate":
          dispatch({
            type: "TOKEN_ESTIMATE",
            estimatedTotalUsed: msg.estimatedTotalUsed,
          });
          break;
        case "agentUserAnnotation":
          if (dropIfNotStreaming()) break;
          dispatch({
            type: "ADD_ANNOTATION",
            text: msg.text,
            badge: msg.badge,
          });
          break;

        case "agentSurfaceChange":
          dispatch({ type: "ADD_SURFACE_CHANGE", change: msg.change });
          break;

        case "agentTextDelta":
          if (dropIfNotStreaming()) break;
          streamingBaselineMetrics?.record({
            type: "delta",
            surface: "vscode-webview",
            kind: "text",
            chars: msg.text.length,
          });
          controls.appendTextDelta(msg.text);
          break;
        case "agentApiRequest":
          if (dropIfNotStreaming()) break;
          dispatch({
            type: "API_REQUEST",
            requestId: msg.requestId,
            model: msg.model,
            reasoningEffort: msg.reasoningEffort,
            mode: msg.mode,
            commandApprovalPolicy: msg.commandApprovalPolicy,
            inputTokens: msg.inputTokens,
            uncachedInputTokens: msg.uncachedInputTokens,
            outputTokens: msg.outputTokens,
            cacheReadTokens: msg.cacheReadTokens,
            cacheCreationTokens: msg.cacheCreationTokens,
            usageEstimated: msg.usageEstimated,
            durationMs: msg.durationMs,
            timeToFirstToken: msg.timeToFirstToken,
            usedPreviousResponseId: msg.usedPreviousResponseId,
            previousResponseIdFallback: msg.previousResponseIdFallback,
            promptCacheKey: msg.promptCacheKey,
            promptCacheRetention: msg.promptCacheRetention,
            storeResponseState: msg.storeResponseState,
            providerResponseId: msg.providerResponseId,
            contextBreakdown: msg.contextBreakdown,
          });
          break;
        case "agentError":
          streamingBaselineMetrics?.record({
            type: "delta",
            surface: "vscode-webview",
            kind: "semantic",
            chars: 0,
          });
          flushDeltasNow();
          streamingRef.current = false;
          dispatch({
            type: "ERROR",
            error: msg.error,
            retryable: msg.retryable,
            code: msg.code,
            actions: msg.actions,
          });
          break;
        case "agentTodoUpdate":
          dispatch({ type: "TODO_UPDATE", todos: msg.todos });
          break;
        case "agentFinalMarker":
          streamingBaselineMetrics?.record({
            type: "delta",
            surface: "vscode-webview",
            kind: "semantic",
            chars: 0,
          });
          dispatch({
            type: "SET_FINAL_MARKER",
            marker: msg.marker,
          });
          break;
        case "agentDone": {
          streamingBaselineMetrics?.record({
            type: "delta",
            surface: "vscode-webview",
            kind: "semantic",
            chars: 0,
          });
          flushDeltasNow();
          if (msg.transcriptRevision !== undefined) {
            const controllerEpoch =
              workspaceSnapshotRef.current?.controllerEpoch ?? null;
            const accepted = acceptedTranscriptRevisionsRef.current.get(
              msg.sessionId,
            );
            acceptedTranscriptRevisionsRef.current.set(msg.sessionId, {
              controllerEpoch,
              revision:
                accepted?.controllerEpoch === controllerEpoch
                  ? Math.max(accepted.revision, msg.transcriptRevision)
                  : msg.transcriptRevision,
            });
          }
          streamingRef.current = false;
          dispatch({ type: "DONE" });
          const queue = queuedMessagesReadyToDrain(
            messageQueueRef.current,
            editingQueuedMessageRef.current?.id ?? null,
          );
          if (queue.length > 0) {
            const originSessionId = msg.sessionId;
            const originMode = stateRef.current.mode;
            const originReasoningEffort = reasoningEffortRef.current;
            messageQueueRef.current = messageQueueRef.current.filter(
              (q) => !queue.some((item) => item.id === q.id),
            );
            streamingRef.current = true;
            for (const item of queue) {
              dispatch({ type: "REMOVE_FROM_QUEUE", id: item.id });
              dispatch({
                type: "ADD_USER_MESSAGE",
                text: item.text,
                isSlashCommand: item.isSlashCommand === true,
                slashCommandLabel: item.slashCommandLabel,
                displayMedia: item.displayMedia,
              });
            }
            vscodeApi.postMessage({
              command: "agentSend",
              text: queue[0]?.fullText ?? queue[0]?.text ?? "",
              displayText: queue[0]?.text,
              isSlashCommand: queue[0]?.isSlashCommand === true,
              slashCommandLabel: queue[0]?.slashCommandLabel,
              attachments: queue[0]?.attachments,
              images: queue[0]?.images,
              documents: queue[0]?.documents,
              messages: queue.map((item) => ({
                text: item.fullText ?? item.text,
                displayText: item.text,
                isSlashCommand: item.isSlashCommand === true,
                slashCommandLabel: item.slashCommandLabel,
                attachments: item.attachments,
                images: item.images,
                documents: item.documents,
              })),
              sessionId: originSessionId,
              mode: originMode,
              reasoningEffort: originReasoningEffort,
              thinkingEnabled: originReasoningEffort !== "none",
            });
          }
          break;
        }
        case "agentOpenFileResult":
          resolveOpenFileRequest(msg.requestId, msg.ok, msg.error);
          break;
        case "agentDebugInfo":
          if (msg.sessionId && msg.sessionId !== stateRef.current.sessionId)
            break;
          dispatch({
            type: "SET_DEBUG_INFO",
            info: msg.info,
            systemPrompt: msg.systemPrompt,
            loadedInstructions: msg.loadedInstructions,
          });
          break;
        case "agentInjectPrompt":
          setInjection({
            type: "prompt",
            prompt: msg.prompt,
            attachments: msg.attachments,
            autoSubmit: msg.autoSubmit,
          });
          break;
        case "agentInjectAttachment":
          setInjection({ type: "attachment", path: msg.path });
          break;
        case "agentInjectContext":
          setInjection({ type: "context", context: msg.context });
          break;
        case "agentModesUpdate":
          // Workspace/tab messages can immediately restore a different session
          // projection before this reducer update has rendered. Keep the
          // imperative projection source in lockstep so the restored tab retains
          // the shared setup data received during startup.
          fullStateRef.current = {
            ...fullStateRef.current,
            modes: msg.modes,
          };
          dispatch({ type: "SET_MODES", modes: msg.modes });
          break;
        case "agentModelsUpdate":
          fullStateRef.current = {
            ...fullStateRef.current,
            availableModels: msg.models,
          };
          dispatch({ type: "SET_MODELS", models: msg.models });
          break;
        case "agentSlashCommandsUpdate":
          fullStateRef.current = {
            ...fullStateRef.current,
            slashCommands: msg.commands,
          };
          dispatch({ type: "SET_SLASH_COMMANDS", commands: msg.commands });
          break;
        case "agentHandoffDraft":
          setHandoffDraft(msg.draft);
          setHandoffError(null);
          break;
        case "agentHandoffResult":
          if (msg.ok) {
            setHandoffDraft(null);
            setHandoffError(null);
          } else {
            setHandoffError(
              msg.error ?? "The fresh session could not be started.",
            );
          }
          break;
        case "agentProviderUsage": {
          setEnvironmentPanelOpen(false);
          setMcpManagerSnapshot(null);
          setAgentPluginManagerSnapshot(null);
          setProviderUsage(msg.data);
          break;
        }
        case "agentModeSwitchRequest":
          vscodeApi.postMessage({ command: "chatTabNewChat", mode: msg.mode });
          break;
        case "agentFormElicitationRequest":
          setElicitation(msg.request);
          break;
        case "agentFormElicitationCleared":
          setElicitation((current) =>
            current?.id === msg.id ? null : current,
          );
          break;
        case "agentUrlElicitationRequest":
          setUrlElicitation(msg.request);
          break;
        case "agentUrlElicitationCleared":
          setUrlElicitation((current) =>
            current?.id === msg.id ? null : current,
          );
          break;
        case "agentMcpConfigMutationResult": {
          const pending = mcpMutationResolversRef.current.get(
            msg.result.operationId,
          );
          if (pending) {
            mcpMutationResolversRef.current.delete(msg.result.operationId);
            clearTimeout(pending.timer);
            pending.resolve(msg.result);
          }
          break;
        }
        case "agentMemoryPanelUpdate": {
          const mutationResponse = Boolean(
            msg.requestId &&
            memoryPanelMutationRequestIdsRef.current.delete(msg.requestId),
          );
          if (
            msg.requestId &&
            msg.requestId !== memoryPanelRequestIdRef.current
          ) {
            if (mutationResponse) {
              const requestId = beginMemoryPanelRequest();
              vscodeApi.postMessage({
                command: "agentMemoryQuery",
                requestId,
                request: memoryPanelQueryRef.current,
              });
            }
            break;
          }
          setMemoryPanelLoading(false);
          setMemoryPanelScope(msg.scope);
          setMemoryPanelAvailableScopes(msg.availableScopes);
          setMemoryPanelError(msg.error ?? null);
          if (msg.open) {
            setEnvironmentPanelOpen(false);
            setMemoryPanelOpen(true);
          }
          if (msg.snapshot) {
            setMemoryPanelSnapshot(msg.snapshot);
          } else if ("selected" in msg) {
            setMemoryPanelSnapshot((current) =>
              current ? { ...current, selected: msg.selected } : current,
            );
          }
          break;
        }
        case "agentMcpStatus":
          if (msg.configSnapshot) {
            if (msg.open) {
              setEnvironmentPanelOpen(false);
              setProviderUsage(null);
              setAgentPluginManagerSnapshot(null);
              setMcpManagerSnapshot(msg.configSnapshot);
              setMcpManagerView(msg.view ?? "status");
            } else {
              setMcpManagerSnapshot((prev) =>
                prev !== null ? msg.configSnapshot! : prev,
              );
            }
          }
          break;
        case "agentPluginManagerSnapshot":
          if (msg.open) {
            setEnvironmentPanelOpen(false);
            setMemoryPanelOpen(false);
            setMcpManagerSnapshot(null);
            setProviderUsage(null);
          }
          setAgentPluginManagerSnapshot(msg.snapshot);
          break;
        case "showApproval":
          if (msg.sessionId === undefined) {
            globalApprovalRef.current = msg.request;
            setGlobalApproval(msg.request);
          } else {
            dispatch({ type: "SET_APPROVAL", request: msg.request });
          }
          break;
        case "idle":
          if (msg.sessionId === undefined) {
            if (globalApprovalRef.current?.id === msg.id) {
              globalApprovalRef.current = null;
              setGlobalApproval(null);
            }
          } else {
            dispatch({ type: "CLEAR_APPROVAL", id: msg.id });
          }
          break;

        case "agentCondense":
          dispatch({
            type: "ADD_CONDENSE",
            prevInputTokens: msg.prevInputTokens,
            newInputTokens: msg.newInputTokens,
            durationMs: msg.durationMs,
            validationWarnings: msg.validationWarnings,
          });
          break;

        case "agentCondenseStart":
          dispatch({ type: "CONDENSE_START" });
          break;

        case "agentWarning":
          dispatch({
            type: "ADD_WARNING",
            message: msg.message,
            retryDelayMs: msg.retryDelayMs,
            retryAt: msg.retryAt,
            retryAttempt: msg.retryAttempt,
            retryMaxAttempts: msg.retryMaxAttempts,
          });
          break;

        case "agentStatusUpdate":
          dispatch({
            type: "SET_STATUS_OVERRIDE",
            message: msg.message,
          });
          break;

        case "agentCondenseError":
          dispatch({
            type: "ADD_CONDENSE_ERROR",
            errorMessage: msg.error,
            retryable: msg.retryable,
            code: msg.code,
            actions: msg.actions,
          });
          break;

        case "regexSuggestion": {
          const pending = pendingRegexSuggestionsRef.current.get(msg.requestId);
          if (pending) {
            pendingRegexSuggestionsRef.current.delete(msg.requestId);
            if (msg.error) {
              pending.reject(new Error(msg.error));
            } else if (msg.pattern) {
              pending.resolve(msg.pattern);
            } else {
              pending.reject(new Error("No suggestion returned"));
            }
          }
          break;
        }

        case "promptPolishResult": {
          const pending = pendingPromptPolishRef.current.get(msg.requestId);
          if (pending) {
            pendingPromptPolishRef.current.delete(msg.requestId);
            if (msg.error) {
              pending.reject(new Error(msg.error));
            } else if (msg.polished) {
              pending.resolve(msg.polished);
            } else {
              pending.reject(new Error("No polished text returned"));
            }
          }
          break;
        }

        case "agentQuestionRequest":
          streamingBaselineMetrics?.record({
            type: "delta",
            surface: "vscode-webview",
            kind: "semantic",
            chars: 0,
          });
          dispatch({
            type: "SET_QUESTION",
            id: msg.id,
            toolCallId: msg.toolCallId,
            context: msg.context,
            questions: msg.questions,
            ...(msg.backgroundTask
              ? { backgroundTask: msg.backgroundTask }
              : {}),
          });
          break;

        case "agentQuestionCleared":
          dispatch({ type: "CLEAR_QUESTION", id: msg.id });
          setRemoteQuestionProgress((progress) =>
            progress?.id === msg.id ? null : progress,
          );
          break;

        case "agentInteractionPromptsCleared":
          activeDetectRequestRef.current = null;
          dispatch({ type: "CLEAR_INTERACTION_PROMPTS" });
          setElicitation(null);
          setRemoteQuestionProgress(null);
          break;

        case "agentQuestionProgress":
          if (msg.origin !== questionProgressOriginRef.current) {
            setRemoteQuestionProgress({
              id: msg.id,
              step: msg.step,
              answers: msg.answers,
              notes: msg.notes,
              origin: msg.origin,
            });
          }
          break;

        case "agentSessionList":
          setSessionHistory(msg.sessions);
          break;

        case "agentSessionLoaded": {
          if (msg.restored && !startupRestorePendingRef.current) {
            break;
          }
          if (
            workspaceSnapshotRef.current &&
            msg.sessionId !==
              selectedWorkspaceSessionId(
                workspaceSnapshotRef.current,
                pinnedTabId,
              )
          ) {
            break;
          }
          const optimisticFirstSend = optimisticFirstSendRef.current;
          if (optimisticFirstSend?.sessionId === msg.sessionId) {
            const hasCommittedUserMessage = (
              msg.messages as Array<{ role?: unknown }>
            ).some((message) => message.role === "user");
            if (!hasCommittedUserMessage) break;
            optimisticFirstSendRef.current = null;
          }
          // Drain buffered deltas first so the projection we evaluate (and
          // possibly keep serving) is current.
          flushDeltasNow();
          const transcriptRevision = msg.transcriptRevision;
          const controllerEpoch =
            workspaceSnapshotRef.current?.controllerEpoch ?? null;
          const acceptedTranscriptRevision =
            acceptedTranscriptRevisionsRef.current.get(msg.sessionId);
          const comparableAcceptedRevision =
            acceptedTranscriptRevision?.controllerEpoch === controllerEpoch
              ? acceptedTranscriptRevision.revision
              : undefined;
          const projectBackgroundResults = () => {
            for (const result of msg.backgroundResults ?? []) {
              dispatch({ type: "BG_AGENT_DONE", completion: result });
            }
          };
          const finishWithoutLoad = () => {
            restoredCachedSessionRef.current = null;
            startupRestorePendingRef.current = false;
            historyLoadPendingRef.current = false;
            loadingSessionIdRef.current = null;
            setShowHistory(false);
            projectBackgroundResults();
          };
          const recordAcceptedRevision = () => {
            if (transcriptRevision === undefined) return;
            const accepted = acceptedTranscriptRevisionsRef.current.get(
              msg.sessionId,
            );
            acceptedTranscriptRevisionsRef.current.set(msg.sessionId, {
              controllerEpoch,
              revision:
                accepted?.controllerEpoch === controllerEpoch
                  ? Math.max(accepted.revision, transcriptRevision)
                  : transcriptRevision,
            });
          };

          // Focus-style hydrations may be served from webview-held state. All
          // other origins (history load, checkpoint revert, recovered-question
          // resync, webview boot) rewrote or re-established the transcript and
          // must be applied.
          if (msg.origin === "focus" && !msg.restored) {
            const bufferIntact =
              !inactiveProjectionCacheRef.current.wasTruncated(msg.sessionId);
            // (a) The session is already live in the current projection: the
            // local replica is a superset of this snapshot. Nothing to apply.
            if (
              restoredCachedSessionRef.current !== msg.sessionId &&
              stateRef.current.sessionId === msg.sessionId &&
              hydratedSessionsRef.current.has(msg.sessionId)
            ) {
              inactiveProjectionCacheRef.current.take(msg.sessionId);
              recordAcceptedRevision();
              finishWithoutLoad();
              break;
            }
            // (b) A cached projection was just restored for this session and
            // every event since it was saved is still buffered: replaying the
            // buffer on top reproduces the live state exactly — including
            // rows (API telemetry, in-turn ask_user context) a persisted-
            // transcript reload cannot rebuild.
            if (
              restoredCachedSessionRef.current === msg.sessionId &&
              hydratedSessionsRef.current.has(msg.sessionId) &&
              bufferIntact
            ) {
              const bufferedEvents = inactiveProjectionCacheRef.current.take(
                msg.sessionId,
              );
              recordAcceptedRevision();
              finishWithoutLoad();
              for (const inactiveEvent of bufferedEvents) {
                replayInactiveSessionMessage(inactiveEvent);
              }
              break;
            }
          }

          // Stale guard: never let an older snapshot clobber newer applied
          // state (e.g. delayed re-delivery after a postMessage failure).
          if (
            transcriptRevision !== undefined &&
            comparableAcceptedRevision !== undefined &&
            transcriptRevision < comparableAcceptedRevision &&
            hydratedSessionsRef.current.has(msg.sessionId) &&
            stateRef.current.sessionId === msg.sessionId
          ) {
            finishWithoutLoad();
            break;
          }

          // Apply the hydration. It is complete (persisted tail + live
          // in-flight blocks), so it supersedes every buffered transcript-
          // content event — replaying those on top of a load is exactly the
          // historical duplication bug. Buffered events that carry state the
          // payload cannot rebuild (questions, approvals, queue changes, API
          // telemetry) are replayed after the load instead.
          const bufferedEvents = inactiveProjectionCacheRef.current.take(
            msg.sessionId,
          );
          recordAcceptedRevision();
          restoredCachedSessionRef.current = null;
          startupRestorePendingRef.current = false;
          historyLoadPendingRef.current = false;
          loadingSessionIdRef.current = msg.sessionId;
          if (msg.hasMoreBefore !== true) {
            loadingSessionIdRef.current = null;
          }
          dispatch({
            type: "LOAD_SESSION",
            sessionId: msg.sessionId,
            title: msg.title,
            originalPrompt: msg.originalPrompt,
            mode: msg.mode,
            model: msg.model,
            messages: agentMessagesToChatMessages(msg.messages as unknown[], {
              baseIndex: msg.messageIndexOffset,
            }),
            todos: msg.todos,
            lastInputTokens: msg.lastInputTokens,
            lastOutputTokens: msg.lastOutputTokens,
            backgroundResults: msg.backgroundResults,
            checkpoints: msg.checkpoints,
            userTurnOffset: (msg.userTurnOffset as number | undefined) ?? 0,
            hasMoreBefore: msg.hasMoreBefore,
            inFlight: msg.inFlight,
            streaming: msg.streaming,
            interrupted: msg.interrupted,
          });
          streamingRef.current = Boolean(msg.streaming);
          // Keep the synchronous mirrors coherent before the render commits,
          // so a follow-up message in the same task sees the applied session.
          stateRef.current = {
            ...stateRef.current,
            sessionId: msg.sessionId,
            streaming: Boolean(msg.streaming),
          };
          hydratedSessionsRef.current.add(msg.sessionId);
          setShowHistory(false);
          for (const bufferedEvent of bufferedEvents) {
            if (bufferedEvent.type === "agentInterjection") {
              // The interjection bubble itself is part of the hydrated
              // transcript; only its queue-consumption side effect must be
              // reapplied or the queued entry resurrects as a ghost.
              dispatch({
                type: "REMOVE_FROM_QUEUE",
                id: bufferedEvent.queueId,
              });
              messageQueueRef.current = messageQueueRef.current.filter(
                (queued) => queued.id !== bufferedEvent.queueId,
              );
              continue;
            }
            if (!TRANSCRIPT_CONTENT_EVENT_TYPES.has(bufferedEvent.type)) {
              replayInactiveSessionMessage(bufferedEvent);
            }
          }
          break;
        }

        case "agentSessionChunk": {
          if (
            !shouldAcceptSessionChunk(
              msg.sessionId,
              stateRef.current.sessionId,
              loadingSessionIdRef.current,
            )
          ) {
            break;
          }
          historyLoadPendingRef.current = false;
          if (msg.hasMoreBefore !== true) {
            loadingSessionIdRef.current = null;
          }
          dispatch({
            type: "PREPEND_SESSION_CHUNK",
            messages: agentMessagesToChatMessages(msg.messages as unknown[], {
              baseIndex: msg.messageIndexOffset,
            }),
            userTurnOffset: msg.userTurnOffset as number,
            hasMoreBefore: msg.hasMoreBefore as boolean,
            checkpoints: msg.checkpoints,
          });
          break;
        }

        case "agentCheckpointCreated":
          dispatch({
            type: "SET_CHECKPOINT",
            checkpointId: msg.checkpointId,
            turnIndex: msg.turnIndex,
          });
          break;

        case "agentInterjection":
          // User message injected mid-run between tool batches
          dispatch({
            type: "ADD_INTERJECTION",
            text: (msg.displayText as string | undefined) ?? msg.text,
            isSlashCommand:
              (msg.isSlashCommand as boolean | undefined) ?? false,
            slashCommandLabel:
              (msg.slashCommandLabel as string | undefined) ??
              ((msg.isSlashCommand as boolean | undefined)
                ? (msg.displayText as string | undefined)
                : undefined),
            displayMedia: msg.displayMedia,
          });
          dispatch({ type: "REMOVE_FROM_QUEUE", id: msg.queueId });
          messageQueueRef.current = messageQueueRef.current.filter(
            (q) => q.id !== msg.queueId,
          );
          break;

        case "agentQueuedMessage":
          dispatch({
            type: "ENQUEUE_MESSAGE",
            id: msg.queueId,
            text: msg.displayText ?? msg.text,
            fullText:
              msg.displayText && msg.displayText !== msg.text
                ? msg.text
                : undefined,
            isSlashCommand: msg.isSlashCommand,
            slashCommandLabel: msg.slashCommandLabel,
            attachments: msg.attachments,
            images: msg.images,
            documents: msg.documents,
            displayMedia: msg.displayMedia,
            source: "browser",
          });
          messageQueueRef.current = [
            ...messageQueueRef.current,
            {
              id: msg.queueId,
              text: msg.displayText ?? msg.text,
              ...(msg.displayText && msg.displayText !== msg.text
                ? { fullText: msg.text }
                : {}),
              ...(msg.isSlashCommand ? { isSlashCommand: true } : {}),
              ...(msg.slashCommandLabel
                ? { slashCommandLabel: msg.slashCommandLabel }
                : {}),
              ...(msg.attachments ? { attachments: msg.attachments } : {}),
              ...(msg.images ? { images: msg.images } : {}),
              ...(msg.documents ? { documents: msg.documents } : {}),
              ...(msg.displayMedia ? { displayMedia: msg.displayMedia } : {}),
              source: "browser",
            },
          ];
          break;

        case "agentRemoveQueuedMessage":
          dispatch({ type: "REMOVE_FROM_QUEUE", id: msg.queueId });
          messageQueueRef.current = messageQueueRef.current.filter(
            (q) => q.id !== msg.queueId,
          );
          break;

        case "agentQueueInterjectionReady":
          dispatch({
            type: "MARK_QUEUE_INTERJECTION_READY",
            id: msg.queueId,
            ready: msg.ready,
          });
          messageQueueRef.current = messageQueueRef.current.map((q) =>
            q.id === msg.queueId ? { ...q, interjectionReady: msg.ready } : q,
          );
          break;

        case "agentCommittedUserMessage":
          dispatch({
            type: "ADD_COMMITTED_USER_MESSAGE",
            text: (msg.displayText as string | undefined) ?? msg.text,
            isSlashCommand:
              (msg.isSlashCommand as boolean | undefined) ?? false,
            slashCommandLabel:
              (msg.slashCommandLabel as string | undefined) ??
              ((msg.isSlashCommand as boolean | undefined)
                ? (msg.displayText as string | undefined)
                : undefined),
            origin: msg.origin as "vscode" | "browser" | undefined,
            displayMedia: msg.displayMedia,
          });
          break;

        case "agentBgSessionsUpdate":
          setBgSessions(msg.sessions as BgSessionInfoProps[]);
          break;

        // Background-only stream events are intentionally not rendered into the
        // foreground transcript. When the transcript overlay is open, project the
        // matching background session through the same reducer used by foreground
        // chat so rendering stays identical and live.
        case "agentBgThinkingStart":
          setTranscriptView((prev) =>
            reduceOpenTranscript(
              prev,
              msg.sessionId,
              { type: "THINKING_START", thinkingId: msg.thinkingId },
              bgTranscriptStreamingOverride(msg.type),
            ),
          );
          break;
        case "agentBgThinkingDelta":
          setTranscriptView((prev) =>
            reduceOpenTranscript(
              prev,
              msg.sessionId,
              {
                type: "THINKING_DELTA",
                thinkingId: msg.thinkingId,
                text: msg.text,
              },
              bgTranscriptStreamingOverride(msg.type),
            ),
          );
          break;
        case "agentBgThinkingEnd":
          setTranscriptView((prev) =>
            reduceOpenTranscript(prev, msg.sessionId, {
              type: "THINKING_END",
              thinkingId: msg.thinkingId,
            }),
          );
          break;
        case "agentBgTextDelta":
          setTranscriptView((prev) =>
            reduceOpenTranscript(
              prev,
              msg.sessionId,
              { type: "TEXT_DELTA", text: msg.text },
              bgTranscriptStreamingOverride(msg.type),
            ),
          );
          break;

        case "agentBgToolStart":
          setTranscriptView((prev) =>
            reduceOpenTranscript(
              prev,
              msg.sessionId,
              {
                type: "TOOL_START",
                toolCallId: msg.toolCallId,
                toolName: msg.toolName,
                input: msg.input,
              },
              bgTranscriptStreamingOverride(msg.type),
            ),
          );
          break;
        case "agentBgToolInputDelta":
          setTranscriptView((prev) =>
            reduceOpenTranscript(
              prev,
              msg.sessionId,
              {
                type: "TOOL_INPUT_DELTA",
                toolCallId: msg.toolCallId,
                partialJson: msg.partialJson,
              },
              bgTranscriptStreamingOverride(msg.type),
            ),
          );
          break;
        case "agentBgToolComplete":
          setTranscriptView((prev) =>
            reduceOpenTranscript(
              prev,
              msg.sessionId,
              {
                type: "TOOL_COMPLETE",
                toolCallId: msg.toolCallId,
                toolName: msg.toolName,
                result: msg.result,
                resultImages: msg.resultImages,
                resultDocuments: msg.resultDocuments,
                durationMs: msg.durationMs,
                input: msg.input,
              },
              bgTranscriptStreamingOverride(msg.type),
            ),
          );
          break;
        case "agentBgApiRequest":
          setTranscriptView((prev) =>
            reduceOpenTranscript(prev, msg.sessionId, {
              type: "API_REQUEST",
              requestId: msg.requestId,
              model: msg.model,
              reasoningEffort: msg.reasoningEffort,
              inputTokens: msg.inputTokens,
              uncachedInputTokens: msg.uncachedInputTokens,
              outputTokens: msg.outputTokens,
              cacheReadTokens: msg.cacheReadTokens,
              cacheCreationTokens: msg.cacheCreationTokens,
              durationMs: msg.durationMs,
              timeToFirstToken: msg.timeToFirstToken,
              usedPreviousResponseId: msg.usedPreviousResponseId,
              previousResponseIdFallback: msg.previousResponseIdFallback,
              promptCacheKey: msg.promptCacheKey,
              promptCacheRetention: msg.promptCacheRetention,
              storeResponseState: msg.storeResponseState,
              providerResponseId: msg.providerResponseId,
              contextBreakdown: msg.contextBreakdown,
            }),
          );
          break;
        case "agentBgError":
          setTranscriptView((prev) =>
            reduceOpenTranscript(
              prev,
              msg.sessionId,
              {
                type: "ERROR",
                error: msg.error,
                retryable: msg.retryable,
                code: msg.code,
                actions: msg.actions,
              },
              bgTranscriptStreamingOverride(msg.type),
            ),
          );
          break;
        case "agentBgTodoUpdate":
          setTranscriptView((prev) =>
            reduceOpenTranscript(prev, msg.sessionId, {
              type: "TODO_UPDATE",
              todos: msg.todos,
            }),
          );
          break;
        case "agentBgWarning":
          setTranscriptView((prev) =>
            reduceOpenTranscript(prev, msg.sessionId, {
              type: "ADD_WARNING",
              message: msg.message,
              retryDelayMs: msg.retryDelayMs,
              retryAt: msg.retryAt,
              retryAttempt: msg.retryAttempt,
              retryMaxAttempts: msg.retryMaxAttempts,
            }),
          );
          break;
        case "agentBgStatusUpdate":
          setTranscriptView((prev) =>
            reduceOpenTranscript(prev, msg.sessionId, {
              type: "SET_STATUS_OVERRIDE",
              message: msg.message,
            }),
          );
          break;
        case "agentBgFinalMarker":
          setTranscriptView((prev) =>
            reduceOpenTranscript(prev, msg.sessionId, {
              type: "SET_FINAL_MARKER",
              marker: msg.marker,
            }),
          );
          break;
        case "agentBgCondenseStart":
          setTranscriptView((prev) =>
            reduceOpenTranscript(prev, msg.sessionId, {
              type: "CONDENSE_START",
            }),
          );
          break;
        case "agentBgCondense":
          setTranscriptView((prev) =>
            reduceOpenTranscript(prev, msg.sessionId, {
              type: "ADD_CONDENSE",
              prevInputTokens: msg.prevInputTokens,
              newInputTokens: msg.newInputTokens,
              durationMs: msg.durationMs,
              validationWarnings: msg.validationWarnings,
            }),
          );
          break;
        case "agentBgCondenseError":
          setTranscriptView((prev) =>
            reduceOpenTranscript(prev, msg.sessionId, {
              type: "ADD_CONDENSE_ERROR",
              errorMessage: msg.error,
              retryable: msg.retryable,
              code: msg.code,
              actions: msg.actions,
            }),
          );
          break;
        case "agentBgInterjection":
          setTranscriptView((prev) =>
            reduceOpenTranscript(
              prev,
              msg.sessionId,
              {
                type: "ADD_INTERJECTION",
                text: msg.displayText ?? msg.text,
                isSlashCommand: msg.isSlashCommand,
                slashCommandLabel: msg.slashCommandLabel,
                displayMedia: msg.displayMedia,
              },
              bgTranscriptStreamingOverride(msg.type),
            ),
          );
          break;
        case "agentBgDone": {
          const bgSessionId = msg.sessionId;
          setTranscriptView((prev) =>
            reduceOpenTranscript(
              prev,
              bgSessionId,
              { type: "DONE" },
              { streaming: false, statusOverride: null },
            ),
          );
          if (
            msg.completion &&
            shouldProjectBackgroundCompletion(
              msg.parentSessionId,
              fullStateRef.current.chatState.sessionId,
            )
          ) {
            dispatch({ type: "BG_AGENT_DONE", completion: msg.completion });
          }
          break;
        }

        case "agentBtwLoading":
          setBtwStates((previous) => ({
            ...previous,
            [msg.sessionId]: {
              requestId: msg.requestId,
              question: msg.question,
              answer: "",
              tools: [],
              warnings: [],
            },
          }));
          break;

        case "agentBtwProgress":
          setBtwStates((previous) => {
            const state = previous[msg.sessionId];
            if (!state || state.requestId !== msg.requestId) return previous;
            return {
              ...previous,
              [msg.sessionId]: {
                ...state,
                answer: msg.answer,
                tools: msg.tools,
                warnings: msg.warnings,
                budget: msg.budget,
              },
            };
          });
          break;

        case "agentBtwResponse":
          setBtwStates((previous) => {
            const state = previous[msg.sessionId];
            if (!state || state.requestId !== msg.requestId) return previous;
            return {
              ...previous,
              [msg.sessionId]: {
                ...state,
                answer: msg.answer,
                error: msg.error,
                done: true,
                cancelled: msg.cancelled,
                tools: msg.tools ?? state.tools,
                warnings: msg.warnings ?? state.warnings,
                budget: msg.budget ?? state.budget,
              },
            };
          });
          break;

        case "agentWorktreeSetupStarted":
          setWorktreeSetupState({
            requestId: msg.requestId,
            input: msg.input,
            answer: "",
            phase: "configuring",
            tools: [],
            warnings: [],
          });
          break;

        case "agentWorktreeSetupProgress":
          setWorktreeSetupState((previous) =>
            previous?.requestId === msg.requestId
              ? {
                  ...previous,
                  answer: msg.answer,
                  tools: msg.tools,
                  warnings: msg.warnings,
                  budget: msg.budget,
                }
              : previous,
          );
          break;

        case "agentWorktreeSetupAwaitingInput":
          setWorktreeSetupState((previous) =>
            previous?.requestId === msg.requestId
              ? {
                  ...previous,
                  phase: "awaiting_input",
                  answer: msg.answer,
                  conversation: msg.conversation,
                  tools: msg.tools,
                  warnings: msg.warnings,
                  budget: msg.budget,
                }
              : previous,
          );
          break;

        case "agentWorktreeSetupReady":
          setWorktreeSetupState((previous) =>
            previous?.requestId === msg.requestId
              ? {
                  ...previous,
                  phase: "ready",
                  answer: msg.answer,
                  config: msg.config,
                  tools: msg.tools,
                  warnings: msg.warnings,
                  budget: msg.budget,
                }
              : previous,
          );
          break;

        case "agentWorktreeSetupLaunching":
          setWorktreeSetupState((previous) =>
            previous?.requestId === msg.requestId
              ? {
                  ...previous,
                  phase: "launching",
                  config: msg.config,
                }
              : previous,
          );
          break;

        case "agentWorktreeSetupResult":
          setWorktreeSetupState((previous) =>
            previous?.requestId === msg.requestId
              ? {
                  ...previous,
                  phase: msg.phase,
                  message: msg.message,
                  config: msg.config ?? previous.config,
                }
              : previous,
          );
          break;

        case "agentPairingCode":
          dispatch({
            type: "ADD_PAIRING_CODE",
            pairingId: msg.pairingId,
            code: msg.code,
            expiresAt: msg.expiresAt,
            pairingUrls: msg.pairingUrls,
          });
          break;

        case "agentPairingStatus":
          dispatch({
            type: "UPDATE_PAIRING_STATUS",
            pairingId: msg.pairingId,
            status: msg.status,
            deviceLabel: msg.deviceLabel,
          });
          break;

        case "showBgTranscript": {
          const sessionId = msg.sessionId as string;
          const converted = agentMessagesToChatMessages(
            (msg.messages as unknown[]) ?? [],
          );
          const bgInfo = bgSessionsRef.current.find((s) => s.id === sessionId);
          setTranscriptView({
            sessionId,
            task: msg.task as string,
            messages: converted,
            todos: msg.todos ?? [],
            statusOverride: null,
            streaming:
              bgInfo?.status === "streaming" ||
              bgInfo?.status === "tool_executing",
            visible: true,
          });
          break;
        }

        case "agentDetectQuestionResult": {
          const active = activeDetectRequestRef.current;
          if (!active || active.requestId !== msg.requestId) break;
          activeDetectRequestRef.current = null;

          if (streamingRef.current) break;
          const snapshot = fullStateRef.current;
          if (snapshot.questionRequest) break;
          if (
            snapshot.dismissedDetectedQuestionIds.includes(active.messageId)
          ) {
            break;
          }
          const currentLast = snapshot.messages[snapshot.messages.length - 1];
          if (!currentLast || currentLast.id !== active.messageId) break;
          if (hasFinalContinueAction(currentLast)) {
            dispatch({ type: "SET_DETECTED_QUESTION", detectedQuestion: null });
            break;
          }

          let detected = msg.detected;
          if (msg.fallback) {
            detected = detectQuestionFromAssistantText(active.assistantText);
          }

          dispatch({
            type: "SET_DETECTED_QUESTION",
            detectedQuestion: detected
              ? { ...detected, messageId: active.messageId }
              : null,
          });
          break;
        }
      }
    },
  });

  const handleSend = useCallback(
    (
      text: string,
      attachments: string[] = [],
      displayText?: string,
      slashCommandLabel?: string,
      media?: Array<{
        name: string;
        mimeType: string;
        base64: string;
        kind: "image" | "document";
      }>,
      origin: "user" | "autoContinue" = "user",
      interject = false,
    ) => {
      const userMessageId = randomId();
      if (origin === "autoContinue") {
        pendingAutoContinueUserMessageIdRef.current = userMessageId;
      } else {
        pendingAutoContinueUserMessageIdRef.current = null;
      }
      // Build message text: prepend attached file references
      let fullText = text;
      if (attachments.length > 0) {
        const fileRefs = attachments.map((p) => `[Attached: ${p}]`).join("\n");
        fullText = fileRefs + "\n\n" + text;
      }

      // Split media into images and documents for the extension
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
      const displayMedia = mediaToDisplayMedia(images, documents);

      // Build display text with media indicators
      const isSlashCommand = slashCommandLabel !== undefined;
      let displayWithMedia = displayText ?? fullText;
      if (images.length > 0 || documents.length > 0) {
        const indicators: string[] = [];
        if (images.length > 0)
          indicators.push(
            `${images.length} image${images.length > 1 ? "s" : ""}`,
          );
        if (documents.length > 0)
          indicators.push(
            `${documents.length} file${documents.length > 1 ? "s" : ""}`,
          );
        displayWithMedia =
          `[${indicators.join(", ")} attached]\n` + displayWithMedia;
      }

      // While streaming, enqueue the message instead of sending immediately.
      if (state.streaming) {
        const queueId = randomId();
        const queueItem = {
          id: queueId,
          text: displayWithMedia,
          ...(displayWithMedia !== fullText ? { fullText } : {}),
          ...(isSlashCommand ? { isSlashCommand: true } : {}),
          ...(slashCommandLabel ? { slashCommandLabel } : {}),
          ...(attachments.length > 0 ? { attachments } : {}),
          ...(images.length > 0 ? { images } : {}),
          ...(documents.length > 0 ? { documents } : {}),
          ...(displayMedia ? { displayMedia } : {}),
          ...(interject ? { interjectionReady: true } : {}),
          source: "vscode" as const,
        };
        messageQueueRef.current = [...messageQueueRef.current, queueItem];
        dispatch({
          type: "ENQUEUE_MESSAGE",
          id: queueId,
          text: displayWithMedia,
          // Preserve the clean payload text whenever the display form differs
          // (e.g. slash commands or media indicators) so queue drain sends the
          // actual agent input rather than UI-only decoration.
          fullText: displayWithMedia !== fullText ? fullText : undefined,
          isSlashCommand,
          slashCommandLabel,
          attachments: attachments.length > 0 ? attachments : undefined,
          images: images.length > 0 ? images : undefined,
          documents: documents.length > 0 ? documents : undefined,
          displayMedia,
          source: "vscode",
        });
        if (interject) {
          dispatch({
            type: "MARK_QUEUE_INTERJECTION_READY",
            id: queueId,
            ready: true,
          });
        }
        if (interject) {
          vscodeApi.postMessage({
            command: "agentInterjectQueuedMessage",
            sessionId: stateRef.current.sessionId,
            queueId,
            text: fullText,
            displayText: displayWithMedia,
            isSlashCommand,
            slashCommandLabel,
            attachments,
            images: images.length > 0 ? images : undefined,
            documents: documents.length > 0 ? documents : undefined,
          });
        }
        return;
      }

      // displayText is shown in the chat UI; fullText is sent to the agent
      if (!stateRef.current.sessionId) {
        const snapshot = workspaceSnapshotRef.current;
        const tabId = pinnedTabId ?? snapshot?.focusedTabId;
        if (tabId) {
          optimisticFirstSendRef.current = { tabId, sessionId: null };
        }
      }
      streamingRef.current = true;
      dispatch({
        type: "ADD_USER_MESSAGE",
        id: userMessageId,
        text: displayWithMedia,
        isSlashCommand,
        slashCommandLabel,
        displayMedia,
      });
      // Log media being sent for debugging
      if (images.length > 0 || documents.length > 0) {
        console.log(
          `[agentlink:media] sending agentSend with ${images.length} image(s), ${documents.length} document(s)`,
        );
        for (const img of images) {
          console.log(
            `[agentlink:media]   image: name="${img.name}" mimeType="${img.mimeType}" base64Length=${img.base64?.length ?? 0}`,
          );
        }
      }
      vscodeApi.postMessage({
        command: "agentSend",
        text: fullText,
        displayText: displayWithMedia,
        isSlashCommand,
        slashCommandLabel,
        attachments,
        images: images.length > 0 ? images : undefined,
        documents: documents.length > 0 ? documents : undefined,
        sessionId: stateRef.current.sessionId,
        mode: pendingSessionSelectionsRef.current.mode ?? stateRef.current.mode,
        reasoningEffort: pendingSessionSelectionsRef.current.reasoningEffort,
        thinkingEnabled:
          pendingSessionSelectionsRef.current.reasoningEffort === undefined
            ? undefined
            : pendingSessionSelectionsRef.current.reasoningEffort !== "none",
        model:
          pendingSessionSelectionsRef.current.model ?? stateRef.current.model,
        ...(pendingSessionSelectionsRef.current.agentWriteApproval
          ? {
              agentWriteApproval:
                pendingSessionSelectionsRef.current.agentWriteApproval,
            }
          : {}),
        ...(pendingSessionSelectionsRef.current.commandApprovalPolicy
          ? {
              commandApprovalPolicy:
                pendingSessionSelectionsRef.current.commandApprovalPolicy,
            }
          : {}),
      });
    },
    [vscodeApi, state.streaming, state.chatState.reasoningEffort],
  );

  const handleInterject = useCallback(
    (
      text: string,
      attachments: string[] = [],
      displayText?: string,
      slashCommandLabel?: string,
      media?: Array<{
        name: string;
        mimeType: string;
        base64: string;
        kind: "image" | "document";
      }>,
    ) => {
      handleSend(
        text,
        attachments,
        displayText,
        slashCommandLabel,
        media,
        "user",
        true,
      );
    },
    [handleSend],
  );

  const handleStop = useCallback(() => {
    if (stateRef.current.sessionId) {
      activeDetectRequestRef.current = null;
      dispatch({ type: "CLEAR_INTERACTION_PROMPTS" });
      setElicitation(null);
      setRemoteQuestionProgress(null);
      vscodeApi.postMessage({
        command: "agentStop",
        sessionId: stateRef.current.sessionId,
      });
    }
  }, [vscodeApi]);

  const handleResumeInterruptedSession = useCallback(() => {
    const sessionId = stateRef.current.sessionId;
    if (!sessionId) return;
    streamingRef.current = true;
    dispatch({
      type: "ADD_USER_MESSAGE",
      text: "Resume interrupted session",
      isSlashCommand: true,
      slashCommandLabel: "/resume interrupted session",
    });
    vscodeApi.postMessage({
      command: "agentResumeSession",
      sessionId,
    });
  }, [vscodeApi]);

  const handleToggleAutoContinue = useCallback((enabled: boolean) => {
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

  const handleDetectedQuestionAnswer = useCallback(
    (payload: string) => {
      handleSend(payload);
    },
    [handleSend],
  );

  const handleDismissDetectedQuestion = useCallback((messageId: string) => {
    dispatch({ type: "DISMISS_DETECTED_QUESTION", messageId });
  }, []);

  useEffect(() => {
    const wasStreaming = previousStreamingRef.current;
    const isStreaming = state.streaming;

    if (!wasStreaming || isStreaming) {
      previousStreamingRef.current = isStreaming;
      return;
    }

    previousStreamingRef.current = isStreaming;

    if (state.questionRequest) {
      dispatch({ type: "SET_DETECTED_QUESTION", detectedQuestion: null });
      return;
    }

    const lastMsg = state.messages[state.messages.length - 1];
    if (!lastMsg || lastMsg.role !== "assistant") {
      dispatch({ type: "SET_DETECTED_QUESTION", detectedQuestion: null });
      return;
    }

    if (state.dismissedDetectedQuestionIds.includes(lastMsg.id)) {
      dispatch({ type: "SET_DETECTED_QUESTION", detectedQuestion: null });
      return;
    }

    if (hasFinalContinueAction(lastMsg)) {
      dispatch({ type: "SET_DETECTED_QUESTION", detectedQuestion: null });
      return;
    }

    const assistantText = (lastMsg.blocks ?? [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    if (!assistantText) {
      dispatch({ type: "SET_DETECTED_QUESTION", detectedQuestion: null });
      return;
    }

    const requestId = `detect-question-${lastMsg.id}-${Date.now()}`;
    activeDetectRequestRef.current = {
      requestId,
      messageId: lastMsg.id,
      assistantText,
    };
    vscodeApi.postMessage({
      command: "agentDetectQuestion",
      requestId,
      messageId: lastMsg.id,
      text: assistantText,
    });
  }, [
    state.streaming,
    state.messages,
    state.questionRequest,
    state.dismissedDetectedQuestionIds,
    vscodeApi,
  ]);

  const handleStopBackground = useCallback(
    (sessionId: string) => {
      vscodeApi.postMessage({ command: "agentStop", sessionId });
    },
    [vscodeApi],
  );

  const handleFinalMarkerContinue = useCallback(
    (prompt: string) => {
      dispatch({ type: "CLEAR_FINAL_MARKER_CONTINUE_ACTIONS" });
      handleSend(prompt);
    },
    [handleSend],
  );

  useEffect(() => {
    const sessionId = state.chatState.sessionId;
    if (autoContinueSessionIdRef.current === sessionId) return;
    autoContinueSessionIdRef.current = sessionId;
    autoContinuedMessageIdsRef.current.clear();
    autoContinueCountRef.current = 0;
    pendingAutoContinueUserMessageIdRef.current = null;
    if (autoContinueEnabled) {
      setAutoContinueEnabled(false);
      setAutoContinueStatus("Auto Continue paused after session change.");
    }
  }, [autoContinueEnabled, state.chatState.sessionId]);

  // Keep the extension informed of how many locally queued (non-browser)
  // messages are waiting so the agent can skip the todo auto-continue and let
  // the queue flush instead. Browser-sourced entries are already tracked
  // extension-side via the foreground projection.
  useEffect(() => {
    const sessionId = state.chatState.sessionId;
    if (!sessionId) return;
    vscodeApi.postMessage({
      command: "agentQueuedMessageCount",
      sessionId,
      count: state.messageQueue.filter((q) => q.source !== "browser").length,
    });
  }, [state.messageQueue, state.chatState.sessionId]);

  useEffect(() => {
    if (!autoContinueEnabled || state.streaming) return;
    if (!state.chatState.sessionId) return;
    if (state.questionRequest || globalApproval || state.approvalRequest)
      return;

    const lastMessage = state.messages[state.messages.length - 1];
    if (lastMessage?.error) {
      setAutoContinueEnabled(false);
      setAutoContinueStatus("Auto Continue paused after an agent error.");
      return;
    }

    const action = getLatestAutoContinueAction(state.messages);
    if (!action) {
      const latest = getLatestFinalMessageMarker(state.messages);
      if (!latest || latest.marker.autoContinueStopReason) return;
      const reason =
        latest.marker.status === "waiting_for_user"
          ? "Auto Continue stopped because the agent is waiting for input."
          : `Auto Continue stopped because the task status is ${latest.marker.status.replaceAll("_", " ")}.`;
      setAutoContinueEnabled(false);
      setAutoContinueStatus(reason);
      dispatch({
        type: "MARK_AUTO_CONTINUE_STOPPED",
        messageId: latest.messageId,
        reason,
      });
      return;
    }
    if (autoContinuedMessageIdsRef.current.has(action.messageId)) return;

    const pendingAutoContinueUserMessageId =
      pendingAutoContinueUserMessageIdRef.current;
    if (
      pendingAutoContinueUserMessageId &&
      !turnMadeProgress(state.messages, pendingAutoContinueUserMessageId)
    ) {
      setAutoContinueEnabled(false);
      setAutoContinueStatus(AUTO_CONTINUE_NO_PROGRESS_REASON);
      pendingAutoContinueUserMessageIdRef.current = null;
      dispatch({
        type: "MARK_AUTO_CONTINUE_STOPPED",
        messageId: action.messageId,
        reason: AUTO_CONTINUE_NO_PROGRESS_REASON,
      });
      return;
    }

    if (autoContinueCountRef.current >= AUTO_CONTINUE_MAX_TURNS) {
      const reason = `Auto Continue stopped after ${AUTO_CONTINUE_MAX_TURNS} turns to avoid an infinite loop.`;
      setAutoContinueEnabled(false);
      setAutoContinueStatus(reason);
      dispatch({
        type: "MARK_AUTO_CONTINUE_STOPPED",
        messageId: action.messageId,
        reason,
      });
      return;
    }

    autoContinuedMessageIdsRef.current.add(action.messageId);
    autoContinueCountRef.current += 1;
    setAutoContinueStatus(
      `Auto Continue sent ${autoContinueCountRef.current}/${AUTO_CONTINUE_MAX_TURNS}.`,
    );
    dispatch({ type: "CLEAR_FINAL_MARKER_CONTINUE_ACTIONS" });
    handleSend(
      action.prompt,
      [],
      undefined,
      undefined,
      undefined,
      "autoContinue",
    );
  }, [
    autoContinueEnabled,
    globalApproval,
    handleSend,
    state.approvalRequest,
    state.chatState.sessionId,
    state.messages,
    state.questionRequest,
    state.streaming,
  ]);

  const handleOpenBgTranscript = useCallback(
    (sessionId: string) => {
      if (
        shouldReuseBackgroundTranscript(transcriptView?.sessionId, sessionId)
      ) {
        setTranscriptView((current) =>
          current ? { ...current, visible: true } : current,
        );
        const bgInfo = bgSessionsRef.current.find(
          (session) => session.id === sessionId,
        );
        if (
          bgInfo?.status === "streaming" ||
          bgInfo?.status === "tool_executing" ||
          bgInfo?.status === "awaiting_approval"
        ) {
          return;
        }
      }
      vscodeApi.postMessage({ command: "openBgTranscript", sessionId });
    },
    [transcriptView?.sessionId, vscodeApi],
  );

  const handleLoadEarlierSessionMessages = useCallback(() => {
    const snapshot = fullStateRef.current;
    const sessionId = snapshot.chatState.sessionId;
    if (
      !sessionId ||
      snapshot.loadedUserTurnOffset <= 0 ||
      historyLoadPendingRef.current
    ) {
      return;
    }
    historyLoadPendingRef.current = true;
    vscodeApi.postMessage({
      command: "agentLoadEarlierSessionMessages",
      sessionId,
      beforeUserTurnOffset: snapshot.loadedUserTurnOffset,
    });
  }, [vscodeApi]);
  const handleSteerBackground = useCallback(
    (sessionId: string, message: string) => {
      vscodeApi.postMessage({ command: "steerBgAgent", sessionId, message });
    },
    [vscodeApi],
  );
  const handleDetachBackground = useCallback(
    (sessionId: string) => {
      vscodeApi.postMessage({ command: "detachBgAgent", sessionId });
    },
    [vscodeApi],
  );
  const handleRetryBackground = useCallback(
    (sessionId: string) => {
      vscodeApi.postMessage({ command: "retryBgAgent", sessionId });
    },
    [vscodeApi],
  );
  const handleArchiveBackground = useCallback(
    (sessionId: string) => {
      vscodeApi.postMessage({ command: "archiveBgAgent", sessionId });
    },
    [vscodeApi],
  );
  const handlePauseBackground = useCallback(
    (sessionId: string) => {
      vscodeApi.postMessage({ command: "pauseBgAgent", sessionId });
    },
    [vscodeApi],
  );
  const handleResumeBackground = useCallback(
    (sessionId: string) => {
      vscodeApi.postMessage({ command: "resumeBgAgent", sessionId });
    },
    [vscodeApi],
  );
  const handleNewSession = useCallback(
    (projectId?: string) => {
      startupRestorePendingRef.current = false;
      dispatch({ type: "SET_RESTORING_SESSION", restoring: false });
      setTranscriptView(null);
      // Optimistically clear to an empty chat: the host may still be busy
      // parsing a large restored transcript, and the New Chat click must not
      // appear dead until that finishes. Late restored hydrations for the
      // replaced session are dropped (startupRestorePendingRef is false),
      // and the host's own new-chat hydration re-establishes the session.
      dispatch({ type: "NEW_SESSION" });
      streamingRef.current = false;
      stateRef.current = {
        ...stateRef.current,
        sessionId: null,
        streaming: false,
      };
      vscodeApi.postMessage({
        command: "chatTabNewChat",
        mode: stateRef.current.mode,
        projectId,
      });
    },
    [vscodeApi],
  );

  const updateSessionlessSelections = useCallback(
    (
      updates: Partial<
        Pick<
          typeof stateRef.current,
          | "mode"
          | "model"
          | "reasoningEffort"
          | "thinkingEnabled"
          | "agentWriteApproval"
          | "commandApprovalPolicy"
        >
      >,
    ) => {
      const snapshot = workspaceSnapshotRef.current;
      const tabId = pinnedTabId ?? snapshot?.focusedTabId ?? null;
      if (pendingSessionSelectionsRef.current.tabId !== tabId) {
        pendingSessionSelectionsRef.current = { tabId };
      }
      Object.assign(pendingSessionSelectionsRef.current, updates);
      stateRef.current = { ...stateRef.current, ...updates };
      dispatch({ type: "SET_SESSIONLESS_SELECTIONS", selections: updates });
    },
    [pinnedTabId],
  );

  const handleSwitchMode = useCallback(
    (slug: string) => {
      if (stateRef.current.sessionId) {
        vscodeApi.postMessage(
          toVsCodeSelectionMessage({ type: "mode", mode: slug }),
        );
      } else {
        setTranscriptView(null);
        updateSessionlessSelections({ mode: slug });
      }
    },
    [updateSessionlessSelections, vscodeApi],
  );

  const handleSelectModel = useCallback(
    (modelId: string) => {
      if (!stateRef.current.sessionId) {
        updateSessionlessSelections({ model: modelId });
        return;
      }
      vscodeApi.postMessage(
        toVsCodeSelectionMessage({ type: "model", model: modelId }),
      );
    },
    [updateSessionlessSelections, vscodeApi],
  );

  const handleSetCondenseThreshold = useCallback(
    (threshold: number) => {
      vscodeApi.postMessage({
        command: "agentSetCondenseThreshold",
        threshold,
      });
    },
    [vscodeApi],
  );

  const handleSetupAction = useCallback(
    (
      action:
        | "codex"
        | "openai-api-key"
        | "anthropic-api-key"
        | "configure-provider",
    ) => {
      switch (action) {
        case "codex":
          vscodeApi.postMessage({
            command: "agentCodexSignIn",
            method: "oauth",
          });
          break;
        case "openai-api-key":
          vscodeApi.postMessage({
            command: "agentCodexSignIn",
            method: "apiKey",
          });
          break;
        case "anthropic-api-key":
          vscodeApi.postMessage({ command: "agentAnthropicSignIn" });
          break;
        case "configure-provider":
          vscodeApi.postMessage({
            command: "agentConfigureOpenAiCompatibleModel",
          });
          break;
      }
    },
    [vscodeApi],
  );

  const handleSignIn = useCallback(
    (provider: string) => {
      if (
        provider.toLowerCase() === "codex" ||
        provider.toLowerCase() === "openai"
      ) {
        vscodeApi.postMessage({ command: "agentCodexSignIn" });
      } else if (provider.toLowerCase() === "anthropic") {
        vscodeApi.postMessage({ command: "agentAnthropicSignIn" });
      } else if (provider.toLowerCase().startsWith("openai-compatible:")) {
        vscodeApi.postMessage({
          command: "agentOpenAiCompatibleSignIn",
          provider,
        });
      }
    },
    [vscodeApi],
  );

  const handleSetAgentWriteApproval = useCallback(
    (mode: WriteApprovalSelection) => {
      if (!stateRef.current.sessionId) {
        updateSessionlessSelections({ agentWriteApproval: mode });
        return;
      }
      vscodeApi.postMessage(
        toVsCodeSelectionMessage({ type: "writeApproval", mode }),
      );
    },
    [updateSessionlessSelections, vscodeApi],
  );

  const handleSetCommandApprovalPolicy = useCallback(
    (policy: CommandApprovalPolicy) => {
      if (!stateRef.current.sessionId) {
        updateSessionlessSelections({ commandApprovalPolicy: policy });
        return;
      }
      vscodeApi.postMessage(
        toVsCodeSelectionMessage({ type: "commandApprovalPolicy", policy }),
      );
    },
    [updateSessionlessSelections, vscodeApi],
  );

  const handleExecuteBuiltinCommand = useCallback(
    (name: string, args: string) => {
      switch (name) {
        case "new":
          startupRestorePendingRef.current = false;
          dispatch({ type: "SET_RESTORING_SESSION", restoring: false });
          setTranscriptView(null);
          vscodeApi.postMessage({
            command: "chatTabNewChat",
            mode: stateRef.current.mode,
          });
          break;

        case "mode": {
          const slug = args.trim();
          if (slug) handleSwitchMode(slug);
          break;
        }
        case "model":
          handleSelectModel(args.trim());
          break;
        case "help":
          // Inject a help message as user text so the agent responds
          vscodeApi.postMessage({
            command: "agentSend",
            text: "List all available slash commands and what they do.",
            attachments: [],
            sessionId: stateRef.current.sessionId,
            mode:
              pendingSessionSelectionsRef.current.mode ?? stateRef.current.mode,
            reasoningEffort: "none",
            thinkingEnabled: false,
            ...(pendingSessionSelectionsRef.current.model
              ? { model: pendingSessionSelectionsRef.current.model }
              : {}),
            ...(pendingSessionSelectionsRef.current.agentWriteApproval
              ? {
                  agentWriteApproval:
                    pendingSessionSelectionsRef.current.agentWriteApproval,
                }
              : {}),
            ...(pendingSessionSelectionsRef.current.commandApprovalPolicy
              ? {
                  commandApprovalPolicy:
                    pendingSessionSelectionsRef.current.commandApprovalPolicy,
                }
              : {}),
          });
          break;
        case "fleet":
          setShowFleetRequest((request) => request + 1);
          break;
        case "environment":
          setEnvironmentPanelOpen(true);
          setMemoryPanelOpen(false);
          setMcpManagerSnapshot(null);
          setAgentPluginManagerSnapshot(null);
          setProviderUsage(null);
          vscodeApi.postMessage({
            command: "agentRefreshDebugInfo",
            sessionId: stateRef.current.sessionId,
          });
          break;
        case "memory": {
          setEnvironmentPanelOpen(false);
          const request: MemoryInspectionQueryRequest = {
            scope: "global",
            limit: 100,
          };
          memoryPanelQueryRef.current = request;
          setMemoryPanelOpen(true);
          setMemoryPanelLoading(true);
          setMemoryPanelError(null);
          setMcpManagerSnapshot(null);
          setAgentPluginManagerSnapshot(null);
          setProviderUsage(null);
          vscodeApi.postMessage({
            command: "agentMemoryQuery",
            requestId: beginMemoryPanelRequest(),
            request,
            open: true,
          });
          return;
        }
      }

      if (isForwardedBuiltinCommand("vscode", name)) {
        vscodeApi.postMessage({ command: "agentSlashCommand", name, args });
      }
    },
    [vscodeApi, handleSelectModel, handleSwitchMode],
  );

  const handleElicitSubmit = useCallback(
    (id: string, values: McpElicitationValues) => {
      vscodeApi.postMessage({
        command: "agentFormElicitationResponse",
        id,
        action: "accept",
        values,
      });
    },
    [vscodeApi],
  );

  const handleElicitCancel = useCallback(
    (id: string) => {
      vscodeApi.postMessage({
        command: "agentFormElicitationResponse",
        id,
        action: "cancel",
      });
    },
    [vscodeApi],
  );

  const submitUrlElicitation = useCallback(
    (id: string, action: "accept" | "cancel" | "decline") => {
      if (action !== "accept") {
        setUrlElicitation((current) => (current?.id === id ? null : current));
      }
      vscodeApi.postMessage({
        command: "agentUrlElicitationResponse",
        id,
        action,
      });
    },
    [vscodeApi],
  );

  const handleUrlElicitAccept = useCallback(
    (id: string, _url: string) => {
      submitUrlElicitation(id, "accept");
    },
    [submitUrlElicitation],
  );

  const handleUrlElicitDecline = useCallback(
    (id: string) => submitUrlElicitation(id, "decline"),
    [submitUrlElicitation],
  );

  const handleUrlElicitCancel = useCallback(
    (id: string) => submitUrlElicitation(id, "cancel"),
    [submitUrlElicitation],
  );

  const handleForwardedApprovalSubmit = useCallback(
    (data: Omit<DecisionMessage, "type">) => {
      const submittedApprovalId = data.id;
      const approvalKind =
        globalApprovalRef.current?.kind ??
        fullStateRef.current.approvalRequest?.kind;
      if (globalApprovalRef.current?.id === submittedApprovalId) {
        globalApprovalRef.current = null;
        setGlobalApproval(null);
      } else {
        dispatch({ type: "CLEAR_APPROVAL", id: submittedApprovalId });
      }
      forwardedFollowUpRef.current = "";
      vscodeApi.postMessage({
        command: "approvalDecision",
        ...data,
        approvalKind: approvalKind ?? data.approvalKind,
      });
    },
    [vscodeApi],
  );

  const handleRevealPendingDiff = useCallback(
    (requestId: string) => {
      vscodeApi.postMessage({ command: "revealPendingDiff", id: requestId });
    },
    [vscodeApi],
  );

  const pendingRegexSuggestionsRef = useRef<
    Map<
      string,
      { resolve: (pattern: string) => void; reject: (err: Error) => void }
    >
  >(new Map());
  const handleSuggestRegex = useCallback(
    (args: { subCommand: string; fullCommand: string }): Promise<string> => {
      return new Promise((resolve, reject) => {
        const requestId = `regex-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        pendingRegexSuggestionsRef.current.set(requestId, { resolve, reject });
        vscodeApi.postMessage({
          command: "agentSuggestRegex",
          requestId,
          subCommand: args.subCommand,
          fullCommand: args.fullCommand,
        });
      });
    },
    [vscodeApi],
  );

  const pendingPromptPolishRef = useRef<
    Map<
      string,
      { resolve: (polished: string) => void; reject: (err: Error) => void }
    >
  >(new Map());
  const handlePolishPrompt = useCallback(
    (draft: string): Promise<string> => {
      return new Promise((resolve, reject) => {
        const requestId = `polish-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        const timeout = setTimeout(() => {
          if (pendingPromptPolishRef.current.delete(requestId)) {
            reject(new Error("Polish timed out"));
          }
        }, PROMPT_POLISH_TIMEOUT_MS);
        pendingPromptPolishRef.current.set(requestId, {
          resolve: (polished) => {
            clearTimeout(timeout);
            resolve(polished);
          },
          reject: (err) => {
            clearTimeout(timeout);
            reject(err);
          },
        });
        vscodeApi.postMessage({
          command: "agentPolishPrompt",
          requestId,
          draft,
        });
      });
    },
    [vscodeApi],
  );

  const clampApprovalPanelHeight = useCallback((height: number) => {
    const min = MIN_APPROVAL_PANEL_HEIGHT;
    const max = Math.max(min, window.innerHeight - 180);
    return Math.min(max, Math.max(min, height));
  }, []);

  const stopApprovalResize = useCallback(() => {
    approvalResizeCleanupRef.current?.();
    approvalResizeCleanupRef.current = null;
    document.body.classList.remove("approval-resizing");
    setApprovalResizing(false);
  }, []);

  useEffect(() => {
    return () => stopApprovalResize();
  }, [stopApprovalResize]);

  useEffect(() => {
    const onWindowResize = () => {
      setApprovalPanelHeight((prev) => clampApprovalPanelHeight(prev));
    };
    window.addEventListener("resize", onWindowResize);
    return () => window.removeEventListener("resize", onWindowResize);
  }, [clampApprovalPanelHeight]);

  const handleApprovalResizeStart = useCallback(
    (e: MouseEvent) => {
      if (e.button !== 0) return;
      const handle = e.currentTarget as HTMLElement | null;
      const panel = handle?.parentElement as HTMLDivElement | null;
      if (!panel) return;

      e.preventDefault();
      stopApprovalResize();

      const startY = e.clientY;
      const startHeight = panel.getBoundingClientRect().height;
      setApprovalPanelHeight(clampApprovalPanelHeight(startHeight));
      setApprovalResizing(true);
      document.body.classList.add("approval-resizing");

      const onMouseMove = (moveEvent: MouseEvent) => {
        const nextHeight = clampApprovalPanelHeight(
          startHeight + (startY - moveEvent.clientY),
        );
        setApprovalPanelHeight(nextHeight);
      };

      const onMouseUp = () => {
        stopApprovalResize();
      };

      window.addEventListener("mousemove", onMouseMove);
      window.addEventListener("mouseup", onMouseUp);
      approvalResizeCleanupRef.current = () => {
        window.removeEventListener("mousemove", onMouseMove);
        window.removeEventListener("mouseup", onMouseUp);
      };
    },
    [clampApprovalPanelHeight, stopApprovalResize],
  );

  const handleSetReasoningEffort = useCallback(
    (effort: ReasoningEffort) => {
      if (!stateRef.current.sessionId) {
        updateSessionlessSelections({
          reasoningEffort: effort,
          thinkingEnabled: effort !== "none",
        });
        return;
      }
      dispatch({ type: "SET_REASONING_EFFORT", effort });
      vscodeApi.postMessage(
        toVsCodeSelectionMessage({ type: "reasoningEffort", effort }),
      );
    },
    [updateSessionlessSelections, vscodeApi],
  );

  const handleExportTranscript = useCallback(() => {
    vscodeApi.postMessage({
      command: "agentExportTranscript",
      messages: state.messages,
    });
  }, [vscodeApi, state.messages]);

  const handleOpenFile = useCallback(
    (path: string, line?: number) => {
      const requestId = randomId();
      trackOpenFileRequest(requestId, path);
      vscodeApi.postMessage({
        command: "agentOpenFile",
        path,
        line,
        requestId,
      });
    },
    [vscodeApi],
  );

  const handleRevealToolCallTerminal = useCallback(
    (id: string) => {
      vscodeApi.postMessage({ command: "revealToolCallTerminal", id });
    },
    [vscodeApi],
  );

  const handleContinueToolCallInBackground = useCallback(
    (id: string) => {
      vscodeApi.postMessage({ command: "continueToolCallInBackground", id });
    },
    [vscodeApi],
  );

  const handleCompleteToolCall = useCallback(
    (id: string) => {
      vscodeApi.postMessage({ command: "completeToolCall", id });
    },
    [vscodeApi],
  );

  const handleCancelToolCall = useCallback(
    (id: string) => {
      vscodeApi.postMessage({ command: "cancelToolCall", id });
    },
    [vscodeApi],
  );

  const handlePromoteMcpToolApproval = useCallback(
    (promotion: {
      serverName: string;
      bareToolName: string;
      mutationTarget?: import("../../shared/types").McpApprovalPromotionMeta["mutationTarget"];
      scope: "session" | "project" | "global";
    }) => {
      const sessionId = stateRef.current.sessionId;
      if (!sessionId) return;
      vscodeApi.postMessage({
        command: "agentPromoteMcpToolApproval",
        sessionId,
        ...promotion,
      });
    },
    [vscodeApi],
  );

  const handleOpenSpecialBlockPanel = useCallback(
    (block: { kind: "mermaid" | "vega" | "vega-lite"; source: string }) => {
      vscodeApi.postMessage({
        command: "agentOpenSpecialBlockPanel",
        ...block,
      });
    },
    [vscodeApi],
  );

  const handleRevertCheckpoint = useCallback(
    (sessionId: string, checkpointId: string) => {
      vscodeApi.postMessage({
        command: "agentRevertCheckpoint",
        sessionId,
        checkpointId,
      });
    },
    [vscodeApi],
  );

  const handleViewCheckpointDiff = useCallback(
    (sessionId: string, checkpointId: string, scope: "turn" | "all") => {
      vscodeApi.postMessage({
        command: "agentViewCheckpointDiff",
        sessionId,
        checkpointId,
        scope,
      });
    },
    [vscodeApi],
  );

  const handleRetry = useCallback(() => {
    if (stateRef.current.sessionId) {
      streamingRef.current = true;
      dispatch({ type: "CLEAR_ERROR" });
      vscodeApi.postMessage({
        command: "agentRetry",
        sessionId: stateRef.current.sessionId,
      });
    }
  }, [vscodeApi]);

  const handleErrorSignIn = useCallback(() => {
    const model = state.availableModels.find(
      (m) => m.id === stateRef.current.model,
    );
    if (model) {
      handleSignIn(model.provider);
    }
  }, [state.availableModels, handleSignIn]);

  const handleErrorSignInAnotherAccount = useCallback(() => {
    vscodeApi.postMessage({ command: "agentCodexAddAccount" });
  }, [vscodeApi]);

  const handleErrorCondense = useCallback(() => {
    vscodeApi.postMessage({
      command: "agentSlashCommand",
      name: "condense",
      args: "",
    });
  }, [vscodeApi]);

  const handleShowHistory = useCallback(() => {
    vscodeApi.postMessage({ command: "agentListSessions" });
    setShowHistory((prev) => !prev);
  }, [vscodeApi]);

  const handleLoadSession = useCallback(
    (sessionId: string) => {
      vscodeApi.postMessage({
        command: "chatTabLoadSession",
        targetSessionId: sessionId,
      });
    },
    [vscodeApi],
  );

  const findWorkspaceTab = useCallback(
    (tabId: string) =>
      workspaceSnapshotRef.current?.tabs.find((tab) => tab.tabId === tabId),
    [],
  );
  const handleFocusChatTab = useCallback(
    (tabId: string) => {
      const tab = findWorkspaceTab(tabId);
      if (!tab) return;
      setTranscriptView(null);
      setShowHistory(false);
      setChatTabFailure(null);
      vscodeApi.postMessage({
        command: "chatTabFocus",
        tabId: tab.tabId,
        sessionId: tab.sessionId,
      });
    },
    [findWorkspaceTab, vscodeApi],
  );
  const handleNewChatTab = useCallback(() => {
    setTranscriptView(null);
    setShowHistory(false);
    setChatTabFailure(null);
    vscodeApi.postMessage({
      command: "chatTabNew",
      mode: stateRef.current.mode,
    });
  }, [vscodeApi]);
  const handleCloseChatTab = useCallback(
    (tabId: string) => {
      const tab = findWorkspaceTab(tabId);
      if (!tab) return;
      setChatTabFailure(null);
      vscodeApi.postMessage({
        command: "chatTabClose",
        tabId: tab.tabId,
        sessionId: tab.sessionId,
      });
    },
    [findWorkspaceTab, vscodeApi],
  );
  const handlePopOutChatTab = useCallback(
    (tabId: string) => {
      const tab = findWorkspaceTab(tabId);
      if (!tab) return;
      setChatTabFailure(null);
      vscodeApi.postMessage({
        command: "chatTabPopOut",
        tabId: tab.tabId,
        sessionId: tab.sessionId,
      });
    },
    [findWorkspaceTab, vscodeApi],
  );
  const handleDockChatTab = useCallback(() => {
    if (!pinnedPane) return;
    setChatTabFailure(null);
    vscodeApi.postMessage({ command: "chatTabDock" });
  }, [pinnedPane, vscodeApi]);
  const handleReorderChatTabs = useCallback(
    (tabIds: string[]) => {
      vscodeApi.postMessage({ command: "chatTabReorder", tabIds });
    },
    [vscodeApi],
  );
  const handleConfirmChatTabAction = useCallback(() => {
    const request = chatTabConfirmation;
    if (!request) return;
    setChatTabConfirmation(null);
    vscodeApi.postMessage({
      command: request.command,
      ...request.address,
      mode: request.mode,
      projectId: request.projectId,
      targetSessionId: request.targetSessionId,
      stopRunning: true,
    });
  }, [chatTabConfirmation, vscodeApi]);
  const selectedWorkspaceTab = workspaceSnapshot?.tabs.find(
    (tab) => tab.tabId === (pinnedTabId ?? workspaceSnapshot.focusedTabId),
  );
  const selectedTabKey = selectedWorkspaceTab
    ? `${selectedWorkspaceTab.tabId}:${selectedWorkspaceTab.sessionId ?? "new"}`
    : "legacy";

  const handleDeleteSession = useCallback(
    (sessionId: string) => {
      vscodeApi.postMessage({ command: "agentDeleteSession", sessionId });
    },
    [vscodeApi],
  );

  const handleRenameSession = useCallback(
    (sessionId: string, title: string) => {
      vscodeApi.postMessage({
        command: "agentRenameSession",
        sessionId,
        title,
      });
    },
    [vscodeApi],
  );

  const handleCopyFirstPrompt = useCallback(
    (sessionId: string) => {
      handleNewSession();
      vscodeApi.postMessage({ command: "agentCopyFirstPrompt", sessionId });
      setShowHistory(false);
    },
    [vscodeApi, handleNewSession],
  );

  const resetDropOverlay = useCallback(() => {
    dragCounterRef.current = 0;
    setShiftDragOver(false);
  }, []);

  const handleContainerDragEnter = useCallback((e: DragEvent) => {
    e.preventDefault();
    dragCounterRef.current++;
    if (e.shiftKey) {
      setShiftDragOver(true);
    }
  }, []);

  const handleContainerDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    if (e.shiftKey && e.dataTransfer) {
      e.dataTransfer.dropEffect = "copy";
    }
    // Update shift state in case user presses/releases shift mid-drag
    setShiftDragOver(e.shiftKey);
  }, []);

  const handleContainerDragLeave = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      dragCounterRef.current--;
      if (dragCounterRef.current <= 0) {
        resetDropOverlay();
      }
    },
    [resetDropOverlay],
  );

  useEffect(() => {
    const handleGlobalDropCleanup = (e: globalThis.DragEvent) => {
      e.preventDefault();
      resetDropOverlay();
    };
    const handleGlobalDragEndCleanup = () => resetDropOverlay();
    const handleWindowBlur = () => resetDropOverlay();
    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible") {
        resetDropOverlay();
      }
    };

    window.addEventListener("drop", handleGlobalDropCleanup, true);
    window.addEventListener("dragend", handleGlobalDragEndCleanup, true);
    window.addEventListener("blur", handleWindowBlur);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.removeEventListener("drop", handleGlobalDropCleanup, true);
      window.removeEventListener("dragend", handleGlobalDragEndCleanup, true);
      window.removeEventListener("blur", handleWindowBlur);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [resetDropOverlay]);

  const handleContainerDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      resetDropOverlay();

      if (!e.shiftKey || !e.dataTransfer) return;

      // Try text/uri-list, then plain text
      let uriList = e.dataTransfer.getData("text/uri-list");
      if (!uriList) {
        const text =
          e.dataTransfer.getData("text/plain") ||
          e.dataTransfer.getData("text");
        if (
          text &&
          (text.startsWith("file://") || text.startsWith("vscode-"))
        ) {
          uriList = text;
        }
      }

      if (!uriList) return;

      const paths = uriList
        .split("\n")
        .map((u) => u.trim())
        .filter((u) => u && !u.startsWith("#"))
        .map((u) => {
          try {
            return decodeURIComponent(new URL(u).pathname);
          } catch {
            return u;
          }
        })
        .filter((p): p is string => !!p);

      if (paths.length > 0) {
        vscodeApi.postMessage({
          command: "agentResolveDroppedFiles",
          paths,
        });
      }
    },
    [resetDropOverlay, vscodeApi],
  );

  const activeBtwSessionId = state.chatState.sessionId;
  const btwState = activeBtwSessionId
    ? btwStates[activeBtwSessionId]
    : undefined;

  return (
    <>
      {elicitation && (
        <ElicitationModal
          key={elicitation.id}
          request={elicitation}
          onSubmit={handleElicitSubmit}
          onCancel={handleElicitCancel}
        />
      )}
      {urlElicitation && (
        <UrlElicitationModal
          request={urlElicitation}
          onAccept={handleUrlElicitAccept}
          onDecline={handleUrlElicitDecline}
          onCancel={handleUrlElicitCancel}
        />
      )}
      {chatTabConfirmation && (
        <ChatTabConfirmation
          request={chatTabConfirmation}
          onConfirm={handleConfirmChatTabAction}
          onCancel={() => setChatTabConfirmation(null)}
        />
      )}
      {pane.surface === "editor" && selectedWorkspaceTab && (
        <div class="chat-editor-actions">
          <span>
            {selectedWorkspaceTab.label} ·{" "}
            {selectedWorkspaceTab.title ?? "New Chat"}
          </span>
          <button
            type="button"
            class="chat-editor-action"
            onClick={handleDockChatTab}
            title="Dock in AgentLink sidebar"
          >
            <i class="codicon codicon-layout-sidebar-left" />
            Dock
          </button>
          <button
            type="button"
            class="chat-editor-action"
            onClick={() => handleCloseChatTab(selectedWorkspaceTab.tabId)}
            title={`Close ${selectedWorkspaceTab.label}`}
          >
            <i class="codicon codicon-close" />
            Close Tab
          </button>
        </div>
      )}
      <ChatWorkspace
        snapshot={workspaceSnapshot}
        showTabStrip={pane.surface === "sidebar"}
        hostStale={hostConnectionStale}
        onFocus={handleFocusChatTab}
        onNewTab={handleNewChatTab}
        onClose={handleCloseChatTab}
        onPopOut={pane.surface === "sidebar" ? handlePopOutChatTab : undefined}
        onReorder={handleReorderChatTabs}
      >
        <ChatSessionPane tabKey={selectedTabKey}>
          <div
            class="chat-container"
            onDragEnter={handleContainerDragEnter}
            onDragOver={handleContainerDragOver}
            onDragLeave={handleContainerDragLeave}
            onDrop={handleContainerDrop}
          >
            {chatTabFailure && (
              <div class="chat-tab-failure" role="alert">
                <i class="codicon codicon-warning" />
                <span>{chatTabFailure}</span>
                <button
                  type="button"
                  class="icon-button"
                  onClick={() => setChatTabFailure(null)}
                  title="Dismiss"
                  aria-label="Dismiss tab message"
                >
                  <i class="codicon codicon-close" />
                </button>
              </div>
            )}
            {transcriptView?.visible && (
              <TranscriptView
                task={transcriptView.task}
                sessionId={transcriptView.sessionId}
                messages={transcriptView.messages}
                streaming={transcriptView.streaming}
                statusOverride={transcriptView.statusOverride}
                runtimeStatus={bgSessions.find(
                  (session) => session.id === transcriptView.sessionId,
                )}
                todos={transcriptView.todos}
                onOpenFile={handleOpenFile}
                onOpenSpecialBlockPanel={handleOpenSpecialBlockPanel}
                onRetry={() => handleRetryBackground(transcriptView.sessionId)}
                onSignIn={handleErrorSignIn}
                onSignInAnotherAccount={handleErrorSignInAnotherAccount}
                bgSessions={bgSessions}
                onStopBackground={handleStopBackground}
                onOpenTranscript={handleOpenBgTranscript}
                onClose={() =>
                  setTranscriptView((current) =>
                    current ? { ...current, visible: false } : current,
                  )
                }
              />
            )}
            {shiftDragOver && (
              <div class="drop-overlay">
                <div class="drop-overlay-content">
                  <i class="codicon codicon-attach" />
                  <span>Drop to attach files</span>
                </div>
              </div>
            )}
            <ChatHeader
              restoringSession={state.restoringSession}
              showHistory={showHistory}
              onNewSession={handleNewSession}
              onShowHistory={handleShowHistory}
            />
            {showHistory && (
              <SessionHistory
                sessions={sessionHistory}
                currentSessionId={state.chatState.sessionId}
                onLoad={handleLoadSession}
                onDelete={handleDeleteSession}
                onRename={handleRenameSession}
                onCopyFirstPrompt={handleCopyFirstPrompt}
                onNewInProject={(projectId) => {
                  handleNewSession(projectId);
                  setShowHistory(false);
                }}
                onClose={() => setShowHistory(false)}
              />
            )}
            {state.revertRecoveryNotice && (
              <div class="revert-recovery-notice" role="alert">
                <i class="codicon codicon-warning" />
                <div>
                  <strong>{state.revertRecoveryNotice.title}</strong>
                  <span>{state.revertRecoveryNotice.message}</span>
                </div>
              </div>
            )}
            <ChatView
              messages={state.messages}
              streaming={state.streaming}
              sessionId={state.chatState.sessionId}
              originalPrompt={state.originalPrompt}
              earlierUserTurnCount={state.loadedUserTurnOffset}
              onLoadEarlierMessages={handleLoadEarlierSessionMessages}
              detectedQuestion={state.detectedQuestion}
              onDetectedQuestionAnswer={handleDetectedQuestionAnswer}
              onDismissDetectedQuestion={handleDismissDetectedQuestion}
              onOpenFile={handleOpenFile}
              onRevealToolCallTerminal={handleRevealToolCallTerminal}
              onContinueToolCallInBackground={
                handleContinueToolCallInBackground
              }
              onCompleteToolCall={handleCompleteToolCall}
              onCancelToolCall={handleCancelToolCall}
              onPromoteMcpToolApproval={handlePromoteMcpToolApproval}
              onOpenSpecialBlockPanel={handleOpenSpecialBlockPanel}
              onRevertCheckpoint={handleRevertCheckpoint}
              onViewCheckpointDiff={handleViewCheckpointDiff}
              onRetry={handleRetry}
              onSignIn={handleErrorSignIn}
              onSignInAnotherAccount={handleErrorSignInAnotherAccount}
              onCondense={handleErrorCondense}
              bgSessions={bgSessions}
              onStopBackground={handleStopBackground}
              onOpenTranscript={handleOpenBgTranscript}
              onFinalMarkerContinue={handleFinalMarkerContinue}
              streamingMetrics={streamingBaselineMetrics}
              streamingMetricsSurface="vscode-webview"
              streamingMetricsScope={state.chatState.sessionId ?? "foreground"}
              emptyState={
                <ModelSetupCard
                  setupState={modelSetupState}
                  hasWorkspace={(state.chatState.projects?.length ?? 0) > 0}
                  surface="vscode"
                  onSetupAction={handleSetupAction}
                  onOpenFolder={() =>
                    vscodeApi.postMessage({ command: "agentOpenFolder" })
                  }
                />
              }
            />
            <ChatActivityShelf
              revealKey={
                globalApproval?.id ??
                state.approvalRequest?.id ??
                (environmentPanelOpen ? "environment" : null)
              }
              revealMinHeight={Math.max(
                approvalPanelHeight + 10,
                environmentPanelOpen ? 320 : 0,
              )}
            >
              <MessageQueuePanel
                queue={state.messageQueue}
                onSteer={(item) => {
                  const nextQueue = messageQueueRef.current.filter(
                    (q) => q.id !== item.id,
                  );
                  messageQueueRef.current = nextQueue;
                  dispatch({ type: "REMOVE_FROM_QUEUE", id: item.id });
                  vscodeApi.postMessage({
                    command: "agentSteerQueuedMessage",
                    sessionId: stateRef.current.sessionId,
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
                  const ready = !item.interjectionReady;
                  messageQueueRef.current = messageQueueRef.current.map(
                    (queued) =>
                      queued.id === item.id
                        ? { ...queued, interjectionReady: ready }
                        : queued,
                  );
                  dispatch({
                    type: "MARK_QUEUE_INTERJECTION_READY",
                    id: item.id,
                    ready,
                  });
                  if (!ready) {
                    vscodeApi.postMessage({
                      command: "agentPauseQueuedMessageInterjection",
                      sessionId: stateRef.current.sessionId,
                      queueId: item.id,
                    });
                    return;
                  }
                  vscodeApi.postMessage({
                    command: "agentInterjectQueuedMessage",
                    sessionId: stateRef.current.sessionId,
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
                onEdit={(item, text) => {
                  messageQueueRef.current = messageQueueRef.current.map(
                    (queued) =>
                      queued.id === item.id
                        ? {
                            ...queued,
                            text,
                            fullText: text,
                            isSlashCommand: false,
                            slashCommandLabel: undefined,
                          }
                        : queued,
                  );
                  dispatch({
                    type: "EDIT_QUEUE_MESSAGE",
                    id: item.id,
                    text,
                  });
                  vscodeApi.postMessage({
                    command: "agentUpdateQueuedMessage",
                    sessionId: stateRef.current.sessionId,
                    queueId: item.id,
                    text,
                    displayText: text,
                    isSlashCommand: false,
                    attachments: item.attachments,
                    images: item.images,
                    documents: item.documents,
                  });
                }}
                onEditingChange={(item, editing) => {
                  if (editing) {
                    editingQueuedMessageRef.current = {
                      id: item.id,
                      resumeInterjection: item.interjectionReady === true,
                    };
                    if (item.interjectionReady) {
                      vscodeApi.postMessage({
                        command: "agentPauseQueuedMessageInterjection",
                        sessionId: stateRef.current.sessionId,
                        queueId: item.id,
                      });
                    }
                    return;
                  }

                  const edit = editingQueuedMessageRef.current;
                  editingQueuedMessageRef.current = null;
                  if (
                    edit?.id !== item.id ||
                    !edit.resumeInterjection ||
                    !streamingRef.current
                  ) {
                    return;
                  }
                  const updatedItem = messageQueueRef.current.find(
                    (queued) => queued.id === item.id,
                  );
                  if (!updatedItem) return;
                  vscodeApi.postMessage({
                    command: "agentInterjectQueuedMessage",
                    sessionId: stateRef.current.sessionId,
                    queueId: updatedItem.id,
                    text: updatedItem.fullText ?? updatedItem.text,
                    displayText: updatedItem.text,
                    isSlashCommand: updatedItem.isSlashCommand === true,
                    slashCommandLabel: updatedItem.slashCommandLabel,
                    attachments: updatedItem.attachments,
                    images: updatedItem.images,
                    documents: updatedItem.documents,
                  });
                }}
                onRemove={(item) => {
                  const nextQueue = messageQueueRef.current.filter(
                    (q) => q.id !== item.id,
                  );
                  messageQueueRef.current = nextQueue;
                  dispatch({ type: "REMOVE_FROM_QUEUE", id: item.id });
                  // Always notify the extension: a VS Code-sourced message may be
                  // registered as a pending interjection, and without this the
                  // deleted message would still be injected at the next tool break.
                  vscodeApi.postMessage({
                    command: "agentRemoveQueuedMessage",
                    sessionId: stateRef.current.sessionId,
                    queueId: item.id,
                  });
                }}
              />
              {handoffDraft && (
                <SessionHandoffPanel
                  draft={handoffDraft}
                  error={handoffError}
                  onCancel={() => {
                    vscodeApi.postMessage({
                      command: "agentHandoffCancel",
                      draftId: handoffDraft.id,
                    });
                    setHandoffDraft(null);
                    setHandoffError(null);
                  }}
                  onConfirm={(markdown) =>
                    vscodeApi.postMessage({
                      command: "agentHandoffConfirm",
                      draftId: handoffDraft.id,
                      markdown,
                    })
                  }
                />
              )}
              <ContextUsageRow
                inputTokens={state.lastInputTokens}
                outputTokens={state.lastOutputTokens}
                cacheReadTokens={state.lastCacheReadTokens}
                estimatedTotalUsed={state.estimatedTotalUsed}
                models={state.availableModels}
                modelId={state.chatState.model}
                contextBudget={state.chatState.contextBudget}
                condenseThreshold={state.chatState.condenseThreshold}
                defaultMaxTokens={DEFAULT_MAX_TOKENS}
              />

              {environmentPanelOpen && (
                <EnvironmentPanel
                  info={state.debugInfo}
                  systemPrompt={state.systemPrompt}
                  loadedInstructions={state.loadedInstructions ?? undefined}
                  onClose={() => setEnvironmentPanelOpen(false)}
                />
              )}
              {memoryPanelOpen && (
                <MemoryPanel
                  snapshot={memoryPanelSnapshot}
                  scope={memoryPanelScope}
                  availableScopes={memoryPanelAvailableScopes}
                  loading={memoryPanelLoading}
                  error={memoryPanelError}
                  onClose={() => setMemoryPanelOpen(false)}
                  onQuery={(request) => {
                    memoryPanelQueryRef.current = request;
                    setMemoryPanelScope(
                      request.scope === "project" ? "project" : "global",
                    );
                    setMemoryPanelLoading(true);
                    setMemoryPanelError(null);
                    vscodeApi.postMessage({
                      command: "agentMemoryQuery",
                      requestId: beginMemoryPanelRequest(),
                      request,
                    });
                  }}
                  onDetail={(recordId) => {
                    setMemoryPanelLoading(true);
                    setMemoryPanelError(null);
                    vscodeApi.postMessage({
                      command: "agentMemoryDetail",
                      requestId: beginMemoryPanelRequest(),
                      recordId,
                      scope: memoryPanelScope,
                    });
                  }}
                  onManage={(input: ManageMemoryToolInput) => {
                    setMemoryPanelLoading(true);
                    setMemoryPanelError(null);
                    vscodeApi.postMessage({
                      command: "agentMemoryManage",
                      requestId: beginMemoryPanelMutation(),
                      input,
                      request: memoryPanelQueryRef.current,
                    });
                  }}
                  onClear={(scope) => {
                    setMemoryPanelLoading(true);
                    setMemoryPanelError(null);
                    vscodeApi.postMessage({
                      command: "agentMemoryClear",
                      requestId: beginMemoryPanelMutation(),
                      scope,
                      confirm: true,
                      request: memoryPanelQueryRef.current,
                    });
                  }}
                  onExport={(scope) =>
                    vscodeApi.postMessage({
                      command: "agentMemoryExport",
                      scope,
                    })
                  }
                  onImport={(archive: MemoryArchiveV1, scope) => {
                    setMemoryPanelLoading(true);
                    setMemoryPanelError(null);
                    vscodeApi.postMessage({
                      command: "agentMemoryImport",
                      requestId: beginMemoryPanelMutation(),
                      archive,
                      scope,
                      request: memoryPanelQueryRef.current,
                    });
                  }}
                />
              )}
              {agentPluginManagerSnapshot && (
                <AgentPluginManagerPanel
                  snapshot={agentPluginManagerSnapshot}
                  onClose={() => setAgentPluginManagerSnapshot(null)}
                  onRefresh={() =>
                    vscodeApi.postMessage({
                      command: "agentPluginManagerRefresh",
                      projectId: agentPluginManagerSnapshot.project?.projectId,
                    })
                  }
                  onSelectProject={(projectId) =>
                    vscodeApi.postMessage({
                      command: "agentPluginManagerSelectProject",
                      projectId,
                    })
                  }
                  onInstall={(source) =>
                    vscodeApi.postMessage({
                      command: "agentPluginManagerInstall",
                      source,
                      projectId: agentPluginManagerSnapshot.project?.projectId,
                    })
                  }
                  onAction={(row, action) =>
                    vscodeApi.postMessage({
                      command: "agentPluginManagerAction",
                      action,
                      installInstanceId: row.installInstanceId,
                      manifestName: row.manifestName,
                      projectId: agentPluginManagerSnapshot.project?.projectId,
                    })
                  }
                />
              )}
              {mcpManagerSnapshot && (
                <McpManagerPanel
                  snapshot={mcpManagerSnapshot}
                  initialView={mcpManagerView}
                  onClose={() => setMcpManagerSnapshot(null)}
                  onRefresh={() =>
                    vscodeApi.postMessage({
                      command: "agentMcpSelectProject",
                      projectId: mcpManagerSnapshot.project?.projectId,
                      refresh: true,
                    })
                  }
                  onSelectProject={(projectId) =>
                    vscodeApi.postMessage({
                      command: "agentMcpSelectProject",
                      projectId,
                    })
                  }
                  onServerAction={(serverName, action) =>
                    vscodeApi.postMessage({
                      command: "agentMcpAction",
                      serverName,
                      action,
                      projectId: mcpManagerSnapshot.project?.projectId,
                    })
                  }
                  onOpenRawConfig={(scope: McpManagerScope) =>
                    vscodeApi.postMessage({
                      command: "agentMcpConfigOpenRaw",
                      profile: mcpManagerSnapshot.profile,
                      scope,
                      projectId: mcpManagerSnapshot.project?.projectId,
                    })
                  }
                  onMutateConfig={(mutation: McpConfigBatchMutation) =>
                    new Promise<McpConfigMutationResult>((resolve, reject) => {
                      const timer = setTimeout(() => {
                        mcpMutationResolversRef.current.delete(
                          mutation.operationId,
                        );
                        reject(
                          new Error(
                            "The MCP configuration save timed out. Refresh the manager before retrying.",
                          ),
                        );
                      }, MCP_CONFIG_MUTATION_TIMEOUT_MS);
                      mcpMutationResolversRef.current.set(
                        mutation.operationId,
                        {
                          resolve,
                          reject,
                          timer,
                        },
                      );
                      vscodeApi.postMessage({
                        command: "agentMcpConfigMutate",
                        mutation,
                      });
                    })
                  }
                  onSaveServer={(scope, server) =>
                    vscodeApi.postMessage({
                      command: "agentMcpConfigSave",
                      profile: mcpManagerSnapshot.profile,
                      scope,
                      projectId: mcpManagerSnapshot.project?.projectId,
                      server,
                    })
                  }
                  onRemoveServer={(scope, serverName) =>
                    vscodeApi.postMessage({
                      command: "agentMcpConfigRemove",
                      profile: mcpManagerSnapshot.profile,
                      scope,
                      projectId: mcpManagerSnapshot.project?.projectId,
                      serverName,
                    })
                  }
                />
              )}
              {providerUsage && (
                <ProviderUsagePanel
                  data={providerUsage}
                  onClose={() => setProviderUsage(null)}
                  onRefresh={() =>
                    vscodeApi.postMessage({
                      command: "agentSlashCommand",
                      name: "usage",
                      args: "",
                    })
                  }
                />
              )}
              {state.todos.length > 0 && <TodoPanel todos={state.todos} />}

              {(globalApproval ?? state.approvalRequest) && (
                <ApprovalPanelEmbed
                  request={(globalApproval ?? state.approvalRequest)!}
                  height={approvalPanelHeight}
                  resizing={approvalResizing}
                  followUpRef={forwardedFollowUpRef}
                  submit={handleForwardedApprovalSubmit}
                  onResizeStart={handleApprovalResizeStart}
                  onSuggestRegex={handleSuggestRegex}
                  onRevealDiff={handleRevealPendingDiff}
                />
              )}
              {btwState && (
                <BtwPanel
                  state={btwState}
                  onDismiss={() => {
                    if (btwState && !btwState.done && !btwState.error) {
                      vscodeApi.postMessage({
                        command: "agentBtwCancel",
                        requestId: btwState.requestId,
                      });
                    }
                    if (activeBtwSessionId) {
                      setBtwStates((previous) => {
                        const next = { ...previous };
                        delete next[activeBtwSessionId];
                        return next;
                      });
                    }
                  }}
                  onCancel={(requestId) =>
                    vscodeApi.postMessage({
                      command: "agentBtwCancel",
                      requestId,
                    })
                  }
                  onPromote={(question, answer) => {
                    vscodeApi.postMessage({
                      command: "agentBtwPromote",
                      question,
                      answer,
                    });
                    if (activeBtwSessionId) {
                      setBtwStates((previous) => {
                        const next = { ...previous };
                        delete next[activeBtwSessionId];
                        return next;
                      });
                    }
                  }}
                />
              )}
              {worktreeSetupState && (
                <WorktreeSetupPanel
                  key={worktreeSetupState.requestId}
                  state={worktreeSetupState}
                  onCancel={(requestId) => {
                    vscodeApi.postMessage({
                      command: "agentWorktreeSetupCancel",
                      requestId,
                    });
                  }}
                  onDismiss={() => {
                    if (
                      worktreeSetupState.phase === "configuring" ||
                      worktreeSetupState.phase === "awaiting_input"
                    ) {
                      vscodeApi.postMessage({
                        command: "agentWorktreeSetupCancel",
                        requestId: worktreeSetupState.requestId,
                      });
                    }
                    setWorktreeSetupState(null);
                  }}
                  onLaunch={(requestId, autoSubmit) => {
                    setWorktreeSetupState((previous) =>
                      previous?.requestId === requestId
                        ? { ...previous, phase: "launching" }
                        : previous,
                    );
                    vscodeApi.postMessage({
                      command: "agentWorktreeSetupLaunch",
                      requestId,
                      autoSubmit,
                    });
                  }}
                  onReply={(requestId, text) => {
                    setWorktreeSetupState((previous) =>
                      previous?.requestId === requestId
                        ? {
                            ...previous,
                            phase: "configuring",
                            answer: "",
                            conversation: [
                              ...(previous.conversation ?? []),
                              { role: "user" as const, text },
                            ],
                          }
                        : previous,
                    );
                    vscodeApi.postMessage({
                      command: "agentWorktreeSetupReply",
                      requestId,
                      text,
                    });
                  }}
                />
              )}
              {state.chatState.interrupted && !state.streaming && (
                <div class="interrupted-session-banner">
                  <i class="codicon codicon-debug-restart" />
                  <div>
                    <strong>Session interrupted</strong>
                    <span>
                      The previous agent turn stopped before it finished. Resume
                      to let the agent inspect current state and continue
                      safely.
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
              {state.streaming && !state.questionRequest && (
                <StreamingStatusBar
                  messages={state.messages}
                  statusOverride={state.statusOverride}
                />
              )}
              <BackgroundSessionStrip
                key={state.chatState.sessionId ?? "no-session"}
                sessions={bgSessions}
                showFleetRequest={showFleetRequest}
                onStop={handleStopBackground}
                onOpenTranscript={handleOpenBgTranscript}
                onSteer={handleSteerBackground}
                onDetach={handleDetachBackground}
                onRetry={handleRetryBackground}
                onArchive={handleArchiveBackground}
                onPause={handlePauseBackground}
                onResume={handleResumeBackground}
              />
            </ChatActivityShelf>
            <InputArea
              onSend={handleSend}
              contextMode={
                state.questionRequest && activeQuestionContextMode
                  ? ({
                      key: `${state.questionRequest.id}:${activeQuestionContextMode.questionId}`,
                      questionId: activeQuestionContextMode.questionId,
                      title: "Adding context to agent question",
                      placeholder:
                        "Add details, paste a screenshot, or attach supporting files…",
                      initialText: activeQuestionContextMode.initialText,
                      focusComposer: activeQuestionContextMode.focusComposer,
                      initialAttachments:
                        activeQuestionAttachments[
                          activeQuestionContextMode.questionId
                        ]?.paths,
                      initialMedia:
                        activeQuestionAttachments[
                          activeQuestionContextMode.questionId
                        ]?.media,
                      onSubmit: (
                        text,
                        paths,
                        _displayText,
                        _slashLabel,
                        media,
                      ) => {
                        activeQuestionContextMode.onCommit(text);
                        setQuestionAttachments((current) => ({
                          requestId: state.questionRequest!.id,
                          values: {
                            ...(current?.requestId === state.questionRequest!.id
                              ? current.values
                              : {}),
                            [activeQuestionContextMode.questionId]: {
                              paths,
                              media: media ?? [],
                            },
                          },
                        }));
                      },
                      onCancel: () => setQuestionContextMode(null),
                      content: (
                        <QuestionCard
                          key={`${state.questionRequest.id}:composer`}
                          id={state.questionRequest.id}
                          context={state.questionRequest.context}
                          questions={state.questionRequest.questions}
                          backgroundTask={state.questionRequest.backgroundTask}
                          modes={state.modes}
                          onOpenFile={handleOpenFile}
                          attachmentCounts={Object.fromEntries(
                            Object.entries(activeQuestionAttachments).map(
                              ([questionId, value]) => [
                                questionId,
                                value.paths.length + value.media.length,
                              ],
                            ),
                          )}
                          integratedComposer
                          onComposerStateChange={(next) =>
                            setQuestionContextMode((current) =>
                              current?.requestId ===
                                state.questionRequest!.id &&
                              current.state.revision === next.revision &&
                              current.state.questionId === next.questionId
                                ? current
                                : {
                                    requestId: state.questionRequest!.id,
                                    state: next,
                                  },
                            )
                          }
                          remoteProgress={
                            remoteQuestionProgress &&
                            remoteQuestionProgress.id ===
                              state.questionRequest.id
                              ? {
                                  step: remoteQuestionProgress.step,
                                  answers: remoteQuestionProgress.answers,
                                  notes: remoteQuestionProgress.notes,
                                }
                              : null
                          }
                          onProgressChange={(progress) => {
                            vscodeApi.postMessage({
                              command: "agentQuestionProgress",
                              id: state.questionRequest!.id,
                              step: progress.step,
                              answers: progress.answers,
                              notes: progress.notes,
                              origin: questionProgressOriginRef.current,
                            });
                          }}
                          onSubmit={(
                            id,
                            answers,
                            notes,
                            currentAttachments,
                          ) => {
                            const attachmentsByQuestion = currentAttachments
                              ? {
                                  ...activeQuestionAttachments,
                                  [currentAttachments.questionId]: {
                                    paths: currentAttachments.paths,
                                    media: currentAttachments.media,
                                  },
                                }
                              : activeQuestionAttachments;
                            const attachments = Object.fromEntries(
                              Object.entries(attachmentsByQuestion).flatMap(
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
                            dispatch({
                              type: "SUBMIT_QUESTION",
                              id,
                              answers,
                              notes,
                            });
                            setRemoteQuestionProgress((progress) =>
                              progress?.id === id ? null : progress,
                            );
                            setQuestionContextMode(null);
                            setQuestionAttachments(null);
                            vscodeApi.postMessage({
                              command: "agentQuestionResponse",
                              id,
                              answers,
                              notes,
                              attachments,
                            });
                          }}
                        />
                      ),
                      actions: {
                        canGoBack: activeQuestionContextMode.canGoBack,
                        onBack: activeQuestionContextMode.onBack,
                        primaryLabel: activeQuestionContextMode.primaryLabel,
                        primaryDisabled:
                          activeQuestionContextMode.primaryDisabled,
                        onPrimary: activeQuestionContextMode.onPrimary,
                        hidePrimaryAction:
                          activeQuestionContextMode.hidePrimaryAction,
                      },
                    } satisfies ComposerContextMode)
                  : null
              }
              onInterject={handleInterject}
              onStop={handleStop}
              onPolishPrompt={handlePolishPrompt}
              streaming={state.streaming}
              reasoningEffort={
                state.chatState.reasoningEffort ??
                (state.thinkingEnabled ? "high" : "none")
              }
              onSetReasoningEffort={handleSetReasoningEffort}
              onExportTranscript={handleExportTranscript}
              hasMessages={state.messages.length > 0}
              vscodeApi={vscodeApi}
              injection={injection}
              onInjectionConsumed={() => setInjection(null)}
              slashCommands={state.slashCommands}
              onExecuteBuiltinCommand={handleExecuteBuiltinCommand}
              modes={state.modes}
              currentMode={state.chatState.mode}
              currentModel={state.chatState.model}
              currentCondenseThreshold={state.chatState.condenseThreshold}
              availableModels={state.availableModels}
              onSelectModel={handleSelectModel}
              onSetCondenseThreshold={handleSetCondenseThreshold}
              onSignIn={handleSignIn}
              onSwitchMode={
                state.chatState.projects?.length === 0
                  ? undefined
                  : handleSwitchMode
              }
              agentWriteApproval={
                state.chatState.agentWriteApproval ?? "prompt"
              }
              onSetAgentWriteApproval={
                state.chatState.projects?.length === 0
                  ? undefined
                  : handleSetAgentWriteApproval
              }
              commandApprovalPolicy={
                state.chatState.commandApprovalPolicy ?? "safe"
              }
              configuredCommandApprovalPolicy={
                state.chatState.configuredCommandApprovalPolicy ?? "safe"
              }
              onSetCommandApprovalPolicy={
                state.chatState.projects?.length === 0
                  ? undefined
                  : handleSetCommandApprovalPolicy
              }
              autoContinueEnabled={
                state.chatState.projects?.length === 0
                  ? false
                  : autoContinueEnabled
              }
              onToggleAutoContinue={
                state.chatState.projects?.length === 0
                  ? undefined
                  : handleToggleAutoContinue
              }
              autoContinueStatus={
                state.chatState.projects?.length === 0 ? "" : autoContinueStatus
              }
              allowAttachments={state.chatState.projects?.length !== 0}
              allowFileMentions={state.chatState.projects?.length !== 0}
              disabled={
                state.chatState.projects?.length !== 0 &&
                state.chatState.project?.availability === "unavailable"
              }
              disabledReason={
                state.chatState.projects?.length !== 0 &&
                state.chatState.project?.availability === "unavailable"
                  ? `Project unavailable: ${state.chatState.project.displayName}`
                  : undefined
              }
              sendBlockedReason={
                modelSetupState.kind === "checking"
                  ? "Checking model setup before AgentLink can send a message."
                  : modelSetupState.kind === "credentials_required"
                    ? `Set up ${modelSetupState.model.providerDisplayName ?? modelSetupState.model.provider} before sending a message.`
                    : modelSetupState.kind === "model_unavailable"
                      ? "Choose an available model before sending a message."
                      : undefined
              }
            />
          </div>
        </ChatSessionPane>
      </ChatWorkspace>
    </>
  );
}
