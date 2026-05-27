import { EmptyState, PaneHeader } from "../../../shared/ui/Panes";
import { useCallback, useEffect, useRef } from "preact/hooks";

import type { ChatMessage } from "../types";
import { TranscriptMessageList } from "./TranscriptMessageList";

interface TranscriptViewProps {
  task: string;
  messages: ChatMessage[];
  streaming?: boolean;
  onClose: () => void;
}

export function TranscriptView({
  task,
  messages,
  streaming = false,
  onClose,
}: TranscriptViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const shouldAutoScroll = useRef(true);
  const programmaticScroll = useRef(false);

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

  useEffect(() => {
    shouldAutoScroll.current = true;
    return scrollToBottomAfterLayout();
  }, [scrollToBottomAfterLayout]);

  useEffect(() => {
    if (shouldAutoScroll.current) {
      return scrollToBottomAfterLayout();
    }
  }, [scrollKey, streaming, scrollToBottomAfterLayout]);

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
  }, [scrollToBottom]);

  const handleScroll = useCallback(() => {
    if (programmaticScroll.current) {
      programmaticScroll.current = false;
      return;
    }
    const el = containerRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    shouldAutoScroll.current = distFromBottom < 150;
  }, []);

  return (
    <div class="transcript-overlay">
      <PaneHeader
        className="transcript-header"
        title={task}
        right={
          <button
            class="icon-button transcript-close"
            onClick={onClose}
            title="Close"
          >
            <i class="codicon codicon-close" />
          </button>
        }
      />
      <div
        class="transcript-messages"
        ref={containerRef}
        onScroll={handleScroll}
      >
        {messages.length === 0 ? (
          <EmptyState className="transcript-empty">
            No messages recorded.
          </EmptyState>
        ) : (
          <TranscriptMessageList messages={messages} streaming={streaming} />
        )}
      </div>
    </div>
  );
}
