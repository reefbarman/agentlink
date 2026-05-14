import { useCallback, useEffect, useRef } from "preact/hooks";

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
}

export function ChatView({
  messages,
  streaming,
  sessionId,
  detectedQuestion,
  onDetectedQuestionAnswer,
  onDismissDetectedQuestion,
  onOpenFile,
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
}: ChatViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const shouldAutoScroll = useRef(true);
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
  const lastMsg = messages[messages.length - 1];
  const lastBlock = lastMsg?.blocks[lastMsg.blocks.length - 1];
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

  // Auto-scroll to bottom when content changes
  useEffect(() => {
    if (shouldAutoScroll.current) {
      return scrollToBottomAfterLayout();
    }
  }, [scrollKey, streaming, scrollToBottomAfterLayout]);

  // Track scrollHeight changes (e.g. mermaid diagrams rendering async)
  // and auto-scroll when content grows
  const lastScrollHeight = useRef(0);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let raf: number;
    const check = () => {
      if (el.scrollHeight !== lastScrollHeight.current) {
        lastScrollHeight.current = el.scrollHeight;
        if (shouldAutoScroll.current) {
          scrollToBottom();
        }
      }
      raf = requestAnimationFrame(check);
    };
    raf = requestAnimationFrame(check);
    return () => cancelAnimationFrame(raf);
  }, []);

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

  if (messages.length === 0) {
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
      {previewLabel && (
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
        <TranscriptMessageList
          messages={messages}
          streaming={streaming}
          sessionId={sessionId}
          detectedQuestion={detectedQuestion}
          onDetectedQuestionAnswer={onDetectedQuestionAnswer}
          onDismissDetectedQuestion={onDismissDetectedQuestion}
          onOpenFile={onOpenFile}
          onPromoteMcpToolApproval={onPromoteMcpToolApproval}
          onOpenSpecialBlockPanel={onOpenSpecialBlockPanel}
          onRetry={onRetry}
          onSignIn={onSignIn}
          onSignInAnotherAccount={onSignInAnotherAccount}
          onCondense={onCondense}
          bgSessions={bgSessions}
          onStopBackground={onStopBackground}
          onOpenTranscript={onOpenTranscript}
          onRevertCheckpoint={onRevertCheckpoint}
          onViewCheckpointDiff={onViewCheckpointDiff}
        />
      </div>
    </>
  );
}
