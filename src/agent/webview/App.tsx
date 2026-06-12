import type {
  ApprovalRequest,
  DecisionMessage,
} from "../../approvals/webview/types";
import type {
  ChatMessage,
  ExtensionMessage,
  ReasoningEffort,
  SessionSummary,
} from "./types";
import {
  agentMessagesToChatMessages,
  initialState,
  reducer,
  shouldAcceptSessionChunk,
  shouldDropSessionScopedEvent,
} from "../../shared/chatProjection.js";
import {
  getFinalMessageContinueAction,
  getLatestAutoContinueAction,
  getLatestFinalMessageMarker,
} from "../../shared/finalStatus.js";
import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
} from "preact/hooks";

import { BackgroundSessionStrip } from "./components/BackgroundSessionStrip";
import type { BgSessionInfoProps } from "./components/BackgroundSessionStrip";
import { BtwPanel } from "./components/BtwPanel";
import type { BtwState } from "./components/BtwPanel";
import { ChatView } from "./components/ChatView";
import { CommandCard } from "../../approvals/webview/components/CommandCard";
import { ContextBar } from "./components/ContextBar";
import { DebugInfo } from "./components/DebugInfo";
import { ElicitationModal } from "./components/ElicitationModal";
import { InputArea } from "./components/InputArea";
import { McpCard } from "../../approvals/webview/components/McpCard";
import { MemoryCard } from "../../approvals/webview/components/MemoryCard";
import { ModeSwitchCard } from "../../approvals/webview/components/ModeSwitchCard";
import { PathCard } from "../../approvals/webview/components/PathCard";
import { QuestionCard } from "./components/QuestionCard";
import { RenameCard } from "../../approvals/webview/components/RenameCard";
import { SessionHistory } from "./components/SessionHistory";
import { TodoPanel } from "./components/TodoPanel";
import { TranscriptView } from "./components/TranscriptView";
import { WriteCard } from "../../approvals/webview/components/WriteCard";
import { detectQuestionFromAssistantText } from "./questionDetection";
import { getStreamingActivity } from "./components/MessageBubble";

const DEFAULT_MAX_TOKENS = 200_000;
const AUTO_CONTINUE_MAX_TURNS = 10;

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
};

export interface Injection {
  type: "prompt" | "attachment" | "context";
  prompt?: string;
  attachments?: string[];
  autoSubmit?: boolean;
  path?: string;
  context?: string;
}

