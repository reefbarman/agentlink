import type { JSX } from "preact";
import type {
  ChatMessage,
  ModeInfo,
  Question,
  ReasoningEffort,
  SessionSummary,
  SlashCommandInfo,
  TodoItem,
  WebviewModelInfo,
} from "../../agent/webview/types";

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
import { ChatView } from "../../agent/webview/components/ChatView";
import { CommandCard } from "../../approvals/webview/components/CommandCard";
import { ContextBar } from "../../agent/webview/components/ContextBar";
import { DebugInfo } from "../../agent/webview/components/DebugInfo";
import { BackgroundSessionStrip } from "../../agent/webview/components/BackgroundSessionStrip";
import { BrowserDiffViewer } from "./components/BrowserDiffViewer";
import { InputArea } from "../../agent/webview/components/InputArea";
import { McpCard } from "../../approvals/webview/components/McpCard";
import { MemoryCard } from "../../approvals/webview/components/MemoryCard";
import { ModeSwitchCard } from "../../approvals/webview/components/ModeSwitchCard";
import { PathCard } from "../../approvals/webview/components/PathCard";
import { QuestionCard } from "../../agent/webview/components/QuestionCard";
import { RenameCard } from "../../approvals/webview/components/RenameCard";
import { SessionHistory } from "../../agent/webview/components/SessionHistory";
import { TodoPanel } from "../../agent/webview/components/TodoPanel";
import { TranscriptView } from "../../agent/webview/components/TranscriptView";
import { WriteCard } from "../../approvals/webview/components/WriteCard";
import { getStreamingActivity } from "../../agent/webview/components/MessageBubble";

