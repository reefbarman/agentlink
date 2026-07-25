import type { ChatMessage, ContentBlock, ReasoningEffort } from "../types";
import type { CommandApprovalPolicy } from "../../../approvals/commandApprovalPolicy";

import type { BgSessionInfoProps } from "./BackgroundSessionStrip";
import { CheckpointRow } from "./CheckpointRow";
import { CondenseRow } from "./CondenseRow";
import type { DetectedQuestion } from "../questionDetection";
import { Fragment, type ComponentChildren } from "preact";
import { memo } from "preact/compat";
import { MessageBubble } from "./MessageBubble";
import { ModelChangeDivider } from "./ModelChangeDivider";
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
  modelChange?: {
    previousModel: string;
    model: string;
  };
  reasoningChange?: {
    previousReasoningEffort: ReasoningEffort;
    reasoningEffort: ReasoningEffort;
  };
  modeChange?: {
    previousMode: string;
    mode: string;
  };
  approvalChange?: {
    previousCommandApprovalPolicy: CommandApprovalPolicy;
    commandApprovalPolicy: CommandApprovalPolicy;
  };
}

type BgAgentResultContentBlock = Extract<
  ContentBlock,
  { type: "bg_agent_result" }
>;

const messageRevisionCache = new WeakMap<ChatMessage, string>();
const assistantSegmentCache = new WeakMap<
  ChatMessage,
  Map<string, ChatMessage>
>();

function messageRevision(message: ChatMessage): string {
  const cached = messageRevisionCache.get(message);
  if (cached !== undefined) return cached;
  const revision = JSON.stringify(message);
  messageRevisionCache.set(message, revision);
  return revision;
}

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
  let segments = assistantSegmentCache.get(source);
  const cached = segments?.get(id);
  if (cached) return cached;

  const { apiRequest, error, finalMarker, ...base } = source;
  void apiRequest;
  void error;
  void finalMarker;
  const segment = {
    ...base,
    id,
    blocks,
  };
  if (!segments) {
    segments = new Map();
    assistantSegmentCache.set(source, segments);
  }
  segments.set(id, segment);
  return segment;
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
  revision,
  scope,
  surface,
}: {
  active: boolean;
  children: ComponentChildren;
  messageId: string;
  metrics: StreamingBaselineMetrics | undefined;
  revision: string;
  scope: string;
  surface:
    | Extract<StreamingBaselineSurface, "vscode-webview" | "browser-webview">
    | undefined;
}) {
  const previousRevision = useRef<string | undefined>(undefined);
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

function buildTranscriptRows(
  messages: ChatMessage[],
  streaming: boolean,
): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  let previousModel: string | undefined;
  let previousReasoningEffort: ReasoningEffort | undefined;
  let previousMode: string | undefined;
  let previousCommandApprovalPolicy: CommandApprovalPolicy | undefined;

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

    const messageRows = splitTopLevelChatBlocks(message);
    const model =
      message.role === "assistant" ? message.apiRequest?.model : null;
    const reasoningEffort =
      message.role === "assistant"
        ? message.apiRequest?.reasoningEffort
        : undefined;
    const mode =
      message.role === "assistant" ? message.apiRequest?.mode : undefined;
    const commandApprovalPolicy =
      message.role === "assistant"
        ? message.apiRequest?.commandApprovalPolicy
        : undefined;
    if (model || reasoningEffort || mode || commandApprovalPolicy) {
      const modelChange =
        model && previousModel && previousModel !== model
          ? { previousModel, model }
          : undefined;
      const reasoningChange =
        reasoningEffort &&
        previousReasoningEffort &&
        previousReasoningEffort !== reasoningEffort
          ? { previousReasoningEffort, reasoningEffort }
          : undefined;
      const modeChange =
        mode && previousMode && previousMode !== mode
          ? { previousMode, mode }
          : undefined;
      const approvalChange =
        commandApprovalPolicy &&
        previousCommandApprovalPolicy &&
        previousCommandApprovalPolicy !== commandApprovalPolicy
          ? {
              previousCommandApprovalPolicy,
              commandApprovalPolicy,
            }
          : undefined;
      if (
        (modelChange || reasoningChange || modeChange || approvalChange) &&
        messageRows.length > 0
      ) {
        messageRows[0] = {
          ...messageRows[0],
          modelChange,
          reasoningChange,
          modeChange,
          approvalChange,
        };
      }
      if (model) previousModel = model;
      if (reasoningEffort) previousReasoningEffort = reasoningEffort;
      if (mode) previousMode = mode;
      if (commandApprovalPolicy)
        previousCommandApprovalPolicy = commandApprovalPolicy;
    }
    rows.push(...messageRows);
  }

  // While streaming, if the newest assistant message currently ends with a
  // background result card, append an empty tail segment to carry the
  // streaming indicator. Without it the indicator renders on the segment
  // above the card and the transcript ends on a static completed card,
  // which reads as the agent having stalled.
  const lastMessage = messages[messages.length - 1];
  const lastRow = rows[rows.length - 1];
  if (
    streaming &&
    lastMessage?.role === "assistant" &&
    lastRow?.sourceMessage === lastMessage &&
    lastRow.bgAgentResultOnly
  ) {
    const id = `${lastMessage.id}:streaming-tail`;
    rows.push({
      key: id,
      message: cloneAssistantSegment(lastMessage, id, []),
      sourceMessage: lastMessage,
      bgAgentResultOnly: false,
    });
  }

  return rows;
}

