import type { ChatMessage, ContentBlock } from "../types";

import type { BgSessionInfoProps } from "./BackgroundSessionStrip";
import { CheckpointRow } from "./CheckpointRow";
import { CondenseRow } from "./CondenseRow";
import type { DetectedQuestion } from "../questionDetection";
import { Fragment } from "preact";
import { MessageBubble } from "./MessageBubble";
import { WarningRow } from "./WarningRow";
import { useMemo } from "preact/hooks";

interface TranscriptMessageListProps {
  messages: ChatMessage[];
  streaming: boolean;
  sessionId?: string | null;
  detectedQuestion?: (DetectedQuestion & { messageId: string }) | null;
  onDetectedQuestionAnswer?: (payload: string) => void;
  onDismissDetectedQuestion?: (messageId: string) => void;
  onOpenFile?: (path: string, line?: number) => void;
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
  onRetry?: () => void;
  onSignIn?: () => void;
  onSignInAnotherAccount?: () => void;
  onCondense?: () => void;
  bgSessions?: BgSessionInfoProps[];
  onStopBackground?: (sessionId: string) => void;
  onOpenTranscript?: (sessionId: string) => void;
  onFinalMarkerContinue?: (prompt: string) => void;
  onRevertCheckpoint?: (sessionId: string, checkpointId: string) => void;
  onViewCheckpointDiff?: (
    sessionId: string,
    checkpointId: string,
    scope: "turn" | "all",
  ) => void;
}

interface TranscriptRow {
  key: string;
  message: ChatMessage;
  sourceMessage: ChatMessage;
  bgAgentResultOnly: boolean;
}

type BgAgentResultContentBlock = Extract<
  ContentBlock,
  { type: "bg_agent_result" }
>;

function isTopLevelChatBlock(
  block: ContentBlock,
): block is BgAgentResultContentBlock {
  return block.type === "bg_agent_result";
}

function cloneAssistantSegment(
  source: ChatMessage,
  id: string,
  blocks: ContentBlock[],
): ChatMessage {
  const { apiRequest, error, finalMarker, ...base } = source;
  void apiRequest;
  void error;
  void finalMarker;
  return {
    ...base,
    id,
    blocks,
  };
}

function isBackgroundResultToolCall(
  block: ContentBlock,
  sessionId: string,
): boolean {
  if (block.type !== "tool_call" || block.name !== "get_background_result") {
    return false;
  }
  try {
    const input = JSON.parse(block.inputJson) as { sessionId?: unknown };
    return input.sessionId === sessionId;
  } catch {
    return false;
  }
}

function splitTopLevelChatBlocks(message: ChatMessage): TranscriptRow[] {
  if (
    message.role !== "assistant" ||
    !message.blocks.some(isTopLevelChatBlock)
  ) {
    return [
      {
        key: message.id,
        message,
        sourceMessage: message,
        bgAgentResultOnly: false,
      },
    ];
  }

  const rows: TranscriptRow[] = [];
  let pendingBlocks: ContentBlock[] = [];
  let pendingStart = 0;

  const pushPending = (endIndex: number) => {
    if (pendingBlocks.length === 0) return;
    rows.push({
      key: `${message.id}:segment:${pendingStart}-${endIndex}`,
      message: cloneAssistantSegment(
        message,
        `${message.id}:segment:${pendingStart}-${endIndex}`,
        pendingBlocks,
      ),
      sourceMessage: message,
      bgAgentResultOnly: false,
    });
    pendingBlocks = [];
  };

  message.blocks.forEach((block, index) => {
    if (!isTopLevelChatBlock(block)) {
      if (pendingBlocks.length === 0) pendingStart = index;
      pendingBlocks.push(block);
      return;
    }

    pendingBlocks = pendingBlocks.filter(
      (pendingBlock) =>
        !isBackgroundResultToolCall(pendingBlock, block.sessionId),
    );
    pushPending(index);
    const id = `${message.id}:bg-agent-result:${block.sessionId}:${index}`;
    rows.push({
      key: id,
      message: cloneAssistantSegment(message, id, [block]),
      sourceMessage: message,
      bgAgentResultOnly: true,
    });
    pendingStart = index + 1;
  });

  pushPending(message.blocks.length);

  let metadataTarget = -1;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (!rows[i].bgAgentResultOnly) {
      metadataTarget = i;
      break;
    }
  }
  const targetIndex = metadataTarget >= 0 ? metadataTarget : rows.length - 1;
  if (targetIndex >= 0) {
    rows[targetIndex] = {
      ...rows[targetIndex],
      message: {
        ...rows[targetIndex].message,
        finalMarker: message.finalMarker,
        apiRequest: message.apiRequest,
        error: message.error,
      },
    };
  }

  return rows;
}

