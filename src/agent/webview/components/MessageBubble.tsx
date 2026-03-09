import { useState, useCallback, useEffect } from "preact/hooks";
import type { ChatMessage, ContentBlock } from "../types";
import { StreamingText } from "./StreamingText";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolCallBlock } from "./ToolCallBlock";
import { ErrorBlock } from "./ErrorBlock";
import { ApiRequestBlock } from "./ApiRequestBlock";

interface MessageBubbleProps {
  message: ChatMessage;
  streaming: boolean;
  onOpenFile?: (path: string, line?: number) => void;
  onOpenMermaidPanel?: (source: string) => void;
  onRetry?: () => void;
}

export function MessageBubble({
  message,
  streaming,
  onOpenFile,
  onOpenMermaidPanel,
  onRetry,
}: MessageBubbleProps) {
  // Track whether the streaming text block has started its reveal animation
  const [textRevealed, setTextRevealed] = useState(false);

  // Reset when streaming starts a new message
  useEffect(() => {
    if (streaming) setTextRevealed(false);
  }, [streaming]);

  if (message.role === "user") {
    // Slash command display — render as a compact pill, not a full bubble
    if (message.content.startsWith("/")) {
      return (
        <div class="message slash-cmd-message">
          <i class="codicon codicon-terminal slash-cmd-msg-icon" />
          <span class="slash-cmd-msg-name">{message.content}</span>
        </div>
      );
    }
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
    return (
      <div class="message user-message">
        <div class="message-content user-content">{message.content}</div>
        <CopyButton text={message.content} />
      </div>
    );
  }

  const blocks = message.blocks ?? [];
  const lastIdx = blocks.length - 1;
  const lastIsStreamingText =
    streaming && lastIdx >= 0 && blocks[lastIdx].type === "text";

  // Show dots while streaming — always visible at the bottom until response completes.
  // This ensures there's always a visible loading indicator during any streaming gap.
  const showDots = streaming;

  return (
    <div class="message assistant-message">
      <div class="assistant-blocks">
        {blocks.map((block, i) => {
          switch (block.type) {
            case "thinking":
              return <ThinkingBlock key={block.id} block={block} />;
            case "tool_call":
              return (
                <ToolCallBlock
                  key={block.id}
                  toolCall={block}
                  onOpenFile={onOpenFile}
                />
              );
            case "text": {
              const isActiveStream = streaming && i === lastIdx;
              return (
                <TextBlock
                  key={`text-${i}`}
                  text={block.text}
                  streaming={isActiveStream}
                  showCopy={!isActiveStream}
                  onOpenMermaidPanel={onOpenMermaidPanel}
                  onRevealStart={
                    isActiveStream ? () => setTextRevealed(true) : undefined
                  }
                />
              );
            }
          }
        })}

        {/* Streaming indicator when no content yet */}
        {showDots && (
          <div class="streaming-indicator">
            <span class="dot" />
            <span class="dot" />
            <span class="dot" />
          </div>
        )}
      </div>

      {/* API request inspector */}
      {message.apiRequest && (
        <ApiRequestBlock
          requestId={message.apiRequest.requestId}
          model={message.apiRequest.model}
          inputTokens={message.apiRequest.inputTokens}
          outputTokens={message.apiRequest.outputTokens}
          durationMs={message.apiRequest.durationMs}
          timeToFirstToken={message.apiRequest.timeToFirstToken}
        />
      )}

      {/* Error block */}
      {message.error && (
        <ErrorBlock
          error={message.error.message}
          retryable={message.error.retryable}
          onRetry={message.error.retryable ? onRetry : undefined}
        />
      )}
    </div>
  );
}

function TextBlock({
  text,
  streaming,
  showCopy,
  onOpenMermaidPanel,
  onRevealStart: onRevealStartProp,
}: {
  text: string;
  streaming: boolean;
  showCopy: boolean;
  onOpenMermaidPanel?: (source: string) => void;
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
        onOpenMermaidPanel={onOpenMermaidPanel}
      />
      {showCopy && <CopyButton text={text} />}
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
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