import {
  agentMessagesToChatMessages,
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

import { EmptyState, PaneCard, PaneHeader } from "../../shared/ui/Panes";

import type {
  BgSessionInfo,
  BrowserGatewayThemeSnapshot,
} from "../../shared/types";
import type { BrowserGatewayInstanceStatusSummary } from "../protocol";

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

type BrowserGatewayInstanceOption = {
  instanceId: string;
  workspaceName: string;
  workspacePath: string;
  url: string;
  status?: BrowserGatewayInstanceStatusSummary;
  lastSeenAt: number;
  disconnectedAt?: number;
};

type GatewaySnapshot = {
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
    recentEvents: Array<{ type: string }>;
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
    repository: {
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
    }>;
    foreground: {
      sessionId: string;
      title: string;
      mode: string;
      model: string;
      status: string;
      streaming: boolean;
      messages: unknown[];
      projectedMessages: ChatMessage[];
      statusOverride: string | null;
      thinkingEnabled?: boolean;
      reasoningEffort?: ReasoningEffort;
      lastInputTokens: number;
      lastOutputTokens: number;
      lastCacheReadTokens: number;
      estimatedTotalUsed: number;
      messageQueue: Array<{
        id: string;
        text: string;
        fullText?: string;
        isSlashCommand?: boolean;
        slashCommandLabel?: string;
        attachments?: string[];
        images?: Array<{ name: string; mimeType: string; base64: string }>;
        documents?: Array<{ name: string; mimeType: string; base64: string }>;
      }>;
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
};

interface BrowserGatewayAppProps {
  authToken: string;
  currentInstanceId: string;
  workspaceName: string;
  routeByInstance?: boolean;
  initialTheme?: BrowserGatewayThemeSnapshot;
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

export function BrowserGatewayApp({
  authToken,
  currentInstanceId,
  workspaceName,
  routeByInstance = false,
  initialTheme,
}: BrowserGatewayAppProps) {
  const [snapshot, setSnapshot] = useState<GatewaySnapshot | null>(null);
  const [instanceOptions, setInstanceOptions] = useState<
    BrowserGatewayInstanceOption[]
  >([]);
  const instanceOptionsRef = useRef<BrowserGatewayInstanceOption[]>([]);
  const [selectedInstanceId, setSelectedInstanceId] =
    useState(currentInstanceId);
  const selectedInstanceIdRef = useRef(currentInstanceId);
  const touchTabPointerRef = useRef<{
    instanceId: string;
    pointerId: number;
    x: number;
    y: number;
  } | null>(null);

  function selectInstance(instanceId: string): void {
    selectedInstanceIdRef.current = instanceId;
    setSelectedInstanceId(instanceId);
  }

  const buildApiPath = useCallback(
    (pathname: string): string => {
      if (!routeByInstance || !selectedInstanceId.trim()) {
        return pathname;
      }
      const separator = pathname.includes("?") ? "&" : "?";
      return `${pathname}${separator}instanceId=${encodeURIComponent(selectedInstanceId)}`;
    },
    [routeByInstance, selectedInstanceId],
  );
  const [selectedDiffId, setSelectedDiffId] = useState<string | null>(null);
  const [sendStatus, setSendStatus] = useState<string>("");
  const [modeStatus, setModeStatus] = useState<string>("");
  const [status, setStatus] = useState("Connecting…");
  const [thinkingPending, setThinkingPending] = useState(false);
  const [pendingReasoningEffort, setPendingReasoningEffort] =
    useState<ReasoningEffort | null>(null);
  const [slashCommands, setSlashCommands] = useState<SlashCommandInfo[]>([]);
  const [modes, setModes] = useState<ModeInfo[]>([]);
  const [models, setModels] = useState<WebviewModelInfo[]>([]);
  const [mobileLayout, setMobileLayout] = useState(false);
  const [touchInput, setTouchInput] = useState(false);
  const [mobilePane, setMobilePane] = useState<"review" | null>(null);
  const [sessionHistory, setSessionHistory] = useState<SessionSummary[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [showMcpStatus, setShowMcpStatus] = useState(false);
  const [expandedMcpServers, setExpandedMcpServers] = useState<Set<string>>(
    () => new Set(),
  );
  const [transcriptView, setTranscriptView] = useState<{
    sessionId: string;
    task: string;
    messages: ChatMessage[];
    streaming: boolean;
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
  const [approvalPanelHeight, setApprovalPanelHeight] = useState(360);
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

  useEffect(() => {
    let closed = false;
    let eventSource: EventSource | undefined;
    let instanceRefreshTimer: ReturnType<typeof setInterval> | undefined;
    let fallbackSnapshotTimer: ReturnType<typeof setInterval> | undefined;

    const stopFallbackSnapshotPolling = () => {
      if (!fallbackSnapshotTimer) return;
      clearInterval(fallbackSnapshotTimer);
      fallbackSnapshotTimer = undefined;
    };

    const fetchFallbackSnapshot = async () => {
      try {
        const response = await fetch(buildApiPath("/api/ui-state"));
        if (!response.ok) {
          if (!closed) {
            setStatus(
              `Realtime stream disconnected — snapshot failed: ${response.status}`,
            );
          }
          return;
        }
        const data = (await response.json()) as GatewaySnapshot;
        if (!closed) {
          setSnapshot(data);
          setStatus("Connected (fallback polling)");
        }
      } catch (err) {
        if (!closed) {
          setStatus(
            `Realtime stream disconnected — retrying… (${String(err)})`,
          );
        }
      }
    };

    const startFallbackSnapshotPolling = () => {
      if (fallbackSnapshotTimer) return;
      void fetchFallbackSnapshot();
      fallbackSnapshotTimer = setInterval(() => {
        void fetchFallbackSnapshot();
      }, 2_000);
    };

    const startRealtimeStream = () => {
      eventSource = new EventSource(buildApiPath("/events"));
      eventSource.onopen = () => {
        stopFallbackSnapshotPolling();
        setStatus("Connected");
      };
      eventSource.onerror = () => {
        setStatus("Realtime stream disconnected — retrying…");
        startFallbackSnapshotPolling();
      };
      eventSource.addEventListener("snapshot", applySnapshotEvent);
      eventSource.addEventListener("update", applySnapshotEvent);
    };

    const applySnapshotEvent = (event: MessageEvent<string>) => {
      try {
        const next = JSON.parse(event.data) as GatewaySnapshot;
        stopFallbackSnapshotPolling();
        setSnapshot(next);
        setStatus("Connected");
      } catch (err) {
        setStatus(`Stream parse error: ${String(err)}`);
      }
    };

    void (async () => {
      const resolvedInstanceId = await fetchInstances();
      if (closed) return;

      instanceRefreshTimer = setInterval(() => {
        void fetchInstances();
      }, 5_000);

      if (routeByInstance && !resolvedInstanceId) {
        setStatus("Waiting for active VS Code session…");
        return;
      }
      if (routeByInstance && resolvedInstanceId !== selectedInstanceId) {
        return;
      }

      void fetchSnapshot();
      void fetchSlashCommands();
      void fetchModes();
      void fetchModels();
      void fetchSessions();
      void fetchDebugInfo();
      startRealtimeStream();
    })();

    return () => {
      closed = true;
      if (instanceRefreshTimer) {
        clearInterval(instanceRefreshTimer);
      }
      stopFallbackSnapshotPolling();
      eventSource?.removeEventListener("snapshot", applySnapshotEvent);
      eventSource?.removeEventListener("update", applySnapshotEvent);
      eventSource?.close();
    };
  }, [selectedInstanceId, routeByInstance]);

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
  const pendingApproval = snapshot?.ui.approval ?? null;
  const pendingQuestion =
    foreground?.questionRequest ?? snapshot?.ui.question ?? null;
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
    foreground?.status === "awaiting_approval" ||
    instanceOptions.some(
      (instance) => instance.status?.kind === "awaiting_approval",
    ),
  );
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
      foreground?.status === "awaiting_approval"
    ) {
      return {
        kind: "awaiting_approval",
        label: pendingQuestion ? "Question" : "Approval",
        detail: foreground?.statusOverride ?? "Awaiting response",
        sessionTitle: foreground?.title,
      };
    }

    if (
      foreground?.streaming ||
      foreground?.status === "streaming" ||
      foreground?.status === "tool_executing"
    ) {
      return {
        kind: "working",
        label:
          foreground.status === "tool_executing" ? "Tool running" : "Working",
        detail: foreground.statusOverride ?? foreground.status,
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
    const currentSelectedInstanceId = selectedInstanceIdRef.current;
    if (
      currentSelectedInstanceId.trim() &&
      instances.some(
        (instance) => instance.instanceId === currentSelectedInstanceId,
      )
    ) {
      return currentSelectedInstanceId;
    }

    const liveInstances = instances.filter(
      (instance) => instance.disconnectedAt === undefined,
    );
    return (
      currentServerInstanceId ||
      liveInstances[0]?.instanceId ||
      instances[0]?.instanceId ||
      ""
    );
  }

  async function fetchInstances(): Promise<string | null> {
    try {
      const response = await fetch(buildApiPath("/api/instances"));
      if (!response.ok) {
        setStatus(`Instance list failed: ${response.status}`);
        return null;
      }
      const data = (await response.json()) as {
        currentInstanceId: string;
        instances: Array<{
          instanceId: string;
          workspaceName: string;
          workspacePath: string;
          url: string;
          status?: BrowserGatewayInstanceStatusSummary;
        }>;
      };
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
      const retainedDisconnectedInstances = instanceOptionsRef.current
        .filter((instance) => !liveInstanceIds.has(instance.instanceId))
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
      instanceOptionsRef.current = instances;
      setInstanceOptions(instances);
      const nextSelectedInstanceId = routeByInstance
        ? selectPreferredInstanceId(instances, data.currentInstanceId)
        : data.currentInstanceId || instances[0]?.instanceId || "";
      if (nextSelectedInstanceId !== selectedInstanceIdRef.current) {
        selectInstance(nextSelectedInstanceId);
      }
      return nextSelectedInstanceId;
    } catch (err) {
      setStatus(`Instance list error: ${String(err)}`);
      return null;
    }
  }

  async function fetchSnapshot(): Promise<void> {
    try {
      const response = await fetch(buildApiPath("/api/ui-state"));
      if (!response.ok) {
        setStatus(`Snapshot failed: ${response.status}`);
        return;
      }
      const data = (await response.json()) as GatewaySnapshot;
      setSnapshot(data);
    } catch (err) {
      setStatus(`Snapshot error: ${String(err)}`);
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

  async function fetchSlashCommands(): Promise<void> {
    try {
      const response = await fetch(buildApiPath("/api/slash-commands"), {
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      });
      if (!response.ok) {
        return;
      }
      const body = (await response.json()) as { commands?: SlashCommandInfo[] };
      if (Array.isArray(body.commands)) {
        setSlashCommands(body.commands);
      }
    } catch {
      // best effort only
    }
  }

  async function fetchModes(): Promise<void> {
    try {
      const response = await fetch(buildApiPath("/api/modes"), {
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      });
      if (!response.ok) {
        setModeStatus(`Mode list unavailable (${response.status})`);
        return;
      }
      const body = (await response.json()) as { modes?: ModeInfo[] };
      if (Array.isArray(body.modes) && body.modes.length > 0) {
        setModes(body.modes);
      }
    } catch {
      setModeStatus("Mode list unavailable");
    }
  }

  async function fetchModels(): Promise<void> {
    try {
      const response = await fetch(buildApiPath("/api/models"), {
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      });
      if (!response.ok) {
        setModeStatus(`Model list unavailable (${response.status})`);
        return;
      }
      const body = (await response.json()) as { models?: WebviewModelInfo[] };
      if (Array.isArray(body.models) && body.models.length > 0) {
        setModels(body.models);
      }
    } catch {
      setModeStatus("Model list unavailable");
    }
  }

  async function fetchSessions(): Promise<void> {
    try {
      const response = await fetch(buildApiPath("/api/sessions"), {
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      });
      if (!response.ok) {
        return;
      }
      const body = (await response.json()) as { sessions?: SessionSummary[] };
      if (Array.isArray(body.sessions)) {
        setSessionHistory(body.sessions);
      }
    } catch {
      // best effort only
    }
  }

  async function fetchDebugInfo(): Promise<void> {
    try {
      await fetch(buildApiPath("/api/debug/refresh"), {
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
  ): Promise<void> {
    if (!foreground) return;

    const userMessageId = crypto.randomUUID();
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
      return;
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
      setSendStatus("Sending…");
      const response = await fetch(buildApiPath("/api/send"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          text: trimmed,
          id: userMessageId,
          sessionId: foreground.sessionId,
          mode: foreground.mode,
          reasoningEffort: effectiveReasoningEffort,
          thinkingEnabled: effectiveReasoningEffort !== "none",
          attachments,
          images: images.length > 0 ? images : undefined,
          documents: documents.length > 0 ? documents : undefined,
          displayText: displayWithMedia,
          slashCommandLabel,
          isSlashCommand: Boolean(slashCommandLabel),
        }),
      });
      const body = (await response.json()) as {
        ok?: boolean;
        queued?: boolean;
        error?: string;
      };
      setSendStatus(
        body.ok
          ? body.queued
            ? "Queued."
            : "Sent"
          : body.error === "queue_full"
            ? "A message is already queued. Wait for it to send or remove it first."
            : `Send failed: ${body.error ?? response.status}`,
      );
    } catch (err) {
      setSendStatus(`Send error: ${String(err)}`);
    }
  }

  const handleStop = (): void => {
    if (!foreground?.sessionId) return;
    const sessionId = foreground.sessionId;
    setSendStatus("Stopping…");
    void (async () => {
      try {
        const response = await fetch(buildApiPath("/api/stop"), {
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
        setSendStatus(
          body.ok ? "Stopped" : `Stop failed: ${body.error ?? response.status}`,
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
      selectInstance(instanceId);
    }
  };

  const handleInstancePointerCancel = (e: PointerEvent): void => {
    if (touchTabPointerRef.current?.pointerId === e.pointerId) {
      touchTabPointerRef.current = null;
    }
  };

  const handleSetReasoningEffort = (effort: ReasoningEffort): void => {
    if (!foreground || thinkingPending) return;
    void (async () => {
      setPendingReasoningEffort(effort);
      setThinkingPending(true);
      const pendingTimeout = window.setTimeout(() => {
        setThinkingPending(false);
        setPendingReasoningEffort(null);
      }, 6000);
      try {
        const response = await fetch(buildApiPath("/api/thinking"), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${authToken}`,
          },
          body: JSON.stringify({ effort }),
        });
        const body = (await response.json()) as {
          ok?: boolean;
          error?: string;
        };
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
        setModeStatus(`Reasoning update error: ${String(err)}`);
        window.clearTimeout(pendingTimeout);
        setThinkingPending(false);
        setPendingReasoningEffort(null);
      }
    })();
  };

  const handleExportTranscript = (): void => {
    // Export stays VS Code-only for now.
  };

  const handleNewSession = (): void => {
    void (async () => {
      try {
        const response = await fetch(buildApiPath("/api/session/new"), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${authToken}`,
          },
          body: JSON.stringify({ mode: foreground?.mode ?? "code" }),
        });
        const body = (await response.json()) as {
          ok?: boolean;
          snapshot?: GatewaySnapshot;
        };
        if (body.ok) {
          if (body.snapshot) {
            setSnapshot(body.snapshot);
          }
          setShowHistory(false);
          setShowMcpStatus(false);
          void fetchSessions();
        }
      } catch {
        // best effort
      }
    })();
  };

  const handleShowHistory = (): void => {
    setShowHistory((prev) => !prev);
    void fetchSessions();
  };

  const handleLoadSession = (sessionId: string): void => {
    void (async () => {
      await fetch(buildApiPath("/api/session/load"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({ sessionId }),
      });
      setShowHistory(false);
      setShowMcpStatus(false);
    })();
  };

  const handleDeleteSession = (sessionId: string): void => {
    void (async () => {
      await fetch(buildApiPath("/api/session/delete"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({ sessionId }),
      });
      void fetchSessions();
    })();
  };

  const handleRenameSession = (sessionId: string, title: string): void => {
    void (async () => {
      await fetch(buildApiPath("/api/session/rename"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({ sessionId, title }),
      });
      void fetchSessions();
    })();
  };

  const handleCopyFirstPrompt = (sessionId: string): void => {
    void (async () => {
      const response = await fetch(
        buildApiPath("/api/session/copy-first-prompt"),
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${authToken}`,
          },
          body: JSON.stringify({ sessionId }),
        },
      );
      const body = (await response.json()) as { ok?: boolean; prompt?: string };
      if (body.ok && body.prompt) {
        void handleSend(body.prompt, []);
      }
    })();
  };

  const handleSwitchMode = (slug: string): void => {
    if (!slug || slug === foreground?.mode) return;
    void (async () => {
      try {
        setModeStatus("Switching…");
        const response = await fetch(buildApiPath("/api/mode"), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${authToken}`,
          },
          body: JSON.stringify({ mode: slug }),
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
    if (!modelId) return;
    void (async () => {
      try {
        setModeStatus("Switching model…");
        const response = await fetch(buildApiPath("/api/model"), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${authToken}`,
          },
          body: JSON.stringify({ model: modelId }),
        });
        const body = (await response.json()) as {
          ok?: boolean;
          error?: string;
          snapshot?: GatewaySnapshot;
        };
        if (body.ok && body.snapshot) {
          setSnapshot(body.snapshot);
        }
        setModeStatus(
          body.ok
            ? "Model updated"
            : `Model switch failed: ${body.error ?? response.status}`,
        );
      } catch (err) {
        setModeStatus(`Model switch error: ${String(err)}`);
      }
    })();
  };

  const handleSetWriteApproval = (nextMode: string): void => {
    if (!nextMode) return;
    void (async () => {
      try {
        const response = await fetch(buildApiPath("/api/write-approval"), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${authToken}`,
          },
          body: JSON.stringify({ mode: nextMode }),
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

  const handleMcpAction = (
    serverName: string,
    action: "disable" | "reconnect" | "reauthenticate",
  ): void => {
    void (async () => {
      await fetch(buildApiPath("/api/mcp/action"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({ serverName, action }),
      });
    })();
  };

  const handleForwardedApprovalSubmit = (
    data: Omit<DecisionMessage, "type">,
  ): void => {
    const submittedApprovalId = data.id;
    setLocalDismissedApprovalId(submittedApprovalId);
    void (async () => {
      const response = await fetch(buildApiPath("/api/approval"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          ...data,
          followUp: forwardedFollowUpRef.current,
        }),
      });
      const body = (await response.json()) as { ok?: boolean; error?: string };
      if (!body.ok) {
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
      const nextHeight = Math.max(220, Math.min(720, startHeight - delta));
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
    void handleSend("Retry the last step.", []);
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
          // Browser transcript opens from a gateway snapshot. Unlike the VS Code
          // webview, it does not receive background-agent stream deltas, so avoid
          // showing a live spinner for frozen content.
          streaming: false,
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
      case "condense":
      case "checkpoint":
      case "revert":
      case "mcp-config":
      case "mcp-refresh":
      case "btw":
      case "help":
        void handleSend(`/${name}${args ? ` ${args}` : ""}`, []);
        break;
      case "mcp":
        setShowMcpStatus(true);
        break;
      case "pair":
        setModeStatus(
          "Run /pair in VS Code to add a new browser device — pairing codes can only be generated there.",
        );
        break;
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
              provider: "local",
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
        const url = buildApiPath(
          `/api/search-files?query=${encodeURIComponent(query)}`,
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
            Authorization: `Bearer ${authToken}`,
          },
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
        if (id) {
          void fetch(buildApiPath("/api/question"), {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${authToken}`,
            },
            body: JSON.stringify({ id, answers, notes }),
          });
        }
        return;
      }

      if (command === "agentQuestionProgress") {
        const id = String(data.id ?? "").trim();
        const step = Number(data.step ?? 0);
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
          void fetch(buildApiPath("/api/question-progress"), {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${authToken}`,
            },
            body: JSON.stringify({ id, step, answers, notes, origin }),
          });
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
        if (writeApprovalMode) {
          handleSetWriteApproval(writeApprovalMode);
        }
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
        {(instanceOptions.length > 0
          ? instanceOptions
          : [
              {
                instanceId: selectedInstanceId,
                workspaceName,
                workspacePath: "",
                url: "",
                lastSeenAt: Date.now(),
              },
            ]
        ).map((instance) => {
          const instanceStatus = getInstanceStatus(instance);
          const active = instance.instanceId === selectedInstanceId;
          return (
            <button
              key={instance.instanceId}
              aria-controls="browser-instance-panel"
              aria-selected={active}
              class={`instance-tab instance-tab-${instanceStatus.kind}${active ? " active" : ""}`}
              id={`instance-tab-${instance.instanceId}`}
              onClick={() => selectInstance(instance.instanceId)}
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
                <span class="instance-tab-name">{instance.workspaceName}</span>
              </span>
              <span class="instance-tab-status">
                <i
                  class={`codicon codicon-${getInstanceStatusIcon(instanceStatus.kind)}${instanceStatus.kind === "working" ? " codicon-modifier-spin" : ""}`}
                />
                <span>{instanceStatus.label}</span>
              </span>
            </button>
          );
        })}
      </div>

      {/** Shared sendability rule: text or other attached content. */}

      <main
        ref={browserLayoutRef}
        aria-labelledby={`instance-tab-${selectedInstanceId}`}
        class={`browser-layout${sidePaneResizing ? " browser-layout-resizing" : ""}`}
        id="browser-instance-panel"
        role="tabpanel"
        style={
          {
            "--browser-side-width": `${sidePanePercent}%`,
          } as unknown as JSX.CSSProperties
        }
      >
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

        <section class="browser-main">
          <PaneCard fill className="chat-pane-card">
            <div class="pane-body browser-chat-pane chat-container">
              {transcriptView && (
                <TranscriptView
                  task={transcriptView.task}
                  messages={transcriptView.messages}
                  streaming={transcriptView.streaming}
                  onClose={() => setTranscriptView(null)}
                />
              )}
              <div class="chat-header">
                <button
                  class="icon-button"
                  onClick={handleNewSession}
                  title={
                    foreground?.restoringSession
                      ? "Start a new session without waiting for restore"
                      : "New Session"
                  }
                >
                  <i class="codicon codicon-add" />
                </button>
                {foreground?.restoringSession && (
                  <div
                    class="session-restore-status"
                    title="Restoring the last session"
                  >
                    <i class="codicon codicon-loading codicon-modifier-spin" />
                    <span>Loading last session…</span>
                  </div>
                )}
                <button
                  class={`icon-button${showHistory ? " active" : ""}`}
                  onClick={handleShowHistory}
                  title="Session History"
                >
                  <i class="codicon codicon-history" />
                </button>
              </div>
              {showHistory && (
                <SessionHistory
                  sessions={sessionHistory}
                  currentSessionId={foreground?.sessionId ?? null}
                  onLoad={handleLoadSession}
                  onDelete={handleDeleteSession}
                  onRename={handleRenameSession}
                  onCopyFirstPrompt={handleCopyFirstPrompt}
                  onClose={() => setShowHistory(false)}
                />
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
                <ChatView
                  messages={messages}
                  streaming={Boolean(streaming)}
                  sessionId={foreground?.sessionId ?? null}
                  detectedQuestion={foreground?.detectedQuestion ?? null}
                  onDetectedQuestionAnswer={(payload) => {
                    void handleSend(payload, []);
                  }}
                  onDismissDetectedQuestion={() => undefined}
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
                    setHiddenFinalContinueMessageIds((prev) => {
                      const next = new Set(prev);
                      for (const message of messages) {
                        if (
                          message.role !== "assistant" ||
                          !message.finalMarker
                        ) {
                          continue;
                        }
                        if (
                          getFinalMessageContinueAction(message.finalMarker)
                            ?.prompt === prompt
                        ) {
                          next.add(message.id);
                        }
                      }
                      return next;
                    });
                    void handleSend(prompt, []);
                  }}
                  onRevertCheckpoint={handleRevertCheckpoint}
                  onViewCheckpointDiff={handleViewCheckpointDiff}
                />
              </div>
              {foreground &&
                foreground.messageQueue.length > 0 &&
                !mobileReviewOpen && (
                  <div class="queue-panel">
                    <div class="queue-header">
                      <i class="codicon codicon-list-ordered" />
                      <span>Queued ({foreground.messageQueue.length})</span>
                    </div>
                    {foreground.messageQueue.map((item) => (
                      <div key={item.id} class="queue-item">
                        <span class="queue-item-text">{item.text}</span>
                      </div>
                    ))}
                  </div>
                )}
              {!mobileReviewOpen &&
              ((foreground?.lastInputTokens ?? 0) > 0 ||
                (foreground?.lastOutputTokens ?? 0) > 0 ||
                (foreground?.estimatedTotalUsed ?? 0) > 0) ? (
                <div class="browser-context-row">
                  {(() => {
                    const currentModel = composerModels.find(
                      (model) => model.id === (foreground?.model ?? ""),
                    );
                    return (
                      <ContextBar
                        inputTokens={foreground?.lastInputTokens ?? 0}
                        outputTokens={foreground?.lastOutputTokens ?? 0}
                        cacheReadTokens={foreground?.lastCacheReadTokens ?? 0}
                        maxContextWindow={
                          currentModel?.contextWindow ?? DEFAULT_MAX_TOKENS
                        }
                        maxInputTokens={
                          foreground?.contextBudget?.maxInputTokens ??
                          currentModel?.maxInputTokens
                        }
                        usedInputTokens={
                          foreground?.contextBudget?.usedInputTokens
                        }
                        outputReservation={
                          foreground?.contextBudget?.outputReservation
                        }
                        safetyBufferTokens={
                          foreground?.contextBudget?.safetyBufferTokens
                        }
                        softThresholdBudget={
                          foreground?.contextBudget?.softThresholdBudget
                        }
                        hardBudget={foreground?.contextBudget?.hardBudget}
                        condenseThreshold={foreground?.condenseThreshold}
                        estimatedTotalUsed={foreground?.estimatedTotalUsed ?? 0}
                      />
                    );
                  })()}
                </div>
              ) : null}
              {!mobileReviewOpen &&
                showMcpStatus &&
                snapshot?.ui.mcpStatusInfos && (
                  <div class="mcp-status-panel">
                    <div class="mcp-status-header">
                      <i class="codicon codicon-server" />
                      <span>MCP Servers</span>
                      <button
                        class="mcp-status-close icon-button"
                        onClick={() => setShowMcpStatus(false)}
                        title="Dismiss"
                      >
                        <i class="codicon codicon-close" />
                      </button>
                    </div>
                    {snapshot.ui.mcpStatusInfos.length === 0 ? (
                      <p class="mcp-status-empty">No MCP servers configured.</p>
                    ) : (
                      <ul class="mcp-status-list">
                        {snapshot.ui.mcpStatusInfos.map((info) => (
                          <li
                            key={info.name}
                            class={`mcp-status-item mcp-status-${info.status}`}
                          >
                            <div class="mcp-status-row">
                              <button
                                class="mcp-status-expand icon-button"
                                disabled={
                                  info.tools.length === 0 &&
                                  !expandedMcpServers.has(info.name)
                                }
                                aria-expanded={expandedMcpServers.has(
                                  info.name,
                                )}
                                title={
                                  info.tools.length === 0 &&
                                  !expandedMcpServers.has(info.name)
                                    ? "No tools available"
                                    : expandedMcpServers.has(info.name)
                                      ? "Hide tools"
                                      : "Show tools"
                                }
                                onClick={() => {
                                  setExpandedMcpServers((prev) => {
                                    const next = new Set(prev);
                                    if (next.has(info.name)) {
                                      next.delete(info.name);
                                    } else {
                                      next.add(info.name);
                                    }
                                    return next;
                                  });
                                }}
                              >
                                <i
                                  class={`codicon codicon-chevron-${expandedMcpServers.has(info.name) ? "down" : "right"}`}
                                />
                              </button>
                              <i
                                class={`codicon ${
                                  info.status === "connected"
                                    ? "codicon-check"
                                    : info.status === "connecting"
                                      ? "codicon-loading codicon-modifier-spin"
                                      : "codicon-error"
                                }`}
                              />
                              <span class="mcp-status-name">{info.name}</span>
                              <span class="mcp-status-detail">
                                {info.status === "connected"
                                  ? [
                                      `${info.toolCount} tool${info.toolCount !== 1 ? "s" : ""}`,
                                      info.resourceCount > 0 &&
                                        `${info.resourceCount} resource${info.resourceCount !== 1 ? "s" : ""}`,
                                      info.promptCount > 0 &&
                                        `${info.promptCount} prompt${info.promptCount !== 1 ? "s" : ""}`,
                                    ]
                                      .filter(Boolean)
                                      .join(" · ")
                                  : (info.error ?? info.status)}
                              </span>
                              <span class="mcp-status-actions">
                                {info.status !== "connecting" && (
                                  <button
                                    class="icon-button"
                                    title="Reconnect"
                                    onClick={() =>
                                      handleMcpAction(info.name, "reconnect")
                                    }
                                  >
                                    <i class="codicon codicon-refresh" />
                                  </button>
                                )}
                                <button
                                  class="icon-button"
                                  title="Reauthenticate"
                                  onClick={() =>
                                    handleMcpAction(info.name, "reauthenticate")
                                  }
                                >
                                  <i class="codicon codicon-key" />
                                </button>
                                <button
                                  class="icon-button mcp-action-disable"
                                  title="Disable"
                                  onClick={() =>
                                    handleMcpAction(info.name, "disable")
                                  }
                                >
                                  <i class="codicon codicon-circle-slash" />
                                </button>
                              </span>
                            </div>
                            {expandedMcpServers.has(info.name) && (
                              <ul class="mcp-tool-list">
                                {info.tools.length === 0 ? (
                                  <li class="mcp-tool-empty">
                                    No tools available.
                                  </li>
                                ) : (
                                  info.tools.map((tool) => (
                                    <li key={tool.name} class="mcp-tool-item">
                                      <span class="mcp-tool-name">
                                        {tool.name}
                                      </span>
                                      {tool.description && (
                                        <span
                                          class="mcp-tool-description"
                                          title={tool.description}
                                        >
                                          {tool.description}
                                        </span>
                                      )}
                                    </li>
                                  ))
                                )}
                              </ul>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              {!mobileReviewOpen && (foreground?.todos?.length ?? 0) > 0 && (
                <TodoPanel todos={foreground?.todos ?? []} />
              )}
              {visibleQuestion && !mobileReviewOpen && (
                <QuestionCard
                  key={visibleQuestion.id}
                  id={visibleQuestion.id}
                  context={visibleQuestion.context}
                  questions={visibleQuestion.questions}
                  backgroundTask={visibleQuestion.backgroundTask}
                  modes={modes}
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
                    });
                  }}
                  onSubmit={(id, answers, notes) => {
                    setLocalDismissedQuestionId(id);
                    browserVscodeApi.postMessage({
                      command: "agentQuestionResponse",
                      id,
                      answers,
                      notes,
                    });
                  }}
                />
              )}
              {visibleApproval && (
                <div
                  class={`approval-panel-embed${approvalResizing ? " approval-panel-embed-resizing" : ""}`}
                  style={{ height: `${approvalPanelHeight}px` }}
                >
                  <div
                    class="approval-panel-embed-handle"
                    onMouseDown={(e) =>
                      handleApprovalResizeStart(e as unknown as MouseEvent)
                    }
                    title="Drag to resize approval card"
                  />
                  {canOpenMobileReview && (
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
                  )}
                  {visibleApproval.kind === "command" ? (
                    <CommandCard
                      request={visibleApproval}
                      submit={handleForwardedApprovalSubmit}
                      followUpRef={forwardedFollowUpRef}
                      onSuggestRegex={handleSuggestRegex}
                    />
                  ) : visibleApproval.kind === "write" ? (
                    <WriteCard
                      request={visibleApproval}
                      submit={handleForwardedApprovalSubmit}
                      followUpRef={forwardedFollowUpRef}
                    />
                  ) : visibleApproval.kind === "rename" ? (
                    <RenameCard
                      request={visibleApproval}
                      submit={handleForwardedApprovalSubmit}
                      followUpRef={forwardedFollowUpRef}
                    />
                  ) : visibleApproval.kind === "mcp" ? (
                    <McpCard
                      request={visibleApproval}
                      submit={handleForwardedApprovalSubmit}
                      followUpRef={forwardedFollowUpRef}
                    />
                  ) : visibleApproval.kind === "memory" ? (
                    <MemoryCard
                      request={visibleApproval}
                      submit={handleForwardedApprovalSubmit}
                      followUpRef={forwardedFollowUpRef}
                    />
                  ) : visibleApproval.kind === "mode-switch" ? (
                    <ModeSwitchCard
                      request={visibleApproval}
                      submit={handleForwardedApprovalSubmit}
                      followUpRef={forwardedFollowUpRef}
                    />
                  ) : (
                    <PathCard
                      request={visibleApproval}
                      submit={handleForwardedApprovalSubmit}
                      followUpRef={forwardedFollowUpRef}
                    />
                  )}
                </div>
              )}
              {streaming && !mobileReviewOpen ? (
                <div class="streaming-status-bar browser-streaming-row">
                  <i class="codicon codicon-loading codicon-modifier-spin" />
                  <span>
                    {statusOverride ??
                      (() => {
                        const lastMsg = messages[messages.length - 1];
                        if (lastMsg?.role === "assistant") {
                          return getStreamingActivity(lastMsg.blocks);
                        }
                        return "Waiting for response…";
                      })()}
                  </span>
                </div>
              ) : null}
              {!mobileReviewOpen && (
                <BackgroundSessionStrip
                  sessions={background}
                  onStop={handleStopBackground}
                  onOpenTranscript={handleOpenBgTranscript}
                />
              )}
              {!mobileReviewOpen && (
                <div class="browser-chat-composer">
                  <InputArea
                    onSend={handleSend}
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
                    onExecuteBuiltinCommand={handleExecuteBuiltinCommand}
                    modes={composerModes}
                    currentMode={foreground?.mode ?? "code"}
                    currentModel={foreground?.model ?? "claude-sonnet-4-6"}
                    currentCondenseThreshold={foreground?.condenseThreshold}
                    availableModels={composerModels}
                    onSwitchMode={handleSwitchMode}
                    onSelectModel={handleSelectModel}
                    onSetCondenseThreshold={handleSetCondenseThreshold}
                    onSignIn={handleSignIn}
                    agentWriteApproval={
                      foreground?.agentWriteApproval ?? "prompt"
                    }
                    onSetAgentWriteApproval={handleSetWriteApproval}
                    autoContinueEnabled={autoContinueEnabled}
                    onToggleAutoContinue={handleToggleAutoContinue}
                    autoContinueStatus={autoContinueStatus}
                    allowAttachments={true}
                    allowMediaPaste={true}
                    allowThinkingToggle={true}
                    allowExportTranscript={false}
                    allowFileMentions={true}
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