export function TranscriptMessageList({
  messages,
  streaming,
  sessionId,
  detectedQuestion,
  onDetectedQuestionAnswer,
  onDismissDetectedQuestion,
  onOpenFile,
  onCompleteToolCall,
  onCancelToolCall,
  onPromoteMcpToolApproval,
  onOpenSpecialBlockPanel,
  onRetry,
  onSignIn,
  onSignInAnotherAccount,
  onCondense,
  bgSessions,
  onStopBackground,
  onOpenTranscript,
  onFinalMarkerContinue,
  onRevertCheckpoint,
  onViewCheckpointDiff,
}: TranscriptMessageListProps) {
  const rows = useMemo(
    () => messages.flatMap(splitTopLevelChatBlocks),
    [messages],
  );
  const lastMessage = messages[messages.length - 1];
  let streamingRowKey: string | null = null;
  if (streaming && lastMessage?.role === "assistant") {
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const row = rows[i];
      if (row.sourceMessage !== lastMessage) continue;
      if (!row.bgAgentResultOnly) {
        streamingRowKey = row.key;
        break;
      }
      if (!streamingRowKey) streamingRowKey = row.key;
    }
  }

  return (
    <>
      {rows.map(({ key, message: msg, sourceMessage, bgAgentResultOnly }) =>
        msg.role === "condense" ? (
          <CondenseRow key={key} message={msg} />
        ) : msg.role === "warning" ? (
          <WarningRow
            key={key}
            message={msg}
            onRetry={
              sourceMessage === lastMessage && msg.error ? onRetry : undefined
            }
          />
        ) : (
          <Fragment key={key}>
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
              streaming={streamingRowKey === key && msg.role === "assistant"}
              detectedQuestion={
                msg.role === "assistant" &&
                !bgAgentResultOnly &&
                detectedQuestion?.messageId === sourceMessage.id
                  ? detectedQuestion
                  : null
              }
              onDetectedQuestionAnswer={onDetectedQuestionAnswer}
              onDismissDetectedQuestion={
                detectedQuestion?.messageId === sourceMessage.id
                  ? () => onDismissDetectedQuestion?.(sourceMessage.id)
                  : onDismissDetectedQuestion
              }
              onOpenFile={onOpenFile}
              onCompleteToolCall={onCompleteToolCall}
              onCancelToolCall={onCancelToolCall}
              onPromoteMcpToolApproval={onPromoteMcpToolApproval}
              onOpenSpecialBlockPanel={onOpenSpecialBlockPanel}
              onRetry={
                sourceMessage === lastMessage && msg.error ? onRetry : undefined
              }
              onSignIn={
                sourceMessage === lastMessage && msg.error
                  ? onSignIn
                  : undefined
              }
              onSignInAnotherAccount={
                sourceMessage === lastMessage && msg.error
                  ? onSignInAnotherAccount
                  : undefined
              }
              onCondense={
                sourceMessage === lastMessage && msg.error
                  ? onCondense
                  : undefined
              }
              bgSessions={bgSessions}
              onStopBackground={onStopBackground}
              onOpenTranscript={onOpenTranscript}
              onFinalMarkerContinue={onFinalMarkerContinue}
            />
          </Fragment>
        ),
      )}
    </>
  );
}
