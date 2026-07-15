import { EmptyState, PaneHeader } from "../../../shared/ui/Panes";

import type { ChatMessage, TodoItem } from "../types";
import type { BgSessionInfoProps } from "./BackgroundSessionStrip";
import { ChatView } from "./ChatView";
import { StreamingStatusBar } from "./StreamingStatusBar";
import { TodoPanel } from "./TodoPanel";

interface TranscriptViewProps {
  task: string;
  sessionId?: string;
  messages: ChatMessage[];
  streaming?: boolean;
  statusOverride?: string | null;
  todos?: TodoItem[];
  onOpenFile?: (path: string, line?: number) => void;
  onOpenSpecialBlockPanel?: (block: {
    kind: "mermaid" | "vega" | "vega-lite";
    source: string;
  }) => void;
  onRetry?: () => void;
  onSignIn?: () => void;
  onSignInAnotherAccount?: () => void;
  bgSessions?: BgSessionInfoProps[];
  onStopBackground?: (sessionId: string) => void;
  onOpenTranscript?: (sessionId: string) => void;
  onClose: () => void;
}

export function TranscriptView({
  task,
  sessionId,
  messages,
  streaming = false,
  statusOverride,
  todos = [],
  onOpenFile,
  onOpenSpecialBlockPanel,
  onRetry,
  onSignIn,
  onSignInAnotherAccount,
  bgSessions,
  onStopBackground,
  onOpenTranscript,
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
          <ChatView
            messages={messages}
            streaming={streaming}
            sessionId={sessionId ?? null}
            onOpenFile={onOpenFile}
            onOpenSpecialBlockPanel={onOpenSpecialBlockPanel}
            onRetry={onRetry}
            onSignIn={onSignIn}
            onSignInAnotherAccount={onSignInAnotherAccount}
            bgSessions={bgSessions}
            onStopBackground={onStopBackground}
            onOpenTranscript={onOpenTranscript}
            streamingMetricsScope={sessionId ?? "background-transcript"}
          />
        )}
      </div>
      {todos.length > 0 && <TodoPanel todos={todos} />}
      {streaming && (
        <StreamingStatusBar
          messages={messages}
          statusOverride={statusOverride ?? null}
        />
      )}
    </div>
  );
}
