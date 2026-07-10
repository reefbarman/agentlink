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

interface ChatViewProps {
  messages: ChatMessage[];
  streaming: boolean;
  sessionId: string | null;
  detectedQuestion?: (DetectedQuestion & { messageId: string }) | null;
  onDetectedQuestionAnswer?: (payload: string) => void;
  onDismissDetectedQuestion?: (messageId: string) => void;
  onOpenFile?: (path: string, line?: number) => void;
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
}

export function ChatView({
  messages,
  streaming,
  sessionId,
  detectedQuestion,
  onDetectedQuestionAnswer,
  onDismissDetectedQuestion,
  onOpenFile,
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
}: ChatViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
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
  const shouldAutoScroll = useRef(true);

  useEffect(() => {
    setVisibleMessageLimit(
      normalizedInitialMessageLimit ?? Number.POSITIVE_INFINITY,
    );
  }, [normalizedInitialMessageLimit]);
  const programmaticScroll = useRef(false);

  // Helper: scroll to bottom, flagging it as programmatic so handleScroll ignores it
  const scrollToBottom = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    programmaticScroll.current = true;
    el.scrollTop = el.scrollHeight;
  }, []);

  const scrollToBottomAfterLayout = useCallback(() => {
    let frame = 0;
    let raf = 0;
    const tick = () => {
      scrollToBottom();
      frame += 1;
      if (frame < 3) {
        raf = requestAnimationFrame(tick);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [scrollToBottom]);

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
  const hasMessages = messages.length > 0;
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
    shouldAutoScroll.current = true;
    return scrollToBottomAfterLayout();
  }, [sessionId, scrollToBottomAfterLayout]);

  // Always reveal a newly submitted user turn, even if the user had scrolled up
  // while reading previous output. Subsequent assistant streaming still respects
  // the user's scroll position through the guarded auto-scroll effect below.
  useEffect(() => {
    const previous = previousLatestUserMessageId.current;
    previousLatestUserMessageId.current = latestUserMessageId;
    if (!latestUserMessageId || previous === latestUserMessageId) return;
    shouldAutoScroll.current = true;
    return scrollToBottomAfterLayout();
  }, [latestUserMessageId, scrollToBottomAfterLayout]);

  // Auto-scroll to bottom when content changes
  useEffect(() => {
    if (shouldAutoScroll.current) {
      return scrollToBottomAfterLayout();
    }
  }, [scrollKey, streaming, scrollToBottomAfterLayout]);

  // Track content height changes (e.g. async diagrams) without forcing a
  // scrollHeight read on every animation frame.
  useEffect(() => {
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (shouldAutoScroll.current) scrollToBottom();
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [hasMessages, scrollToBottom]);

  useLayoutEffect(() => {
    const anchor = pendingHistoryAnchorRef.current;
    const el = containerRef.current;
    if (!anchor || !el) return;
    pendingHistoryAnchorRef.current = null;
    el.scrollTop = anchor.scrollTop + (el.scrollHeight - anchor.scrollHeight);
  }, [visibleMessageLimit]);

  const handleScroll = useCallback(() => {
    // Skip scroll events caused by our own programmatic scrolling
    if (programmaticScroll.current) {
      programmaticScroll.current = false;
      return;
    }
    const el = containerRef.current;
    if (!el) return;
    // Only disable auto-scroll if user scrolled well away from bottom
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    shouldAutoScroll.current = distFromBottom < 150;
  }, []);

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
    programmaticScroll.current = true;
    el.scrollTop = 0;
  }, []);

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
                shouldAutoScroll.current = false;
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
          <TranscriptMessageList
            messages={visibleMessages}
            streaming={streaming}
            sessionId={sessionId}
            detectedQuestion={detectedQuestion}
            onDetectedQuestionAnswer={onDetectedQuestionAnswer}
            onDismissDetectedQuestion={onDismissDetectedQuestion}
            onOpenFile={onOpenFile}
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
          />
        </div>
      </div>
    </>
  );
}
