import { ToolCallGroup, segmentBlocks } from "./ToolCallGroup";
import { Fragment } from "preact";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "preact/hooks";

import { ApiRequestBlock } from "./ApiRequestBlock";
import { BgAgentBlock } from "./BgAgentBlock";
import { BgAgentResultBlock } from "./BgAgentResultBlock";
import type { BgSessionInfoProps } from "./BackgroundSessionStrip";
import type { ChatMessage, ContentBlock } from "../types";
import type { DetectedQuestion } from "../questionDetection";
import { ErrorBlock } from "./ErrorBlock";
import type { FinalMarkerToolCall } from "../../../shared/finalStatus";
import { LiveLinkIndicator } from "./LiveLinkIndicator";
import { PairingCodeBlock } from "./PairingCodeBlock";
import { QuestionAnswerBlock } from "./QuestionAnswerBlock";
import { SkillLoadBlock } from "./SkillLoadBlock";
import { StreamingText } from "./StreamingText";
import { ThinkingBlock } from "./ThinkingBlock";
import { ThinkingContent } from "./ThinkingContent";
import { ToolCallBlock } from "./ToolCallBlock";
import { getStreamingActivity } from "./activityPresentation";
import { getFinalMessageContinueAction } from "../../../shared/finalStatus";
import { normalizeProjectedToolName } from "../../../shared/chatProjection";

const TOOL_GROUP_SETTLE_MS = 350;

function getToolSettleKey(messageId: string, toolCallId: string): string {
  return `${messageId}:${toolCallId}`;
}

type DisplayMedia = NonNullable<ChatMessage["displayMedia"]>;

interface AssistantMediaPlacement {
  promotedByToolCallId: Map<string, DisplayMedia>;
  unplaced?: DisplayMedia;
}

function imageExtensionForMimeType(mimeType: string): string {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  if (mimeType === "image/gif") return "gif";
  return "png";
}

function placeAssistantDisplayMedia(
  displayMedia: ChatMessage["displayMedia"],
  blocks: ContentBlock[],
): AssistantMediaPlacement {
  const availableImages = (displayMedia?.images ?? []).map((image) => ({
    image,
    used: false,
  }));
  const promotedByToolCallId = new Map<string, DisplayMedia>();
  let fallbackImageIndex = 0;

  for (const block of blocks) {
    if (block.type !== "tool_call" || !block.resultImages?.length) continue;
    const toolName = normalizeProjectedToolName(block.name);
    if (toolName !== "generate_image" && toolName !== "present_images") {
      continue;
    }

    const images = block.resultImages.map((image) => {
      const src = `data:${image.mimeType};base64,${image.data}`;
      const matchingImage = availableImages.find(
        (candidate) =>
          !candidate.used &&
          candidate.image.mimeType === image.mimeType &&
          candidate.image.src === src,
      );
      if (matchingImage) {
        matchingImage.used = true;
        return matchingImage.image;
      }

      fallbackImageIndex += 1;
      return {
        name: `${toolName === "present_images" ? "presented-image" : "generated-image"}-${fallbackImageIndex}.${imageExtensionForMimeType(image.mimeType)}`,
        mimeType: image.mimeType,
        src,
      };
    });
    promotedByToolCallId.set(block.id, { images, documents: [] });
  }

  const unplacedImages = availableImages
    .filter((candidate) => !candidate.used)
    .map((candidate) => candidate.image);
  const unplacedDocuments = displayMedia?.documents ?? [];
  const unplaced =
    unplacedImages.length > 0 || unplacedDocuments.length > 0
      ? { images: unplacedImages, documents: unplacedDocuments }
      : undefined;

  return { promotedByToolCallId, unplaced };
}

function combineDisplayMedia(
  media: Array<DisplayMedia | undefined>,
): DisplayMedia | undefined {
  const images = media.flatMap((item) => item?.images ?? []);
  const documents = media.flatMap((item) => item?.documents ?? []);
  return images.length > 0 || documents.length > 0
    ? { images, documents }
    : undefined;
}

interface MessageBubbleProps {
  message: ChatMessage;
  streaming: boolean;
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
}

