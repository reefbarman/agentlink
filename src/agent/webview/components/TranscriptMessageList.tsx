import type { ChatMessage, ContentBlock } from "../types";

import type { BgSessionInfoProps } from "./BackgroundSessionStrip";
import { CheckpointRow } from "./CheckpointRow";
import { CondenseRow } from "./CondenseRow";
import type { DetectedQuestion } from "../questionDetection";
import { Fragment, type ComponentChildren } from "preact";
import { MessageBubble } from "./MessageBubble";
import { WarningRow } from "./WarningRow";
import { useLayoutEffect, useMemo, useRef } from "preact/hooks";
import type {
  StreamingBaselineMetrics,
  StreamingBaselineSurface,
} from "../../../shared/streamingBaselineMetrics";

interface TranscriptMessageListProps {
  messages: ChatMessage[];
  streaming: boolean;
  sessionId?: string | null;
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
  streamingMetrics?: StreamingBaselineMetrics;
  streamingMetricsSurface?: Extract<
    StreamingBaselineSurface,
    "vscode-webview" | "browser-webview"
  >;
  streamingMetricsScope?: string;
}

interface TranscriptRow {
  key: string;
  message: ChatMessage;
  sourceMessage: ChatMessage;
  bgAgentResultOnly: boolean;
  warningMessages?: ChatMessage[];
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

function TranscriptMetricRow({
  active,
  children,
  messageId,
  metrics,
  scope,
  sourceMessage,
  surface,
}: {
  active: boolean;
  children: ComponentChildren;
  messageId: string;
  metrics: StreamingBaselineMetrics | undefined;
  scope: string;
  sourceMessage: ChatMessage;
  surface:
    | Extract<StreamingBaselineSurface, "vscode-webview" | "browser-webview">
    | undefined;
}) {
  const previousSourceMessage = useRef<ChatMessage | undefined>(undefined);
  const previousRevision = useRef<string | undefined>(undefined);
  const revision =
    previousSourceMessage.current === sourceMessage
      ? previousRevision.current
      : JSON.stringify(sourceMessage);
  const unchanged =
    previousRevision.current !== undefined &&
    previousRevision.current === revision;
  if (metrics && surface) {
    metrics.record({
      type: "render",
      surface,
      phase: "render",
      target: active ? "active" : "history",
      messageId,
      scope,
      unchanged,
    });
  }

  useLayoutEffect(() => {
    if (metrics && surface) {
      metrics.record({
        type: "render",
        surface,
        phase: "commit",
        target: active ? "active" : "history",
        messageId,
        scope,
        unchanged,
      });
    }
    previousSourceMessage.current = sourceMessage;
    previousRevision.current = revision;
  });

  return <>{children}</>;
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

function buildTranscriptRows(messages: ChatMessage[]): TranscriptRow[] {
  const rows: TranscriptRow[] = [];

  for (const message of messages) {
    if (message.role === "warning") {
      const previous = rows[rows.length - 1];
      if (previous?.warningMessages) {
        rows[rows.length - 1] = {
          ...previous,
          message,
          sourceMessage: message,
          warningMessages: [...previous.warningMessages, message],
        };
      } else {
        rows.push({
          key: `warning-group:${message.id}`,
          message,
          sourceMessage: message,
          bgAgentResultOnly: false,
          warningMessages: [message],
        });
      }
      continue;
    }

    rows.push(...splitTopLevelChatBlocks(message));
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
  onContinueToolCallInBackground,
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
  streamingMetrics,
  streamingMetricsSurface,
  streamingMetricsScope = sessionId ?? "transcript",
}: TranscriptMessageListProps) {
  const rows = useMemo(() => buildTranscriptRows(messages), [messages]);
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

  const renderRow = (
    key: string,
    msg: ChatMessage,
    sourceMessage: ChatMessage,
    bgAgentResultOnly: boolean,
    warningMessages?: ChatMessage[],
  ) =>
    msg.role === "condense" ? (
      <CondenseRow message={msg} />
    ) : msg.role === "warning" ? (
      <WarningRow
        messages={warningMessages ?? [msg]}
        resolved={sourceMessage !== lastMessage && !lastMessage?.error}
        onRetry={
          sourceMessage === lastMessage && msg.error ? onRetry : undefined
        }
      />
    ) : (
      <Fragment>
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
          onContinueToolCallInBackground={onContinueToolCallInBackground}
          onCompleteToolCall={onCompleteToolCall}
          onCancelToolCall={onCancelToolCall}
          onPromoteMcpToolApproval={onPromoteMcpToolApproval}
          onOpenSpecialBlockPanel={onOpenSpecialBlockPanel}
          onRetry={
            sourceMessage === lastMessage && msg.error ? onRetry : undefined
          }
          onSignIn={
            sourceMessage === lastMessage && msg.error ? onSignIn : undefined
          }
          onSignInAnotherAccount={
            sourceMessage === lastMessage && msg.error
              ? onSignInAnotherAccount
              : undefined
          }
          onCondense={
            sourceMessage === lastMessage && msg.error ? onCondense : undefined
          }
          bgSessions={bgSessions}
          onStopBackground={onStopBackground}
          onOpenTranscript={onOpenTranscript}
          onFinalMarkerContinue={onFinalMarkerContinue}
        />
      </Fragment>
    );

  return (
    <>
      {rows.map(
        ({
          key,
          message: msg,
          sourceMessage,
          bgAgentResultOnly,
          warningMessages,
        }) => {
          const content = renderRow(
            key,
            msg,
            sourceMessage,
            bgAgentResultOnly,
            warningMessages,
          );
          return streamingMetrics && streamingMetricsSurface ? (
            <TranscriptMetricRow
              key={key}
              active={streamingRowKey === key}
              messageId={key}
              metrics={streamingMetrics}
              scope={streamingMetricsScope}
              sourceMessage={sourceMessage}
              surface={streamingMetricsSurface}
            >
              {content}
            </TranscriptMetricRow>
          ) : (
            <Fragment key={key}>{content}</Fragment>
          );
        },
      )}
    </>
  );
}
