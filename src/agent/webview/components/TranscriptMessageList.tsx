import type { BgSessionInfoProps } from "./BackgroundSessionStrip";
import type { ChatMessage } from "../types";
import { CheckpointRow } from "./CheckpointRow";
import { CondenseRow } from "./CondenseRow";
import type { DetectedQuestion } from "../questionDetection";
import { Fragment } from "preact";
import { MessageBubble } from "./MessageBubble";
import { WarningRow } from "./WarningRow";

interface TranscriptMessageListProps {
  messages: ChatMessage[];
  streaming: boolean;
  sessionId?: string | null;
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
  onRetry?: () => void;
  onSignIn?: () => void;
  onSignInAnotherAccount?: () => void;
  onCondense?: () => void;
  bgSessions?: BgSessionInfoProps[];
  onStopBackground?: (sessionId: string) => void;
  onOpenTranscript?: (sessionId: string) => void;
  onRevertCheckpoint?: (sessionId: string, checkpointId: string) => void;
  onViewCheckpointDiff?: (
    sessionId: string,
    checkpointId: string,
    scope: "turn" | "all",
  ) => void;
}

export function TranscriptMessageList({
  messages,
  streaming,
  sessionId,
  detectedQuestion,
  onDetectedQuestionAnswer,
  onDismissDetectedQuestion,
  onOpenFile,
  onPromoteMcpToolApproval,
  onOpenSpecialBlockPanel,
  onRetry,
  onSignIn,
  onSignInAnotherAccount,
  onCondense,
  bgSessions,
  onStopBackground,
  onOpenTranscript,
  onRevertCheckpoint,
  onViewCheckpointDiff,
}: TranscriptMessageListProps) {
  return (
    <>
      {messages.map((msg) =>
        msg.role === "condense" ? (
          <CondenseRow key={msg.id} message={msg} />
        ) : msg.role === "warning" ? (
          <WarningRow
            key={msg.id}
            message={msg}
            onRetry={
              msg === messages[messages.length - 1] && msg.error
                ? onRetry
                : undefined
            }
          />
        ) : (
          <Fragment key={msg.id}>
            {msg.role === "user" && msg.checkpointId && onRevertCheckpoint && (
              <CheckpointRow
                checkpointId={msg.checkpointId}
                sessionId={sessionId ?? null}
                onRevert={onRevertCheckpoint}
                onViewDiff={onViewCheckpointDiff}
              />
            )}
            <MessageBubble
              message={msg}
              streaming={
                streaming &&
                msg === messages[messages.length - 1] &&
                msg.role === "assistant"
              }
              detectedQuestion={
                msg.role === "assistant" &&
                detectedQuestion?.messageId === msg.id
                  ? detectedQuestion
                  : null
              }
              onDetectedQuestionAnswer={onDetectedQuestionAnswer}
              onDismissDetectedQuestion={onDismissDetectedQuestion}
              onOpenFile={onOpenFile}
              onPromoteMcpToolApproval={onPromoteMcpToolApproval}
              onOpenSpecialBlockPanel={onOpenSpecialBlockPanel}
              onRetry={
                msg === messages[messages.length - 1] && msg.error
                  ? onRetry
                  : undefined
              }
              onSignIn={
                msg === messages[messages.length - 1] && msg.error
                  ? onSignIn
                  : undefined
              }
              onSignInAnotherAccount={
                msg === messages[messages.length - 1] && msg.error
                  ? onSignInAnotherAccount
                  : undefined
              }
              onCondense={
                msg === messages[messages.length - 1] && msg.error
                  ? onCondense
                  : undefined
              }
              bgSessions={bgSessions}
              onStopBackground={onStopBackground}
              onOpenTranscript={onOpenTranscript}
            />
          </Fragment>
        ),
      )}
    </>
  );
}
