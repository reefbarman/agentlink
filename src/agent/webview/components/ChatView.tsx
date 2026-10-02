import type {
  StreamingBaselineMetrics,
  StreamingBaselineSurface,
} from "../../../shared/streamingBaselineMetrics";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "preact/hooks";

import type { BgSessionInfoProps } from "./BackgroundSessionStrip";
import type { ChatMessage } from "@agentlink/protocol/chat-transcript";
import type { ComponentChildren } from "preact";
import type { DetectedQuestion } from "../questionDetection";
import type { OpenImageInEditor } from "./ImagePreview";
import { TranscriptMessageList } from "./TranscriptMessageList";
import { useAutoScroll } from "./useAutoScroll";

const JUMP_TO_LATEST_MIN_DISTANCE = 24;
const USER_MESSAGE_ANCHOR_TOLERANCE = 4;
const USER_MESSAGE_JUMP_OFFSET = 8;

function scrollPaddingTop(container: HTMLElement): number {
  const value = Number.parseFloat(getComputedStyle(container).scrollPaddingTop);
  return Number.isFinite(value) ? value : 0;
}

/**
 * Finds the nearest rendered user message whose top sits above the current
 * reading position. User messages are in document order, so a binary search
 * keeps scroll handling cheap for long transcripts.
 */
