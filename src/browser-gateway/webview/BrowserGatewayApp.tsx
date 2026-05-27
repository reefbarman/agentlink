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
import { InputArea } from "../../agent/webview/components/InputArea";
import { McpCard } from "../../approvals/webview/components/McpCard";
import { ModeSwitchCard } from "../../approvals/webview/components/ModeSwitchCard";
import { PathCard } from "../../approvals/webview/components/PathCard";
import { QuestionCard } from "../../agent/webview/components/QuestionCard";
import { RenameCard } from "../../approvals/webview/components/RenameCard";
import { SessionHistory } from "../../agent/webview/components/SessionHistory";
import { TodoPanel } from "../../agent/webview/components/TodoPanel";
import { TranscriptView } from "../../agent/webview/components/TranscriptView";
import { WriteCard } from "../../approvals/webview/components/WriteCard";
import { getStreamingActivity } from "../../agent/webview/components/MessageBubble";

import { agentMessagesToChatMessages } from "../../shared/chatProjection";
import {
  getFinalMessageContinueAction,
  getLatestAutoContinueAction,
  getLatestFinalMessageMarker,
} from "../../shared/finalStatus";
import { MetaGrid, MetaItem, Pill, TitleRow } from "../../shared/ui/Meta";
import { EmptyState, PaneCard, PaneHeader } from "../../shared/ui/Panes";

import { deriveTerminalBuffers } from "../../shared/terminalActivity";
import { BrowserTerminalPane } from "./components/BrowserTerminalPane";
import type {
  BgSessionInfo,
  BrowserGatewayThemeSnapshot,
} from "../../shared/types";
import type { BrowserGatewayInstanceStatusSummary } from "../protocol";

const DEFAULT_MAX_TOKENS = 200_000;
const AUTO_CONTINUE_MAX_TURNS = 10;
const AUTO_CONTINUE_BROWSER_SETTLE_MS = 500;
const THEME_CACHE_KEY = "agentlink.browserGateway.themeSnapshot.v1";
const TAB_FLASH_INTERVAL_MS = 1_000;
const TAB_FLASH_TITLE = "⚠ Action needed — AgentLink";

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
      finalMarker = { ...rest, continueActionSuppressed: true };
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

