import { EmptyState, PaneHeader } from "../../../shared/ui/Panes";

import type { ChatMessage } from "../types";
import { TranscriptMessageList } from "./TranscriptMessageList";
import { useAutoScroll } from "./useAutoScroll";
import { useEffect } from "preact/hooks";

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
  const {
    containerRef,
    contentRef,
    shouldAutoScrollRef,
    scrollToBottomAfterLayout,
    handleScroll,
  } = useAutoScroll({ contentPresent: messages.length > 0 });

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
    shouldAutoScrollRef.current = true;
    return scrollToBottomAfterLayout();
  }, [scrollToBottomAfterLayout, shouldAutoScrollRef]);

  useEffect(() => {
    if (shouldAutoScrollRef.current) {
      return scrollToBottomAfterLayout();
    }
  }, [scrollKey, streaming, scrollToBottomAfterLayout, shouldAutoScrollRef]);

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
          <div class="chat-message-list" ref={contentRef}>
            <TranscriptMessageList messages={messages} streaming={streaming} />
          </div>
        )}
      </div>
    </div>
  );
}
