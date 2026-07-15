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
import type { ChatMessage } from "../types";
import type { DetectedQuestion } from "../questionDetection";
import { TranscriptMessageList } from "./TranscriptMessageList";
import { useAutoScroll } from "./useAutoScroll";

interface ChatViewProps {
  messages: ChatMessage[];
  streaming: boolean;
  sessionId: string | null;
  detectedQuestion?: (DetectedQuestion & { messageId: string }) | null;
  onDetectedQuestionAnswer?: (payload: string) => void;
  onDismissDetectedQuestion?: (messageId: string) => void;
  onOpenFile?: (path: string, line?: number) => void;
  onRevealToolCallTerminal?: (id: string) => void;
  onContinueToolCallInBackground?: (id: string) => void;
  onCompleteToolCall?: (id: string) => void;
  onCancelToolCall?: (id: string) => void;
  onPromoteMcpToolApproval?: (promotion: {
    serverName: string;
    bareToolName: string;
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
}

export function ChatView({
  messages,
  streaming,
  sessionId,
  detectedQuestion,
  onDetectedQuestionAnswer,
  onDismissDetectedQuestion,
  onOpenFile,
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
}: ChatViewProps) {
  const hasMessages = messages.length > 0;
  const {
    containerRef,
    contentRef,
    shouldAutoScrollRef,
    markProgrammaticScroll,
    scrollToBottomAfterLayout,
    cancelPendingScrolls,
    handleScroll,
  } = useAutoScroll({ contentPresent: hasMessages });
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
  const firstPromptText = firstUserMsg?.content.trim() ?? "";
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

  if (!hasMessages) {
    return (
      <div class="chat-messages empty">
        <div class="empty-state">
          <i class="codicon codicon-comment-discussion empty-icon" />
          <p>Ask anything to get started</p>
        </div>
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
      <div class="chat-messages" ref={containerRef} onScroll={handleScroll}>
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
      </div>
    </>
  );
}