function findPreviousUserMessage(
  container: HTMLElement,
  content: HTMLElement,
): HTMLElement | null {
  const userMessages = content.querySelectorAll<HTMLElement>(".user-message");
  const readingTop =
    container.getBoundingClientRect().top +
    scrollPaddingTop(container) -
    USER_MESSAGE_ANCHOR_TOLERANCE;
  let low = 0;
  let high = userMessages.length - 1;
  let found: HTMLElement | null = null;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (userMessages[mid].getBoundingClientRect().top < readingTop) {
      found = userMessages[mid];
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

interface ChatViewProps {
  messages: ChatMessage[];
  streaming: boolean;
  sessionId: string | null;
  originalPrompt?: string | null;
  detectedQuestion?: (DetectedQuestion & { messageId: string }) | null;
  onDetectedQuestionAnswer?: (payload: string) => void;
  onDismissDetectedQuestion?: (messageId: string) => void;
  onOpenFile?: (path: string, line?: number) => void;
  onOpenImageInEditor?: OpenImageInEditor;
  onRevealToolCallTerminal?: (id: string) => void;
  onContinueToolCallInBackground?: (id: string) => void;
  onCompleteToolCall?: (id: string) => void;
  onCancelToolCall?: (id: string) => void;
  onPromoteMcpToolApproval?: (promotion: {
    serverName: string;
    bareToolName: string;
    mutationTarget?: import("@agentlink/protocol/tool-result").McpApprovalPromotionMeta["mutationTarget"];
    scope: "session" | "project" | "global";
  }) => void;
  onOpenSpecialBlockPanel?: (block: {
    kind: "mermaid" | "vega" | "vega-lite";
    source: string;
  }) => void;
  onRevertCheckpoint?: (sessionId: string, checkpointId: string) => void;
  onViewCheckpointDiff?: (
    sessionId: string,
    checkpointId: string,
    scope: "turn" | "all",
  ) => void;
  onRetry?: () => void;
  onSignIn?: () => void;
  onSignInAnotherAccount?: () => void;
  onCondense?: () => void;
  bgSessions?: BgSessionInfoProps[];
  onStopBackground?: (sessionId: string) => void;
  onOpenTranscript?: (sessionId: string) => void;
  onFinalMarkerContinue?: (prompt: string) => void;
  initialMessageLimit?: number;
  earlierUserTurnCount?: number;
  onLoadEarlierMessages?: () => void;
  streamingMetrics?: StreamingBaselineMetrics;
  streamingMetricsSurface?: Extract<
    StreamingBaselineSurface,
    "vscode-webview" | "browser-webview"
  >;
  streamingMetricsScope?: string;
  /** Optional product-specific content for an empty foreground chat. */
  emptyState?: ComponentChildren;
}

export function ChatView({
  messages,
  streaming,
  sessionId,
  originalPrompt,
  detectedQuestion,
  onDetectedQuestionAnswer,
  onDismissDetectedQuestion,
  onOpenFile,
  onOpenImageInEditor,
  onRevealToolCallTerminal,
  onContinueToolCallInBackground,
  onCompleteToolCall,
  onCancelToolCall,
  onPromoteMcpToolApproval,
  onOpenSpecialBlockPanel,
  onRevertCheckpoint,
  onViewCheckpointDiff,
  onRetry,
  onSignIn,
  onSignInAnotherAccount,
  onCondense,
  bgSessions,
  onStopBackground,
  onOpenTranscript,
  onFinalMarkerContinue,
  initialMessageLimit,
  earlierUserTurnCount = 0,
  onLoadEarlierMessages,
  streamingMetrics,
  streamingMetricsSurface,
  streamingMetricsScope,
  emptyState,
}: ChatViewProps) {
  const hasMessages = messages.length > 0;
  const {
    containerRef,
    contentRef,
    shouldAutoScrollRef,
    markProgrammaticScroll,
    scrollToBottom,
    scrollToBottomAfterLayout,
    cancelPendingScrolls,
    handleScroll,
  } = useAutoScroll({ contentPresent: hasMessages });
  const [jumpTargets, setJumpTargets] = useState({
    previousUserMessage: false,
    latest: false,
  });
  const normalizedInitialMessageLimit =
    initialMessageLimit !== undefined && initialMessageLimit > 0
      ? initialMessageLimit
      : undefined;
  const [visibleMessageLimit, setVisibleMessageLimit] = useState(
    normalizedInitialMessageLimit ?? Number.POSITIVE_INFINITY,
  );
  const pendingHistoryAnchorRef = useRef<{
    scrollHeight: number;
    scrollTop: number;
  } | null>(null);

  useEffect(() => {
    setVisibleMessageLimit(
      normalizedInitialMessageLimit ?? Number.POSITIVE_INFINITY,
    );
  }, [normalizedInitialMessageLimit]);

  // Derive a scroll key that changes whenever content grows —
  // new messages, new blocks, text/input deltas, tool results
  const visibleMessages = useMemo(
    () =>
      Number.isFinite(visibleMessageLimit) &&
      messages.length > visibleMessageLimit
        ? messages.slice(messages.length - visibleMessageLimit)
        : messages,
    [messages, visibleMessageLimit],
  );
  const hiddenMessageCount = messages.length - visibleMessages.length;
  const lastMsg = visibleMessages[visibleMessages.length - 1];
  const lastBlock = lastMsg?.blocks[lastMsg.blocks.length - 1];
  const latestUserMessageId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].role === "user") return messages[i].id;
    }
    return null;
  }, [messages]);
  const previousLatestUserMessageId = useRef<string | null>(null);
  const scrollKey = lastMsg
    ? `${messages.length}:${lastMsg.blocks.length}:${
        lastBlock?.type === "text"
          ? lastBlock.text.length
          : lastBlock?.type === "tool_call"
            ? `${lastBlock.inputJson.length}:${lastBlock.result.length}`
            : lastBlock?.type === "thinking"
              ? lastBlock.text.length
              : 0
      }`
    : "empty";

  // Treat a loaded/switched session as a fresh transcript and start at the bottom.
  useEffect(() => {
    shouldAutoScrollRef.current = true;
    return scrollToBottomAfterLayout();
  }, [sessionId, scrollToBottomAfterLayout, shouldAutoScrollRef]);

  // Always reveal a newly submitted user turn, even if the user had scrolled up
  // while reading previous output. Subsequent assistant streaming still respects
  // the user's scroll position through the guarded auto-scroll effect below.
  useEffect(() => {
    const previous = previousLatestUserMessageId.current;
    previousLatestUserMessageId.current = latestUserMessageId;
    if (!latestUserMessageId || previous === latestUserMessageId) return;
    shouldAutoScrollRef.current = true;
    return scrollToBottomAfterLayout();
  }, [latestUserMessageId, scrollToBottomAfterLayout, shouldAutoScrollRef]);

  // Auto-scroll to bottom when content changes
  useEffect(() => {
    if (shouldAutoScrollRef.current) {
      return scrollToBottomAfterLayout();
    }
  }, [scrollKey, streaming, scrollToBottomAfterLayout, shouldAutoScrollRef]);

  useLayoutEffect(() => {
    const anchor = pendingHistoryAnchorRef.current;
    const el = containerRef.current;
    if (!anchor || !el) return;
    pendingHistoryAnchorRef.current = null;
    el.scrollTop = anchor.scrollTop + (el.scrollHeight - anchor.scrollHeight);
  }, [visibleMessageLimit]);

  const firstUserMsg = messages.find((m) => m.role === "user");
  const firstPromptText =
    originalPrompt !== undefined && originalPrompt !== null
      ? originalPrompt.trim()
      : (firstUserMsg?.content.trim() ?? "");
  const PREVIEW_MAX = 80;
  const previewLabel =
    firstPromptText.length > PREVIEW_MAX
      ? firstPromptText.slice(0, PREVIEW_MAX) + "…"
      : firstPromptText;

  const scrollToTop = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    markProgrammaticScroll(0);
    el.scrollTop = 0;
  }, [containerRef, markProgrammaticScroll]);

  const updateJumpTargets = useCallback(() => {
    const container = containerRef.current;
    const content = contentRef.current;
    if (!container || !content) return;
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    const latest =
      !shouldAutoScrollRef.current &&
      distanceFromBottom > JUMP_TO_LATEST_MIN_DISTANCE;
    const previousUserMessage =
      findPreviousUserMessage(container, content) !== null;
    setJumpTargets((current) =>
      current.latest === latest &&
      current.previousUserMessage === previousUserMessage
        ? current
        : { latest, previousUserMessage },
    );
  }, [containerRef, contentRef, shouldAutoScrollRef]);

  const handleTranscriptScroll = useCallback(() => {
    handleScroll();
    updateJumpTargets();
  }, [handleScroll, updateJumpTargets]);

  useEffect(() => {
    updateJumpTargets();
  }, [scrollKey, visibleMessages, updateJumpTargets]);

  useEffect(() => {
    const container = containerRef.current;
    const content = contentRef.current;
    if (!container || !content || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(() => updateJumpTargets());
    observer.observe(container);
    observer.observe(content);
    return () => observer.disconnect();
  }, [hasMessages, containerRef, contentRef, updateJumpTargets]);

  const jumpToPreviousUserMessage = useCallback(() => {
    const container = containerRef.current;
    const content = contentRef.current;
    if (!container || !content) return;
    const target = findPreviousUserMessage(container, content);
    if (!target) return;
    shouldAutoScrollRef.current = false;
    cancelPendingScrolls();
    const offset =
      target.getBoundingClientRect().top -
      container.getBoundingClientRect().top -
      Math.max(scrollPaddingTop(container), USER_MESSAGE_JUMP_OFFSET);
    container.scrollTop = Math.max(0, container.scrollTop + offset);
    markProgrammaticScroll(container.scrollTop);
    updateJumpTargets();
  }, [
    containerRef,
    contentRef,
    shouldAutoScrollRef,
    cancelPendingScrolls,
    markProgrammaticScroll,
    updateJumpTargets,
  ]);

  const jumpToLatest = useCallback(() => {
    shouldAutoScrollRef.current = true;
    scrollToBottom();
    scrollToBottomAfterLayout();
    updateJumpTargets();
  }, [
    shouldAutoScrollRef,
    scrollToBottom,
    scrollToBottomAfterLayout,
    updateJumpTargets,
  ]);

  if (!hasMessages) {
    return (
      <div class="chat-messages empty">
        {emptyState ?? (
          <div class="empty-state">
            <i class="codicon codicon-comment-discussion empty-icon" />
            <p>Ask anything to get started</p>
          </div>
        )}
      </div>
    );
  }

  return (
    <>
      {previewLabel && hiddenMessageCount === 0 && (
        <button
          class="prompt-preview"
          onClick={scrollToTop}
          title={firstPromptText}
        >
          <i class="codicon codicon-comment" />
          <span class="prompt-preview-text">{previewLabel}</span>
        </button>
      )}
      <div
        class="chat-messages"
        ref={containerRef}
        onScroll={handleTranscriptScroll}
      >
        {jumpTargets.previousUserMessage && (
          <div class="transcript-jump transcript-jump-top">
            <button
              type="button"
              class="transcript-jump-button"
              onClick={jumpToPreviousUserMessage}
              title="Previous user message"
              aria-label="Jump to previous user message"
            >
              <i class="codicon codicon-arrow-up" />
            </button>
          </div>
        )}
        <div class="chat-message-list" ref={contentRef}>
          {hiddenMessageCount > 0 && normalizedInitialMessageLimit && (
            <button
              type="button"
              class="load-earlier-messages"
              onClick={() => {
                const el = containerRef.current;
                if (el) {
                  pendingHistoryAnchorRef.current = {
                    scrollHeight: el.scrollHeight,
                    scrollTop: el.scrollTop,
                  };
                }
                shouldAutoScrollRef.current = false;
                cancelPendingScrolls();
                setVisibleMessageLimit(
                  (current) => current + normalizedInitialMessageLimit,
                );
              }}
            >
              Show {Math.min(normalizedInitialMessageLimit, hiddenMessageCount)}{" "}
              earlier messages
              <span>{hiddenMessageCount} hidden</span>
            </button>
          )}
          {hiddenMessageCount === 0 &&
            earlierUserTurnCount > 0 &&
            onLoadEarlierMessages && (
              <button
                type="button"
                class="load-earlier-messages"
                onClick={() => {
                  const el = containerRef.current;
                  if (el) {
                    pendingHistoryAnchorRef.current = {
                      scrollHeight: el.scrollHeight,
                      scrollTop: el.scrollTop,
                    };
                  }
                  shouldAutoScrollRef.current = false;
                  cancelPendingScrolls();
                  onLoadEarlierMessages();
                }}
              >
                Show earlier messages
                <span>{earlierUserTurnCount} earlier turns</span>
              </button>
            )}
          <TranscriptMessageList
            messages={visibleMessages}
            streaming={streaming}
            sessionId={sessionId}
            detectedQuestion={detectedQuestion}
            onDetectedQuestionAnswer={onDetectedQuestionAnswer}
            onDismissDetectedQuestion={onDismissDetectedQuestion}
            onOpenFile={onOpenFile}
            onOpenImageInEditor={onOpenImageInEditor}
            onRevealToolCallTerminal={onRevealToolCallTerminal}
            onContinueToolCallInBackground={onContinueToolCallInBackground}
            onCompleteToolCall={onCompleteToolCall}
            onCancelToolCall={onCancelToolCall}
            onPromoteMcpToolApproval={onPromoteMcpToolApproval}
            onOpenSpecialBlockPanel={onOpenSpecialBlockPanel}
            onRetry={onRetry}
            onSignIn={onSignIn}
            onSignInAnotherAccount={onSignInAnotherAccount}
            onCondense={onCondense}
            bgSessions={bgSessions}
            onStopBackground={onStopBackground}
            onOpenTranscript={onOpenTranscript}
            onFinalMarkerContinue={onFinalMarkerContinue}
            onRevertCheckpoint={onRevertCheckpoint}
            onViewCheckpointDiff={onViewCheckpointDiff}
            streamingMetrics={streamingMetrics}
            streamingMetricsSurface={streamingMetricsSurface}
            streamingMetricsScope={streamingMetricsScope}
          />
        </div>
        {jumpTargets.latest && (
          <div class="transcript-jump transcript-jump-bottom">
            <button
              type="button"
              class="transcript-jump-button"
              onClick={jumpToLatest}
              title="Jump to latest"
              aria-label="Jump to latest message"
            >
              <i class="codicon codicon-arrow-down" />
            </button>
          </div>
        )}
      </div>
    </>
  );
}