interface TranscriptRowActions {
  onDetectedQuestionAnswer?: (payload: string) => void;
  onDismissDetectedQuestion?: (messageId: string) => void;
  onOpenFile?: (path: string, line?: number) => void;
  onRevealToolCallTerminal?: (id: string) => void;
  onContinueToolCallInBackground?: (id: string) => void;
  onCompleteToolCall?: (id: string) => void;
  onCancelToolCall?: (id: string) => void;
  onPromoteMcpToolApproval?: TranscriptMessageListProps["onPromoteMcpToolApproval"];
  onOpenSpecialBlockPanel?: TranscriptMessageListProps["onOpenSpecialBlockPanel"];
  onRetry?: () => void;
  onSignIn?: () => void;
  onSignInAnotherAccount?: () => void;
  onCondense?: () => void;
  onStopBackground?: (sessionId: string) => void;
  onOpenTranscript?: (sessionId: string) => void;
  onFinalMarkerContinue?: (prompt: string) => void;
  onRevertCheckpoint?: (sessionId: string, checkpointId: string) => void;
  onViewCheckpointDiff?: TranscriptMessageListProps["onViewCheckpointDiff"];
}

interface MemoizedTranscriptRowProps {
  actions: TranscriptRowActions;
  active: boolean;
  bgSessions?: BgSessionInfoProps[];
  detectedQuestion?: (DetectedQuestion & { messageId: string }) | null;
  isLatest: boolean;
  lastMessageHasError: boolean;
  metrics?: StreamingBaselineMetrics;
  metricsScope: string;
  metricsSurface?: Extract<
    StreamingBaselineSurface,
    "vscode-webview" | "browser-webview"
  >;
  revision: string;
  row: TranscriptRow;
  sessionId?: string | null;
}