export function App({ vscodeApi }: { vscodeApi: VsCodeApi }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const stateRef = useRef(state.chatState);
  stateRef.current = state.chatState;
  const fullStateRef = useRef(state);
  fullStateRef.current = state;
  const previousStreamingRef = useRef(state.streaming);
  const activeDetectRequestRef = useRef<{
    requestId: string;
    messageId: string;
    assistantText: string;
  } | null>(null);
  const startupRestorePendingRef = useRef(true);
  const loadingSessionIdRef = useRef<string | null>(null);
  const messageQueueRef = useRef(state.messageQueue);
  messageQueueRef.current = state.messageQueue;
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
  // Buffers for coalescing streaming deltas — flushed once per animation frame.
  const textDeltaBuf = useRef("");
  const thinkingDeltaBuf = useRef(new Map<string, string>());
  const toolInputDeltaBuf = useRef(new Map<string, string>());
  const deltaRafRef = useRef<number | null>(null);
  const [injection, setInjection] = useState<Injection | null>(null);
  const [autoContinueEnabled, setAutoContinueEnabled] = useState(false);
  const [autoContinueStatus, setAutoContinueStatus] = useState("");
  const autoContinuedMessageIdsRef = useRef<Set<string>>(new Set());
  const autoContinueCountRef = useRef(0);
  const autoContinueSessionIdRef = useRef<string | null>(
    state.chatState.sessionId,
  );
  const [shiftDragOver, setShiftDragOver] = useState(false);
  const dragCounterRef = useRef(0);
  const [mcpStatusInfos, setMcpStatusInfos] = useState<Array<{
    name: string;
    status: string;
    error?: string;
    toolCount: number;
    resourceCount: number;
    promptCount: number;
  }> | null>(null);
  const [elicitation, setElicitation] = useState<{
    id: string;
    serverName: string;
    message: string;
    fields: Record<
      string,
      {
        type: "string" | "number" | "boolean";
        title?: string;
        description?: string;
        enum?: string[];
        default?: unknown;
        minimum?: number;
        maximum?: number;
      }
    >;
    required: string[];
  } | null>(null);
  const [sessionHistory, setSessionHistory] = useState<SessionSummary[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [forwardedApproval, setForwardedApproval] =
    useState<ApprovalRequest | null>(null);
  const forwardedApprovalRef = useRef<ApprovalRequest | null>(null);
  const [approvalPanelHeight, setApprovalPanelHeight] = useState(360);
  const [approvalResizing, setApprovalResizing] = useState(false);
  const approvalResizeCleanupRef = useRef<(() => void) | null>(null);
  const forwardedFollowUpRef = useRef("");
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
  const [editingQueueId, setEditingQueueId] = useState<string | null>(null);
  const [editingQueueText, setEditingQueueText] = useState("");
  const [bgSessions, setBgSessions] = useState<BgSessionInfoProps[]>([]);
  const bgSessionsRef = useRef<BgSessionInfoProps[]>([]);
  bgSessionsRef.current = bgSessions;
  const [expandedQueueIds, setExpandedQueueIds] = useState<Set<string>>(
    new Set(),
  );
  const [transcriptView, setTranscriptView] = useState<{
    sessionId: string;
    task: string;
    messages: ChatMessage[];
    streaming: boolean;
  } | null>(null);
  const [btwState, setBtwState] = useState<BtwState | null>(null);

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

  useEffect(() => {
    // Drain all delta buffers, dispatching one action per buffer.
    // React 18 batches these synchronous dispatches into a single render.
    const drainDeltaBuffers = () => {
      if (textDeltaBuf.current) {
        dispatch({ type: "TEXT_DELTA", text: textDeltaBuf.current });
        textDeltaBuf.current = "";
      }
      for (const [thinkingId, text] of thinkingDeltaBuf.current) {
        dispatch({ type: "THINKING_DELTA", thinkingId, text });
      }
      thinkingDeltaBuf.current.clear();
      for (const [toolCallId, partialJson] of toolInputDeltaBuf.current) {
        dispatch({ type: "TOOL_INPUT_DELTA", toolCallId, partialJson });
      }
      toolInputDeltaBuf.current.clear();
    };
    const scheduleDeltaFlush = () => {
      if (deltaRafRef.current !== null) return;
      deltaRafRef.current = requestAnimationFrame(() => {
        deltaRafRef.current = null;
        drainDeltaBuffers();
      });
    };
    const flushDeltasNow = () => {
      if (deltaRafRef.current !== null) {
        cancelAnimationFrame(deltaRafRef.current);
        deltaRafRef.current = null;
      }
      drainDeltaBuffers();
    };

    const handler = (e: MessageEvent) => {
      const msg = e.data as ExtensionMessage;

      const currentSessionId = stateRef.current.sessionId;
      const eventSessionId =
        "sessionId" in msg
          ? (msg as { sessionId: string }).sessionId
          : undefined;
      const isBackgroundEvent =
        msg.type === "agentBgThinkingStart" ||
        msg.type === "agentBgThinkingDelta" ||
        msg.type === "agentBgThinkingEnd" ||
        msg.type === "agentBgTextDelta" ||
        msg.type === "agentBgToolStart" ||
        msg.type === "agentBgToolInputDelta" ||
        msg.type === "agentBgToolComplete" ||
        msg.type === "agentBgApiRequest" ||
        msg.type === "agentBgError" ||
        msg.type === "agentBgDone";

      const reportDrop = (
        reason: "session_mismatch" | "streaming_false",
      ): void => {
        vscodeApi.postMessage({
          command: "agentStreamDrop",
          reason,
          eventType: msg.type,
          eventSessionId: eventSessionId ?? null,
          currentSessionId: stateRef.current.sessionId,
          streaming: streamingRef.current,
        });
      };

      // Filter session-scoped foreground events from non-foreground sessions.
      // agentSessionLoaded is excluded — it intentionally switches the active session.
      // showBgTranscript is excluded — it carries the bg session's ID but is a
      // response to a user-initiated action, not a stream event.
      if (
        shouldDropSessionScopedEvent(
          msg.type,
          eventSessionId,
          currentSessionId,
          isBackgroundEvent,
        )
      ) {
        console.debug(
          `[agentlink-webview] dropping ${msg.type}: session mismatch (event=${eventSessionId}, current=${currentSessionId ?? "null"})`,
        );
        reportDrop("session_mismatch");
        return;
      }

      const dropIfNotStreaming = () => {
        if (streamingRef.current) return false;
        console.debug(
          `[agentlink-webview] dropping ${msg.type}: streamingRef=false (eventSession=${eventSessionId ?? "none"}, current=${stateRef.current.sessionId ?? "null"})`,
        );
        reportDrop("streaming_false");
        return true;
      };

      switch (msg.type) {
        case "stateUpdate":
          streamingRef.current = Boolean(msg.state.streaming);
          dispatch({ type: "SET_STATE", state: msg.state });
          break;
        case "agentRestoreSessionStart":
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
          thinkingDeltaBuf.current.set(
            msg.thinkingId,
            (thinkingDeltaBuf.current.get(msg.thinkingId) ?? "") + msg.text,
          );
          scheduleDeltaFlush();
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
          // Flush any buffered text deltas first so pre-tool text lands in its
          // own block before the tool_call block is inserted.
          flushDeltasNow();
          dispatch({
            type: "TOOL_START",
            toolCallId: msg.toolCallId,
            toolName: msg.toolName,
          });
          break;
        case "agentToolInputDelta":
          if (dropIfNotStreaming()) break;
          toolInputDeltaBuf.current.set(
            msg.toolCallId,
            (toolInputDeltaBuf.current.get(msg.toolCallId) ?? "") +
              msg.partialJson,
          );
          scheduleDeltaFlush();
          break;
        case "agentToolComplete":
          if (dropIfNotStreaming()) break;
          // Flush any buffered input deltas before marking complete,
          // otherwise the input JSON may be empty/partial when the
          // tool block switches to its "complete" state.
          flushDeltasNow();
          dispatch({
            type: "TOOL_COMPLETE",
            toolCallId: msg.toolCallId,
            toolName: msg.toolName,
            result: msg.result,
            durationMs: msg.durationMs,
            input: msg.input,
            mcpApprovalPromotion: msg.mcpApprovalPromotion,
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
        case "agentTextDelta":
          if (dropIfNotStreaming()) break;
          textDeltaBuf.current += msg.text;
          scheduleDeltaFlush();
          break;
        case "agentApiRequest":
          if (dropIfNotStreaming()) break;
          dispatch({
            type: "API_REQUEST",
            requestId: msg.requestId,
            model: msg.model,
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
          });
          break;
        case "agentError":
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
          dispatch({
            type: "SET_FINAL_MARKER",
            marker: msg.marker,
          });
          break;
        case "agentDone": {
          flushDeltasNow();
          streamingRef.current = false;
          dispatch({ type: "DONE" });
          dispatch({ type: "CLEAR_QUESTION" });
          const queue = messageQueueRef.current.filter(
            (q) => q.source !== "browser",
          );
          if (queue.length > 0) {
            // Display text for the chat UI (shows slash command names and media indicators)
            const displayCombined = queue.map((q) => q.text).join("\n\n");
            // Full text for the agent (expanded slash command bodies)
            const sendCombined = queue
              .map((q) => q.fullText ?? q.text)
              .join("\n\n");
            const attachmentsCombined = queue.flatMap(
              (q) => q.attachments ?? [],
            );
            const imagesCombined = queue.flatMap((q) => q.images ?? []);
            const documentsCombined = queue.flatMap((q) => q.documents ?? []);
            const displayMediaCombined = mediaToDisplayMedia(
              imagesCombined,
              documentsCombined,
            );
            messageQueueRef.current = messageQueueRef.current.filter(
              (q) => q.source === "browser",
            );
            for (const item of queue) {
              dispatch({ type: "REMOVE_FROM_QUEUE", id: item.id });
            }
            const isSlashCombined =
              queue.length === 1 ? queue[0]?.isSlashCommand === true : false;
            const slashCommandLabelCombined =
              queue.length === 1 ? queue[0]?.slashCommandLabel : undefined;
            setTimeout(() => {
              streamingRef.current = true;
              dispatch({
                type: "ADD_USER_MESSAGE",
                text: displayCombined,
                isSlashCommand: isSlashCombined,
                slashCommandLabel: slashCommandLabelCombined,
                displayMedia: displayMediaCombined,
              });
              vscodeApi.postMessage({
                command: "agentSend",
                text: sendCombined,
                displayText: displayCombined,
                isSlashCommand: isSlashCombined,
                slashCommandLabel: slashCommandLabelCombined,
                attachments:
                  attachmentsCombined.length > 0
                    ? attachmentsCombined
                    : undefined,
                images: imagesCombined.length > 0 ? imagesCombined : undefined,
                documents:
                  documentsCombined.length > 0 ? documentsCombined : undefined,
                sessionId: stateRef.current.sessionId,
                mode: stateRef.current.mode,
                reasoningEffort: reasoningEffortRef.current,
                thinkingEnabled: reasoningEffortRef.current !== "none",
              });
            }, 0);
          }
          break;
        }
        case "agentDebugInfo":
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
          dispatch({ type: "SET_MODES", modes: msg.modes });
          break;
        case "agentModelsUpdate":
          dispatch({ type: "SET_MODELS", models: msg.models });
          break;
        case "agentSlashCommandsUpdate":
          dispatch({ type: "SET_SLASH_COMMANDS", commands: msg.commands });
          break;
        case "agentModeSwitchRequest":
          // Agent requested a mode switch — create a new session in the new mode
          // but do NOT clear the current chat history (it stays visible while the
          // new session is being created; the next stateUpdate will set the new sessionId)
          vscodeApi.postMessage({ command: "agentNewSession", mode: msg.mode });
          break;
        case "agentElicitationRequest":
          setElicitation({
            id: msg.id,
            serverName: msg.serverName,
            message: msg.message,
            fields: msg.fields,
            required: msg.required,
          });
          break;
        case "agentMcpStatus":
          if (msg.open) {
            // /mcp command — always open the panel
            setMcpStatusInfos(msg.infos);
          } else {
            // live update from onStatusChange — only refresh if already open
            setMcpStatusInfos((prev) => (prev !== null ? msg.infos : prev));
          }
          break;
        case "showApproval":
          forwardedApprovalRef.current = msg.request as ApprovalRequest;
          setForwardedApproval(msg.request as ApprovalRequest);
          break;
        case "idle":
          forwardedApprovalRef.current = null;
          setForwardedApproval(null);
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

        case "agentQuestionRequest":
          dispatch({
            type: "SET_QUESTION",
            id: msg.id,
            context: msg.context,
            questions: msg.questions,
            ...(msg.backgroundTask
              ? { backgroundTask: msg.backgroundTask }
              : {}),
          });
          break;

        case "agentQuestionCleared":
          dispatch({ type: "CLEAR_QUESTION" });
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
          startupRestorePendingRef.current = false;
          loadingSessionIdRef.current = msg.sessionId;
          if (msg.hasMoreBefore !== true) {
            loadingSessionIdRef.current = null;
          }
          dispatch({
            type: "LOAD_SESSION",
            sessionId: msg.sessionId,
            title: msg.title,
            mode: msg.mode,
            model: msg.model,
            messages: agentMessagesToChatMessages(msg.messages as unknown[]),
            lastInputTokens: msg.lastInputTokens,
            lastOutputTokens: msg.lastOutputTokens,
            checkpoints: msg.checkpoints,
            userTurnOffset: (msg.userTurnOffset as number | undefined) ?? 0,
            hasMoreBefore: msg.hasMoreBefore,
          });
          setShowHistory(false);
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
          if (msg.hasMoreBefore !== true) {
            loadingSessionIdRef.current = null;
          }
          dispatch({
            type: "PREPEND_SESSION_CHUNK",
            messages: agentMessagesToChatMessages(msg.messages as unknown[]),
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
            prev?.sessionId === msg.sessionId
              ? {
                  ...prev,
                  messages: reducer(
                    {
                      ...initialState,
                      messages: prev.messages,
                      streaming: true,
                    },
                    { type: "THINKING_START", thinkingId: msg.thinkingId },
                  ).messages,
                  streaming: true,
                }
              : prev,
          );
          break;
        case "agentBgThinkingDelta":
          setTranscriptView((prev) =>
            prev?.sessionId === msg.sessionId
              ? {
                  ...prev,
                  messages: reducer(
                    {
                      ...initialState,
                      messages: prev.messages,
                      streaming: prev.streaming,
                    },
                    {
                      type: "THINKING_DELTA",
                      thinkingId: msg.thinkingId,
                      text: msg.text,
                    },
                  ).messages,
                }
              : prev,
          );
          break;
        case "agentBgThinkingEnd":
          setTranscriptView((prev) =>
            prev?.sessionId === msg.sessionId
              ? {
                  ...prev,
                  messages: reducer(
                    {
                      ...initialState,
                      messages: prev.messages,
                      streaming: prev.streaming,
                    },
                    { type: "THINKING_END", thinkingId: msg.thinkingId },
                  ).messages,
                }
              : prev,
          );
          break;
        case "agentBgTextDelta":
          setTranscriptView((prev) =>
            prev?.sessionId === msg.sessionId
              ? {
                  ...prev,
                  messages: reducer(
                    {
                      ...initialState,
                      messages: prev.messages,
                      streaming: true,
                    },
                    { type: "TEXT_DELTA", text: msg.text },
                  ).messages,
                  streaming: true,
                }
              : prev,
          );
          break;
        case "agentBgToolStart":
          setTranscriptView((prev) =>
            prev?.sessionId === msg.sessionId
              ? {
                  ...prev,
                  messages: reducer(
                    {
                      ...initialState,
                      messages: prev.messages,
                      streaming: true,
                    },
                    {
                      type: "TOOL_START",
                      toolCallId: msg.toolCallId,
                      toolName: msg.toolName,
                    },
                  ).messages,
                  streaming: true,
                }
              : prev,
          );
          break;
        case "agentBgToolInputDelta":
          setTranscriptView((prev) =>
            prev?.sessionId === msg.sessionId
              ? {
                  ...prev,
                  messages: reducer(
                    {
                      ...initialState,
                      messages: prev.messages,
                      streaming: prev.streaming,
                    },
                    {
                      type: "TOOL_INPUT_DELTA",
                      toolCallId: msg.toolCallId,
                      partialJson: msg.partialJson,
                    },
                  ).messages,
                }
              : prev,
          );
          break;
        case "agentBgToolComplete":
          setTranscriptView((prev) =>
            prev?.sessionId === msg.sessionId
              ? {
                  ...prev,
                  messages: reducer(
                    {
                      ...initialState,
                      messages: prev.messages,
                      streaming: prev.streaming,
                    },
                    {
                      type: "TOOL_COMPLETE",
                      toolCallId: msg.toolCallId,
                      toolName: msg.toolName,
                      result: msg.result,
                      durationMs: msg.durationMs,
                      input: msg.input,
                    },
                  ).messages,
                }
              : prev,
          );
          break;
        case "agentBgApiRequest":
          setTranscriptView((prev) =>
            prev?.sessionId === msg.sessionId
              ? {
                  ...prev,
                  messages: reducer(
                    {
                      ...initialState,
                      messages: prev.messages,
                      streaming: prev.streaming,
                    },
                    {
                      type: "API_REQUEST",
                      requestId: msg.requestId,
                      model: msg.model,
                      inputTokens: msg.inputTokens,
                      uncachedInputTokens: msg.uncachedInputTokens,
                      outputTokens: msg.outputTokens,
                      cacheReadTokens: msg.cacheReadTokens,
                      cacheCreationTokens: msg.cacheCreationTokens,
                      durationMs: msg.durationMs,
                      timeToFirstToken: msg.timeToFirstToken,
                      usedPreviousResponseId: msg.usedPreviousResponseId,
                      previousResponseIdFallback:
                        msg.previousResponseIdFallback,
                      promptCacheKey: msg.promptCacheKey,
                      promptCacheRetention: msg.promptCacheRetention,
                      storeResponseState: msg.storeResponseState,
                      providerResponseId: msg.providerResponseId,
                      contextBreakdown: msg.contextBreakdown,
                    },
                  ).messages,
                }
              : prev,
          );
          break;
        case "agentBgError":
          setTranscriptView((prev) =>
            prev?.sessionId === msg.sessionId
              ? {
                  ...prev,
                  messages: reducer(
                    {
                      ...initialState,
                      messages: prev.messages,
                      streaming: prev.streaming,
                    },
                    {
                      type: "ERROR",
                      error: msg.error,
                      retryable: msg.retryable,
                      code: msg.code,
                      actions: msg.actions,
                    },
                  ).messages,
                  streaming: false,
                }
              : prev,
          );
          break;
        case "agentBgDone": {
          // Insert a completion notification at the current chat position
          const bgSessionId = msg.sessionId;
          // Find the task name from existing bg_agent blocks in messages
          let bgTask = "Background Agent";
          for (const m of fullStateRef.current.messages) {
            for (const b of m.blocks) {
              if (b.type === "bg_agent" && b.sessionId === bgSessionId) {
                bgTask = b.task;
                break;
              }
            }
          }
          // Determine status from bgSessions state
          const bgInfo = bgSessionsRef.current.find(
            (s) => s.id === bgSessionId,
          );
          const bgStatus: "completed" | "error" | "cancelled" =
            bgInfo?.status === "error"
              ? "error"
              : bgInfo?.status === "cancelled"
                ? "cancelled"
                : "completed";
          setTranscriptView((prev) => {
            if (prev?.sessionId !== bgSessionId) return prev;
            const next = reducer(
              {
                ...initialState,
                messages: prev.messages,
                streaming: prev.streaming,
              },
              { type: "DONE" },
            );
            return { ...prev, messages: next.messages, streaming: false };
          });
          dispatch({
            type: "BG_AGENT_DONE",
            sessionId: bgSessionId,
            task: bgTask,
            status: bgStatus,
            resultText:
              (msg.resultText as string | undefined) ?? bgInfo?.resultText,
            summary: msg.resultSummary as string | undefined,
          });
          break;
        }

        case "agentBtwLoading":
          setBtwState({
            requestId: msg.requestId,
            question: msg.question,
            answer: "",
          });
          break;

        case "agentBtwResponse":
          setBtwState((prev) => {
            // Discard stale responses
            if (!prev || prev.requestId !== msg.requestId) return prev;
            return {
              ...prev,
              answer: msg.answer,
              error: msg.error,
            };
          });
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
            streaming:
              bgInfo?.status === "streaming" ||
              bgInfo?.status === "tool_executing",
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
    };

    window.addEventListener("message", handler);

    // Tell extension we're ready
    vscodeApi.postMessage({ command: "webviewReady" });

    return () => {
      window.removeEventListener("message", handler);
      if (deltaRafRef.current !== null)
        cancelAnimationFrame(deltaRafRef.current);
    };
  }, [vscodeApi]);

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
    ) => {
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
        const queueId = crypto.randomUUID();
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
        // Notify extension about this queued item so it can inject it ASAP
        // between tool batches. Only the first pending item will be used.
        vscodeApi.postMessage({
          command: "agentQueueMessage",
          text: fullText,
          displayText: displayWithMedia,
          isSlashCommand,
          slashCommandLabel,
          queueId,
          sessionId: stateRef.current.sessionId,
          attachments: attachments.length > 0 ? attachments : undefined,
          images: images.length > 0 ? images : undefined,
          documents: documents.length > 0 ? documents : undefined,
        });
        return;
      }

      // displayText is shown in the chat UI; fullText is sent to the agent
      streamingRef.current = true;
      dispatch({
        type: "ADD_USER_MESSAGE",
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
        mode: stateRef.current.mode,
        reasoningEffort: reasoningEffortRef.current,
        thinkingEnabled: reasoningEffortRef.current !== "none",
      });
    },
    [vscodeApi, state.streaming, state.chatState.reasoningEffort],
  );

  const handleStop = useCallback(() => {
    if (stateRef.current.sessionId) {
      vscodeApi.postMessage({
        command: "agentStop",
        sessionId: stateRef.current.sessionId,
      });
    }
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
    if (autoContinueEnabled) {
      setAutoContinueEnabled(false);
      setAutoContinueStatus("Auto Continue paused after session change.");
    }
  }, [autoContinueEnabled, state.chatState.sessionId]);

  useEffect(() => {
    if (!autoContinueEnabled || state.streaming) return;
    if (!state.chatState.sessionId) return;
    if (state.questionRequest || forwardedApproval) return;

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
    handleSend(action.prompt);
  }, [
    autoContinueEnabled,
    forwardedApproval,
    handleSend,
    state.chatState.sessionId,
    state.messages,
    state.questionRequest,
    state.streaming,
  ]);

  const handleOpenBgTranscript = useCallback(
    (sessionId: string) => {
      vscodeApi.postMessage({ command: "openBgTranscript", sessionId });
    },
    [vscodeApi],
  );

  const handleNewSession = useCallback(() => {
    startupRestorePendingRef.current = false;
    dispatch({ type: "SET_RESTORING_SESSION", restoring: false });
    dispatch({ type: "NEW_SESSION" });
    setBgSessions([]);
    setTranscriptView(null);
    vscodeApi.postMessage({
      command: "agentNewSession",
      mode: stateRef.current.mode,
    });
  }, [vscodeApi]);

  const handleSwitchMode = useCallback(
    (slug: string) => {
      // If there's an active session, switch mode in-place without creating
      // a new session. Otherwise create a fresh session in the target mode.
      if (stateRef.current.sessionId) {
        startupRestorePendingRef.current = false;
        dispatch({ type: "SET_RESTORING_SESSION", restoring: false });
        vscodeApi.postMessage({ command: "agentSwitchMode", mode: slug });
      } else {
        startupRestorePendingRef.current = false;
        dispatch({ type: "SET_RESTORING_SESSION", restoring: false });
        dispatch({ type: "NEW_SESSION" });
        setBgSessions([]);
        setTranscriptView(null);
        vscodeApi.postMessage({ command: "agentNewSession", mode: slug });
      }
    },
    [vscodeApi],
  );

  const handleSelectModel = useCallback(
    (modelId: string) => {
      vscodeApi.postMessage({
        command: "agentSetModel",
        model: modelId,
      });
    },
    [vscodeApi],
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

  const handleSignIn = useCallback(
    (provider: string) => {
      if (
        provider.toLowerCase() === "codex" ||
        provider.toLowerCase() === "openai"
      ) {
        vscodeApi.postMessage({ command: "agentCodexSignIn" });
      } else if (provider.toLowerCase() === "anthropic") {
        vscodeApi.postMessage({ command: "agentAnthropicSignIn" });
      }
    },
    [vscodeApi],
  );

  const handleSetAgentWriteApproval = useCallback(
    (mode: string) => {
      vscodeApi.postMessage({
        command: "agentSetWriteApproval",
        mode,
      });
    },
    [vscodeApi],
  );

  const handleExecuteBuiltinCommand = useCallback(
    (name: string, args: string) => {
      switch (name) {
        case "new":
          startupRestorePendingRef.current = false;
          dispatch({ type: "SET_RESTORING_SESSION", restoring: false });
          dispatch({ type: "NEW_SESSION" });
          setBgSessions([]);
          setTranscriptView(null);
          vscodeApi.postMessage({
            command: "agentNewSession",
            mode: stateRef.current.mode,
          });
          break;

        case "mode": {
          const slug = args.trim();
          if (slug) handleSwitchMode(slug);
          break;
        }
        case "model":
          vscodeApi.postMessage({
            command: "agentSetModel",
            model: args.trim(),
          });
          break;
        case "help":
          // Inject a help message as user text so the agent responds
          vscodeApi.postMessage({
            command: "agentSend",
            text: "List all available slash commands and what they do.",
            attachments: [],
            sessionId: stateRef.current.sessionId,
            mode: stateRef.current.mode,
            reasoningEffort: "none",
            thinkingEnabled: false,
          });
          break;
        case "skills":
          vscodeApi.postMessage({ command: "agentSlashCommand", name, args });
          break;
        case "mcp":
          vscodeApi.postMessage({ command: "agentSlashCommand", name, args });
          break;
        case "mcp-config":
          // args is "project" or "global" (from the webview mcp-config sub-picker)
          vscodeApi.postMessage({ command: "agentSlashCommand", name, args });
          break;
        case "mcp-refresh":
          vscodeApi.postMessage({ command: "agentSlashCommand", name, args });
          break;
        case "btw":
          vscodeApi.postMessage({ command: "agentSlashCommand", name, args });
          break;
        case "pair":
          vscodeApi.postMessage({ command: "agentSlashCommand", name, args });
          break;
        case "condense":
        case "checkpoint":
        case "revert":
          vscodeApi.postMessage({ command: "agentSlashCommand", name, args });
          break;
      }
    },
    [vscodeApi, handleSwitchMode],
  );

  const handleElicitSubmit = useCallback(
    (id: string, values: Record<string, unknown>) => {
      setElicitation(null);
      vscodeApi.postMessage({
        command: "agentElicitationResponse",
        id,
        values,
        cancelled: false,
      });
    },
    [vscodeApi],
  );

  const handleElicitCancel = useCallback(
    (id: string) => {
      setElicitation(null);
      vscodeApi.postMessage({
        command: "agentElicitationResponse",
        id,
        values: {},
        cancelled: true,
      });
    },
    [vscodeApi],
  );

  const handleForwardedApprovalSubmit = useCallback(
    (data: Omit<DecisionMessage, "type">) => {
      const submittedApprovalId = data.id;
      setForwardedApproval((current) => {
        if (!current || current.id === submittedApprovalId) return null;
        return current;
      });
      if (forwardedApprovalRef.current?.id === submittedApprovalId) {
        forwardedApprovalRef.current = null;
      }
      forwardedFollowUpRef.current = "";
      vscodeApi.postMessage({ command: "approvalDecision", ...data });
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

  const clampApprovalPanelHeight = useCallback((height: number) => {
    const min = 220;
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

  const handleSetReasoningEffort = useCallback((effort: ReasoningEffort) => {
    dispatch({ type: "SET_REASONING_EFFORT", effort });
  }, []);

  const handleExportTranscript = useCallback(() => {
    vscodeApi.postMessage({
      command: "agentExportTranscript",
      messages: state.messages,
    });
  }, [vscodeApi, state.messages]);

  const handleOpenFile = useCallback(
    (path: string, line?: number) => {
      vscodeApi.postMessage({ command: "agentOpenFile", path, line });
    },
    [vscodeApi],
  );

  const handlePromoteMcpToolApproval = useCallback(
    (promotion: {
      serverName: string;
      bareToolName: string;
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
      vscodeApi.postMessage({ command: "agentLoadSession", sessionId });
    },
    [vscodeApi],
  );

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

  return (
    <>
      {elicitation && (
        <ElicitationModal
          id={elicitation.id}
          serverName={elicitation.serverName}
          message={elicitation.message}
          fields={elicitation.fields}
          required={elicitation.required}
          onSubmit={handleElicitSubmit}
          onCancel={handleElicitCancel}
        />
      )}
      <div
        class="chat-container"
        onDragEnter={handleContainerDragEnter}
        onDragOver={handleContainerDragOver}
        onDragLeave={handleContainerDragLeave}
        onDrop={handleContainerDrop}
      >
        {transcriptView && (
          <TranscriptView
            task={transcriptView.task}
            messages={transcriptView.messages}
            streaming={transcriptView.streaming}
            onClose={() => setTranscriptView(null)}
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
        <div class="chat-header">
          <button
            class="icon-button"
            onClick={handleNewSession}
            title={
              state.restoringSession
                ? "Start a new session without waiting for restore"
                : "New Session"
            }
          >
            <i class="codicon codicon-add" />
          </button>
          {state.restoringSession && (
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
            currentSessionId={state.chatState.sessionId}
            onLoad={handleLoadSession}
            onDelete={handleDeleteSession}
            onRename={handleRenameSession}
            onCopyFirstPrompt={handleCopyFirstPrompt}
            onClose={() => setShowHistory(false)}
          />
        )}
        {state.debugInfo && (
          <DebugInfo
            info={state.debugInfo}
            systemPrompt={state.systemPrompt}
            loadedInstructions={state.loadedInstructions ?? undefined}
          />
        )}
        <ChatView
          messages={state.messages}
          streaming={state.streaming}
          sessionId={state.chatState.sessionId}
          detectedQuestion={state.detectedQuestion}
          onDetectedQuestionAnswer={handleDetectedQuestionAnswer}
          onDismissDetectedQuestion={handleDismissDetectedQuestion}
          onOpenFile={handleOpenFile}
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
        />
        {state.messageQueue.length > 0 && (
          <div class="queue-panel">
            <div class="queue-header">
              <i class="codicon codicon-list-ordered" />
              <span>Queued ({state.messageQueue.length})</span>
            </div>
            {state.messageQueue.map((item) => (
              <div key={item.id} class="queue-item">
                {editingQueueId === item.id ? (
                  <textarea
                    class="queue-item-textarea"
                    value={editingQueueText}
                    onInput={(e) =>
                      setEditingQueueText(
                        (e.target as HTMLTextAreaElement).value,
                      )
                    }
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        const trimmed = editingQueueText.trim();
                        if (trimmed) {
                          dispatch({
                            type: "EDIT_QUEUE_MESSAGE",
                            id: item.id,
                            text: trimmed,
                          });
                          vscodeApi.postMessage({
                            command: "agentUpdateQueuedMessage",
                            sessionId: stateRef.current.sessionId,
                            queueId: item.id,
                            text: trimmed,
                            displayText: trimmed,
                            isSlashCommand: false,
                            attachments: item.attachments,
                            images: item.images,
                            documents: item.documents,
                          });
                        }
                        setEditingQueueId(null);
                      } else if (e.key === "Escape") {
                        setEditingQueueId(null);
                      }
                    }}
                    autoFocus
                  />
                ) : (
                  <span
                    class={`queue-item-text${expandedQueueIds.has(item.id) ? " expanded" : ""}`}
                    title="Click to expand/collapse"
                    onClick={() =>
                      setExpandedQueueIds((prev) => {
                        const next = new Set(prev);
                        if (next.has(item.id)) next.delete(item.id);
                        else next.add(item.id);
                        return next;
                      })
                    }
                  >
                    {item.text}
                  </span>
                )}
                <div class="queue-item-actions">
                  {editingQueueId !== item.id && (
                    <button
                      class="icon-button queue-item-edit"
                      title="Edit"
                      onClick={() => {
                        setEditingQueueText(item.text);
                        setEditingQueueId(item.id);
                      }}
                    >
                      <i class="codicon codicon-edit" />
                    </button>
                  )}
                  <button
                    class="icon-button queue-item-remove"
                    title="Remove"
                    onClick={() => {
                      dispatch({ type: "REMOVE_FROM_QUEUE", id: item.id });
                      const wasHead =
                        messageQueueRef.current[0]?.id === item.id;
                      const nextQueue = messageQueueRef.current.filter(
                        (q) => q.id !== item.id,
                      );
                      messageQueueRef.current = nextQueue;
                      if (wasHead) {
                        vscodeApi.postMessage({
                          command: "agentRemoveQueuedMessage",
                          sessionId: stateRef.current.sessionId,
                          queueId: item.id,
                        });
                        const nextHead = nextQueue[0];
                        if (nextHead) {
                          vscodeApi.postMessage({
                            command: "agentQueueMessage",
                            text: nextHead.fullText ?? nextHead.text,
                            displayText: nextHead.text,
                            isSlashCommand: nextHead.isSlashCommand === true,
                            queueId: nextHead.id,
                            sessionId: stateRef.current.sessionId,
                            attachments: nextHead.attachments,
                            images: nextHead.images,
                            documents: nextHead.documents,
                          });
                        }
                      }
                    }}
                  >
                    <i class="codicon codicon-close" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
        {(state.lastInputTokens > 0 ||
          state.lastOutputTokens > 0 ||
          state.estimatedTotalUsed > 0) &&
          (() => {
            const currentModel = state.availableModels.find(
              (m) => m.id === state.chatState.model,
            );
            return (
              <ContextBar
                inputTokens={state.lastInputTokens}
                outputTokens={state.lastOutputTokens}
                cacheReadTokens={state.lastCacheReadTokens}
                maxContextWindow={
                  currentModel?.contextWindow ?? DEFAULT_MAX_TOKENS
                }
                maxInputTokens={
                  state.chatState.contextBudget?.maxInputTokens ??
                  currentModel?.maxInputTokens
                }
                usedInputTokens={state.chatState.contextBudget?.usedInputTokens}
                outputReservation={
                  state.chatState.contextBudget?.outputReservation
                }
                safetyBufferTokens={
                  state.chatState.contextBudget?.safetyBufferTokens
                }
                softThresholdBudget={
                  state.chatState.contextBudget?.softThresholdBudget
                }
                hardBudget={state.chatState.contextBudget?.hardBudget}
                condenseThreshold={state.chatState.condenseThreshold}
                estimatedTotalUsed={state.estimatedTotalUsed}
              />
            );
          })()}
        {mcpStatusInfos && (
          <div class="mcp-status-panel">
            <div class="mcp-status-header">
              <i class="codicon codicon-server" />
              <span>MCP Servers</span>
              <button
                class="mcp-status-close icon-button"
                onClick={() => setMcpStatusInfos(null)}
                title="Dismiss"
              >
                <i class="codicon codicon-close" />
              </button>
            </div>
            {mcpStatusInfos.length === 0 ? (
              <p class="mcp-status-empty">No MCP servers configured.</p>
            ) : (
              <ul class="mcp-status-list">
                {mcpStatusInfos.map((info) => (
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
                            vscodeApi.postMessage({
                              command: "agentMcpAction",
                              serverName: info.name,
                              action: "reconnect",
                            })
                          }
                        >
                          <i class="codicon codicon-refresh" />
                        </button>
                      )}
                      <button
                        class="icon-button"
                        title="Reauthenticate"
                        onClick={() =>
                          vscodeApi.postMessage({
                            command: "agentMcpAction",
                            serverName: info.name,
                            action: "reauthenticate",
                          })
                        }
                      >
                        <i class="codicon codicon-key" />
                      </button>
                      <button
                        class="icon-button mcp-action-disable"
                        title="Disable"
                        onClick={() =>
                          vscodeApi.postMessage({
                            command: "agentMcpAction",
                            serverName: info.name,
                            action: "disable",
                          })
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
        {state.todos.length > 0 && <TodoPanel todos={state.todos} />}
        {state.questionRequest && (
          <QuestionCard
            id={state.questionRequest.id}
            context={state.questionRequest.context}
            questions={state.questionRequest.questions}
            backgroundTask={state.questionRequest.backgroundTask}
            modes={state.modes}
            remoteProgress={
              remoteQuestionProgress &&
              remoteQuestionProgress.id === state.questionRequest.id
                ? {
                    step: remoteQuestionProgress.step,
                    answers: remoteQuestionProgress.answers,
                    notes: remoteQuestionProgress.notes,
                  }
                : null
            }
            onProgressChange={(progress) => {
              if (!state.questionRequest) return;
              vscodeApi.postMessage({
                command: "agentQuestionProgress",
                id: state.questionRequest.id,
                step: progress.step,
                answers: progress.answers,
                notes: progress.notes,
                origin: questionProgressOriginRef.current,
              });
            }}
            onSubmit={(
              id: string,
              answers: Record<
                string,
                string | string[] | number | boolean | undefined
              >,
              notes: Record<string, string>,
            ) => {
              dispatch({ type: "CLEAR_QUESTION" });
              setRemoteQuestionProgress(null);
              vscodeApi.postMessage({
                command: "agentQuestionResponse",
                id,
                answers,
                notes,
              });
            }}
          />
        )}
        {forwardedApproval && (
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
            {forwardedApproval.kind === "command" ? (
              <CommandCard
                request={forwardedApproval}
                submit={handleForwardedApprovalSubmit}
                followUpRef={forwardedFollowUpRef}
                onSuggestRegex={handleSuggestRegex}
              />
            ) : forwardedApproval.kind === "write" ? (
              <WriteCard
                request={forwardedApproval}
                submit={handleForwardedApprovalSubmit}
                followUpRef={forwardedFollowUpRef}
              />
            ) : forwardedApproval.kind === "rename" ? (
              <RenameCard
                request={forwardedApproval}
                submit={handleForwardedApprovalSubmit}
                followUpRef={forwardedFollowUpRef}
              />
            ) : forwardedApproval.kind === "mcp" ? (
              <McpCard
                request={forwardedApproval}
                submit={handleForwardedApprovalSubmit}
                followUpRef={forwardedFollowUpRef}
              />
            ) : forwardedApproval.kind === "memory" ? (
              <MemoryCard
                request={forwardedApproval}
                submit={handleForwardedApprovalSubmit}
                followUpRef={forwardedFollowUpRef}
              />
            ) : forwardedApproval.kind === "mode-switch" ? (
              <ModeSwitchCard
                request={forwardedApproval}
                submit={handleForwardedApprovalSubmit}
                followUpRef={forwardedFollowUpRef}
              />
            ) : (
              <PathCard
                request={forwardedApproval}
                submit={handleForwardedApprovalSubmit}
                followUpRef={forwardedFollowUpRef}
              />
            )}
          </div>
        )}
        {btwState && (
          <BtwPanel state={btwState} onDismiss={() => setBtwState(null)} />
        )}
        {state.streaming && (
          <div class="streaming-status-bar">
            <i class="codicon codicon-loading codicon-modifier-spin" />
            <span>
              {state.statusOverride ??
                (() => {
                  const lastMsg = state.messages[state.messages.length - 1];
                  if (lastMsg?.role === "assistant") {
                    return getStreamingActivity(lastMsg.blocks);
                  }
                  return "Waiting for response…";
                })()}
            </span>
          </div>
        )}
        <BackgroundSessionStrip
          sessions={bgSessions}
          onStop={handleStopBackground}
          onOpenTranscript={handleOpenBgTranscript}
        />
        <InputArea
          onSend={handleSend}
          onStop={handleStop}
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
          onSwitchMode={handleSwitchMode}
          agentWriteApproval={state.chatState.agentWriteApproval ?? "prompt"}
          onSetAgentWriteApproval={handleSetAgentWriteApproval}
          autoContinueEnabled={autoContinueEnabled}
          onToggleAutoContinue={handleToggleAutoContinue}
          autoContinueStatus={autoContinueStatus}
        />
      </div>
    </>
  );
}