type GatewaySnapshot = {
  ui: {
    approval: ApprovalRequest | null;
    question: {
      id: string;
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
    }>;
  };
  session: {
    terminals: Array<{
      id: string;
      name: string;
      busy: boolean;
      stale?: boolean;
    }>;
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
        questions: Question[];
        backgroundTask?: string;
      } | null;
      detectedQuestion: (DetectedQuestion & { messageId: string }) | null;
      todos: TodoItem[];
      debugInfo: Record<string, string | number> | null;
      systemPrompt: string | null;
      loadedInstructions: Array<{ source: string; chars: number }> | null;
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

type DiffDetail = {
  requestId: string;
  filePath: string;
  operation: string;
  outsideWorkspace: boolean;
  createdAt: number;
  originalContent: string;
  proposedContent: string;
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
    Array<{
      instanceId: string;
      workspaceName: string;
      workspacePath: string;
      url: string;
      status?: BrowserGatewayInstanceStatusSummary;
    }>
  >([]);
  const [selectedInstanceId, setSelectedInstanceId] =
    useState(currentInstanceId);
  const userSelectedInstanceRef = useRef(false);

  function buildApiPath(pathname: string): string {
    if (!routeByInstance || !selectedInstanceId.trim()) {
      return pathname;
    }
    const separator = pathname.includes("?") ? "&" : "?";
    return `${pathname}${separator}instanceId=${encodeURIComponent(selectedInstanceId)}`;
  }
  const [selectedDiffId, setSelectedDiffId] = useState<string | null>(null);
  const [selectedDiff, setSelectedDiff] = useState<DiffDetail | null>(null);
  const [sendStatus, setSendStatus] = useState<string>("");
  const [modeStatus, setModeStatus] = useState<string>("");
  const [reviewStatus, setReviewStatus] = useState<string>("");
  const [status, setStatus] = useState("Connecting…");
  const [thinkingPending, setThinkingPending] = useState(false);
  const [pendingReasoningEffort, setPendingReasoningEffort] =
    useState<ReasoningEffort | null>(null);
  const [slashCommands, setSlashCommands] = useState<SlashCommandInfo[]>([]);
  const [modes, setModes] = useState<ModeInfo[]>([]);
  const [models, setModels] = useState<WebviewModelInfo[]>([]);
  const [mobilePane, setMobilePane] = useState<"review" | "terminal" | null>(
    null,
  );
  const [sessionHistory, setSessionHistory] = useState<SessionSummary[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [showMcpStatus, setShowMcpStatus] = useState(false);
  const [transcriptView, setTranscriptView] = useState<{
    sessionId: string;
    task: string;
    messages: ChatMessage[];
    streaming: boolean;
  } | null>(null);
  const [localDismissedApprovalId, setLocalDismissedApprovalId] = useState<
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
  const autoContinueSessionIdRef = useRef<string | null>(null);
  const [approvalPanelHeight, setApprovalPanelHeight] = useState(360);
  const [approvalResizing, setApprovalResizing] = useState(false);
  const approvalResizeCleanupRef = useRef<(() => void) | null>(null);
  const forwardedFollowUpRef = useRef("");
  const appliedThemeKeysRef = useRef<Set<string>>(new Set());
  const questionProgressOriginRef = useRef<string>(
    `br-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`,
  );

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
    if (!selectedDiffId) {
      setSelectedDiff(null);
      return;
    }
    if (!snapshot?.diffs.some((diff) => diff.requestId === selectedDiffId)) {
      setSelectedDiffId(null);
      setSelectedDiff(null);
      return;
    }
    void fetchDiffDetail(selectedDiffId);
  }, [selectedDiffId, snapshot]);

  const messages = useMemo<ChatMessage[]>(() => {
    return projectFinalMarkerAutoContinueState(
      snapshot?.session.foreground?.projectedMessages ?? [],
      hiddenFinalContinueMessageIds,
      autoContinueStopReasons,
    );
  }, [autoContinueStopReasons, hiddenFinalContinueMessageIds, snapshot]);

  const terminalBuffers = useMemo(() => {
    return deriveTerminalBuffers(messages, {
      workspaceName,
      gitBranch: snapshot?.session.repository?.branch,
      dirty: snapshot?.session.repository?.dirty,
      terminals: snapshot?.session.terminals ?? [],
    });
  }, [
    messages,
    snapshot?.session.repository?.branch,
    snapshot?.session.repository?.dirty,
    snapshot?.session.terminals,
    workspaceName,
  ]);

  const foreground = snapshot?.session.foreground ?? null;
  const reasoningEffort: ReasoningEffort = foreground
    ? (foreground.reasoningEffort ??
      (foreground.thinkingEnabled === false ? "none" : "high"))
    : "none";
  const effectiveReasoningEffort =
    thinkingPending && pendingReasoningEffort !== null
      ? pendingReasoningEffort
      : reasoningEffort;

  const diffs = snapshot?.diffs ?? [];
  const background = snapshot?.background ?? [];
  const pendingApproval = snapshot?.ui.approval ?? null;
  const pendingQuestion =
    foreground?.questionRequest ?? snapshot?.ui.question ?? null;
  const visibleApproval =
    pendingApproval && pendingApproval.id !== localDismissedApprovalId
      ? pendingApproval
      : null;
  const awaitingUserInput = Boolean(
    visibleApproval ||
    pendingQuestion ||
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
      case "idle":
        return "circle-filled";
    }
  }

  function selectPreferredInstanceId(
    instances: Array<{
      instanceId: string;
      status?: BrowserGatewayInstanceStatusSummary;
    }>,
    currentServerInstanceId: string,
  ): string {
    const selectedInstanceStillExists = instances.some(
      (instance) => instance.instanceId === selectedInstanceId,
    );
    if (
      userSelectedInstanceRef.current &&
      selectedInstanceId.trim() &&
      selectedInstanceStillExists
    ) {
      return selectedInstanceId;
    }

    const activeInstance = instances.find(
      (instance) =>
        instance.status?.kind === "awaiting_approval" ||
        instance.status?.kind === "working" ||
        instance.status?.kind === "error",
    );

    if (activeInstance) {
      return activeInstance.instanceId;
    }
    if (selectedInstanceId.trim() && selectedInstanceStillExists) {
      return selectedInstanceId;
    }
    return currentServerInstanceId || instances[0]?.instanceId || "";
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
      setInstanceOptions(data.instances);
      const nextSelectedInstanceId = routeByInstance
        ? selectPreferredInstanceId(data.instances, data.currentInstanceId)
        : data.currentInstanceId || data.instances[0]?.instanceId || "";
      if (nextSelectedInstanceId !== selectedInstanceId) {
        setSelectedInstanceId(nextSelectedInstanceId);
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

  async function fetchDiffDetail(requestId: string): Promise<void> {
    if (selectedDiff?.requestId === requestId) {
      return;
    }
    try {
      const response = await fetch(
        buildApiPath(`/api/diff/${encodeURIComponent(requestId)}`),
      );
      if (!response.ok) {
        setSelectedDiff(null);
        return;
      }
      setSelectedDiff((await response.json()) as DiffDetail);
    } catch {
      setSelectedDiff(null);
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
  ): Promise<void> {
    if (!foreground) return;

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
          `${documents.length} PDF${documents.length > 1 ? "s" : ""}`,
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
      const body = (await response.json()) as { ok?: boolean; error?: string };
      setSendStatus(
        body.ok ? "Sent" : `Send failed: ${body.error ?? response.status}`,
      );
    } catch (err) {
      setSendStatus(`Send error: ${String(err)}`);
    }
  }

  const handleStop = (): void => {
    // Browser pane remains send-only for now; no remote stop endpoint yet.
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
        const body = (await response.json()) as { ok?: boolean };
        if (body.ok) {
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
        };
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
        setReviewStatus(
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
        setReviewStatus(
          body.ok
            ? "Background session stopped"
            : `Stop failed: ${body.error ?? response.status}`,
        );
      } catch (err) {
        setReviewStatus(`Stop error: ${String(err)}`);
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
          setReviewStatus(
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
        setReviewStatus(
          `Loaded ${converted.length} messages (${assistantBlocks} assistant blocks) for ${body.transcript.task}`,
        );
      } catch (err) {
        setReviewStatus(`Open transcript error: ${String(err)}`);
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
        setReviewStatus(
          "Run /pair in VS Code to add a new browser device — pairing codes can only be generated there.",
        );
        break;
    }
  };

  async function handleQuestionAnswer(): Promise<void> {
    if (!pendingQuestion) return;
    try {
      const missingRecommendation = pendingQuestion.questions.find(
        (question) => question.recommended === undefined,
      );
      if (missingRecommendation) {
        setReviewStatus(
          "Cannot auto-answer: one or more questions have no recommended value.",
        );
        return;
      }

      const answers: Record<string, string> = {};
      for (const question of pendingQuestion.questions) {
        answers[question.id] = question.recommended ?? "";
      }
      setReviewStatus("Answering question…");
      const response = await fetch(buildApiPath("/api/question"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          id: pendingQuestion.id,
          answers,
          notes: {},
        }),
      });
      const body = (await response.json()) as { ok?: boolean };
      setReviewStatus(body.ok ? "Question answered" : "Question action failed");
    } catch (err) {
      setReviewStatus(`Question error: ${String(err)}`);
    }
  }

  const reviewPaneContent = pendingQuestion ? (
    <div class="review-card review-priority-card">
      <div class="review-kicker">Pending question</div>
      <TitleRow
        title={
          <>
            {pendingQuestion.questions.length} question
            {pendingQuestion.questions.length === 1 ? "" : "s"}
          </>
        }
        right={<Pill>Action needed</Pill>}
      />
      <div class="stacked-list">
        {pendingQuestion.questions.map((question, index) => (
          <div key={question.id} class="question-row question-card-lite">
            <div class="question-index">{index + 1}</div>
            <div class="question-content">
              <div class="question-text">{question.question}</div>
              <div class="review-meta">
                Type: {question.type}
                {question.recommended !== undefined
                  ? ` · Recommended: ${String(question.recommended)}`
                  : ""}
              </div>
            </div>
          </div>
        ))}
      </div>
      <div class="button-row">
        <button onClick={() => void handleQuestionAnswer()}>
          Answer with recommended values
        </button>
      </div>
      {reviewStatus && <div class="review-meta">{reviewStatus}</div>}
    </div>
  ) : diffs.length > 0 ? (
    <>
      <div class="review-section-label">Pending diffs</div>
      <div class="diff-list">
        {diffs.map((diff) => (
          <button
            key={diff.requestId}
            class={`diff-list-item ${selectedDiffId === diff.requestId ? "active" : ""}`}
            onClick={() => setSelectedDiffId(diff.requestId)}
          >
            <div class="diff-list-title-row">
              <div class="diff-list-title">{diff.filePath}</div>
              <Pill subtle>{diff.operation}</Pill>
            </div>
            <div class="review-meta">
              {diff.outsideWorkspace ? "Outside workspace · " : ""}
              {formatTimestamp(diff.createdAt)}
            </div>
          </button>
        ))}
      </div>
      <div class="diff-detail-card">
        {selectedDiff ? (
          <>
            <TitleRow
              title={selectedDiff.filePath}
              right={<Pill subtle>{selectedDiff.operation}</Pill>}
            />
            <MetaGrid compact>
              <MetaItem
                label="Created"
                value={formatTimestamp(selectedDiff.createdAt)}
              />
              <MetaItem
                label="Workspace"
                value={
                  selectedDiff.outsideWorkspace
                    ? "Outside workspace"
                    : "Inside workspace"
                }
              />
            </MetaGrid>
            <div class="diff-columns">
              <div class="diff-panel">
                <div class="diff-panel-header">Original</div>
                <pre>{selectedDiff.originalContent}</pre>
              </div>
              <div class="diff-panel">
                <div class="diff-panel-header">Proposed</div>
                <pre>{selectedDiff.proposedContent}</pre>
              </div>
            </div>
          </>
        ) : (
          <EmptyState>Select a diff to preview it.</EmptyState>
        )}
      </div>
    </>
  ) : (
    <EmptyState>No pending approvals, questions, or diffs.</EmptyState>
  );

  const terminalPaneContent = (
    <BrowserTerminalPane
      buffers={terminalBuffers}
      sessionId={foreground?.sessionId ?? null}
    />
  );

  const streaming = foreground?.streaming === true;
  const statusOverride = foreground?.statusOverride ?? null;

  useEffect(() => {
    const sessionId = foreground?.sessionId ?? null;
    if (autoContinueSessionIdRef.current === sessionId) return;
    autoContinueSessionIdRef.current = sessionId;
    autoContinuedMessageIdsRef.current.clear();
    autoContinueCountRef.current = 0;
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
      void handleSend(action.prompt, []);
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
        const pathsRaw = Array.isArray(data.paths)
          ? (data.paths as unknown[])
          : [];
        const files = pathsRaw
          .map((value) => String(value).trim())
          .filter((value) => value.length > 0);
        window.postMessage({
          type: "agentDroppedFilesResolved",
          files,
        });
      }
    },
  };

  return (
    <div class="browser-shell">
      <header class="browser-header">
        <div>
          <div class="browser-title">AgentLink Remote</div>
          <div class="browser-subtitle">
            {workspaceName} · {selectedInstanceId}
          </div>
        </div>
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
              onClick={() => {
                userSelectedInstanceRef.current = true;
                setSelectedInstanceId(instance.instanceId);
              }}
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

      {/** Shared sendability rule: text or other attached content. Browser currently has text only. */}

      <main
        aria-labelledby={`instance-tab-${selectedInstanceId}`}
        class="browser-layout"
        id="browser-instance-panel"
        role="tabpanel"
      >
        <section class="browser-side browser-side-top">
          <PaneCard fill>
            <PaneHeader title="Review" />
            <div class="pane-body stacked-list">{reviewPaneContent}</div>
          </PaneCard>
        </section>

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
                <div class="mobile-pane-actions">
                  <button
                    class={`secondary mobile-pane-toggle ${mobilePane === "review" ? "active" : ""}`}
                    onClick={() =>
                      setMobilePane((current) =>
                        current === "review" ? null : "review",
                      )
                    }
                    type="button"
                  >
                    Review
                  </button>
                  <button
                    class={`secondary mobile-pane-toggle ${mobilePane === "terminal" ? "active" : ""}`}
                    onClick={() =>
                      setMobilePane((current) =>
                        current === "terminal" ? null : "terminal",
                      )
                    }
                    type="button"
                  >
                    Terminal
                  </button>
                </div>
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
              {mobilePane && (
                <div class="mobile-secondary-pane">
                  <PaneCard fill className="mobile-secondary-card">
                    <PaneHeader
                      title={
                        mobilePane === "review"
                          ? "Review"
                          : "Terminal / Activity"
                      }
                      right={
                        <button
                          class="icon-button"
                          onClick={() => setMobilePane(null)}
                          title="Close"
                          type="button"
                        >
                          <i class="codicon codicon-close" />
                        </button>
                      }
                    />
                    <div class="pane-body stacked-list">
                      {mobilePane === "review" ? (
                        reviewPaneContent
                      ) : (
                        <BrowserTerminalPane
                          buffers={terminalBuffers}
                          sessionId={foreground?.sessionId ?? null}
                          showInstanceList={false}
                        />
                      )}
                    </div>
                  </PaneCard>
                </div>
              )}
              <div class="browser-transcript">
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
              {foreground && foreground.messageQueue.length > 0 && (
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
              {(foreground?.lastInputTokens ?? 0) > 0 ||
              (foreground?.lastOutputTokens ?? 0) > 0 ||
              (foreground?.estimatedTotalUsed ?? 0) > 0 ? (
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
              {showMcpStatus && snapshot?.ui.mcpStatusInfos && (
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
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
              {(foreground?.todos?.length ?? 0) > 0 && (
                <TodoPanel todos={foreground?.todos ?? []} />
              )}
              {pendingQuestion && (
                <QuestionCard
                  key={pendingQuestion.id}
                  id={pendingQuestion.id}
                  questions={pendingQuestion.questions}
                  backgroundTask={pendingQuestion.backgroundTask}
                  modes={modes}
                  remoteProgress={
                    remoteQuestionProgress &&
                    remoteQuestionProgress.id === pendingQuestion.id
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
                      id: pendingQuestion.id,
                      step: progress.step,
                      answers: progress.answers,
                      notes: progress.notes,
                      origin: questionProgressOriginRef.current,
                    });
                  }}
                  onSubmit={(id, answers, notes) => {
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
              {streaming ? (
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
              <BackgroundSessionStrip
                sessions={background}
                onStop={handleStopBackground}
                onOpenTranscript={handleOpenBgTranscript}
              />
              <div class="browser-chat-composer">
                <InputArea
                  onSend={handleSend}
                  onStop={handleStop}
                  streaming={Boolean(streaming)}
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
            </div>
          </PaneCard>
        </section>

        <section class="browser-side browser-side-bottom">
          <PaneCard fill>
            <PaneHeader title="Terminal / Activity" />
            <div class="pane-body stacked-list">{terminalPaneContent}</div>
          </PaneCard>
        </section>
      </main>
    </div>
  );
}