function renderTranscriptRow({
  actions,
  active,
  bgSessions,
  detectedQuestion,
  isLatest,
  lastMessageHasError,
  metrics,
  metricsScope,
  metricsSurface,
  revision,
  row,
  sessionId,
}: MemoizedTranscriptRowProps) {
  const { key, message, sourceMessage, bgAgentResultOnly, warningMessages } =
    row;
  const content =
    message.role === "condense" ? (
      <CondenseRow message={message} />
    ) : message.role === "warning" ? (
      <WarningRow
        messages={warningMessages ?? [message]}
        resolved={!isLatest && !lastMessageHasError}
        onRetry={
          isLatest && message.error && actions.onRetry
            ? () => actions.onRetry?.()
            : undefined
        }
      />
    ) : (
      <Fragment>
        {message.role === "user" &&
          message.checkpointId &&
          actions.onRevertCheckpoint && (
            <CheckpointRow
              checkpointId={message.checkpointId}
              sessionId={sessionId ?? null}
              onRevert={(...args) => actions.onRevertCheckpoint?.(...args)}
              onViewDiff={
                actions.onViewCheckpointDiff
                  ? (...args) => actions.onViewCheckpointDiff?.(...args)
                  : undefined
              }
            />
          )}
        <MessageBubble
          message={message}
          streaming={active && message.role === "assistant"}
          detectedQuestion={
            message.role === "assistant" && !bgAgentResultOnly
              ? detectedQuestion
              : null
          }
          onDetectedQuestionAnswer={
            actions.onDetectedQuestionAnswer
              ? (payload) => actions.onDetectedQuestionAnswer?.(payload)
              : undefined
          }
          onDismissDetectedQuestion={
            actions.onDismissDetectedQuestion
              ? detectedQuestion
                ? () => actions.onDismissDetectedQuestion?.(sourceMessage.id)
                : (messageId) => actions.onDismissDetectedQuestion?.(messageId)
              : undefined
          }
          onOpenFile={
            actions.onOpenFile
              ? (...args) => actions.onOpenFile?.(...args)
              : undefined
          }
          onRevealToolCallTerminal={
            actions.onRevealToolCallTerminal
              ? (id) => actions.onRevealToolCallTerminal?.(id)
              : undefined
          }
          onContinueToolCallInBackground={
            actions.onContinueToolCallInBackground
              ? (id) => actions.onContinueToolCallInBackground?.(id)
              : undefined
          }
          onCompleteToolCall={
            actions.onCompleteToolCall
              ? (id) => actions.onCompleteToolCall?.(id)
              : undefined
          }
          onCancelToolCall={
            actions.onCancelToolCall
              ? (id) => actions.onCancelToolCall?.(id)
              : undefined
          }
          onPromoteMcpToolApproval={
            actions.onPromoteMcpToolApproval
              ? (promotion) => actions.onPromoteMcpToolApproval?.(promotion)
              : undefined
          }
          onOpenSpecialBlockPanel={
            canOpenSpecialBlockPanel(message) && actions.onOpenSpecialBlockPanel
              ? (block) => actions.onOpenSpecialBlockPanel?.(block)
              : undefined
          }
          onRetry={
            isLatest && message.error && actions.onRetry
              ? () => actions.onRetry?.()
              : undefined
          }
          onSignIn={
            isLatest && message.error && actions.onSignIn
              ? () => actions.onSignIn?.()
              : undefined
          }
          onSignInAnotherAccount={
            isLatest && message.error && actions.onSignInAnotherAccount
              ? () => actions.onSignInAnotherAccount?.()
              : undefined
          }
          onCondense={
            isLatest && message.error && actions.onCondense
              ? () => actions.onCondense?.()
              : undefined
          }
          bgSessions={bgSessions}
          onStopBackground={
            actions.onStopBackground
              ? (backgroundSessionId) =>
                  actions.onStopBackground?.(backgroundSessionId)
              : undefined
          }
          onOpenTranscript={
            actions.onOpenTranscript
              ? (backgroundSessionId) =>
                  actions.onOpenTranscript?.(backgroundSessionId)
              : undefined
          }
          onFinalMarkerContinue={
            actions.onFinalMarkerContinue
              ? (prompt) => actions.onFinalMarkerContinue?.(prompt)
              : undefined
          }
        />
      </Fragment>
    );

  return (
    <Fragment>
      {(row.modelChange ||
        row.reasoningChange ||
        row.modeChange ||
        row.approvalChange) && (
        <ModelChangeDivider
          modelChange={row.modelChange}
          reasoningChange={row.reasoningChange}
          modeChange={row.modeChange}
          approvalChange={row.approvalChange}
        />
      )}
      {metrics && metricsSurface ? (
        <TranscriptMetricRow
          active={active}
          messageId={key}
          metrics={metrics}
          revision={revision}
          scope={metricsScope}
          surface={metricsSurface}
        >
          {content}
        </TranscriptMetricRow>
      ) : (
        content
      )}
    </Fragment>
  );
}

