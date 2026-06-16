import type { ChatMessage, ContentBlock } from "../types";
import { ToolCallGroup, segmentBlocks } from "./ToolCallGroup";
import { useCallback, useEffect, useState } from "preact/hooks";

import { ApiRequestBlock } from "./ApiRequestBlock";
import { BgAgentBlock } from "./BgAgentBlock";
import { BgAgentResultBlock } from "./BgAgentResultBlock";
import type { BgSessionInfoProps } from "./BackgroundSessionStrip";
import type { ComponentChild } from "preact";
import type { DetectedQuestion } from "../questionDetection";
import { ErrorBlock } from "./ErrorBlock";
import type { FinalMarkerToolCall } from "../../../shared/finalStatus";
import { PairingCodeBlock } from "./PairingCodeBlock";
import { QuestionAnswerBlock } from "./QuestionAnswerBlock";
import { SkillLoadBlock } from "./SkillLoadBlock";
import { StreamingText } from "./StreamingText";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolCallBlock } from "./ToolCallBlock";
import { getFinalMessageContinueAction } from "../../../shared/finalStatus";
import { matchFilePaths } from "./filePathLinks";

/**
 * Derive a short activity label from the current message blocks.
 * Covers: thinking, writing, running tools, and the gaps between
 * (waiting for API, processing tool results, etc.)
 */
export function getStreamingActivity(blocks: ContentBlock[]): string {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b.type === "text") return "Writing…";
    if (b.type === "tool_call" || b.type === "skill_load") {
      if (!b.complete) return "Running tool…";
      // Last block is a completed tool → agent is sending results back to the API
      return "Waiting for response…";
    }
    if (b.type === "thinking") {
      if (!b.complete) return "Thinking…";
      // Finished thinking, waiting for the model to start responding
      return "Waiting for response…";
    }
  }
  // No blocks yet → initial API call in flight
  return "Waiting for response…";
}

interface MessageBubbleProps {
  message: ChatMessage;
  streaming: boolean;
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
  onFinalMarkerContinue?: (prompt: string) => void;
}

export function MessageBubble({
  message,
  streaming,
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
  onFinalMarkerContinue,
}: MessageBubbleProps) {
  // Track whether the streaming text block has started its reveal animation
  const [_textRevealed, setTextRevealed] = useState(false);
  const [showAllDetectedOptions, setShowAllDetectedOptions] = useState(false);
  const [deferToolGrouping, setDeferToolGrouping] = useState(streaming);

  // Reset when streaming starts a new message
  useEffect(() => {
    if (streaming) setTextRevealed(false);
  }, [streaming]);

  useEffect(() => {
    if (streaming) {
      setDeferToolGrouping(true);
      return;
    }

    const timer = window.setTimeout(() => setDeferToolGrouping(false), 350);
    return () => window.clearTimeout(timer);
  }, [message.id, streaming]);

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
    const { files, mediaLabel, cleanText } = parseAttachments(message.content);
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

  // Hide spawn_background_agent tool_call — it's replaced by the bg_agent block.
  // Keep get_background_status/result/kill visible so users can see what the foreground
  // agent is doing (e.g. waiting for bg results vs actually stuck).
  const finalMarkerToolId = message.finalMarker?.toolCall?.id;
  const blocks = (message.blocks ?? []).filter(
    (b) =>
      !(b.type === "tool_call" && b.name === "spawn_background_agent") &&
      !(b.type === "tool_call" && b.id === finalMarkerToolId),
  );
  const lastIdx = blocks.length - 1;
  const blockSegments = segmentBlocks(blocks, {
    groupCompletedTools: !deferToolGrouping,
  });

  // Show dots while streaming — always visible at the bottom until response completes.
  // This ensures there's always a visible loading indicator during any streaming gap.
  const showDots = streaming;
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
        {blockSegments.map((segment) => {
          if (segment.kind === "tool_group") {
            return (
              <ToolCallGroup
                key={`group-${segment.blocks[0].id}`}
                blocks={segment.blocks}
                onOpenFile={onOpenFile}
                onPromoteMcpToolApproval={onPromoteMcpToolApproval}
              />
            );
          }

          const block = segment.block;
          const blockIndex = segment.index;
          switch (block.type) {
            case "thinking":
              return <ThinkingBlock key={block.id} block={block} />;
            case "tool_call":
              return (
                <ToolCallBlock
                  key={block.id}
                  toolCall={block}
                  onOpenFile={onOpenFile}
                  onPromoteMcpToolApproval={onPromoteMcpToolApproval}
                />
              );
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
                  onRevealStart={
                    isActiveStream ? () => setTextRevealed(true) : undefined
                  }
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

        {/* Streaming indicator with activity label */}
        {showDots && (
          <div class="streaming-indicator">
            <span class="dot" />
            <span class="dot" />
            <span class="dot" />
            <span class="streaming-activity-label">
              {getStreamingActivity(blocks)}
            </span>
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

      {/* API request inspector */}
      {message.apiRequest && (
        <ApiRequestBlock
          requestId={message.apiRequest.requestId}
          model={message.apiRequest.model}
          inputTokens={message.apiRequest.inputTokens}
          uncachedInputTokens={message.apiRequest.uncachedInputTokens}
          cacheReadTokens={message.apiRequest.cacheReadTokens}
          cacheCreationTokens={message.apiRequest.cacheCreationTokens}
          outputTokens={message.apiRequest.outputTokens}
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
function UserAttachments({
  files,
  mediaLabel,
  displayMedia,
  slashLabel,
  remote,
  onOpenFile,
}: {
  files: string[];
  mediaLabel: string | null;
  displayMedia?: ChatMessage["displayMedia"];
  slashLabel?: string;
  remote?: boolean;
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
            const label = image.name || `attached image ${index + 1}`;
            return (
              <button
                key={`${image.name}-${index}`}
                class="user-image-preview-button"
                type="button"
                title={`Open ${label}`}
                aria-label={`Open ${label}`}
                onClick={() => setSelectedImage(image)}
              >
                <img
                  class="user-image-preview"
                  src={image.src}
                  alt={image.name || `Attached image ${index + 1}`}
                />
              </button>
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
              alt={selectedImage.name || "Attached image"}
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
  if (!onOpenFile) return <>{text}</>;

  const parts: ComponentChild[] = [];
  let lastIndex = 0;

  for (const match of matchFilePaths(text)) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    parts.push(
      <a
        key={match.index}
        class="file-path-link"
        href="#"
        title={`Open ${match.filePath}${match.line !== undefined ? `:${match.line}` : ""}`}
        onClick={(e: MouseEvent) => {
          e.preventDefault();
          onOpenFile(match.filePath, match.line);
        }}
      >
        {match.fullMatch}
      </a>,
    );
    lastIndex = match.index + match.fullMatch.length;
  }

  if (parts.length === 0) return <>{text}</>;
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return <>{parts}</>;
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

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {
        // Clipboard can be unavailable or reject (e.g. denied permission).
        // Don't surface an unhandled rejection for a copy button.
      });
  }, [text]);

  return (
    <button
      class={`copy-button ${copied ? "copied" : ""}`}
      onClick={handleCopy}
      title={copied ? "Copied!" : "Copy as Markdown"}
    >
      <i class={`codicon codicon-${copied ? "check" : "copy"}`} />
    </button>
  );
}