export function MessageBubble({
  message,
  streaming,
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
}: MessageBubbleProps) {
  const [showAllDetectedOptions, setShowAllDetectedOptions] = useState(false);
  const [settledToolIds, setSettledToolIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [thinkingExpanded, setThinkingExpanded] = useState(false);
  const toolSettleTimers = useRef<Map<string, number>>(new Map());

  // Hide spawn_background_agent tool_call — it's replaced by the bg_agent block.
  // Keep get_background_status/result/kill visible so users can see what the foreground
  // agent is doing (e.g. waiting for bg results vs actually stuck).
  const finalMarkerToolId = message.finalMarker?.toolCall?.id;
  const activityBlocks = useMemo(
    () =>
      message.role === "assistant"
        ? (message.blocks ?? []).filter(
            (b) =>
              !(
                b.type === "tool_call" && b.name === "spawn_background_agent"
              ) && !(b.type === "tool_call" && b.id === finalMarkerToolId),
          )
        : [],
    [message.role, message.blocks, finalMarkerToolId],
  );
  const blocks = useMemo(
    () =>
      activityBlocks.filter(
        (block) => !(block.type === "thinking" && !block.complete),
      ),
    [activityBlocks],
  );
  const streamingActivity = streaming
    ? getStreamingActivity(activityBlocks)
    : undefined;
  const activeThinking =
    streamingActivity?.phase === "reasoning"
      ? [...activityBlocks]
          .reverse()
          .find((block) => block.type === "thinking" && !block.complete)
      : undefined;
  const canExpandThinking =
    activeThinking?.type === "thinking" &&
    activeThinking.text.trim().length > 0;
  const activeThinkingId =
    activeThinking?.type === "thinking" ? activeThinking.id : null;

  useEffect(() => {
    setThinkingExpanded(false);
  }, [activeThinkingId]);

  const blockSegments = useMemo(
    () =>
      segmentBlocks(blocks, {
        shouldGroupToolCall: (block) =>
          !streaming ||
          settledToolIds.has(getToolSettleKey(message.id, block.id)),
      }),
    [blocks, streaming, settledToolIds, message.id],
  );
  const assistantMediaPlacement = useMemo(
    () => placeAssistantDisplayMedia(message.displayMedia, blocks),
    [message.displayMedia, blocks],
  );

  const parsedAttachments = useMemo(
    () =>
      message.role === "user"
        ? parseAttachments(message.content)
        : { files: [], mediaLabel: null, cleanText: message.content },
    [message.content, message.role],
  );

  useEffect(() => {
    return () => {
      for (const timer of toolSettleTimers.current.values()) {
        window.clearTimeout(timer);
      }
      toolSettleTimers.current.clear();
    };
  }, [message.id]);

  useEffect(() => {
    if (!streaming) {
      for (const timer of toolSettleTimers.current.values()) {
        window.clearTimeout(timer);
      }
      toolSettleTimers.current.clear();
      setSettledToolIds((prev) => (prev.size === 0 ? prev : new Set()));
      return;
    }

    const visibleToolIds = new Set(
      blocks
        .filter((block) => block.type === "tool_call")
        .map((block) => getToolSettleKey(message.id, block.id)),
    );

    for (const [id, timer] of toolSettleTimers.current.entries()) {
      if (!visibleToolIds.has(id)) {
        window.clearTimeout(timer);
        toolSettleTimers.current.delete(id);
      }
    }

    setSettledToolIds((prev) => {
      let next: Set<string> | null = null;
      for (const id of prev) {
        if (!visibleToolIds.has(id)) {
          next ??= new Set(prev);
          next.delete(id);
        }
      }
      return next ?? prev;
    });

    for (const block of blocks) {
      if (
        block.type !== "tool_call" ||
        !block.complete ||
        settledToolIds.has(getToolSettleKey(message.id, block.id)) ||
        toolSettleTimers.current.has(getToolSettleKey(message.id, block.id))
      ) {
        continue;
      }

      const settleKey = getToolSettleKey(message.id, block.id);
      const timer = window.setTimeout(() => {
        toolSettleTimers.current.delete(settleKey);
        setSettledToolIds((prev) => {
          if (prev.has(settleKey)) return prev;
          const next = new Set(prev);
          next.add(settleKey);
          return next;
        });
      }, TOOL_GROUP_SETTLE_MS);
      toolSettleTimers.current.set(settleKey, timer);
    }
  }, [blocks, message.id, settledToolIds, streaming]);

  useEffect(() => {
    setShowAllDetectedOptions(false);
  }, [message.id, detectedQuestion?.messageId]);

  if (message.role === "user") {
    // Annotation messages (follow-up / rejection from approval cards)
    if (message.badge) {
      const isReject = message.badge === "rejection";
      return (
        <div class="message user-message">
          <div
            class={`message-content user-content annotation-${message.badge}`}
          >
            <div class="annotation-badge">
              <i
                class={`codicon codicon-${isReject ? "circle-slash" : "comment"}`}
              />
              {isReject ? "Rejected" : "Follow up"}
            </div>
            {message.content}
          </div>
          <CopyButton text={message.content} />
        </div>
      );
    }
    const { files, mediaLabel, cleanText } = parsedAttachments;
    const displayMedia = message.displayMedia;
    const slashLabel = message.slashCommandLabel;
    const hasSlashLabel = Boolean(message.isSlashCommand && slashLabel);
    const isStandaloneSlashCommand =
      hasSlashLabel &&
      cleanText.length > 0 &&
      cleanText === slashLabel &&
      files.length === 0 &&
      mediaLabel === null &&
      !displayMedia;

    if (isStandaloneSlashCommand) {
      return (
        <div class="message user-message">
          <SlashCommandToolCall label={slashLabel!} />
          <CopyButton text={message.content} />
        </div>
      );
    }

    const showAttachmentRow =
      files.length > 0 ||
      mediaLabel !== null ||
      hasSlashLabel ||
      message.origin === "browser" ||
      Boolean(displayMedia);

    return (
      <div class="message user-message">
        <div class="message-content user-content">
          {showAttachmentRow && (
            <UserAttachments
              files={files}
              mediaLabel={mediaLabel}
              displayMedia={displayMedia}
              slashLabel={hasSlashLabel ? slashLabel : undefined}
              remote={message.origin === "browser"}
              onOpenFile={onOpenFile}
            />
          )}
          <UserText text={cleanText} onOpenFile={onOpenFile} />
        </div>
        <CopyButton text={message.content} />
      </div>
    );
  }

  const lastIdx = blocks.length - 1;

  const finalMarker = !streaming ? message.finalMarker : undefined;
  const finalContinueAction = finalMarker
    ? getFinalMessageContinueAction(finalMarker)
    : undefined;
  const hasVisibleFinalContinueAction =
    Boolean(finalContinueAction) && Boolean(onFinalMarkerContinue);
  const finalRegionClass = finalMarker
    ? `assistant-final-region assistant-final-region-${finalMarker.status}`
    : undefined;

  return (
    <div class="message assistant-message">
      <div class="assistant-blocks">
        {assistantMediaPlacement.unplaced && (
          <UserAttachments
            files={[]}
            mediaLabel={null}
            displayMedia={assistantMediaPlacement.unplaced}
            imageLabel="generated image"
            imageAlt="Generated image"
            onOpenFile={onOpenFile}
          />
        )}
        {blockSegments.map((segment) => {
          if (segment.kind === "tool_group") {
            const promotedMedia = combineDisplayMedia(
              segment.blocks.map((block) =>
                assistantMediaPlacement.promotedByToolCallId.get(block.id),
              ),
            );
            return (
              <Fragment key={`group-${segment.blocks[0].id}`}>
                <ToolCallGroup
                  blocks={segment.blocks}
                  onOpenFile={onOpenFile}
                  onRevealToolCallTerminal={onRevealToolCallTerminal}
                  onContinueToolCallInBackground={
                    onContinueToolCallInBackground
                  }
                  onCompleteToolCall={onCompleteToolCall}
                  onCancelToolCall={onCancelToolCall}
                  onPromoteMcpToolApproval={onPromoteMcpToolApproval}
                />
                {promotedMedia && (
                  <UserAttachments
                    files={[]}
                    mediaLabel={null}
                    displayMedia={promotedMedia}
                    imageLabel="generated image"
                    imageAlt="Generated image"
                    onOpenFile={onOpenFile}
                  />
                )}
              </Fragment>
            );
          }

          const block = segment.block;
          const blockIndex = segment.index;
          switch (block.type) {
            case "thinking":
              return <ThinkingBlock key={block.id} block={block} />;
            case "tool_call": {
              const promotedMedia =
                assistantMediaPlacement.promotedByToolCallId.get(block.id);
              return (
                <Fragment key={block.id}>
                  <ToolCallBlock
                    toolCall={block}
                    onOpenFile={onOpenFile}
                    onRevealToolCallTerminal={onRevealToolCallTerminal}
                    onContinueToolCallInBackground={
                      onContinueToolCallInBackground
                    }
                    onCompleteToolCall={onCompleteToolCall}
                    onCancelToolCall={onCancelToolCall}
                    onPromoteMcpToolApproval={onPromoteMcpToolApproval}
                  />
                  {promotedMedia && (
                    <UserAttachments
                      files={[]}
                      mediaLabel={null}
                      displayMedia={promotedMedia}
                      imageLabel="generated image"
                      imageAlt="Generated image"
                      onOpenFile={onOpenFile}
                    />
                  )}
                </Fragment>
              );
            }
            case "skill_load":
              return <SkillLoadBlock key={block.id} block={block} />;
            case "text": {
              const isActiveStream = streaming && blockIndex === lastIdx;
              return (
                <TextBlock
                  key={`text-${blockIndex}`}
                  text={block.text}
                  streaming={isActiveStream}
                  showCopy={!isActiveStream}
                  onOpenFile={onOpenFile}
                  onOpenSpecialBlockPanel={onOpenSpecialBlockPanel}
                />
              );
            }
            case "bg_agent":
              return (
                <BgAgentBlock
                  key={`bg-${block.sessionId}`}
                  sessionId={block.sessionId}
                  task={block.task}
                  message={block.message}
                  resolvedModel={block.resolvedModel}
                  resolvedProvider={block.resolvedProvider}
                  resolvedMode={block.resolvedMode}
                  taskClass={block.taskClass}
                  routingReason={block.routingReason}
                  bgSession={bgSessions?.find((s) => s.id === block.sessionId)}
                  onStop={onStopBackground}
                />
              );
            case "bg_agent_result":
              return (
                <BgAgentResultBlock
                  key={`bgr-${block.sessionId}`}
                  sessionId={block.sessionId}
                  task={block.task}
                  status={block.status}
                  resultText={block.resultText}
                  summary={block.summary}
                  onOpenTranscript={onOpenTranscript}
                />
              );
            case "question_answer":
              return (
                <QuestionAnswerBlock key={`qa-${blockIndex}`} block={block} />
              );
            case "pairing_code":
              return (
                <PairingCodeBlock
                  key={`pair-${block.pairingId}`}
                  block={block}
                />
              );
          }
        })}

        {/* General live activity stays visible through every streaming gap. */}
        {streamingActivity && (
          <div
            class={`streaming-indicator${canExpandThinking ? " streaming-indicator-expandable" : ""}`}
          >
            {canExpandThinking ? (
              <>
                <button
                  class="streaming-indicator-summary"
                  type="button"
                  aria-expanded={thinkingExpanded}
                  onClick={() => setThinkingExpanded((expanded) => !expanded)}
                >
                  <LiveLinkIndicator motion={streamingActivity.motion} />
                  <span class="streaming-activity-label">
                    {streamingActivity.label}
                  </span>
                  <i
                    class={`codicon codicon-chevron-${thinkingExpanded ? "down" : "right"} streaming-indicator-chevron`}
                  />
                </button>
                {thinkingExpanded && (
                  <div class="streaming-indicator-thinking-content">
                    <ThinkingContent text={activeThinking.text} />
                  </div>
                )}
              </>
            ) : (
              <>
                <LiveLinkIndicator motion={streamingActivity.motion} />
                <span class="streaming-activity-label">
                  {streamingActivity.label}
                </span>
              </>
            )}
          </div>
        )}

        {/* Empty response fallback — shown when streaming ended with no visible content */}
        {!streaming &&
          blocks.length === 0 &&
          !message.error &&
          !finalMarker && (
            <div class="message-content assistant-content empty-response">
              (No response)
            </div>
          )}

        {finalMarker && (
          <div class={finalRegionClass}>
            <FinalMarkerHeader marker={finalMarker} />
            {(finalMarker.summary ||
              finalMarker.toolCall ||
              hasVisibleFinalContinueAction) && (
              <FinalMarkerActions
                marker={finalMarker}
                onContinue={onFinalMarkerContinue}
                onOpenFile={onOpenFile}
                onOpenSpecialBlockPanel={onOpenSpecialBlockPanel}
              />
            )}
          </div>
        )}
      </div>

      {!streaming &&
        detectedQuestion &&
        !hasVisibleFinalContinueAction &&
        (() => {
          const visibleOptions = showAllDetectedOptions
            ? detectedQuestion.options
            : detectedQuestion.options.slice(0, 6);
          const hiddenCount = Math.max(0, detectedQuestion.options.length - 6);

          return (
            <div class="detected-question-card">
              <div class="detected-question-header">
                <i class="codicon codicon-lightbulb" />
                <span>Detected choice prompt</span>
                {onDismissDetectedQuestion && (
                  <button
                    class="icon-button detected-question-dismiss"
                    title="Dismiss"
                    onClick={() => onDismissDetectedQuestion(message.id)}
                  >
                    <i class="codicon codicon-close" />
                  </button>
                )}
              </div>
              <div class="detected-question-text">
                {detectedQuestion.prompt}
              </div>
              <div class="detected-question-options">
                {visibleOptions.map((opt) => (
                  <button
                    key={`${opt.label}-${opt.payload}`}
                    class="question-option detected-question-option"
                    onClick={() => {
                      onDismissDetectedQuestion?.(message.id);
                      onDetectedQuestionAnswer?.(opt.payload);
                    }}
                  >
                    {opt.label}
                  </button>
                ))}
                {hiddenCount > 0 && !showAllDetectedOptions && (
                  <button
                    class="question-option detected-question-option detected-question-more"
                    onClick={() => setShowAllDetectedOptions(true)}
                    type="button"
                  >
                    Show {hiddenCount} more
                  </button>
                )}
              </div>
            </div>
          );
        })()}

      {message.memoryDisclosure && (
        <MemoryDisclosure disclosure={message.memoryDisclosure} />
      )}

      {/* API request inspector */}
      {message.apiRequest && (
        <ApiRequestBlock
          requestId={message.apiRequest.requestId}
          model={message.apiRequest.model}
          reasoningEffort={message.apiRequest.reasoningEffort}
          inputTokens={message.apiRequest.inputTokens}
          uncachedInputTokens={message.apiRequest.uncachedInputTokens}
          cacheReadTokens={message.apiRequest.cacheReadTokens}
          cacheCreationTokens={message.apiRequest.cacheCreationTokens}
          outputTokens={message.apiRequest.outputTokens}
          usageEstimated={message.apiRequest.usageEstimated}
          durationMs={message.apiRequest.durationMs}
          timeToFirstToken={message.apiRequest.timeToFirstToken}
          contextBreakdown={message.apiRequest.contextBreakdown}
        />
      )}

      {/* Error block */}
      {message.error && (
        <ErrorBlock
          error={message.error.message}
          retryable={message.error.retryable}
          code={message.error.code}
          actions={message.error.actions}
          onRetry={onRetry}
          onSignIn={onSignIn}
          onSignInAnotherAccount={onSignInAnotherAccount}
          onCondense={onCondense}
        />
      )}
    </div>
  );
}

function MemoryDisclosure({
  disclosure,
}: {
  disclosure: NonNullable<ChatMessage["memoryDisclosure"]>;
}) {
  const summaryLabel =
    disclosure.summaryCount === 1
      ? "1 memory summary"
      : `${disclosure.summaryCount} memory summaries`;
  const excerptLabel =
    disclosure.transcriptExcerptCount === 0
      ? null
      : disclosure.transcriptExcerptCount === 1
        ? "1 transcript excerpt"
        : `${disclosure.transcriptExcerptCount} transcript excerpts`;
  const label = excerptLabel
    ? `Memory used · ${summaryLabel}, ${excerptLabel}`
    : `Memory used · ${summaryLabel}`;

  return (
    <details class="memory-disclosure-block">
      <summary class="memory-disclosure-header">
        <i class="codicon codicon-history" />
        <span>{label}</span>
      </summary>
      <div class="memory-disclosure-content">
        <div class="memory-disclosure-note">
          Local conversation memory was injected as background recall, not as
          durable instructions.
        </div>
        {disclosure.sources.length > 0 && (
          <ul class="memory-disclosure-sources">
            {disclosure.sources.map((source) => (
              <li key={`${source.kind}:${source.label}`}>
                <span class="memory-disclosure-source-kind">
                  {source.kind === "transcript" ? "Transcript" : "Summary"}
                </span>
                <span class="memory-disclosure-source-title">
                  {source.title || source.label}
                </span>
                {typeof source.score === "number" && (
                  <span class="memory-disclosure-source-score">
                    {Math.round(source.score * 100)}%
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}

// Regex to extract [Attached: path] markers from user message content
function getFinalMarkerMeta(marker: NonNullable<ChatMessage["finalMarker"]>) {
  switch (marker.status) {
    case "completed":
      return { icon: "check", label: "Task complete" };
    case "waiting_for_user":
      return { icon: "comment-discussion", label: "Waiting for input" };
    case "blocked":
      return { icon: "warning", label: "Blocked" };
    case "cancelled":
      return { icon: "debug-stop", label: "Stopped" };
  }
}

function FinalMarkerHeader({
  marker,
}: {
  marker: NonNullable<ChatMessage["finalMarker"]>;
}) {
  const meta = getFinalMarkerMeta(marker);
  return (
    <div class={`final-marker-header final-marker-header-${marker.status}`}>
      <i class={`codicon codicon-${meta.icon}`} />
      <span>{meta.label}</span>
    </div>
  );
}

function FinalMarkerActions({
  marker,
  onContinue,
  onOpenFile,
  onOpenSpecialBlockPanel,
}: {
  marker: NonNullable<ChatMessage["finalMarker"]>;
  onContinue?: (prompt: string) => void;
  onOpenFile?: (path: string, line?: number) => void;
  onOpenSpecialBlockPanel?: (block: {
    kind: "mermaid" | "vega" | "vega-lite";
    source: string;
  }) => void;
}) {
  const action = getFinalMessageContinueAction(marker);
  return (
    <div class={`final-marker-actions final-marker-actions-${marker.status}`}>
      {marker.summary && (
        <div class="final-marker-summary">
          <StreamingText
            text={marker.summary}
            streaming={false}
            onOpenFile={onOpenFile}
            onOpenSpecialBlockPanel={onOpenSpecialBlockPanel}
          />
          <CopyButton text={marker.summary} />
        </div>
      )}
      {marker.autoContinueStopReason && (
        <div class="final-marker-auto-continue-stopped">
          <i class="codicon codicon-debug-pause" />
          <span>{marker.autoContinueStopReason}</span>
        </div>
      )}
      {marker.toolCall && (
        <FinalMarkerToolCallBlock toolCall={marker.toolCall} />
      )}
      {action && onContinue && (
        <button
          class="final-marker-continue"
          type="button"
          title={action.prompt}
          onClick={() => onContinue(action.prompt)}
        >
          {action.label}
        </button>
      )}
    </div>
  );
}

function FinalMarkerToolCallBlock({
  toolCall,
}: {
  toolCall: FinalMarkerToolCall;
}) {
  return (
    <div class="final-marker-tool-call">
      <ToolCallBlock
        toolCall={{
          type: "tool_call",
          id: toolCall.id,
          name: toolCall.name,
          inputJson: toolCall.inputJson,
          result: toolCall.result ?? "",
          complete: true,
          durationMs: toolCall.durationMs,
        }}
      />
    </div>
  );
}

const ATTACHED_FILE_RE = /\[Attached: ([^\]]+)\]\n*/g;
// Regex to extract [N image(s), N file(s) attached] media indicator
const MEDIA_INDICATOR_RE = /\[([^\]]*attached)\]\n*/;

/** Parse attachment markers out of user message text, returning chips + clean text */
function parseAttachments(content: string): {
  files: string[];
  mediaLabel: string | null;
  cleanText: string;
} {
  const files: string[] = [];
  let text = content;

  // Extract file attachments
  let match: RegExpExecArray | null;
  ATTACHED_FILE_RE.lastIndex = 0;
  while ((match = ATTACHED_FILE_RE.exec(content)) !== null) {
    files.push(match[1]);
  }
  text = text.replace(ATTACHED_FILE_RE, "");

  // Extract media indicator (images/files)
  let mediaLabel: string | null = null;
  const mediaMatch = MEDIA_INDICATOR_RE.exec(text);
  if (mediaMatch) {
    mediaLabel = mediaMatch[1];
    text = text.replace(MEDIA_INDICATOR_RE, "");
  }

  return { files, mediaLabel, cleanText: text.trim() };
}

/** Renders attachment chips above user message text */
function imageDownloadName(image: { name?: string; mimeType: string }): string {
  if (image.name?.trim()) return image.name.trim();
  const extension = image.mimeType === "image/jpeg" ? "jpg" : "png";
  return `agentlink-image.${extension}`;
}

function UserAttachments({
  files,
  mediaLabel,
  displayMedia,
  slashLabel,
  remote,
  imageLabel = "attached image",
  imageAlt = "Attached image",
  onOpenFile,
}: {
  files: string[];
  mediaLabel: string | null;
  displayMedia?: ChatMessage["displayMedia"];
  slashLabel?: string;
  remote?: boolean;
  imageLabel?: string;
  imageAlt?: string;
  onOpenFile?: (path: string, line?: number) => void;
}) {
  const [selectedImage, setSelectedImage] = useState<
    NonNullable<ChatMessage["displayMedia"]>["images"][number] | null
  >(null);

  useEffect(() => {
    if (!selectedImage) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelectedImage(null);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedImage]);

  if (
    files.length === 0 &&
    !mediaLabel &&
    !displayMedia &&
    !slashLabel &&
    !remote
  ) {
    return null;
  }
  const showChipRow =
    files.length > 0 ||
    Boolean(mediaLabel) ||
    Boolean(slashLabel) ||
    Boolean(remote);

  return (
    <>
      {displayMedia?.images && displayMedia.images.length > 0 && (
        <div class="user-image-previews">
          {displayMedia.images.map((image, index) => {
            const label = image.name || `${imageLabel} ${index + 1}`;
            const alt = image.name || `${imageAlt} ${index + 1}`;
            const downloadName = imageDownloadName(image);
            return (
              <div
                key={`${image.name}-${index}`}
                class="user-image-preview-card"
              >
                <button
                  class="user-image-preview-button"
                  type="button"
                  title={`Open ${label}`}
                  aria-label={`Open ${label}`}
                  onClick={() => setSelectedImage(image)}
                >
                  <img class="user-image-preview" src={image.src} alt={alt} />
                </button>
                <a
                  class="icon-button user-image-download"
                  href={image.src}
                  download={downloadName}
                  rel="noopener"
                  title={`Download ${label}`}
                  aria-label={`Download ${label}`}
                  onClick={(event) => event.stopPropagation()}
                >
                  <i class="codicon codicon-save" />
                </a>
              </div>
            );
          })}
        </div>
      )}
      {showChipRow && (
        <div class="user-attachments">
          {files.map((filePath) => {
            const name = filePath.split("/").pop() ?? filePath;
            return (
              <span
                key={filePath}
                class="user-attachment-chip"
                title={filePath}
                onClick={
                  onOpenFile
                    ? (e: MouseEvent) => {
                        e.preventDefault();
                        onOpenFile(filePath);
                      }
                    : undefined
                }
                style={onOpenFile ? { cursor: "pointer" } : undefined}
              >
                <i class="codicon codicon-file" />
                <span class="user-attachment-chip-name">{name}</span>
              </span>
            );
          })}
          {mediaLabel && (
            <span class="user-attachment-chip user-attachment-media">
              <i class="codicon codicon-file-media" />
              <span class="user-attachment-chip-name">{mediaLabel}</span>
            </span>
          )}
          {slashLabel && (
            <span class="user-attachment-chip user-attachment-slash-command">
              <i class="codicon codicon-terminal" />
              <span class="user-attachment-chip-name">{slashLabel}</span>
            </span>
          )}
          {remote && (
            <span class="user-attachment-chip user-attachment-remote">
              <i class="codicon codicon-device-mobile" />
              <span class="user-attachment-chip-name">Remote</span>
            </span>
          )}
        </div>
      )}
      {selectedImage && (
        <div
          class="user-image-lightbox"
          role="dialog"
          aria-modal="true"
          aria-label={selectedImage.name || "Attached image preview"}
          onClick={() => setSelectedImage(null)}
        >
          <div
            class="user-image-lightbox-content"
            onClick={(event) => event.stopPropagation()}
          >
            <div class="user-image-lightbox-header">
              <span class="user-image-lightbox-title">
                {selectedImage.name || "Attached image"}
              </span>
              <a
                class="icon-button user-image-lightbox-download"
                href={selectedImage.src}
                download={imageDownloadName(selectedImage)}
                rel="noopener"
                title="Download image"
                aria-label="Download image"
              >
                <i class="codicon codicon-save" />
              </a>
              <button
                class="icon-button user-image-lightbox-close"
                type="button"
                title="Close"
                aria-label="Close image preview"
                onClick={() => setSelectedImage(null)}
              >
                <i class="codicon codicon-close" />
              </button>
            </div>
            <img
              class="user-image-lightbox-image"
              src={selectedImage.src}
              alt={selectedImage.name || imageAlt}
              title="Click to close"
              onClick={() => setSelectedImage(null)}
            />
          </div>
        </div>
      )}
    </>
  );
}

function SlashCommandToolCall({ label }: { label: string }) {
  const firstSpace = label.indexOf(" ");
  const command = firstSpace >= 0 ? label.slice(0, firstSpace) : label;
  const args = firstSpace >= 0 ? label.slice(firstSpace + 1).trim() : "";

  return (
    <div class="tool-call-block slash-standalone-command-block">
      <div class="slash-standalone-command-row">
        <i class="codicon codicon-terminal slash-standalone-command-icon" />
        <span class="slash-standalone-command-name">{command}</span>
        {args && <span class="slash-standalone-command-args">{args}</span>}
      </div>
    </div>
  );
}

function UserText({
  text,
  onOpenFile,
}: {
  text: string;
  onOpenFile?: (path: string, line?: number) => void;
}) {
  return (
    <StreamingText text={text} streaming={false} onOpenFile={onOpenFile} />
  );
}

function TextBlock({
  text,
  streaming,
  showCopy,
  onOpenFile,
  onOpenSpecialBlockPanel,
  onRevealStart: onRevealStartProp,
}: {
  text: string;
  streaming: boolean;
  showCopy: boolean;
  onOpenFile?: (path: string, line?: number) => void;
  onOpenSpecialBlockPanel?: (block: {
    kind: "mermaid" | "vega" | "vega-lite";
    source: string;
  }) => void;
  onRevealStart?: () => void;
}) {
  const [revealed, setRevealed] = useState(false);

  const handleRevealStart = useCallback(() => {
    setRevealed(true);
    onRevealStartProp?.();
  }, [onRevealStartProp]);

  return (
    <div
      class="message-content assistant-content"
      style={streaming && !revealed ? { display: "none" } : undefined}
    >
      <StreamingText
        text={text}
        streaming={streaming}
        onRevealStart={handleRevealStart}
        onOpenFile={onOpenFile}
        onOpenSpecialBlockPanel={onOpenSpecialBlockPanel}
      />
      {showCopy && <CopyButton text={text} />}
    </div>
  );
}

function extractStandaloneFencedCode(text: string): string | null {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let openingIndex = 0;
  while (openingIndex < lines.length && lines[openingIndex]?.trim() === "") {
    openingIndex++;
  }

  const opening = lines[openingIndex]?.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
  if (!opening) return null;

  const fence = opening[1]!;
  if (fence[0] === "`" && opening[2]?.includes("`")) return null;

  for (
    let closingIndex = openingIndex + 1;
    closingIndex < lines.length;
    closingIndex++
  ) {
    const closing = lines[closingIndex]?.match(/^ {0,3}(`+|~+)[ \t]*$/)?.[1];
    if (
      closing === undefined ||
      closing[0] !== fence[0] ||
      closing.length < fence.length
    ) {
      continue;
    }

    if (lines.slice(closingIndex + 1).some((line) => line.trim() !== "")) {
      return null;
    }
    return lines.slice(openingIndex + 1, closingIndex).join("\n");
  }

  return null;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const standaloneCode = extractStandaloneFencedCode(text);
  const clipboardText = standaloneCode ?? text;

  const handleCopy = useCallback(() => {
    navigator.clipboard
      ?.writeText(clipboardText)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {
        // Clipboard can be unavailable or reject (e.g. denied permission).
        // Don't surface an unhandled rejection for a copy button.
      });
  }, [clipboardText]);

  return (
    <button
      class={`copy-button ${copied ? "copied" : ""}`}
      onClick={handleCopy}
      title={
        copied
          ? "Copied!"
          : standaloneCode !== null
            ? "Copy code block"
            : "Copy as Markdown"
      }
    >
      <i class={`codicon codicon-${copied ? "check" : "copy"}`} />
    </button>
  );
}