const MemoizedTranscriptRow = memo(
  renderTranscriptRow,
  (previous, next) =>
    previous.revision === next.revision &&
    previous.metrics === next.metrics &&
    previous.metricsScope === next.metricsScope &&
    previous.metricsSurface === next.metricsSurface,
);

function relevantBackgroundSessions(
  message: ChatMessage,
  bgSessions: BgSessionInfoProps[] | undefined,
): Array<{
  id: string;
  status: BgSessionInfoProps["status"] | null;
  currentTool?: string;
  displayStatus?: string;
}> {
  if (message.role !== "assistant") return [];
  return message.blocks.flatMap((block) => {
    if (block.type !== "bg_agent") return [];
    const session = bgSessions?.find(({ id }) => id === block.sessionId);
    return [
      {
        id: block.sessionId,
        status: session?.status ?? null,
        currentTool: session?.currentTool,
        displayStatus: session?.displayStatus,
      },
    ];
  });
}

function canOpenSpecialBlockPanel(message: ChatMessage): boolean {
  return (
    message.role === "assistant" &&
    (message.blocks.some((block) => block.type === "text") ||
      Boolean(message.finalMarker?.summary))
  );
}

function rowActionAvailability(
  row: TranscriptRow,
  actions: TranscriptRowActions,
  detectedQuestion:
    | (DetectedQuestion & { messageId: string })
    | null
    | undefined,
  isLatest: boolean,
): Record<string, boolean> {
  const { message } = row;
  if (message.role === "condense") return {};
  if (message.role === "warning") {
    return {
      retry: Boolean(isLatest && message.error && actions.onRetry),
    };
  }

  const assistantBlocks = message.role === "assistant" ? message.blocks : [];
  const hasToolCall = assistantBlocks.some(
    (block) => block.type === "tool_call",
  );
  const hasBackgroundAgent = assistantBlocks.some(
    (block) => block.type === "bg_agent",
  );
  const hasBackgroundResult = assistantBlocks.some(
    (block) => block.type === "bg_agent_result",
  );
  const hasError = Boolean(isLatest && message.error);

  return {
    detectedQuestionAnswer: Boolean(
      detectedQuestion && actions.onDetectedQuestionAnswer,
    ),
    dismissDetectedQuestion: Boolean(
      detectedQuestion && actions.onDismissDetectedQuestion,
    ),
    openFile: Boolean(actions.onOpenFile),
    revealToolCallTerminal: Boolean(
      hasToolCall && actions.onRevealToolCallTerminal,
    ),
    continueToolCallInBackground: Boolean(
      hasToolCall && actions.onContinueToolCallInBackground,
    ),
    completeToolCall: Boolean(hasToolCall && actions.onCompleteToolCall),
    cancelToolCall: Boolean(hasToolCall && actions.onCancelToolCall),
    promoteMcpToolApproval: Boolean(
      hasToolCall && actions.onPromoteMcpToolApproval,
    ),
    openSpecialBlockPanel: Boolean(
      canOpenSpecialBlockPanel(message) && actions.onOpenSpecialBlockPanel,
    ),
    retry: Boolean(hasError && actions.onRetry),
    signIn: Boolean(hasError && actions.onSignIn),
    signInAnotherAccount: Boolean(hasError && actions.onSignInAnotherAccount),
    condense: Boolean(hasError && actions.onCondense),
    stopBackground: Boolean(hasBackgroundAgent && actions.onStopBackground),
    openTranscript: Boolean(hasBackgroundResult && actions.onOpenTranscript),
    finalMarkerContinue: Boolean(
      message.finalMarker && actions.onFinalMarkerContinue,
    ),
    revertCheckpoint: Boolean(
      message.role === "user" &&
      message.checkpointId &&
      actions.onRevertCheckpoint,
    ),
    viewCheckpointDiff: Boolean(
      message.role === "user" &&
      message.checkpointId &&
      actions.onViewCheckpointDiff,
    ),
  };
}

