import { EmptyState, PaneHeader } from "../../../shared/ui/Panes";

import type { ChatMessage } from "../types";
import { TranscriptMessageList } from "./TranscriptMessageList";

interface TranscriptViewProps {
  task: string;
  messages: ChatMessage[];
  onClose: () => void;
}

export function TranscriptView({
  task,
  messages,
  onClose,
}: TranscriptViewProps) {
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
      <div class="transcript-messages">
        {messages.length === 0 ? (
          <EmptyState className="transcript-empty">
            No messages recorded.
          </EmptyState>
        ) : (
          <TranscriptMessageList messages={messages} streaming={false} />
        )}
      </div>
    </div>
  );
}