function createRowRevision(params: {
  actions: TranscriptRowActions;
  active: boolean;
  bgSessions?: BgSessionInfoProps[];
  detectedQuestion?: (DetectedQuestion & { messageId: string }) | null;
  isLatest: boolean;
  lastMessageHasError: boolean;
  row: TranscriptRow;
  sessionId?: string | null;
}): string {
  const { actions, row } = params;
  // The message revisions are already JSON strings (cached per message object).
  // Concatenate them instead of nesting them in another JSON.stringify, which
  // would re-walk and re-escape every message body on each render.
  const scalars = JSON.stringify({
    modelChange: row.modelChange,
    reasoningChange: row.reasoningChange,
    modeChange: row.modeChange,
    approvalChange: row.approvalChange,
    active: params.active,
    isLatest:
      row.message.role === "warning" || row.message.error
        ? params.isLatest
        : undefined,
    lastMessageHasError:
      row.message.role === "warning" ? params.lastMessageHasError : undefined,
    detectedQuestion: params.detectedQuestion,
    backgroundSessions: relevantBackgroundSessions(
      row.message,
      params.bgSessions,
    ),
    checkpointSessionId:
      row.message.role === "user" && row.message.checkpointId
        ? (params.sessionId ?? null)
        : undefined,
    actions: rowActionAvailability(
      row,
      actions,
      params.detectedQuestion,
      params.isLatest,
    ),
  });
  // JSON.stringify output never contains a raw NUL character (control chars are
  // escaped), so "\u0000" is a collision-safe separator.
  const warnings =
    row.warningMessages?.map(messageRevision).join("\u0000") ?? "";
  return `${scalars}\u0000${warnings}\u0000${messageRevision(row.message)}`;
}

export function TranscriptMessageList({
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
  const rows = useMemo(
    () => buildTranscriptRows(messages, streaming),
    [messages, streaming],
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

  const actionsRef = useRef<TranscriptRowActions>({});
  // Preact renders synchronously, so memoized rows can safely read the latest
  // callbacks from this stable carrier without callback identity waking them.
  Object.assign(actionsRef.current, {
    onDetectedQuestionAnswer,
    onDismissDetectedQuestion,
    onOpenFile,
    onRevealToolCallTerminal,
    onContinueToolCallInBackground,
    onCompleteToolCall,
    onCancelToolCall,
    onPromoteMcpToolApproval,
    onOpenSpecialBlockPanel,
    onRetry,
    onSignIn,
    onSignInAnotherAccount,
    onCondense,
    onStopBackground,
    onOpenTranscript,
    onFinalMarkerContinue,
    onRevertCheckpoint,
    onViewCheckpointDiff,
  });
  const actions = actionsRef.current;
  const lastMessageHasError = Boolean(lastMessage?.error);

  return (
    <>
      {rows.map((row) => {
        const active = streamingRowKey === row.key;
        const isLatest = row.sourceMessage === lastMessage;
        const rowQuestion =
          row.message.role === "assistant" &&
          !row.bgAgentResultOnly &&
          detectedQuestion?.messageId === row.sourceMessage.id
            ? detectedQuestion
            : null;
        const revision = createRowRevision({
          actions,
          active,
          bgSessions,
          detectedQuestion: rowQuestion,
          isLatest,
          lastMessageHasError,
          row,
          sessionId,
        });
        return (
          <MemoizedTranscriptRow
            key={row.key}
            actions={actions}
            active={active}
            bgSessions={bgSessions}
            detectedQuestion={rowQuestion}
            isLatest={isLatest}
            lastMessageHasError={lastMessageHasError}
            metrics={streamingMetrics}
            metricsScope={streamingMetricsScope}
            metricsSurface={streamingMetricsSurface}
            revision={revision}
            row={row}
            sessionId={sessionId}
          />
        );
      })}
    </>
  );
}
